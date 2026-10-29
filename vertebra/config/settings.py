"""Central configuration for the Vertebra engine.

All settings are declared once here with Pydantic v2 validation. Values are
read from the process environment (12-factor) or a ``.env`` file at the
project root, with the ``VERTEBRA_`` prefix and ``__`` as the nesting
delimiter, e.g. ``VERTEBRA_DATABASE__DSN``.
"""

from __future__ import annotations

from enum import StrEnum
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Verticals Syntropic targets for Q4 enterprise pipeline.
TARGET_VERTICALS: tuple[str, ...] = ("pvf", "electrical", "hvac", "fluid_power")

#: Revenue corridor (USD) that defines the ideal distributor profile.
REVENUE_FLOOR_USD: int = 10_000_000
REVENUE_CEILING_USD: int = 150_000_000


class Environment(StrEnum):
    """Deployment environment."""

    LOCAL = "local"
    STAGING = "staging"
    PRODUCTION = "production"


class DatabaseSettings(BaseModel):
    """Neon serverless Postgres connection policy."""

    dsn: SecretStr = Field(
        description="Neon Postgres DSN, e.g. postgresql://user:pass@ep-xyz.us-east-2.aws.neon.tech/vertebra?sslmode=require"
    )
    min_pool_size: int = Field(default=1, ge=1, le=32)
    max_pool_size: int = Field(default=10, ge=1, le=128)
    command_timeout_sec: float = Field(default=30.0, gt=0)
    # Neon routes through PgBouncer in transaction mode which does not support
    # server-side prepared statement caching — it must be disabled.
    statement_cache_size: int = Field(default=0, ge=0)
    idle_timeout_sec: float = Field(default=300.0, gt=0)

    @property
    def asyncpg_dsn(self) -> str:
        """DSN normalised for asyncpg (drives to postgresql scheme)."""
        raw = self.dsn.get_secret_value()
        if raw.startswith("postgres://"):
            raw = raw.replace("postgres://", "postgresql://", 1)
        return raw


class QdrantSettings(BaseModel):
    """Qdrant vector search connection policy."""

    url: str = Field(description="Qdrant endpoint, e.g. https://qdrant.example.cloud:6333")
    api_key: SecretStr | None = None
    collection: str = Field(default="vertebra_firmographics")
    vector_size: int = Field(default=64, ge=8, le=4096)
    prefer_grpc: bool = False
    timeout_sec: float = Field(default=15.0, gt=0)


class AnthropicSettings(BaseModel):
    """Claude API policy used by the scoring module."""

    api_key: SecretStr = Field(description="Anthropic API key")
    model: str = Field(default="claude-3-5-sonnet-latest")
    max_tokens: int = Field(default=1600, ge=256, le=8192)
    temperature: float = Field(default=0.2, ge=0.0, le=1.0)
    timeout_sec: float = Field(default=45.0, gt=0)
    max_retries: int = Field(default=2, ge=0, le=8)


class EmailDispatchSettings(BaseModel):
    """Channel A — automated outbound via secondary domains."""

    # Rotating pool of secondary sending domains, e.g. syntropic-os.com.
    sending_domains: list[str] = Field(default_factory=lambda: ["syntropic-os.com"])
    # Per-domain daily caps honouring mailbox-provider warmup curves.
    daily_cap_per_domain: int = Field(default=40, ge=1, le=2000)
    hourly_cap_per_domain: int = Field(default=8, ge=1, le=500)
    # Gap between sends from the same domain to look human.
    min_send_gap_sec: float = Field(default=90.0, ge=0)
    from_display_name: str = Field(default="Syntropic Industrial Growth")
    reply_to: str | None = None
    # Resend HTTP API (preferred) with raw SMTP fallback.
    resend_api_key: SecretStr | None = None
    resend_base_url: str = Field(default="https://api.resend.com")
    smtp_host: str | None = None
    smtp_port: int = Field(default=587, ge=1, le=65535)
    smtp_user: SecretStr | None = None
    smtp_password: SecretStr | None = None

    @field_validator("sending_domains")
    @classmethod
    def _require_domains(cls, value: list[str]) -> list[str]:
        cleaned = [d.strip().lower() for d in value if d.strip()]
        if not cleaned:
            raise ValueError("at least one sending domain is required")
        return cleaned


