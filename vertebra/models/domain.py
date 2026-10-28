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
    aggregate_type: Literal[
        "prospect",
        "score",
        "dispatch",
        "calendar",
        "high_touch",
        "telemetry",
        "cluster",
        "reply",
    ]
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


# --------------------------------------------------------------------------- #
# Module 5 — ERP & competitor tech-stack profiling
# --------------------------------------------------------------------------- #


class QuotePortalType(StrEnum):
    """How a distributor actually takes quotes from customers today."""

    MANUAL_MAILTO = "manual_mailto"          # RFQ inbox / mailto: links
    STATIC_PDF_FORM = "static_pdf_form"      # downloadable PDF quote forms
    LEGACY_PORTAL = "legacy_portal"          # ASP.NET / WebForms-era portals
    MODERN_QUOTE_API = "modern_quote_api"    # configurator / CPQ / JSON APIs
    UNDETERMINED = "undetermined"


class ERPSignal(_Strict):
    """One grounded evidence hit for an ERP or portal classification."""

    source: Literal["page_body", "page_meta", "http_header", "ssl_cert", "job_posting"]
    keyword: str = Field(description="Signature the hit is attributed to")
    snippet: str = Field(max_length=400, description="Text around the match, for audit")
    url: str | None = None
    weight: float = Field(default=1.0, ge=0, le=2)


class ERPMetadata(_Strict):
    """Structured ``erp_metadata`` JSONB attached to a prospect profile."""

    detected_erp: str | None = None
    erp_family: str | None = None
    detection_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    quote_portal_type: QuotePortalType = QuotePortalType.UNDETERMINED
    portal_evidence: list[str] = Field(default_factory=list)
    signals: list[ERPSignal] = Field(default_factory=list)
    recommended_pitch_angle: str = Field(
        default="", description="Pitch angle tailored to their ERP integration surface"
    )
    ssl_issuer: str | None = None
    job_boards_scanned: list[str] = Field(default_factory=list)
    job_postings_scanned: int = Field(default=0, ge=0)
    profiled_at: datetime = Field(default_factory=utcnow)
    model_version: str = "erp-profiler/1.0"


# --------------------------------------------------------------------------- #
# Module 6 — Audit preview assets + margin-leakage estimator
# --------------------------------------------------------------------------- #


class LeakageEstimate(_Strict):
    """Deterministic annual net-margin leakage figure for the audit widget."""

    annual_net_margin_leakage: float = Field(ge=0, description="USD per year")
    revenue_basis_usd: float = Field(ge=0, description="Revenue the estimate was scaled to")
    monthly_rfq_volume: int = Field(ge=0)
    avg_order_value_usd: float = Field(ge=0)
    gross_margin_pct: float = Field(ge=0, le=1)
    capture_loss_rate: float = Field(ge=0, le=1)
    avg_quote_delay_hours: float = Field(ge=0)
    methodology: str = Field(description="Human-readable formula trace, shown on request")


class AuditPreview(_Strict):
    """A captured prospect page with the overlaid audit calculator widget."""

    prospect_id: str
    source_url: str
    asset_key: str
    audit_image_url: str = Field(description="Public CDN link embedded in Channel A + high-touch queue")
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    leakage: LeakageEstimate
    generated_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Module 7 — Spatial proximity clusters
# --------------------------------------------------------------------------- #


class LeadCluster(_Strict):
    """A regional tactical cluster of geocoded distributors."""

    cluster_id: str
    cluster_name: str
    anchor_city: str | None = None
    anchor_country: str | None = None
    centroid_lat: float = Field(ge=-90, le=90)
    centroid_lng: float = Field(ge=-180, le=180)
    radius_m: int = Field(ge=0)
    density_count: int = Field(ge=1)
    vertical_focus: str | None = None
    member_prospect_ids: list[str] = Field(default_factory=list)


class MeetingContext(_Strict):
    """Coordinates of a booked meeting, used to trigger localized hooks."""

    meeting_id: str | None = None
    prospect_id: str | None = None
    contact_first_name: str | None = None
    company_name: str | None = None
    vertical: str | None = None
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    scheduled_at: datetime | None = None


