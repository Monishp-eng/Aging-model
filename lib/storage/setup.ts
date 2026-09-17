import { SupabaseClient } from "@supabase/supabase-js";

export interface BucketDefinition {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number; // in bytes
  allowedMimeTypes: string[];
}

export const REQUIRED_BUCKETS: BucketDefinition[] = [
  {
    id: "input",
    name: "input",
    public: false,
    fileSizeLimit: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  {
    id: "output",
    name: "output",
    public: false,
    fileSizeLimit: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: ["image/gif", "image/webp", "image/jpeg", "image/png"],
  },
  {
    id: "temp",
    name: "temp",
    public: false,
    fileSizeLimit: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  },
];

/**
 * Ensures all required Supabase storage buckets are configured with private access
 * and file size / MIME restrictions.
 */
export async function ensureStorageBucketsExist(
  supabaseAdmin: SupabaseClient,
): Promise<{ created: string[]; existing: string[]; errors: string[] }> {
  const created: string[] = [];
  const existing: string[] = [];
  const errors: string[] = [];

  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) {
    errors.push(`Failed to list storage buckets: ${listError.message}`);
    return { created, existing, errors };
  }

  const existingBucketIds = new Set(buckets.map((b) => b.id));

  for (const def of REQUIRED_BUCKETS) {
    if (existingBucketIds.has(def.id)) {
      existing.push(def.id);
      // Update bucket to ensure it is private and has limits
      const { error: updateError } = await supabaseAdmin.storage.updateBucket(def.id, {
        public: def.public,
        fileSizeLimit: def.fileSizeLimit,
        allowedMimeTypes: def.allowedMimeTypes,
      });
      if (updateError) {
        errors.push(`Failed to update bucket '${def.id}': ${updateError.message}`);
      }
    } else {
      const { error: createError } = await supabaseAdmin.storage.createBucket(def.id, {
        public: def.public,
        fileSizeLimit: def.fileSizeLimit,
        allowedMimeTypes: def.allowedMimeTypes,
      });
      if (createError) {
        errors.push(`Failed to create bucket '${def.id}': ${createError.message}`);
      } else {
        created.push(def.id);
      }
    }
  }

  return { created, existing, errors };
}
