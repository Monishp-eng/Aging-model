import { createAdminClient } from "@/lib/supabase/admin";
import { getGenerationsRepository } from "@/lib/db";
import { parseStoragePath } from "./keys";
import { RETENTION_CONFIG, isGenerationExpired } from "./retention";

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export class StorageNotFoundError extends StorageError {
  constructor(message = "Storage object not found") {
    super(message);
    this.name = "StorageNotFoundError";
  }
}

export class StorageUnauthorizedError extends StorageError {
  constructor(message = "Unauthorized access to storage asset") {
    super(message);
    this.name = "StorageUnauthorizedError";
  }
}

export class AssetExpiredError extends StorageError {
  constructor(message = "This asset has expired according to our retention policy") {
    super(message);
    this.name = "AssetExpiredError";
  }
}

/**
 * Generates a short-lived signed URL for a specific bucket and path.
 */
export async function createSignedAssetUrl(
  bucket: string,
  path: string,
  expiresInSeconds: number = RETENTION_CONFIG.SIGNED_URL_TTL_SECONDS,
): Promise<string> {
  const supabase = createAdminClient();
  const cleanPath = path.replace(/^\/+/, "");

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(cleanPath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new StorageError(`Failed to generate signed URL: ${error?.message || "Unknown error"}`);
  }

  return data.signedUrl;
}

/**
 * Authoritative asset-access service:
 * 1. Enforces user ownership via SQLite generation record (IDOR protection)
 * 2. Enforces explicit retention expiry state
 * 3. Returns a short-lived signed URL without exposing permanent credentials or storage bucket keys
 */
export async function getAuthorizedGenerationAsset(
  userId: string,
  generationId: string,
  assetType: "input" | "output",
): Promise<{ signedUrl: string; bucket: string; path: string }> {
  if (!userId || !generationId) {
    throw new StorageUnauthorizedError("User ID and Generation ID are required");
  }

  const generationsRepo = getGenerationsRepository();
  const generation = await generationsRepo.getGenerationForUser(generationId, userId);

  if (!generation) {
    throw new StorageUnauthorizedError("Generation not found or access denied");
  }

  // Enforce retention policy
  if (isGenerationExpired(generation)) {
    throw new AssetExpiredError(
      "This generation's assets have expired and were removed according to the 24-hour privacy retention policy.",
    );
  }

  let storageRef: string;
  if (assetType === "input") {
    storageRef = generation.input_path;
  } else if (assetType === "output") {
    if (!generation.output_path) {
      throw new StorageNotFoundError("Output asset is not yet available for this generation");
    }
    storageRef = generation.output_path;
  } else {
    throw new StorageError(`Unsupported asset type: ${assetType}`);
  }

  const { bucket, path } = parseStoragePath(storageRef);
  const signedUrl = await createSignedAssetUrl(bucket, path, RETENTION_CONFIG.SIGNED_URL_TTL_SECONDS);

  return { signedUrl, bucket, path };
}

/**
 * Recursively lists all exact file paths under a user's prefix in a bucket.
 * Supabase Storage `.list()` returns files and folders in the current directory.
 * We recurse into any folders to retrieve exact file keys.
 */
export async function listAllUserFiles(bucket: string, userId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const files: string[] = [];

  async function recurse(prefix: string) {
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: 100,
      offset: 0,
      sortBy: { column: "name", order: "asc" },
    });

    if (error || !data) {
      console.warn(`[Storage list error] bucket=${bucket} prefix=${prefix}:`, error?.message);
      return;
    }

    for (const item of data) {
      const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id === null) {
        // Supabase folders have id === null
        await recurse(itemPath);
      } else {
        files.push(itemPath);
      }
    }
  }

  await recurse(userId);
  return files;
}

/**
 * Durably deletes all storage assets belonging to a specific user across input, output, and temp buckets.
 * Operates on exact file keys rather than directory prefixes to ensure Supabase Storage removes them.
 */
