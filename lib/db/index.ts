import { Client } from "@libsql/client";
import { getDbClient } from "./client";
import { runMigrations } from "./migrations";
import { seedReferenceData } from "./seed";
import { UsersRepository } from "./repositories/users";
import { GenerationsRepository } from "./repositories/generations";
import { CreditsRepository } from "./repositories/credits";
import { WebhooksRepository } from "./repositories/webhooks";
import { BillingRepository } from "./repositories/billing";

export * from "./types";
export * from "./client";
export * from "./migrations";
export * from "./seed";
export * from "./repositories/users";
export * from "./repositories/generations";
export * from "./repositories/credits";
export * from "./repositories/webhooks";
export * from "./repositories/billing";

let initPromise: Promise<void> | null = null;

/**
 * Ensures the SQLite database has applied all migrations and seeded reference data.
 * Safe for repeated calls (memoized).
 */
export async function ensureDatabaseInitialized(client?: Client): Promise<void> {
  const c = client || getDbClient();
  if (!initPromise) {
    initPromise = (async () => {
      await runMigrations(c);
      const billingRepo = new BillingRepository(c);
      const products = await billingRepo.listActiveProductsWithPrices();
      if (products.length === 0) {
        await seedReferenceData(c);
      }
    })();
  }
  return initPromise;
}

export function getUsersRepository(client?: Client): UsersRepository {
  return new UsersRepository(client || getDbClient());
}

export function getGenerationsRepository(client?: Client): GenerationsRepository {
  return new GenerationsRepository(client || getDbClient());
}

export function getCreditsRepository(client?: Client): CreditsRepository {
  return new CreditsRepository(client || getDbClient());
}

export function getWebhooksRepository(client?: Client): WebhooksRepository {
  return new WebhooksRepository(client || getDbClient());
}

export function getBillingRepository(client?: Client): BillingRepository {
  return new BillingRepository(client || getDbClient());
}
