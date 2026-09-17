import {
  Generation,
  GenerationStatus,
  InvalidStateTransitionError,
  NotFoundError,
} from "../db/types";
import { getGenerationsRepository } from "../db";
import { calculateGenerationExpiresAt } from "../storage";
import { createAdminClient } from "../supabase/admin";
import { logGenerationEvent, GenerationEventName } from "./observability";

export const GENERATION_ERROR_CODES = {
  REPLICATE_CREATE_FAILED: "REPLICATE_CREATE_FAILED",
  REPLICATE_TIMEOUT: "REPLICATE_TIMEOUT",
  REPLICATE_FAILED: "REPLICATE_FAILED",
  STORAGE_UPLOAD_FAILED: "STORAGE_UPLOAD_FAILED",
  STORAGE_SIGN_FAILED: "STORAGE_SIGN_FAILED",
  OUTPUT_DOWNLOAD_FAILED: "OUTPUT_DOWNLOAD_FAILED",
  OUTPUT_STORAGE_FAILED: "OUTPUT_STORAGE_FAILED",
  PREDICTION_NEVER_STARTED: "PREDICTION_NEVER_STARTED",
  STALE_TIMEOUT: "STALE_TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
} as const;

export type GenerationErrorCode =
  (typeof GENERATION_ERROR_CODES)[keyof typeof GENERATION_ERROR_CODES];

export interface TransitionOptions {
  outputPath?: string | null;
  replicatePredictionId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  expiresAt?: string | null;
  cleanedUpAt?: string | null;
  processingStartedAt?: string | null;
  lastReconciledAt?: string | null;
  attemptCount?: number;
  metadata?: Record<string, any>;
}

const TERMINAL_STATES: readonly GenerationStatus[] = [
  "succeeded",
  "failed",
  "canceled",
  "expired",
];

