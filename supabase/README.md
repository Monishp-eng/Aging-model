# Supabase Legacy Artifacts & Quarantine Notice

> **Application Persistence Migration to SQLite Completed (Phase 1)**
> 
> The SQL files in this directory (`schema.sql`, `seed.sql`, and `migrations/`) are **legacy PostgreSQL artifacts** retained solely for historical reference.
>
> They are **NOT** used by the active Extrapolate application.

## Active Data Architecture
- **Primary Persistence Layer**: SQLite managed via `@libsql/client`.
- **Authoritative Migrations**: Located in [`lib/db/migrations/`](../lib/db/migrations/).
- **Seed Scripts**: Run via `pnpm db:seed` using [`lib/db/seed.ts`](../lib/db/seed.ts).
- **Migration Runner**: Run via `pnpm db:migrate` using [`scripts/migrate.ts`](../scripts/migrate.ts).

## Active Supabase Scope
The application retains Supabase solely for:
1. **Authentication**: Supabase Auth handles OAuth sessions (Google/GitHub/email).
2. **Object Storage**: Supabase Storage buckets (`photos`, etc.) hold uploaded and transformed image assets.

All tabular application data—including `users`, `generations`, `credit_ledger`, `products`, `prices`, and `webhook_events`—is persisted exclusively in SQLite.
