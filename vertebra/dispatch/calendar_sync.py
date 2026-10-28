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

    def _urgent_slot(self) -> tuple[datetime, datetime]:
        """Same-day 30-minute slot ~90 minutes out, clamped to business hours."""
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(self._settings.timezone)
        start = datetime.now(tz=tz) + timedelta(minutes=90)
        if start.hour < self._settings.work_start_hour:
            start = start.replace(
                hour=self._settings.work_start_hour, minute=0, second=0, microsecond=0
            )
        if start.weekday() >= 5 or start.hour >= self._settings.work_end_hour - 1:
            start = (start + timedelta(days=1)).replace(
                hour=self._settings.work_start_hour, minute=0, second=0, microsecond=0
            )
            while start.weekday() >= 5:
                start += timedelta(days=1)
        return start, start + timedelta(minutes=30)

    # -------------------------------------------------------- urgent call slot
    async def create_urgent_call_invite(
        self,
        *,
        company_name: str,
        contact_name: str,
        prospect_id: str,
        intent: str,
        reply_excerpt: str = "",
        qlv_score: int | None = None,
        audit_image_url: str | None = None,
    ) -> dict[str, str]:
        """Book an urgent same-day call for an INTERESTED reply (Module 9).

        Inserts directly into the Josias calendar with a Meet link and a
        popup reminder at T-0. ``colorId`` 11 (red) is deliberate Google
        Calendar urgency semantics for the operator — the Vertebra UI itself
        stays strictly achromatic per DESIGN.md.
        """
        start, _end = self._urgent_slot()
        score_line = f"QLV {qlv_score}/100" if qlv_score is not None else "QLV pending"
        description_lines = [
            "Vertebra closed-loop agent booked this call from an INTERESTED reply.",
            "",
            f"Company: {company_name}",
            f"Contact: {contact_name}",
            f"Score: {score_line}",
            f"Detected intent: {intent}",
            f"Prospect ID: {prospect_id}",
        ]
        if audit_image_url:
            description_lines.append(f"Audit preview: {audit_image_url}")
        if reply_excerpt:
            description_lines += ["", "Reply excerpt:", reply_excerpt]

        body: dict[str, Any] = {
            "id": uuid.uuid5(uuid.NAMESPACE_URL, f"vertebra-urgent:{prospect_id}").hex,
            "summary": f"URGENT CALL — {company_name} ({contact_name})",
            "description": "\n".join(description_lines),
            "start": {"dateTime": start.isoformat(), "timeZone": self._settings.timezone},
            "end": {"dateTime": (start + timedelta(minutes=30)).isoformat(), "timeZone": self._settings.timezone},
            "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
            "conferenceData": {
                "createRequest": {
                    "requestId": uuid.uuid4().hex,
                    "conferenceSolutionKey": {"type": "hangoutsMeet"},
                }
            },
            "colorId": "11",
            "transparency": "opaque",
            "source": {"title": "Vertebra Reply Agent", "url": "https://syntropic-os.com"},
        }

        def _create() -> dict[str, Any]:
            service = self._google_service()
            return (
                service.events()
                .insert(
                    calendarId=self._settings.calendar_id,
                    body=body,
                    conferenceDataVersion=1,
                    sendUpdates="all",
                )
                .execute()
            )

        created = await asyncio.to_thread(_create)
        event_id = str(created.get("id", body["id"]))
        log.info(
            "urgent_call_booked",
            company=company_name,
            contact=contact_name,
            event_id=event_id,
            start=start.isoformat(),
        )
        return {
            "event_id": event_id,
            "html_link": str(created.get("htmlLink", "")),
            "start": str(created.get("start", {}).get("dateTime", start.isoformat())),
        }

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
