import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createClient } from "@libsql/client";
import sharp from "sharp";
import {
  UsersRepository,
  GenerationsRepository,
  CreditsRepository,
  runMigrations,
} from "../lib/db";
import {
  getInputKey,
  getOutputKey,
  getTempKey,
  parseStoragePath,
  sanitizePathSegment,
  InvalidPathError,
  RETENTION_CONFIG,
  calculateGenerationExpiresAt,
  isGenerationExpired,
  getAuthorizedGenerationAsset,
  deleteUserStorageAssets,
  deleteGenerationAssets,
  cleanExpiredTemporaryAssets,
  StorageUnauthorizedError,
  AssetExpiredError,
  StorageNotFoundError,
} from "../lib/storage";
import {
  validateAndNormalizeImage,
  detectImageMagicBytes,
  ImageValidationError,
  MAX_IMAGE_SIZE_BYTES,
} from "../lib/validation/image";
import { validateDeleteConfirmation } from "../lib/validation";

// Mock Supabase admin client for storage tests
const mockStorageState: {
  files: Map<string, Set<string>>; // bucket -> Set of file keys
  signedUrls: Map<string, string>;
} = {
  files: new Map<string, Set<string>>([
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
          const signedUrl = `https://mock-supabase.co/storage/v1/object/sign/${bucket}/${path}?token=mock_token_expires_${expiresIn}`;
          return { data: { signedUrl }, error: null };
        }),
        upload: vi.fn(async (path: string, buffer: any, options: any) => {
          mockStorageState.files.get(bucket)?.add(path.replace(/^\/+/, ""));
          return { data: { path }, error: null };
        }),
        remove: vi.fn(async (paths: string[]) => {
          const bucketFiles = mockStorageState.files.get(bucket);
          for (const p of paths) {
            bucketFiles?.delete(p.replace(/^\/+/, ""));
          }
          return { data: paths, error: null };
        }),
        list: vi.fn(async (prefix = "", options?: any) => {
          const bucketFiles = mockStorageState.files.get(bucket) || new Set<string>();
          const cleanPrefix = prefix ? prefix.replace(/^\/+/, "").replace(/\/+$/, "") : "";
          const matchingItems: Array<{ name: string; id: string | null; created_at: string }> = [];

          const seenDirs = new Set<string>();
          Array.from(bucketFiles).forEach((filePath) => {
            if (!cleanPrefix || filePath.startsWith(`${cleanPrefix}/`)) {
              const relative = cleanPrefix ? filePath.slice(cleanPrefix.length + 1) : filePath;
              const parts = relative.split("/");
              if (parts.length > 1) {
                // It's a directory
                const dirName = parts[0];
                if (!seenDirs.has(dirName)) {
                  seenDirs.add(dirName);
                  matchingItems.push({ name: dirName, id: null, created_at: new Date().toISOString() });
                }
              } else {
                // It's a file
                matchingItems.push({ name: parts[0], id: parts[0], created_at: new Date().toISOString() });
              }
            }
          });
          return { data: matchingItems, error: null };
        }),
      }),
    },
    auth: {
      admin: {
        deleteUser: vi.fn(async (userId: string) => {
          return { data: { user: { id: userId, email: "user@example.com" } }, error: null };
        }),
      },
    },
  }),
}));

