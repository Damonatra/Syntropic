"""FastAPI routes: system health + the ingest/score/dispatch pipeline."""

from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from vertebra.logging_conf import get_logger

log = get_logger("api.routes")

system_router = APIRouter(tags=["system"])
pipeline_router = APIRouter(prefix="/pipeline", tags=["pipeline"])


# --------------------------------------------------------------------------- #
# System
# --------------------------------------------------------------------------- #


@system_router.get("/health")
async def health(request: Request) -> dict[str, Any]:
    """Liveness + database readiness probe."""
    db = request.app.state.db
    database_ok = False
    try:
        await db.execute("SELECT 1")
        database_ok = True
    except Exception as exc:  # noqa: BLE001 - health must degrade, not throw
        log.warning("health_db_check_failed", error=str(exc))
    return {
        "status": "ok" if database_ok else "degraded",
        "service": "vertebra",
        "database": database_ok,
        "scheduler": request.app.state.scheduler_status() if hasattr(request.app.state, "scheduler_status") else None,
    }


# --------------------------------------------------------------------------- #
# Pipeline request models
# --------------------------------------------------------------------------- #


class IngestRequest(BaseModel):
    source_ids: list[str] | None = Field(default=None, description="Subset of registered sources")
    limit: int = Field(default=25, ge=1, le=200)


class ScoreRequest(BaseModel):
    prospect_id: str = Field(min_length=8)


class ManualProspectRequest(BaseModel):
    """Ingest a single company by hand (advisor-supplied, no directory)."""

    name: str = Field(min_length=2, max_length=200)
    domain: str
    vertical: Literal["pvf", "electrical", "hvac", "fluid_power"]
    region: Literal["us", "ca"]
    city: str | None = None
    state_province: str | None = None
    employee_count: int | None = Field(default=None, ge=1)
    revenue_estimate_usd: int | None = Field(default=None, ge=0)
    detected_erp: str | None = None
    notes: str | None = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------- #
# Pipeline endpoints
# --------------------------------------------------------------------------- #


@pipeline_router.post("/ingest")
async def run_ingestion(request: Request, body: IngestRequest) -> dict[str, Any]:
    """Run a bounded directory ingestion batch and persist accepted records."""
    jobs = request.app.state.jobs
    try:
        await jobs.ingestion()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"ingestion failed: {exc}") from exc
    return {"status": "completed", "batch_size": jobs._batch}


@pipeline_router.post("/prospects")
async def add_manual_prospect(request: Request, body: ManualProspectRequest) -> dict[str, Any]:
    """Persist a hand-supplied prospect directly into the pending queue."""
    db = request.app.state.db
    row = await db.fetchrow(
        """
        INSERT INTO prospects (source, source_url, name, domain, vertical, region,
                               city, state_province, country, employee_count,
                               revenue_estimate_usd, revenue_confidence, detected_erp,
                               raw_excerpt, ingestion)
        VALUES ('manual', 'console://manual-entry', $1, $2, $3, $4, $5, $6,
                CASE WHEN $4 = 'ca' THEN 'Canada' ELSE 'United States' END,
                $7, $8, 'estimated', $9, $10, 'pending')
        ON CONFLICT (source, lower(coalesce(domain, name)))
        DO UPDATE SET updated_at = now()
        RETURNING id
        """,
        body.name, body.domain.lower(), body.vertical, body.region,
        body.city, body.state_province, body.employee_count,
        body.revenue_estimate_usd, body.detected_erp, body.notes,
    )
    if row is None:
        raise HTTPException(status_code=500, detail="insert returned no row")
    return {"prospect_id": str(row["id"]), "status": "pending"}


