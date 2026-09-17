"use server";

import Stripe from "stripe";
import { getDomain } from "@/lib/utils";
import { redirect } from "next/navigation";
import { ensureDatabaseInitialized, getUsersRepository } from "@/lib/db";
import { requireAuthenticatedUser, UnauthorizedError } from "@/lib/auth";

export async function billing() {
  await ensureDatabaseInitialized();

  let auth;
  try {
    auth = await requireAuthenticatedUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { message: "Please sign in to view billing", status: 401 };
    }
    return { message: "Authentication failure", status: 401 };
  }

  const user = auth.user;
  const usersRepo = getUsersRepository();

  const stripeSecretKey =
    process.env.NEXT_PUBLIC_VERCEL_ENV === "production"
      ? process.env.STRIPE_SECRET_KEY
      : process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY;

  if (!stripeSecretKey) {
    return { message: "Stripe configuration missing", status: 500 };
  }

  const stripe = new Stripe(stripeSecretKey);

  let stripeCustomerId = user.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    });
    stripeCustomerId = customer.id;
    await usersRepo.updateStripeCustomerId(user.id, stripeCustomerId);
  }

  const stripeBillingSession = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: getDomain(),
  });

  if (!stripeBillingSession.url) {
    return { message: "Unable to create billing portal session", status: 500 };
  }

  redirect(stripeBillingSession.url);
}
