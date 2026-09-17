import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDatabaseClient,
  closeDbClient,
  runMigrations,
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  WebhooksRepository,
  BillingRepository,
  seedReferenceData,
  InsufficientCreditsError,
  InvalidStateTransitionError,
  DuplicateRefundError,
  DuplicateReservationError,
} from "../lib/db";
import { Client } from "@libsql/client";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";

describe("Phase 1: SQLite Database & Data Model Foundation", () => {
  let client: Client;
  let testDbPath: string;
  let testDbUrl: string;

  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;
  let webhooksRepo: WebhooksRepository;
  let billingRepo: BillingRepository;

  beforeEach(async () => {
    const testId = nanoid(8);
    const testDir = path.resolve(process.cwd(), "data", "test");
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    testDbPath = path.join(testDir, `test-${testId}.db`);
    testDbUrl = `file:${testDbPath.replace(/\\/g, "/")}`;

    client = createDatabaseClient(testDbUrl);
    await runMigrations(client);

    usersRepo = new UsersRepository(client);
    generationsRepo = new GenerationsRepository(client);
    creditsRepo = new CreditsRepository(client);
    webhooksRepo = new WebhooksRepository(client);
    billingRepo = new BillingRepository(client);
  });

  afterEach(async () => {
    await closeDbClient(client);
    // Cleanup temporary test db file
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      const walPath = `${testDbPath}-wal`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      const shmPath = `${testDbPath}-shm`;
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    } catch {}
  });

  describe("1. Fresh Database & Migration System", () => {
    it("initializes an empty database, runs migrations, and creates all required tables", async () => {
      const rs = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC;",
      );
      const tables = rs.rows.map((r) => String(r.name));

      expect(tables).toContain("migrations");
      expect(tables).toContain("users");
      expect(tables).toContain("generations");
      expect(tables).toContain("credit_ledger");
      expect(tables).toContain("webhook_events");
      expect(tables).toContain("products");
      expect(tables).toContain("prices");
    });

    it("records migration in migrations table and is idempotent on rerun", async () => {
      const migrationRes = await runMigrations(client);
      expect(migrationRes.alreadyApplied).toContain("001_initial_schema");
      expect(migrationRes.applied.length).toBe(0);
    });

    it("seeds reference billing data deterministically", async () => {
      await seedReferenceData(client);
      const products = await billingRepo.listActiveProductsWithPrices();
      expect(products.length).toBe(3);
      expect(products[0].name).toBe("Starter");
      expect(products[0].price).toBe(9.0);
      expect(products[0].credits).toBe(100);
      expect(products[1].name).toBe("Pro");
      expect(products[2].name).toBe("Premium");
    });
  });

  describe("2. User Operations & Integrity", () => {
    it("creates and retrieves a user by ID and Auth Provider ID", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "google_12345",
        email: "alice@example.com",
        name: "Alice Smith",
        credits_balance: 50,
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe("alice@example.com");
      expect(user.credits_balance).toBe(50);
      expect(user.deletion_status).toBe("active");

      const foundById = await usersRepo.findById(user.id);
      expect(foundById?.email).toBe("alice@example.com");

      const foundByAuth = await usersRepo.findByAuthProviderId("google_12345");
      expect(foundByAuth?.id).toBe(user.id);
    });

    it("enforces unique auth_provider_user_id constraint", async () => {
      await usersRepo.create({
        auth_provider_user_id: "google_unique",
        email: "user1@example.com",
      });

      await expect(
        usersRepo.create({
          auth_provider_user_id: "google_unique",
          email: "user2@example.com",
        }),
      ).rejects.toThrow();
    });

    it("enforces unique stripe_customer_id constraint", async () => {
      const u1 = await usersRepo.create({
        auth_provider_user_id: "google_1",
        email: "u1@example.com",
        stripe_customer_id: "cus_same_123",
      });
      expect(u1.stripe_customer_id).toBe("cus_same_123");

      await expect(
        usersRepo.create({
          auth_provider_user_id: "google_2",
          email: "u2@example.com",
          stripe_customer_id: "cus_same_123",
        }),
      ).rejects.toThrow();
    });

    it("synchronizes user profile from external auth provider idempotently", async () => {
      const user1 = await usersRepo.syncFromAuth({
        authProviderUserId: "google_sync_test",
        email: "sync@example.com",
        name: "Initial Name",
      });
      expect(user1.name).toBe("Initial Name");

      const user2 = await usersRepo.syncFromAuth({
        authProviderUserId: "google_sync_test",
        email: "sync_updated@example.com",
        name: "Updated Name",
      });
      expect(user2.id).toBe(user1.id);
      expect(user2.name).toBe("Updated Name");
      expect(user2.email).toBe("sync_updated@example.com");
    });
  });

  describe("3. Generation State Machine & Persistence", () => {
    it("creates generation and validates initial state", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "google_gen_user",
        email: "gen@example.com",
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `storage/input/${user.id}/photo.jpg`,
        creditsReserved: 10,
      });

      expect(gen.id).toBeDefined();
      expect(gen.status).toBe("queued");
      expect(gen.input_path).toBe(`storage/input/${user.id}/photo.jpg`);
      expect(gen.credits_reserved).toBe(10);
    });

    it("supports ownership-aware retrieval", async () => {
      const u1 = await usersRepo.create({ auth_provider_user_id: "u1", email: "u1@example.com" });
      const u2 = await usersRepo.create({ auth_provider_user_id: "u2", email: "u2@example.com" });

      const gen = await generationsRepo.create({
        userId: u1.id,
        inputPath: "input1.jpg",
      });

      const foundByOwner = await generationsRepo.findForUser(gen.id, u1.id);
      expect(foundByOwner?.id).toBe(gen.id);

      const foundByOther = await generationsRepo.findForUser(gen.id, u2.id);
      expect(foundByOther).toBeNull();
    });

    it("allows legal state transitions (queued -> processing -> succeeded)", async () => {
      const user = await usersRepo.create({ auth_provider_user_id: "u_trans", email: "trans@example.com" });
      const gen = await generationsRepo.create({ userId: user.id, inputPath: "input.jpg" });

      const processingGen = await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: "pred_12345",
      });
      expect(processingGen.status).toBe("processing");
      expect(processingGen.replicate_prediction_id).toBe("pred_12345");
      expect(processingGen.started_at).toBeDefined();

      const succeededGen = await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output.gif",
      });
      expect(succeededGen.status).toBe("succeeded");
      expect(succeededGen.output_path).toBe("output.gif");
      expect(succeededGen.completed_at).toBeDefined();
    });

    it("rejects illegal state transitions (succeeded -> failed or failed -> succeeded)", async () => {
      const user = await usersRepo.create({ auth_provider_user_id: "u_invalid_trans", email: "inv@example.com" });
      const gen = await generationsRepo.create({ userId: user.id, inputPath: "input.jpg" });

      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded");

      await expect(
        generationsRepo.transitionStatus(gen.id, "failed", { errorMessage: "some error" }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe("4. Credit Ledger & Transactional Semantics", () => {
    it("records a purchase and credits the user balance", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_purchase",
        email: "purchase@example.com",
        credits_balance: 0,
      });

      const res = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId: "evt_stripe_123",
        amount: 100,
        metadata: { pack: "Starter" },
      });

      expect(res.balance).toBe(100);
      expect(res.alreadyProcessed).toBe(false);

      const balanceInDb = await creditsRepo.getBalance(user.id);
      expect(balanceInDb).toBe(100);
    });

    it("enforces purchase idempotency on repeated Stripe events", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_purchase_idem",
        email: "purchase_idem@example.com",
        credits_balance: 0,
      });

      const first = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId: "evt_stripe_duplicate",
        amount: 100,
      });
      expect(first.balance).toBe(100);
      expect(first.alreadyProcessed).toBe(false);

      // Replay same stripe event
      const second = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId: "evt_stripe_duplicate",
        amount: 100,
      });
      expect(second.balance).toBe(100); // Does NOT double-credit!
      expect(second.alreadyProcessed).toBe(true);

      const finalBalance = await creditsRepo.getBalance(user.id);
      expect(finalBalance).toBe(100);
    });

    it("atomically reserves credits and updates user balance", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_reserve",
        email: "reserve@example.com",
        credits_balance: 30,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      const res = await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });

      expect(res.balance).toBe(20);
      expect(res.ledgerEntry.amount).toBe(-10);
      expect(res.ledgerEntry.type).toBe("reservation");

      const balanceInDb = await creditsRepo.getBalance(user.id);
      expect(balanceInDb).toBe(20);
    });

    it("rejects credit reservation if user has insufficient balance", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_insufficient",
        email: "insufficient@example.com",
        credits_balance: 5,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      await expect(
        creditsRepo.reserveCredits({
          userId: user.id,
          generationId: gen.id,
          amount: 10,
        }),
      ).rejects.toThrow(InsufficientCreditsError);

      const balanceAfter = await creditsRepo.getBalance(user.id);
      expect(balanceAfter).toBe(5);
    });

    it("prevents duplicate credit reservation for the same generation", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_dup_reserve",
        email: "dup_reserve@example.com",
        credits_balance: 50,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });

      await expect(
        creditsRepo.reserveCredits({
          userId: user.id,
          generationId: gen.id,
          amount: 10,
        }),
      ).rejects.toThrow(DuplicateReservationError);
    });

    it("idempotently refunds credits for failed generation and prevents double-refunds", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_refund",
        email: "refund@example.com",
        credits_balance: 20,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      // Reserve 10 credits -> balance: 10
      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });
      expect(await creditsRepo.getBalance(user.id)).toBe(10);

      // Transition to failed
      await generationsRepo.transitionStatus(gen.id, "failed", { errorMessage: "Face not detected" });

      // First refund -> balance: 20
      const refund1 = await creditsRepo.refundCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
        reason: "Face not detected",
      });
      expect(refund1.alreadyRefunded).toBe(false);
      expect(refund1.balance).toBe(20);

      // Replay refund (duplicate webhook) -> balance remains 20!
      const refund2 = await creditsRepo.refundCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
        reason: "Face not detected",
      });
      expect(refund2.alreadyRefunded).toBe(true);
      expect(refund2.balance).toBe(20);

      const finalBalance = await creditsRepo.getBalance(user.id);
      expect(finalBalance).toBe(20);
    });
  });

  describe("5. Webhook Event Deduplication", () => {
    it("records new webhook event and flags duplicate events", async () => {
      const ev1 = await webhooksRepo.recordEvent({
        provider: "replicate",
        externalEventId: "pred_abc_123",
        eventType: "prediction.completed",
      });
      expect(ev1.isDuplicate).toBe(false);
      expect(ev1.event.status).toBe("received");

      const ev2 = await webhooksRepo.recordEvent({
        provider: "replicate",
        externalEventId: "pred_abc_123",
        eventType: "prediction.completed",
      });
      expect(ev2.isDuplicate).toBe(true);
      expect(ev2.event.id).toBe(ev1.event.id);
    });

    it("permits different providers to use the same external event ID", async () => {
      const rep = await webhooksRepo.recordEvent({
        provider: "replicate",
        externalEventId: "id_100",
        eventType: "prediction",
      });
      expect(rep.isDuplicate).toBe(false);

      const stripe = await webhooksRepo.recordEvent({
        provider: "stripe",
        externalEventId: "id_100",
        eventType: "charge",
      });
      expect(stripe.isDuplicate).toBe(false);
    });
  });

  describe("6. Concurrency & Race-Condition Safety", () => {
    it("prevents double-spending when two concurrent requests try to reserve the same credits", async () => {
      // User only has 10 credits
      const user = await usersRepo.create({
        auth_provider_user_id: "u_race",
        email: "race@example.com",
        credits_balance: 10,
      });

      const genA = await generationsRepo.create({ userId: user.id, inputPath: "a.jpg" });
      const genB = await generationsRepo.create({ userId: user.id, inputPath: "b.jpg" });

      // Run two reservations simultaneously
      const results = await Promise.allSettled([
        creditsRepo.reserveCredits({ userId: user.id, generationId: genA.id, amount: 10 }),
        creditsRepo.reserveCredits({ userId: user.id, generationId: genB.id, amount: 10 }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // EXACTLY ONE request must succeed; the other must fail with InsufficientCreditsError
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientCreditsError);

      const finalBalance = await creditsRepo.getBalance(user.id);
      expect(finalBalance).toBe(0); // Balance CANNOT become negative!
    });
  });
});
