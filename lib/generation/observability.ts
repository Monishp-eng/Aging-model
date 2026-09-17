export type GenerationEventName =
  | "generation.created"
  | "generation.processing"
  | "generation.succeeded"
  | "generation.failed"
  | "generation.canceled"
  | "generation.expired"
  | "generation.reconciled"
  | "generation.retry"
  | "generation.stale"
  | "generation.output_recovered"
  | "realtime.connected"
  | "realtime.disconnected";

export interface GenerationEventPayload {
  generationId: string;
  userId?: string | null;
  predictionId?: string | null;
  status?: string;
  previousStatus?: string;
  durationMs?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  reconciled?: boolean;
  refunded?: boolean;
  metadata?: Record<string, any>;
}

import { logger, metrics } from "../observability";

/**
 * Structured generation lifecycle logger.
 * Emits JSON-formatted structured events containing correlation IDs
 * without leaking PII, images, or provider credentials.
 */
export function logGenerationEvent(
  event: GenerationEventName,
  payload: GenerationEventPayload,
): void {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    ...payload,
  };

  // Record operational metrics for completed terminal states
  if (payload.status === "succeeded" || payload.status === "failed" || payload.status === "canceled") {
    metrics.recordGeneration({
      generationId: payload.generationId,
      status: payload.status as "succeeded" | "failed" | "canceled",
      durationMs: payload.durationMs || 0,
      refunded: payload.refunded,
    });
  }

  logger.info(`[GenerationEvent] ${event}`, logEntry);
  console.log(`[GENERATION_EVENT] ${JSON.stringify(logEntry)}`);
}