export function isTerminalState(status: GenerationStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

/**
 * Classify errors from external inference providers (e.g. Replicate).
 * Separates transient failures (eligible for bounded retry) from permanent failures.
 */
export function classifyReplicateError(err: any): {
  isTransient: boolean;
  code: string;
  message: string;
} {
  const status = Number(err?.status || err?.response?.status || 0);
  const rawMessage = String(err?.message || err?.error || "Unknown external error");

  // Rate limiting (429) -> Transient with backoff
  if (status === 429 || rawMessage.toLowerCase().includes("rate limit")) {
    return {
      isTransient: true,
      code: GENERATION_ERROR_CODES.RATE_LIMITED,
      message: "External provider rate limited",
    };
  }

  // 5xx Server Errors -> Transient
  if (status >= 500 && status <= 599) {
    return {
      isTransient: true,
      code: GENERATION_ERROR_CODES.REPLICATE_CREATE_FAILED,
      message: `External provider returned status ${status}`,
    };
  }

  // Network timeouts / connection drops -> Transient
  const isNetworkTransient =
    err?.code === "ETIMEDOUT" ||
    err?.code === "ECONNRESET" ||
    err?.code === "ECONNREFUSED" ||
    rawMessage.includes("fetch failed") ||
    rawMessage.includes("network timeout") ||
    rawMessage.includes("socket hang up");

  if (isNetworkTransient) {
    return {
      isTransient: true,
      code: GENERATION_ERROR_CODES.REPLICATE_TIMEOUT,
      message: "Network error communicating with external provider",
    };
  }

  // 4xx Client Errors (except 429) -> Permanent (invalid model, bad input, bad token)
  return {
    isTransient: false,
    code: GENERATION_ERROR_CODES.REPLICATE_FAILED,
    message: rawMessage,
  };
}

/**
 * Execute an async operation with bounded exponential backoff and jitter.
 * Non-transient errors terminate the retry sequence immediately.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    generationId?: string;
  },
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 2;
  const initialDelay = options?.initialDelayMs ?? 500;
  const maxDelay = options?.maxDelayMs ?? 4000;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: any) {
      lastError = err;
      const classification = classifyReplicateError(err);

      if (!classification.isTransient || attempt >= maxAttempts) {
        throw err;
      }

      const delay = Math.min(
        initialDelay * Math.pow(2, attempt - 1) + Math.random() * 200,
        maxDelay,
      );

      if (options?.generationId) {
        logGenerationEvent("generation.retry", {
          generationId: options.generationId,
          durationMs: delay,
          errorCode: classification.code,
          errorMessage: classification.message,
          metadata: { attempt, maxAttempts },
        });
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Best-effort Realtime broadcast accelerator.
 * Does NOT throw errors if Realtime is disconnected or unavailable.
 */
export async function broadcastGenerationStatus(
  generationId: string,
  status: GenerationStatus,
): Promise<void> {
  try {
    const supabaseAdmin = createAdminClient();
    await supabaseAdmin
      .channel(`generation:${generationId}`)
      .send({
        type: "broadcast",
        event: "status",
        payload: {
          id: generationId,
          status,
          updated_at: new Date().toISOString(),
        },
      });
  } catch (err) {
    // Non-blocking: Realtime is an acceleration layer, SQLite is the authority
    console.warn(`[Realtime Broadcast Failed] id=${generationId}:`, err);
  }
}

/**
 * Authoritative generation state transition domain function.
 *
 * Invariants enforced:
 * 1. Current generation existence verified.
 * 2. Terminal state protection: terminal states (succeeded, failed, canceled, expired)
 *    cannot regress to queued or processing.
 * 3. Idempotent: transitioning to the same terminal state returns existing record safely.
 * 4. Automatic timestamp management (started_at, completed_at, failed_at).
 * 5. Automatic retention calculation (expires_at) for terminal states.
 * 6. Structured audit event logging.
 * 7. Realtime broadcast notification.
 */
export async function transitionGeneration(
  generationId: string,
  targetStatus: GenerationStatus,
  options?: TransitionOptions,
): Promise<Generation> {
  const repo = getGenerationsRepository();
  const existing = await repo.findById(generationId);

  if (!existing) {
    throw new NotFoundError(`Generation '${generationId}' not found`);
  }

  // Idempotent no-op for identical status
  if (existing.status === targetStatus) {
    return existing;
  }

  // Terminal state protection: Cannot regress from terminal state
  if (isTerminalState(existing.status)) {
    // Exception: terminal states may only transition to expired via cleanup cron
    if (targetStatus === "expired") {
      const updated = await repo.transitionStatus(generationId, targetStatus, options);
      logGenerationEvent("generation.expired", {
        generationId,
        userId: existing.user_id,
        predictionId: existing.replicate_prediction_id,
        status: targetStatus,
        previousStatus: existing.status,
      });
      return updated;
    }

    // Any other transition attempt from a terminal state is an illegal regression!
    throw new InvalidStateTransitionError(existing.status, targetStatus);
  }

  // Automatically compute retention expiration if not explicitly provided
  let expiresAt = options?.expiresAt;
  if (!expiresAt && ["succeeded", "failed", "canceled"].includes(targetStatus)) {
    expiresAt = calculateGenerationExpiresAt(
      targetStatus === "succeeded" ? "succeeded" : "failed",
    );
  }

  // Persist state transition to SQLite
  const updated = await repo.transitionStatus(generationId, targetStatus, {
    ...options,
    expiresAt: expiresAt ?? options?.expiresAt,
  });

  // Map to structured event name
  const eventMap: Record<GenerationStatus, GenerationEventName> = {
    queued: "generation.created",
    processing: "generation.processing",
    succeeded: "generation.succeeded",
    failed: "generation.failed",
    canceled: "generation.canceled",
    expired: "generation.expired",
  };

  logGenerationEvent(eventMap[targetStatus], {
    generationId,
    userId: updated.user_id,
    predictionId: updated.replicate_prediction_id,
    status: targetStatus,
    previousStatus: existing.status,
    errorCode: options?.errorCode ?? updated.error_code,
    errorMessage: options?.errorMessage ?? updated.error_message,
    metadata: options?.metadata,
  });

  // Non-blocking acceleration broadcast
  broadcastGenerationStatus(generationId, targetStatus).catch(() => {});

  return updated;
}
