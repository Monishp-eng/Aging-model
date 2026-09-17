# Incident Response & Runbooks — Extrapolate

## General Incident Invariants

1. **Correlation IDs First:** Always locate the `x-request-id` from the HTTP response or client error boundary (`Incident Reference: <id>`).
2. **Never Modify Financial Data via Ad-Hoc SQL:** Never execute direct `UPDATE users SET credits = ...`. All credit balance modifications must flow through the credit ledger (`lib/db/repositories/credits.ts`) to maintain accounting auditability.
3. **Trace Generation Lifecycle:** Search structured logs for `generationId`, `predictionId`, or `webhookEventId`.

---

## 1. Stuck Generations

### Symptoms
* User interface displays "Generating..." indefinitely.
* Metric `HIGH_REFUND_RATE` or stuck generation count increasing.
* Customer reports photo processing never finished.

### Where to Look
* Application logs: filter by `generationId`.
* Check Replicate dashboard for model prediction status (`predictionId`).
* Inspect `/api/cron/reconcile` execution logs.

### Safe Recovery Action
1. Trigger an immediate reconciliation run:
   ```bash
   curl -X POST https://extrapolate.app/api/cron/reconcile \
     -H "Authorization: Bearer <CRON_SECRET>"
   ```
2. The reconciler checks Replicate:
   * If Replicate succeeded, it fetches the artifact, uploads to storage, and marks `succeeded`.
   * If Replicate failed, canceled, or exceeded 10 minutes, it marks `failed` and atomically refunds reserved credits.
   * If orphaned before prediction started, it terminates the job and refunds credits.

### Dangerous Actions to Avoid
* Do NOT delete generation rows from the database.
* Do NOT issue manual Stripe refunds before verifying credit ledger state.

---

## 2. Replicate Provider Outage

### Symptoms
* High rate of `REPLICATE_TIMEOUT` or `REPLICATE_FAILED` errors.
* Generation success rate drops below 85%.

### Where to Look
* Status page: `https://status.replicate.com`.
* Structured logs: filter by `error_code: REPLICATE_TIMEOUT` or `REPLICATE_FAILED`.

### Safe Recovery Action
1. Upstream retries (`retryWithBackoff`) handle transient network spikes (up to 2 attempts with backoff).
2. For sustained outages, notify users on the upload form with maintenance banner.
3. The reconciliation service (`/api/cron/reconcile`) will automatically catch up and refund any affected users once Replicate stabilizes.

---

## 3. Webhook Delivery Failures / Spikes

### Symptoms
* Metric `HIGH_WEBHOOK_FAILURE_RATE` alert triggers (>5% failures).
* Webhook responses returning HTTP 401 or 400.

### Where to Look
* Application logs: search for `[Replicate Webhook Signature Failure]` or `[Stripe Webhook Signature Verification Error]`.
* Review `REPLICATE_WEBHOOK_SECRET` and `STRIPE_WEBHOOK_SECRET` in environment settings.

### Safe Recovery Action
1. Confirm webhook secret matches provider dashboard.
2. In local development: verify `TUNNEL_URL` is active and matches the URL registered in external provider.
3. Once secrets are corrected, Replicate and Stripe will automatically retry failed webhooks with exponential backoff.
4. Run `/api/cron/reconcile` to sync any missed events.

---

## 4. SQLite Lock Contention or Corruption

### Symptoms
* HTTP 500/503 errors with `SQLITE_BUSY` or `database is locked`.
* `/api/ready` endpoint returns 503 with `"database": "error"`.

### Where to Look
* Inspect SQLite file location and disk usage.
* Check if multiple write processes are executing against the same SQLite database file without sharing the client pool.

### Safe Recovery Action
1. Verify `PRAGMA busy_timeout = 5000;` is active.
2. If file corruption is suspected, test integrity:
   ```bash
   sqlite3 ./data/extrapolate.db "PRAGMA integrity_check;"
   ```
3. If corrupt, restore from the most recent hourly backup:
   ```bash
   npm run db:restore backups/<latest-backup>.db
   ```
4. Restart application container.

---

## 5. Storage Outage (Supabase)

### Symptoms
* Upload fails during initial photo upload.
* Metric `STORAGE_CLEANUP_FAILURES` alert triggers.

### Where to Look
* Supabase dashboard: Storage metrics and project status.
* Check bucket configuration: ensure `input`, `output`, `temp` buckets exist and are marked private.
* Verify `SUPABASE_SERVICE_ROLE_KEY` is valid.

### Safe Recovery Action
1. Verify Supabase service status.
2. If uploads fail, credits are NOT deducted because deduction happens only upon valid upload initiation.
3. If output storage fails, reconciliation service will retry artifact storage on subsequent cron runs.

---

## 6. High HTTP 5xx Error Spike

### Symptoms
* Alert `HIGH_HTTP_5XX_RATE` triggers (>5% errors).
* Users experiencing error boundary screens.

### Where to Look
* Application error logs: filter by `level: error` or `[AppError]`.
* Check `/api/health` and `/api/ready` responses.
* Check process memory and CPU utilization.

### Safe Recovery Action
1. Check readiness endpoint: `curl -I https://extrapolate.app/api/ready`.
2. Inspect incident references quoted by users.
3. If memory leak or node unresponsiveness, restart application container (readiness probes will re-route traffic).
