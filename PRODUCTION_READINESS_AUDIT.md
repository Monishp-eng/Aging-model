# PRODUCTION READINESS AUDIT & FORENSIC ENGINEERING ANALYSIS

**Target Project:** `extrapolate` (`steven-tey/extrapolate` / `ajayvignesh01/extrapolate-new`)  
**Auditor Roles:** Principal Software Architect, Senior Security Engineer, Staff Product Engineer, DevOps Architect, Enterprise UI/UX Reviewer  
**Audit Date:** September 2026  
**Repository State:** Branch `main`, Commit `9003193`  
**Execution Standard:** Strictly Read-Only Discovery, Zero Assumptions, 100% Code-Evidenced  

---

## TABLE OF CONTENTS
1. [Phase 0 — Project & Codebase Context](#phase-0--project--codebase-context)
2. [Phase 1 — System Architecture Review](#phase-1--system-architecture-review)
3. [Phase 2 — Enterprise UI/UX Audit](#phase-2--enterprise-uiux-audit)
4. [Phase 3 — Defensive Security Audit (OWASP Top 10)](#phase-3--defensive-security-audit-owasp-top-10)
5. [Phase 4 — Performance & Scalability Review](#phase-4--performance--scalability-review)
6. [Phase 5 — Code Quality & Maintainability Review](#phase-5--code-quality--maintainability-review)
7. [Phase 6 — Database & Storage Review](#phase-6--database--storage-review)
8. [Phase 7 — DevOps, Infrastructure & Operational Review](#phase-7--devops-infrastructure--operational-review)
9. [Phase 8 — Final Production Readiness Report & Scoring](#phase-8--final-production-readiness-report--scoring)
10. [Prioritized Engineering Improvements (P0–P3)](#prioritized-engineering-improvements-p0p3)
11. [Realistic Implementation Roadmap (Phases 1–6)](#realistic-implementation-roadmap-phases-16)
12. [Project Knowledge Model](#project-knowledge-model)
13. [What I Now Understand About This Project](#what-i-now-understand-about-this-project)

---

# PHASE 0 — PROJECT & CODEBASE CONTEXT

### 1. Project Purpose & Use Cases
*Extrapolate* is a consumer-facing AI micro-SaaS application designed to generate aged facial progression GIFs (showing a person aging from youth into their 90s) from a single user-uploaded headshot.
- **Core Use Case:** A user signs in with Google OAuth, purchases credit packs through Stripe Checkout, uploads a portrait photo, and waits ~30–60 seconds while a Replicate machine learning model generates an aging GIF, which is displayed and made downloadable in a personal gallery.
- **Secondary / Exploratory Use Case:** An incomplete, commented-out "Age Predict" modal designed to estimate a person's current age from a photo.

### 2. Actual Tech Stack (Discovered from Codebase)
| Layer | Declared / Claimed | Actually Implemented | Evidence |
| :--- | :--- | :--- | :--- |
| **Framework** | Next.js 14 (App Router) | Next.js 14.2.3, React 18.3.1 | `package.json` lines 49–53 |
| **Styling & UI** | Tailwind CSS + Radix UI | Tailwind 3.4.3, Radix UI Primitives, Framer Motion 11.1.9, Sonner, Vaul Drawer | `package.json` lines 22–31, `tailwind.config.ts` |
| **State Management** | Zustand + SWR | Zustand 4.5.2 (dialog visibility & user state) + `swr/immutable` | `components/layout/navbar.tsx` lines 17–25 |
| **Database & Auth** | Supabase (PostgreSQL + Auth) | Supabase SSR (`@supabase/ssr` 0.3.0, `@supabase/supabase-js` 2.43.1), Google OAuth | `lib/supabase/server.ts` lines 1–35 |
| **Object Storage** | Supabase Storage (S3-compatible) | 3 buckets: `input`, `output`, `temp` | `app/actions/upload.ts` lines 46–52 |
| **Realtime Sync** | Supabase Realtime | Postgres change listener on `public.data` table | `app/p/[id]/photo-page.tsx` lines 20–39 |
| **AI Inference** | Replicate API | `replicate` SDK 0.29.4 calling model `yuval-alaluf/sam` | `app/actions/upload.ts` lines 60–69 |
| **Payments** | Stripe Billing & Checkout | `stripe` SDK 15.5.0, Checkout Sessions, Customer Portal, Webhook sync | `app/actions/checkout.ts` lines 19–56 |
| **Analytics & Referral** | Dub.co + Google Analytics | `dub` 0.36.2, `@dub/analytics`, `@next/third-parties/google` | `app/api/auth/callback/route.ts` lines 5–33 |
| **Rate Limiting** | Upstash Redis | **NOT IMPLEMENTED** (Packages `@upstash/ratelimit` & `@upstash/redis` exist in `package.json`, but zero references exist in source code) | `package.json` lines 34–35 |
| **Scheduled Jobs** | Vercel Cron | **NOT IMPLEMENTED** (`vercel.json` is `{ }`, no route handler exists) | `vercel.json` lines 1–3 |

---

# PHASE 1 — SYSTEM ARCHITECTURE REVIEW

```text
               ┌──────────────────────────────────────────────────────────┐
               │                   Browser Client (Next.js)              │
               │  [Navbar]  [PhotoBooth / Carousel]  [Gallery]  [Dialogs] │
               └────────────┬─────────────────────────────┬───────────────┘
                            │ Server Actions              │ Realtime WS
                            ▼                             ▼
               ┌──────────────────────────┐      ┌─────────────────────────┐
               │ Next.js App Router (Node)│      │  Supabase Realtime      │
               │  - upload.ts             │      │  (PostgreSQL CDC)       │
               │  - checkout.ts           │      └────────────▲────────────┘
               │  - deleteAccount.ts      │                   │
               └────┬───────────────┬─────┘                   │
                    │               │                         │
     Upload Image   ▼               ▼ Create Prediction       │ Update Row
  ┌───────────────────┐    ┌────────────────────┐             │
  │  Supabase Storage │    │  Replicate API     │             │
  │  Bucket: 'input'  │    │  (yuval-alaluf/sam)│             │
  └───────────────────┘    └────────┬───────────┘             │
                                    │ Webhook Callback        │
                                    ▼                         │
               ┌──────────────────────────────────────────┐   │
               │ Edge Route Handler                       │   │
               │ POST /api/webhooks/replicate/[id]        ├───┘
               │ - Download GIF from Replicate delivery   │
               │ - Store in Supabase 'output' bucket      │
               │ - Update public.data { output } in DB    │
               └──────────────────────────────────────────┘
```

### 1. Architectural Bottlenecks & Critical Flaws
1. **Critical Disconnect Between SQL Migration and Application Code (Fatal Bug):**
   - In `app/actions/upload.ts` (lines 97–105):
     ```ts
     const { error } = await supabase.from("data").insert({
       id: key,
       input: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/input/${user_id}/${key}`,
     });
     if (error) { return setRandomKey(user_id); }
     ```
   - In `supabase/migrations/20240514064141_init.sql` (lines 19–28) and `supabase/schema.sql` (lines 87–93):
     `public.data` has columns `id`, `output`, `failed`, `created_at`, `user_id`. **Column `input` does NOT exist in the SQL schema.**
   - **Impact:** Any fresh database setup running the official migration will fail on insert with `PostgrestError: column "input" of relation "data" does not exist`. Because the action treats any error as a key collision, it executes **unbounded recursive self-invocation (`setRandomKey`)**, causing a stack overflow / crash.
   - **Severity:** `CRITICAL (P0)`.

2. **Decoupled Asynchronous Completion Model with Unsecured Public Ingress:**
   - Client initiates the job synchronously via Server Action, but generation takes 30–60s. The client redirects to `/p/[id]` and waits on Supabase Realtime WebSocket changes.
   - The completion signal is sent by Replicate to `/api/webhooks/replicate/[id]`. This endpoint has **no authentication, signature check, or token verification**.

3. **Development vs. Production Split Hardcoded Inconsistently:**
   - In `components/layout/checkout-dialog.tsx` (lines 60–65), `rpc("get_products_dev")` is called when `NEXT_PUBLIC_VERCEL_ENV !== "production"`. This stored procedure does not exist in the migration scripts.
   - In `app/actions/billing.ts` (line 31) and `app/actions/checkout.ts` (line 37), non-production environments attempt to read `userData.stripe_id_dev`, a column absent from the PostgreSQL migration.

---

# PHASE 2 — ENTERPRISE UI/UX AUDIT

Compared against modern SaaS standards (Linear, Vercel, Stripe), the presentation layer shows good aesthetic intent (using Clash Display and clean cards) but suffers from UX friction, missing interaction states, and copy-paste template remnants.

### 1. Detailed UI/UX Findings
| Component / Area | Exact UI Issue | Why It Hurts UX | Recommended Redesign | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **Modal Headers** | Logo in all modals links to `https://precedent.dev` (`upload-dialog.tsx` line 47, `checkout-dialog.tsx` line 80) | Clicking the brand icon navigates the user away from the app to a third-party open-source template website. | Remove `<a>` tag or link to internal root `/`. | **P1** |
| **File Validation Feedback** | Code checks `file.size > 10MB` (`upload-dialog.tsx` line 119), but text error says `"File size too big (max 5MB)"` (line 148) | Users uploading an 8MB image are told it exceeds 5MB, causing confusion over actual platform constraints. | Synchronize client-side boundary and message to 10MB with clear visual validation badges. | **P2** |
| **Gallery Empty State** | Unstyled `<p>Upload a photo to see your gallery!</p>` (`gallery-page.tsx` line 35) | No primary call-to-action button, no illustration, feels like an abandoned screen. | Add empty-state card with an "Upload Your First Photo" action button triggering the upload modal. | **P2** |
| **Result Page Loading State** | Static text "This can take a minute to run." (`photo-booth.tsx` line 155) | Users waiting 45s on an AI inference job receive zero progress indicator, no step indication. | Implement an animated progress tracker with realistic elapsed time estimations. | **P2** |
| **Download UX** | Download uses `Origin: location.origin` fetch blob trick (`photo-booth.tsx` lines 85–101) | Fails silently on CORS mismatch or network interruption without user-facing toast notifications. | Catch errors with `sonner` toast ("Download failed. Right click and save image"). | **P2** |
| **Dicebear Avatar Fallback** | User dropdown uses `https://avatars.dicebear.com/api/micah/...` (`user-dropdown.tsx` line 74) | Dicebear v4 API endpoint has been discontinued and throws 404 or broken images. | Switch to modern Dicebear API (`api.dicebear.com/7.x/...`) or local SVG initials avatar. | **P1** |
| **Auth Error Page Missing** | In `app/api/auth/callback/route.ts` line 43, failed OAuth redirects to `/auth/auth-code-error` | Route `/auth/auth-code-error` does NOT exist in `app/`. Users land on default Next.js 404 page. | Create a dedicated friendly authentication error screen with retry instructions. | **P1** |

---

# PHASE 3 — DEFENSIVE SECURITY AUDIT (OWASP TOP 10)

### 1. Security Vulnerability Matrix
| Vulnerability Class | Location | Real-World Impact | Severity | Likelihood |
| :--- | :--- | :--- | :--- | :--- |
| **A01: Broken Access Control / Authentication Bypass** | `app/api/webhooks/replicate/[id]/route.ts` lines 6–86 | Webhook endpoint is publicly exposed without signature verification. Anyone can forge completed/failed predictions. | **CRITICAL** | High |
| **A10: Server-Side Request Forgery (SSRF)** | `app/api/webhooks/replicate/[id]/route.ts` line 25 | The route executes `fetch(output)` where `output` is an unvalidated string from request JSON. Edge worker can be coerced to probe internal network or exfiltrate tokens. | **CRITICAL** | High |
| **A01: Broken Authorization / Unauthorized Deletion** | `app/api/webhooks/supabase/customer/route.ts` lines 16–59 | Public endpoint receives database webhook without secret token header. An attacker can POST `{ type: "DELETE", old_record: { stripe_id: "cus_..." } }` to delete arbitrary Stripe customers. | **HIGH** | High |
| **A01: Open Redirect Vulnerability** | `app/api/auth/callback/route.ts` lines 11–38 | Parameter `next` is read directly from query string and concatenated with `origin`: `redirect(`${origin}${next}`)`. If `next` starts with `//evil.com`, some browsers treat this as external redirect. | **MEDIUM** | Medium |
| **A04: Insecure Design / Incomplete Account Erasure** | `app/actions/deleteAccount.ts` lines 36–66 | S3/Supabase storage files are NOT deleted because folder paths instead of file keys are passed to `.remove()`. Furthermore, error handling checks wrong variable (`if (error)` instead of `deleteError`). | **HIGH** | High |
| **A04: Unlimited Credit Minting Exploit** | `app/api/webhooks/replicate/[id]/route.ts` lines 72–82 | Repeatedly calling the webhook with `{ status: "failed" }` increments user credits by +10 indefinitely because there is no idempotency key or state check on whether the job was already refunded. | **CRITICAL** | High |

### 2. Concrete Remediation Implementations

#### A. Secure Replicate Webhook Validation
```ts
// app/api/webhooks/replicate/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  const webhookSecret = process.env.REPLICATE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new NextResponse("Webhook secret unconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  const idHeader = req.headers.get("webhook-id");
  const timestampHeader = req.headers.get("webhook-timestamp");
  const signatureHeader = req.headers.get("webhook-signature");

  if (!idHeader || !timestampHeader || !signatureHeader) {
    return new NextResponse("Missing signature headers", { status: 401 });
  }

  const signedContent = `${idHeader}.${timestampHeader}.${rawBody}`;
  const computedSignature = crypto
    .createHmac("sha256", Buffer.from(webhookSecret.split("_")[1] || webhookSecret, "base64"))
    .update(signedContent)
    .digest("base64");

  // Verify signature and check timestamp replay (< 5 minutes)
  const isValid = crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(computedSignature));
  if (!isValid) {
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const payload = JSON.parse(rawBody);
  // Strictly validate that output URL belongs to replicate.delivery domain
  if (payload.output && !payload.output.startsWith("https://replicate.delivery/")) {
    return new NextResponse("Untrusted output domain (SSRF protection)", { status: 400 });
  }
  // Proceed with idempotent processing
}
```

#### B. Secure Supabase Webhook Authorization
```ts
// app/api/webhooks/supabase/customer/route.ts
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("x-supabase-webhook-secret");
  if (authHeader !== process.env.SUPABASE_WEBHOOK_SECRET) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  // Proceed with processing
}
```

---

# PHASE 4 — PERFORMANCE & SCALABILITY REVIEW

### 1. Performance Hotspots & Architectural Defects
1. **Severe Memory Leak & Subscription Storm in Realtime Client:**
   - In `app/p/[id]/photo-page.tsx` (lines 20–39):
     ```tsx
     const supabase = createClient();
     const realtime = supabase.channel(id);
     if (!fallbackData?.output && !fallbackData?.failed) {
       realtime.on("postgres_changes", ...).subscribe();
     }
     ```
   - **Root Cause:** This channel creation and subscription logic is placed directly in the **render function body**, outside of any `useEffect`.
   - **Impact:** Every React render creates an additional WebSocket channel subscription to Supabase. Re-renders generate dozens of duplicate listeners, leaking memory and exhausting Supabase Realtime client connection quotas.
   - **Fix:** Wrap all subscription, dispatch, and teardown logic inside a `useEffect` hook with a clean `return () => { supabase.removeChannel(realtime); }`.

2. **Next.js Image Domain Configuration Syntax Bug:**
   - In `next.config.mjs` line 7:
     ```javascript
     remotePatterns: [
       {
         protocol: 'https',
         hostname: `${process.env.NEXT_PUBLIC_SUPABASE_URL}`,
         pathname: '/storage/v1/object/public/data/**',
       }
     ]
     ```
   - **Root Cause:** `NEXT_PUBLIC_SUPABASE_URL` contains the protocol (e.g. `https://xyz.supabase.co`). `hostname` requires only the bare domain (e.g. `xyz.supabase.co`).
   - **Impact:** Next.js Image optimization will fail hostname validation and refuse to render or optimize remote images.

3. **Uncached User Fetch on Navigation:**
   - In `components/layout/navbar.tsx` (lines 32–44), `useSWRImmutable` fetches user data from Supabase client-side, but updates a global Zustand store. If the session expires or cookies desynchronize, the UI shows stale credit counters.

---

# PHASE 5 — CODE QUALITY & MAINTAINABILITY REVIEW

### 1. Dead Code, Orphan Components & Phantom Dependencies
The repository contains substantial residue from starter kits and abandoned PR experiments:

| Category | File / Artifact | Evidence of Non-Participation |
| :--- | :--- | :--- |
| **Dead Dependencies** | `@upstash/ratelimit`, `@upstash/redis` | In `package.json` lines 34–35, zero imports in any `.ts`/`.tsx` file. |
| **Dead Dependencies** | `plaiceholder`, `react-markdown`, `date-fns` | In `package.json` lines 41, 51, 54, zero imports in codebase. |
| **Abandoned Feature** | `app/actions/uploadAgePredict.ts`, `components/age-predict-modal.tsx` | Completely commented out in `components/home-page.tsx`. Contains un-awaited promises (line 66) and hardcoded dev IDs (line 53). |
| **Unused UI Components** | `components/Banner.tsx` | Exported component is unreferenced across the app. |
| **Unused UI Components** | `components/shared/counting-numbers.tsx`, `leaflet.tsx`, `modal.tsx`, `popover.tsx`, `switch.tsx`, `tooltip.tsx` | Leftover components from Precedent template; zero imports anywhere in application code. |

### 2. Silent Error Swallowing in Webhook Handler
In `app/api/webhooks/replicate/[id]/route.ts` (lines 33–36, 45–48, 58–59, 68–70, 78–81):
```ts
if (storageError)
  new Response(`Error saving output: ${storageError.message}`, {
    status: 400,
  });
// ...
return new Response("OK", { status: 200 });
```
- **Analysis:** `new Response(...)` creates a Response object without `return`. Execution falls straight through to the bottom line, returning `200 OK` even if the file failed to save or the database query crashed.

---

# PHASE 6 — DATABASE & STORAGE REVIEW

### 1. Database Schema Analysis & Discrepancies
The PostgreSQL database managed via Supabase has 4 primary application tables:
1. `public.users`: Profiles mirrored from `auth.users` via trigger `on_auth_user_created`. Holds `credits` and `stripe_id`.
2. `public.data`: Stores job runs (`id`, `user_id`, `output`, `failed`, `created_at`).
3. `public.products`: Mirrored Stripe products.
4. `public.prices`: Mirrored Stripe prices.

#### Critical Database Bugs:
1. **Missing `input` Column on `public.data`:**
   - As identified in Phase 1, `public.data` lacks the `input text` column, causing all uploads to fail on new deployments.
2. **Hardcoded Webhook Trigger in SQL Schema:**
   - In `supabase/schema.sql` line 169:
     ```sql
     CREATE OR REPLACE TRIGGER "customer" AFTER INSERT OR DELETE ON "public"."users" 
     FOR EACH ROW EXECUTE FUNCTION "supabase_functions"."http_request"(
       'https://extrapolate-new.vercel.app/api/webhooks/supabase/customer', 
       'POST', 
       '{"Content-type":"application/json"}', 
       '{}', 
       '1000'
     );
     ```
   - **Impact:** Any developer deploying this migration on their own Supabase project will have their database trigger send customer lifecycle webhooks to `https://extrapolate-new.vercel.app` instead of their own domain.
3. **Storage Bucket Policy Configuration Missing:**
   - Neither `schema.sql` nor `migrations/` define the required Supabase Storage bucket configurations (`input`, `output`, `temp`) or their respective storage RLS policies.

### 2. Consolidated Database Migration Fix
```sql
-- Migration: 20260916000000_production_fixes.sql

-- 1. Add missing input column to data table
ALTER TABLE public.data ADD COLUMN IF NOT EXISTS input text;

-- 2. Add missing indexes for high-volume lookup queries
CREATE INDEX IF NOT EXISTS idx_data_user_failed ON public.data (user_id, failed) WHERE failed = false;
CREATE INDEX IF NOT EXISTS idx_users_stripe_id ON public.users (stripe_id);
CREATE INDEX IF NOT EXISTS idx_prices_product_active ON public.prices (product, active);

-- 3. Replace hardcoded webhook trigger with an internal secure database function
DROP TRIGGER IF EXISTS "customer" ON public.users;
```

---

# PHASE 7 — DEVOPS, INFRASTRUCTURE & OPERATIONAL REVIEW

### 1. Environment & Build Architecture
- **Vercel Dependency:** The codebase is tightly coupled to Vercel runtime specifics (`@vercel/functions`, headers `x-vercel-ip-continent`, environment variables `NEXT_PUBLIC_VERCEL_ENV`, `NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL`, `NEXT_PUBLIC_VERCEL_URL`).
- **Local Development Is Fragile:**
  - Running locally requires a Cloudflare Tunnel configured via `pnpm tunnel` and `TUNNEL_URL` set in `.env.local`.
  - If `TUNNEL_URL` is omitted, `lib/utils.ts` (line 82) resolves `domain` to `"undefined"`, breaking webhook registration with Replicate and Stripe redirect URLs.
- **Empty Deployment Configuration:**
  - `vercel.json` is an empty object (`{ }`).
  - Claimed automated daily image purging via Vercel Cron does not exist.

### 2. Observability & Monitoring
- **Logging:** Console logging is minimal and unstructured (`console.log("e", e)`).
- **Error Tracking:** Zero integration with Sentry, Datadog, or Baselime.
- **Health Checks:** No `/api/health` route exists for uptime monitors.

---

# PHASE 8 — FINAL PRODUCTION READINESS REPORT & SCORING

### 1. Executive Summary
Extrapolate has a compelling core concept and modern foundational components (Next.js 14, Supabase, Tailwind, Stripe). However, **it is currently NOT ready for real-world production deployment**. 

The application contains:
1. **A fatal P0 bug in fresh deployments** (the database migration is missing the `input` column, causing all uploads to enter infinite recursive failure).
2. **Critical security vulnerabilities** (unauthenticated Replicate and Supabase customer webhooks allowing SSRF, arbitrary credit increments, and unauthorized Stripe customer deletions).
3. **High-severity client bugs** (realtime WebSocket subscription leaks inside React render bodies).
4. **Substantial configuration drift** (hardcoded staging project IDs, hardcoded personal domains in SQL triggers, and missing cron cleanup jobs).

---

### 2. Forensic Engineering Scorecard

| Domain | Score | Justification |
| :--- | :---: | :--- |
| **System Architecture** | **52 / 100** | Good choice of modular managed services, but crippled by schema/action divergence, missing columns, and uncontrolled edge callbacks. |
| **Enterprise UI/UX** | **64 / 100** | Attractive typography and transitions; degraded by external template links in dialogs, dead avatar APIs, and poor loading/empty states. |
| **Defensive Security** | **34 / 100** | Absence of webhook signature validation, SSRF via unvalidated fetch, unauthenticated customer deletion, and incomplete account data purging. |
| **Performance & Scalability**| **58 / 100** | Edge runtime used where appropriate, but severely undermined by Realtime channel leaks on every client re-render and misconfigured image optimization. |
| **Code Quality** | **56 / 100** | TypeScript types present, but marred by silent error drops (`new Response` without `return`), dead dependencies, and orphaned template code. |
| **Database Architecture** | **48 / 100** | Missing columns, missing indexes, hardcoded external URLs in PostgreSQL triggers, and missing storage bucket declarations. |
| **DevOps & Observability** | **38 / 100** | Broken local dev without tunnel, zero structured logging, no error monitoring (Sentry), and phantom cron configurations. |
| **Overall Production Readiness**| **46 / 100** | **LEVEL 2 — Functional Prototype with Major Engineering Blockers.** Must not be deployed to paying users without remediation. |

---

# PRIORITIZED ENGINEERING IMPROVEMENTS (P0–P3)

### TOP PRIORITY (P0) — Critical Blockers & Security Vulnerabilities
1. **Fix Missing `input` Column & Prevent Recursion Crash:**
   - Execute `ALTER TABLE public.data ADD COLUMN input text;`.
   - In `app/actions/upload.ts` (lines 101–106), remove recursive retry in `setRandomKey` and fail gracefully after 3 distinct attempts with dedicated error logging.
2. **Authenticate Replicate Webhook & Block SSRF:**
   - Validate Replicate HMAC signature on `/api/webhooks/replicate/[id]`.
   - Restrict `fetch(output)` strictly to `https://replicate.delivery/` hostnames.
   - Return actual HTTP error responses when storage or database updates fail (add `return`).
3. **Secure Supabase Customer Webhook:**
   - Protect `/api/webhooks/supabase/customer` with a shared secret header (`x-supabase-webhook-secret`).
   - Remove the hardcoded `https://extrapolate-new.vercel.app` trigger from `supabase/schema.sql`.
4. **Fix Realtime Channel Leak in Photo Page:**
   - Move `supabase.channel(id)` and `.subscribe()` inside `useEffect` in `app/p/[id]/photo-page.tsx` (lines 20–39) with proper cleanup on unmount.

### HIGH PRIORITY (P1) — Major Functional & UX Deficiencies
1. **Fix Next.js Image Optimization Configuration:**
   - Strip `https://` protocol from `NEXT_PUBLIC_SUPABASE_URL` in `next.config.mjs` (line 7).
2. **Clean Account Deletion Flow:**
   - In `app/actions/deleteAccount.ts` (lines 36–66), list all files in user storage before invoking `.remove()`, fix variable typo `if (error)` to `if (deleteError)`, and delete customer records on Stripe.
3. **Replace Broken Template References:**
   - Remove `https://precedent.dev` links from all modal dialogs.
   - Replace dead `avatars.dicebear.com` URL with local fallback or updated Dicebear API.
   - Create missing `/auth/auth-code-error` route.

### MEDIUM PRIORITY (P2) — Performance & Debt Reduction
1. **Prune Dead Dependencies & Clean Package Manifest:**
   - Uninstall `@upstash/ratelimit`, `@upstash/redis`, `plaiceholder`, `sharp`, `date-fns`, `react-markdown`.
   - Delete orphaned components in `components/shared/` and `components/Banner.tsx`.
2. **Implement Actual Storage Purge Cron Job:**
   - Create route handler `app/api/cron/cleanup/route.ts` protected by `Bearer ${CRON_SECRET}`.
   - Add cron entry to `vercel.json` to purge input/output images older than 24h as promised in FAQ.
3. **Add Database Indexes:**
   - Index `data(user_id, failed)` and `users(stripe_id)`.

### LOW PRIORITY (P3) — Nice-to-Have Enhancements
1. Add Sentry error tracking and OpenTelemetry tracing.
2. Complete and validate the Age Prediction feature or purge the unused code completely.

---

# REALISTIC IMPLEMENTATION ROADMAP (PHASES 1–6)

```text
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Phase 1: P0     │     │ Phase 2: Core   │     │ Phase 3: UX &   │
│ Security & DB   ├────►│ Stability       ├────►│ Template Polish │
│ (Effort: 2 days)│     │ (Effort: 3 days)│     │ (Effort: 2 days)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                         │
┌─────────────────┐     ┌─────────────────┐              │
│ Phase 6: Scale  │     │ Phase 5: DevOps │     ┌────────▼────────┐
│ & Monolith Prep │◄────┤ & Observability │◄────┤ Phase 4: Data   │
│ (Effort: 4 days)│     │ (Effort: 3 days)│     │ Lifecycle / Cron│
└─────────────────┘     └─────────────────┘     │ (Effort: 2 days)│
                                                └─────────────────┘
```

- **Phase 1 — Critical Fixes (Day 1–2):** Add database migration for `input` column; remove recursive crash loop in `upload.ts`; add HMAC signature verification and SSRF domain checks to Replicate webhook; secure customer webhook.
- **Phase 2 — Core Stability (Day 3–5):** Move Supabase Realtime listeners into React `useEffect`; fix `next.config.mjs` image hostnames; resolve `deleteAccount.ts` storage deletion bugs; eliminate `get_products_dev` environment discrepancy.
- **Phase 3 — UX & Template Polish (Day 6–7):** Replace external template links; repair Dicebear avatar fallback; build `/auth/auth-code-error` page; add real progress feedback for AI generation.
- **Phase 4 — Data Lifecycle & Scheduled Tasks (Day 8–9):** Implement `app/api/cron/cleanup/route.ts` with Vercel Cron to enforce 24-hour image retention as stated in privacy commitments.
- **Phase 5 — DevOps & Observability (Day 10–12):** Add Sentry error reporting; add structured logging utility; implement `/api/health` monitoring endpoint.
- **Phase 6 — Scale & Maintenance (Day 13–16):** Prune unused packages; add Playwright end-to-end smoke test suite; add Upstash rate limiting to upload action to prevent wallet-draining abuse.

---

# PROJECT KNOWLEDGE MODEL

```text
EXTRAPOLATE (Full-Stack AI Micro-SaaS)
├── Purpose: Generate facial aging sequence GIFs from user-submitted portraits
├── Users: Consumers, social media users, viral referral visitors
├── Core Workflows:
│   ├── Auth: Google OAuth → Supabase Auth → /api/auth/callback → Dub Lead Tracking
│   ├── Billing: Stripe Checkout → Webhook sync (products/prices) → Credit deduction (10 credits/run)
│   ├── Job Run: Upload photo → Supabase Storage ('input') → Replicate API → Webhook callback → Supabase Storage ('output') → Realtime push → Client Display
│   └── Account: Purge user data & storage assets via Server Action
├── Critical Integrations:
│   ├── Supabase (Auth, Postgres, Realtime, S3 Storage)
│   ├── Replicate (SAM aging diffusion model yuval-alaluf/sam)
│   ├── Stripe (Checkout & Customer Portal)
│   └── Dub.co (Referrals & conversion tracking)
└── Major Operational Risks:
    ├── Unauthenticated webhooks (SSRF & Credit Injection)
    ├── Missing schema column causing recursive stack overflow on clean setup
    ├── Realtime WebSocket memory leaks on client
    └── Unfulfilled privacy promise (images never auto-deleted)
```

---

# WHAT I NOW UNDERSTAND ABOUT THIS PROJECT

### 1. What this project really is
A single-purpose consumer AI micro-SaaS application built on Next.js 14 App Router, Supabase, Stripe, and Replicate that transforms human headshots into progressive aging GIFs.

### 2. What problem it solves
It satisfies consumer curiosity and viral entertainment needs by simulating how an individual will age over decades without requiring manual image editing or complex generative AI prompting.

### 3. Who uses it
Individual end-users seeking personal entertainment or social media sharing content, authenticated via Google accounts.

### 4. How it works end-to-end
The user logs in via Google OAuth, purchases credits via Stripe Checkout, and uploads a photo. A Server Action uploads the image to Supabase Storage and triggers a prediction on Replicate. The client redirects to a results page and subscribes to Supabase Realtime. When Replicate completes inference, it calls an edge webhook route which transfers the output GIF to Supabase Storage and updates the database row. The database update fires a Realtime event to the client browser, which displays the aging GIF in an interactive carousel and enables download.

### 5. What is genuinely implemented
- Google OAuth flow via Supabase SSR.
- Stripe Checkout session creation, customer portal integration, and webhook synchronization for products/prices.
- File upload handling and dispatching predictions to Replicate.
- Interactive photo booth carousel displaying before/after transitions.
- Gallery listing user-generated photos.

### 6. What is incomplete
- The database schema (missing `input` column in migration).
- The development/preview environment (calls non-existent `get_products_dev` RPC and references non-existent `stripe_id_dev` column).
- Account deletion (fails to delete storage objects because directory paths are passed instead of file keys).
- The error routing (redirects to a non-existent `/auth/auth-code-error` page).

### 7. What is merely scaffolding
- Vercel Cron jobs: Claimed in PR documentation, but `vercel.json` is completely empty and no route handler exists.
- Age Prediction feature: Scaffolded in `uploadAgePredict.ts` and `age-predict-modal.tsx`, but commented out in the UI, containing un-awaited asynchronous calls and hardcoded development URLs.

### 8. What is mocked or simulated
- Total photo counter on the homepage: Artificially inflated by hardcoding `370986 + count`.
- `Banner.tsx`: Hardcoded promo banner with static discount codes, completely unmounted.

### 9. What appears abandoned or unused
- Dead dependencies: `@upstash/ratelimit`, `@upstash/redis`, `plaiceholder`, `react-markdown`, `date-fns`.
- Dead template files: `components/shared/counting-numbers.tsx`, `leaflet.tsx`, `modal.tsx`, `popover.tsx`, `switch.tsx`, `tooltip.tsx`.

### 10. What the most important architectural insight is
The project was originally an open-source Next.js 13 template by Steven Tey using Cloudflare R2 and Workers with Upstash KV. It was subsequently refactored to use Supabase and Stripe. During this migration, code was written against a live Supabase development database that acquired columns (`input`), functions (`get_products_dev`), and triggers that were **never cleanly backported to the repository's migration files**. As a result, the code in git cannot run cleanly against a fresh database initialized with the repository's own SQL scripts.

### 11. What the most important technical risks are
1. **Unauthenticated Replicate Webhook:** Permitting arbitrary external POST requests that allow server-side request forgery (SSRF) and unlimited credit minting.
2. **Fatal Upload Recursion:** Fresh database instances lack the `input` column, causing `setRandomKey` to infinitely recurse and crash the Node process.
3. **Client Realtime Connection Exhaustion:** Instantiating Supabase Realtime channels directly in the React render function body.
4. **Legal / Privacy Exposure:** Promising users that data is deleted after 1 day or upon account deletion, while the cron job is completely missing and the deletion action fails to purge storage buckets.

### 12. What would be required to make it production-grade
Synchronize the database migration script with application code; secure all webhooks with cryptographic signature verification; wrap Realtime subscriptions in React lifecycle hooks; implement the missing 24-hour image retention cleanup cron; remove all abandoned starter kit assets and dead dependencies; and integrate standard production observability (Sentry and health check endpoints).
