"use server";

import Stripe from "stripe";
import { getDomain } from "@/lib/utils";
import { redirect } from "next/navigation";
import { ensureDatabaseInitialized, getUsersRepository, getBillingRepository } from "@/lib/db";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth";
import { validatePriceId } from "@/lib/validation";
import { checkRateLimit, RATE_LIMIT_POLICIES } from "@/lib/security";

export async function checkout({
  price_id,
  credits: requestedCredits,
}: {
  price_id: string;
  credits?: number;
}) {
  await ensureDatabaseInitialized();

  // 1. Authenticate user via canonical server-side resolver
  let auth;
  try {
    auth = await requireAuthenticatedUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { message: "Please sign in to continue", status: 401 };
    }
    return { message: "Authentication failure", status: 401 };
  }

  const user = auth.user;

  // Rate limiting on checkout session creation
  const rateLimitResult = await checkRateLimit(
    `checkout:user:${user.id}`,
    RATE_LIMIT_POLICIES.checkoutUser,
  );
  if (!rateLimitResult.allowed) {
    return {
      message: `Too many checkout attempts. Please wait ${rateLimitResult.retryAfterSeconds} seconds before trying again.`,
      status: 429,
    };
  }

  // 2. Validate price ID format
  let validatedPriceId: string;
  try {
    validatedPriceId = validatePriceId(price_id);
  } catch {
    return { message: "Invalid price identifier", status: 400 };
  }

  // 3. Authoritatively resolve price and credits from SQLite catalog
  const billingRepo = getBillingRepository();
  const priceItem = await billingRepo.getActivePriceWithProduct(validatedPriceId);
  if (!priceItem || priceItem.credits <= 0) {
    return { message: "Selected product is currently unavailable", status: 400 };
  }

  // Authoritative credits from database catalog, NEVER client input
  const authoritativeCredits = priceItem.credits;

  const usersRepo = getUsersRepository();

  const stripeSecretKey =
    process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
      ? process.env.STRIPE_SECRET_KEY
      : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    return { message: "Stripe configuration missing", status: 500 };
  }

  const stripe = new Stripe(stripeSecretKey);

  // Self-heal Stripe Customer ID if not yet created
  let stripeCustomerId = user.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: {
        userId: user.id,
      },
    });
    stripeCustomerId = customer.id;
    await usersRepo.updateStripeCustomerId(user.id, stripeCustomerId);
  }

  const stripeCheckoutSession = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    client_reference_id: user.id,
    success_url: getDomain(`/?success=true&credits=${authoritativeCredits}`),
    cancel_url: getDomain(`/?success=false&credits=${authoritativeCredits}`),
    line_items: [
      {
        price: validatedPriceId,
        quantity: 1,
      },
    ],
    metadata: {
      credits: String(authoritativeCredits),
      dubCustomerId: user.id,
    },
    invoice_creation: {
      enabled: true,
    },
    mode: "payment",
  });

  if (!stripeCheckoutSession.url) {
    return { message: "Unable to create Stripe checkout session", status: 500 };
  }

  redirect(stripeCheckoutSession.url);
}
