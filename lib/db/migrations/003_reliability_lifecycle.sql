ALTER TABLE generations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE generations ADD COLUMN processing_started_at TEXT;
ALTER TABLE generations ADD COLUMN last_reconciled_at TEXT;
ALTER TABLE generations ADD COLUMN client_idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_generations_client_idempotency ON generations(client_idempotency_key) WHERE client_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generations_reconcile ON generations(status, updated_at);
