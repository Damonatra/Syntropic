"""Operational CLI: reassign pre-isolation ``__legacy__`` rows to real tenants.

Migration 0003 backfilled every pre-isolation row with the ``__legacy__``
sentinel tenant. Those rows are invisible to every authenticated tenant
(tenant-scoped queries never match the sentinel) and must be reassigned to
their owning organization before multi-tenant go-live.

Usage:
  python -m syntropic.core.matching.api.tenant_admin report \
      --database-url postgresql+asyncpg://...
  python -m syntropic.core.matching.api.tenant_admin reassign \
      --to acme-corp --database-url ... --yes
  python -m syntropic.core.matching.api.tenant_admin verify --database-url ...

The tool never infers ownership: a human operator decides the target tenant
per batch. ``report`` is the dry-run view; ``verify`` checks post-conditions
(no sentinel rows left, no outbox rows whose tenant diverges from their job).
"""

import argparse
import asyncio
import json
import os
import sys
from typing import Any, Dict, List

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

from syntropic.core.matching.api.database import (
    LEGACY_TENANT_ID,
    ReviewJob,
    WebhookOutbox,
)


def _add_database_url_option(subparser) -> None:
    # Accept --database-url after the subcommand too. SUPPRESS keeps the
    # subparser from clobbering a value given before the subcommand.
    subparser.add_argument(
        "--database-url", default=argparse.SUPPRESS, help=argparse.SUPPRESS
    )


async def collect_report(session_factory) -> Dict[str, Any]:
    """Count sentinel rows per table and sample a few job ids."""
    async with session_factory() as session:
        jobs_legacy = await session.scalar(
            select(func.count())
            .select_from(ReviewJob)
            .where(ReviewJob.tenant_id == LEGACY_TENANT_ID)
        )
        outbox_legacy = await session.scalar(
            select(func.count())
            .select_from(WebhookOutbox)
            .where(WebhookOutbox.tenant_id == LEGACY_TENANT_ID)
        )
        total_jobs = await session.scalar(select(func.count()).select_from(ReviewJob))
        total_outbox = await session.scalar(
            select(func.count()).select_from(WebhookOutbox)
        )
        samples = (
            (
                await session.execute(
                    select(ReviewJob.job_id, ReviewJob.filename)
                    .where(ReviewJob.tenant_id == LEGACY_TENANT_ID)
                    .order_by(ReviewJob.created_at)
                    .limit(10)
                )
            ).all()
        )
        histogram = (
            (
                await session.execute(
                    select(ReviewJob.tenant_id, func.count())
                    .group_by(ReviewJob.tenant_id)
                    .order_by(func.count().desc())
                )
            ).all()
        )
    return {
        "jobs_legacy": int(jobs_legacy or 0),
        "outbox_legacy": int(outbox_legacy or 0),
        "jobs_total": int(total_jobs or 0),
        "outbox_total": int(total_outbox or 0),
        "samples": [{"job_id": job_id, "filename": filename} for job_id, filename in samples],
        "job_tenant_histogram": [
            {"tenant_id": tenant, "jobs": int(count)} for tenant, count in histogram
        ],
    }


async def reassign(
    session_factory,
    target_tenant: str,
    *,
    tables: str = "all",
) -> Dict[str, int]:
    """Move sentinel rows to ``target_tenant`` in a single transaction.

    ``tables`` selects the scope: ``all`` (default, keeps job/outbox tenants
    consistent), ``jobs``, or ``outbox`` (surgical repair of orphaned outbox
    rows only).
    """
    moved = {"rfq_jobs": 0, "webhook_outbox": 0}
    async with session_factory() as session:
        async with session.begin():
            if tables in ("all", "jobs"):
                result = await session.execute(
                    update(ReviewJob)
                    .where(ReviewJob.tenant_id == LEGACY_TENANT_ID)
                    .values(tenant_id=target_tenant)
                )
                moved["rfq_jobs"] = int(result.rowcount or 0)
            if tables in ("all", "outbox"):
                result = await session.execute(
                    update(WebhookOutbox)
                    .where(WebhookOutbox.tenant_id == LEGACY_TENANT_ID)
                    .values(tenant_id=target_tenant)
                )
                moved["webhook_outbox"] = int(result.rowcount or 0)
    return moved


