"""Composite operator alert fan-out: Telegram / Slack / generic webhook.

Used by the intent monitor (Module 8) for the high-intent pager and by the
spatial clusterer (Module 7) for meeting-proximity notices. Delivery is
best-effort by design: a dead channel is logged and skipped so a Telegram
outage never blocks telemetry ingestion.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx

from vertebra.config.settings import TelemetrySettings
from vertebra.logging_conf import get_logger

log = get_logger("telemetry.notifier")


class AlertDispatcher:
    """Fans a single alert out to every configured channel exactly once."""

    def __init__(
        self,
        settings: TelemetrySettings,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            headers={"User-Agent": "Vertebra-AlertDispatcher/1.0"},
        )
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ------------------------------------------------------------------ send
    async def dispatch(
        self, *, title: str, body: str, severity: str = "HIGH"
    ) -> tuple[list[str], list[str]]:
        """Deliver one alert; returns (channels_attempted, channels_delivered)."""
        attempted: list[str] = []
        delivered: list[str] = []

        token = self._settings.telegram_bot_token
        chat_id = self._settings.telegram_chat_id
        if token and chat_id:
            attempted.append("telegram")
            if await self._safe(self._send_telegram(token.get_secret_value(), chat_id, title, body)):
                delivered.append("telegram")

        if self._settings.slack_webhook_url:
            attempted.append("slack")
            if await self._safe(self._send_slack(title, body)):
                delivered.append("slack")

        if self._settings.alert_webhook_url:
            attempted.append("webhook")
            if await self._safe(self._send_webhook(title, body, severity)):
                delivered.append("webhook")

        if not attempted:
            log.warning("alert_no_channels_configured", title=title, severity=severity)
        else:
            log.info(
                "alert_dispatched",
                title=title,
                severity=severity,
                attempted=attempted,
                delivered=delivered,
            )
        return attempted, delivered

    # -------------------------------------------------------------- channels
    async def _send_telegram(self, token: str, chat_id: str, title: str, body: str) -> bool:
        response = await self._client.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={
                "chat_id": chat_id,
                # Plain text preserves the operator template verbatim.
                "text": f"{title}\n\n{body}",
                "disable_web_page_preview": True,
            },
        )
        response.raise_for_status()
        return bool(response.json().get("ok"))

    async def _send_slack(self, title: str, body: str) -> bool:
        response = await self._client.post(
            self._settings.slack_webhook_url,  # type: ignore[arg-type]
            json={"text": f"{title}\n\n{body}"},
        )
        response.raise_for_status()
        return True

    async def _send_webhook(self, title: str, body: str, severity: str) -> bool:
        response = await self._client.post(
            self._settings.alert_webhook_url,  # type: ignore[arg-type]
            json={
                "source": "vertebra",
                "severity": severity,
                "title": title,
                "body": body,
                "ts": datetime.now(tz=timezone.utc).isoformat(),
            },
        )
        response.raise_for_status()
        return True

    @staticmethod
    async def _safe(coro) -> bool:  # noqa: ANN001 - private coroutine helper
        try:
            return await coro
        except Exception as exc:  # noqa: BLE001 - one dead channel must not stop the rest
            log.warning("alert_channel_failed", error=f"{type(exc).__name__}: {exc}")
            return False
