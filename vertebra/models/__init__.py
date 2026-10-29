"""Shared Pydantic v2 domain models used across every Vertebra module."""

from __future__ import annotations

from vertebra.models.domain import (
    Channel,
    CompanyRecord,
    Contact,
    DispatchDecision,
    EmailCandidate,
    ExecutiveRole,
    Hook,
    IngestionStatus,
    OutboxEvent,
    Prospect,
    QLVFactor,
    Region,
    ScoreResult,
    SmtpVerification,
    Vertical,
)
from vertebra.models.errors import (
    CASLViolation,
    DispatchError,
    EnrichmentError,
    IngestionError,
    ScoringError,
    VertebraError,
)

__all__ = [
    "CASLViolation",
    "Channel",
    "CompanyRecord",
    "Contact",
    "DispatchDecision",
    "DispatchError",
    "EmailCandidate",
    "EnrichmentError",
    "ExecutiveRole",
    "Hook",
    "IngestionError",
    "IngestionStatus",
    "OutboxEvent",
    "Prospect",
    "QLVFactor",
    "Region",
    "ScoreResult",
    "ScoringError",
    "SmtpVerification",
    "Vertical",
    "VertebraError",
]
