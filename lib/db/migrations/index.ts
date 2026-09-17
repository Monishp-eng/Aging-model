import { Client } from "@libsql/client";
import { initializePragmas } from "../client";

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: "001_initial_schema",
    sql: `
-- 1. Users table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    auth_provider_user_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    image TEXT,
    stripe_customer_id TEXT UNIQUE,
    credits_balance INTEGER NOT NULL DEFAULT 0 CHECK (credits_balance >= 0),
    deletion_requested_at TEXT,
    deletion_status TEXT NOT NULL DEFAULT 'active' CHECK (deletion_status IN ('active', 'pending', 'deleted')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_auth_provider_id ON users (auth_provider_user_id);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users (stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- 2. Generations table
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'canceled', 'expired')),
    input_path TEXT NOT NULL,
    output_path TEXT,
    replicate_prediction_id TEXT UNIQUE,
    credits_reserved INTEGER NOT NULL DEFAULT 10 CHECK (credits_reserved >= 0),
    error_code TEXT,
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    failed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generations_user_created ON generations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generations_status_updated ON generations (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_generations_replicate_id ON generations (replicate_prediction_id);

-- 3. Credit Ledger table
CREATE TABLE IF NOT EXISTS credit_ledger (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    generation_id TEXT REFERENCES generations(id) ON DELETE RESTRICT,
    stripe_event_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('purchase', 'reservation', 'consumption', 'refund', 'adjustment')),
    amount INTEGER NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user_created ON credit_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_generation ON credit_ledger (generation_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_generation_type ON credit_ledger (generation_id, type) WHERE generation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_ledger_stripe_event ON credit_ledger (stripe_event_id) WHERE stripe_event_id IS NOT NULL;

-- 4. Webhook Events table (for idempotency & audit)
CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('stripe', 'replicate', 'supabase')),
    external_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_hash TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
    received_at TEXT NOT NULL,
    processed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT uq_webhook_provider_event UNIQUE (provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_event ON webhook_events (provider, external_event_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status);

-- 5. Products table
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    stripe_product_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_stripe_product_id ON products (stripe_product_id);

-- 6. Prices table
CREATE TABLE IF NOT EXISTS prices (
    id TEXT PRIMARY KEY,
    stripe_price_id TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    unit_amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prices_stripe_price_id ON prices (stripe_price_id);
CREATE INDEX IF NOT EXISTS idx_prices_product_active ON prices (product_id, active);
`,
  },
  {
    name: "002_storage_lifecycle",
    sql: `
ALTER TABLE generations ADD COLUMN expires_at TEXT;
ALTER TABLE generations ADD COLUMN cleaned_up_at TEXT;
ALTER TABLE generations ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generations ADD COLUMN last_delete_error TEXT;

CREATE INDEX IF NOT EXISTS idx_generations_cleanup ON generations (cleaned_up_at, expires_at);

ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN deletion_error TEXT;
`,
  },
  {
    name: "003_reliability_lifecycle",
    sql: `
ALTER TABLE generations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE generations ADD COLUMN processing_started_at TEXT;
ALTER TABLE generations ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE generations ADD COLUMN client_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_client_idempotency ON generations(client_idempotency_key) WHERE client_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generations_reconcile ON generations(status, updated_at);
`,
  },
];

export async function runMigrations(client: Client): Promise<{ applied: string[]; alreadyApplied: string[] }> {
  await initializePragmas(client);

  // Ensure migrations tracking table exists
  await client.execute(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = await client.execute("SELECT name FROM migrations ORDER BY id ASC;");
  const appliedSet = new Set(appliedRows.rows.map((r) => String(r.name)));

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const migration of MIGRATIONS) {
    if (appliedSet.has(migration.name)) {
      alreadyApplied.push(migration.name);
      continue;
    }

    // Split SQL by statements and execute
    const statements = migration.sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const tx = await client.transaction("write");
    try {
      for (const statement of statements) {
        await tx.execute(statement);
      }
      const now = new Date().toISOString();
      await tx.execute({
        sql: "INSERT INTO migrations (name, applied_at) VALUES (?, ?);",
        args: [migration.name, now],
      });
      await tx.commit();
      applied.push(migration.name);
    } catch (error) {
      await tx.rollback();
      throw new Error(`Failed to apply migration '${migration.name}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { applied, alreadyApplied };
}
