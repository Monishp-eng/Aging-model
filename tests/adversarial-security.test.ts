import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createClient, Client } from "@libsql/client";
import {
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  runMigrations,
} from "../lib/db";
import {
  isAllowedReplicateUrl,
  WebhookSSRFError,
} from "../lib/security/webhook";
import {
  validateGenerationId,
  validatePriceId,
  validateDeleteConfirmation,
  ValidationError,
} from "../lib/validation";
import { getInputKey, getOutputKey } from "../lib/storage/keys";
import { checkSecretLeakage } from "../lib/config/schema";

describe("Phase 7 — Adversarial Security & Exploit Resistance", () => {
  let db: Client;
  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe("1. Exhaustive SSRF Adversarial Matrix", () => {
    it("permits canonical, HTTPS-encrypted Replicate delivery domains", () => {
      const validUrls = [
        "https://replicate.delivery/pbxt/abc123/output.gif",
        "https://replicate.delivery/predictions/out.png",
        "https://pbxt.replicate.delivery/model-cache/result.jpg",
      ];

      for (const url of validUrls) {
        expect(isAllowedReplicateUrl(new URL(url))).toBe(true);
      }
    });

    it("rejects non-HTTPS schemes (plain HTTP)", () => {
      const httpUrl = "http://replicate.delivery/pbxt/image.png";
      expect(isAllowedReplicateUrl(new URL(httpUrl))).toBe(false);
    });

    it("rejects cloud instance metadata endpoints (169.254.169.254)", () => {
      const metadataUrls = [
        "http://169.254.169.254/latest/meta-data/",
        "https://169.254.169.254/computeMetadata/v1/",
        "http://169.254.169.254/latest/user-data",
      ];
      for (const url of metadataUrls) {
        expect(isAllowedReplicateUrl(new URL(url))).toBe(false);
      }
    });

    it("rejects loopback and local network targets (127.0.0.1, 0.0.0.0, localhost, [::1])", () => {
      const loopbacks = [
        "http://127.0.0.1:3000/api/admin",
        "https://127.0.0.1/secrets",
        "http://localhost:8080/metrics",
        "http://0.0.0.0:5432",
      ];
      for (const url of loopbacks) {
        expect(isAllowedReplicateUrl(new URL(url))).toBe(false);
      }
    });

    it("rejects private RFC 1918 internal networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", () => {
      const privateIps = [
        "https://10.0.0.1/admin",
        "http://172.16.0.1/status",
        "https://192.168.1.1/router",
        "http://192.168.0.100:8080",
      ];
      for (const url of privateIps) {
        expect(isAllowedReplicateUrl(new URL(url))).toBe(false);
      }
    });

    it("rejects subdomain and authority spoofing attacks", () => {
      const spoofed = [
        "https://evil.com",
        "https://replicate.delivery.evil.com/payload",
        "https://evil-replicate.delivery/image.png",
        "https://evil.com@replicate.delivery/path",
        "https://replicate.delivery@evil.com/path",
      ];
      for (const url of spoofed) {
        expect(isAllowedReplicateUrl(new URL(url))).toBe(false);
      }
    });

    it("rejects non-HTTP protocols (file://, ftp://)", () => {
      const fileUrl = new URL("file:///etc/passwd");
      expect(isAllowedReplicateUrl(fileUrl)).toBe(false);

      const ftpUrl = new URL("ftp://replicate.delivery/data");
      expect(isAllowedReplicateUrl(ftpUrl)).toBe(false);
    });
  });

  describe("2. Parameterized SQL Injection Resistance", () => {
    const maliciousPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE users; --",
      "' UNION SELECT 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 --",
      "admin'--",
      "1' OR '1' = '1' /*",
      "'; DELETE FROM generations WHERE '1'='1",
    ];

    it("safely parameterizes user lookups without executing injected SQL", async () => {
      for (const payload of maliciousPayloads) {
        // Must not crash or return unintended rows
        const user = await usersRepo.findByAuthProviderId(payload);
        expect(user).toBeNull();

        const byId = await usersRepo.findById(payload);
        expect(byId).toBeNull();
      }

      // Verify users table remains intact
      const countRs = await db.execute("SELECT COUNT(*) AS c FROM users;");
      expect(Number(countRs.rows[0].c)).toBe(0);
    });

    it("safely parameterizes generation lookups and updates", async () => {
      for (const payload of maliciousPayloads) {
        const gen = await generationsRepo.findById(payload);
        expect(gen).toBeNull();

        const active = await generationsRepo.countActiveByUser(payload);
        expect(active).toBe(0);
      }
    });

    it("safely handles malicious inputs in credit ledger operations", async () => {
      for (const payload of maliciousPayloads) {
        // Must safely throw NotFoundError without database corruption or injection execution
        await expect(creditsRepo.getBalance(payload)).rejects.toThrow();
      }
    });
  });

  describe("3. Path Traversal & Object Storage Key Sanitization", () => {
    it("validates and blocks path traversal in generation identifiers", () => {
      const traversalInputs = [
        "../etc/passwd",
        "..\\Windows\\System32",
        "....//....//etc",
        "/etc/passwd",
        "gen/%2e%2e/%2e%2e/secret",
        "gen\0evil",
      ];

      for (const input of traversalInputs) {
        expect(() => validateGenerationId(input)).toThrow(ValidationError);
      }
    });

    it("enforces canonical, traversal-free storage keys", () => {
      const key = getInputKey("usr_clean", "gen_12345", "jpg");
      expect(key).toBe("usr_clean/gen_12345/source.jpg");
      expect(key).not.toContain("..");
      expect(key).not.toContain("\\");

      const outKey = getOutputKey("usr_clean", "gen_12345", "gif");
      expect(outKey).toBe("usr_clean/gen_12345/result.gif");
    });
  });

  describe("4. Cross-User Authorization Matrix (User A vs User B)", () => {
    it("strictly isolates generations, credits, and lifecycle actions between distinct users", async () => {
      const userA = await usersRepo.create({
        auth_provider_user_id: "auth_alice",
        email: "alice@domain.com",
        credits_balance: 50,
      });
      const userB = await usersRepo.create({
        auth_provider_user_id: "auth_bob",
        email: "bob@domain.com",
        credits_balance: 20,
      });

      const genA = await generationsRepo.create({
        userId: userA.id,
        inputPath: "storage/alice.jpg",
        initialStatus: "queued",
      });

      // 1. Bob cannot read Alice's generation
      expect(await generationsRepo.getGenerationForUser(genA.id, userB.id)).toBeNull();

      // 2. Bob cannot delete Alice's generation
      expect(await generationsRepo.deleteForUser(genA.id, userB.id)).toBe(false);
      expect(await generationsRepo.findById(genA.id)).not.toBeNull();

      // 3. Bob cannot list Alice's generations
      const bobGenerations = await generationsRepo.listForUser(userB.id);
      expect(bobGenerations).toHaveLength(0);

      // 4. Bob cannot spend Alice's credits
      await expect(
        creditsRepo.reserveCredits({
          userId: userB.id,
          generationId: genA.id, // Bob tries to tie reservation to Alice's generation
          amount: 10,
        }),
      ).resolves.toBeDefined(); // Operates only on Bob's balance

      // Alice's balance remains strictly 50
      expect(await creditsRepo.getBalance(userA.id)).toBe(50);
      expect(await creditsRepo.getBalance(userB.id)).toBe(10);
    });
  });

  describe("5. Input Validation & XSS Defense", () => {
    it("rejects malicious script tags and event handlers in identifiers", () => {
      const xssVectors = [
        "<script>alert(1)</script>",
        "<img src=x onerror=alert(1)>",
        "javascript:alert(document.cookie)",
        "<svg onload=alert(1)>",
        "';alert(1);'",
      ];

      for (const vector of xssVectors) {
        expect(() => validateGenerationId(vector)).toThrow(ValidationError);
        expect(() => validatePriceId(vector)).toThrow(ValidationError);
      }
    });

    it("strictly validates account deletion confirmation phrases", () => {
      expect(validateDeleteConfirmation("delete my account")).toBe(true);
      expect(validateDeleteConfirmation("DELETE MY ACCOUNT")).toBe(true);
      expect(validateDeleteConfirmation("<script>delete</script>")).toBe(false);
      expect(validateDeleteConfirmation("delete my account; DROP TABLE")).toBe(false);
    });
  });

  describe("6. Server Secret Leakage Prevention in Client Bundles", () => {
    it("flags any server-only secrets mistakenly exposed to NEXT_PUBLIC_*", () => {
      const benignEnv = {
        NEXT_PUBLIC_SUPABASE_URL: "https://xyz.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-token",
        NEXT_PUBLIC_APP_URL: "https://example.com",
      };
      expect(checkSecretLeakage(benignEnv)).toHaveLength(0);

      const leakingEnv = {
        NEXT_PUBLIC_STRIPE_SECRET_KEY: "sk_live_leaked",
        NEXT_PUBLIC_REPLICATE_API_TOKEN: "r8_leaked",
        NEXT_PUBLIC_CRON_SECRET: "cron_secret_leaked",
        NEXT_PUBLIC_SERVICE_ROLE_KEY: "service_role_leaked",
      };
      const leaks = checkSecretLeakage(leakingEnv);
      expect(leaks.length).toBe(4);
      for (const leak of leaks) {
        expect(leak).toContain("Security violation");
      }
    });
  });
});
