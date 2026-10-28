"""Google Calendar automation for Channel B follow-ups.

Creates structured follow-up events inside the rep working window using a
Google service account. The Google API client is synchronous, so every call
is wrapped in ``asyncio.to_thread`` to keep the event loop responsive.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from vertebra.config.settings import GoogleCalendarSettings, get_settings
from vertebra.logging_conf import get_logger

log = get_logger("dispatch.calendar")


class CalendarSync:
    """Creates follow-up tasks/events for the Josias high-touch queue."""

    def __init__(self, settings: GoogleCalendarSettings | None = None) -> None:
        self._settings = settings or get_settings().calendar
        self._service: Any | None = None

    # ----------------------------------------------------------------- client
    def _google_service(self) -> Any:
        if self._service is not None:
            return self._service
        from google.oauth2 import service_account  # lazy heavy imports
        from googleapiclient.discovery import build

        scopes = ["https://www.googleapis.com/auth/calendar.events"]
        credentials = service_account.Credentials.from_service_account_file(
            self._settings.service_account_file, scopes=scopes
        )
        self._service = build("calendar", "v3", credentials=credentials, cache_discovery=False)
        return self._service

    # ------------------------------------------------------------------ event
    async def create_followup_event(
        self,
        *,
        company_name: str,
        contact_name: str,
        top_hook: str,
        qlv_score: int | None,
        prospect_id: str,
    ) -> str:
        """Create the follow-up event; returns the Google Calendar event id."""
        start, end = self._next_slot()
        body = self._event_body(company_name, contact_name, top_hook, qlv_score, prospect_id)

        def _create() -> str:
            service = self._google_service()
            created = (
                service.events()
                .insert(
                    calendarId=self._settings.calendar_id,
                    body=body,
                    sendUpdates="none",
                )
                .execute()
            )
            return str(created["id"])

        event_id = await asyncio.to_thread(_create)
        log.info(
            "calendar_event_created",
            company=company_name,
            event_id=event_id,
            start=start.isoformat(),
        )
        return event_id

    # ----------------------------------------------------------------- timing
    def _next_slot(self) -> tuple[datetime, datetime]:
        """Next free slot inside the configured working window (>= tomorrow)."""
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(self._settings.timezone)
        now = datetime.now(tz=tz)
        start = now.replace(hour=self._settings.work_start_hour, minute=0, second=0, microsecond=0)
        start += timedelta(days=self._settings.followup_offset_days)
        while start.weekday() >= 5:  # skip weekends
            start += timedelta(days=1)
        end = start.replace(hour=min(self._settings.work_end_hour, 23))
        return start.astimezone(timezone.utc), end.astimezone(timezone.utc)

    # ------------------------------------------------------------------ build
    def _event_body(
        self,
        company_name: str,
        contact_name: str,
        top_hook: str,
        qlv_score: int | None,
        prospect_id: str,
    ) -> dict[str, Any]:
        start, end = self._next_slot()
        score_line = f"QLV {qlv_score}/100" if qlv_score is not None else "QLV pending"
        reminders = [
            {"method": "popup", "minutes": minutes}
            for minutes in self._settings.reminder_minutes
        ]
        return {
            "id": uuid.uuid5(uuid.NAMESPACE_URL, f"vertebra:{prospect_id}").hex,
            "summary": f"High-touch follow-up — {company_name} ({score_line})",
            "description": (
                f"Josias high-touch queue follow-up.\n\n"
                f"Company: {company_name}\n"
                f"Contact: {contact_name}\n"
                f"Score: {score_line}\n"
                f"Prospect ID: {prospect_id}\n\n"
                f"Opening hook on file:\n{top_hook or '(no hook authored yet)'}\n"
            ),
            "start": {"dateTime": start.isoformat(), "timeZone": self._settings.timezone},
            "end": {"dateTime": end.isoformat(), "timeZone": self._settings.timezone},
            "reminders": {"useDefault": False, "overrides": reminders},
            "source": {"title": "Vertebra", "url": "https://syntropic-os.com"},
            "transparency": "opaque",
        }
