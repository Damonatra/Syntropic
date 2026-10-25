"""Drafts-folder-only Outlook dispatch worker (Layer 4 Vector 1).

Delivery semantics mirror the ERP webhook outbox exactly (durable
lease-claim with ``FOR UPDATE SKIP LOCKED``, exponential backoff, poison
detection) so on-call engineers operate one mental model for both queues.

HARD INVARIANT — HUMAN-IN-THE-LOOP LIABILITY BOUNDARY:
    The ONLY Microsoft Graph write endpoint this module may call is

        POST /users/{mailbox_id}/mailFolders/Drafts/messages

    There is deliberately no send path. Injected drafts remain in the
    estimator's Drafts folder until the inside estimator personally
    reviews and clicks Send. ``tests/test_dispatch.py`` enforces this
    with a contract test (source scan + functional URL capture), so a
    future refactor cannot silently introduce auto-send.

Backbone escalation ("The Backbone" manual-resolution queue): failures
that retrying cannot fix are moved to the terminal ``backbone`` status
IMMEDIATELY (no retry churn):
- ``missing_recipient``  — approved RFQ carries no customer email
- ``mailbox_unreachable`` — Graph 403/404 (locked or non-existent mailbox)
- ``invalid_draft``       — Graph 400/422 (malformed payload)
- ``attempts_exhausted``  — retryable errors past MAX_DISPATCH_ATTEMPTS

Transient failures (429, 5xx, timeouts, network errors, post-401 token
renewal) back off exponentially — 429 honors the Graph ``Retry-After``
header — and never drop a quote: rows stay ``pending`` until delivered
or escalated.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from syntropic.core.dispatch.draft_composer import (
    DraftCompositionError,
    compose_quote_draft,
)
from syntropic.core.dispatch.graph_auth import DispatchAuthError, GraphTokenManager
from syntropic.core.matching.api.database import DispatchOutbox

logger = logging.getLogger(__name__)

GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"
DRAFTS_FOLDER = "Drafts"

MAX_DISPATCH_ATTEMPTS = 8
MAX_RETRY_DELAY_SECONDS = 60 * 60
DISPATCH_LEASE_SECONDS = 60
DISPATCH_POLL_SECONDS = 1
DEFAULT_SLA_SECONDS = 90

STATUS_PENDING = "pending"
STATUS_PROCESSING = "processing"
STATUS_INJECTED = "injected"
STATUS_BACKBONE = "backbone"

BACKBONE_MISSING_RECIPIENT = "missing_recipient"
BACKBONE_MAILBOX_UNREACHABLE = "mailbox_unreachable"
BACKBONE_INVALID_DRAFT = "invalid_draft"
BACKBONE_ATTEMPTS_EXHAUSTED = "attempts_exhausted"
BACKBONE_AUTH = "auth_failure"

_SLASHLESS = ("..", "//")


def dispatch_enabled() -> bool:
    """True when Layer 4 draft dispatch is configured for this deployment.

    Requires an explicit opt-in plus a complete Azure AD app-registration
    surface. Disabled deployments simply never enqueue drafts — quotes
    stay in the review queue (graceful degradation, no silent drops).
    """
    if os.getenv("DISPATCH_ENABLED", "false").strip().lower() not in {
        "1",
        "true",
        "yes",
    }:
        return False
    return all(
        os.getenv(name, "").strip()
        for name in (
            "GRAPH_TENANT_ID",
            "GRAPH_CLIENT_ID",
            "GRAPH_CLIENT_SECRET",
            "GRAPH_MAILBOX_ID",
        )
    )


@dataclass(frozen=True)
class DispatchConfig:
    tenant_id: str
    client_id: str
    client_secret: str
    mailbox_id: str
    sla_seconds: int = DEFAULT_SLA_SECONDS


def get_dispatch_config() -> DispatchConfig:
    """Read and validate the Graph deployment surface from the environment."""
    config = DispatchConfig(
        tenant_id=os.getenv("GRAPH_TENANT_ID", "").strip(),
        client_id=os.getenv("GRAPH_CLIENT_ID", "").strip(),
        client_secret=os.getenv("GRAPH_CLIENT_SECRET", "").strip(),
        mailbox_id=os.getenv("GRAPH_MAILBOX_ID", "").strip(),
        sla_seconds=_sla_seconds(),
    )
    if not all((config.tenant_id, config.client_id, config.client_secret, config.mailbox_id)):
        raise RuntimeError(
            "Draft dispatch requires GRAPH_TENANT_ID, GRAPH_CLIENT_ID, "
            "GRAPH_CLIENT_SECRET and GRAPH_MAILBOX_ID."
        )
    return config


def _sla_seconds() -> int:
    try:
        return max(int(os.getenv("DISPATCH_SLA_SECONDS", str(DEFAULT_SLA_SECONDS))), 1)
    except ValueError:
        return DEFAULT_SLA_SECONDS


def draft_creation_endpoint(mailbox_id: str) -> str:
    """The single Graph write endpoint this worker may ever call."""
    if not mailbox_id or any(token in mailbox_id for token in _SLASHLESS):
        raise RuntimeError("GRAPH_MAILBOX_ID is malformed.")
    return f"{GRAPH_API_BASE}/users/{mailbox_id}/mailFolders/{DRAFTS_FOLDER}/messages"


def _sla_breach_threshold() -> int:
    return _sla_seconds()


async def _claim_dispatch(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, dict[str, Any], int] | None:
    """Lease-claim the oldest dispatchable event (mirrors webhook claim)."""
    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        async with session.begin():
            statement = (
                select(DispatchOutbox)
                .where(
                    or_(
                        and_(
                            DispatchOutbox.status == STATUS_PENDING,
                            DispatchOutbox.available_at <= now,
                        ),
                        and_(
                            DispatchOutbox.status == STATUS_PROCESSING,
                            DispatchOutbox.lease_until <= now,
                        ),
                    )
                )
                .order_by(DispatchOutbox.available_at, DispatchOutbox.created_at)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            event = await session.scalar(statement)
            if event is None:
                return None
            event.status = STATUS_PROCESSING
            event.attempts += 1
            event.lease_until = now + timedelta(seconds=DISPATCH_LEASE_SECONDS)
            return (event.event_id, dict(event.payload), event.attempts)


async def _mark_injected(
    session_factory: async_sessionmaker[AsyncSession],
    event_id: str,
    sla_ms: int | None,
) -> None:
    """Terminal success: draft sits in the estimator's Drafts folder."""
    now = datetime.now(timezone.utc)
    breached = sla_ms is not None and sla_ms > _sla_breach_threshold() * 1000
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(DispatchOutbox, event_id, with_for_update=True)
            if event is None:
                raise RuntimeError(f"Claimed dispatch event {event_id} no longer exists.")
            event.status = STATUS_INJECTED
            event.injected_at = now
            event.sla_ms = sla_ms
            event.sla_breached = breached
            event.lease_until = None
            event.last_error = None
    if breached:
        logger.warning(
            "Dispatch event %s breached the %ss draft SLA (took %sms).",
            event_id,
            _sla_breach_threshold(),
            sla_ms,
        )