class GoogleCalendarSettings(BaseModel):
    """Channel B — Google Calendar follow-up automation."""

    service_account_file: str = Field(description="Path to the Google service account JSON key")
    calendar_id: str = Field(default="primary")
    timezone: str = Field(default="America/Chicago")
    # Working window in which high-touch follow-ups may be scheduled.
    work_start_hour: int = Field(default=8, ge=0, le=23)
    work_end_hour: int = Field(default=17, ge=1, le=24)
    followup_offset_days: int = Field(default=2, ge=0, le=30)
    reminder_minutes: list[int] = Field(default_factory=lambda: [1440, 60])


class ScrapingSettings(BaseModel):
    """Politeness and robustness policy for directory ingestion."""

    user_agent: str = Field(
        default="VertebraBot/1.0 (+https://syntropic.com/vertebra-bot; compliance@syntropic.com)"
    )
    max_concurrency: int = Field(default=6, ge=1, le=64)
    request_timeout_sec: float = Field(default=20.0, gt=0)
    max_retries: int = Field(default=3, ge=0, le=10)
    # Per-host rate limit (requests/second) to respect directory operators.
    host_rate_limit_rps: float = Field(default=0.5, gt=0)
    respect_robots_txt: bool = True
    proxy_url: str | None = None


class CaslSettings(BaseModel):
    """Canadian Anti-Spawn Legislation compliance policy."""

    default_footer_ca: str = Field(
        default=(
            "You are receiving this one-time business inquiry because Syntropic believes "
            "it is relevant to your role. Syntropic Engine LLC, compliance@syntropic.com. "
            "Prefer not to hear from us again? Unsubscribe instantly: {unsubscribe_url}"
        )
    )
    default_footer_us: str = Field(
        default=(
            "Sent by Syntropic Engine LLC. Don't want these emails? "
            "Unsubscribe: {unsubscribe_url}"
        )
    )
    unsubscribe_base_url: str = Field(default="https://syntropic-os.com/u")
    # CASL requires a functioning unsubscribe honoured within 10 business days.
    unsubscribe_sla_days: int = Field(default=10, ge=1, le=30)


class ErpProfilerSettings(BaseModel):
    """Module 5 — ERP & competitor tech-stack profiling policy."""

    crawl_paths: list[str] = Field(
        default_factory=lambda: [
            "/", "/rfq", "/request-a-quote", "/request-quote", "/quote",
            "/contact", "/contact-us", "/products", "/catalog", "/about",
        ]
    )
    page_fetch_max_bytes: int = Field(default=400_000, ge=10_000, le=5_000_000)
    scan_job_boards: bool = Field(default=True, description="Scan Greenhouse/Lever/Ashby for ERP keywords")
    job_board_timeout_sec: float = Field(default=12.0, gt=0, le=60)
    # Minimum evidence score before an ERP name is asserted on the record.
    detection_confidence_floor: float = Field(default=0.9, ge=0.0, le=2.0)
    sync_qdrant_payload: bool = Field(default=True, description="Mirror ERP fields onto the Qdrant point")


class AuditPreviewSettings(BaseModel):
    """Module 6 — screenshot capture + audit asset storage policy."""

    viewport_width: int = Field(default=1440, ge=320, le=7680)
    viewport_height: int = Field(default=900, ge=240, le=4320)
    device_scale_factor: int = Field(default=2, ge=1, le=4)
    navigation_timeout_ms: int = Field(default=30_000, ge=1_000, le=120_000)
    storage_backend: Literal["local", "s3"] = "local"
    s3_bucket: str | None = None
    s3_region: str | None = None
    s3_endpoint_url: str | None = None          # R2 / MinIO compatible endpoint
    aws_access_key_id: str | None = None
    aws_secret_access_key: SecretStr | None = None
    cdn_base_url: str | None = Field(default=None, description="Public CDN serving the assets")
    local_dir: str = Field(default="/var/lib/vertebra/audit-previews")
    portal_base_url: str = Field(default="https://syntropic-os.com")

    @property
    def asset_public_base_url(self) -> str:
        """Base URL under which stored asset keys resolve publicly."""
        return (self.cdn_base_url or f"{self.portal_base_url}/assets").rstrip("/")


class SpatialSettings(BaseModel):
    """Module 7 — spatial proximity clustering policy."""

    eps_meters: int = Field(
        default=80_000, ge=1_000, le=1_000_000, description="DBSCAN neighbourhood radius"
    )
    min_points: int = Field(default=3, ge=1, le=50, description="DBSCAN core-point threshold")
    seed_attach_km: int = Field(
        default=150, ge=10, le=1_000, description="Max distance to adopt a named seed cluster"
    )
    max_assign_km: int = Field(
        default=250, ge=10, le=2_000, description="Max distance for meeting→cluster assignment"
    )
    notify_on_meeting_proximity: bool = True