@pipeline_router.post("/score")
async def score_prospect(request: Request, body: ScoreRequest) -> dict[str, Any]:
    """Score one prospect immediately (Claude primary / rubric fallback)."""
    db = request.app.state.db
    row = await db.fetchrow(
        """
        SELECT id, name, domain, vertical, region, city, state_province, country,
               employee_count, revenue_estimate_usd, detected_erp, raw_excerpt, casl_scope
          FROM prospects WHERE id = $1
        """,
        body.prospect_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail="prospect not found")

    scorer = request.app.state.scorer
    from vertebra.ai.scorer import ScoringInput

    lowered = (row["raw_excerpt"] or "").lower()
    portal_hint = next(
        (h for h in ("customer portal", "b2b portal", "ordering portal", "rfq portal") if h in lowered),
        None,
    )
    payload = ScoringInput(
        prospect_id=str(row["id"]),
        company_name=row["name"],
        vertical=row["vertical"],
        region=row["region"],
        revenue_estimate_usd=row["revenue_estimate_usd"],
        employee_count=row["employee_count"],
        detected_erp=row["detected_erp"],
        legacy_portal=portal_hint,
        notes=row["raw_excerpt"],
    )
    result = await scorer.score(payload)
    async with db.pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO scores (prospect_id, qlv_score, band, factors, hooks,
                                    rationale, model, input_fingerprint)
                VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)
                ON CONFLICT (input_fingerprint) DO UPDATE SET scored_at = now()
                """,
                row["id"], result.qlv_score, result.band,
                json.dumps([f.model_dump() for f in result.factors], default=str),
                json.dumps([h.model_dump() for h in result.hooks], default=str),
                result.rationale, result.model, result.input_fingerprint,
            )
            await request.app.state.outbox.enqueue(
                conn, aggregate_type="score", aggregate_id=str(row["id"]),
                event_type="prospect.scored",
                payload={"qlv_score": result.qlv_score, "band": result.band},
            )
    return result.model_dump(mode="json")


@pipeline_router.post("/dispatch/{prospect_id}")
async def dispatch_prospect(request: Request, prospect_id: str) -> dict[str, Any]:
    """Route and execute dispatch for one scored prospect."""
    router = request.app.state.dispatch_router
    prospect = await request.app.state.load_prospect(prospect_id)
    if prospect is None:
        raise HTTPException(status_code=404, detail="prospect not found")
    if prospect.score is None:
        raise HTTPException(status_code=409, detail="prospect must be scored before dispatch")
    decision = await router.execute(prospect)
    return decision.model_dump(mode="json")


@pipeline_router.get("/high-touch/export")
async def export_high_touch(request: Request) -> dict[str, Any]:
    """Export the pending Josias queue to CSV and mark rows exported."""
    exporter = request.app.state.high_touch
    path = await exporter.export_pending_csv()
    return {"status": "exported", "path": str(path)}


@pipeline_router.get("/stats")
async def pipeline_stats(request: Request) -> dict[str, Any]:
    """Live pipeline counters for the console dashboards."""
    db = request.app.state.db
    prospect_counts = await db.fetch(
        "SELECT ingestion, count(*) AS n FROM prospects GROUP BY ingestion"
    )
    dispatch_counts = await db.fetch(
        "SELECT channel, status, count(*) AS n FROM dispatches GROUP BY channel, status"
    )
    score_agg = await db.fetchrow(
        "SELECT count(*) AS scored, round(avg(qlv_score)::numeric, 1) AS avg_qlv FROM scores"
    )
    outbox_pending = await db.fetchrow(
        "SELECT count(*) AS n FROM outbox WHERE published_at IS NULL"
    )
    high_touch_pending = await db.fetchrow(
        "SELECT count(*) AS n FROM high_touch_queue WHERE exported_at IS NULL"
    )
    return {
        "prospects": {r["ingestion"]: r["n"] for r in prospect_counts},
        "dispatches": [
            {"channel": r["channel"], "status": r["status"], "count": r["n"]}
            for r in dispatch_counts
        ],
        "scoring": {
            "scored": score_agg["scored"] if score_agg else 0,
            "avg_qlv": float(score_agg["avg_qlv"]) if score_agg and score_agg["avg_qlv"] else None,
        },
        "outbox_pending": outbox_pending["n"] if outbox_pending else 0,
        "high_touch_pending": high_touch_pending["n"] if high_touch_pending else 0,
    }


@pipeline_router.get("/outbox")
async def list_outbox(
    request: Request,
    limit: int = Query(default=50, ge=1, le=500),
) -> dict[str, Any]:
    rows = await request.app.state.db.fetch(
        """
        SELECT id, aggregate_type, aggregate_id, event_type, payload, attempts,
               created_at, published_at
          FROM outbox ORDER BY created_at DESC LIMIT $1
        """,
        limit,
    )
    return {
        "events": [
            {
                "id": str(r["id"]),
                "aggregate_type": r["aggregate_type"],
                "aggregate_id": r["aggregate_id"],
                "event_type": r["event_type"],
                "payload": r["payload"] if isinstance(r["payload"], dict) else json.loads(r["payload"]),
                "attempts": r["attempts"],
                "created_at": r["created_at"].isoformat(),
                "published_at": r["published_at"].isoformat() if r["published_at"] else None,
            }
            for r in rows
        ]
    }


# --------------------------------------------------------------------------- #
# Advanced tactical modules (5-9) — operational endpoints
# --------------------------------------------------------------------------- #

tactical_router = APIRouter(prefix="/tactical", tags=["tactical"])


@tactical_router.post("/erp-profile/{prospect_id}")
async def profile_prospect_erp(request: Request, prospect_id: str) -> dict[str, Any]:
    """Module 5 — classify one prospect's ERP stack and persist erp_metadata."""
    profiler = request.app.state.erp_profiler
    try:
        metadata = await profiler.profile_prospect(prospect_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"erp profiling failed: {exc}") from exc
    if metadata is None:
        raise HTTPException(status_code=422, detail="prospect has no domain to profile")
    return metadata.model_dump(mode="json")


