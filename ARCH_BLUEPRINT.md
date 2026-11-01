# SYNTROPIC // TARGET MONOREPO & MULTI-AGENT ARCHITECTURE BLUEPRINT

## 1. Overview & Vision
Syntropic is a defense-grade autonomous B2B lead generation, margin defense, and quote intelligence platform designed for enterprise industrial distributors ($10M–$150M revenue across PVF, Electrical, HVAC, and Fluid Power).

This blueprint outlines the planned monorepo evolution into a unified PNPM/Turbo workspace and details the upcoming **Hermes Fleet** multi-agent orchestration layer.

---

## 2. Target Workspace Structure (`syntropic/`)

```
syntropic/
├── .github/
│   └── workflows/
│       ├── deploy-vercel.yml       # Auto-deploys Next.js portal on push to `main`
│       └── deploy-hetzner.yml      # Auto-deploys Python containers & Qdrant via SSH
│
├── apps/
│   ├── enclave/                    # Executive Portal & Landing Page (Next.js 16 / React 19)
│   │   ├── app/                    # App Router (/portal, /audit, /gate, /api)
│   │   ├── components/             # Soft Neumorphic tactile UI (DESIGN.md)
│   │   │   ├── defense/            # HUD Telemetry, ERP Badges, Geo-IP overlays
│   │   │   └── UI/                 # Neumorphic cards, sliders, monochrome buttons
│   │   ├── public/                 # Assets, logos, SVG icons
│   │   ├── package.json
│   │   └── tailwind.config.js
│   │
│   └── vertebra/                   # Outbound Lead Generation Engine (Python FastAPI)
│       ├── ingestion/              # ThomasNet, Blue Book & IndustryNet scrapers + UoM normalizer
│       ├── enrichment/             # Live SMTP verify & ERP Profiler (P21/Infor/Eclipse)
│       ├── ai/                     # Quote Leakage Scorer (Claude 3.5 Sonnet) & Reply Agent
│       ├── spatial/                # PostGIS / Haversine DBSCAN Proximity Clustering
│       ├── dispatch/               # Secondary Domain Rotator, M365 Draft Injector, GCal Sync
│       ├── main.py                 # FastAPI application entry point
│       └── requirements.txt
│
├── packages/
│   ├── doc-pipeline/               # Core PDF & AST Margin Defense Engine (Python)
│   │   ├── parser/                 # Spatial Docling OCR & bounding-box table extractor
│   │   ├── matcher/                # Qdrant Hybrid RRF dense + lexical vector lookup engine
│   │   ├── ast_gate/               # Zero-Trust AST tenant_id & margin calculation defender
│   │   └── main.py
│   │
│   ├── database/                   # Shared Single Source of Truth
│   │   ├── prisma/
│   │   │   ├── schema.prisma       # Neon PostgreSQL schema definitions
│   │   │   └── migrations/         # Database migration history
│   │   └── package.json
│   │
│   └── hermes-fleet/               # 8-Agent Multi-Agent Orchestration Fleet (Planned)
│       ├── supervisor.py           # LangGraph supervisor node routing enterprise tasks
│       ├── roster.py               # Fleet definition & capabilities contract
│       └── agents/
│           ├── audit_specialist.py # Agent 1: Mike Ross (PDF Spatial Extraction & Scorer)
│           ├── roi_sentinel.py     # Agent 2: Harvey Specter (Executive COO Briefs)
│           ├── provisioning.py     # Agent 3: J.A.R.V.I.S. (Tenant Setup)
│           ├── catalog_matcher.py  # Agent 4: Gaz (Cross-Border Qdrant Matcher)
│           ├── maintenance.py      # Agent 5: Nikolai (System Health & Failover)
│           ├── quality_gate.py     # Agent 6: Red Reddington (AST Veto & CASL Compliance)
│           ├── client_success.py   # Agent 7: Donna Paulsen (Intent Telemetry & Task Router)
│           └── catalog_memory.py   # Agent 8: Captain Price (Append-Only Stream Log)
│
├── docker-compose.yml              # Production container orchestration
├── DESIGN.md                       # Monochromatic defense UI specification
├── .env.example                    # Unified environment template
└── README.md                       # High-level architecture docs
```

---

## 3. The 8-Agent Hermes Fleet (Planned Roadmap)

When activated, Hermes Fleet operates under a LangGraph hierarchical supervisor architecture:

| Agent # | Persona Code | Responsibility & Domain |
|---|---|---|
| **Agent 1** | **Mike Ross** (`audit_specialist.py`) | Spatial extraction from raw quote PDFs, unapplied Special Pricing Agreement (SPA) detection, and initial QLV scoring. |
| **Agent 2** | **Harvey Specter** (`roi_sentinel.py`) | Synthesizes verified evidence into crisp, executive-ready COO briefs and margin defense deliverable PDFs. |
| **Agent 3** | **J.A.R.V.I.S.** (`provisioning.py`) | Automates zero-trust tenant provisioning, database isolation scoping, and API credentials. |
| **Agent 4** | **Gaz** (`catalog_matcher.py`) | Cross-border SKU matching using Qdrant Hybrid Reciprocal Rank Fusion (RRF) dense + BM25 search. |
| **Agent 5** | **Nikolai** (`maintenance.py`) | Health monitors, heartbeat doors, Redis/asyncpg failover, and jittered job claims (`SKIP LOCKED`). |
| **Agent 6** | **Red Reddington** (`quality_gate.py`) | Enforces the AST tenant query veto gate and guarantees Canadian CASL compliance (RFC 8058 one-click headers). |
| **Agent 7** | **Donna Paulsen** (`client_success.py`) | Intent telemetry tracking (`?lid=`), high-heat visitor alerts, and LangGraph objection handling. |
| **Agent 8** | **Captain Price** (`catalog_memory.py`) | Manages the immutable, cryptographic append-only event stream (`stream.log`) with sequential SHA-256 hash chaining. |

---

## 4. Current State & Compatibility Guarantee

To preserve stability, all core components currently run verified and green in the root and `vertebra/` structure:
- **Next.js 16 Portal:** `166 pass, 0 fail` across all unit, authentication, turnaround, and webhook door tests.
- **Vertebra Engine:** `25 checks pass` across core pipeline and tactical modules 5–9.
- **Advanced Capabilities:** UoM canonicalization, Hybrid RRF, AST tenant isolation, and cryptographic event stream are tested and passing (`scripts/verify_core_pipeline.py`).
