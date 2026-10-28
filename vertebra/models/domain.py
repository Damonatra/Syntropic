"""Pydantic v2 domain models shared by every Vertebra module."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


def utcnow() -> datetime:
    """Timezone-aware UTC now (never use naive datetimes across the engine)."""
    return datetime.now(tz=timezone.utc)


class _Strict(BaseModel):
    """Base model: strict-ish, immutable-friendly, extra values rejected."""

    model_config = ConfigDict(extra="forbid", validate_assignment=True, str_strip_whitespace=True)


class Vertical(StrEnum):
    """Industrial verticals Syntropic targets in Q4."""

    PVF = "pvf"                    # Pipe, Valve & Fitting
    ELECTRICAL = "electrical"
    HVAC = "hvac"
    FLUID_POWER = "fluid_power"    # Hydraulics, pneumatics, motion control


class Region(StrEnum):
    """Serving region."""

    US = "us"
    CA = "ca"


class ExecutiveRole(StrEnum):
    """Roles that own RFQ latency pain in distribution businesses."""

    CEO = "ceo"
    PRESIDENT = "president"
    OWNER = "owner"
    COO = "coo"
    VP_SALES = "vp_sales"
    VP_OPERATIONS = "vp_operations"
    SALES_DIRECTOR = "sales_director"
    BRANCH_MANAGER = "branch_manager"
    PROCUREMENT_LEAD = "procurement_lead"
    UNKNOWN = "unknown"


class IngestionStatus(StrEnum):
    PENDING = "pending"
    INGESTED = "ingested"
    FILTERED = "filtered"          # Rejected by revenue/vertical corridor
    FAILED = "failed"


class Channel(StrEnum):
    """Outbound channel decided by the dispatch router."""

    AUTOMATED_EMAIL = "channel_a_automated_email"
    HIGH_TOUCH = "channel_b_josias_high_touch"


class CompanyRecord(_Strict):
    """A raw company scraped from an industrial directory."""

    source: str = Field(description="Directory identifier, e.g. 'blue_book_pvf'")
    source_url: str = Field(description="URL the record was parsed from")
    name: str = Field(min_length=2, max_length=200)
    domain: str | None = Field(default=None, description="Registrable domain, e.g. 'acmevalve.com'")
    website: HttpUrl | None = None
    vertical: Vertical | None = None
    region: Region | None = None
    city: str | None = None
    state_province: str | None = None
    country: str | None = None
    postal_code: str | None = None
    employee_count: int | None = Field(default=None, ge=1)
    revenue_estimate_usd: int | None = Field(default=None, ge=0)
    revenue_confidence: Literal["exact", "estimated", "banded", "unknown"] = "unknown"
    detected_erp: str | None = Field(default=None, description="ERP / portal signature, e.g. 'Epicor Eclipse'")
    raw_excerpt: str | None = Field(default=None, description="Short raw text excerpt kept for audit")
    scraped_at: datetime = Field(default_factory=utcnow)

    @field_validator("domain", mode="before")
    @classmethod
    def _normalise_domain(cls, value: str | None) -> str | None:
        if value is None:
            return None
        domain = str(value).strip().lower().replace("http://", "").replace("https://", "")
        domain = domain.split("/")[0].split("?")[0].strip(".")
        return domain or None


class Contact(_Strict):
    """An executive contact harvested or inferred for a company."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    company_name: str
    first_name: str = Field(min_length=1)
    last_name: str = Field(min_length=1)
    role: ExecutiveRole = ExecutiveRole.UNKNOWN
    title_raw: str | None = None
    linkedin_url: str | None = None


