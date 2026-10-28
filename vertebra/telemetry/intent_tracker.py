"""Module 8 — Real-Time Intent & Telemetry Monitoring.

Tracks prospect visitors the moment they click an email audit link or land
on the Syntropic portal (``/portal``, ``/audit``), then pages Josias the
instant a scored lead (QLV > 85) shows live intent.

Identity
--------
Channel A links carry an HMAC-signed tracking token (``?lid=<id>.<sig>``).
The signature prevents prospect-id enumeration; unsigned visitors stay
anonymous and still enrich aggregate telemetry.

Geo-IP
------
Vercel edge headers are captured server-side: ``x-vercel-ip-city``,
``x-vercel-ip-country``, ``x-vercel-ip-country-region``, ``x-vercel-ip-latitude``
and ``x-vercel-ip-longitude`` (city values are percent-encoded by Vercel and
decoded here).

Intent heat
-----------
Heat (0-100) is a transparent rolling 14-day score over telemetry rows:
``8 × events + 18 × document_downloads + 10 × extra_sessions + 12 (dwell ≥ 2 min)``.
When heat ≥ ``hot_intent_heat`` *and* the prospect's latest QLV score ≥
``hot_prospect_score``, a CRITICAL alert fans out to Telegram / Slack /
webhook with a per-prospect cooldown so the pager never storms.

Alert template (verbatim operator format)::

    🚨 HIGH-INTENT PROSPECT ON PORTAL
    Company: <name>
    Executive: <first last> (<phone>)
    Location: <city>, <country>
    Action: Call direct line immediately.

Endpoints (mounted by ``vertebra.api.main``)
--------------------------------------------
* ``POST /telemetry/visit``            — record a portal/audit visit
* ``POST /telemetry/event``            — record downloads / pricing views
* ``GET  /telemetry/sessions/{id}``    — session rollup for the enclave UI
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid as uuid_mod
from typing import Any, Literal
from urllib.parse import unquote

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from vertebra.config.settings import Settings, get_settings
from vertebra.db.outbox import OutboxStore
from vertebra.db.pool import Database
from vertebra.logging_conf import get_logger
from vertebra.models.domain import TelemetryEventType, VisitorGeo
from vertebra.telemetry.notifier import AlertDispatcher

log = get_logger("telemetry.intent_tracker")

_TOKEN_SIG_LEN = 32

_ALERT_COOLDOWN_SQL = (
    "SELECT id FROM intent_alerts "
    "WHERE dedupe_key = $1 AND created_at > now() - make_interval(mins => $2) LIMIT 1"
)

_HOT_PROSPECT_SQL = """
SELECT p.id
  FROM prospects p
  LEFT JOIN LATERAL (
      SELECT qlv_score FROM scores s
       WHERE s.prospect_id = p.id ORDER BY scored_at DESC LIMIT 1
  ) latest ON TRUE
 WHERE p.id = $1 AND COALESCE(latest.qlv_score, 0) >= $2
"""

_ALERT_CONTEXT_SQL = """
SELECT p.name, p.city, p.country,
       c.first_name, c.last_name, c.phone,
       COALESCE(latest.qlv_score, 0) AS qlv_score
  FROM prospects p
  LEFT JOIN LATERAL (
      SELECT first_name, last_name, phone
        FROM contacts WHERE prospect_id = p.id
       ORDER BY created_at LIMIT 1
  ) c ON TRUE
  LEFT JOIN LATERAL (
      SELECT qlv_score FROM scores s
       WHERE s.prospect_id = p.id ORDER BY scored_at DESC LIMIT 1
  ) latest ON TRUE
 WHERE p.id = $1
"""

_HEAT_SQL = """
SELECT count(*) AS events,
       count(*) FILTER (WHERE event_type = 'document_download') AS downloads,
       count(DISTINCT session_id) AS sessions,
       COALESCE(sum(duration_ms), 0) AS dwell_ms
  FROM telemetry_events
 WHERE prospect_id = $1
   AND occurred_at > now() - interval '14 days'
