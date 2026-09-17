import Stripe from "stripe";
import { WebhookVerificationError } from "./types";

export interface VerifyStripeWebhookParams {
  rawBody: string;
  signature: string | null;
  secret?: string | string[];
  stripeInstance?: Stripe;
}

/**
 * Cryptographically verifies an incoming Stripe webhook event using the raw request body
 * and official Stripe HMAC-SHA256 signature verification.
 * Supports secret rotation across multiple signing secrets.
 */
export async function verifyStripeWebhook(
  params: VerifyStripeWebhookParams,
): Promise<Stripe.Event> {
  const { rawBody, signature, secret } = params;

  if (!signature || typeof signature !== "string" || !signature.trim()) {
    throw new WebhookVerificationError("Missing or empty stripe-signature header");
  }

  if (typeof rawBody !== "string" || !rawBody.length) {
    throw new WebhookVerificationError("Missing raw body for Stripe webhook verification");
  }

  // Resolve secret(s) for rotation
  const secretsList: string[] = [];
  if (Array.isArray(secret)) {
    secretsList.push(...secret);
  } else if (typeof secret === "string" && secret.trim()) {
    secretsList.push(...secret.split(",").map((s) => s.trim()).filter(Boolean));
  } else {
    // Default to configured environment variables
    const primary =
      process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
        ? process.env.STRIPE_WEBHOOK_SECRET
        : process.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET;

    if (primary) secretsList.push(primary);
    if (process.env.STRIPE_WEBHOOK_SECRET && !secretsList.includes(process.env.STRIPE_WEBHOOK_SECRET)) {
      secretsList.push(process.env.STRIPE_WEBHOOK_SECRET);
    }
  }

  if (secretsList.length === 0) {
    throw new WebhookVerificationError("Stripe webhook secret is not configured on the server");
  }

  const stripe =
    params.stripeInstance ||
    new Stripe(
      process.env.STRIPE_SECRET_KEY ||
        process.env.STRIPE_SECRET_KEY_TEST ||
        "sk_test_placeholder",
    );

  let lastError: any = null;

  for (const candidateSecret of secretsList) {
    try {
      const event = await stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        candidateSecret,
      );
      return event;
    } catch (err) {
      lastError = err;
      // Continue trying next secret in rotation
    }
  }

  throw new WebhookVerificationError(
    `Stripe signature verification failed: ${lastError?.message || "Invalid signature"}`,
  );
}