class EmailCandidate(_Strict):
    """A deterministic email permutation generated for a contact."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    contact_id: str | None = None
    address: str = Field(description="Lowercase full email address")
    pattern: str = Field(description="Permutation pattern name, e.g. 'first.last'")
    domain: str
    is_casl_scope: bool = Field(default=False, description="True when the mailbox is under Canadian CASL")
    syntax_valid: bool = False
    verified: bool = False
    verification_method: Literal["none", "mx", "smtp_rcpt", "catch_all_neutral"] = "none"
    smtp_code: int | None = None
    verified_at: datetime | None = None

    @field_validator("address")
    @classmethod
    def _lowercase(cls, value: str) -> str:
        return value.strip().lower()


class SmtpVerification(_Strict):
    """Result of a live SMTP RCPT TO handshake probe."""

    address: str
    deliverable: bool
    method: Literal["none", "mx", "smtp_rcpt", "catch_all_neutral"]
    smtp_code: int | None = None
    mx_host: str | None = None
    detail: str | None = None
    checked_at: datetime = Field(default_factory=utcnow)


class QLVFactor(_Strict):
    """One scored factor contributing to the Quote Leakage Vulnerability Score."""

    key: Literal[
        "rfq_latency",
        "legacy_portal",
        "unapplied_spa",
        "manual_quoting_share",
        "vertical_fit",
        "size_fit",
    ]
    weight: float = Field(ge=0, le=1)
    points: float = Field(ge=0, le=100, description="0-100 severity of this factor")
    evidence: str = Field(description="Grounded evidence string cited from prospect data")


class Hook(_Strict):
    """A hyper-personalised cold-email hook authored by Claude."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    flavor: Literal["rfq_latency", "spa_leakage", "portal_drift", "peer_proof"]
    body: str = Field(min_length=40, max_length=600)
    reference_company: str | None = Field(default=None, description="Peer company used for social proof")


class ScoreResult(_Strict):
    """Quote Leakage Vulnerability Score produced by ``vertebra.ai.scorer``."""

    prospect_id: str
    company_name: str
    qlv_score: int = Field(ge=1, le=100)
    band: Literal["low", "medium", "high", "critical"]
    factors: list[QLVFactor] = Field(min_length=1)
    hooks: list[Hook] = Field(min_length=1)
    rationale: str = Field(min_length=40, description="Why this score, in plain business English")
    model: str = Field(description="Model that produced the score, e.g. claude-3-5-sonnet-latest")
    scored_at: datetime = Field(default_factory=utcnow)
    input_fingerprint: str = Field(description="SHA-256 of the normalised scoring input (cache key)")

    @property
    def top_factors(self) -> list[QLVFactor]:
        return sorted(self.factors, key=lambda f: f.weight * f.points, reverse=True)


class DispatchDecision(_Strict):
    """Router verdict for one scored prospect."""

    prospect_id: str
    channel: Channel
    casl_scope: bool
    footer_template: str | None = Field(default=None, description="CASL footer applied to Channel A sends")
    subject: str | None = None
    body: str | None = None
    from_domain: str | None = None
    send_after: datetime | None = Field(default=None, description="Throttled earliest send time")
    reasons: list[str] = Field(default_factory=list)
    decided_at: datetime = Field(default_factory=utcnow)


class OutboxEvent(_Strict):
    """Transactional outbox event — written in the same DB tx as state change."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    aggregate_type: Literal["prospect", "score", "dispatch", "calendar", "high_touch"]
    aggregate_id: str
    event_type: str = Field(description="e.g. 'prospect.scored', 'dispatch.email.queued'")
    payload: dict[str, Any]
    created_at: datetime = Field(default_factory=utcnow)
    published_at: datetime | None = None
    attempts: int = 0
    last_error: str | None = None


class HighTouchQueueItem(_Strict):
    """One row of the Josias high-touch CSV queue (Channel B)."""

    prospect_id: str
    company_name: str
    contact_first: str
    contact_last: str
    role: str
    email: str | None
    phone: str | None = None
    city: str | None = None
    state_province: str | None = None
    region: Region
    vertical: Vertical
    qlv_score: int
    qlv_band: str
    top_hook: str
    rationale: str
    detected_erp: str | None = None
    calendar_event_id: str | None = Field(default=None, description="Google Calendar follow-up event")
    created_at: datetime = Field(default_factory=utcnow)


class Prospect(_Strict):
    """A fully processed prospect: ingested → enriched → scored."""

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    company: CompanyRecord
    contacts: list[Contact] = Field(default_factory=list)
    email_candidates: list[EmailCandidate] = Field(default_factory=list)
    best_email: str | None = None
    casl_scope: bool = False
    casl_reason: str | None = None
    ingestion: IngestionStatus = IngestionStatus.PENDING
    filter_reason: str | None = None
    score: ScoreResult | None = None
    dispatch: DispatchDecision | None = None
    updated_at: datetime = Field(default_factory=utcnow)

    @property
    def primary_contact(self) -> Contact | None:
        return self.contacts[0] if self.contacts else None