@tactical_router.post("/erp-profile")
async def profile_erp_batch(request: Request, body: IngestRequest) -> dict[str, Any]:
    """Module 5 — batch-profile every prospect missing erp_metadata."""
    profiler = request.app.state.erp_profiler
    results = await profiler.profile_unprofiled(limit=body.limit)
    return {"requested": len(results), "profiled": sum(1 for r in results if r is not None)}


@tactical_router.post("/audit-preview/{prospect_id}")
async def generate_audit_preview(request: Request, prospect_id: str) -> dict[str, Any]:
    """Module 6 — capture, overlay the leakage widget and publish the asset."""
    generator = request.app.state.audit_preview
    try:
        preview = await generator.generate(prospect_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"audit preview failed: {exc}") from exc
    return preview.model_dump(mode="json")


@tactical_router.post("/audit-preview")
async def generate_audit_batch(request: Request, body: IngestRequest) -> dict[str, Any]:
    """Module 6 — batch-generate previews for top unscreenshotted prospects."""
    generator = request.app.state.audit_preview
    done = await generator.generate_batch(limit=body.limit)
    return {"generated": len(done), "prospect_ids": done}


class ClusterRequest(BaseModel):
    eps_meters: int | None = Field(default=None, ge=1_000, le=1_000_000)
    min_points: int | None = Field(default=None, ge=1, le=50)


@tactical_router.post("/spatial/cluster")
async def run_spatial_clustering(request: Request, body: ClusterRequest) -> dict[str, Any]:
    """Module 7 — DBSCAN the geocoded base and refresh tactical clusters."""
    clusterer = request.app.state.spatial
    clusters = await clusterer.cluster_prospects(
        eps_meters=body.eps_meters, min_points=body.min_points
    )
    return {"clusters": [c.model_dump() for c in clusters]}


class RegionalHookRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    meeting_id: str | None = None
    prospect_id: str | None = None
    contact_first_name: str | None = None
    company_name: str | None = None
    vertical: Literal["pvf", "electrical", "hvac", "fluid_power"] | None = None


@tactical_router.post("/spatial/regional-hook")
async def build_regional_hook(request: Request, body: RegionalHookRequest) -> dict[str, Any]:
    """Module 7 — localized hook when a meeting lands inside a cluster."""
    from vertebra.models.domain import MeetingContext

    clusterer = request.app.state.spatial
    meeting = MeetingContext(**body.model_dump())
    hook = await clusterer.regional_hook_for_meeting(meeting)
    return hook.model_dump() if hook else {"hook": None, "reason": "outside known clusters"}


class InboundEmailRequest(BaseModel):
    """An inbound prospect reply handed over by the mailbox webhook."""

    from_email: str = Field(description="Reply-From address")
    subject: str | None = None
    body: str = Field(min_length=1, max_length=20_000)
    message_id: str | None = None


@tactical_router.post("/inbound-email")
async def receive_inbound_email(request: Request, body: InboundEmailRequest) -> dict[str, Any]:
    """Module 9 — closed loop: register the reply and run the agent on it."""
    agent = request.app.state.reply_agent
    try:
        reply_id = await agent.register_inbound(
            from_email=body.from_email,
            subject=body.subject,
            body=body.body,
            message_id=body.message_id,
        )
        decision = await agent.process_reply(reply_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"reply agent failed: {exc}") from exc
    return {"reply_id": reply_id, "decision": decision.model_dump(mode="json")}


class ProcessRepliesRequest(BaseModel):
    limit: int = Field(default=25, ge=1, le=200)


@tactical_router.post("/replies/process")
async def process_pending_replies(request: Request, body: ProcessRepliesRequest) -> dict[str, Any]:
    """Module 9 — drain every unprocessed inbound reply."""
    agent = request.app.state.reply_agent
    decisions = await agent.process_pending(limit=body.limit)
    return {"processed": len(decisions), "decisions": [d.model_dump(mode="json") for d in decisions]}