async def verify(session_factory) -> Dict[str, Any]:
    """Post-condition check: no sentinel rows, no job/outbox tenant divergence."""
    async with session_factory() as session:
        jobs_legacy = await session.scalar(
            select(func.count())
            .select_from(ReviewJob)
            .where(ReviewJob.tenant_id == LEGACY_TENANT_ID)
        )
        outbox_legacy = await session.scalar(
            select(func.count())
            .select_from(WebhookOutbox)
            .where(WebhookOutbox.tenant_id == LEGACY_TENANT_ID)
        )
        orphans = (
            (
                await session.execute(
                    select(WebhookOutbox.event_id, WebhookOutbox.job_id)
                    .join(ReviewJob, ReviewJob.job_id == WebhookOutbox.job_id)
                    .where(WebhookOutbox.tenant_id != ReviewJob.tenant_id)
                    .limit(50)
                )
            ).all()
        )
    return {
        "jobs_legacy_remaining": int(jobs_legacy or 0),
        "outbox_legacy_remaining": int(outbox_legacy or 0),
        "orphaned_outbox": [
            {"event_id": event_id, "job_id": job_id} for event_id, job_id in orphans
        ],
        "consistent": (jobs_legacy or 0) == 0
        and (outbox_legacy or 0) == 0
        and not orphans,
    }


def _database_url(args: argparse.Namespace) -> str:
    url = args.database_url or os.getenv("DATABASE_URL", "")
    if not url:
        raise SystemExit(
            "No database URL: pass --database-url or set DATABASE_URL."
        )
    return url


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="syntropic.tenant_admin",
        description="Reassign pre-isolation __legacy__ rows to real tenants.",
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="Async SQLAlchemy URL (defaults to DATABASE_URL env).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    report_parser = subparsers.add_parser(
        "report", help="Count sentinel rows (dry-run view)."
    )
    _add_database_url_option(report_parser)

    reassign_parser = subparsers.add_parser(
        "reassign", help="Move sentinel rows to a target tenant."
    )
    _add_database_url_option(reassign_parser)
    reassign_parser.add_argument("--to", required=True, help="Target tenant_id.")
    reassign_parser.add_argument(
        "--tables",
        choices=("all", "jobs", "outbox"),
        default="all",
        help="Scope of the move (default: all, keeps job/outbox consistent).",
    )
    reassign_parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm the write. Without it the command refuses to run.",
    )

    verify_parser = subparsers.add_parser(
        "verify", help="Check post-conditions after reassignment."
    )
    _add_database_url_option(verify_parser)

    args = parser.parse_args(argv)
    database_url = _database_url(args)

    engine: AsyncEngine = create_async_engine(database_url)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        if args.command == "report":
            payload = asyncio.run(collect_report(session_factory))
            print(json.dumps(payload, indent=2))
            pending = payload["jobs_legacy"] + payload["outbox_legacy"]
            print(
                f"\n{pending} sentinel row(s) pending reassignment."
                if pending
                else "\nNo sentinel rows remain."
            )
            return 0

        if args.command == "reassign":
            target = args.to.strip()
            if not target:
                raise SystemExit("--to must be a non-empty tenant id.")
            if target == LEGACY_TENANT_ID:
                raise SystemExit(
                    "Refusing to reassign to the __legacy__ sentinel itself."
                )
            if not args.yes:
                raise SystemExit(
                    "Reassignment writes production rows: re-run with --yes."
                )
            moved = asyncio.run(
                reassign(session_factory, target, tables=args.tables)
            )
            print(
                json.dumps(
                    {"status": "reassigned", "target_tenant": target, "moved": moved},
                    indent=2,
                )
            )
            return 0

        if args.command == "verify":
            payload = asyncio.run(verify(session_factory))
            print(json.dumps(payload, indent=2))
            return 0 if payload["consistent"] else 2

        raise SystemExit(f"Unknown command: {args.command}")
    finally:
        asyncio.run(engine.dispose())


if __name__ == "__main__":
    sys.exit(main())
