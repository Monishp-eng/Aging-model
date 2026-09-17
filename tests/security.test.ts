import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient } from "@libsql/client";
import {
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  BillingRepository,
  runMigrations,
} from "../lib/db";
import { getSafeRedirectPath } from "../lib/auth/redirects";
import {
  validateGenerationId,
  validatePriceId,
  validateDeleteConfirmation,
  validateImageUpload,
  ValidationError,
} from "../lib/validation";
import { UnauthorizedError } from "../lib/auth";
import nextConfig from "../next.config.mjs";

describe("Phase 2 — Authentication, Authorization & Security Boundaries", () => {
  let db: ReturnType<typeof createClient>;
  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;
  let billingRepo: BillingRepository;

  beforeEach(async () => {
    // In-memory isolated SQLite instance for fast, non-interfering security tests
    db = createClient({ url: ":memory:" });
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);
    billingRepo = new BillingRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("1. Safe Redirect Validation (Open Redirect Protection)", () => {
    it("accepts valid relative application paths", () => {
      expect(getSafeRedirectPath("/gallery")).toBe("/gallery");
      expect(getSafeRedirectPath("/p/abc12345")).toBe("/p/abc12345");
      expect(getSafeRedirectPath("/")).toBe("/");
      expect(getSafeRedirectPath("/?x=1")).toBe("/?x=1");
      expect(getSafeRedirectPath("/dashboard?tab=credits#pricing")).toBe(
        "/dashboard?tab=credits#pricing",
      );
    });

    it("rejects protocol-relative open redirect attacks", () => {
      expect(getSafeRedirectPath("//evil.com")).toBe("/");
      expect(getSafeRedirectPath("///evil.com")).toBe("/");
      expect(getSafeRedirectPath("////evil.com/path")).toBe("/");
    });

    it("rejects absolute external URLs", () => {
      expect(getSafeRedirectPath("https://evil.com")).toBe("/");
      expect(getSafeRedirectPath("http://evil.com/phishing")).toBe("/");
      expect(getSafeRedirectPath("ftp://evil.com")).toBe("/");
    });

    it("rejects Windows backslash bypasses", () => {
      expect(getSafeRedirectPath("\\evil.com")).toBe("/");
      expect(getSafeRedirectPath("/\\evil.com")).toBe("/");
      expect(getSafeRedirectPath("/path\\to\\somewhere")).toBe("/");
      expect(getSafeRedirectPath("/%5cevil.com")).toBe("/");
      expect(getSafeRedirectPath("%5C%5Cevil.com")).toBe("/");
    });

    it("rejects dangerous URI schemes (XSS vectors)", () => {
      expect(getSafeRedirectPath("javascript:alert(1)")).toBe("/");
      expect(getSafeRedirectPath("/javascript:alert(1)")).toBe("/");
      expect(getSafeRedirectPath("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe("/");
      expect(getSafeRedirectPath("vbscript:msgbox(1)")).toBe("/");
    });

    it("rejects CRLF injection and null byte attempts", () => {
      expect(getSafeRedirectPath("/valid\r\nLocation: https://evil.com")).toBe("/");
      expect(getSafeRedirectPath("/valid%0d%0aLocation:evil.com")).toBe("/");
      expect(getSafeRedirectPath("/valid\0evil")).toBe("/");
    });

    it("falls back safely on null, undefined, or empty values", () => {
      expect(getSafeRedirectPath(null)).toBe("/");
      expect(getSafeRedirectPath(undefined)).toBe("/");
      expect(getSafeRedirectPath("")).toBe("/");
      expect(getSafeRedirectPath("   ")).toBe("/");
      expect(getSafeRedirectPath(null, "/fallback")).toBe("/fallback");
    });
  });

  describe("2. Resource Ownership & IDOR/BOLA Protection", () => {
    it("permits User A to read their own generation and blocks User B", async () => {
      const userA = await usersRepo.create({
        auth_provider_user_id: "auth_a",
        email: "alice@example.com",
      });
      const userB = await usersRepo.create({
        auth_provider_user_id: "auth_b",
        email: "bob@example.com",
      });

      const genA = await generationsRepo.create({
        userId: userA.id,
        inputPath: "https://storage.example.com/a.jpg",
      });

      // User A can access their own generation
      const owned = await generationsRepo.getGenerationForUser(genA.id, userA.id);
      expect(owned).not.toBeNull();
      expect(owned?.id).toBe(genA.id);
      expect(owned?.user_id).toBe(userA.id);

      // User B CANNOT access User A's generation (IDOR prevented, returns null)
      const unauthorized = await generationsRepo.getGenerationForUser(genA.id, userB.id);
      expect(unauthorized).toBeNull();
    });

    it("prevents User B from deleting User A's generation", async () => {
      const userA = await usersRepo.create({
        auth_provider_user_id: "auth_a2",
        email: "alice2@example.com",
      });
      const userB = await usersRepo.create({
        auth_provider_user_id: "auth_b2",
        email: "bob2@example.com",
      });

      const genA = await generationsRepo.create({
        userId: userA.id,
        inputPath: "https://storage.example.com/a2.jpg",
      });

      // User B attempts to delete User A's generation
      const deleteAttempt = await generationsRepo.deleteForUser(genA.id, userB.id);
      expect(deleteAttempt).toBe(false);

      // Verify User A's generation still exists intact
      const stillExists = await generationsRepo.findById(genA.id);
      expect(stillExists).not.toBeNull();

      // User A can successfully delete their own generation
      const authorizedDelete = await generationsRepo.deleteForUser(genA.id, userA.id);
      expect(authorizedDelete).toBe(true);
      expect(await generationsRepo.findById(genA.id)).toBeNull();
    });

    it("isolates user gallery results completely between sessions", async () => {
      const userA = await usersRepo.create({
        auth_provider_user_id: "auth_a_gal",
        email: "alice_gal@example.com",
      });
      const userB = await usersRepo.create({
        auth_provider_user_id: "auth_b_gal",
        email: "bob_gal@example.com",
      });

      // User A has 2 succeeded generations
      const genA1 = await generationsRepo.create({
        userId: userA.id,
        inputPath: "https://storage.example.com/a1.jpg",
        initialStatus: "succeeded",
      });
      const genA2 = await generationsRepo.create({
        userId: userA.id,
        inputPath: "https://storage.example.com/a2.jpg",
        initialStatus: "succeeded",
      });

      // User B has 0 generations
      const userBGenerations = await generationsRepo.listForUser(userB.id);
      expect(userBGenerations).toHaveLength(0);

      // User A has 2
      const userAGenerations = await generationsRepo.listForUser(userA.id);
      expect(userAGenerations).toHaveLength(2);
      expect(userAGenerations.map((g) => g.id)).toContain(genA1.id);
      expect(userAGenerations.map((g) => g.id)).toContain(genA2.id);
    });
  });

  describe("3. Credit Authorization & Cross-User Protection", () => {
    it("prevents User A from reading User B's credit ledger", async () => {
      const userA = await usersRepo.create({
        auth_provider_user_id: "auth_a_cred",
        email: "alice_cred@example.com",
        credits_balance: 50,
      });
      const userB = await usersRepo.create({
        auth_provider_user_id: "auth_b_cred",
        email: "bob_cred@example.com",
        credits_balance: 100,
      });

      await creditsRepo.recordStripePurchase({
        userId: userB.id,
        stripeEventId: "evt_bob_1",
        amount: 100,
      });

      // User A checks their own ledger: has 0 entries
      const ledgerA = await creditsRepo.listLedgerForUser(userA.id);
      expect(ledgerA).toHaveLength(0);

      // User B ledger has 1 entry
      const ledgerB = await creditsRepo.listLedgerForUser(userB.id);
      expect(ledgerB).toHaveLength(1);
      expect(ledgerB[0].user_id).toBe(userB.id);
    });

    it("strictly prevents credit balances from dropping below 0", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_low_cred",
        email: "low@example.com",
        credits_balance: 5,
      });

      await expect(
        creditsRepo.reserveCredits({
          userId: user.id,
          generationId: "gen_fail",
          amount: 10,
        }),
      ).rejects.toThrow();

      // Verify balance remains untouched
      const balance = await creditsRepo.getBalance(user.id);
      expect(balance).toBe(5);
    });
  });

  describe("4. Mass Assignment & Integrity Protection", () => {
    it("syncFromAuth cannot alter protected fields (credits, stripe_customer_id, deletion_status)", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_protected",
        email: "protected@example.com",
        credits_balance: 500,
        stripe_customer_id: "cus_legit_123",
      });

      // Subsequent login sync updates only name and image
      const synced = await usersRepo.syncFromAuth({
        authProviderUserId: "auth_protected",
        email: "protected@example.com",
        name: "New Name",
        image: "https://avatar.example.com/new.jpg",
      });

      expect(synced.name).toBe("New Name");
      expect(synced.image).toBe("https://avatar.example.com/new.jpg");
      // Protected fields MUST remain unchanged
      expect(synced.credits_balance).toBe(500);
      expect(synced.stripe_customer_id).toBe("cus_legit_123");
      expect(synced.deletion_status).toBe("active");
    });
  });

  describe("5. Input Validation Boundaries", () => {
    it("validates generation ID format and rejects malicious inputs", () => {
      expect(validateGenerationId("valid_gen_123")).toBe("valid_gen_123");
      expect(validateGenerationId("V1StGXR8_Z5jdHi6B-myT")).toBe("V1StGXR8_Z5jdHi6B-myT");

      expect(() => validateGenerationId("")).toThrow(ValidationError);
      expect(() => validateGenerationId("../../etc/passwd")).toThrow(ValidationError);
      expect(() => validateGenerationId("gen; DROP TABLE users;--")).toThrow(ValidationError);
      expect(() => validateGenerationId("<script>alert(1)</script>")).toThrow(ValidationError);
      expect(() => validateGenerationId("a".repeat(100))).toThrow(ValidationError);
    });

    it("validates Stripe Price ID format and rejects malicious inputs", () => {
      expect(validatePriceId("price_1Oxxxxxxxxxxxxxx")).toBe("price_1Oxxxxxxxxxxxxxx");
      expect(validatePriceId("price_starter_default")).toBe("price_starter_default");

      expect(() => validatePriceId("")).toThrow(ValidationError);
      expect(() => validatePriceId("invalid price with spaces")).toThrow(ValidationError);
      expect(() => validatePriceId("price_' OR '1'='1")).toThrow(ValidationError);
      expect(() => validatePriceId("p")).toThrow(ValidationError);
    });

    it("validates delete confirmation string strictly", () => {
      expect(validateDeleteConfirmation("delete my account")).toBe(true);
      expect(validateDeleteConfirmation("DELETE MY ACCOUNT")).toBe(true);
      expect(validateDeleteConfirmation("  delete my account  ")).toBe(true);

      expect(validateDeleteConfirmation("delete")).toBe(false);
      expect(validateDeleteConfirmation("yes")).toBe(false);
      expect(validateDeleteConfirmation("")).toBe(false);
      expect(validateDeleteConfirmation(null)).toBe(false);
    });

    it("validates image upload MIME types and size boundaries", () => {
      const validJpeg = { size: 1024 * 100, type: "image/jpeg" };
      expect(validateImageUpload(validJpeg).valid).toBe(true);

      const validPng = { size: 1024 * 200, type: "image/png" };
      expect(validateImageUpload(validPng).valid).toBe(true);

      const emptyFile = { size: 0, type: "image/jpeg" };
      expect(validateImageUpload(emptyFile).valid).toBe(false);

      const oversizedFile = { size: 15 * 1024 * 1024, type: "image/jpeg" };
      expect(validateImageUpload(oversizedFile).valid).toBe(false);

      const maliciousSvg = { size: 1024, type: "image/svg+xml" };
      expect(validateImageUpload(maliciousSvg).valid).toBe(false);

      const executable = { size: 1024, type: "application/x-msdownload" };
      expect(validateImageUpload(executable).valid).toBe(false);
    });
  });

  describe("6. Production Security Headers", () => {
    it("configures strict security headers including CSP, HSTS, and clickjacking protection", async () => {
      const configHeaders = await (nextConfig as any).headers();
      expect(configHeaders).toBeDefined();
      expect(configHeaders.length).toBeGreaterThan(0);

      const rootConfig = configHeaders.find((h: any) => h.source === "/(.*)");
      expect(rootConfig).toBeDefined();

      const headerMap = new Map(
        rootConfig.headers.map((item: { key: string; value: string }) => [item.key, item.value]),
      );

      // Verify MIME sniffing protection
      expect(headerMap.get("X-Content-Type-Options")).toBe("nosniff");

      // Verify Clickjacking protection
      expect(headerMap.get("X-Frame-Options")).toBe("DENY");

      // Verify Referrer Policy
      expect(headerMap.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");

      // Verify HSTS
      expect(headerMap.get("Strict-Transport-Security")).toContain("max-age=63072000");
      expect(headerMap.get("Strict-Transport-Security")).toContain("includeSubDomains");

      // Verify CSP contains essential directives
      const csp = headerMap.get("Content-Security-Policy");
      expect(csp).toBeDefined();
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'self'");
    });
  });
});