async def _mark_backbone(
    session_factory: async_sessionmaker[AsyncSession],
    event_id: str,
    attempts: int,
    reason: str,
    error_message: str,
) -> None:
    """Terminal escalation to The Backbone for manual resolution."""
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(DispatchOutbox, event_id, with_for_update=True)
            if event is None:
                raise RuntimeError(f"Claimed dispatch event {event_id} no longer exists.")
            event.status = STATUS_BACKBONE
            event.backbone_reason = reason
            event.last_error = error_message[:1000]
            event.lease_until = None
    logger.error(
        "Dispatch event %s escalated to the Backbone (%s) after %s attempt(s): %s",
        event_id,
        reason,
        attempts,
        error_message,
    )


async def _mark_retry(
    session_factory: async_sessionmaker[AsyncSession],
    event_id: str,
    attempts: int,
    error_message: str,
    delay_seconds: int | None = None,
) -> str:
    """Schedule a retry with exponential backoff; escalate past the cap.

    Returns the resulting status (``pending`` or ``backbone``) so callers
    report truthful outcomes.
    """
    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(DispatchOutbox, event_id, with_for_update=True)
            if event is None:
                raise RuntimeError(f"Claimed dispatch event {event_id} no longer exists.")
            event.last_error = error_message[:1000]
            event.lease_until = None
            if attempts >= MAX_DISPATCH_ATTEMPTS:
                event.status = STATUS_BACKBONE
                event.backbone_reason = BACKBONE_ATTEMPTS_EXHAUSTED
                resulting_status = STATUS_BACKBONE
            else:
                event.status = STATUS_PENDING
                delay = delay_seconds if delay_seconds is not None else min(
                    2**attempts, MAX_RETRY_DELAY_SECONDS
                )
                event.available_at = now + timedelta(seconds=max(delay, 0))
                resulting_status = STATUS_PENDING
    if attempts >= MAX_DISPATCH_ATTEMPTS:
        logger.error(
            "Dispatch event %s escalated to the Backbone (%s) after %s attempts: %s",
            event_id,
            BACKBONE_ATTEMPTS_EXHAUSTED,
            attempts,
            error_message,
        )
    else:
        logger.warning(
            "Dispatch event %s failed on attempt %s; retrying in %s seconds: %s",
            event_id,
            attempts,
            delay_seconds if delay_seconds is not None else min(2**attempts, MAX_RETRY_DELAY_SECONDS),
            error_message,
        )
    return resulting_status


