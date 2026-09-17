# Deployment Guide & Release Checklist — Extrapolate

## 1. Supported Production Topologies

### Topology A: Fly.io Persistent Volume (Recommended)
* **Architecture:** Next.js standalone container deployed on Fly.io with an NVMe persistent volume mounted at `/data`.
* **Database:** SQLite file stored at `/data/extrapolate.db`.
* **Advantages:** Low latency, single-node persistence, durable across restarts, trivial backups via `VACUUM INTO`.

### Topology B: Hosted LibSQL / Turso with Vercel
* **Architecture:** Next.js frontend deployed on Vercel Serverless.
* **Database:** Hosted LibSQL database via Turso (`DATABASE_URL=libsql://...`).
* **Advantages:** Serverless horizontal auto-scaling with persistent external SQLite-compatible engine.

---

## 2. Production Release Gate

Before deploying to production, the CI pipeline enforces:

```text
1. git checkout clean
2. npm ci (exact dependency lockfile)
3. npm run lint (0 warnings/errors)
4. npx tsc --noEmit (0 TypeScript errors)
5. Fresh SQLite migration test (database initialized from zero)
6. Automated test suite (all suites passing)
7. npm run build (production Next.js bundle compiles clean)
```

If any step fails, deployment is automatically halted.

---

## 3. Database Migration Deployment Sequence

Migrations must be executed prior to switching traffic:

```text
1. Prepare release
2. Trigger automated backup:
   npm run db:backup
3. Apply schema migrations:
   npm run db:migrate
4. Deploy new application code
5. Verify health & readiness:
   curl -f http://app:3000/api/health
   curl -f http://app:3000/api/ready
6. Switch live traffic
```

---

## 4. Production Smoke Test Procedure

After deployment, perform a non-destructive operational smoke test:

1. **Liveness Check:**
   ```bash
   curl -i https://extrapolate.app/api/health
   ```
   *Expected:* HTTP 200 `{ status: "ok", release: { ... } }`

2. **Readiness Check:**
   ```bash
   curl -i https://extrapolate.app/api/ready
   ```
   *Expected:* HTTP 200 `{ status: "ready", checks: { database: "ok", migrations: "ok", config: "ok" } }`

3. **Cron Authentication Verification:**
   ```bash
   curl -i -X POST https://extrapolate.app/api/cron/cleanup
   ```
   *Expected:* HTTP 401 `{"error":"Unauthorized: Invalid or missing cron secret"}`

4. **Authenticated Flow:**
   Log in with a staging/test account, confirm dashboard renders and credit balance is displayed accurately.

---

## 5. Rollback Strategy

### 5.1 Application Code Rollback
If a defect is discovered in application code:
1. Re-deploy previous known-good release commit in deployment console.
2. Verify `/api/health` and `/api/ready`.

### 5.2 Database Rollback Invariants
* Schema changes in this codebase are designed to be backward-compatible (adding columns with defaults, creating new tables).
* If a migration introduced breaking changes and application rollback fails:
  1. Halt application traffic.
  2. Restore SQLite from the pre-deployment backup:
     ```bash
     npm run db:restore backups/<pre-deploy-backup>.db
     ```
  3. Re-deploy the previous application version.
  4. Bring traffic back online.
