/**
 * Webhook security types, error classes, and payload schemas.
 */

export class WebhookVerificationError extends Error {
  constructor(message = "Webhook cryptographic verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export class WebhookReplayError extends Error {
  constructor(message = "Webhook delivery timestamp expired or outside tolerance window") {
    super(message);
    this.name = "WebhookReplayError";
  }
}

export class WebhookSSRFError extends Error {
  constructor(message = "SSRF target prohibited: output URL does not meet security policy") {
    super(message);
    this.name = "WebhookSSRFError";
  }
}

export class WebhookPayloadError extends Error {
  constructor(message = "Webhook payload schema validation failed") {
    super(message);
    this.name = "WebhookPayloadError";
  }
}

export class WebhookStateError extends Error {
  constructor(message = "Webhook attempted invalid or regressive state transition") {
    super(message);
    this.name = "WebhookStateError";
  }
}

export interface ReplicatePredictionPayload {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: string | string[] | null;
  error?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface SafeDownloadedArtifact {
  buffer: Buffer;
  contentType: string;
  sizeBytes: number;
}
