import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureDatabaseInitialized,
  getGenerationsRepository,
  getCreditsRepository,
  getWebhooksRepository,
} from "@/lib/db";
import { logger, metrics } from "@/lib/observability";
import {
  verifyReplicateWebhook,
  validateReplicatePayload,
  validateAndFetchReplicateArtifact,
  WebhookVerificationError,
  WebhookReplayError,
  WebhookPayloadError,
  WebhookSSRFError,
} from "@/lib/security/webhook";
import { validateGenerationId } from "@/lib/validation";
import { getOutputKey } from "@/lib/storage";
import { transitionGeneration, GENERATION_ERROR_CODES } from "@/lib/generation";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params?: { id?: string } },
) {
  const startTime = Date.now();

  // 1. Validate route generation ID
  const routeId = params?.id || req.nextUrl.pathname.split("/")[4];
  let generationId: string;
  try {
    generationId = validateGenerationId(routeId);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid generation ID in route" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Read raw request body exactly as received
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Size limit check
  if (rawBody.length > 1024 * 1024) {
    return new Response(JSON.stringify({ error: "Payload exceeds 1MB limit" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Cryptographic signature and timestamp replay verification
  const webhookId = req.headers.get("webhook-id");
  const webhookTimestamp = req.headers.get("webhook-timestamp");
  const webhookSignature = req.headers.get("webhook-signature");

  try {
    verifyReplicateWebhook({
      id: webhookId,
      timestamp: webhookTimestamp,
      signature: webhookSignature,
      rawBody,
    });
  } catch (err: any) {
    console.warn(`[Replicate Webhook Auth Failure] generationId=${generationId} reason=${err?.message}`);
    if (err instanceof WebhookReplayError) {
      return new Response(JSON.stringify({ error: "Webhook delivery expired or timestamp invalid" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "Unauthorized webhook signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 5. Schema validation of JSON payload
  let payload;
  try {
    payload = validateReplicatePayload(rawBody);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Invalid payload schema" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureDatabaseInitialized();
  const generationsRepo = getGenerationsRepository();
  const creditsRepo = getCreditsRepository();
  const webhooksRepo = getWebhooksRepository();

  // 6. Resource identity validation
  const generation = await generationsRepo.findById(generationId);
  if (!generation) {
    return new Response(JSON.stringify({ error: "Generation not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // If generation already has a Replicate prediction ID bound, verify it matches
  if (
    generation.replicate_prediction_id &&
    generation.replicate_prediction_id !== payload.id
  ) {
    console.error(
      `[Replicate Webhook Mismatch] generationId=${generationId} expectedPredictionId=${generation.replicate_prediction_id} payloadPredictionId=${payload.id}`,
    );
    return new Response(JSON.stringify({ error: "Prediction ID does not match local generation record" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 7. Atomic transport idempotency deduplication
  const externalEventId = webhookId || `${payload.id}_${payload.status}`;
  const { isDuplicate } = await webhooksRepo.recordEvent({
    provider: "replicate",
    externalEventId,
    eventType: `prediction.${payload.status}`,
  });

  if (isDuplicate) {
    metrics.recordWebhook({
      provider: "replicate",
      eventType: `prediction.${payload.status}`,
      status: "duplicate",
      durationMs: Date.now() - startTime,
    });
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 8. State machine protection: prevent regressions from out-of-order webhooks
  const terminalStates = ["succeeded", "failed", "canceled", "expired"];
  if (terminalStates.includes(generation.status)) {
    // Already in a terminal state. Acknowledge harmlessly without regressing state
    await webhooksRepo.markProcessed({
      provider: "replicate",
      externalEventId,
      status: "processed",
    });
    return new Response(JSON.stringify({ received: true, ignored: "Already terminal" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // 9. Process by status
    if (payload.status === "succeeded") {
      const outputUrl = Array.isArray(payload.output)
        ? payload.output[0]
        : payload.output;

      if (!outputUrl || typeof outputUrl !== "string") {
        await webhooksRepo.markProcessed({
          provider: "replicate",
          externalEventId,
          status: "failed",
          errorMessage: "Succeeded status received without output URL",
        });
        return new Response(JSON.stringify({ error: "Missing output URL" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Safe artifact download with strict SSRF & magic byte validation
      const artifact = await validateAndFetchReplicateArtifact(outputUrl);

      // Upload to Supabase storage using deterministic private key
      const supabaseAdmin = createAdminClient();
      const relativeKey = getOutputKey(generation.user_id, generation.id, "gif");
      const canonicalOutputPath = `output/${relativeKey}`;

      const { error: storageError } = await supabaseAdmin.storage
        .from("output")
        .upload(relativeKey, artifact.buffer, {
          contentType: artifact.contentType,
          cacheControl: "3600",
          upsert: true,
        });

      if (storageError) {
        await webhooksRepo.markProcessed({
          provider: "replicate",
          externalEventId,
          status: "failed",
          errorMessage: `Storage upload failed: ${storageError.message}`,
        });
        return new Response(JSON.stringify({ error: "Storage upload failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Transition generation to succeeded with explicit 24h retention deadline
      await transitionGeneration(generation.id, "succeeded", {
        outputPath: canonicalOutputPath,
        replicatePredictionId: payload.id,
      });

      await webhooksRepo.markProcessed({
        provider: "replicate",
        externalEventId,
        status: "processed",
      });
    } else if (payload.status === "failed" || payload.status === "canceled") {
      // Transition generation to failed with 2h retention cleanup for input photo
      await transitionGeneration(generation.id, "failed", {
        errorCode: GENERATION_ERROR_CODES.REPLICATE_FAILED,
        errorMessage: payload.error || `Prediction ${payload.status}`,
        replicatePredictionId: payload.id,
      });

      // Idempotent credit refund via append-only ledger
      await creditsRepo.refundCredits({
        userId: generation.user_id,
        generationId: generation.id,
        amount: 10,
        reason: `Replicate prediction ${payload.status}`,
      });

      await webhooksRepo.markProcessed({
        provider: "replicate",
        externalEventId,
        status: "processed",
      });
    } else if (payload.status === "processing" || payload.status === "starting") {
      if (generation.status === "queued") {
        await transitionGeneration(generation.id, "processing", {
          replicatePredictionId: payload.id,
        });
      }
      await webhooksRepo.markProcessed({
        provider: "replicate",
        externalEventId,
        status: "processed",
      });
    }

    const duration = Date.now() - startTime;
    metrics.recordWebhook({
      provider: "replicate",
      eventType: `prediction.${payload.status}`,
      status: "processed",
      durationMs: duration,
    });

    logger.info("Replicate webhook processed successfully", {
      generationId: generation.id,
      status: payload.status,
      durationMs: duration,
      predictionId: payload.id,
    });

    console.log(
      `[Replicate Webhook Handled] generationId=${generation.id} status=${payload.status} durationMs=${duration}`,
    );

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (processingErr: any) {
    const duration = Date.now() - startTime;
    metrics.recordWebhook({
      provider: "replicate",
      eventType: `prediction.${payload?.status || "unknown"}`,
      status: "failed",
      durationMs: duration,
    });

    logger.error("[Replicate Webhook Processing Error]", processingErr, {
      generationId: generationId,
      externalEventId,
    });
    console.error("[Replicate Webhook Processing Error]", processingErr);

    await webhooksRepo.markProcessed({
      provider: "replicate",
      externalEventId,
      status: "failed",
      errorMessage: processingErr?.message,
    });

    if (processingErr instanceof WebhookSSRFError) {
      return new Response(JSON.stringify({ error: processingErr.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Internal processing error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
