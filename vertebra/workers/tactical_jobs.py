"""Autonomous background jobs for the advanced tactical modules (5-9).

Where :mod:`vertebra.workers.jobs` drives the core pipeline (ingest →
enrich → score → dispatch → relay), this module keeps the tactical layer
self-running between operator interactions:

* Module 5 — ``erp_profiling``    profile prospects missing ``erp_metadata``;
* Module 6 — ``audit_previews``   capture + overlay + publish audit assets;
* Module 7 — ``spatial_clustering`` refresh DBSCAN clusters and memberships;
* Module 9 — ``reply_processing`` drain unprocessed inbound replies.

Module 8 (intent telemetry) is event-driven by design — the portal POSTs to
``/telemetry/*`` and the high-intent pager fires inline — so it has no
batch job here.

Every job is bounded per run and fault-isolated: item-level failures are
logged and skipped inside the module implementations, while job-level
failures are handled by the scheduler's cool-down loop. Each job can be
switched off independently through ``TacticalJobsSettings`` so a deployment
without Playwright or Anthropic credentials stays healthy.
"""

from __future__ import annotations

from typing import Any

from vertebra.config.settings import TacticalJobsSettings, get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.logging_conf import get_logger

log = get_logger("workers.tactical_jobs")

#: Module 5 — bounded crawl batch every 15 minutes.
ERP_PROFILING_INTERVAL_SEC = 900.0
#: Module 6 — Playwright capture is the heaviest job; 30 minutes, small batch.
AUDIT_PREVIEWS_INTERVAL_SEC = 1_800.0
#: Module 7 — territories drift slowly; a 6-hour refresh is plenty.
SPATIAL_CLUSTERING_INTERVAL_SEC = 21_600.0
#: Module 9 — replies are time-critical; drain every 2 minutes.
REPLY_PROCESSING_INTERVAL_SEC = 120.0


class TacticalJobs:
    """Bundle of the module 5-9 recurring jobs, bound to shared components."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        settings: TacticalJobsSettings | None = None,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._settings = settings or get_settings().tactical_jobs
        self._components: dict[str, Any] = {}

    # ------------------------------------------------------------ components
    def _erp_profiler(self) -> Any:
        """Module 5 profiler with an optional Qdrant payload mirror."""
        if "erp_profiler" not in self._components:
            from vertebra.enrichment.erp_profiler import ERPProfiler

            index = None
            try:
                from vertebra.vector.similarity import FirmographicIndex

                index = FirmographicIndex()
            except Exception as exc:  # noqa: BLE001 - vector mirror is optional
                log.warning("tactical_qdrant_index_unavailable", error=str(exc))
            self._components["erp_profiler"] = ERPProfiler(
                self._db, self._outbox, qdrant_index=index
            )
        return self._components["erp_profiler"]

    def _audit_preview(self) -> Any:
        """Module 6 generator (Playwright imports stay inside its capture)."""
        if "audit_preview" not in self._components:
            from vertebra.intelligence.audit_preview import AuditPreviewGenerator

            self._components["audit_preview"] = AuditPreviewGenerator(self._db, self._outbox)
        return self._components["audit_preview"]

    def _spatial(self) -> Any:
        """Module 7 clusterer wired to the operator alert fan-out."""
        if "spatial" not in self._components:
            from vertebra.spatial.clustering import SpatialClusterer
            from vertebra.telemetry.notifier import AlertDispatcher

            notifier = AlertDispatcher(get_settings().telemetry)
            self._components["spatial"] = SpatialClusterer(
                self._db, self._outbox, notifier=notifier
            )
        return self._components["spatial"]

    def _reply_agent(self) -> Any:
        """Module 9 LangGraph agent (Claude clients are lazy inside)."""
        if "reply_agent" not in self._components:
            from vertebra.ai.reply_agent import ReplyAgent

            self._components["reply_agent"] = ReplyAgent(self._db, self._outbox)
        return self._components["reply_agent"]

    # ------------------------------------------------------------------ jobs
    async def erp_profiling(self) -> None:
        """Module 5 — enrich unscored-profile prospects with ERP intel."""
        if not self._settings.erp_profiling_enabled:
            return
        results = await self._erp_profiler().profile_unprofiled(
            limit=self._settings.erp_profiling_batch
        )
        profiled = sum(1 for r in results if r is not None)
        if profiled:
            log.info("tactical_erp_profiling_batch", profiled=profiled, requested=len(results))

    async def audit_previews(self) -> None:
        """Module 6 — generate previews for the top unscreenshotted prospects."""
        if not self._settings.audit_previews_enabled:
            return
        done = await self._audit_preview().generate_batch(
            limit=self._settings.audit_previews_batch
        )
        if done:
            log.info("tactical_audit_preview_batch", generated=len(done))

    async def spatial_clustering(self) -> None:
        """Module 7 — refresh tactical clusters and membership bindings."""
        if not self._settings.spatial_clustering_enabled:
            return
        clusters = await self._spatial().cluster_prospects()
        if clusters:
            log.info("tactical_clustering_batch", clusters=len(clusters))

    async def reply_processing(self) -> None:
        """Module 9 — classify and act on every unprocessed inbound reply."""
        if not self._settings.reply_processing_enabled:
            return
        decisions = await self._reply_agent().process_pending()
        if decisions:
            log.info("tactical_reply_batch", processed=len(decisions))


def default_tactical_jobs(db: Database, outbox: OutboxStore) -> list:
    """Assemble the module 5-9 job set with production intervals."""
    from vertebra.workers.scheduler import Job

    tactical = TacticalJobs(db, outbox)
    return [
        Job(
            name="erp_profiling",
            interval_sec=ERP_PROFILING_INTERVAL_SEC,
            fn=tactical.erp_profiling,
            run_immediately=True,
        ),
        Job(
            name="audit_previews",
            interval_sec=AUDIT_PREVIEWS_INTERVAL_SEC,
            fn=tactical.audit_previews,
        ),
        Job(
            name="spatial_clustering",
            interval_sec=SPATIAL_CLUSTERING_INTERVAL_SEC,
            fn=tactical.spatial_clustering,
            run_immediately=True,
        ),
        Job(
            name="reply_processing",
            interval_sec=REPLY_PROCESSING_INTERVAL_SEC,
            fn=tactical.reply_processing,
        ),
    ]