"""


# --------------------------------------------------------------------------- #
# Tracking tokens
# --------------------------------------------------------------------------- #


def sign_prospect_token(prospect_id: str, secret: str) -> str:
    """HMAC-signed tracking token for email/audit links: ``<uuid>.<sig>``."""
    digest = hmac.new(secret.encode("utf-8"), prospect_id.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{prospect_id}.{digest[:_TOKEN_SIG_LEN]}"


def verify_prospect_token(token: str, secret: str) -> str | None:
    """Constant-time token verification; returns the prospect id or None."""
    try:
        payload, signature = token.rsplit(".", 1)
    except ValueError:
        return None
    expected = hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if hmac.compare_digest(signature, expected[:_TOKEN_SIG_LEN]):
        try:
            return str(uuid_mod.UUID(payload))
        except ValueError:
            return None
    return None


def tracking_link(base_url: str, path: str, prospect_id: str, secret: str) -> str:
    """Build a tracked portal/audit URL for Channel A emails."""
    return f"{base_url.rstrip('/')}{path}?lid={sign_prospect_token(prospect_id, secret)}"


def _device_class(user_agent: str | None) -> str | None:
    if not user_agent:
        return None
    lowered = user_agent.lower()
    if "mobile" in lowered or "iphone" in lowered or "android" in lowered:
        return "mobile"
    if "bot" in lowered or "spider" in lowered or "crawl" in lowered:
        return "bot"
    return "desktop"


def _vercel_geo(request: Request) -> VisitorGeo:
    """Resolve Geo-IP parameters from Vercel edge request headers."""

    def _float(key: str) -> float | None:
        try:
            return float(request.headers[key])
        except (KeyError, TypeError, ValueError):
            return None

    city = request.headers.get("x-vercel-ip-city")
    return VisitorGeo(
        city=unquote(city) if city else None,
        country=request.headers.get("x-vercel-ip-country"),
        region=request.headers.get("x-vercel-ip-country-region"),
        latitude=_float("x-vercel-ip-latitude"),
        longitude=_float("x-vercel-ip-longitude"),
    )


# --------------------------------------------------------------------------- #
# Intent monitor
# --------------------------------------------------------------------------- #


class IntentMonitor:
    """Ingests telemetry, scores intent heat and pages the operator."""

    def __init__(
        self,
        db: Database,
        outbox: OutboxStore,
        *,
        settings: Settings | None = None,
        dispatcher: AlertDispatcher | None = None,
    ) -> None:
        self._db = db
        self._outbox = outbox
        self._settings = settings or get_settings()
        self._dispatcher = dispatcher or AlertDispatcher(self._settings.telemetry)

    # ---------------------------------------------------------------- ingest
    async def ingest_visit(
        self,
        *,
        event_type: TelemetryEventType,
        session_id: str,
        token: str | None,
        path: str,
        referrer: str | None,
        duration_ms: int | None,
        geo: VisitorGeo,
        user_agent: str | None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist one telemetry event and run the hot-prospect trigger."""
        secret = self._settings.telemetry.tracking_hmac_secret.get_secret_value()
        prospect_id = verify_prospect_token(token, secret) if token else None
        prospect_uuid = uuid_mod.UUID(prospect_id) if prospect_id else None

        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    INSERT INTO telemetry_events (
                        prospect_id, session_id, event_type, url, referrer,
                        city, country, latitude, longitude, user_agent, device,
                        duration_ms, payload
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
                    RETURNING id, occurred_at
                    """,
                    prospect_uuid,
                    session_id,
                    str(event_type.value),
                    path,
                    referrer,
                    geo.city,
                    geo.country,
                    geo.latitude,
                    geo.longitude,
                    user_agent,
                    _device_class(user_agent),
                    duration_ms,
                    json.dumps(extra or {}, default=str),
                )

        heat = 0
        alerted = False
        if prospect_uuid is not None:
            heat = await self._intent_heat(prospect_uuid)
            await self._db.execute(
                "UPDATE prospects SET last_intent_heat = $2, updated_at = now() WHERE id = $1",
                prospect_uuid,
                heat,
            )
            if event_type in (TelemetryEventType.PORTAL_VISIT, TelemetryEventType.AUDIT_VIEW):
                if await self._is_hot(prospect_uuid, heat):
                    alerted = await self._alert_high_intent(prospect_id, geo, heat)  # type: ignore[arg-type]

        log.info(
            "telemetry_ingested",
            event_type=event_type.value,
            session_id=session_id,
            prospect_matched=bool(prospect_id),
            intent_heat=heat,
            alert_dispatched=alerted,
        )
        return {
            "event_id": str(row["id"]),
            "prospect_matched": prospect_id,
            "intent_heat": heat,
            "alert_dispatched": alerted,
        }

    # ------------------------------------------------------------------ heat
    async def _intent_heat(self, prospect_uuid: uuid_mod.UUID) -> int:
        """Rolling 14-day intent heat: events, downloads, sessions, dwell."""
        row = await self._db.fetchrow(_HEAT_SQL, prospect_uuid)
        if row is None:
            return 0
        heat = (
            8 * int(row["events"])
            + 18 * int(row["downloads"])
            + 10 * max(0, int(row["sessions"]) - 1)
            + (12 if int(row["dwell_ms"]) >= 120_000 else 0)
        )
        return min(100, int(heat))

    async def _is_hot(self, prospect_uuid: uuid_mod.UUID, heat: int) -> bool:
        telemetry = self._settings.telemetry
        if heat < telemetry.hot_intent_heat:
            return False
        row = await self._db.fetchrow(
            _HOT_PROSPECT_SQL, prospect_uuid, telemetry.hot_prospect_score
        )
        return row is not None

    # ----------------------------------------------------------------- alert
    async def _alert_high_intent(
        self, prospect_id: str, geo: VisitorGeo, heat: int
    ) -> bool:
        telemetry = self._settings.telemetry
        dedupe_key = f"hot-portal:{prospect_id}"

        recent = await self._db.fetchval(
            _ALERT_COOLDOWN_SQL, dedupe_key, telemetry.alert_cooldown_minutes
        )
        if recent is not None:
            log.info("hot_alert_cooldown_skip", prospect_id=prospect_id, dedupe_key=dedupe_key)
            return False

        row = await self._db.fetchrow(_ALERT_CONTEXT_SQL, uuid_mod.UUID(prospect_id))
        if row is None:
            return False

        executive = f"{row['first_name'] or ''} {row['last_name'] or ''}".strip() or "Unknown executive"
        phone = row["phone"] or "no direct line on file"
        city = row["city"] or geo.city or "unknown city"
        country = row["country"] or geo.country or "unknown country"

        title = "🚨 HIGH-INTENT PROSPECT ON PORTAL"
        body = (
            f"Company: {row['name']}\n"
            f"Executive: {executive} ({phone})\n"
            f"Location: {city}, {country}\n"
            f"Action: Call direct line immediately."
        )

        attempted, delivered = await self._dispatcher.dispatch(title=title, body=body, severity="CRITICAL")

        async with self._db.pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO intent_alerts (
                        prospect_id, title, body, dedupe_key,
                        channels_attempted, channels_delivered, delivered
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    """,
                    uuid_mod.UUID(prospect_id),
                    title,
                    body,
                    dedupe_key,
                    attempted,
                    delivered,
                    bool(delivered),
                )
                await self._outbox.enqueue(
                    conn,
                    aggregate_type="telemetry",
                    aggregate_id=prospect_id,
                    event_type="telemetry.high_intent_alert",
                    payload={
                        "title": title,
                        "company": row["name"],
                        "executive": executive,
                        "city": city,
                        "country": country,
                        "qlv_score": int(row["qlv_score"]),
                        "intent_heat": heat,
                        "channels_delivered": delivered,
                    },
                )
        log.info("high_intent_alert_dispatched", prospect_id=prospect_id, delivered=delivered)
        return bool(delivered)

    # --------------------------------------------------------------- rollups
    async def session_summary(self, session_id: str) -> dict[str, Any]:
        """Session rollup powering the Executive Enclave telemetry panel."""
        rows = await self._db.fetch(
            """
            SELECT event_type, url, city, country, device, duration_ms, occurred_at
              FROM telemetry_events
             WHERE session_id = $1
             ORDER BY occurred_at
            """,
            session_id,
        )
        dwell_ms = sum(int(r["duration_ms"] or 0) for r in rows)
        return {
            "session_id": session_id,
            "event_count": len(rows),
            "dwell_ms": dwell_ms,
            "document_downloads": sum(
                1 for r in rows if r["event_type"] == "document_download"
            ),
            "geo": {
                "city": rows[0]["city"] if rows else None,
                "country": rows[0]["country"] if rows else None,
            },
            "events": [
                {
                    "event_type": r["event_type"],
                    "url": r["url"],
                    "duration_ms": r["duration_ms"],
                    "occurred_at": r["occurred_at"].isoformat(),
                }
                for r in rows
            ],
        }


