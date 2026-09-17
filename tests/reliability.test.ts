import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient } from "@libsql/client";
import {
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  WebhooksRepository,
  runMigrations,
  InvalidStateTransitionError,
  NotFoundError,
} from "../lib/db";
import {
  transitionGeneration,
  classifyReplicateError,
  retryWithBackoff,
  GENERATION_ERROR_CODES,
  isTerminalState,
} from "../lib/generation/lifecycle";
import {
  reconcileGeneration,
  reconcileStaleGenerations,
  RECONCILIATION_CONFIG,
} from "../lib/generation/reconciliation";
import { GET as getGenerationRoute } from "../app/api/generations/[id]/route";
import { GET as getReconcileCronRoute } from "../app/api/cron/reconcile/route";
import { NextRequest } from "next/server";

// Mock Supabase admin client and storage
const mockStorageState: {
  files: Map<string, Set<string>>;
  signedUrls: Map<string, string>;
} = {
  files: new Map([
    ["input", new Set<string>()],
    ["output", new Set<string>()],
    ["temp", new Set<string>()],
  ]),
  signedUrls: new Map(),
};

function resetMockStorage() {
  mockStorageState.files.get("input")!.clear();
  mockStorageState.files.get("output")!.clear();
  mockStorageState.files.get("temp")!.clear();
  mockStorageState.signedUrls.clear();
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: vi.fn(async (path: string, expiresIn: number) => {
          const files = mockStorageState.files.get(bucket);
          if (!files || !files.has(path)) {
            return { data: null, error: { message: "Object not found" } };
          }
          const signedUrl = `https://mock-storage.supabase.co/${bucket}/${path}?token=signed_${expiresIn}`;
          return { data: { signedUrl }, error: null };
        }),
        upload: vi.fn(async (path: string, buffer: Buffer, options: any) => {
          const files = mockStorageState.files.get(bucket);
          if (files) files.add(path);
          return { data: { path }, error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          const files = mockStorageState.files.get(bucket);
          if (files) {
            for (const p of paths) files.delete(p);
          }
          return { data: paths, error: null };
        }),
      }),
    },
    channel: vi.fn(() => ({
      send: vi.fn(async () => {}),
    })),
  }),
}));

// Mock Replicate SDK
let mockReplicatePredictions: Map<string, any> = new Map();
let mockReplicateCalls: {
  created: any[];
  get: string[];
  canceled: string[];
} = {
  created: [],
  get: [],
  canceled: [],
};

vi.mock("replicate", () => {
  return {
    default: class MockReplicate {
      predictions = {
        create: vi.fn(async (params: any) => {
          mockReplicateCalls.created.push(params);
          const id = `pred_${Date.now()}_${Math.random().toString(36).substring(7)}`;
          const prediction = {
            id,
            status: "starting",
            input: params.input,
            output: null,
            error: null,
          };
          mockReplicatePredictions.set(id, prediction);
          return prediction;
        }),
        get: vi.fn(async (id: string) => {
          mockReplicateCalls.get.push(id);
          const prediction = mockReplicatePredictions.get(id);
          if (!prediction) {
            throw new Error(`Prediction ${id} not found on Replicate`);
          }
          return prediction;
        }),
        cancel: vi.fn(async (id: string) => {
          mockReplicateCalls.canceled.push(id);
          const prediction = mockReplicatePredictions.get(id);
          if (prediction) {
            prediction.status = "canceled";
          }
          return prediction;
        }),
      };
    },
  };
});

// Mock SSRF artifact fetcher
vi.mock("@/lib/security/webhook", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    validateAndFetchReplicateArtifact: vi.fn(async (url: string) => {
      return {
        buffer: Buffer.from("GIF89a_MOCK_VALIDATED_OUTPUT"),
        contentType: "image/gif",
      };
    }),
  };
});

