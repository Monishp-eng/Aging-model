# Operational Guide — Extrapolate

## 1. System Architecture & Runtimes

* **Application Framework:** Next.js 14 (App Router)
* **Runtime Target:** Node.js 20.x LTS (Pinned in package.json and CI)
* **Persistence Layer:** SQLite via `@libsql/client` (durable, atomic local/embedded database)
* **Blob Storage:** Supabase Storage (private buckets for raw inputs, temporary artifacts, and final outputs)
* **Inference Engine:** Replicate API (`cjwbw/damo-image-wandering`)
* **Billing & Payments:** Stripe Checkout & Webhooks
* **Authentication:** Supabase Auth (OAuth / Google)

---

## 2. Environment Architecture

The application strictly separates environments:

| Environment | Purpose | Persistence | External Providers |
| :--- | :--- | :--- | :--- |
| **`development`** | Local machine | `./data/extrapolate.db` | Mock or test credentials; optional `TUNNEL_URL` for webhooks |
| **`preview`** | PR / Staging review | Isolated preview SQLite or LibSQL branch | Stripe Test Mode, staging buckets, test Replicate keys |
| **`production`** | Live customer traffic | Persistent volume SQLite or dedicated LibSQL | Stripe Live Mode, private production buckets, live keys |

Environment detection evaluates:
1. `APP_ENV` (`production` | `preview` | `development` | `test`)
2. `NEXT_PUBLIC_VERCEL_ENV` (Vercel deployment context)
3. `NODE_ENV`

---

## 3. SQLite Production Persistence Strategy

### 3.1 Durability & Filesystem Requirements
SQLite requires a persistent, POSIX-compliant filesystem with file locking support:
* **Fly.io / Dedicated Container (Recommended):** Deploy with a persistent NVMe volume mounted at `/data`. All writes persist across deploys and container restarts.
* **Serverless Constraint (Vercel):** Vercel serverless function filesystems are ephemeral and read-only across lambda instances. **Hosting a local SQLite file directly on standard Vercel serverless is NOT durable for production writes.** For serverless Vercel deployments, configure `DATABASE_URL` with a remote Turso / LibSQL endpoint (`libsql://...`), or host the Next.js standalone server on Fly.io or a persistent container.

### 3.2 Concurrency & Connection Settings
The database client automatically configures optimal production pragmas in `lib/db/client.ts`:
* **WAL Mode:** `PRAGMA journal_mode = WAL;` (permits concurrent non-blocking readers alongside writers).
* **Foreign Keys:** `PRAGMA foreign_keys = ON;` (enforces relational integrity).
* **Busy Timeout:** `PRAGMA busy_timeout = 5000;` (waits up to 5,000ms for lock release before throwing SQLITE_BUSY).

---

## 4. Backup & Disaster Recovery

### 4.1 Objectives
* **RPO (Recovery Point Objective):** <= 1 hour.
* **RTO (Recovery Time Objective):** <= 15 minutes.

### 4.2 Automated Backup Creation
Run the backup script via npm:
```bash
npm run db:backup
```
**Mechanism:**
1. Checkpoints the SQLite Write-Ahead Log: `PRAGMA wal_checkpoint(TRUNCATE);`.
2. Creates an atomic snapshot using `VACUUM INTO '<destination>.db'`.
3. Runs an isolated integrity check: `PRAGMA integrity_check;`.
4. Saves verified snapshot to `backups/extrapolate-backup-<timestamp>.db`.

### 4.3 Verified Database Restoration
To restore from a backup:
```bash
npm run db:restore backups/extrapolate-backup-2026-09-17T15-02-31.db
```
**Safety Invariants:**
1. The source backup file is verified for integrity prior to touching the target.
2. The current active database is preserved into a `.pre-restore-<timestamp>` backup.
3. Target database is atomically overwritten.
4. Restored database integrity is validated before completing.

---

## 5. Health & Readiness Checks

### 5.1 Liveness Probe (`/api/health`)
* **Endpoint:** `GET /api/health`
* **Response:** HTTP 200 `{ status: "ok", timestamp, uptime, release: { version, commit, env } }`
* **Header:** `Cache-Control: no-store, no-cache, must-revalidate`
* **Behavior:** Lightweight in-memory check without external network dependencies.

### 5.2 Readiness Probe (`/api/ready`)
* **Endpoint:** `GET /api/ready`
* **Response (Healthy):** HTTP 200 `{ status: "ready", checks: { database: "ok", migrations: "ok", config: "ok" } }`
* **Response (Unhealthy):** HTTP 503 `{ status: "not_ready", checks: { database: "error", ... } }`
* **Behavior:** Confirms SQLite connectivity, verifies migration table existence, and ensures required configuration is present. Never leaks database paths or secrets.

---

## 6. Scheduled Cron Jobs

Configured in `vercel.json` and deployable via system crontab / cloud schedulers:

| Route | Schedule | Purpose | Auth Mechanism |
| :--- | :--- | :--- | :--- |
| `/api/cron/cleanup` | Hourly (`0 * * * *`) | Purges expired 24h assets, temporary files, and account deletions | `Bearer <CRON_SECRET>` or `x-cron-secret` |
| `/api/cron/reconcile` | Every 10 min (`*/10 * * * *`) | Reconciles stuck/hung predictions and refunds credits | `Bearer <CRON_SECRET>` or `x-cron-secret` |

Both jobs are idempotent and emit structured JSON events (`storage_cleanup.completed`, `generation_reconciliation.completed`) with execution `run_id` and duration.
