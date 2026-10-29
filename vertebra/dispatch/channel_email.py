"""Channel A — automated outbound email through secondary domains.

Sends ride a rotating pool of secondary sending domains (``syntropic-os.com``
and siblings). Each domain carries daily and hourly caps tuned to mailbox
warmup curves, plus a minimum send gap so mail from one domain never lands in
machine-gun bursts. Delivery prefers the Resend HTTP API and falls back to
raw SMTP (aiosmtplib) when no Resend key is configured.

Compliance is non-negotiable here: CASL-scope recipients always carry the
identification footer and RFC 8058 one-click unsubscribe headers.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

import httpx

from vertebra.config.settings import EmailDispatchSettings, get_settings
from vertebra.logging_conf import get_logger
from vertebra.models.errors import CASLViolation, DispatchError

log = get_logger("dispatch.email")


# --------------------------------------------------------------------------- #
# Domain rotation with warmup-aware caps
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _DomainWindow:
    day_key: str
    day_count: int = 0
    hour_keys: dict[str, int] = field(default_factory=dict)
    last_send: float = 0.0


class DomainRotator:
    """Picks the next eligible sending domain under its rate caps."""

    def __init__(self, settings: EmailDispatchSettings) -> None:
        self._settings = settings
        self._domains = list(settings.sending_domains)
        self._windows: dict[str, _DomainWindow] = {d: _DomainWindow(day_key="") for d in self._domains}
        self._cursor = 0

    def next_domain(self, *, now: datetime | None = None) -> str:
        """Return the next domain with capacity (round-robin), or raise."""
        now = now or datetime.now(tz=UTC)
        day_key = now.strftime("%Y%m%d")
        hour_key = now.strftime("%Y%m%d%H")
        total = len(self._domains)

        for offset in range(total):
            domain = self._domains[(self._cursor + offset) % total]
            window = self._windows[domain]
            if window.day_key != day_key:
                window.day_key = day_key
                window.day_count = 0
                window.hour_keys.clear()
            if window.day_count >= self._settings.daily_cap_per_domain:
                continue
            if window.hour_keys.get(hour_key, 0) >= self._settings.hourly_cap_per_domain:
                continue
            self._cursor = (self._cursor + offset + 1) % total
            return domain

        raise DispatchError(
            "all sending domains exhausted for this window",
            context={"domains": self._domains, "hour": hour_key},
        )

    def record_send(self, domain: str, *, now: datetime | None = None) -> None:
        now = now or datetime.now(tz=UTC)
        window = self._windows[domain]
        window.day_count += 1
        hour_key = now.strftime("%Y%m%d%H")
        window.hour_keys[hour_key] = window.hour_keys.get(hour_key, 0) + 1
        window.last_send = time.monotonic()

    async def wait_for_gap(self, domain: str) -> None:
        """Sleep until the domain's minimum send gap has elapsed."""
        window = self._windows[domain]
        elapsed = time.monotonic() - window.last_send
        remaining = self._settings.min_send_gap_sec - elapsed
        if remaining > 0:
            await asyncio.sleep(remaining)


# --------------------------------------------------------------------------- #
# Dispatcher
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class OutboundEmail:
    """A fully-composed, compliance-cleared email ready for the wire."""

    prospect_id: str
    from_domain: str
    from_email: str
    to_email: str
    subject: str
    body_text: str
    headers: dict[str, str]
    reply_to: str | None = None


