import crypto from "crypto";
import {
  WebhookVerificationError,
  WebhookReplayError,
  WebhookPayloadError,
  ReplicatePredictionPayload,
} from "./types";

export interface VerifyReplicateWebhookParams {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  secret?: string | string[];
  toleranceSeconds?: number;
  currentTimestamp?: number;
}

/**
 * Verifies Replicate webhook delivery signatures according to the Svix / Replicate specification:
 * - Content signed: `${webhookId}.${webhookTimestamp}.${rawBody}`
 * - Hash: HMAC-SHA256
 * - Secrets: May start with `whsec_` (base64-encoded secret key)
 * - Signatures: Space-delimited versioned signatures (e.g. `v1,sig1 v1,sig2`)
 * - Constant-time comparison
 * - Replay tolerance window
 * - Secret rotation support (multiple secrets)
 */
export function verifyReplicateWebhook(params: VerifyReplicateWebhookParams): boolean {
  const {
    id,
    timestamp,
    signature,
    rawBody,
    secret = process.env.REPLICATE_WEBHOOK_SECRET,
    toleranceSeconds = 300,
    currentTimestamp = Math.floor(Date.now() / 1000),
  } = params;

  // 1. Validate required headers
  if (!id || typeof id !== "string" || !id.trim()) {
    throw new WebhookVerificationError("Missing or invalid webhook-id header");
  }
  if (!timestamp || typeof timestamp !== "string" || !timestamp.trim()) {
    throw new WebhookVerificationError("Missing or invalid webhook-timestamp header");
  }
  if (!signature || typeof signature !== "string" || !signature.trim()) {
    throw new WebhookVerificationError("Missing or invalid webhook-signature header");
  }

  // 2. Validate raw body presence
  if (typeof rawBody !== "string") {
    throw new WebhookVerificationError("Raw request body must be a string");
  }

  // 3. Resolve secret(s)
  const secretsList: string[] = [];
  if (Array.isArray(secret)) {
    secretsList.push(...secret);
  } else if (typeof secret === "string" && secret.trim()) {
    // Support comma-separated secret list for rotation
    secretsList.push(...secret.split(",").map((s) => s.trim()).filter(Boolean));
  }

  if (secretsList.length === 0) {
    throw new WebhookVerificationError(
      "Replicate webhook secret is not configured on the server",
    );
  }

  // 4. Replay window validation (must be plausible Unix timestamp in seconds)
  const webhookTs = parseInt(timestamp, 10);
  if (isNaN(webhookTs) || webhookTs <= 0) {
    throw new WebhookReplayError("Malformed webhook-timestamp header");
  }

  const age = Math.abs(currentTimestamp - webhookTs);
  if (age > toleranceSeconds) {
    throw new WebhookReplayError(
      `Webhook timestamp outside tolerance window (${age}s > ${toleranceSeconds}s)`,
    );
  }

  // 5. Parse signature tokens
  // Replicate format: "v1,sig1 v1,sig2 v2,sig3"
  const tokens = signature.split(/\s+/).filter(Boolean);
  const v1Signatures: string[] = [];

  for (const token of tokens) {
    const parts = token.split(",");
    if (parts.length === 2 && parts[0] === "v1" && parts[1]) {
      v1Signatures.push(parts[1]);
    }
  }

  if (v1Signatures.length === 0) {
    throw new WebhookVerificationError(
      "No supported v1 signatures found in webhook-signature header",
    );
  }

  // 6. Signed content is: `${id}.${timestamp}.${rawBody}`
  const signedContent = `${id}.${timestamp}.${rawBody}`;

  // 7. Verify against any candidate secret in constant time
  for (const candidateSecret of secretsList) {
    try {
      // Decode secret material (strip whsec_ prefix if present, then base64 decode)
      const rawSecret = candidateSecret.startsWith("whsec_")
        ? candidateSecret.slice(6)
        : candidateSecret;

      const secretBytes = Buffer.from(rawSecret, "base64");
      if (secretBytes.length === 0) continue;

      const computedSignature = crypto
        .createHmac("sha256", secretBytes)
        .update(signedContent, "utf8")
        .digest("base64");

      const computedBuf = Buffer.from(computedSignature, "base64");

      for (const expectedSig of v1Signatures) {
        const expectedBuf = Buffer.from(expectedSig, "base64");
        if (
          computedBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(computedBuf, expectedBuf)
        ) {
          return true;
        }
      }
    } catch {
      // Continue trying next secret in rotation
    }
  }

  throw new WebhookVerificationError("Webhook signature verification failed");
}

/**
 * Validates and parses Replicate prediction webhook JSON payload.
 * Enforces field schemas, bounds payload size, and rejects malformed types.
 */
export function validateReplicatePayload(
  rawBody: string,
  maxSizeBytes = 1024 * 1024,
): ReplicatePredictionPayload {
  if (rawBody.length > maxSizeBytes) {
    throw new WebhookPayloadError("Webhook payload exceeds maximum size limit");
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("Webhook payload is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new WebhookPayloadError("Webhook payload must be a JSON object");
  }

  if (!parsed.id || typeof parsed.id !== "string" || !parsed.id.trim()) {
    throw new WebhookPayloadError("Missing or invalid prediction ID in payload");
  }

  const validStatuses = ["starting", "processing", "succeeded", "failed", "canceled", "cancelled"];
  if (!parsed.status || !validStatuses.includes(parsed.status)) {
    throw new WebhookPayloadError(`Invalid prediction status in payload: ${parsed.status}`);
  }

  const normalizedStatus = parsed.status === "cancelled" ? "canceled" : parsed.status;

  return {
    id: parsed.id.trim(),
    status: normalizedStatus as ReplicatePredictionPayload["status"],
    output: parsed.output ?? null,
    error: parsed.error ? String(parsed.error) : null,
    created_at: parsed.created_at ? String(parsed.created_at) : undefined,
    started_at: parsed.started_at ? String(parsed.started_at) : null,
    completed_at: parsed.completed_at ? String(parsed.completed_at) : null,
  };
}