export async function deleteUserStorageAssets(
  userId: string,
): Promise<{ deletedCount: number; errors: string[] }> {
  const supabase = createAdminClient();
  const buckets = ["input", "output", "temp"] as const;
  let deletedCount = 0;
  const errors: string[] = [];

  for (const bucket of buckets) {
    try {
      const filePaths = await listAllUserFiles(bucket, userId);
      if (filePaths.length > 0) {
        // Bounded batches of 100 items for deletion
        for (let i = 0; i < filePaths.length; i += 100) {
          const batch = filePaths.slice(i, i + 100);
          const { error } = await supabase.storage.from(bucket).remove(batch);
          if (error) {
            errors.push(`Bucket ${bucket}: ${error.message}`);
          } else {
            deletedCount += batch.length;
          }
        }
      }
    } catch (err: any) {
      errors.push(`Bucket ${bucket} listing/removal exception: ${err?.message || String(err)}`);
    }
  }

  return { deletedCount, errors };
}

/**
 * Deletes the input and output storage assets associated with a specific generation record.
 * Idempotent: safe to run if assets are already deleted.
 */
export async function deleteGenerationAssets(
  generation: { input_path: string; output_path?: string | null },
): Promise<{ success: boolean; error?: string }> {
  const supabase = createAdminClient();
  const errors: string[] = [];

  // 1. Delete input asset
  try {
    const { bucket, path } = parseStoragePath(generation.input_path);
    const { error } = await supabase.storage.from(bucket).remove([path]);
    if (error && !error.message?.includes("not found")) {
      errors.push(`Input removal failed: ${error.message}`);
    }
  } catch (err: any) {
    errors.push(`Input parsing/removal error: ${err?.message}`);
  }

  // 2. Delete output asset if present
  if (generation.output_path) {
    try {
      const { bucket, path } = parseStoragePath(generation.output_path);
      const { error } = await supabase.storage.from(bucket).remove([path]);
      if (error && !error.message?.includes("not found")) {
        errors.push(`Output removal failed: ${error.message}`);
      }
    } catch (err: any) {
      errors.push(`Output parsing/removal error: ${err?.message}`);
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join("; ") };
  }

  return { success: true };
}

/**
 * Deletes expired temporary objects in the temp bucket older than the specified retention hours.
 */
export async function cleanExpiredTemporaryAssets(
  olderThanHours: number = RETENTION_CONFIG.TEMP_ASSET_TTL_HOURS,
): Promise<{ cleanedCount: number; errors: string[] }> {
  const supabase = createAdminClient();
  let cleanedCount = 0;
  const errors: string[] = [];
  const cutoffTime = Date.now() - olderThanHours * 60 * 60 * 1000;

  try {
    const { data: rootItems, error } = await supabase.storage.from("temp").list("", {
      limit: 100,
    });

    if (error || !rootItems) {
      return { cleanedCount: 0, errors: [error?.message || "Failed to list temp root"] };
    }

    const filesToDelete: string[] = [];

    for (const item of rootItems) {
      if (item.id === null) {
        // Subfolder: list files inside
        const { data: subItems } = await supabase.storage.from("temp").list(item.name, {
          limit: 100,
        });
        if (subItems) {
          for (const sub of subItems) {
            const createdAt = new Date(sub.created_at || item.created_at || 0).getTime();
            if (createdAt < cutoffTime) {
              filesToDelete.push(`${item.name}/${sub.name}`);
            }
          }
        }
      } else {
        const createdAt = new Date(item.created_at || 0).getTime();
        if (createdAt < cutoffTime) {
          filesToDelete.push(item.name);
        }
      }
    }

    if (filesToDelete.length > 0) {
      for (let i = 0; i < filesToDelete.length; i += 100) {
        const batch = filesToDelete.slice(i, i + 100);
        const { error: removeError } = await supabase.storage.from("temp").remove(batch);
        if (removeError) {
          errors.push(`Temp removal error: ${removeError.message}`);
        } else {
          cleanedCount += batch.length;
        }
      }
    }
  } catch (err: any) {
    errors.push(`Temp cleanup exception: ${err?.message}`);
  }

  return { cleanedCount, errors };
}