class RegionalHook(_Strict):
    """Localized outbound hook produced when a meeting lands in a cluster."""

    cluster_id: str
    cluster_name: str
    hook_text: str
    onboarded_this_month: int = Field(ge=0)
    meeting_id: str | None = None


# --------------------------------------------------------------------------- #
# Module 8 — Telemetry, visitor identity and intent alerts
# --------------------------------------------------------------------------- #


class TelemetryEventType(StrEnum):
    PORTAL_VISIT = "portal_visit"
    AUDIT_VIEW = "audit_view"
    DOCUMENT_DOWNLOAD = "document_download"
    PRICING_VIEW = "pricing_view"
    SESSION_END = "session_end"


class VisitorGeo(_Strict):
    """Geo-IP parameters resolved from Vercel edge headers."""

    city: str | None = None
    country: str | None = None
    region: str | None = None
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class TelemetryEvent(_Strict):
    """One visitor telemetry row (mirror of the ``telemetry_events`` table)."""

    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    prospect_id: str | None = None
    session_id: str
    event_type: TelemetryEventType
    url: str | None = None
    referrer: str | None = None
    city: str | None = None
    country: str | None = None
    latitude: float | None = None
    longitude: float | None = None
    user_agent: str | None = None
    device: Literal["desktop", "mobile", "bot"] | None = None
    duration_ms: int | None = Field(default=None, ge=0)
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime = Field(default_factory=utcnow)


class IntentAlert(_Strict):
    """A high-priority operator alert (Telegram / Slack / webhook)."""

    alert_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    prospect_id: str
    title: str
    body: str
    channels_attempted: list[str] = Field(default_factory=list)
    channels_delivered: list[str] = Field(default_factory=list)
    dedupe_key: str | None = None
    created_at: datetime = Field(default_factory=utcnow)


# --------------------------------------------------------------------------- #
# Module 9 — Closed-loop reply agent
# --------------------------------------------------------------------------- #


class ReplyIntent(StrEnum):
    """Intent classes for inbound prospect replies."""

    INTERESTED = "interested"
    OUT_OF_OFFICE = "out_of_office"
    SEND_INFORMATION = "send_information"
    NOT_INTERESTED = "not_interested"
    OBJECTION_PRICE = "objection_price"
    OBJECTION_ERP = "objection_erp"
    UNKNOWN = "unknown"


class AgentActionType(StrEnum):
    """Autonomous actions the reply agent may take."""

    BOOK_URGENT_CALL = "book_urgent_call"
    DRAFT_FOR_REVIEW = "draft_for_review"
    RESCHEDULE_SEQUENCE = "reschedule_sequence"
    SUPPRESS_SEQUENCE = "suppress_sequence"
    ESCALATE_HUMAN = "escalate_human"
    LOG_ONLY = "log_only"


class DraftStatus(StrEnum):
    PENDING_HUMAN_REVIEW = "pending_human_review"
    APPROVED = "approved"
    SENT = "sent"
    DISCARDED = "discarded"


class ReplyExtraction(_Strict):
    """Structured details the classifier pulls out of a reply."""

    return_date: datetime | None = Field(default=None, description="OOO return date (ISO-8601)")
    objection_type: Literal["price", "erp", "other"] | None = None
    requested_info: str | None = None
    meeting_readiness: bool = False
    delegate_contact: str | None = None


class InboundReply(_Strict):
    """A parsed inbound email from a prospect sequence."""

    reply_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    prospect_id: str | None = None
    message_id: str | None = None
    from_email: str
    subject: str | None = None
    body: str
    received_at: datetime = Field(default_factory=utcnow)
    intent: ReplyIntent = ReplyIntent.UNKNOWN
    intent_confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    rationale: str | None = None
    extracted: ReplyExtraction | None = None


class AgentDecision(_Strict):
    """What the agent decided and executed for one inbound reply."""

    reply_id: str
    prospect_id: str | None = None
    intent: ReplyIntent
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    rationale: str = ""
    actions: list[AgentActionType] = Field(default_factory=list)
    draft_subject: str | None = None
    draft_body: str | None = None
    calendar_event_id: str | None = None
    calendar_event_link: str | None = None
    rescheduled_to: datetime | None = None
    review_required: bool = False
    decided_at: datetime = Field(default_factory=utcnow)