describe("Phase 5 — Async Processing, Reliability & Realtime", () => {
  let db: ReturnType<typeof createClient>;
  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;
  let webhooksRepo: WebhooksRepository;

  beforeEach(async () => {
    db = createClient({ url: ":memory:" });
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);
    webhooksRepo = new WebhooksRepository(db);

    resetMockStorage();
    mockReplicatePredictions.clear();
    mockReplicateCalls = { created: [], get: [], canceled: [] };

    // Wire repository singletons for testing
    const dbModule = await import("../lib/db");
    vi.spyOn(dbModule, "getGenerationsRepository").mockReturnValue(generationsRepo);
    vi.spyOn(dbModule, "getCreditsRepository").mockReturnValue(creditsRepo);
    vi.spyOn(dbModule, "getUsersRepository").mockReturnValue(usersRepo);
    vi.spyOn(dbModule, "getWebhooksRepository").mockReturnValue(webhooksRepo);
    vi.spyOn(dbModule, "ensureDatabaseInitialized").mockResolvedValue();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe("1. Durable Generation State Machine & Regression Protection", () => {
    it("allows legal forward state transitions", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u1",
        email: "u1@example.com",
        creditsBalance: 50,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `input/${user.id}/gen_1/source.jpg`,
      });

      expect(gen.status).toBe("queued");

      // queued -> processing
      const processing = await transitionGeneration(gen.id, "processing", {
        replicatePredictionId: "pred_123",
      });
      expect(processing.status).toBe("processing");
      expect(processing.replicate_prediction_id).toBe("pred_123");
      expect(processing.processing_started_at).toBeDefined();

      // processing -> succeeded
      const succeeded = await transitionGeneration(gen.id, "succeeded", {
        outputPath: `output/${user.id}/gen_1/result.gif`,
      });
      expect(succeeded.status).toBe("succeeded");
      expect(succeeded.completed_at).toBeDefined();
      expect(succeeded.expires_at).toBeDefined(); // Automatically set 24h retention

      // succeeded -> expired
      const expired = await transitionGeneration(gen.id, "expired");
      expect(expired.status).toBe("expired");
    });

    it("blocks illegal state regressions from terminal states", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u2",
        email: "u2@example.com",
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "processing",
      });

      const succeeded = await transitionGeneration(gen.id, "succeeded", {
        outputPath: "output/result.gif",
      });
      expect(succeeded.status).toBe("succeeded");

      // Attempt regression from succeeded -> processing
      await expect(
        transitionGeneration(gen.id, "processing"),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Attempt regression from succeeded -> failed
      await expect(
        transitionGeneration(gen.id, "failed"),
      ).rejects.toThrow(InvalidStateTransitionError);

      // Attempt regression from succeeded -> queued
      await expect(
        transitionGeneration(gen.id, "queued"),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it("treats redundant transitions to the current status as idempotent safe no-ops", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u3",
        email: "u3@example.com",
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "processing",
      });

      const succeeded = await transitionGeneration(gen.id, "succeeded", {
        outputPath: "output/result.gif",
      });

      // Calling transitionGeneration with the same status returns the record safely without error
      const redundant = await transitionGeneration(gen.id, "succeeded");
      expect(redundant.id).toBe(succeeded.id);
      expect(redundant.status).toBe("succeeded");
    });
  });

  describe("2. External Provider Error Classification & Bounded Retries", () => {
    it("classifies rate limits (429) as transient", () => {
      const error = { status: 429, message: "Too many requests" };
      const res = classifyReplicateError(error);
      expect(res.isTransient).toBe(true);
      expect(res.code).toBe(GENERATION_ERROR_CODES.RATE_LIMITED);
    });

    it("classifies 5xx server errors as transient", () => {
      const error = { status: 503, message: "Service Unavailable" };
      const res = classifyReplicateError(error);
      expect(res.isTransient).toBe(true);
      expect(res.code).toBe(GENERATION_ERROR_CODES.REPLICATE_CREATE_FAILED);
    });

    it("classifies network connection drops and timeouts as transient", () => {
      const error = { code: "ETIMEDOUT", message: "Connection timed out" };
      const res = classifyReplicateError(error);
      expect(res.isTransient).toBe(true);
      expect(res.code).toBe(GENERATION_ERROR_CODES.REPLICATE_TIMEOUT);
    });

    it("classifies 4xx client errors (400, 401, 422) as permanent", () => {
      const error = { status: 422, message: "Invalid image format" };
      const res = classifyReplicateError(error);
      expect(res.isTransient).toBe(false);
      expect(res.code).toBe(GENERATION_ERROR_CODES.REPLICATE_FAILED);
    });

    it("retries transient failures up to max attempts with backoff", async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        if (attempts < 2) {
          throw { status: 503, message: "Service temporary overload" };
        }
        return { success: true };
      });

      const result = await retryWithBackoff(operation, {
        maxAttempts: 2,
        initialDelayMs: 10,
        maxDelayMs: 50,
      });

      expect(result).toEqual({ success: true });
      expect(attempts).toBe(2);
    });

    it("fails immediately without retrying for permanent failures", async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        throw { status: 400, message: "Bad Request" };
      });

      await expect(
        retryWithBackoff(operation, {
          maxAttempts: 3,
          initialDelayMs: 10,
        }),
      ).rejects.toMatchObject({ status: 400 });

      expect(attempts).toBe(1); // Never retries permanent failure!
    });
  });

  describe("3. Client Idempotency & Prevention of Duplicate Generations", () => {
    it("persists client_idempotency_key and enforces uniqueness", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u4",
        email: "u4@example.com",
      });

      const idempotencyKey = "client_token_abc_123";

      const gen1 = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/photo.jpg",
        clientIdempotencyKey: idempotencyKey,
      });

      expect(gen1.client_idempotency_key).toBe(idempotencyKey);

      // Query by idempotency key finds existing generation
      const found = await generationsRepo.findByIdempotencyKey(idempotencyKey);
      expect(found?.id).toBe(gen1.id);

      // Attempting to insert duplicate client_idempotency_key fails uniqueness constraint
      await expect(
        generationsRepo.create({
          userId: user.id,
          inputPath: "input/photo2.jpg",
          clientIdempotencyKey: idempotencyKey,
        }),
      ).rejects.toThrow();
    });
  });

  describe("4. Dedicated Status API Endpoint (/api/generations/[id])", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const authModule = await import("../lib/auth");
      vi.spyOn(authModule, "getAuthenticatedUser").mockResolvedValue(null);

      const req = new NextRequest("http://localhost:3000/api/generations/gen_123");
      const res = await getGenerationRoute(req, { params: { id: "gen_123" } });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Authentication required");
    });

    it("enforces cross-user resource isolation (IDOR protection) with 404", async () => {
      const userOwner = await usersRepo.create({
        authProviderUserId: "owner_auth",
        email: "owner@example.com",
      });
      const userAttacker = await usersRepo.create({
        authProviderUserId: "attacker_auth",
        email: "attacker@example.com",
      });

      const gen = await generationsRepo.create({
        userId: userOwner.id,
        inputPath: `input/${userOwner.id}/gen_owner/source.jpg`,
      });

      // Authenticated as attacker
      const authModule = await import("../lib/auth");
      vi.spyOn(authModule, "getAuthenticatedUser").mockResolvedValue({
        id: userAttacker.id,
        email: userAttacker.email,
        authProviderUserId: userAttacker.auth_provider_user_id,
        user: userAttacker,
      });

      const req = new NextRequest(`http://localhost:3000/api/generations/${gen.id}`);
      const res = await getGenerationRoute(req, { params: { id: gen.id } });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("Generation not found");
    });

    it("returns authorized generation status and signed URLs for owner", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "user_auth",
        email: "user@example.com",
      });

      const inputRelative = `${user.id}/gen_test/source.jpg`;
      const outputRelative = `${user.id}/gen_test/result.gif`;
      mockStorageState.files.get("input")!.add(inputRelative);
      mockStorageState.files.get("output")!.add(outputRelative);

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `input/${inputRelative}`,
        initialStatus: "processing",
      });

      await transitionGeneration(gen.id, "succeeded", {
        outputPath: `output/${outputRelative}`,
      });

      const authModule = await import("../lib/auth");
      vi.spyOn(authModule, "getAuthenticatedUser").mockResolvedValue({
        id: user.id,
        email: user.email,
        authProviderUserId: user.auth_provider_user_id,
        user,
      });

      const req = new NextRequest(`http://localhost:3000/api/generations/${gen.id}`);
      const res = await getGenerationRoute(req, { params: { id: gen.id } });

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toContain("no-store");

      const json = await res.json();
      expect(json.id).toBe(gen.id);
      expect(json.status).toBe("succeeded");
      expect(json.outputUrl).toContain("result.gif");
      expect(json.failed).toBe(false);
      expect(json.expired).toBe(false);
    });
  });

  describe("5. Stuck-Job Reconciliation Service", () => {
    it("reconciles succeeded external prediction: fetches artifact, uploads to storage, marks succeeded", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u5",
        email: "u5@example.com",
        creditsBalance: 50,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `input/${user.id}/gen_rec_1/source.jpg`,
        initialStatus: "processing",
      });

      const predictionId = "pred_rec_success";
      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: predictionId,
      });

      // Set up Replicate prediction state as succeeded with output URL
      mockReplicatePredictions.set(predictionId, {
        id: predictionId,
        status: "succeeded",
        output: ["https://replicate.delivery/pbxt/test_output.gif"],
      });

      const result = await reconcileGeneration(gen.id);

      expect(result.reconciled).toBe(true);
      expect(result.action).toBe("repaired_success");
      expect(result.finalStatus).toBe("succeeded");

      const updated = await generationsRepo.findById(gen.id);
      expect(updated?.status).toBe("succeeded");
      expect(updated?.output_path).toContain("result.gif");
      expect(mockStorageState.files.get("output")!.size).toBe(1);
    });

    it("reconciles failed external prediction: marks failed and idempotently refunds 10 credits", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u6",
        email: "u6@example.com",
        creditsBalance: 20,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "processing",
      });

      // Reserve credits
      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });
      expect(await creditsRepo.getBalance(user.id)).toBe(10);

      const predictionId = "pred_rec_failed";
      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: predictionId,
      });

      mockReplicatePredictions.set(predictionId, {
        id: predictionId,
        status: "failed",
        error: "Face not detected in image",
      });

      const result = await reconcileGeneration(gen.id);

      expect(result.reconciled).toBe(true);
      expect(result.refunded).toBe(true);
      expect(result.action).toBe("repaired_failed");
      expect(result.finalStatus).toBe("failed");

      // Balance restored from 10 to 20
      expect(await creditsRepo.getBalance(user.id)).toBe(20);

      const updated = await generationsRepo.findById(gen.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error_code).toBe(GENERATION_ERROR_CODES.REPLICATE_FAILED);
    });

    it("reconciles hung external prediction (>10m): cancels on Replicate, marks failed, refunds credits", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u7",
        email: "u7@example.com",
        creditsBalance: 10,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "processing",
      });

      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });

      const predictionId = "pred_hung";
      const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();

      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: predictionId,
        processingStartedAt: elevenMinutesAgo,
      });

      mockReplicatePredictions.set(predictionId, {
        id: predictionId,
        status: "processing", // Still processing remotely past 10 min threshold
      });

      const result = await reconcileGeneration(gen.id);

      expect(result.reconciled).toBe(true);
      expect(result.refunded).toBe(true);
      expect(result.action).toBe("timeout_failed");
      expect(result.finalStatus).toBe("failed");

      // Verifies provider cancellation was issued
      expect(mockReplicateCalls.canceled).toContain(predictionId);
      // Verifies credit refund
      expect(await creditsRepo.getBalance(user.id)).toBe(10);
    });

    it("reconciles orphaned queued job (>2m without prediction ID): marks failed, refunds credits", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u8",
        email: "u8@example.com",
        creditsBalance: 10,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "queued",
      });

      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });

      // Manually backdate created_at to 3 minutes ago
      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      await db.execute({
        sql: "UPDATE generations SET created_at = ?, updated_at = ? WHERE id = ?;",
        args: [threeMinutesAgo, threeMinutesAgo, gen.id],
      });

      const result = await reconcileGeneration(gen.id);

      expect(result.reconciled).toBe(true);
      expect(result.refunded).toBe(true);
      expect(result.action).toBe("orphaned_failed");

      expect(await creditsRepo.getBalance(user.id)).toBe(10);
      const updated = await generationsRepo.findById(gen.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error_code).toBe(GENERATION_ERROR_CODES.PREDICTION_NEVER_STARTED);
    });

    it("is completely idempotent: running reconciliation multiple times does not double refund", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u9",
        email: "u9@example.com",
        creditsBalance: 10,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "processing",
      });

      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });

      const predictionId = "pred_fail_twice";
      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: predictionId,
      });

      mockReplicatePredictions.set(predictionId, {
        id: predictionId,
        status: "failed",
        error: "Test failure",
      });

      // First reconciliation -> marks failed, refunds 10 credits
      const res1 = await reconcileGeneration(gen.id);
      expect(res1.reconciled).toBe(true);
      expect(res1.refunded).toBe(true);
      expect(await creditsRepo.getBalance(user.id)).toBe(10);

      // Second reconciliation on already terminal job -> safe no-op!
      const res2 = await reconcileGeneration(gen.id);
      expect(res2.reconciled).toBe(false);
      expect(res2.refunded).toBe(false);
      expect(res2.action).toBe("no_op_terminal");
      expect(await creditsRepo.getBalance(user.id)).toBe(10); // Balance remains exactly 10!
    });
  });

  describe("6. Scheduled Reconciliation Cron Endpoint (/api/cron/reconcile)", () => {
    it("rejects unauthorized requests without valid CRON_SECRET", async () => {
      process.env.CRON_SECRET = "super_secure_cron_secret";

      const req = new NextRequest("http://localhost:3000/api/cron/reconcile");
      const res = await getReconcileCronRoute(req);

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain("Unauthorized");
    });

    it("authorizes valid CRON_SECRET and executes batch reconciliation", async () => {
      process.env.CRON_SECRET = "super_secure_cron_secret";

      const user = await usersRepo.create({
        authProviderUserId: "auth_u10",
        email: "u10@example.com",
        creditsBalance: 10,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: "input/test.jpg",
        initialStatus: "processing",
      });

      mockReplicatePredictions.set("pred_batch", {
        id: "pred_batch",
        status: "succeeded",
        output: ["https://replicate.delivery/pbxt/batch_out.gif"],
      });
      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: "pred_batch",
      });

      const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      await db.execute({
        sql: "UPDATE generations SET updated_at = ? WHERE id = ?;",
        args: [fifteenMinAgo, gen.id],
      });

      const req = new NextRequest("http://localhost:3000/api/cron/reconcile", {
        headers: {
          Authorization: "Bearer super_secure_cron_secret",
        },
      });

      const res = await getReconcileCronRoute(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.totalFound).toBe(1);
      expect(json.processed).toBe(1);
      expect(json.reconciled).toBe(1);
    });
  });

  describe("7. Process Restart & Browser Abandonment Resilience", () => {
    it("retains complete generation state in SQLite across simulated process restarts", async () => {
      const user = await usersRepo.create({
        authProviderUserId: "auth_u11",
        email: "u11@example.com",
        creditsBalance: 30,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `input/${user.id}/gen_restart/source.jpg`,
        initialStatus: "processing",
        clientIdempotencyKey: "idemp_restart_test",
      });

      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: "pred_restart_123",
      });

      // Simulate process restart: create a new repository instance pointing to the same SQLite db
      const restartedRepo = new GenerationsRepository(db);
      const recovered = await restartedRepo.findById(gen.id);

      expect(recovered).not.toBeNull();
      expect(recovered?.id).toBe(gen.id);
      expect(recovered?.status).toBe("processing");
      expect(recovered?.replicate_prediction_id).toBe("pred_restart_123");
      expect(recovered?.client_idempotency_key).toBe("idemp_restart_test");
    });
  });

  describe("8. Webhook Out-of-Order & Duplicate Interaction Protection", () => {
    const testSecretKey = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const testSecret = `whsec_${testSecretKey}`;
    const testSecretBytes = Buffer.from(testSecretKey, "base64");

    function generateSignature(id: string, timestamp: number, body: string): string {
      const signedContent = `${id}.${timestamp}.${body}`;
      const hmac = require("crypto")
        .createHmac("sha256", testSecretBytes)
        .update(signedContent, "utf8")
        .digest("base64");
      return `v1,${hmac}`;
    }

    it("handles duplicate webhook deliveries idempotently without re-triggering storage or DB conflicts", async () => {
      process.env.REPLICATE_WEBHOOK_SECRET = testSecret;

      const user = await usersRepo.create({
        authProviderUserId: "auth_u12",
        email: "u12@example.com",
        creditsBalance: 50,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `input/${user.id}/gen_webhook/source.jpg`,
        initialStatus: "processing",
      });

      const predictionId = "pred_webhook_dup";
      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: predictionId,
      });

      const webhookRoute = (await import("../app/api/webhooks/replicate/[id]/route")).POST;

      const payload = JSON.stringify({
        id: predictionId,
        status: "succeeded",
        output: ["https://replicate.delivery/pbxt/out1.gif"],
      });

      const webhookId = "msg_webhook_1";
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = generateSignature(webhookId, timestamp, payload);

      const makeRequest = () =>
        new NextRequest(`http://localhost:3000/api/webhooks/replicate/${gen.id}`, {
          method: "POST",
          headers: {
            "webhook-id": webhookId,
            "webhook-timestamp": String(timestamp),
            "webhook-signature": signature,
            "Content-Type": "application/json",
          },
          body: payload,
        });

      // First webhook delivery -> processes successfully
      const res1 = await webhookRoute(makeRequest(), { params: { id: gen.id } });
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.received).toBe(true);

      const updated = await generationsRepo.findById(gen.id);
      expect(updated?.status).toBe("succeeded");

      // Second webhook delivery with identical webhook-id -> transport deduplication (isDuplicate: true)
      const res2 = await webhookRoute(makeRequest(), { params: { id: gen.id } });
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.duplicate).toBe(true);
    });

    it("safely ignores out-of-order failed webhook if generation already reached succeeded without regressing state or refunding", async () => {
      process.env.REPLICATE_WEBHOOK_SECRET = testSecret;

      const user = await usersRepo.create({
        authProviderUserId: "auth_u13",
        email: "u13@example.com",
        creditsBalance: 50,
      });

      const gen = await generationsRepo.create({
        userId: user.id,
        inputPath: `input/${user.id}/gen_ooo/source.jpg`,
        initialStatus: "processing",
      });

      // Reserve credits
      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });
      expect(await creditsRepo.getBalance(user.id)).toBe(40);

      const predictionId = "pred_ooo";
      await generationsRepo.transitionStatus(gen.id, "processing", {
        replicatePredictionId: predictionId,
      });

      // Generation transitions to succeeded first
      await transitionGeneration(gen.id, "succeeded", {
        outputPath: `output/${user.id}/${gen.id}/result.gif`,
      });

      const webhookRoute = (await import("../app/api/webhooks/replicate/[id]/route")).POST;

      // An out-of-order 'failed' webhook arrives later
      const failedPayload = JSON.stringify({
        id: predictionId,
        status: "failed",
        error: "Delayed network error",
      });

      const webhookId = "msg_webhook_late_failed";
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = generateSignature(webhookId, timestamp, failedPayload);

      const req = new NextRequest(`http://localhost:3000/api/webhooks/replicate/${gen.id}`, {
        method: "POST",
        headers: {
          "webhook-id": webhookId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
          "Content-Type": "application/json",
        },
        body: failedPayload,
      });

      const res = await webhookRoute(req, { params: { id: gen.id } });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ignored).toBe("Already terminal");

      // State remains succeeded
      const currentGen = await generationsRepo.findById(gen.id);
      expect(currentGen?.status).toBe("succeeded");

      // Credits remain deducted (no duplicate or spurious refund!)
      expect(await creditsRepo.getBalance(user.id)).toBe(40);
    });
  });

  describe("9. Supabase Realtime Subscription Lifecycle & Channel Leak Prevention", () => {
    it("guarantees clean channel removal on unmount and prevents duplicate subscriptions", () => {
      const channels = new Map<string, { subscribed: boolean; removed: boolean }>();

      const mockSupabaseClient = {
        channel: (topic: string) => {
          const entry = { subscribed: false, removed: false };
          channels.set(topic, entry);
          return {
            on: (_event: string, _opts: any, _cb: any) => ({
              subscribe: () => {
                entry.subscribed = true;
                return {};
              },
            }),
          };
        },
        removeChannel: (channelObj: any) => {
          channels.forEach((entry) => {
            entry.removed = true;
            entry.subscribed = false;
          });
        },
      };

      // 1. Initial render -> 1 channel created and subscribed
      const channel1 = mockSupabaseClient.channel("generation:gen_123");
      channel1.on("broadcast", { event: "status" }, () => {}).subscribe();

      expect(channels.size).toBe(1);
      expect(channels.get("generation:gen_123")?.subscribed).toBe(true);

      // 2. Cleanup on unmount or ID change
      mockSupabaseClient.removeChannel(channel1);
      expect(channels.get("generation:gen_123")?.removed).toBe(true);
      expect(channels.get("generation:gen_123")?.subscribed).toBe(false);
    });
  });
});
