"""Transactional outbox for Vertebra.

State changes and their audit events are committed atomically: the caller
writes the row change and enqueues outbox events inside one transaction.
A relay worker then publishes events (webhooks, calendar writes, downstream
sync) with retries and records failures on the row.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from datetime import datetime
from typing import Any

import asyncpg

from vertebra.db.event_stream import EventStreamLogger
from vertebra.db.pool import Database
from vertebra.logging_conf import get_logger
from vertebra.models.domain import OutboxEvent, utcnow

log = get_logger("db.outbox")

_INSERT_SQL = """
INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload)
VALUES ($1, $2, $3, $4::jsonb)
RETURNING id, created_at
"""

_CLAIM_SQL = """
UPDATE outbox
   SET attempts = attempts + 1
 WHERE id IN (
       SELECT id FROM outbox
        WHERE published_at IS NULL AND attempts < $1
        ORDER BY created_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED)
RETURNING id, aggregate_type, aggregate_id, event_type, payload, attempts
"""

_COMPLETE_SQL = "UPDATE outbox SET published_at = $2, last_error = NULL WHERE id = $1"
_FAIL_SQL = "UPDATE outbox SET last_error = $2 WHERE id = $1"


class OutboxStore:
    """Read/write access to the transactional outbox table."""

    def __init__(self, db: Database, *, stream_logger: EventStreamLogger | None = None) -> None:
        self._db = db
        self._stream_logger = stream_logger

    # ------------------------------------------------------------------ write
    async def enqueue(
        self,
        conn: asyncpg.Connection,
        *,
        aggregate_type: str,
        aggregate_id: str,
        event_type: str,
        payload: Mapping[str, Any],
    ) -> OutboxEvent:
        """Enqueue an event on an *existing open transaction/connection*.

        Callers must pass the same connection that performs the correlated
        state change so the event commits atomically with it.
        """
        row = await conn.fetchrow(
            _INSERT_SQL,
            aggregate_type,
            aggregate_id,
            event_type,
            json.dumps(payload, default=_json_default),
        )
        event = OutboxEvent(
            id=str(row["id"]),
            aggregate_type=aggregate_type,  # type: ignore[arg-type]
            aggregate_id=aggregate_id,
            event_type=event_type,
            payload=dict(payload),
            created_at=row["created_at"],
        )
        if self._stream_logger is not None:
            try:
                self._stream_logger.append(
                    event_type,
                    {"aggregate_type": aggregate_type, "aggregate_id": aggregate_id, **dict(payload)},
                )
            except Exception as stream_err:
                log.warning("stream_log_append_failed", event_type=event_type, error=str(stream_err))
        log.info("outbox_enqueued", event_type=event_type, aggregate_id=aggregate_id)
        return event

    # ------------------------------------------------------------------- read
    async def claim_batch(
        self,
        *,
        batch_size: int = 50,
        max_attempts: int = 8,
    ) -> list[OutboxEvent]:
        """Atomically claim unpublished events for relay (SKIP LOCKED)."""
        rows: Sequence[asyncpg.Record] = await self._db.fetch(
            _CLAIM_SQL, max_attempts, batch_size
        )
        return [
            OutboxEvent(
                id=str(r["id"]),
                aggregate_type=r["aggregate_type"],  # type: ignore[arg-type]
                aggregate_id=r["aggregate_id"],
                event_type=r["event_type"],
                payload=json.loads(r["payload"]),
                attempts=r["attempts"],
            )
            for r in rows
        ]

    async def mark_published(self, event_id: str) -> None:
        await self._db.execute(_COMPLETE_SQL, event_id, utcnow())

    async def mark_failed(self, event_id: str, error: str) -> None:
        await self._db.execute(_FAIL_SQL, event_id, error[:2000])

    # ------------------------------------------------------------------ relay
    async def relay(
        self,
        publisher: Callable[[OutboxEvent], Awaitable[None]],
        *,
        batch_size: int = 50,
        max_attempts: int = 8,
    ) -> int:
        """Relay one batch; returns the number of published events.

        ``publisher`` is any awaitable-accepting callable mapping an event to a
        coroutine that raises on failure. Retries happen on subsequent relay
        cycles with attempts already incremented.
        """
        events = await self.claim_batch(batch_size=batch_size, max_attempts=max_attempts)
        published = 0
        for event in events:
            try:
                await publisher(event)
                await self.mark_published(event.id)
                published += 1
            except Exception as exc:  # noqa: BLE001 - relay must survive bad events
                await self.mark_failed(event.id, f"{type(exc).__name__}: {exc}")
                log.warning(
                    "outbox_publish_failed",
                    event_type=event.event_type,
                    event_id=event.id,
                    attempts=event.attempts,
                    error=str(exc),
                )
        if events:
            log.info("outbox_relay_batch", claimed=len(events), published=published)
        return published


async def stream_batches(
    store: OutboxStore,
    *,
    interval_sec: float = 5.0,
    batch_size: int = 50,
) -> AsyncIterator[list[OutboxEvent]]:
    """Endless generator of claimed batches with sleep pacing (for workers)."""
    import asyncio

    while True:
        batch = await store.claim_batch(batch_size=batch_size)
        if batch:
            yield batch
        await asyncio.sleep(interval_sec if not batch else 0.5)


def _json_default(obj: Any) -> Any:
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Cannot serialise {type(obj).__name__} to JSON")
