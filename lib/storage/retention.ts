/**
 * Centralized retention and lifecycle policy configuration.
 * Consumed by upload pipelines, webhooks, asset authorization, and cleanup jobs.
 */

export const RETENTION_CONFIG = {
  /**
   * Maximum retention for succeeded generation images (input photo and output GIF).
   * Promised to users as 24 hours.
   */
  GENERATION_ASSET_TTL_HOURS: 24,

  /**
   * Retention for failed or canceled generation assets before cleanup.
   */
  FAILED_GENERATION_TTL_HOURS: 2,

  /**
   * Maximum retention for temporary artifacts in the temp bucket.
   */
  TEMP_ASSET_TTL_HOURS: 6,

  /**
   * Short-lived signed URL TTL for browser client asset access (15 minutes).
   */
  SIGNED_URL_TTL_SECONDS: 15 * 60,

  /**
   * Short-lived signed URL TTL passed to Replicate's prediction ingress (1 hour).
   */
  REPLICATE_SIGNED_URL_TTL_SECONDS: 60 * 60,

  /**
   * Maximum batch size processed per scheduled cleanup cron run.
   */
  BATCH_SIZE: 50,

  /**
   * Maximum retry attempts for deleting failed storage objects.
   */
  MAX_DELETE_RETRIES: 3,
} as const;

/**
 * Calculates the ISO timestamp when a generation's assets become eligible for cleanup.
 * @param status - The current terminal or intermediate status
 * @param baseTime - Reference timestamp (defaults to current time)
 */
export function calculateGenerationExpiresAt(
  status: "succeeded" | "failed" | "canceled" | "expired" | "queued" | "processing",
  baseTime: Date = new Date(),
): string | null {
  const baseMs = baseTime.getTime();

  switch (status) {
    case "succeeded":
      return new Date(
        baseMs + RETENTION_CONFIG.GENERATION_ASSET_TTL_HOURS * 60 * 60 * 1000,
      ).toISOString();

    case "failed":
    case "canceled":
      return new Date(
        baseMs + RETENTION_CONFIG.FAILED_GENERATION_TTL_HOURS * 60 * 60 * 1000,
      ).toISOString();

    case "expired":
      return new Date(baseMs).toISOString();

    case "queued":
    case "processing":
      // Active generations must never have an expiration cutoff set that triggers cleanup
      return null;

    default:
      return null;
  }
}

/**
 * Checks whether a generation's assets are expired based on its explicit retention metadata.
 */
export function isGenerationExpired(
  generation: {
    expires_at?: string | null;
    cleaned_up_at?: string | null;
    status: string;
  },
  now: Date = new Date(),
): boolean {
  if (generation.cleaned_up_at) {
    return true;
  }
  if (generation.status === "expired") {
    return true;
  }
  if (generation.expires_at) {
    const expiresAtTime = new Date(generation.expires_at).getTime();
    if (!isNaN(expiresAtTime) && expiresAtTime <= now.getTime()) {
      return true;
    }
  }
  return false;
}
