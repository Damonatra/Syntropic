# Syntropic Backbone

A 1-of-1 back-office operating system for industrial supply operations —
intake → parse → human-in-the-loop review → ledger → recovery guarantee,
wrapped in a multi-tenant customer portal (the *enclave*).

Built on the **Steep** editorial design system: ink-on-paper surfaces,
tabular numerals, hairline rules, dot-matrix telemetry. Every dollar shown
in the UI is computed server-side (R-01 integrity rule) — the client only
typesets.

## Stack

| Layer      | Choice                              |
| ---------- | ----------------------------------- |
| Framework  | Next.js (App Router) + TypeScript   |
| Styling    | Tailwind CSS                        |
| Data       | Prisma ORM → SQLite (`db/`)         |
| Runtime    | Bun                                 |
| Webhooks   | Stripe, Telegram (HITL relay)       |

## Getting started

```bash
bun install
bun run db:generate          # prisma generate
bun run db:push              # create / migrate the SQLite database
bun scripts/seed.ts          # seed demo tenants + ledger
bun run dev                  # http://localhost:3000
```

### Environment

Secrets are **not** committed. Provide a local `.env` (never push it):

| Variable                  | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `DATABASE_URL`            | SQLite file URL for Prisma                     |
| `AUTH_SECRET`             | Session signing secret                         |
| `PORTAL_AUTH_SECRET`      | Enclave session cookie HMAC secret             |
| `ENGINE_WEBHOOK_KEY`      | Shared key for intake/engine webhooks          |
| `IP_HASH_SALT_BASE`       | Salt base for privacy-preserving IP hashing    |
| `IP_HASH_SALT_ROTATE_DAYS`| Salt rotation window (days)                    |
| `PUBLIC_BASE_URL`         | Externally reachable base URL                  |
| `DATA_DIR`                | Tenant document storage root                   |
| `GEO_PROVIDER` / `GEO_FALLBACK_*` | Geo-IP resolution posture              |
| `IP_PRIVACY_MODE`         | IP privacy mode                                |
| `OPERATOR_*`              | Operator auth flags / allow-list emails        |

## Repository layout

```
src/app/          App Router: /backbone ops console, /portal enclave, /api routes
src/components/   Backbone + enclave UI (Steep design system)
src/lib/          Auth, ledger math, HITL bus, ingest, telemetry
prisma/           Schema + migrations (SQLite)
scripts/          Seed, backfills, probes, AAR generation
data/tenants/     Demo tenant documents (fictional)
download/         Delivered artifacts: reports, screenshots
```

## Notes

- All tenant data in the repo and database is **fictional demo data**
  (Apex Piping & Supply, Midwest Trade Wholesale).
- The workspace is a sandbox: `OPERATOR_AUTH=0` disables operator auth
  gates. Do not deploy as-is with production secrets.
