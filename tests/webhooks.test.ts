import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createClient } from "@libsql/client";
import {
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  WebhooksRepository,
  BillingRepository,
  runMigrations,
} from "../lib/db";
import {
  verifyReplicateWebhook,
  validateReplicatePayload,
  isAllowedReplicateUrl,
  validateImageMagicBytes,
  WebhookVerificationError,
  WebhookReplayError,
  WebhookPayloadError,
} from "../lib/security/webhook";

describe("Phase 3 — Webhook Security & Idempotent Event Processing", () => {
  let db: ReturnType<typeof createClient>;
  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;
  let webhooksRepo: WebhooksRepository;
  let billingRepo: BillingRepository;

  const testSecretKey = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const testSecret = `whsec_${testSecretKey}`;
  const testSecretBytes = Buffer.from(testSecretKey, "base64");

  function generateReplicateSignature(
    id: string,
    timestamp: number | string,
    body: string,
    secretBytes: Buffer = testSecretBytes,
  ): string {
    const signedContent = `${id}.${timestamp}.${body}`;
    const hmac = crypto
      .createHmac("sha256", secretBytes)
      .update(signedContent, "utf8")
      .digest("base64");
    return `v1,${hmac}`;
  }

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);
    webhooksRepo = new WebhooksRepository(db);
    billingRepo = new BillingRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("1. Replicate Webhook Signature & Replay Protection", () => {
    const now = Math.floor(Date.now() / 1000);
    const id = "msg_test_12345";
    const body = JSON.stringify({ id: "pred_123", status: "succeeded", output: "https://replicate.delivery/out.gif" });

    it("verifies a valid HMAC-SHA256 signature", () => {
      const sig = generateReplicateSignature(id, now, body);
      const isValid = verifyReplicateWebhook({
        id,
        timestamp: String(now),
        signature: sig,
        rawBody: body,
        secret: testSecret,
        currentTimestamp: now,
      });
      expect(isValid).toBe(true);
    });

    it("rejects an invalid or forged signature", () => {
      const forgedSig = "v1,Zm9yZ2VkX3NpZ25hdHVyZV9leGFtcGxlCg==";
      expect(() =>
        verifyReplicateWebhook({
          id,
          timestamp: String(now),
          signature: forgedSig,
          rawBody: body,
          secret: testSecret,
          currentTimestamp: now,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it("rejects when raw body was modified after signing", () => {
      const sig = generateReplicateSignature(id, now, body);
      const tamperedBody = JSON.stringify({ id: "pred_123", status: "failed" });
      expect(() =>
        verifyReplicateWebhook({
          id,
          timestamp: String(now),
          signature: sig,
          rawBody: tamperedBody,
          secret: testSecret,
          currentTimestamp: now,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it("rejects missing or empty required headers", () => {
      const sig = generateReplicateSignature(id, now, body);
      expect(() =>
        verifyReplicateWebhook({
          id: null,
          timestamp: String(now),
          signature: sig,
          rawBody: body,
          secret: testSecret,
        }),
      ).toThrow(WebhookVerificationError);

      expect(() =>
        verifyReplicateWebhook({
          id,
          timestamp: null,
          signature: sig,
          rawBody: body,
          secret: testSecret,
        }),
      ).toThrow(WebhookVerificationError);

      expect(() =>
        verifyReplicateWebhook({
          id,
          timestamp: String(now),
          signature: "",
          rawBody: body,
          secret: testSecret,
        }),
      ).toThrow(WebhookVerificationError);
    });

    it("rejects timestamps outside the tolerance window (replay protection)", () => {
      const expiredTimestamp = now - 600; // 10 minutes ago (> 300s limit)
      const sig = generateReplicateSignature(id, expiredTimestamp, body);

      expect(() =>
        verifyReplicateWebhook({
          id,
          timestamp: String(expiredTimestamp),
          signature: sig,
          rawBody: body,
          secret: testSecret,
          toleranceSeconds: 300,
          currentTimestamp: now,
        }),
      ).toThrow(WebhookReplayError);
    });

    it("rejects future timestamps beyond tolerance", () => {
      const futureTimestamp = now + 400; // 400s in the future
      const sig = generateReplicateSignature(id, futureTimestamp, body);

      expect(() =>
        verifyReplicateWebhook({
          id,
          timestamp: String(futureTimestamp),
          signature: sig,
          rawBody: body,
          secret: testSecret,
          toleranceSeconds: 300,
          currentTimestamp: now,
        }),
      ).toThrow(WebhookReplayError);
    });

    it("supports multiple signatures and verifies if any match", () => {
      const validSig = generateReplicateSignature(id, now, body);
      const combinedHeader = `v1,dummy_invalid_sig ${validSig} v2,unsupported_version_sig`;

      const isValid = verifyReplicateWebhook({
        id,
        timestamp: String(now),
        signature: combinedHeader,
        rawBody: body,
        secret: testSecret,
        currentTimestamp: now,
      });
      expect(isValid).toBe(true);
    });

    it("supports secret rotation with multiple secrets", () => {
      const oldSecretKey = "T2xkU2VjcmV0S2V5Rm9yUm90YXRpb25UZXN0aW5n";
      const oldSecret = `whsec_${oldSecretKey}`;
      const oldBytes = Buffer.from(oldSecretKey, "base64");

      // Signed with old secret
      const sig = generateReplicateSignature(id, now, body, oldBytes);

      // Verifier given array of [currentSecret, oldSecret]
      const isValid = verifyReplicateWebhook({
        id,
        timestamp: String(now),
        signature: sig,
        rawBody: body,
        secret: [testSecret, oldSecret],
        currentTimestamp: now,
      });
      expect(isValid).toBe(true);
    });
  });

  describe("2. Replicate Payload Validation", () => {
    it("parses valid prediction payload schema", () => {
      const raw = JSON.stringify({
        id: "pred_abc",
        status: "succeeded",
        output: "https://replicate.delivery/out.gif",
        created_at: "2026-09-17T00:00:00Z",
      });
      const parsed = validateReplicatePayload(raw);
      expect(parsed.id).toBe("pred_abc");
      expect(parsed.status).toBe("succeeded");
      expect(parsed.output).toBe("https://replicate.delivery/out.gif");
    });

    it("rejects non-JSON payloads and oversized bodies", () => {
      expect(() => validateReplicatePayload("not json")).toThrow(WebhookPayloadError);
      expect(() => validateReplicatePayload("{}", 1)).toThrow(WebhookPayloadError);
    });

    it("rejects invalid or missing status", () => {
      const raw = JSON.stringify({ id: "pred_abc", status: "exploit_state" });
      expect(() => validateReplicatePayload(raw)).toThrow(WebhookPayloadError);
    });
  });

  describe("3. SSRF & Artifact Host Validation", () => {
    it("allows replicate.delivery and its subdomains", () => {
      expect(isAllowedReplicateUrl(new URL("https://replicate.delivery/pbxt/sample.gif"))).toBe(true);
      expect(isAllowedReplicateUrl(new URL("https://pbxt.replicate.delivery/image.png"))).toBe(true);
    });

    it("rejects non-HTTPS schemes", () => {
      expect(isAllowedReplicateUrl(new URL("http://replicate.delivery/out.gif"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("ftp://replicate.delivery/out.gif"))).toBe(false);
    });

    it("rejects loopback and private IP addresses", () => {
      expect(isAllowedReplicateUrl(new URL("http://127.0.0.1/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("http://localhost/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://10.0.0.1/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://192.168.1.1/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://169.254.169.254/latest/meta-data/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://[::1]/"))).toBe(false);
    });

    it("rejects foreign domains and host confusion tricks", () => {
      expect(isAllowedReplicateUrl(new URL("https://evil.com/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://replicate.delivery.evil.com/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://evil-replicate.delivery/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://user:pass@replicate.delivery/"))).toBe(false);
      expect(isAllowedReplicateUrl(new URL("https://replicate.delivery:8080/"))).toBe(false);
    });

    it("validates artifact magic bytes correctly", () => {
      // GIF89a magic bytes
      const gifHeader = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes(gifHeader).valid).toBe(true);
      expect(validateImageMagicBytes(gifHeader).detectedType).toBe("image/gif");

      // PNG magic bytes
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
      expect(validateImageMagicBytes(pngHeader).valid).toBe(true);
      expect(validateImageMagicBytes(pngHeader).detectedType).toBe("image/png");

      // HTML malicious content rejected
      const htmlHeader = Buffer.from("<!DOCTYPE html><html><body>malicious</body></html>");
      expect(validateImageMagicBytes(htmlHeader).valid).toBe(false);

      // Truncated buffer rejected
      expect(validateImageMagicBytes(Buffer.from([0x47, 0x49])).valid).toBe(false);
    });
  });

  describe("4. Replicate Webhook Idempotency & State Invariants", () => {
    it("deduplicates repeated webhook deliveries atomically", async () => {
      const externalEventId = "evt_replicate_dup_1";

      const first = await webhooksRepo.recordEvent({
        provider: "replicate",
        externalEventId,
        eventType: "prediction.succeeded",
      });
      expect(first.isDuplicate).toBe(false);

      // Repeated delivery of same event
      const second = await webhooksRepo.recordEvent({
        provider: "replicate",
        externalEventId,
        eventType: "prediction.succeeded",
      });
      expect(second.isDuplicate).toBe(true);
    });

    it("idempotently refunds credits on failure and never duplicates refund on repeated failure webhook", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_refund_user",
        email: "refund@example.com",
        credits_balance: 50,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "https://storage.example.com/in.jpg",
        creditsReserved: 10,
        initialStatus: "processing",
      });

      // Reserve credits (50 -> 40)
      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });
      expect(await creditsRepo.getBalance(user.id)).toBe(40);

      // Webhook Failure 1: Transitions to failed, refunds 10 credits (40 -> 50)
      await generationsRepo.transitionStatus(gen.id, "failed", {
        errorCode: "PREDICTION_FAILED",
      });
      const refund1 = await creditsRepo.refundCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
        reason: "Prediction failed",
      });
      expect(refund1.alreadyRefunded).toBe(false);
      expect(refund1.balance).toBe(50);
      expect(await creditsRepo.getBalance(user.id)).toBe(50);

      // Webhook Failure 2 (Duplicate/Retry): Must be idempotent (50 stays 50)
      const refund2 = await creditsRepo.refundCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
        reason: "Prediction failed retry",
      });
      expect(refund2.alreadyRefunded).toBe(true);
      expect(refund2.balance).toBe(50);
      expect(await creditsRepo.getBalance(user.id)).toBe(50);

      // Ledger has exactly 1 refund entry
      const ledger = await creditsRepo.listLedgerForUser(user.id);
      const refundEntries = ledger.filter((l) => l.type === "refund" && l.generation_id === gen.id);
      expect(refundEntries).toHaveLength(1);
    });

    it("preserves terminal state when out-of-order webhooks arrive", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_order_user",
        email: "order@example.com",
        credits_balance: 100,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "https://storage.example.com/in.jpg",
        initialStatus: "queued",
      });

      // Transitions queued -> processing -> succeeded
      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "https://storage.example.com/out.gif",
      });

      const terminalGen = await generationsRepo.findById(gen.id);
      expect(terminalGen?.status).toBe("succeeded");

      // Attempt invalid regression from terminal succeeded -> failed throws InvalidStateTransitionError
      await expect(
        generationsRepo.transitionStatus(gen.id, "failed", {
          errorCode: "LATE_FAILURE",
        }),
      ).rejects.toThrow();

      // Generation remains succeeded
      const currentGen = await generationsRepo.findById(gen.id);
      expect(currentGen?.status).toBe("succeeded");
    });
  });

  describe("5. Stripe Webhook Idempotency & Financial Guarantees", () => {
    it("grants credits exactly once when receiving duplicate checkout.session.completed events", async () => {
      const user = await usersRepo.create({
        auth_provider_user_id: "auth_stripe_idem",
        email: "stripe_idem@example.com",
        credits_balance: 0,
      });

      const stripeEventId = "evt_checkout_completed_999";

      // Delivery 1: credits user with 100 credits
      const res1 = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId,
        amount: 100,
      });
      expect(res1.alreadyProcessed).toBe(false);
      expect(res1.balance).toBe(100);
      expect(await creditsRepo.getBalance(user.id)).toBe(100);

      // Delivery 2 (Stripe retry): must NOT credit again
      const res2 = await creditsRepo.recordStripePurchase({
        userId: user.id,
        stripeEventId,
        amount: 100,
      });
      expect(res2.alreadyProcessed).toBe(true);
      expect(res2.balance).toBe(100);
      expect(await creditsRepo.getBalance(user.id)).toBe(100);

      // Ledger has exactly 1 purchase entry for this Stripe event
      const ledger = await creditsRepo.listLedgerForUser(user.id);
      const purchases = ledger.filter((l) => l.stripe_event_id === stripeEventId);
      expect(purchases).toHaveLength(1);
    });

    it("deduplicates Stripe events in webhook_events table", async () => {
      const eventId = "evt_stripe_table_dedupe";
      const rec1 = await webhooksRepo.recordEvent({
        provider: "stripe",
        externalEventId: eventId,
        eventType: "checkout.session.completed",
      });
      expect(rec1.isDuplicate).toBe(false);

      const rec2 = await webhooksRepo.recordEvent({
        provider: "stripe",
        externalEventId: eventId,
        eventType: "checkout.session.completed",
      });
      expect(rec2.isDuplicate).toBe(true);
    });
  });

  describe("6. Obsolete Supabase Customer Webhook Regression Test", () => {
    it("confirms app/api/webhooks/supabase/customer/route.ts has been removed", () => {
      const obsoleteRoutePath = path.join(
        process.cwd(),
        "app",
        "api",
        "webhooks",
        "supabase",
        "customer",
        "route.ts",
      );
      expect(fs.existsSync(obsoleteRoutePath)).toBe(false);
    });
  });
});
