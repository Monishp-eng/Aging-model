import { Client } from "@libsql/client";
import { BillingRepository } from "./repositories/billing";

export async function seedReferenceData(client: Client): Promise<void> {
  const billingRepo = new BillingRepository(client);

  const defaultProducts = [
    {
      productId: "prod_starter_default",
      stripeProductId: "prod_starter_default",
      priceId: "price_starter_default",
      stripePriceId: "price_starter_default",
      name: "Starter",
      description: "100 credits for generating 10 aged headshots",
      unitAmount: 900,
      credits: 100,
    },
    {
      productId: "prod_pro_default",
      stripeProductId: "prod_pro_default",
      priceId: "price_pro_default",
      stripePriceId: "price_pro_default",
      name: "Pro",
      description: "900 credits for generating 90 aged headshots",
      unitAmount: 1900,
      credits: 900,
    },
    {
      productId: "prod_premium_default",
      stripeProductId: "prod_premium_default",
      priceId: "price_premium_default",
      stripePriceId: "price_premium_default",
      name: "Premium",
      description: "4000 credits for generating 400 aged headshots",
      unitAmount: 3900,
      credits: 4000,
    },
  ];

  for (const item of defaultProducts) {
    await billingRepo.upsertProduct({
      id: item.productId,
      stripeProductId: item.stripeProductId,
      name: item.name,
      description: item.description,
      active: true,
      metadata: { credits: item.credits },
    });

    await billingRepo.upsertPrice({
      id: item.priceId,
      stripePriceId: item.stripePriceId,
      stripeProductId: item.stripeProductId,
      unitAmount: item.unitAmount,
      currency: "usd",
      active: true,
    });
  }
}
