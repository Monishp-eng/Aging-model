# Age Transition (Extrapolate)

An AI-powered micro-SaaS application that generates progressive facial aging GIFs from a single user-uploaded headshot.

Built with **Next.js 14 (App Router)**, **Supabase**, **Replicate AI**, and **Stripe**.

---

## ✨ Features

- **Decades Age Progression**: Transforms any portrait photo into an animated sequence showing aging across decades.
- **Interactive Photo Booth**: Compare your original headshot with the AI-generated progression GIF using an interactive before/after carousel.
- **Realtime Updates**: Instant WebSocket notifications via Supabase Realtime when your generation completes.
- **Personal Gallery**: View and download all your past generated aging GIFs.
- **Cryptographically Verified Webhooks**: Svix HMAC-SHA256 signature verification with replay window protection for Replicate callbacks.
- **Credit & Billing System**: Stripe Checkout integration with automated webhooks and an append-only credit ledger.
- **Strict Privacy Lifecycle**: Automated 24-hour asset cleanup policy with secure private signed URLs.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Framework** | [Next.js 14](https://nextjs.org/) (App Router, Server Actions) |
| **Language** | [TypeScript](https://www.typescriptlang.org/) |
| **UI & Styling** | [Tailwind CSS](https://tailwindcss.com/), [Radix UI Primitives](https://www.radix-ui.com/), [Framer Motion](https://www.framer.com/motion/) |
| **Database & Auth** | [Supabase](https://supabase.com/) (PostgreSQL, Row Level Security, Auth SSR) |
| **Object Storage** | Supabase Storage (`input`, `output`, `temp` buckets) |
| **AI Inference** | [Replicate](https://replicate.com/) (`yuval-alaluf/sam` style-based age progression) |
| **Payments** | [Stripe](https://stripe.com/) Checkout & Customer Portal |
| **Testing** | [Vitest](https://vitest.dev/) & [Playwright](https://playwright.dev/) |

---

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project
- A [Replicate](https://replicate.com) API token
- A [Stripe](https://stripe.com) account (for billing)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/P-Sakthi-Sabareesh/Age_Transition.git
   cd Age_Transition
   ```

2. **Install dependencies:**
   ```bash
   npm install
   # or
   pnpm install
   ```

3. **Configure environment variables:**
   Copy `.env.example` to `.env.local` and fill in the required keys:
   ```bash
   cp .env.example .env.local
   ```

4. **Initialize database schema & run migrations:**
   ```bash
   npm run db:migrate
   ```

5. **Start the development server:**
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 🧪 Testing & Verification

Run the comprehensive unit test suite:
```bash
npm test
```

Run end-to-end browser tests:
```bash
npm run test:e2e
```

Run the production readiness check script:
```bash
npm run production:check
```

---

## 🔒 Security Highlights

- **Replicate Webhook Verification**: Header validation (`webhook-id`, `webhook-timestamp`, `webhook-signature`), constant-time signature matching, and anti-replay window checks.
- **SSRF Mitigation**: Strict host validation ensures Replicate artifacts only download from trusted `replicate.delivery` domains.
- **Metadata Stripping**: Uploaded images are re-encoded and stripped of GPS/EXIF metadata before cloud storage.
- **Idempotency Safeguards**: Deduplication hashes prevent double credit spending from rapid repeated submissions.

---

## 📄 License

MIT License. See [LICENSE.md](LICENSE.md) for details.
