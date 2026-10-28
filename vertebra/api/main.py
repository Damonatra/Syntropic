"""FastAPI application factory + lifespan wiring for Vertebra.

Startup sequence: configure logging → connect Neon → apply migrations →
construct the component graph (outbox, dispatch router, high-touch exporter,
scorer, ERP profiler, audit preview generator, spatial clusterer, intent
monitor, reply agent) → start the asyncio worker scheduler. Shutdown reverses
it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from vertebra.api.routes import pipeline_router, system_router, tactical_router
from vertebra.config.settings import get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database, database_from_settings
from vertebra.dispatch.router import DispatchRouter
from vertebra.logging_conf import configure_logging, get_logger
from vertebra.telemetry.intent_tracker import IntentMonitor, telemetry_router
from vertebra.workers.jobs import default_jobs
from vertebra.workers.scheduler import Scheduler
from vertebra.workers.tactical_jobs import default_tactical_jobs

log = get_logger("api.main")


def create_app(*, start_scheduler: bool = True) -> FastAPI:
    """Build the Vertebra FastAPI app (lifespan-managed dependencies)."""
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    db: Database = database_from_settings(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await db.connect()
        await db.apply_migrations()
        outbox = OutboxStore(db)
        dispatch_router = DispatchRouter(db, outbox=outbox)
        high_touch = dispatch_router._high_touch  # noqa: SLF001 - shared instance by design

        app.state.db = db
        app.state.outbox = outbox
        app.state.dispatch_router = dispatch_router
        app.state.high_touch = high_touch
        app.state.scorer = _lazy_scorer()
        app.state.load_prospect = _make_prospect_loader(db)

        # -- advanced tactical modules (5-9) ---------------------------------
        app.state.erp_profiler = _lazy_erp_profiler(db, outbox)
        app.state.audit_preview = _lazy_audit_preview(db, outbox)
        app.state.spatial = _lazy_spatial_clusterer(db, outbox)
        app.state.telemetry = IntentMonitor(db, outbox)
        app.state.reply_agent = _lazy_reply_agent(db, outbox)

        scheduler: Scheduler | None = None
        if start_scheduler:
            scheduler = Scheduler(
                default_jobs(db, outbox, dispatch_router)
                + default_tactical_jobs(db, outbox)
            )
            await scheduler.start()
            app.state.scheduler_status = scheduler.status

        log.info("vertebra_api_started", env=settings.env.value, scheduler=start_scheduler)
        try:
            yield
        finally:
            if scheduler is not None:
                await scheduler.stop()
            await db.close()
            log.info("vertebra_api_stopped")

    app = FastAPI(
        title="Vertebra",
        description="Syntropic autonomous lead & intelligence engine",
        version="1.1.0",
        lifespan=lifespan,
    )
    app.include_router(system_router)
    app.include_router(pipeline_router)
    app.include_router(telemetry_router)
    app.include_router(tactical_router)
    return app


def _lazy_scorer():
    from vertebra.ai.scorer import QuoteLeakageScorer

    return QuoteLeakageScorer()


def _lazy_erp_profiler(db: Database, outbox: OutboxStore):
    """Module 5 — profiler with an optional Qdrant payload mirror."""
    from vertebra.enrichment.erp_profiler import ERPProfiler

    index = None
    try:
        from vertebra.vector.similarity import FirmographicIndex

        index = FirmographicIndex()
    except Exception as exc:  # noqa: BLE001 - vector mirror is optional
        log.warning("qdrant_index_unavailable", error=str(exc))
    return ERPProfiler(db, outbox, qdrant_index=index)


def _lazy_audit_preview(db: Database, outbox: OutboxStore):
    """Module 6 — Playwright + widget overlay + CDN asset pipeline."""
    from vertebra.intelligence.audit_preview import AuditPreviewGenerator

    return AuditPreviewGenerator(db, outbox)


def _lazy_spatial_clusterer(db: Database, outbox: OutboxStore):
    """Module 7 — PostGIS/haversine clusterer with meeting-proximity alerts."""
    from vertebra.spatial.clustering import SpatialClusterer
    from vertebra.telemetry.notifier import AlertDispatcher

    notifier = AlertDispatcher(get_settings().telemetry)
    return SpatialClusterer(db, outbox, notifier=notifier)


def _lazy_reply_agent(db: Database, outbox: OutboxStore):
    """Module 9 — LangGraph closed-loop follow-up agent."""
    from vertebra.ai.reply_agent import ReplyAgent

    return ReplyAgent(db, outbox)


def _make_prospect_loader(db: Database):
    """Bind the shared prospect loader to the API app state."""
    from vertebra.workers.jobs import load_prospect

    async def _loader(prospect_id: str):
        return await load_prospect(db, prospect_id)

    return _loader
