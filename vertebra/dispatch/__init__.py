"""Dispatch package: dual-channel outbound routing.

- Channel A: automated outbound email through rotating secondary domains
  (Resend HTTP API with raw-SMTP fallback), CASL-compliant.
- Channel B: the Josias High-Touch queue — structured CSV exports, outbox
  events in Neon Postgres and Google Calendar follow-up automation.
"""

from vertebra.dispatch.calendar_sync import CalendarSync
from vertebra.dispatch.channel_email import DomainRotator, EmailDispatcher
from vertebra.dispatch.high_touch import HighTouchExporter
from vertebra.dispatch.router import DispatchRouter

__all__ = ["CalendarSync", "DispatchRouter", "DomainRotator", "EmailDispatcher", "HighTouchExporter"]