class EmailDispatcher:
    """Resend-first, SMTP-fallback sender honouring CASL headers."""

    def __init__(
        self,
        settings: EmailDispatchSettings | None = None,
        rotator: DomainRotator | None = None,
    ) -> None:
        self._settings = settings or get_settings().email
        self._rotator = rotator or DomainRotator(self._settings)
        self._http: httpx.AsyncClient | None = None

    @property
    def rotator(self) -> DomainRotator:
        return self._rotator

    @property
    def active_provider(self) -> str:
        """Provider the current configuration resolves to."""
        if self._settings.resend_api_key is not None:
            return "resend"
        if self._settings.smtp_host:
            return "smtp"
        return "none"

    # ---------------------------------------------------------------- compose
    def compose(
        self,
        *,
        prospect_id: str,
        to_email: str,
        to_name: str | None,
        subject: str,
        body: str,
        casl_scope: bool,
        footer: str | None,
        headers: dict[str, str],
    ) -> OutboundEmail:
        """Assemble the outbound message; enforce CASL kit when in scope."""
        if casl_scope and not footer:
            raise CASLViolation(
                "CASL-scope send attempted without a compliance footer",
                context={"prospect_id": prospect_id, "to": to_email},
            )
        body_text = f"{body}\n\n--\n{footer}".rstrip() if footer else body
        domain = self._rotator.next_domain()
        mailbox = "growth"
        return OutboundEmail(
            prospect_id=prospect_id,
            from_domain=domain,
            from_email=formataddr((self._settings.from_display_name, f"{mailbox}@{domain}")),
            to_email=to_email,
            subject=subject,
            body_text=body_text,
            headers=headers,
            reply_to=self._settings.reply_to,
        )

    # ------------------------------------------------------------------- send
    async def send(self, email: OutboundEmail) -> str:
        """Deliver via Resend if configured, else SMTP. Returns provider id."""
        if self._settings.resend_api_key is not None:
            message_id = await self._send_resend(email)
            provider = "resend"
        elif self._settings.smtp_host:
            message_id = await self._send_smtp(email)
            provider = "smtp"
        else:
            raise DispatchError(
                "no delivery provider configured (set VERTEBRA_EMAIL__RESEND_API_KEY or SMTP_* )",
                context={"prospect_id": email.prospect_id},
            )
        self._rotator.record_send(email.from_domain)
        log.info(
            "email_sent",
            provider=provider,
            from_domain=email.from_domain,
            prospect_id=email.prospect_id,
            message_id=message_id,
        )
        return message_id

    async def _send_resend(self, email: OutboundEmail) -> str:
        assert self._settings.resend_api_key is not None
        if self._http is None:
            self._http = httpx.AsyncClient(
                base_url=self._settings.resend_base_url,
                headers={"Authorization": f"Bearer {self._settings.resend_api_key.get_secret_value()}"},
                timeout=20.0,
            )
        payload: dict[str, object] = {
            "from": email.from_email,
            "to": [email.to_email],
            "subject": email.subject,
            "text": email.body_text,
        }
        if email.reply_to:
            payload["reply_to"] = email.reply_to
        payload["headers"] = {
            **email.headers,
            "X-Entity-Ref-ID": email.prospect_id,
        }
        response = await self._http.post("/emails", json=payload)
        if response.status_code >= 400:
            raise DispatchError(
                f"resend rejected send ({response.status_code})",
                context={"prospect_id": email.prospect_id, "body": response.text[:500]},
            )
        data = response.json()
        return str(data.get("id", "resend-unknown"))

    async def _send_smtp(self, email: OutboundEmail) -> str:
        message = EmailMessage()
        message["From"] = email.from_email
        message["To"] = email.to_email
        message["Subject"] = email.subject
        message["Message-ID"] = make_msgid(domain=email.from_domain)
        for key, value in email.headers.items():
            message[key] = value
        if email.reply_to:
            message["Reply-To"] = email.reply_to
        message.set_content(email.body_text)

        import aiosmtplib  # lazy heavy import

        assert self._settings.smtp_host is not None
        await aiosmtplib.send(
            message,
            hostname=self._settings.smtp_host,
            port=self._settings.smtp_port,
            username=self._settings.smtp_user.get_secret_value() if self._settings.smtp_user else None,
            password=self._settings.smtp_password.get_secret_value() if self._settings.smtp_password else None,
            start_tls=True,
        )
        return str(message["Message-ID"])

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None
