# Production Release Checklist & Governance Gate

This document defines the authoritative, version-controlled release gate criteria and operational rollback procedures for the `extrapolate` application.

---

## 1. Zero-Tolerance Release Blockers (P0)

Any failure of the following checks **strictly blocks production deployment**. No overrides or exceptions are permitted for P0 items:

- [ ] **Authentication Bypass:** Any endpoint or server action accepting unauthenticated requests where user identity is required.
- [ ] **IDOR / Cross-User Access:** Any route, query, or storage access allowing User A to inspect, mutate, or delete User B's resources.
- [ ] **Webhook Forgery:** Any failure in HMAC-SHA256 signature verification or timestamp freshness checks on Stripe or Replicate ingress.
- [ ] **SSRF Vulnerability:** Permitting arbitrary external URLs or private IP resolution during asset downloads.
- [ ] **Financial Invariant Violation:** Any race condition allowing duplicate refunds, duplicate credit grants, or a negative `credits_balance`.
- [ ] **Broken SQLite Migration from Zero:** Failure of `npm run db:test-zero` on a fresh, empty SQLite database.
- [ ] **Non-Durable SQLite Configuration:** Running in production without WAL mode (`journal_mode = WAL`) or busy timeout configuration.
- [ ] **Production Secret Exposure:** Any server-only secret (`STRIPE_SECRET_KEY`, `REPLICATE_API_TOKEN`, `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`) present in client-side code, git history, or `NEXT_PUBLIC_*` environment variables.
- [ ] **Unauthenticated Destructive Cron:** Cron endpoints (`/api/cron/cleanup`, `/api/cron/reconcile`) accessible without a matching `CRON_SECRET` bearer token.
- [ ] **Failed Automated Release Gate:** Failure of any step in `npm run production:check`.

---

## 2. Issue Severity Classification

| Level | Classification | Action Required |
|---|---|---|
| **P0** | **Release Blocker** | Halt deployment immediately. Fix required before release candidate can proceed. |
| **P1** | **High Severity** | Blocks deployment unless formal mitigation is accepted in writing by Security / Staff Architect. |
| **P2** | **Medium Severity** | Should fix before broad general availability; track in next scheduled maintenance sprint. |
| **P3** | **Low / Backlog** | Minor visual defects, non-critical logging improvements, or performance optimizations. |

---

## 3. Comprehensive Verification Checklist

### A. Database & Migration Layer
- [x] SQLite schema conforms to migration `001_initial_schema.sql`, `002_storage_lifecycle.sql`, and `003_reliability_lifecycle.sql`.
- [x] Foreign keys enabled and verified via integration tests.
- [x] Immutable `credit_ledger` tracks all credit flows (`purchase`, `reservation`, `refund`, `manual_adjustment`).
- [x] Client idempotency hashes prevent duplicate generation submissions.
- [x] Backup script (`npm run db:backup`) generates consistent atomic snapshots using `VACUUM INTO`.

### B. Authentication & Authorization
- [x] Server-side Supabase SSR session validation (`requireAuthenticatedUser`).
- [x] Open redirect vulnerability eliminated via canonical `getSafeRedirectPath`.
- [x] User deletion lifecycle prevents active generations for pending/deleted accounts.
- [x] User sync cannot overwrite protected fields (`credits_balance`, `stripe_customer_id`, `deletion_status`).

### C. Webhooks & SSRF Defense
- [x] Replicate webhooks validated with Svix HMAC-SHA256 and 5-minute replay tolerance window.
- [x] Stripe webhooks verified using `stripe.webhooks.constructEvent` with official webhook secrets.
- [x] External image download engine validates hostname (`replicate.delivery`), scheme (`https`), and blocks RFC 1918 / loopback / metadata IPs.
- [x] Magic bytes verified for incoming artifacts (GIF, JPEG, PNG, WebP) before storage.

### D. Abuse Prevention & Rate Limiting
- [x] Generation creation rate-limited to 5 requests/min per user and 10 requests/min per IP.
- [x] Concurrency limit strictly enforced: maximum 2 concurrent active generations (`queued` or `processing`) per user.
- [x] Generation status polling rate-limited to 60 requests/min per user.
- [x] Stripe checkout creation rate-limited to 5 requests/min per user.
- [x] Structured abuse warnings logged without leaking credentials or raw payloads.

### E. Storage & Data Privacy
- [x] Input and output storage buckets configured as private.
- [x] Images normalized and stripped of EXIF / GPS metadata before storage via Sharp.
- [x] Assets served via short-lived signed URLs with ownership verification.
- [x] Retention cron (`/api/cron/cleanup`) removes expired assets after 24 hours.

### F. Observability & Monitoring
- [x] `/api/health` reports liveness, uptime, and version.
- [x] `/api/ready` validates database connectivity, migration status, and runtime environment.
- [x] Structured JSON logging with correlation IDs on all server requests.
- [x] Global error boundaries (`app/error.tsx`, `app/global-error.tsx`) capture unhandled exceptions without leaking stack traces.

---

## 4. Release Command

To certify a release candidate before deploying to staging or production, execute:

```bash
npm run production:check
```

This automated gate runs:
1. `npm run lint` — Code quality & formatting
2. `npx tsc --noEmit` — TypeScript type safety
3. `npm run security:scan` — Static security & secret scan
4. `npm run db:test-zero` — Fresh SQLite database migration gate
5. `npx vitest run` — Full test pyramid (164+ automated tests)
6. `npm run build` — Next.js production build verification

---

## 5. Non-Destructive Rollback Runbook

If a deployment incident occurs in production:

1. **Traffic Redirection / Container Rollback:**
   - Immediately roll back the deployment container or Vercel deployment alias to the previous stable release commit.
2. **Database State Preservation:**
   - Because all SQLite migrations are additive and backward-compatible, rolling back application code does NOT require rolling back the SQLite database file.
   - Do NOT delete or overwrite `data/extrapolate.db`.
3. **Emergency Backup Creation:**
   ```bash
   npm run db:backup
   ```
   This creates an atomic snapshot before taking any diagnostic action.
4. **Verification Post-Rollback:**
   - Probe `GET /api/health` and `GET /api/ready` to verify that the previous application version connects cleanly to the existing database.
   - Monitor logs for any unexpected schema errors.
