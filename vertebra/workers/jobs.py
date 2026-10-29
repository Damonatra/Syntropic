"""Concrete pipeline jobs: ingest → enrich → score → dispatch → relay.

Each job is idempotent and claim-based: rows are claimed with ``FOR UPDATE
SKIP LOCKED`` so multiple worker processes can share the Neon database
safely. Outbox events are written inside the same transactions as the state
changes they describe.
"""

from __future__ import annotations

from datetime import UTC
from typing import Any

from vertebra.ai.scorer import QuoteLeakageScorer, ScoringInput
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.dispatch.router import DispatchRouter
from vertebra.ingestion.scraper import DirectoryScraper
from vertebra.logging_conf import get_logger
from vertebra.models.domain import IngestionStatus

log = get_logger("workers.jobs")

# Claims use SKIP LOCKED so concurrent workers never double-process.
_CLAIM_PENDING_SQL = """
UPDATE prospects
   SET ingestion = $2, updated_at = now()
 WHERE id IN (
       SELECT id FROM prospects
        WHERE ingestion = $1
        ORDER BY created_at
        LIMIT $3
        FOR UPDATE SKIP LOCKED)
RETURNING id, name, domain, vertical, region, city, state_province, country,
          postal_code, employee_count, revenue_estimate_usd, revenue_confidence,
          detected_erp, raw_excerpt, source, source_url, scraped_at, casl_scope
"""

_UPSERT_PROSPECT_SQL = """
INSERT INTO prospects (source, source_url, name, domain, website, vertical, region,
                       city, state_province, country, postal_code, employee_count,
                       revenue_estimate_usd, revenue_confidence, detected_erp,
                       raw_excerpt, ingestion, filter_reason)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
ON CONFLICT (source, lower(coalesce(domain, name)))
DO UPDATE SET revenue_estimate_usd = EXCLUDED.revenue_estimate_usd,
              employee_count       = EXCLUDED.employee_count,
              detected_erp         = EXCLUDED.detected_erp,
              raw_excerpt          = EXCLUDED.raw_excerpt,
              updated_at           = now()
RETURNING id
"""


