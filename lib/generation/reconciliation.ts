import Replicate from "replicate";
import {
  getGenerationsRepository,
  getCreditsRepository,
  NotFoundError,
} from "../db";
import {
  transitionGeneration,
  isTerminalState,
  GENERATION_ERROR_CODES,
} from "./lifecycle";
import { logGenerationEvent } from "./observability";
import { validateAndFetchReplicateArtifact } from "../security/webhook";
import { createAdminClient } from "../supabase/admin";
import { getOutputKey } from "../storage";

export interface ReconciliationResult {
  generationId: string;
  previousStatus: string;
  finalStatus: string;
  action:
    | "no_op_terminal"
    | "repaired_success"
    | "repaired_failed"
    | "timeout_failed"
    | "orphaned_failed"
    | "still_processing"
    | "replicate_fetch_error";
  reconciled: boolean;
  refunded: boolean;
  error?: string;
}

export interface BatchReconciliationResult {
  totalFound: number;
  processed: number;
  reconciled: number;
  refunded: number;
  durationMs: number;
  results: ReconciliationResult[];
}

export const RECONCILIATION_CONFIG = {
  STALE_THRESHOLD_MINUTES: 10,
  ORPHAN_QUEUED_THRESHOLD_MINUTES: 2,
  DEFAULT_BATCH_SIZE: 20,
} as const;

/**
 * Authoritative single generation reconciliation service.
 * Inspects external inference provider state (Replicate), synchronizes local SQLite
 * state, recovers missing output artifacts to private storage, and performs idempotent
 * credit refunds if external jobs failed or hung past the timeout threshold.
 */
export async function reconcileGeneration(
  generationId: string,
): Promise<ReconciliationResult> {
  const generationsRepo = getGenerationsRepository();
  const creditsRepo = getCreditsRepository();

  const generation = await generationsRepo.findById(generationId);
  if (!generation) {
    throw new NotFoundError(`Generation '${generationId}' not found`);
  }

  const previousStatus = generation.status;

  // 1. Invariant: Terminal states require no reconciliation (idempotent no-op)
  if (isTerminalState(generation.status)) {
    return {
      generationId,
      previousStatus,
      finalStatus: generation.status,
      action: "no_op_terminal",
      reconciled: false,
      refunded: false,
    };
  }

  // 2. Generation with active external Replicate prediction ID
  if (generation.replicate_prediction_id) {
    const replicate = new Replicate({
      auth: process.env.REPLICATE_API_TOKEN || "",
    });

    let prediction: any;
    try {
      prediction = await replicate.predictions.get(
        generation.replicate_prediction_id,
      );
    } catch (fetchErr: any) {
      logGenerationEvent("generation.reconciled", {
        generationId,
        predictionId: generation.replicate_prediction_id,
        errorMessage: `Failed to query Replicate API: ${fetchErr?.message}`,
      });
      return {
        generationId,
        previousStatus,
        finalStatus: generation.status,
        action: "replicate_fetch_error",
        reconciled: false,
        refunded: false,
        error: fetchErr?.message,
      };
    }

    // A. Replicate completed successfully
    if (prediction.status === "succeeded") {
      let canonicalOutputPath = generation.output_path;

      // If output artifact was never downloaded/saved locally, recover it now
      if (!canonicalOutputPath) {
        const outputUrl = Array.isArray(prediction.output)
          ? prediction.output[0]
          : prediction.output;

        if (outputUrl && typeof outputUrl === "string") {
          try {
            // SSRF-safe download and validation
            const artifact = await validateAndFetchReplicateArtifact(outputUrl);

            // Deterministic private storage key
            const supabaseAdmin = createAdminClient();
            const relativeKey = getOutputKey(
              generation.user_id,
              generation.id,
              "gif",
            );
            canonicalOutputPath = `output/${relativeKey}`;

            const { error: storageError } = await supabaseAdmin.storage
              .from("output")
              .upload(relativeKey, artifact.buffer, {
                contentType: artifact.contentType,
                cacheControl: "3600",
                upsert: true,
              });

            if (!storageError) {
              logGenerationEvent("generation.output_recovered", {
                generationId,
                userId: generation.user_id,
                predictionId: prediction.id,
                metadata: { key: relativeKey },
              });
            }
          } catch (artifactErr) {
            console.error(
              `[Reconciliation] Failed to recover output artifact for ${generationId}:`,
              artifactErr,
            );
          }
        }
      }

      // Transition to terminal succeeded state
      const updated = await transitionGeneration(generation.id, "succeeded", {
        outputPath: canonicalOutputPath,
        replicatePredictionId: prediction.id,
        lastReconciledAt: new Date().toISOString(),
      });

      logGenerationEvent("generation.reconciled", {
        generationId,
        userId: generation.user_id,
        predictionId: prediction.id,
        status: "succeeded",
        previousStatus,
        reconciled: true,
      });

      return {
        generationId,
        previousStatus,
        finalStatus: updated.status,
        action: "repaired_success",
        reconciled: true,
        refunded: false,
      };
    }

    // B. Replicate explicitly failed or was canceled
    if (prediction.status === "failed" || prediction.status === "canceled") {
      const updated = await transitionGeneration(generation.id, "failed", {
        errorCode: GENERATION_ERROR_CODES.REPLICATE_FAILED,
        errorMessage:
          prediction.error || `Prediction was ${prediction.status} externally`,
        replicatePredictionId: prediction.id,
        lastReconciledAt: new Date().toISOString(),
      });

      // Atomic, idempotent credit refund via ledger
      await creditsRepo.refundCredits({
        userId: generation.user_id,
        generationId: generation.id,
        amount: 10,
        reason: `Reconciliation refund: Prediction was ${prediction.status}`,
      });

      logGenerationEvent("generation.reconciled", {
        generationId,
        userId: generation.user_id,
        predictionId: prediction.id,
        status: "failed",
        previousStatus,
        reconciled: true,
        refunded: true,
      });

      return {
        generationId,
        previousStatus,
        finalStatus: updated.status,
        action: "repaired_failed",
        reconciled: true,
        refunded: true,
      };
    }

    // C. Replicate still in starting / processing status
    const startTimeStr =
      generation.processing_started_at ||
      generation.started_at ||
      generation.created_at;
    const ageMs = Date.now() - new Date(startTimeStr).getTime();
    const timeoutMs =
      RECONCILIATION_CONFIG.STALE_THRESHOLD_MINUTES * 60 * 1000;

    if (ageMs > timeoutMs) {
      // Prediction is hung on Replicate past timeout limit
      try {
        await replicate.predictions.cancel(prediction.id);
      } catch (cancelErr) {
        console.warn(`[Reconciliation] Replicate cancel failed:`, cancelErr);
      }

      const updated = await transitionGeneration(generation.id, "failed", {
        errorCode: GENERATION_ERROR_CODES.REPLICATE_TIMEOUT,
        errorMessage: `Generation exceeded maximum runtime limit of ${RECONCILIATION_CONFIG.STALE_THRESHOLD_MINUTES} minutes`,
        replicatePredictionId: prediction.id,
        lastReconciledAt: new Date().toISOString(),
      });

      // Idempotently refund credits
      await creditsRepo.refundCredits({
        userId: generation.user_id,
        generationId: generation.id,
        amount: 10,
        reason: "Reconciliation refund: Provider inference timed out",
      });

      logGenerationEvent("generation.reconciled", {
        generationId,
        userId: generation.user_id,
        predictionId: prediction.id,
        status: "failed",
        previousStatus,
        errorCode: GENERATION_ERROR_CODES.REPLICATE_TIMEOUT,
        reconciled: true,
        refunded: true,
      });

      return {
        generationId,
        previousStatus,
        finalStatus: updated.status,
        action: "timeout_failed",
        reconciled: true,
        refunded: true,
      };
    }

    // Still processing normally within acceptable timeout bounds
    await generationsRepo.touchReconciled(generation.id);
    return {
      generationId,
      previousStatus,
      finalStatus: generation.status,
      action: "still_processing",
      reconciled: false,
      refunded: false,
    };
  }

  // 3. Generation without Replicate prediction ID (e.g. server crashed after DB insert)
  const orphanAgeMs = Date.now() - new Date(generation.created_at).getTime();
  const orphanThresholdMs =
    RECONCILIATION_CONFIG.ORPHAN_QUEUED_THRESHOLD_MINUTES * 60 * 1000;

  if (orphanAgeMs > orphanThresholdMs) {
    // Orphaned queued job: prediction was never successfully dispatched
    const updated = await transitionGeneration(generation.id, "failed", {
      errorCode: GENERATION_ERROR_CODES.PREDICTION_NEVER_STARTED,
      errorMessage: "Generation was orphaned before external inference started",
      lastReconciledAt: new Date().toISOString(),
    });

    await creditsRepo.refundCredits({
      userId: generation.user_id,
      generationId: generation.id,
      amount: 10,
      reason: "Reconciliation refund: Orphaned job never dispatched",
    });

    logGenerationEvent("generation.reconciled", {
      generationId,
      userId: generation.user_id,
      status: "failed",
      previousStatus,
      errorCode: GENERATION_ERROR_CODES.PREDICTION_NEVER_STARTED,
      reconciled: true,
      refunded: true,
    });

    return {
      generationId,
      previousStatus,
      finalStatus: updated.status,
      action: "orphaned_failed",
      reconciled: true,
      refunded: true,
    };
  }

  // Fresh queued job, likely in-flight right now
  return {
    generationId,
    previousStatus,
    finalStatus: generation.status,
    action: "still_processing",
    reconciled: false,
    refunded: false,
  };
}

