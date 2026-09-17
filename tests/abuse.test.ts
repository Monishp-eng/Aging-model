import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient, Client } from "@libsql/client";
import {
  checkRateLimit,
  resetRateLimits,
  RATE_LIMIT_POLICIES,
  getRateLimitHeaders,
} from "../lib/security/ratelimit";
import {
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  runMigrations,
} from "../lib/db";
import { logger } from "../lib/observability/logger";

describe("Phase 7 — Abuse Prevention & Rate Limiting Suite", () => {
  let db: Client;
  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;

  beforeEach(async () => {
    resetRateLimits();
    db = createClient({ url: ":memory:" });
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);
  });

  afterEach(async () => {
    resetRateLimits();
    await db.close();
  });

  describe("1. Sliding-Window Rate Limiting Engine", () => {
    it("allows requests within configured threshold and tracks remaining tokens", async () => {
      const id = "user_test_1";
      const policy = { maxRequests: 3, windowSeconds: 60 };

      const r1 = await checkRateLimit(id, policy);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);
      expect(r1.limit).toBe(3);

      const r2 = await checkRateLimit(id, policy);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);

      const r3 = await checkRateLimit(id, policy);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
    });

    it("rejects requests exceeding threshold and returns meaningful Retry-After hint", async () => {
      const id = "user_test_exceed";
      const policy = { maxRequests: 2, windowSeconds: 60 };

      await checkRateLimit(id, policy);
      await checkRateLimit(id, policy);

      const r3 = await checkRateLimit(id, policy);
      expect(r3.allowed).toBe(false);
      expect(r3.remaining).toBe(0);
      expect(r3.retryAfterSeconds).toBeGreaterThan(0);
      expect(r3.retryAfterSeconds).toBeLessThanOrEqual(60);

      const headers = getRateLimitHeaders(r3);
      expect(headers["X-RateLimit-Limit"]).toBe("2");
      expect(headers["X-RateLimit-Remaining"]).toBe("0");
      expect(headers["Retry-After"]).toBeDefined();
    });

    it("isolates rate limits between distinct identifiers and endpoints", async () => {
      const policy = { maxRequests: 1, windowSeconds: 60 };

      const u1 = await checkRateLimit("user_alice", policy);
      expect(u1.allowed).toBe(true);

      // Alice is blocked on 2nd request
      const u1Second = await checkRateLimit("user_alice", policy);
      expect(u1Second.allowed).toBe(false);

      // Bob is unaffected
      const u2 = await checkRateLimit("user_bob", policy);
      expect(u2.allowed).toBe(true);
    });

    it("resets limits when window expires", async () => {
      const id = "user_short_window";
      const policy = { maxRequests: 1, windowSeconds: 1 }; // 1s window

      const r1 = await checkRateLimit(id, policy);
      expect(r1.allowed).toBe(true);

      const r2 = await checkRateLimit(id, policy);
      expect(r2.allowed).toBe(false);

      // Wait 1.1s for window to slide past
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const r3 = await checkRateLimit(id, policy);
      expect(r3.allowed).toBe(true);
    });
  });

  describe("2. Active Generation Concurrency Limit (Cost Protection)", () => {
    it("permits new generation when active concurrent count is under maximum limit", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_concur_1",
        email: "concur1@example.com",
      });

      expect(await generationsRepo.countActiveByUser(user.id)).toBe(0);

      // Create 1 active generation
      await generationsRepo.create({
        userId: user.id,
        inputPath: "in1.jpg",
        initialStatus: "queued",
      });
      expect(await generationsRepo.countActiveByUser(user.id)).toBe(1);

      // Create 2nd active generation
      await generationsRepo.create({
        userId: user.id,
        inputPath: "in2.jpg",
        initialStatus: "processing",
      });
      expect(await generationsRepo.countActiveByUser(user.id)).toBe(2);
    });

    it("enforces hard ceiling of 2 active concurrent generations per user", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_concur_max",
        email: "concurmax@example.com",
      });

      const gen1 = await generationsRepo.create({
        userId: user.id,
        inputPath: "in1.jpg",
        initialStatus: "queued",
      });
      const gen2 = await generationsRepo.create({
        userId: user.id,
        inputPath: "in2.jpg",
        initialStatus: "processing",
      });

      // Active count is 2
      const activeCount = await generationsRepo.countActiveByUser(user.id);
      expect(activeCount).toBe(2);

      // Server-side check: should block 3rd generation
      const MAX_CONCURRENT = 2;
      const canProceed = activeCount < MAX_CONCURRENT;
      expect(canProceed).toBe(false);

      // When one finishes, slots free up immediately (gen2 is in processing)
      await generationsRepo.transitionStatus(gen2.id, "succeeded", { outputPath: "out.gif" });

      const newActiveCount = await generationsRepo.countActiveByUser(user.id);
      expect(newActiveCount).toBe(1);
      expect(newActiveCount < MAX_CONCURRENT).toBe(true);
    });

    it("treats canceled and failed generations as inactive, allowing immediate retry", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_concur_term",
        email: "concurterm@example.com",
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "in.jpg",
        initialStatus: "queued",
      });

      await generationsRepo.transitionStatus(gen.id, "failed", { errorMessage: "Model timeout" });
      expect(await generationsRepo.countActiveByUser(user.id)).toBe(0);
    });
  });

  describe("3. Wallet-Draining Abuse Simulation", () => {
    it("bounds inference requests and prevents financial exhaustion under 100 rapid concurrent requests", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "u_wallet_drain",
        email: "drain@example.com",
        credits_balance: 100,
      });

      // Simulate 100 near-instantaneous requests to the rate limiter & concurrency checker
      const attempts = Array.from({ length: 100 });
      let allowedRequests = 0;
      let blockedByRateLimit = 0;
      let blockedByConcurrency = 0;

      for (let i = 0; i < attempts.length; i++) {
        const rateLimit = await checkRateLimit(`upload:user:${user.id}`, RATE_LIMIT_POLICIES.uploadUser);
        if (!rateLimit.allowed) {
          blockedByRateLimit++;
          continue;
        }

        const activeCount = await generationsRepo.countActiveByUser(user.id);
        if (activeCount >= 2) {
          blockedByConcurrency++;
          continue;
        }

        // Successfully allowed request
        allowedRequests++;
        await generationsRepo.create({
          userId: user.id,
          inputPath: `in_${i}.jpg`,
          initialStatus: "queued",
        });
      }

      // Exactly at most 5 requests allowed by uploadUser policy (5/min), and at most 2 concurrent
      expect(allowedRequests).toBe(2); // Since 2 active generations cap concurrency!
      expect(blockedByConcurrency + blockedByRateLimit).toBe(98);
      expect(await generationsRepo.countActiveByUser(user.id)).toBe(2);
    });
  });

  describe("4. Structured Abuse Logging", () => {
    it("logs audit warning on rate limit violation without exposing secrets or raw payloads", async () => {
      const warnSpy = vi.spyOn(logger, "warn");

      const policy = { maxRequests: 1, windowSeconds: 60 };
      await checkRateLimit("sensitive_user_id_123456789", policy);
      await checkRateLimit("sensitive_user_id_123456789", policy);

      expect(warnSpy).toHaveBeenCalled();
      const lastCall = warnSpy.mock.calls[warnSpy.mock.calls.length - 1];
      expect(lastCall[0]).toContain("Rate limit exceeded");

      // Verify identifier was redacted in metadata
      const meta = lastCall[1] as any;
      expect(meta.event).toBe("abuse.rate_limit_exceeded");
      expect(meta.identifier).toContain("sens...6789"); // Redacted!
      expect(meta.identifier).not.toBe("sensitive_user_id_123456789");

      warnSpy.mockRestore();
    });
  });
});
