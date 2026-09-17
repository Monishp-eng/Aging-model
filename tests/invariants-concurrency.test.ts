import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createDatabaseClient,
  closeDbClient,
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  WebhooksRepository,
  runMigrations,
  InsufficientCreditsError,
  InvalidStateTransitionError,
} from "../lib/db";
import { Client } from "@libsql/client";
import path from "path";
import fs from "fs";
import { nanoid } from "nanoid";
import {
  classifyReplicateError,
  GENERATION_ERROR_CODES,
} from "../lib/generation";

describe("Phase 7 — Database Invariants, Financial Integrity & Concurrency Stress", () => {
  let db: Client;
  let testDbPath: string;
  let testDbUrl: string;

  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;
  let webhooksRepo: WebhooksRepository;

  beforeEach(async () => {
    const testId = nanoid(8);
    const testDir = path.resolve(process.cwd(), "data", "test");
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    testDbPath = path.join(testDir, `invariants-${testId}.db`);
    testDbUrl = `file:${testDbPath.replace(/\\/g, "/")}`;

    db = createDatabaseClient(testDbUrl);
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);
    webhooksRepo = new WebhooksRepository(db);
  });

  afterEach(async () => {
    await closeDbClient(db);
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      const walPath = `${testDbPath}-wal`;
      if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
      const shmPath = `${testDbPath}-shm`;
      if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
    } catch {}
  });

  describe("1. Database Foreign Key Constraints", () => {
    it("strictly blocks generation creation referencing a non-existent user", async () => {
      await expect(
        generationsRepo.create({
          userId: "non_existent_user_id",
          inputPath: "input.jpg",
        }),
      ).rejects.toThrow();
    });

    it("strictly blocks credit ledger entry referencing a non-existent user", async () => {
      await expect(
        creditsRepo.recordStripePurchase({
          userId: "ghost_user",
          stripeEventId: "evt_ghost",
          amount: 50,
        }),
      ).rejects.toThrow();
    });
  });

  describe("2. Financial Balance Invariants & Race Condition Stress", () => {
    it("strictly prohibits credits_balance from becoming negative under concurrent reservations", async () => {
      // User has only 10 credits
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_race_reserve",
        email: "race_reserve@test.com",
        credits_balance: 10,
      });

      // Create 2 generations
      const genA = await generationsRepo.create({ userId: user.id, inputPath: "a.jpg" });
      const genB = await generationsRepo.create({ userId: user.id, inputPath: "b.jpg" });

      // Run two reservations simultaneously
      const results = await Promise.allSettled([
        creditsRepo.reserveCredits({ userId: user.id, generationId: genA.id, amount: 10 }),
        creditsRepo.reserveCredits({ userId: user.id, generationId: genB.id, amount: 10 }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly 1 must succeed; the other must fail
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
        InsufficientCreditsError,
      );

      // Balance must be exactly 0, never negative
      const finalBalance = await creditsRepo.getBalance(user.id);
      expect(finalBalance).toBe(0);
    });

    it("guarantees idempotency and prevents double-refunding across multiple refund triggers", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_race_refund",
        email: "race_refund@test.com",
        credits_balance: 10,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      // Reserve 10 credits -> balance: 0
      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });
      expect(await creditsRepo.getBalance(user.id)).toBe(0);

      // Transition to processing then failed
      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "failed", {
        errorCode: "MODEL_TIMEOUT",
      });

      // Sequential duplicate refund attempts (simulating retried / duplicate webhooks)
      const r1 = await creditsRepo.refundCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
        reason: "MODEL_TIMEOUT",
      });
      expect(r1.alreadyRefunded).toBe(false);
      expect(r1.balance).toBe(10);

      const r2 = await creditsRepo.refundCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
        reason: "MODEL_TIMEOUT",
      });
      expect(r2.alreadyRefunded).toBe(true);
      expect(r2.balance).toBe(10);

      // Final balance must remain strictly 10
      const balance = await creditsRepo.getBalance(user.id);
      expect(balance).toBe(10);
    });

    it("guarantees idempotency and prevents double-crediting across multiple Stripe purchase events", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_race_stripe",
        email: "race_stripe@test.com",
        credits_balance: 0,
      });

      // First purchase event
      const first = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId: "evt_duplicate_stripe_123",
        amount: 100,
      });
      expect(first.alreadyProcessed).toBe(false);
      expect(first.balance).toBe(100);

      // Duplicate delivery
      const second = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId: "evt_duplicate_stripe_123",
        amount: 100,
      });
      expect(second.alreadyProcessed).toBe(true);
      expect(second.balance).toBe(100);

      // Balance must be exactly 100, never 200
      expect(await creditsRepo.getBalance(user.id)).toBe(100);
    });
  });

  describe("3. Terminal State Irreversibility", () => {
    it("prevents succeeded generation from regressing to failed or queued", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_terminal_succ",
        email: "terminal_succ@test.com",
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output.gif",
      });

      // Attempt to regress state to failed
      await expect(
        generationsRepo.transitionStatus(gen.id, "failed", {
          errorMessage: "Late failure webhook",
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Attempt to regress state to queued
      await expect(
        generationsRepo.transitionStatus(gen.id, "queued"),
      ).rejects.toThrow(InvalidStateTransitionError);

      // State remains succeeded
      const current = await generationsRepo.findById(gen.id);
      expect(current?.status).toBe("succeeded");
    });

    it("prevents failed generation from regressing to succeeded or processing", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_terminal_fail",
        email: "terminal_fail@test.com",
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input.jpg",
      });

      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "failed", {
        errorCode: "FACE_DETECTION_FAILED",
      });

      // Attempt to transition to succeeded
      await expect(
        generationsRepo.transitionStatus(gen.id, "succeeded", {
          outputPath: "output.gif",
        }),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Attempt to transition to processing
      await expect(
        generationsRepo.transitionStatus(gen.id, "processing"),
      ).rejects.toThrow(InvalidStateTransitionError);

      // State remains failed
      const current = await generationsRepo.findById(gen.id);
      expect(current?.status).toBe("failed");
    });
  });

  describe("4. Provider Failure Classification & Recovery", () => {
    it("accurately classifies diverse provider errors into canonical failure codes", () => {
      const nsfw = classifyReplicateError("NSFW content detected in input");
      expect(nsfw.code).toBe(GENERATION_ERROR_CODES.REPLICATE_FAILED);

      const timeout = classifyReplicateError({ code: "ETIMEDOUT", message: "network timeout" });
      expect(timeout.code).toBe(GENERATION_ERROR_CODES.REPLICATE_TIMEOUT);
      expect(timeout.isTransient).toBe(true);

      const rate = classifyReplicateError({ status: 429, message: "rate limit" });
      expect(rate.code).toBe(GENERATION_ERROR_CODES.RATE_LIMITED);
      expect(rate.isTransient).toBe(true);

      const serverError = classifyReplicateError({ status: 503 });
      expect(serverError.code).toBe(GENERATION_ERROR_CODES.REPLICATE_CREATE_FAILED);
      expect(serverError.isTransient).toBe(true);
    });
  });
});
