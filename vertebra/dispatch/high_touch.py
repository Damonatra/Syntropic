"""Channel B — the Josias High-Touch queue.

Every prospect routed to high-touch is persisted to Neon Postgres, emitted as
an outbox event, and scheduled as a Google Calendar follow-up. Reps consume a
structured CSV export (the format Josias expects) that also marks rows as
exported so no lead is worked twice.
"""

from __future__ import annotations

import csv
from datetime import datetime, timezone
from pathlib import Path

import asyncpg

from vertebra.db.pool import Database
from vertebra.db.outbox import OutboxStore
from vertebra.config.settings import DispatchPolicySettings, get_settings
from vertebra.logging_conf import get_logger
from vertebra.models.domain import HighTouchQueueItem, Prospect

log = get_logger("dispatch.high_touch")

_INSERT_SQL = """
INSERT INTO high_touch_queue (
    prospect_id, company_name, contact_first, contact_last, role, email, phone,
    city, state_province, region, vertical, qlv_score, qlv_band, top_hook,
    rationale, detected_erp
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
RETURNING id, created_at
"""

_MARK_EXPORTED_SQL = "UPDATE high_touch_queue SET exported_at = $2 WHERE prospect_id = ANY($1::uuid[])"
_PENDING_SQL = """
SELECT prospect_id, company_name, contact_first, contact_last, role, email, phone,
       city, state_province, region, vertical, qlv_score, qlv_band, top_hook,
       rationale, detected_erp, created_at
  FROM high_touch_queue
 WHERE exported_at IS NULL
 ORDER BY qlv_score DESC, created_at
"""


class HighTouchExporter:
    """Persists, schedules and exports the Josias queue."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        export_dir: str | None = None,
        calendar: "CalendarSync | None" = None,
        schedule_calendar: bool = True,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._export_dir = Path(export_dir or get_settings().policy.high_touch_export_dir)
        self._calendar = calendar
        self._schedule_calendar = schedule_calendar and calendar is not None

    # ---------------------------------------------------------------- enqueue
    async def enqueue(self, prospect: Prospect) -> HighTouchQueueItem:
        """Persist a queued high-touch row + outbox event (+ calendar task)."""
        score = prospect.score
        contact = prospect.primary_contact
        top_hook = score.hooks[0].body if score and score.hooks else ""

        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    _INSERT_SQL,
                    prospect.id,
                    prospect.company.name,
                    contact.first_name if contact else "",
                    contact.last_name if contact else "",
                    str(contact.role.value) if contact else "unknown",
                    prospect.best_email,
                    None,
                    prospect.company.city,
                    prospect.company.state_province,
                    str(prospect.company.region.value) if prospect.company.region else "us",
                    str(prospect.company.vertical.value) if prospect.company.vertical else "pvf",
                    score.qlv_score if score else 0,
                    score.band if score else "low",
                    top_hook,
                    score.rationale if score else "",
                    prospect.company.detected_erp,
                )
                await self._outbox.enqueue(
                    conn,
                    aggregate_type="high_touch",
                    aggregate_id=str(row["id"]),
                    event_type="high_touch.queued",
                    payload={
                        "prospect_id": prospect.id,
                        "company_name": prospect.company.name,
                        "qlv_score": score.qlv_score if score else None,
                        "casl_scope": prospect.casl_scope,
                    },
                )

        calendar_event_id: str | None = None
        if self._schedule_calendar and self._calendar is not None:
            try:
                calendar_event_id = await self._calendar.create_followup_event(
                    company_name=prospect.company.name,
                    contact_name=f"{contact.first_name} {contact.last_name}" if contact else "unknown contact",
                    top_hook=top_hook,
                    qlv_score=score.qlv_score if score else None,
                    prospect_id=prospect.id,
                )
            except Exception as exc:  # noqa: BLE001 - calendar outage must not block queueing
                log.warning("calendar_followup_failed", company=prospect.company.name, error=str(exc))

        await self._db.execute(
            "UPDATE high_touch_queue SET calendar_event_id = $2 WHERE id = $1",
            row["id"], calendar_event_id,
        )

        item = HighTouchQueueItem(
            prospect_id=prospect.id,
            company_name=prospect.company.name,
            contact_first=contact.first_name if contact else "",
            contact_last=contact.last_name if contact else "",
            role=str(contact.role.value) if contact else "unknown",
            email=prospect.best_email,
            city=prospect.company.city,
            state_province=prospect.company.state_province,
            region=prospect.company.region,  # type: ignore[arg-type]
            vertical=prospect.company.vertical,  # type: ignore[arg-type]
            qlv_score=score.qlv_score if score else 0,
            qlv_band=score.band if score else "low",
            top_hook=top_hook,
            rationale=score.rationale if score else "",
            detected_erp=prospect.company.detected_erp,
            calendar_event_id=calendar_event_id,
            created_at=row["created_at"],
        )
        log.info(
            "high_touch_queued",
            company=prospect.company.name,
            qlv=item.qlv_score,
            calendar_event_id=calendar_event_id,
        )
        return item

    # ----------------------------------------------------------------- export
    async def export_pending_csv(self, path: str | None = None) -> Path:
        """Write the pending queue to Josias' structured CSV and mark rows."""
        rows: list[asyncpg.Record] = await self._db.fetch(_PENDING_SQL)
        if not rows:
            log.info("high_touch_export_empty")
            return self._ensure_dir() / "high-touch-empty.csv"

        export_path = Path(path) if path else self._ensure_dir() / f"josias-high-touch-{datetime.now(tz=timezone.utc):%Y%m%d-%H%M%S}.csv"
        columns = [
            "prospect_id", "company_name", "contact_first", "contact_last", "role",
            "email", "phone", "city", "state_province", "region", "vertical",
            "qlv_score", "qlv_band", "top_hook", "rationale", "detected_erp",
            "calendar_event_id", "created_at",
        ]
        with export_path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns, quoting=csv.QUOTE_MINIMAL)
            writer.writeheader()
            for record in rows:
                writer.writerow({column: record.get(column) for column in columns})

        ids = [str(r["prospect_id"]) for r in rows]
        await self._db.execute(_MARK_EXPORTED_SQL, ids, datetime.now(tz=timezone.utc))
        log.info("high_touch_exported", rows=len(rows), path=str(export_path))
        return export_path

    def _ensure_dir(self) -> Path:
        self._export_dir.mkdir(parents=True, exist_ok=True)
        return self._export_dir
