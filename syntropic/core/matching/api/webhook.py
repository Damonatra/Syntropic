"""Durable HMAC-signed webhook delivery for approved RFQ jobs."""

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from syntropic.core.matching.api.database import WebhookOutbox

logger = logging.getLogger(__name__)

MAX_DELIVERY_ATTEMPTS = 8
MAX_RETRY_DELAY_SECONDS = 60 * 60
WEBHOOK_LEASE_SECONDS = 60
WEBHOOK_POLL_SECONDS = 1
SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS = 300


def sign_webhook_payload(
    payload: dict[str, Any], secret: str, timestamp: int | None = None
) -> tuple[bytes, str, str]:
    """Sign canonical JSON with replay protection.

    The signature covers ``{unix_timestamp}.{body}`` (Stripe scheme) and the
    timestamp travels in its own header, so captured (body, signature) pairs
    expire after SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS. Returns the body, the
    ``sha256=...`` signature header value, and the timestamp header value.
    """
    if timestamp is None:
        timestamp = int(time.time())
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    signed_material = f"{timestamp}.".encode("utf-8") + body
    signature = hmac.new(
        secret.encode("utf-8"), signed_material, hashlib.sha256
    ).hexdigest()
    return body, f"sha256={signature}", str(timestamp)


def verify_webhook_signature(
    body: bytes,
    signature_header: str,
    timestamp_header: str,
    secret: str,
    tolerance_seconds: int = SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS,
) -> bool:
    """Receiver-side verification: constant-time compare + freshness window."""
    try:
        timestamp = int(str(timestamp_header).strip())
    except (TypeError, ValueError):
        return False
    if abs(time.time() - timestamp) > tolerance_seconds:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, str(signature_header).strip())


def get_webhook_config() -> tuple[str, str]:
    endpoint = os.getenv("WEBHOOK_URL", "").strip()
    secret = os.getenv("WEBHOOK_HMAC_SECRET", "")
    parsed = urlsplit(endpoint)
    secure_endpoint = bool(
        parsed.hostname
        and not parsed.username
        and not parsed.password
        and (
            parsed.scheme == "https"
            or (
                parsed.scheme == "http"
                and parsed.hostname in {"localhost", "127.0.0.1"}
            )
        )
    )
    if not secure_endpoint:
        raise RuntimeError(
            "WEBHOOK_URL must be an HTTPS URL, except for localhost development."
        )
    if len(secret.encode("utf-8")) < 32 or secret.startswith("replace-"):
        raise RuntimeError("WEBHOOK_HMAC_SECRET must be a random secret of at least 32 bytes.")
    return endpoint, secret


async def _claim_event(
    session_factory: async_sessionmaker[AsyncSession],
) -> tuple[str, dict[str, Any], int] | None:
    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        async with session.begin():
            statement = (
                select(WebhookOutbox)
                .where(
                    or_(
                        and_(
                            WebhookOutbox.status == "pending",
                            WebhookOutbox.available_at <= now,
                        ),
                        and_(
                            WebhookOutbox.status == "processing",
                            WebhookOutbox.lease_until <= now,
                        ),
                    )
                )
                .order_by(WebhookOutbox.available_at, WebhookOutbox.created_at)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            event = await session.scalar(statement)
            if event is None:
                return None
            event.status = "processing"
            event.attempts += 1
            event.lease_until = now + timedelta(seconds=WEBHOOK_LEASE_SECONDS)
            result = (event.event_id, dict(event.payload), event.attempts)
        return result


async def _mark_delivered(
    session_factory: async_sessionmaker[AsyncSession], event_id: str
) -> None:
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(WebhookOutbox, event_id, with_for_update=True)
            if event is None:
                raise RuntimeError(f"Claimed webhook event {event_id} no longer exists.")
            event.status = "delivered"
            event.delivered_at = datetime.now(timezone.utc)
            event.lease_until = None
            event.last_error = None


async def _mark_failed(
    session_factory: async_sessionmaker[AsyncSession],
    event_id: str,
    attempts: int,
    error_message: str,
) -> None:
    now = datetime.now(timezone.utc)
    async with session_factory() as session:
        async with session.begin():
            event = await session.get(WebhookOutbox, event_id, with_for_update=True)
            if event is None:
                raise RuntimeError(f"Claimed webhook event {event_id} no longer exists.")
            event.last_error = error_message[:1000]
            event.lease_until = None
            if attempts >= MAX_DELIVERY_ATTEMPTS:
                event.status = "failed"
                logger.error(
                    "Webhook event %s permanently failed after %s attempts: %s",
                    event_id,
                    attempts,
                    error_message,
                )
            else:
                event.status = "pending"
                delay = min(2**attempts, MAX_RETRY_DELAY_SECONDS)
                event.available_at = now + timedelta(seconds=delay)
                logger.warning(
                    "Webhook event %s failed on attempt %s; retrying in %s seconds: %s",
                    event_id,
                    attempts,
                    delay,
                    error_message,
                )


async def deliver_webhook_outbox(
    session_factory: async_sessionmaker[AsyncSession],
    endpoint: str,
    secret: str,
) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        while True:
            claimed = await _claim_event(session_factory)
            if claimed is None:
                await asyncio.sleep(WEBHOOK_POLL_SECONDS)
                continue

            event_id, payload, attempts = claimed
            body, signature, timestamp = sign_webhook_payload(payload, secret)
            error_message = None
            try:
                response = await client.post(
                    endpoint,
                    content=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Syntropic-Event-ID": event_id,
                        "X-Syntropic-Signature": signature,
                        "X-Syntropic-Timestamp": timestamp,
                    },
                )
                if not response.is_success:
                    error_message = f"webhook endpoint returned HTTP {response.status_code}"
            except httpx.TimeoutException:
                error_message = "webhook request timed out"
            except httpx.RequestError as error:
                error_message = f"webhook request failed: {type(error).__name__}"

            if error_message is None:
                await _mark_delivered(session_factory, event_id)
                logger.info("Webhook event %s delivered successfully.", event_id)
            else:
                await _mark_failed(
                    session_factory, event_id, attempts, error_message
                )
