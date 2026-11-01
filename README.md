# Syntropic

**Autonomous lead generation, quote intelligence, and margin defense engine for US & Canada industrial distribution ($10M–$150M revenue)** across PVF, Electrical, HVAC, and Fluid Power.

---

## Architecture

The system consists of two primary operational pillars:

1. **Syntropic UI & Executive Command Enclave (`src/app`, `components/`)**:
   - Next.js 16 (Turbopack) & React 19 audit workstation.
   - Soft-tactile monochromatic defense neumorphic UI (see `DESIGN.md`).
   - Operator gateway with scrypt timing-safe authentication (`/gate`).
   - Real-time command center, threat matrix radar, and append-only audit trail.

2. **Vertebra Intelligence Engine (`vertebra/`)**:
   - Python 3.12 / FastAPI autonomous B2B lead engine.
   - Modules 1–4: Directory ingestion, revenue corridor gating, deterministic email permutations, RFC 8058 CASL compliance kit, Claude 3.5 Sonnet QLV scoring, and omnichannel dispatch.
   - Modules 5–9: ERP profiler, headless Playwright RFQ audit snapshots, haversine DBSCAN spatial clustering, HMAC intent telemetry tracker, and LangGraph reply agent.
   - Core pipeline extensions: Unit-of-Measure (UoM) canonicalizer, Qdrant Hybrid Reciprocal Rank Fusion (RRF), AST query isolation veto gate, cryptographic append-only event stream (`stream.log`), and Microsoft Graph API draft injector.

---

## Quick Start

### 1. Frontend & Operator Console
```bash
# Install dependencies
bun install

# Run test suite (166 tests)
bun test

# Build production bundle
bun run build

# Start server (default: port 3000)
bun run start
```

### 2. Vertebra Backend Engine
```bash
# Install dependencies in editable mode
pip install -e "./vertebra[dev]"

# Verify engine integrity & tactical modules
python3 scripts/verify_vertebra.py
python3 scripts/verify_modules_5_9.py
python3 scripts/verify_core_pipeline.py

# Run API server
uvicorn vertebra.api.main:create_app --factory --host 0.0.0.0 --port 8000
```

### 3. Docker Orchestration
```bash
# Start full stack: Next.js console + Vertebra engine + Qdrant vector database
docker compose up -d
```

---

## Architectural Evolution

For the planned monorepo evolution into `apps/`, `packages/`, and the upcoming 8-agent **Hermes Fleet**, see [`ARCH_BLUEPRINT.md`](./ARCH_BLUEPRINT.md).