/**
 * Batch reconciliation of stale generations.
 * Suitable for scheduled background cron execution or administrative repair.
 */
export async function reconcileStaleGenerations(options?: {
  batchSize?: number;
  staleThresholdMinutes?: number;
}): Promise<BatchReconciliationResult> {
  const startTime = Date.now();
  const generationsRepo = getGenerationsRepository();

  const batchSize =
    options?.batchSize ?? RECONCILIATION_CONFIG.DEFAULT_BATCH_SIZE;
  const staleMinutes =
    options?.staleThresholdMinutes ??
    RECONCILIATION_CONFIG.STALE_THRESHOLD_MINUTES;

  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000).toISOString();
  const staleGenerations = await generationsRepo.findStaleGenerations(
    cutoff,
    batchSize,
  );

  const results: ReconciliationResult[] = [];
  let reconciledCount = 0;
  let refundedCount = 0;

  for (const gen of staleGenerations) {
    try {
      const res = await reconcileGeneration(gen.id);
      results.push(res);
      if (res.reconciled) reconciledCount++;
      if (res.refunded) refundedCount++;
    } catch (err: any) {
      console.error(
        `[Reconciliation Error] Failed reconciling generation ${gen.id}:`,
        err,
      );
      results.push({
        generationId: gen.id,
        previousStatus: gen.status,
        finalStatus: gen.status,
        action: "replicate_fetch_error",
        reconciled: false,
        refunded: false,
        error: err?.message || String(err),
      });
    }
  }

  return {
    totalFound: staleGenerations.length,
    processed: results.length,
    reconciled: reconciledCount,
    refunded: refundedCount,
    durationMs: Date.now() - startTime,
    results,
  };
}