describe("Phase 4 — Storage, Privacy & Account Lifecycle", () => {
  let db: ReturnType<typeof createClient>;
  let usersRepo: UsersRepository;
  let generationsRepo: GenerationsRepository;
  let creditsRepo: CreditsRepository;

  beforeEach(async () => {
    resetMockStorage();
    db = createClient({ url: ":memory:" });
    await runMigrations(db);

    usersRepo = new UsersRepository(db);
    generationsRepo = new GenerationsRepository(db);
    creditsRepo = new CreditsRepository(db);

    // Mock getGenerationsRepository in db module
    vi.spyOn(await import("../lib/db"), "getGenerationsRepository").mockReturnValue(generationsRepo);
    vi.spyOn(await import("../lib/db"), "getUsersRepository").mockReturnValue(usersRepo);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe("1. Deterministic Storage Keys & Path Traversal Prevention", () => {
    it("generates safe, canonical object keys", () => {
      const inputKey = getInputKey("user_123", "gen_456", "jpg");
      expect(inputKey).toBe("user_123/gen_456/source.jpg");

      const outputKey = getOutputKey("user_123", "gen_456", "gif");
      expect(outputKey).toBe("user_123/gen_456/result.gif");

      const tempKey = getTempKey("user_123", "gen_456", "rnd_789");
      expect(tempKey).toBe("user_123/gen_456/rnd_789");
    });

    it("rejects directory traversal and path escape attempts", () => {
      expect(() => sanitizePathSegment("../evil")).toThrow(InvalidPathError);
      expect(() => sanitizePathSegment("..\\evil")).toThrow(InvalidPathError);
      expect(() => sanitizePathSegment("evil/path")).toThrow(InvalidPathError);
      expect(() => sanitizePathSegment("/root")).toThrow(InvalidPathError);
      expect(() => sanitizePathSegment("foo%2e%2ebar")).toThrow(InvalidPathError);
      expect(() => sanitizePathSegment("null\0byte")).toThrow(InvalidPathError);
      expect(() => sanitizePathSegment("")).toThrow(InvalidPathError);
    });

    it("parses both canonical relative keys and legacy public URLs", () => {
      const canonical = parseStoragePath("input/user_abc/gen_xyz/source.jpg");
      expect(canonical.bucket).toBe("input");
      expect(canonical.path).toBe("user_abc/gen_xyz/source.jpg");

      const legacyUrl = parseStoragePath(
        "https://example.supabase.co/storage/v1/object/public/output/user_abc/gen_xyz/result.gif",
      );
      expect(legacyUrl.bucket).toBe("output");
      expect(legacyUrl.path).toBe("user_abc/gen_xyz/result.gif");
    });
  });

  describe("2. Image Validation Pipeline & Metadata Stripping", () => {
    it("detects valid image magic bytes", async () => {
      const testJpeg = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
      })
        .jpeg()
        .toBuffer();

      const testPng = await sharp({
        create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
      })
        .png()
        .toBuffer();

      const testWebp = await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
      })
        .webp()
        .toBuffer();

      expect(detectImageMagicBytes(testJpeg)).toBe("jpeg");
      expect(detectImageMagicBytes(testPng)).toBe("png");
      expect(detectImageMagicBytes(testWebp)).toBe("webp");

      // Non-image
      const textBuffer = Buffer.from("Hello world, this is a plain text file!");
      expect(detectImageMagicBytes(textBuffer)).toBeNull();
    });

    it("rejects non-image payloads even if disguised", async () => {
      const fakeImage = Buffer.from("fake image contents disguised as jpg");
      await expect(validateAndNormalizeImage(fakeImage)).rejects.toThrow(ImageValidationError);
    });

    it("rejects images exceeding the 10MB size limit", async () => {
      const fakeOversized = Buffer.alloc(MAX_IMAGE_SIZE_BYTES + 100);
      fakeOversized[0] = 0xff;
      fakeOversized[1] = 0xd8;
      fakeOversized[2] = 0xff;

      await expect(validateAndNormalizeImage(fakeOversized)).rejects.toThrow(ImageValidationError);
    });

    it("rejects images with dimensions below minimum bounds", async () => {
      const tinyImage = await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 255, g: 0, b: 0 } },
      })
        .jpeg()
        .toBuffer();

      await expect(validateAndNormalizeImage(tinyImage)).rejects.toThrow(/too small/);
    });

    it("normalizes image and strips EXIF/GPS metadata", async () => {
      // Create image with dummy EXIF metadata
      const rawImage = await sharp({
        create: { width: 200, height: 200, channels: 3, background: { r: 120, g: 120, b: 120 } },
      })
        .jpeg({ quality: 90 })
        .withMetadata({
          exif: {
            IFD0: {
              Make: "TestCamera",
              Model: "SuperModelX",
            },
          },
        })
        .toBuffer();

      const normalized = await validateAndNormalizeImage(rawImage);
      expect(normalized.format).toBe("jpeg");
      expect(normalized.mimeType).toBe("image/jpeg");
      expect(normalized.width).toBe(200);
      expect(normalized.height).toBe(200);

      // Verify the normalized image has no EXIF Make/Model
      const inspectMetadata = await sharp(normalized.buffer).metadata();
      expect(inspectMetadata.exif).toBeUndefined();
    });
  });

  describe("3. Storage Authorization & Cross-User Isolation", () => {
    it("allows resource owner to access their own assets with short-lived signed URLs", async () => {
      const user = await usersRepo.create({
        id: "user_owner",
        auth_provider_user_id: "auth_owner",
        email: "owner@example.com",
      });

      const gen = await generationsRepo.create({
        id: "gen_test_1",
        userId: user.id,
        inputPath: "input/user_owner/gen_test_1/source.jpg",
      });

      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output/user_owner/gen_test_1/result.gif",
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });

      const inputAsset = await getAuthorizedGenerationAsset(user.id, gen.id, "input");
      expect(inputAsset.signedUrl).toContain("mock_token");
      expect(inputAsset.bucket).toBe("input");
      expect(inputAsset.path).toBe("user_owner/gen_test_1/source.jpg");

      const outputAsset = await getAuthorizedGenerationAsset(user.id, gen.id, "output");
      expect(outputAsset.signedUrl).toContain("mock_token");
      expect(outputAsset.bucket).toBe("output");
      expect(outputAsset.path).toBe("user_owner/gen_test_1/result.gif");
    });

    it("strictly forbids User B from accessing User A's input or output assets (IDOR defense)", async () => {
      const userA = await usersRepo.create({
        id: "user_a",
        auth_provider_user_id: "auth_a",
        email: "a@example.com",
      });

      const userB = await usersRepo.create({
        id: "user_b",
        auth_provider_user_id: "auth_b",
        email: "b@example.com",
      });

      const genA = await generationsRepo.create({
        id: "gen_a",
        userId: userA.id,
        inputPath: "input/user_a/gen_a/source.jpg",
      });

      await generationsRepo.transitionStatus(genA.id, "processing");
      await generationsRepo.transitionStatus(genA.id, "succeeded", {
        outputPath: "output/user_a/gen_a/result.gif",
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });

      // User B attempts to access User A's input
      await expect(getAuthorizedGenerationAsset(userB.id, genA.id, "input")).rejects.toThrow(
        StorageUnauthorizedError,
      );

      // User B attempts to access User A's output
      await expect(getAuthorizedGenerationAsset(userB.id, genA.id, "output")).rejects.toThrow(
        StorageUnauthorizedError,
      );
    });

    it("rejects access to expired assets", async () => {
      const user = await usersRepo.create({
        id: "user_expired",
        auth_provider_user_id: "auth_expired",
        email: "expired@example.com",
      });

      const gen = await generationsRepo.create({
        id: "gen_expired",
        userId: user.id,
        inputPath: "input/user_expired/gen_expired/source.jpg",
      });

      await generationsRepo.transitionStatus(gen.id, "processing");
      // Set expired in the past
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output/user_expired/gen_expired/result.gif",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      await expect(getAuthorizedGenerationAsset(user.id, gen.id, "output")).rejects.toThrow(
        AssetExpiredError,
      );
    });
  });

  describe("4. Retention Policy & Lifecycle Scheduling", () => {
    it("calculates correct retention deadlines", () => {
      const now = new Date();
      const succeededExpiry = calculateGenerationExpiresAt("succeeded", now);
      expect(succeededExpiry).not.toBeNull();
      const diffHours = (new Date(succeededExpiry!).getTime() - now.getTime()) / (3600 * 1000);
      expect(Math.round(diffHours)).toBe(RETENTION_CONFIG.GENERATION_ASSET_TTL_HOURS);

      const failedExpiry = calculateGenerationExpiresAt("failed", now);
      const failedDiffHours = (new Date(failedExpiry!).getTime() - now.getTime()) / (3600 * 1000);
      expect(Math.round(failedDiffHours)).toBe(RETENTION_CONFIG.FAILED_GENERATION_TTL_HOURS);

      // Active jobs do not have an expiration deadline set
      expect(calculateGenerationExpiresAt("queued")).toBeNull();
      expect(calculateGenerationExpiresAt("processing")).toBeNull();
    });

    it("detects expired generation status accurately", () => {
      const past = new Date(Date.now() - 3600 * 1000).toISOString();
      const future = new Date(Date.now() + 3600 * 1000).toISOString();

      expect(isGenerationExpired({ status: "succeeded", expires_at: past })).toBe(true);
      expect(isGenerationExpired({ status: "succeeded", expires_at: future })).toBe(false);
      expect(isGenerationExpired({ status: "expired" })).toBe(true);
      expect(isGenerationExpired({ status: "succeeded", cleaned_up_at: past })).toBe(true);
    });

    it("finds expired generations eligible for cleanup in bounded batches", async () => {
      const user = await usersRepo.create({
        id: "user_batch",
        auth_provider_user_id: "auth_batch",
        email: "batch@example.com",
      });

      const past = new Date(Date.now() - 5000).toISOString();
      const future = new Date(Date.now() + 100000).toISOString();

      // Create 3 expired generations
      for (let i = 1; i <= 3; i++) {
        const g = await generationsRepo.create({
          id: `gen_batch_${i}`,
          userId: user.id,
          inputPath: `input/user_batch/gen_batch_${i}/source.jpg`,
        });
        await generationsRepo.transitionStatus(g.id, "processing");
        await generationsRepo.transitionStatus(g.id, "succeeded", {
          outputPath: `output/user_batch/gen_batch_${i}/result.gif`,
          expiresAt: past,
        });
      }

      // Create 1 active (unexpired) generation
      const activeGen = await generationsRepo.create({
        id: "gen_active",
        userId: user.id,
        inputPath: "input/user_batch/gen_active/source.jpg",
      });
      await generationsRepo.transitionStatus(activeGen.id, "processing");
      await generationsRepo.transitionStatus(activeGen.id, "succeeded", {
        outputPath: "output/user_batch/gen_active/result.gif",
        expiresAt: future,
      });

      const expiredList = await generationsRepo.findExpiredGenerations({ limit: 50 });
      expect(expiredList.length).toBe(3);
      expect(expiredList.map((g) => g.id)).toEqual(
        expect.arrayContaining(["gen_batch_1", "gen_batch_2", "gen_batch_3"]),
      );
      expect(expiredList.map((g) => g.id)).not.toContain("gen_active");
    });
  });

  describe("5. Durable Account Deletion Lifecycle", () => {
    it("validates exact confirmation phrase before deletion", () => {
      expect(validateDeleteConfirmation("delete my account")).toBe(true);
      expect(validateDeleteConfirmation("Delete My Account")).toBe(true);
      expect(validateDeleteConfirmation("delete account")).toBe(false);
      expect(validateDeleteConfirmation("")).toBe(false);
      expect(validateDeleteConfirmation(null)).toBe(false);
    });

    it("recursively discovers exact file keys and purges user storage across buckets", async () => {
      const userId = "user_purge_test";

      // Seed mock storage with exact files
      mockStorageState.files.get("input")!.add(`${userId}/gen_1/source.jpg`);
      mockStorageState.files.get("input")!.add(`${userId}/gen_2/source.jpg`);
      mockStorageState.files.get("output")!.add(`${userId}/gen_1/result.gif`);
      mockStorageState.files.get("temp")!.add(`${userId}/gen_1/temp_artifact`);
      // Another user's file that MUST NOT be deleted
      mockStorageState.files.get("input")!.add("other_user/gen_99/source.jpg");

      const result = await deleteUserStorageAssets(userId);
      expect(result.errors).toHaveLength(0);
      expect(result.deletedCount).toBe(4);

      // Verify user's files are gone
      expect(mockStorageState.files.get("input")!.has(`${userId}/gen_1/source.jpg`)).toBe(false);
      expect(mockStorageState.files.get("input")!.has(`${userId}/gen_2/source.jpg`)).toBe(false);
      expect(mockStorageState.files.get("output")!.has(`${userId}/gen_1/result.gif`)).toBe(false);
      expect(mockStorageState.files.get("temp")!.has(`${userId}/gen_1/temp_artifact`)).toBe(false);

      // Verify other user's file is intact
      expect(mockStorageState.files.get("input")!.has("other_user/gen_99/source.jpg")).toBe(true);
    });

    it("preserves financial ledger records while anonymizing user PII", async () => {
      const user = await usersRepo.create({
        id: "user_audit_test",
        auth_provider_user_id: "auth_audit_test",
        email: "alice@example.com",
        name: "Alice Smith",
        credits_balance: 100,
      });

      // User performs purchase and reservations
      await creditsRepo.recordStripePurchase({
        userId: user.id,
        amount: 100,
        stripeEventId: "evt_test_delete_1",
      });

      const gen = await generationsRepo.create({
        id: "gen_audit_1",
        userId: user.id,
        inputPath: "input/user_audit_test/gen_audit_1/source.jpg",
      });

      await creditsRepo.reserveCredits({
        userId: user.id,
        generationId: gen.id,
        amount: 10,
      });

      // Mark user deleted with PII anonymization
      await usersRepo.markDeletedWithAnonymization(user.id);

      // Verify user record
      const updatedUser = await usersRepo.findById(user.id);
      expect(updatedUser).not.toBeNull();
      expect(updatedUser!.deletion_status).toBe("deleted");
      expect(updatedUser!.deleted_at).not.toBeNull();
      expect(updatedUser!.email).toBe(`deleted-${user.id}@deleted.extrapolate.app`);
      expect(updatedUser!.name).toBe("Deleted User");
      expect(updatedUser!.image).toBeNull();
      expect(updatedUser!.credits_balance).toBe(0);

      // Verify Credit Ledger integrity: audit records remain intact!
      const ledgerHistory = await creditsRepo.listLedgerForUser(user.id);
      expect(ledgerHistory.length).toBe(2);
      expect(ledgerHistory[0].type).toBe("reservation");
      expect(ledgerHistory[1].type).toBe("purchase");
    });
  });

  describe("6. Scheduled Cleanup Cron Endpoint & Idempotency", () => {
    it("rejects unauthorized cleanup requests when CRON_SECRET is missing or invalid", async () => {
      process.env.CRON_SECRET = "super_secret_cron_token";
      const { GET: cleanupHandler } = await import("../app/api/cron/cleanup/route");

      // No auth header
      const req1 = new Request("http://localhost/api/cron/cleanup");
      const res1 = await cleanupHandler(req1 as any);
      expect(res1.status).toBe(401);

      // Wrong secret
      const req2 = new Request("http://localhost/api/cron/cleanup", {
        headers: { Authorization: "Bearer wrong_secret" },
      });
      const res2 = await cleanupHandler(req2 as any);
      expect(res2.status).toBe(401);
    });

    it("authorizes valid CRON_SECRET, executes batch deletions, and is idempotent", async () => {
      process.env.CRON_SECRET = "super_secret_cron_token";
      const { GET: cleanupHandler } = await import("../app/api/cron/cleanup/route");

      const user = await usersRepo.create({
        id: "user_cron_test",
        auth_provider_user_id: "auth_cron_test",
        email: "cron@example.com",
      });

      const past = new Date(Date.now() - 10000).toISOString();
      const gen = await generationsRepo.create({
        id: "gen_cron_1",
        userId: user.id,
        inputPath: "input/user_cron_test/gen_cron_1/source.jpg",
      });

      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output/user_cron_test/gen_cron_1/result.gif",
        expiresAt: past,
      });

      // Seed mock storage
      mockStorageState.files.get("input")!.add("user_cron_test/gen_cron_1/source.jpg");
      mockStorageState.files.get("output")!.add("user_cron_test/gen_cron_1/result.gif");

      // Execute cleanup
      const req = new Request("http://localhost/api/cron/cleanup", {
        headers: { Authorization: "Bearer super_secret_cron_token" },
      });
      const res = await cleanupHandler(req as any);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.processed).toBe(1);
      expect(json.succeeded).toBe(1);

      // Verify files were removed
      expect(mockStorageState.files.get("input")!.has("user_cron_test/gen_cron_1/source.jpg")).toBe(false);
      expect(mockStorageState.files.get("output")!.has("user_cron_test/gen_cron_1/result.gif")).toBe(false);

      // Verify DB generation is marked cleaned up and expired
      const updatedGen = await generationsRepo.findById(gen.id);
      expect(updatedGen!.status).toBe("expired");
      expect(updatedGen!.cleaned_up_at).not.toBeNull();

      // Rerun cleanup immediately: Idempotent!
      const res2 = await cleanupHandler(req as any);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.processed).toBe(0); // already cleaned up, 0 remaining
    });
  });

  describe("7. Asset Delivery Endpoint & Access Control", () => {
    it("handles invalid generation ID or unsupported asset types", async () => {
      const { GET: assetHandler } = await import("../app/api/assets/[id]/[type]/route");

      // Invalid generation ID
      const req1 = new Request("http://localhost/api/assets/bad..id/output");
      const res1 = await assetHandler(req1 as any, { params: { id: "bad..id", type: "output" } });
      expect(res1.status).toBe(400);

      // Invalid asset type
      const req2 = new Request("http://localhost/api/assets/gen_valid123/unsupported");
      const res2 = await assetHandler(req2 as any, { params: { id: "gen_valid123", type: "unsupported" } });
      expect(res2.status).toBe(400);
    });

    it("rejects unauthenticated requests", async () => {
      const { GET: assetHandler } = await import("../app/api/assets/[id]/[type]/route");
      vi.spyOn(await import("../lib/auth"), "requireAuthenticatedUser").mockRejectedValue(
        new (await import("../lib/auth")).UnauthorizedError("Sign in required"),
      );

      const req = new Request("http://localhost/api/assets/gen_valid123/output");
      const res = await assetHandler(req as any, { params: { id: "gen_valid123", type: "output" } });
      expect(res.status).toBe(401);
    });

    it("returns 410 Gone for expired assets", async () => {
      const { GET: assetHandler } = await import("../app/api/assets/[id]/[type]/route");

      const user = await usersRepo.create({
        id: "user_asset_test",
        auth_provider_user_id: "auth_asset_test",
        email: "asset@example.com",
      });

      vi.spyOn(await import("../lib/auth"), "requireAuthenticatedUser").mockResolvedValue({
        user,
        authProviderUserId: user.auth_provider_user_id,
      } as any);

      const past = new Date(Date.now() - 10000).toISOString();
      const gen = await generationsRepo.create({
        id: "gen_expired_asset",
        userId: user.id,
        inputPath: "input/user_asset_test/gen_expired_asset/source.jpg",
      });
      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output/user_asset_test/gen_expired_asset/result.gif",
        expiresAt: past,
      });

      const req = new Request("http://localhost/api/assets/gen_expired_asset/output");
      const res = await assetHandler(req as any, {
        params: { id: "gen_expired_asset", type: "output" },
      });
      expect(res.status).toBe(410);
    });

    it("redirects 307 to signed URL with no-cache headers for authorized owner", async () => {
      const { GET: assetHandler } = await import("../app/api/assets/[id]/[type]/route");

      const user = await usersRepo.create({
        id: "user_ok_asset",
        auth_provider_user_id: "auth_ok_asset",
        email: "ok@example.com",
      });

      vi.spyOn(await import("../lib/auth"), "requireAuthenticatedUser").mockResolvedValue({
        user,
        authProviderUserId: user.auth_provider_user_id,
      } as any);

      const future = new Date(Date.now() + 100000).toISOString();
      const gen = await generationsRepo.create({
        id: "gen_ok_asset",
        userId: user.id,
        inputPath: "input/user_ok_asset/gen_ok_asset/source.jpg",
      });
      await generationsRepo.transitionStatus(gen.id, "processing");
      await generationsRepo.transitionStatus(gen.id, "succeeded", {
        outputPath: "output/user_ok_asset/gen_ok_asset/result.gif",
        expiresAt: future,
      });

      const req = new Request("http://localhost/api/assets/gen_ok_asset/output");
      const res = await assetHandler(req as any, {
        params: { id: "gen_ok_asset", type: "output" },
      });
      expect(res.status).toBe(307);
      expect(res.headers.get("Location")).toContain("mock_token");
      expect(res.headers.get("Cache-Control")).toContain("private");
      expect(res.headers.get("Cache-Control")).toContain("no-store");
    });
  });
});
