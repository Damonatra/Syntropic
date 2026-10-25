"""Async SQLAlchemy persistence for the human review queue."""

from datetime import datetime
from typing import Any
import uuid

from sqlalchemy import DateTime, ForeignKey, Index, Integer, JSON, String, Text, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from security.ast_veto import (
    TenantIsolationViolationError,
    enforce_tenant_isolation,
)


class Base(DeclarativeBase):
    pass


# Sentinel tenant for rows written before tenant isolation existed. These
# require operational reassignment before multi-tenant go-live.
LEGACY_TENANT_ID = "__legacy__"

# Review-queue workflow statuses. PENDING_HITL jobs parked below the
# confidence automation floor share the same reviewer queue as flagged jobs.
FLAGGED_FOR_REVIEW_STATUS = "flagged_for_review"
PENDING_HITL_STATUS = "pending_hitl"
REVIEWABLE_STATUSES = (FLAGGED_FOR_REVIEW_STATUS, PENDING_HITL_STATUS)


class ReviewJob(Base):
    __tablename__ = "rfq_jobs"
    __table_args__ = (
        Index("ix_rfq_jobs_tenant_status", "tenant_id", "status"),
    )

    job_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    execution_result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    review_decision: Mapped[str | None] = mapped_column(String(16))
    review_note: Mapped[str | None] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class WebhookOutbox(Base):
    __tablename__ = "webhook_outbox"
    __table_args__ = (
        Index("ix_webhook_outbox_status_available", "status", "available_at"),
        Index("ix_webhook_outbox_tenant_status", "tenant_id", "status"),
    )

    event_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String(64), nullable=False)
    job_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("rfq_jobs.job_id"), nullable=False, unique=True
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="pending"
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


def approved_webhook_payload(
    job_id: str,
    filename: str,
    execution_result: dict[str, Any],
) -> dict[str, Any]:
    extracted_data = execution_result.get("extracted_data", {})
    line_items = extracted_data.get("line_items") or [
        {
            key: extracted_data[key]
            for key in ("part_number", "quantity", "unit_of_measure")
            if key in extracted_data
        }
    ]
    matched_items = execution_result.get("matched_catalog_items", [])
    return {
        "event": "rfq.approved",
        "job_id": job_id,
        "filename": filename,
        "confidence_score": execution_result.get("confidence_score"),
        "line_items": line_items,
        "matched_catalog_items": matched_items,
        # Margin telemetry from the SPA rebate interceptor: unapplied rebates,
        # volume-tier opportunities, cost-sheet lag. Downstream ERP consumers
        # can act on margin leakage without re-deriving it from the catalog.
        "rebate_flags": execution_result.get("rebate_flags", []),
        # Margin Defender decisions and per-line price deltas (quoted vs
        # pushed vs cost vs floor) so ERP consumers see every enforcement
        # action — including automatic repricing to floor — without
        # re-deriving it from the catalog.
        "margin_report": execution_result.get("margin_report", []),
        "price_deltas": execution_result.get("price_deltas", []),
    }


@enforce_tenant_isolation
async def save_review_job(
    session: AsyncSession,
    job_id: str,
    filename: str,
    status: str,
    execution_result: dict[str, Any],
    review_decision: str | None = None,
    review_note: str | None = None,
    *,
    tenant_id: str | None = None,
) -> ReviewJob | None:
    """Create or update a review job scoped to the bound tenant.

    Cross-tenant overwrite attempts return ``None`` without leaking the
    existence of the other tenant's row.
    """
    if not tenant_id:
        raise TenantIsolationViolationError(
            "Security Veto Triggered: save_review_job requires a tenant_id."
        )
    job = await session.get(ReviewJob, job_id)
    if job is None:
        job = ReviewJob(
            job_id=job_id,
            tenant_id=tenant_id,
            filename=filename,
            status=status,
            execution_result=execution_result,
            review_decision=review_decision,
            review_note=review_note,
        )
        session.add(job)
    else:
        if job.tenant_id != tenant_id:
            # Cross-tenant overwrite: reject silently (404 semantics at the
            # API layer; no information about the other tenant leaks).
            return None
        job.filename = filename
        job.status = status
        job.execution_result = execution_result
        job.review_decision = review_decision
        job.review_note = review_note
    if status == "completed" and execution_result.get(
        "webhook_dispatch_requested"
    ):
        event_id = str(
            uuid.uuid5(uuid.NAMESPACE_URL, f"syntropic:rfq.approved:{job_id}")
        )
        if await session.get(WebhookOutbox, event_id) is None:
            session.add(
                WebhookOutbox(
                    event_id=event_id,
                    tenant_id=tenant_id,
                    job_id=job_id,
                    payload=approved_webhook_payload(
                        job_id, filename, execution_result
                    ),
                )
            )
    await session.commit()
    await session.refresh(job)
    return job


@enforce_tenant_isolation
async def get_review_job(
    session: AsyncSession,
    job_id: str,
    *,
    for_update: bool = False,
    tenant_id: str | None = None,
) -> ReviewJob | None:
    if not tenant_id:
        raise TenantIsolationViolationError(
            "Security Veto Triggered: get_review_job requires a tenant_id."
        )
    statement = select(ReviewJob).where(
        ReviewJob.job_id == job_id,
        ReviewJob.tenant_id == tenant_id,
    )
    if for_update:
        statement = statement.with_for_update()
    return await session.scalar(statement)


@enforce_tenant_isolation
async def list_pending_review_jobs(
    session: AsyncSession,
    *,
    tenant_id: str | None = None,
) -> list[dict[str, str]]:
    if not tenant_id:
        raise TenantIsolationViolationError(
            "Security Veto Triggered: list_pending_review_jobs requires a tenant_id."
        )
    statement = (
        select(ReviewJob.job_id, ReviewJob.filename)
        .where(
            ReviewJob.status.in_(REVIEWABLE_STATUSES),
            ReviewJob.tenant_id == tenant_id,
        )
        .order_by(ReviewJob.created_at)
    )
    return [
        {"job_id": job_id, "filename": filename}
        for job_id, filename in (await session.execute(statement)).all()
    ]
