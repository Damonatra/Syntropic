"""Tests for the __legacy__ tenant reassignment operational CLI."""

import asyncio

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from syntropic.core.matching.api import tenant_admin
from syntropic.core.matching.api.database import (
    LEGACY_TENANT_ID,
    ReviewJob,
    WebhookOutbox,
)


@pytest.fixture
def session_factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/admin.sqlite3")

    async def create_schema():
        async with engine.begin() as conn:
            await conn.run_sync(ReviewJob.metadata.create_all)

    asyncio.run(create_schema())
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    asyncio.run(engine.dispose())


async def _seed_job(session_factory, job_id, tenant_id, status="flagged_for_review"):
    async with session_factory() as session:
        session.add(
            ReviewJob(
                job_id=job_id,
                tenant_id=tenant_id,
                filename=f"{job_id}.pdf",
                status=status,
                execution_result={"confidence_score": 0.9},
            )
        )
        await session.commit()


async def _seed_outbox(session_factory, event_id, job_id, tenant_id):
    async with session_factory() as session:
        session.add(
            WebhookOutbox(
                event_id=event_id,
                tenant_id=tenant_id,
                job_id=job_id,
                payload={"event": "rfq.approved", "job_id": job_id},
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_report_counts_sentinel_rows_and_histogram(session_factory):
    await _seed_job(session_factory, "job-legacy-1", LEGACY_TENANT_ID)
    await _seed_job(session_factory, "job-legacy-2", LEGACY_TENANT_ID)
    await _seed_job(session_factory, "job-acme", "acme-corp")
    await _seed_outbox(session_factory, "evt-1", "job-legacy-1", LEGACY_TENANT_ID)

    report = await tenant_admin.collect_report(session_factory)

    assert report["jobs_legacy"] == 2
    assert report["outbox_legacy"] == 1
    assert report["jobs_total"] == 3
    assert {"tenant_id": LEGACY_TENANT_ID, "jobs": 2} in report["job_tenant_histogram"]
    assert {"tenant_id": "acme-corp", "jobs": 1} in report["job_tenant_histogram"]


@pytest.mark.asyncio
async def test_reassign_moves_both_tables_and_verify_turns_consistent(session_factory):
    await _seed_job(session_factory, "job-legacy-1", LEGACY_TENANT_ID)
    await _seed_outbox(session_factory, "evt-1", "job-legacy-1", LEGACY_TENANT_ID)

    moved = await tenant_admin.reassign(session_factory, "acme-corp")

    assert moved == {"rfq_jobs": 1, "webhook_outbox": 1}
    verification = await tenant_admin.verify(session_factory)
    assert verification["consistent"] is True
    assert verification["jobs_legacy_remaining"] == 0
    assert verification["outbox_legacy_remaining"] == 0


@pytest.mark.asyncio
async def test_reassign_single_table_scope_for_orphan_repair(session_factory):
    await _seed_job(session_factory, "job-legacy-1", LEGACY_TENANT_ID)
    await _seed_outbox(session_factory, "evt-1", "job-legacy-1", LEGACY_TENANT_ID)

    moved = await tenant_admin.reassign(
        session_factory, "acme-corp", tables="jobs"
    )

    assert moved == {"rfq_jobs": 1, "webhook_outbox": 0}
    verification = await tenant_admin.verify(session_factory)
    assert verification["consistent"] is False
    assert verification["orphaned_outbox"] == [
        {"event_id": "evt-1", "job_id": "job-legacy-1"}
    ]

    # Surgical repair: move only the outbox row.
    moved = await tenant_admin.reassign(
        session_factory, "acme-corp", tables="outbox"
    )
    assert moved == {"rfq_jobs": 0, "webhook_outbox": 1}
    assert (await tenant_admin.verify(session_factory))["consistent"] is True


@pytest.mark.asyncio
async def test_verify_flags_inconsistency_when_outbox_diverges(session_factory):
    await _seed_job(session_factory, "job-a", "tenant-a", status="completed")
    await _seed_outbox(session_factory, "evt-x", "job-a", "tenant-b")

    verification = await tenant_admin.verify(session_factory)

    assert verification["consistent"] is False
    assert verification["orphaned_outbox"] == [
        {"event_id": "evt-x", "job_id": "job-a"}
    ]


def _build_empty_db(db_path):
    """Create a schema-only sqlite database for CLI tests."""
    from syntropic.core.matching.api.database import Base

    async def build():
        engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await engine.dispose()

    asyncio.run(build())


def test_cli_reassign_refuses_without_confirmation(tmp_path):
    db_path = (tmp_path / "cli.sqlite3").as_posix()
    _build_empty_db(db_path)

    with pytest.raises(SystemExit) as error:
        tenant_admin.main(
            ["reassign", "--to", "acme-corp", "--database-url", f"sqlite+aiosqlite:///{db_path}"]
        )
    assert error.value.code != 0


def test_cli_reassign_refuses_sentinel_target(tmp_path):
    db_path = (tmp_path / "cli2.sqlite3").as_posix()
    _build_empty_db(db_path)

    with pytest.raises(SystemExit) as error:
        tenant_admin.main(
            [
                "reassign",
                "--to",
                LEGACY_TENANT_ID,
                "--yes",
                "--database-url",
                f"sqlite+aiosqlite:///{db_path}",
            ]
        )
    assert error.value.code != 0


def test_cli_end_to_end_reassign_and_verify(tmp_path, capsys):
    import json

    db_path = (tmp_path / "cli3.sqlite3").as_posix()
    url = f"sqlite+aiosqlite:///{db_path}"
    _build_empty_db(db_path)

    async def seed():
        engine = create_async_engine(url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            session.add(
                ReviewJob(
                    job_id="job-cli",
                    tenant_id=LEGACY_TENANT_ID,
                    filename="cli.pdf",
                    status="completed",
                    execution_result={"confidence_score": 1.0},
                )
            )
            session.add(
                WebhookOutbox(
                    event_id="evt-cli",
                    tenant_id=LEGACY_TENANT_ID,
                    job_id="job-cli",
                    payload={"event": "rfq.approved"},
                )
            )
            await session.commit()
        await engine.dispose()

    asyncio.run(seed())

    assert tenant_admin.main(["reassign", "--to", "acme", "--yes", "--database-url", url]) == 0
    assert tenant_admin.main(["verify", "--database-url", url]) == 0
    capsys.readouterr()  # consume reassign/verify output

    # report must now show zero sentinel rows in both tables.
    assert tenant_admin.main(["report", "--database-url", url]) == 0
    out = capsys.readouterr().out
    assert '"jobs_legacy": 0' in out
    assert '"outbox_legacy": 0' in out
