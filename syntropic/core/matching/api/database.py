"""Async SQLAlchemy persistence for the human review queue."""

from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, JSON, String, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ReviewJob(Base):
    __tablename__ = "rfq_jobs"

    job_id: Mapped[str] = mapped_column(String(36), primary_key=True)
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


async def save_review_job(
    session: AsyncSession,
    job_id: str,
    filename: str,
    status: str,
    execution_result: dict[str, Any],
    review_decision: str | None = None,
    review_note: str | None = None,
) -> ReviewJob:
    job = await session.get(ReviewJob, job_id)
    if job is None:
        job = ReviewJob(
            job_id=job_id,
            filename=filename,
            status=status,
            execution_result=execution_result,
            review_decision=review_decision,
            review_note=review_note,
        )
        session.add(job)
    else:
        job.filename = filename
        job.status = status
        job.execution_result = execution_result
        job.review_decision = review_decision
        job.review_note = review_note
    await session.commit()
    await session.refresh(job)
    return job


async def get_review_job(
    session: AsyncSession, job_id: str, *, for_update: bool = False
) -> ReviewJob | None:
    statement = select(ReviewJob).where(ReviewJob.job_id == job_id)
    if for_update:
        statement = statement.with_for_update()
    return await session.scalar(statement)


async def list_pending_review_jobs(
    session: AsyncSession,
) -> list[dict[str, str]]:
    statement = (
        select(ReviewJob.job_id, ReviewJob.filename)
        .where(ReviewJob.status == "flagged_for_review")
        .order_by(ReviewJob.created_at)
    )
    return [
        {"job_id": job_id, "filename": filename}
        for job_id, filename in (await session.execute(statement)).all()
    ]
