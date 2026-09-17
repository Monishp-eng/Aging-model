-- Migration 002: Storage & Retention Lifecycle
ALTER TABLE generations ADD COLUMN expires_at TEXT;
ALTER TABLE generations ADD COLUMN cleaned_up_at TEXT;
ALTER TABLE generations ADD COLUMN delete_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE generations ADD COLUMN last_delete_error TEXT;

CREATE INDEX IF NOT EXISTS idx_generations_cleanup ON generations (cleaned_up_at, expires_at);

ALTER TABLE users ADD COLUMN deleted_at TEXT;
ALTER TABLE users ADD COLUMN deletion_error TEXT;
