# Vertebra

**The Syntropic autonomous lead & intelligence engine** — a 1-of-1 B2B enterprise
lead generation, AI scoring and omnichannel dispatch engine targeting **US &
Canada industrial distributors ($10M–$150M revenue)** across **PVF, Electrical,
HVAC and Fluid Power** for the Q4 enterprise pipeline.

## Architecture

```
directories ──▶ ingestion ──▶ enrichment ──▶ ai.scorer ──▶ dispatch router
 (Blue Book,     scraper +      email perms     Claude 3.5      │
  NFPA, CIPH,    normalizer     + SMTP verify   Sonnet QLV      ├─ Channel A
  HARDI, FPDA)   ($10-150M      + CASL flag     1-100 + hooks   │  rotating domains
                 corridor)                                      │  Resend / SMTP
                                                                └─ Channel B
                                                                   Josias High-Touch
                                                                   CSV + outbox + GCal
                                        Qdrant ◀── firmographic vectors (lookalikes)
                                        Neon PG ◀── state + transactional outbox
```

## Module map

| Module | Responsibility |
|---|---|
| `vertebra/config` | Pydantic v2 settings (env: `VERTEBRA_SECTION__FIELD`, `.env` supported) |
| `vertebra/models` | Domain contracts + typed error hierarchy |
| `vertebra/db` | asyncpg pool for Neon (PgBouncer-safe), schema DDL, transactional outbox |
| `vertebra/ingestion` | robots-aware HTTP fetcher, adapters (JSON-LD / HTML cards / CSV feeds), vertical classification, revenue corridor gate |
| `vertebra/enrichment` | deterministic email permutations, RFC-5322 hygiene, live SMTP RCPT verification with catch-all discrimination, CASL evaluation + RFC 8058 headers |
| `vertebra/ai` | Quote Leakage Vulnerability scorer (Claude 3.5 Sonnet tool-use; deterministic rubric fallback), hook authoring, LangGraph pipeline |
| `vertebra/vector` | Qdrant firmographic kNN (64-dim deterministic embeddings, payload-indexed) |
| `vertebra/dispatch` | Dual-channel router: A = rotating secondary domains via Resend/SMTP with warmup caps; B = Josias high-touch CSV + outbox + Google Calendar follow-ups |
| `vertebra/enrichment/erp_profiler` | **Module 5** — ERP & competitor tech-stack profiler: domain crawl + HTTP headers + TLS metadata + Greenhouse/Lever/Ashby job-board scans → `erp_metadata` JSONB, quote-portal classification, ERP-specific pitch angle |
| `vertebra/intelligence` | **Module 6** — audit preview generator: Playwright 2× screenshot of the RFQ page, achromatic leakage-widget overlay, S3/R2-or-local asset storage, public `audit_image_url` |
| `vertebra/spatial` | **Module 7** — spatial clustering: deterministic haversine DBSCAN + PostGIS `ST_DWithin` proximity, seed tactical clusters (Gulf Coast, Chicago, Toronto, DFW, Great Lakes, Atlanta, SoCal), localized meeting hooks |
| `vertebra/telemetry` | **Module 8** — intent monitor: HMAC-signed `?lid=` tracking tokens, Vercel geo headers, rolling 14-day intent heat, 🚨 high-intent Telegram/Slack/webhook pager with cooldown |
| `vertebra/ai/reply_agent` | **Module 9** — closed-loop follow-up: LangGraph + Claude 3.5 Sonnet intent classification (interested / OOO / info / not-interested / price / ERP objections), urgent calendar booking, human-review drafts, OOO rescheduling, sequence suppression |
| `vertebra/workers` | asyncio scheduler (jittered intervals, per-job isolation, SKIP LOCKED claims); core pipeline jobs + autonomous tactical jobs (`tactical_jobs.py`: ERP profiling 15m, audit previews 30m, spatial clustering 6h, reply processing 2m — each independently toggleable via `TacticalJobsSettings`) |
| `vertebra/api` | FastAPI app factory + pipeline/system/tactical/telemetry routes |

## Scoring — Quote Leakage Vulnerability (1–100)

Weighted factors (single source of truth in `vertebra/ai/scorer.py`):

| Factor | Weight |
|---|---|
| `rfq_latency` | 0.28 |
| `legacy_portal` | 0.22 |
| `unapplied_spa` | 0.18 |
| `manual_quoting_share` | 0.14 |
| `vertical_fit` | 0.10 |
| `size_fit` | 0.08 |

Bands: `<40 low`, `40–64 medium`, `65–84 high`, `85+ critical`.
Routing policy: **QLV ≥ 70 → Channel A** (automated), **< 70 → Channel B** (high-touch).
Claude outages degrade to the transparent rubric scorer — the pipeline never stalls.

## CASL compliance (Canada)

Any prospect resolving to a Canadian jurisdiction (`.ca` domain, province,
postal pattern) is CASL-scope: Channel A sends are forced to carry the
identification footer and `List-Unsubscribe` / `List-Unsubscribe-Post:
List-Unsubscribe=One-Click` (RFC 8058) headers, backed by a signed unsubscribe
URL. Sends without the compliance kit raise `CASLViolation` and never leave
the building.

## Quick start

```bash
cd vertebra
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env         # fill every CHANGE_ME value

# Module 6 headless browser (one-time per worker image)
playwright install chromium

# verify engine logic (no external services required)
python ../scripts/verify_vertebra.py
python ../scripts/verify_modules_5_9.py

# run the API + workers
uvicorn vertebra.api.main:create_app --factory --host 0.0.0.0 --port 8000
```

## API surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + Neon readiness |
| POST | `/pipeline/ingest` | bounded directory ingestion run |
| POST | `/pipeline/prospects` | manual advisor-supplied prospect |
| POST | `/pipeline/score` | score one prospect immediately |
| POST | `/pipeline/dispatch/{id}` | route + execute dispatch |
| GET | `/pipeline/high-touch/export` | export Josias CSV queue |
| GET | `/pipeline/stats` | live pipeline counters |
| GET | `/pipeline/outbox` | outbox event log |
| POST | `/tactical/erp-profile/{id}` | **M5** profile one prospect's ERP stack |
| POST | `/tactical/erp-profile` | **M5** batch-profile unprofiled prospects |
| POST | `/tactical/audit-preview/{id}` | **M6** screenshot + widget + CDN upload |
| POST | `/tactical/audit-preview` | **M6** batch-generate previews |
| POST | `/tactical/spatial/cluster` | **M7** refresh tactical clusters |
| POST | `/tactical/spatial/regional-hook` | **M7** localized hook for a meeting coordinate |
| POST | `/telemetry/visit` | **M8** record portal/audit visit (Vercel geo) |
| POST | `/telemetry/event` | **M8** record downloads / pricing views |
| GET | `/telemetry/sessions/{id}` | **M8** session rollup |
| POST | `/tactical/inbound-email` | **M9** register + process an inbound reply |
| POST | `/tactical/replies/process` | **M9** drain unprocessed replies |

## Operational guarantees

- **Zero mock data** — every code path either performs real work or raises.
- **Transactional outbox** — state changes and audit events commit atomically;
  relay publishes with attempt tracking on `outbox` rows.
- **Idempotency** — unique source dedupe index on prospects, unique
  `input_fingerprint` on scores, `FOR UPDATE SKIP LOCKED` job claims.
- **Graceful degradation** — Claude → rubric; Resend → SMTP; calendar outage →
  queueing continues; robots/parse failures logged per source.