def _parse_retry_after(response: httpx.Response) -> int | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return max(int(float(value)), 0)
    except (TypeError, ValueError):
        return None


async def inject_draft_once(
    session_factory: async_sessionmaker[AsyncSession],
    config: DispatchConfig,
    token_manager: GraphTokenManager,
    *,
    now_fn: Callable[[], float] = time.time,
    client: httpx.AsyncClient | None = None,
) -> str:
    """Claim and dispatch at most one outbox event.

    Returns one of ``"idle"``, ``"injected"``, ``"retry"`` or ``"backbone"``.
    """
    claimed = await _claim_dispatch(session_factory)
    if claimed is None:
        return "idle"
    event_id, payload, attempts = claimed

    # Compose from the frozen approved payload (pure, no I/O).
    try:
        draft = compose_quote_draft(payload)
    except DraftCompositionError as error:
        await _mark_backbone(
            session_factory, event_id, attempts, error.reason, str(error)
        )
        return "backbone"

    endpoint = draft_creation_endpoint(config.mailbox_id)
    token = await token_manager.get_access_token()
    own_client = client is None
    http = client or httpx.AsyncClient(timeout=15.0)
    error_message: str | None = None
    retry_after: int | None = None
    sla_ms: int | None = None
    try:
        response = await http.post(
            endpoint,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json={
                "subject": draft["subject"],
                "body": {"contentType": "HTML", "content": draft["html"]},
                "toRecipients": draft["to_recipients"],
                "attachments": [],
            },
        )
        if response.status_code == 201:
            ingested_at = payload.get("quote_ingested_at")
            if ingested_at:
                try:
                    ingested = datetime.fromisoformat(str(ingested_at))
                    if ingested.tzinfo is None:
                        ingested = ingested.replace(tzinfo=timezone.utc)
                    sla_ms = max(int((now_fn() - ingested.timestamp()) * 1000), 0)
                except (TypeError, ValueError):
                    sla_ms = None
            await _mark_injected(session_factory, event_id, sla_ms)
            logger.info(
                "Dispatch event %s: draft created in Drafts folder (%s line item(s)).",
                event_id,
                draft["line_count"],
            )
            return "injected"
        if response.status_code == 429:
            retry_after = _parse_retry_after(response)
            error_message = "Microsoft Graph throttled the request (HTTP 429)"
        elif response.status_code == 401:
            # Credential rejected: drop the cached token; the next attempt
            # silently re-acquires. Treated as transient.
            await token_manager.invalidate()
            error_message = "Microsoft Graph rejected the bearer token (HTTP 401)"
        elif response.status_code in (403, 404):
            await _mark_backbone(
                session_factory,
                event_id,
                attempts,
                BACKBONE_MAILBOX_UNREACHABLE,
                f"Microsoft Graph returned HTTP {response.status_code} for the "
                "dispatch mailbox; routing to the Backbone.",
            )
            return "backbone"
        elif response.status_code in (400, 422):
            await _mark_backbone(
                session_factory,
                event_id,
                attempts,
                BACKBONE_INVALID_DRAFT,
                f"Microsoft Graph rejected the draft payload with HTTP "
                f"{response.status_code}: {response.text[:300]}",
            )
            return "backbone"
        else:
            error_message = (
                f"Microsoft Graph returned HTTP {response.status_code}"
            )
    except DispatchAuthError as error:
        error_message = f"Azure AD token acquisition failed: {error}"
        await _mark_backbone(
            session_factory, event_id, attempts, BACKBONE_AUTH, error_message
        )
        return "backbone"
    except httpx.TimeoutException:
        error_message = "Microsoft Graph request timed out"
    except httpx.RequestError as error:
        error_message = f"Microsoft Graph request failed: {type(error).__name__}"
    finally:
        if own_client:
            await http.aclose()

    return await _mark_retry(
        session_factory,
        event_id,
        attempts,
        error_message or "unknown error",
        delay_seconds=retry_after,
    )


async def deliver_dispatch_outbox(
    session_factory: async_sessionmaker[AsyncSession],
    config: DispatchConfig,
    token_manager: GraphTokenManager,
    *,
    now_fn: Callable[[], float] = time.time,
    poll_seconds: float = DISPATCH_POLL_SECONDS,
    client: httpx.AsyncClient | None = None,
) -> None:
    """Worker loop: drain the dispatch outbox forever (mirrors webhook worker)."""
    own_client = client is None
    http = client or httpx.AsyncClient(timeout=15.0)
    try:
        while True:
            outcome = await inject_draft_once(
                session_factory,
                config,
                token_manager,
                now_fn=now_fn,
                client=http,
            )
            if outcome == "idle":
                await asyncio.sleep(poll_seconds)
    finally:
        if own_client:
            await http.aclose()
