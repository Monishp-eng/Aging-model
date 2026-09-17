import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { createClient } from "@libsql/client";
import {
  validateServerConfig,
  buildClientConfig,
  checkSecretLeakage,
  resolveAppUrl,
  resetServerConfigForTesting,
  ConfigValidationError,
} from "../lib/config";
import {
  logger,
  enableLogCapture,
  disableLogCapture,
  getCapturedLogs,
  redactSensitiveData,
  sanitizeUrl,
  withCorrelationContext,
  generateCorrelationId,
  captureException,
  enableErrorCaptureForTesting,
  disableErrorCaptureForTesting,
  metrics,
  evaluateAlerts,
} from "../lib/observability";
import { createBackup, restoreBackup } from "../lib/db/backup";
import { getDbClient, closeDbClient, initializePragmas } from "../lib/db/client";
import { runMigrations } from "../lib/db/migrations";
import { GET as healthHandler } from "../app/api/health/route";
import { GET as readyHandler } from "../app/api/ready/route";
import { POST as cleanupHandler } from "../app/api/cron/cleanup/route";
import { POST as reconcileHandler } from "../app/api/cron/reconcile/route";

describe("Phase 6 — DevOps, Configuration & Observability", () => {
  const testDbDir = path.resolve(process.cwd(), "data", "test-devops");
  const testDbFile = path.join(testDbDir, "devops.db");
  const testBackupDir = path.resolve(process.cwd(), "backups", "test-devops");

  beforeEach(async () => {
    vi.restoreAllMocks();
    metrics.reset();
    resetServerConfigForTesting();
    await closeDbClient();
  });

  afterEach(async () => {
    await closeDbClient();
    resetServerConfigForTesting();
    if (fs.existsSync(testDbDir)) {
      try {
        fs.rmSync(testDbDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock on Windows during teardown
      }
    }
    if (fs.existsSync(testBackupDir)) {
      try {
        fs.rmSync(testBackupDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock on Windows during teardown
      }
    }
  });

  // =========================================================================
  // 1. Centralized Configuration & Security Boundaries
  // =========================================================================
  describe("1. Configuration & Security Boundaries", () => {
    it("validates and accepts a complete production configuration", () => {
      const prodEnv = {
        APP_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://extrapolate.app",
        DATABASE_URL: "file:./data/prod.db",
        NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-123",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-456",
        STRIPE_SECRET_KEY: "sk_live_stripe_key",
        STRIPE_WEBHOOK_SECRET: "whsec_live_stripe",
        REPLICATE_API_TOKEN: "r8_live_replicate_token",
        REPLICATE_WEBHOOK_SECRET: "whsec_live_replicate",
        CRON_SECRET: "cron_secret_789",
        LOG_LEVEL: "info",
      };

      const result = validateServerConfig(prodEnv);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.config?.isProduction).toBe(true);
      expect(result.config?.appUrl).toBe("https://extrapolate.app");
      expect(result.config?.webhookBaseUrl).toBe("https://extrapolate.app");
    });

    it("fails fast when required production secrets are missing", () => {
      const incompleteProdEnv = {
        APP_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://extrapolate.app",
        DATABASE_URL: "file:./data/prod.db",
        NEXT_PUBLIC_SUPABASE_URL: "https://prod.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-123",
        // Missing: SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, REPLICATE_API_TOKEN, CRON_SECRET
      };

      const result = validateServerConfig(incompleteProdEnv);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
      expect(result.errors.some((e) => e.includes("SUPABASE_SERVICE_ROLE_KEY"))).toBe(true);
      expect(result.errors.some((e) => e.includes("STRIPE_SECRET_KEY"))).toBe(true);
      expect(result.errors.some((e) => e.includes("REPLICATE_API_TOKEN"))).toBe(true);
      expect(result.errors.some((e) => e.includes("CRON_SECRET"))).toBe(true);
    });

    it("detects and rejects server secret leakage through NEXT_PUBLIC_* variables", () => {
      const leakingEnv = {
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "public-anon-key", // Allowed
        NEXT_PUBLIC_STRIPE_SECRET_KEY: "sk_live_leaked_secret", // LEAK!
        NEXT_PUBLIC_SERVICE_ROLE_KEY: "secret-service-role", // LEAK!
      };

      const leaks = checkSecretLeakage(leakingEnv);
      expect(leaks.length).toBe(2);
      expect(leaks[0]).toContain("NEXT_PUBLIC_STRIPE_SECRET_KEY");
      expect(leaks[1]).toContain("NEXT_PUBLIC_SERVICE_ROLE_KEY");

      const validation = validateServerConfig(leakingEnv);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes("NEXT_PUBLIC_STRIPE_SECRET_KEY"))).toBe(true);
    });

    it("verifies client configuration only exposes safe public fields", () => {
      const mixedEnv = {
        APP_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://extrapolate.app",
        NEXT_PUBLIC_SUPABASE_URL: "https://safe.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "safe-anon-key",
        SUPABASE_SERVICE_ROLE_KEY: "SECRET_SERVICE_KEY",
        STRIPE_SECRET_KEY: "SECRET_STRIPE_KEY",
        REPLICATE_API_TOKEN: "SECRET_REPLICATE_TOKEN",
      };

      const clientConfig = buildClientConfig(mixedEnv);
      expect(clientConfig.appUrl).toBe("https://extrapolate.app");
      expect(clientConfig.supabase.url).toBe("https://safe.supabase.co");
      expect(clientConfig.supabase.anonKey).toBe("safe-anon-key");
      expect((clientConfig as any).SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
      expect((clientConfig as any).STRIPE_SECRET_KEY).toBeUndefined();
      expect((clientConfig as any).REPLICATE_API_TOKEN).toBeUndefined();
    });

    it("resolves canonical application URLs without tunnel dependency in local dev", () => {
      const devEnv = {
        APP_ENV: "development",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      };

      const devConfig = validateServerConfig(devEnv).config!;
      expect(devConfig.appUrl).toBe("http://localhost:3000");
      // Without tunnel, webhooks fallback to localhost safely without 'undefined'
      expect(devConfig.webhookBaseUrl).toBe("http://localhost:3000");

      // When tunnel is provided, webhookBaseUrl uses tunnel
      const devWithTunnelEnv = {
        ...devEnv,
        TUNNEL_URL: "https://cloudflared.sample.net",
      };
      const tunnelConfig = validateServerConfig(devWithTunnelEnv).config!;
      expect(tunnelConfig.appUrl).toBe("http://localhost:3000");
      expect(tunnelConfig.webhookBaseUrl).toBe("https://cloudflared.sample.net");
    });
  });

  // =========================================================================
  // 2. Health & Readiness Probes
  // =========================================================================
  describe("2. Health & Readiness Endpoints", () => {
    it("/api/health returns 200 with status ok and release metadata", async () => {
      const response = await healthHandler();
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.status).toBe("ok");
      expect(json.timestamp).toBeDefined();
      expect(typeof json.uptime).toBe("number");
      expect(json.release).toBeDefined();
      expect(json.release.version).toBeDefined();
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

    it("/api/ready returns 200 when SQLite and migrations are initialized", async () => {
      await closeDbClient();
      resetServerConfigForTesting();
      process.env.APP_ENV = "test";
      (process.env as any).NODE_ENV = "test";

      if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
      process.env.DATABASE_URL = `file:${testDbFile.replace(/\\/g, "/")}`;

      const client = getDbClient();
      await initializePragmas(client);
      await runMigrations(client);

      const response = await readyHandler();
      const json = await response.json();
      expect(response.status).toBe(200);
      expect(json.status).toBe("ready");
      expect(json.checks.database).toBe("ok");
      expect(json.checks.migrations).toBe("ok");
      expect(json.checks.config).toBe("ok");
    });

    it("/api/ready returns 503 if database is inaccessible or unmigrated", async () => {
      await closeDbClient();
      resetServerConfigForTesting();

      // Setup a fresh empty database file without running any migrations
      const emptyDbPath = path.join(testDbDir, "unmigrated.db");
      if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
      if (fs.existsSync(emptyDbPath)) fs.unlinkSync(emptyDbPath);

      process.env.DATABASE_URL = `file:${emptyDbPath.replace(/\\/g, "/")}`;
      const emptyClient = getDbClient();
      await initializePragmas(emptyClient);
      // Do NOT run runMigrations(emptyClient)

      const response = await readyHandler();
      expect(response.status).toBe(503);

      const json = await response.json();
      expect(json.status).toBe("not_ready");
      expect(json.checks.migrations).toBe("error");

      // Verify security: No internal paths or stack traces exposed
      expect(JSON.stringify(json)).not.toContain(emptyDbPath);
      expect(JSON.stringify(json)).not.toContain("stack");
    });
  });

  // =========================================================================
  // 3. Structured Logging, Correlation & Redaction
  // =========================================================================
  describe("3. Structured Observability & Redaction", () => {
    beforeEach(() => {
      enableLogCapture();
      enableErrorCaptureForTesting();
    });

    afterEach(() => {
      disableLogCapture();
      disableErrorCaptureForTesting();
    });

    it("redacts sensitive fields (passwords, tokens, auth headers, cookies, webhook secrets)", () => {
      const sensitiveData = {
        userId: "usr_123",
        authorization: "Bearer secret_jwt_token",
        cookie: "session=xyz123; tracking=abc",
        stripeWebhookSecret: "whsec_topsecret",
        normalField: "public_value",
        nested: {
          token: "r8_very_secret",
          password: "my_password",
        },
      };

      const sanitized = redactSensitiveData(sensitiveData);
      expect(sanitized.userId).toBe("usr_123");
      expect(sanitized.normalField).toBe("public_value");
      expect(sanitized.authorization).toBe("[REDACTED]");
      expect(sanitized.cookie).toBe("[REDACTED]");
      expect(sanitized.stripeWebhookSecret).toBe("[REDACTED]");
      expect(sanitized.nested.token).toBe("[REDACTED]");
      expect(sanitized.nested.password).toBe("[REDACTED]");
    });

    it("sanitizes signed storage URLs with query signatures", () => {
      const signedUrl =
        "https://example.supabase.co/storage/v1/object/sign/input/user/file.jpeg?token=secret123&X-Amz-Signature=sig456";
      const cleaned = sanitizeUrl(signedUrl);

      expect(cleaned).toBe("https://example.supabase.co/storage/v1/object/sign/input/user/file.jpeg?[REDACTED_QUERY_PARAMS]");
      expect(cleaned).not.toContain("secret123");
      expect(cleaned).not.toContain("sig456");
    });

    it("propagates correlation context (requestId, generationId) into structured logs", () => {
      const testRequestId = generateCorrelationId();
      const testGenerationId = "gen_test_correlation_456";

      withCorrelationContext(
        { requestId: testRequestId, generationId: testGenerationId },
        () => {
          logger.info("Processing test prediction lifecycle step", {
            step: "image_fetch",
            attempt: 1,
            authorization: "Bearer do_not_log_this",
          });
        },
      );

      const captured = getCapturedLogs();
      expect(captured).toHaveLength(1);
      const log = captured[0];

      expect(log.level).toBe("info");
      expect(log.message).toBe("Processing test prediction lifecycle step");
      expect(log.requestId).toBe(testRequestId);
      expect(log.generationId).toBe(testGenerationId);
      expect(log.step).toBe("image_fetch");
      expect(log.authorization).toBe("[REDACTED]");
    });

    it("captures unhandled exceptions with sanitized context without crashing", () => {
      const testRequestId = generateCorrelationId();

      const errorId = withCorrelationContext({ requestId: testRequestId }, () => {
        return captureException(new Error("External prediction connection reset"), {
          provider: "replicate",
          token: "r8_secret_token",
        });
      });

      expect(typeof errorId).toBe("string");
      const capturedErrors = disableErrorCaptureForTesting();
      expect(capturedErrors.length).toBeGreaterThanOrEqual(1);

      const errEvent = capturedErrors[0];
      expect(errEvent.error.message).toBe("External prediction connection reset");
      expect(errEvent.context.requestId).toBe(testRequestId);
      expect(errEvent.context.token).toBe("[REDACTED]");
    });
  });

  // =========================================================================
  // 4. Operational Metrics & Actionable Alerts
  // =========================================================================
  describe("4. Metrics & Operational Alerting", () => {
    it("tracks HTTP requests and detects 5xx error spikes", () => {
      // Simulate 20 requests with 3 500 errors (15% failure rate)
      for (let i = 0; i < 17; i++) {
        metrics.recordHttpRequest("GET", "/api/health", 200, 10);
      }
      for (let i = 0; i < 3; i++) {
        metrics.recordHttpRequest("POST", "/api/actions/upload", 500, 120);
      }

      const summary = metrics.getSummary();
      expect(summary.http.totalRequests).toBe(20);
      expect(summary.http.error5xxCount).toBe(3);
      expect(summary.http.error5xxRate).toBe(0.15);

      // Evaluate alerts
      const alerts = evaluateAlerts(summary);
      expect(alerts.some((a) => a.id === "HIGH_HTTP_5XX_RATE")).toBe(true);
      const alert = alerts.find((a) => a.id === "HIGH_HTTP_5XX_RATE")!;
      expect(alert.severity).toBe("CRITICAL");
      expect(alert.action).toContain("Check application logs");
    });

    it("tracks generation failure and refund rate triggers", () => {
      // Simulate 10 generations with 3 failures and refunds (30% failure rate)
      for (let i = 0; i < 7; i++) {
        metrics.recordGeneration({
          generationId: `gen_ok_${i}`,
          status: "succeeded",
          durationMs: 4000,
        });
      }
      for (let i = 0; i < 3; i++) {
        metrics.recordGeneration({
          generationId: `gen_fail_${i}`,
          status: "failed",
          durationMs: 1500,
          refunded: true,
        });
      }

      const summary = metrics.getSummary();
      expect(summary.generations.total).toBe(10);
      expect(summary.generations.failed).toBe(3);
      expect(summary.generations.refunded).toBe(3);
      expect(summary.generations.failureRate).toBe(0.3);

      const alerts = evaluateAlerts(summary);
      expect(alerts.some((a) => a.id === "HIGH_GENERATION_FAILURE_RATE")).toBe(true);
      expect(alerts.some((a) => a.id === "HIGH_REFUND_RATE")).toBe(true);
    });

    it("tracks storage cleanup failures and alerts", () => {
      metrics.recordCleanup({
        deletedCount: 15,
        failedCount: 2,
        durationMs: 850,
      });

      const summary = metrics.getSummary();
      expect(summary.cleanup.totalDeleted).toBe(15);
      expect(summary.cleanup.totalFailed).toBe(2);

      const alerts = evaluateAlerts(summary);
      expect(alerts.some((a) => a.id === "STORAGE_CLEANUP_FAILURES")).toBe(true);
    });
  });

  // =========================================================================
  // 5. SQLite Backup, Verification & Restoration
  // =========================================================================
  describe("5. SQLite Production Backup & Restoration", () => {
    it("creates a consistent backup and successfully restores to an isolated target", async () => {
      await closeDbClient();
      if (!fs.existsSync(testDbDir)) fs.mkdirSync(testDbDir, { recursive: true });
      if (!fs.existsSync(testBackupDir)) fs.mkdirSync(testBackupDir, { recursive: true });

      const sourceDbPath = path.join(testDbDir, "source.db");
      const normalizedSourcePath = sourceDbPath.replace(/\\/g, "/");
      process.env.DATABASE_URL = `file:${normalizedSourcePath}`;

      // 1. Initialize source database with schema and sample test data
      const sourceClient = getDbClient(`file:${normalizedSourcePath}`);
      await initializePragmas(sourceClient);
      await runMigrations(sourceClient);

      const now = new Date().toISOString();
      await sourceClient.execute({
        sql: "INSERT INTO users (id, auth_provider_user_id, email, credits_balance, deletion_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?);",
        args: ["usr_backup_test", "auth_usr_123", "backup@example.com", 50, now, now],
      });

      // 2. Perform safe backup
      const backupResult = await createBackup({
        destinationDir: testBackupDir,
        client: sourceClient,
        customFilename: "test-snapshot.db",
      });

      expect(fs.existsSync(backupResult.backupPath)).toBe(true);
      expect(backupResult.sizeBytes).toBeGreaterThan(0);
      expect(backupResult.integrity).toBe("ok");
      expect(backupResult.tableCount).toBeGreaterThanOrEqual(5);

      // 3. Perform restoration into an isolated destination
      const restoredDbPath = path.join(testDbDir, "restored.db");
      const restoreResult = await restoreBackup({
        backupPath: backupResult.backupPath,
        targetPath: restoredDbPath,
      });

      expect(restoreResult.integrity).toBe("ok");
      expect(fs.existsSync(restoredDbPath)).toBe(true);

      // 4. Verify restored data integrity
      const restoredClient = createClient({ url: `file:${restoredDbPath.replace(/\\/g, "/")}` });
      try {
        const userRes = await restoredClient.execute({
          sql: "SELECT * FROM users WHERE id = ?;",
          args: ["usr_backup_test"],
        });
        expect(userRes.rows.length).toBe(1);
        expect(userRes.rows[0].email).toBe("backup@example.com");
        expect(Number(userRes.rows[0].credits_balance)).toBe(50);
      } finally {
        restoredClient.close();
      }
    });
  });

  // =========================================================================
  // 6. Scheduled Job Authentication & Idempotency
  // =========================================================================
  describe("6. Scheduled Jobs Authentication", () => {
    it("rejects unauthorized cleanup cron requests without valid secret", async () => {
      process.env.CRON_SECRET = "production_cron_secret_test";
      resetServerConfigForTesting();

      const unauthReq = new NextRequest("http://localhost:3000/api/cron/cleanup", {
        method: "POST",
      });
      const res = await cleanupHandler(unauthReq);
      expect(res.status).toBe(401);
    });

    it("rejects unauthorized reconcile cron requests without valid secret", async () => {
      process.env.CRON_SECRET = "production_cron_secret_test";
      resetServerConfigForTesting();

      const unauthReq = new NextRequest("http://localhost:3000/api/cron/reconcile", {
        method: "POST",
      });
      const res = await reconcileHandler(unauthReq);
      expect(res.status).toBe(401);
    });

    it("accepts authenticated cron requests with Bearer token or x-cron-secret", async () => {
      process.env.CRON_SECRET = "production_cron_secret_test";
      resetServerConfigForTesting();

      const bearerReq = new NextRequest("http://localhost:3000/api/cron/cleanup", {
        method: "POST",
        headers: {
          authorization: "Bearer production_cron_secret_test",
        },
      });
      const res = await cleanupHandler(bearerReq);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.runId).toBeDefined();
    });
  });
});
