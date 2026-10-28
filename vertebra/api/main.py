"""FastAPI application factory + lifespan wiring for Vertebra.

Startup sequence: configure logging → connect Neon → apply migrations →
construct the component graph (outbox, dispatch router, high-touch exporter,
scorer) → start the asyncio worker scheduler. Shutdown reverses it.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI

from vertebra.api.routes import pipeline_router, system_router
from vertebra.config.settings import get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database, database_from_settings
from vertebra.dispatch.high_touch import HighTouchExporter
from vertebra.dispatch.router import DispatchRouter
from vertebra.logging_conf import configure_logging, get_logger
from vertebra.workers.jobs import default_jobs
from vertebra.workers.scheduler import Scheduler

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

        scheduler: Scheduler | None = None
        if start_scheduler:
            scheduler = Scheduler(default_jobs(db, outbox, dispatch_router))
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
        version="1.0.0",
        lifespan=lifespan,
    )
    app.include_router(system_router)
    app.include_router(pipeline_router)
    return app


def _lazy_scorer():
    from vertebra.ai.scorer import QuoteLeakageScorer

    return QuoteLeakageScorer()


def _make_prospect_loader(db: Database):
    """Bind the shared prospect loader to the API app state."""
    from vertebra.workers.jobs import load_prospect

    async def _loader(prospect_id: str):
        return await load_prospect(db, prospect_id)

    return _loader