class TelemetrySettings(BaseModel):
    """Module 8 — visitor telemetry + high-intent alert fan-out."""

    tracking_hmac_secret: SecretStr = Field(
        description="HMAC secret for signed ?lid= tracking tokens (>= 16 chars)"
    )
    hot_prospect_score: int = Field(
        default=85, ge=1, le=100, description="QLV score that qualifies a prospect as hot"
    )
    hot_intent_heat: int = Field(
        default=40, ge=1, le=100, description="Live intent heat needed to page the operator"
    )
    alert_cooldown_minutes: int = Field(default=30, ge=1, le=1_440)
    telegram_bot_token: SecretStr | None = None
    telegram_chat_id: str | None = None
    slack_webhook_url: str | None = None
    alert_webhook_url: str | None = None

    @field_validator("tracking_hmac_secret")
    @classmethod
    def _require_real_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 16:
            raise ValueError("telemetry.tracking_hmac_secret must be at least 16 characters")
        return value


class ReplyAgentSettings(BaseModel):
    """Module 9 — autonomous closed-loop follow-up policy."""

    draft_max_words: int = Field(default=150, ge=40, le=400)
    ooo_buffer_hours: int = Field(default=2, ge=0, le=48, description="Grace added after an OOO return date")
    process_pending_limit: int = Field(default=25, ge=1, le=200)


class TacticalJobsSettings(BaseModel):
    """Autonomous scheduling policy for the advanced tactical modules (5-9).

    Each heavy job can be disabled independently — e.g. a worker image
    without Chromium sets ``audit_previews_enabled = false`` and the
    scheduler skips Module 6 without logging a failure every cycle.
    """

    erp_profiling_enabled: bool = Field(default=True)
    erp_profiling_batch: int = Field(default=8, ge=1, le=100)
    audit_previews_enabled: bool = Field(default=True)
    audit_previews_batch: int = Field(default=4, ge=1, le=50)
    spatial_clustering_enabled: bool = Field(default=True)
    reply_processing_enabled: bool = Field(default=True)


class DispatchPolicySettings(BaseModel):
    """Routing thresholds between Channel A and Channel B."""

    # Score at or above which the prospect is handled by the automated email
    # channel; below it goes to the Josias high-touch queue for manual craft.
    channel_a_min_score: int = Field(default=70, ge=1, le=100)
    # Canadian prospects always get the CASL-enforced single-click headers.
    enforce_casl_headers: bool = True
    # High-touch CSV export location (writable path or s3:// style handled by ops).
    high_touch_export_dir: str = Field(
        default="/tmp/vertebra/high-touch"  # noqa: S108 - operator-overridable default, no secrets
    )
    max_hooks_per_prospect: int = Field(default=3, ge=1, le=5)


class Settings(BaseSettings):
    """Root settings object for the Vertebra engine."""

    model_config = SettingsConfigDict(
        env_prefix="VERTEBRA_",
        env_nested_delimiter="__",
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        frozen=True,
    )

    env: Environment = Environment.LOCAL
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    log_json: bool = Field(default=True, description="Emit JSON logs for ingestion by log shippers")
    service_name: str = "vertebra"

    api_host: str = "0.0.0.0"  # noqa: S104 - container service binding, expected default
    api_port: int = Field(default=8000, ge=1, le=65535)

    database: DatabaseSettings
    qdrant: QdrantSettings
    anthropic: AnthropicSettings
    email: EmailDispatchSettings = EmailDispatchSettings()
    calendar: GoogleCalendarSettings
    scraping: ScrapingSettings = ScrapingSettings()
    casl: CaslSettings = CaslSettings()
    policy: DispatchPolicySettings = DispatchPolicySettings()

    # -- advanced tactical modules (5-9) -------------------------------------
    erp_profiler: ErpProfilerSettings = ErpProfilerSettings()
    audit_preview: AuditPreviewSettings = AuditPreviewSettings()
    spatial: SpatialSettings = SpatialSettings()
    telemetry: TelemetrySettings
    reply_agent: ReplyAgentSettings = ReplyAgentSettings()
    tactical_jobs: TacticalJobsSettings = TacticalJobsSettings()


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the cached process-wide settings singleton."""
    return Settings()  # type: ignore[call-arg]


def reset_settings_cache() -> None:
    """Clear the cached settings (used by tests and hot reconfiguration)."""
    get_settings.cache_clear()