class PipelineJobs:
    """Bundle of the engine's recurring jobs, bound to shared components."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        router: DispatchRouter,
        *,
        scrape_limit: int = 40,
        batch_size: int = 25,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._router = router
        self._scrape_limit = scrape_limit
        self._batch = batch_size
        self._scorer = QuoteLeakageScorer()

    # ---------------------------------------------------------------- ingest
    async def ingestion(self) -> None:
        """Crawl target directories and persist corridor-qualified records."""
        scraper = DirectoryScraper()
        accepted = 0
        async for record, _outcome in scraper.scrape():
            row = await self._db.fetchrow(
                _UPSERT_PROSPECT_SQL,
                record.source, record.source_url, record.name, record.domain,
                str(record.website) if record.website else None,
                str(record.vertical.value) if record.vertical else None,
                str(record.region.value) if record.region else None,
                record.city, record.state_province, record.country, record.postal_code,
                record.employee_count, record.revenue_estimate_usd, record.revenue_confidence,
                record.detected_erp, record.raw_excerpt,
                IngestionStatus.PENDING.value, None,
            )
            if row:
                accepted += 1
            if accepted >= self._scrape_limit:
                break
        if accepted:
            await self._relay_event("ingestion.batch_persisted", {"accepted": accepted})
            log.info("ingestion_job_persisted", accepted=accepted)

    # -------------------------------------------------------------- scoring
    async def scoring(self) -> None:
        """Score pending prospects and queue their dispatches."""
        rows = await self._db.fetch(_CLAIM_PENDING_SQL, "pending", "scoring", self._batch)
        for row in rows:
            payload = ScoringInput(
                prospect_id=str(row["id"]),
                company_name=row["name"],
                vertical=row["vertical"],
                region=row["region"],
                revenue_estimate_usd=row["revenue_estimate_usd"],
                employee_count=row["employee_count"],
                detected_erp=row["detected_erp"],
                legacy_portal=_portal_hint(row["raw_excerpt"]),
                notes=row["raw_excerpt"],
            )
            result = await self._scorer.score(payload)
            async with self._db.pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        """
                        INSERT INTO scores (prospect_id, qlv_score, band, factors, hooks,
                                            rationale, model, input_fingerprint)
                        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)
                        ON CONFLICT (input_fingerprint) DO NOTHING
                        """,
                        row["id"], result.qlv_score, result.band,
                        _json([f.model_dump() for f in result.factors]),
                        _json([h.model_dump() for h in result.hooks]),
                        result.rationale, result.model, result.input_fingerprint,
                    )
                    await self._outbox.enqueue(
                        conn,
                        aggregate_type="score",
                        aggregate_id=str(row["id"]),
                        event_type="prospect.scored",
                        payload={"qlv_score": result.qlv_score, "band": result.band},
                    )
        if rows:
            log.info("scoring_job_batch", scored=len(rows))

    # -------------------------------------------------------------- dispatch
    async def dispatching(self) -> None:
        """Execute queued dispatch decisions (Channel A sends / Channel B queue)."""
        rows = await self._db.fetch(
            """
            SELECT d.id, d.prospect_id, d.channel, d.status
              FROM dispatches d
             WHERE d.status = 'queued' AND (d.send_after IS NULL OR d.send_after <= now())
             ORDER BY d.created_at
             LIMIT $1
            """,
            self._batch,
        )
        for row in rows:
            prospect = await self._load_prospect(row["prospect_id"])
            if prospect is None or prospect.score is None:
                continue
            await self._router.execute(prospect)

    # ----------------------------------------------------------------- relay
    async def outbox_relay(self) -> None:
        """Publish pending outbox events (currently: structured log sink)."""
        async def log_publisher(event) -> None:
            log.info("outbox_event", event_type=event.event_type,
                     aggregate_id=event.aggregate_id, payload=event.payload)

        await self._outbox.relay(log_publisher)

    async def _load_prospect(self, prospect_id: Any):
        return await load_prospect(self._db, prospect_id)

    async def _relay_event(self, event_type: str, payload: dict[str, Any]) -> None:
        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await self._outbox.enqueue(
                    conn, aggregate_type="prospect", aggregate_id="batch",
                    event_type=event_type, payload=payload,
                )


def _portal_hint(excerpt: str | None) -> str | None:
    """Legacy-portal signal extracted from a raw directory excerpt."""
    if not excerpt:
        return None
    lowered = excerpt.lower()
    for hint in ("customer portal", "b2b portal", "ordering portal", "rfq portal", "login to order"):
        if hint in lowered:
            return hint
    return None


async def load_prospect(db: Database, prospect_id: Any):
    """Load a prospect + latest score from Postgres into domain models."""
    from datetime import datetime

    from vertebra.models.domain import (
        Channel,
        CompanyRecord,
        Contact,
        DispatchDecision,
        ExecutiveRole,
        Hook,
        Prospect,
        QLVFactor,
        ScoreResult,
    )

    row = await db.fetchrow(
        """
        SELECT p.*, s.qlv_score, s.band, s.factors, s.hooks, s.rationale, s.model,
               s.input_fingerprint, s.scored_at
          FROM prospects p
          LEFT JOIN LATERAL (
               SELECT * FROM scores sc WHERE sc.prospect_id = p.id
                ORDER BY sc.scored_at DESC LIMIT 1
          ) s ON TRUE
         WHERE p.id = $1
        """,
        prospect_id,
    )
    if row is None:
        return None

    company = CompanyRecord(
        source=row["source"], source_url=row["source_url"], name=row["name"],
        domain=row["domain"], vertical=row["vertical"], region=row["region"],
        city=row["city"], state_province=row["state_province"], country=row["country"],
        postal_code=row["postal_code"], employee_count=row["employee_count"],
        revenue_estimate_usd=row["revenue_estimate_usd"],
        revenue_confidence=row["revenue_confidence"],
        detected_erp=row["detected_erp"], raw_excerpt=row["raw_excerpt"],
    )
    contact_rows = await db.fetch(
        "SELECT id, first_name, last_name, role, title_raw FROM contacts WHERE prospect_id = $1",
        row["id"],
    )
    contacts = [
        Contact(
            id=str(c["id"]), company_name=row["name"], first_name=c["first_name"],
            last_name=c["last_name"], role=ExecutiveRole(c["role"]), title_raw=c["title_raw"],
        )
        for c in contact_rows
    ]
    score = None
    if row["qlv_score"] is not None:
        score = ScoreResult(
            prospect_id=str(row["id"]),
            company_name=row["name"],
            qlv_score=row["qlv_score"],
            band=row["band"],
            factors=[QLVFactor(**f) for f in row["factors"]],
            hooks=[Hook(**h) for h in row["hooks"]],
            rationale=row["rationale"],
            model=row["model"],
            input_fingerprint=row["input_fingerprint"],
            scored_at=row["scored_at"] or datetime.now(tz=UTC),
        )
    prospect = Prospect(
        id=str(row["id"]), company=company, contacts=contacts, casl_scope=row["casl_scope"],
        best_email=row["best_email"], score=score,
    )
    if row["qlv_score"] is not None:
        prospect.dispatch = DispatchDecision(
            prospect_id=str(row["id"]),
            channel=Channel.HIGH_TOUCH,
            casl_scope=row["casl_scope"],
        )
    return prospect


def _json(value: Any) -> str:
    import json

    return json.dumps(value, default=str)


def default_jobs(db: Database, outbox: OutboxStore, router: DispatchRouter) -> list:
    """Assemble the standard worker job set with Q4 production intervals."""
    from vertebra.workers.scheduler import Job

    jobs = PipelineJobs(db, outbox, router)
    return [
        Job(name="ingestion", interval_sec=3600.0, fn=jobs.ingestion, run_immediately=True),
        Job(name="scoring", interval_sec=300.0, fn=jobs.scoring),
        Job(name="dispatching", interval_sec=120.0, fn=jobs.dispatching),
        Job(name="outbox_relay", interval_sec=15.0, fn=jobs.outbox_relay),
    ]