# --------------------------------------------------------------------------- #
# FastAPI router (mounted in vertebra.api.main)
# --------------------------------------------------------------------------- #

telemetry_router = APIRouter(prefix="/telemetry", tags=["telemetry"])


class TelemetryVisitIn(BaseModel):
    """Inbound telemetry payload from the portal/audit pages."""

    session_id: str | None = Field(
        default=None, description="Client session id; server-side fallback used when absent"
    )
    token: str | None = Field(default=None, description="Signed ?lid= token from the tracked link")
    path: str = "/portal"
    referrer: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    event_type: Literal[
        "portal_visit", "audit_view", "document_download", "pricing_view", "session_end"
    ] = "portal_visit"
    document_id: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


def _fallback_session_id() -> str:
    return uuid_mod.uuid4().hex


@telemetry_router.post("/visit", status_code=202)
async def ingest_visit(request: Request, body: TelemetryVisitIn) -> dict[str, Any]:
    """Record a portal visit (Vercel geo headers captured server-side)."""
    monitor: IntentMonitor = request.app.state.telemetry
    event_type = TelemetryEventType(body.event_type)
    return await monitor.ingest_visit(
        event_type=event_type,
        session_id=body.session_id or _fallback_session_id(),
        token=body.token,
        path=body.path,
        referrer=body.referrer,
        duration_ms=body.duration_ms,
        geo=_vercel_geo(request),
        user_agent=request.headers.get("user-agent"),
        extra=body.extra,
    )


@telemetry_router.post("/event", status_code=202)
async def ingest_event(request: Request, body: TelemetryVisitIn) -> dict[str, Any]:
    """Record downloads / pricing views / session ends."""
    monitor: IntentMonitor = request.app.state.telemetry
    extra = dict(body.extra)
    if body.document_id:
        extra.setdefault("document_id", body.document_id)
    return await monitor.ingest_visit(
        event_type=TelemetryEventType(body.event_type),
        session_id=body.session_id or _fallback_session_id(),
        token=body.token,
        path=body.path,
        referrer=body.referrer,
        duration_ms=body.duration_ms,
        geo=_vercel_geo(request),
        user_agent=request.headers.get("user-agent"),
        extra=extra,
    )


@telemetry_router.get("/sessions/{session_id}")
async def session_summary(request: Request, session_id: str) -> dict[str, Any]:
    """Session rollup for the enclave dashboard."""
    monitor: IntentMonitor = request.app.state.telemetry
    return await monitor.session_summary(session_id)
