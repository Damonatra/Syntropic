"""Typed error hierarchy for the Vertebra engine.

Every module raises errors from this tree so API layers can map failures to
precise HTTP semantics and the workers can apply targeted retry policies.
"""

from __future__ import annotations


class VertebraError(Exception):
    """Base class for all engine errors."""

    #: Suggests whether the failing operation is worth retrying.
    retryable: bool = False

    def __init__(self, message: str, *, context: dict | None = None) -> None:
        super().__init__(message)
        self.context = context or {}

    def __str__(self) -> str:  # pragma: no cover - trivial
        if self.context:
            return f"{super().__str__()} | context={self.context}"
        return super().__str__()


class IngestionError(VertebraError):
    """Directory scraping or parsing failure."""

    retryable = True


class EnrichmentError(VertebraError):
    """Email permutation or SMTP verification failure."""


class ScoringError(VertebraError):
    """Claude scoring pipeline failure (after fallbacks are exhausted)."""

    retryable = True


class DispatchError(VertebraError):
    """Outbound dispatch failure on either channel."""

    retryable = True


class CASLViolation(DispatchError):  # noqa: N818 - documented operator-facing contract name
    """Attempted dispatch that would breach Canadian CASL policy."""

    retryable = False


class ProfilerError(VertebraError):
    """ERP / competitor tech-stack profiling failure (Module 5)."""

    retryable = True


class AuditPreviewError(VertebraError):
    """Audit screenshot capture, widget composition or asset upload failure (Module 6)."""

    retryable = True


class SpatialError(VertebraError):
    """Spatial clustering or proximity-hook failure (Module 7)."""


class TelemetryError(VertebraError):
    """Telemetry ingestion or alert fan-out failure (Module 8)."""

    retryable = True


class ReplyAgentError(VertebraError):
    """Inbound-reply classification or autonomous action failure (Module 9)."""

    retryable = True
