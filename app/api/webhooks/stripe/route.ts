import { NextRequest } from "next/server";
import Stripe from "stripe";
import {
  ensureDatabaseInitialized,
  getBillingRepository,
  getCreditsRepository,
  getWebhooksRepository,
} from "@/lib/db";
import { verifyStripeWebhook, WebhookVerificationError } from "@/lib/security/webhook";

export const dynamic = "force-dynamic";

const ALLOWED_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "product.created",
  "product.updated",
  "product.deleted",
  "price.created",
  "price.updated",
  "price.deleted",
]);

export async function POST(req: NextRequest) {
  const startTime = Date.now();

  // 1. Read raw body as text for cryptographic signature verification
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "Failed to read request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Cryptographic signature and replay verification
  const signature = req.headers.get("stripe-signature");
  let event: Stripe.Event;

  try {
    event = await verifyStripeWebhook({
      rawBody,
      signature,
    });
  } catch (err: any) {
    console.warn(`[Stripe Webhook Auth Failure] reason=${err?.message}`);
    return new Response(JSON.stringify({ error: err?.message || "Invalid signature" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  await ensureDatabaseInitialized();
  const webhooksRepo = getWebhooksRepository();
  const billingRepo = getBillingRepository();
  const creditsRepo = getCreditsRepository();

  // 3. Idempotent webhook event recording & deduplication
  const { isDuplicate } = await webhooksRepo.recordEvent({
    provider: "stripe",
    externalEventId: event.id,
    eventType: event.type,
  });

  if (isDuplicate) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Check event allowlist
  if (!ALLOWED_STRIPE_EVENTS.has(event.type)) {
    await webhooksRepo.markProcessed({
      provider: "stripe",
      externalEventId: event.id,
      status: "processed",
    });
    return new Response(JSON.stringify({ received: true, ignored: "Unsupported event type" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    switch (event.type) {
      // Product lifecycle synchronization
      case "product.created":
      case "product.updated": {
        const product = event.data.object as Stripe.Product;
        await billingRepo.upsertProduct({
          stripeProductId: product.id,
          name: product.name,
          description: product.description,
          active: product.active,
          metadata: product.metadata,
        });
        break;
      }
      case "product.deleted": {
        const product = event.data.object as Stripe.Product;
        await billingRepo.deleteProduct(product.id);
        break;
      }

      // Price lifecycle synchronization
      case "price.created":
      case "price.updated": {
        const price = event.data.object as Stripe.Price;
        await billingRepo.upsertPrice({
          stripePriceId: price.id,
          stripeProductId:
            typeof price.product === "string" ? price.product : price.product.id,
          unitAmount: price.unit_amount || 0,
          currency: price.currency,
          active: price.active,
          metadata: price.metadata,
        });
        break;
      }
      case "price.deleted": {
        const price = event.data.object as Stripe.Price;
        await billingRepo.deletePrice(price.id);
        break;
      }

      // Checkout completion: idempotent credit crediting
      case "checkout.session.completed": {
        const checkout = event.data.object as Stripe.Checkout.Session;
        if (
          checkout.status === "complete" &&
          checkout.payment_status === "paid" &&
          checkout.client_reference_id
        ) {
          const creditsAmount = Number(checkout.metadata?.credits);
          if (creditsAmount > 0) {
            await creditsRepo.recordStripePurchase({
              userId: checkout.client_reference_id,
              stripeEventId: event.id,
              amount: creditsAmount,
              metadata: {
                checkoutSessionId: checkout.id,
                customer: checkout.customer,
              },
            });
          }
        }
        break;
      }

      default:
        break;
    }

    await webhooksRepo.markProcessed({
      provider: "stripe",
      externalEventId: event.id,
      status: "processed",
    });

    const duration = Date.now() - startTime;
    console.log(
      `[Stripe Webhook Handled] eventId=${event.id} eventType=${event.type} durationMs=${duration}`,
    );

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error(`[Stripe Webhook Processing Error] eventId=${event.id} error=${error?.message}`);

    await webhooksRepo.markProcessed({
      provider: "stripe",
      externalEventId: event.id,
      status: "failed",
      errorMessage: error?.message,
    });

    return new Response(JSON.stringify({ error: "Database synchronization error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
