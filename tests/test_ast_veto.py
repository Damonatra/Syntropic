"""Tests for the Agent 6 AST & tenant isolation veto gate."""

import asyncio
import logging

import pytest

from security.ast_veto import (
    TenantIsolationViolationError,
    enforce_tenant_isolation,
    get_current_tenant,
    reset_current_tenant,
    set_current_tenant,
    tenant_context,
    verify_query_has_tenant_isolation,
    verify_query_safety,
)


# --- A. AST query inspector -------------------------------------------------


def test_verify_query_safety_accepts_parameterized_sql_with_tenant_filter():
    query = "SELECT * FROM rfq_jobs WHERE tenant_id = $1 AND status = 'open'"
    assert verify_query_safety(query) is True


def test_verify_query_safety_rejects_unsegmented_sql():
    query = "SELECT * FROM rfq_jobs WHERE status = 'open'"
    assert verify_query_safety(query) is False


def test_verify_query_safety_requires_structural_filter_not_keyword_mention():
    # 'tenant_id' appears only in a comment, never in the query structure.
    query = "status = 'open'  # tenant_id handled upstream"
    assert verify_query_safety(query) is False


def test_verify_query_safety_accepts_python_style_comparison():
    assert verify_query_safety("row.tenant_id == active_tenant") is True
    assert verify_query_safety("row['tenant_id'] == active_tenant") is True
    assert verify_query_safety("tenant_id == requested_tenant") is True
    assert verify_query_safety("row.status == 'open'") is False


def test_verify_query_safety_accepts_filter_dictionary_with_tenant_key():
    filters = {"tenant_id": "acme-corp", "status": "open"}
    assert verify_query_safety(filters) is True


def test_verify_query_safety_rejects_filter_dictionary_without_tenant_key():
    filters = {"status": "open"}
    assert verify_query_safety(filters) is False


def test_verify_query_safety_accepts_nested_vector_store_filter():
    qdrant_filter = {
        "must": [{"key": "tenant_id", "match": {"value": "acme-corp"}}]
    }
    assert verify_query_safety(qdrant_filter) is True


def test_verify_query_safety_accepts_keyword_argument_named_tenant_id():
    assert verify_query_safety("search(query='valve', tenant_id=active_tenant)") is True
    assert verify_query_safety("search(query='valve', status='open')") is False


def test_verify_query_has_tenant_isolation_returns_true_when_isolated():
    assert (
        verify_query_has_tenant_isolation(
            "SELECT part_number FROM catalog WHERE tenant_id = $1"
        )
        is True
    )


def test_verify_query_has_tenant_isolation_raises_for_unsegmented_query():
    with pytest.raises(TenantIsolationViolationError, match="tenant_id"):
        verify_query_has_tenant_isolation("SELECT part_number FROM catalog")


def test_verify_query_has_tenant_isolation_checks_filter_dictionaries():
    assert verify_query_has_tenant_isolation({"tenant_id": "acme-corp"}) is True
    with pytest.raises(TenantIsolationViolationError, match="tenant_id"):
        verify_query_has_tenant_isolation({"region": "emea"})


# --- Active request context -------------------------------------------------


def test_tenant_context_binds_and_restores_the_active_tenant():
    assert get_current_tenant() is None
    with tenant_context("tenant-acme") as bound:
        assert bound == "tenant-acme"
        assert get_current_tenant() == "tenant-acme"
    assert get_current_tenant() is None


def test_set_and_reset_current_tenant_round_trip():
    token = set_current_tenant("tenant-omega")
    try:
        assert get_current_tenant() == "tenant-omega"
    finally:
        reset_current_tenant(token)
    assert get_current_tenant() is None


# --- B. Veto gate decorator -------------------------------------------------


@enforce_tenant_isolation
async def _execute_query(*, query, calls):
    calls.append(query)
    return "executed"


def test_decorator_vetoes_unsegmented_query_and_skips_execution(caplog):
    calls = []
    with caplog.at_level(logging.CRITICAL, logger="syntropic.security.ast_veto"):
        with pytest.raises(TenantIsolationViolationError, match="tenant_id"):
            asyncio.run(
                _execute_query(query="SELECT * FROM rfq_jobs", calls=calls)
            )
    assert calls == []
    assert "[SECURITY VETO]" in caplog.text
    assert "SELECT * FROM rfq_jobs" in caplog.text


def test_decorator_allows_tenant_isolated_query(caplog):
    calls = []
    with caplog.at_level(logging.CRITICAL, logger="syntropic.security.ast_veto"):
        result = asyncio.run(
            _execute_query(
                query="SELECT * FROM rfq_jobs WHERE tenant_id = $1", calls=calls
            )
        )
    assert result == "executed"
    assert len(calls) == 1
    assert "[SECURITY VETO]" not in caplog.text


def test_decorator_vetoes_filter_dictionary_without_tenant():
    calls = []
    with pytest.raises(TenantIsolationViolationError, match="tenant_id"):
        asyncio.run(_execute_query(query={"status": "open"}, calls=calls))
    assert calls == []


def test_decorator_accepts_filter_dictionary_with_tenant_key():
    calls = []
    result = asyncio.run(
        _execute_query(query={"tenant_id": "acme-corp"}, calls=calls)
    )
    assert result == "executed"
    assert calls == [{"tenant_id": "acme-corp"}]


def test_decorator_vetoes_positional_unsegmented_query():
    calls = []

    @enforce_tenant_isolation
    async def run(query, calls):
        calls.append(query)
        return "executed"

    with pytest.raises(TenantIsolationViolationError, match="tenant_id"):
        asyncio.run(run("SELECT * FROM accounts", calls))
    assert calls == []


def test_decorator_logs_audited_tenant_context_on_veto(caplog):
    calls = []
    with tenant_context("tenant-acme"):
        with caplog.at_level(logging.CRITICAL, logger="syntropic.security.ast_veto"):
            with pytest.raises(TenantIsolationViolationError):
                asyncio.run(
                    _execute_query(query="SELECT * FROM accounts", calls=calls)
                )
    assert "tenant-acme" in caplog.text
    assert get_current_tenant() is None


def test_decorator_passes_through_functions_without_a_query_argument():
    @enforce_tenant_isolation
    async def load_job(session, job_id):
        return f"job:{job_id}"

    assert asyncio.run(load_job(object(), "job-1")) == "job:job-1"


def test_decorator_vetoes_empty_filter_dictionary():
    calls = []
    with pytest.raises(TenantIsolationViolationError, match="tenant_id"):
        asyncio.run(_execute_query(query={}, calls=calls))
    assert calls == []


def test_decorator_preserves_function_metadata():
    assert _execute_query.__name__ == "_execute_query"
    assert asyncio.iscoroutinefunction(_execute_query)


# --- Integration point ------------------------------------------------------


def test_database_query_wrappers_are_gated_by_the_veto():
    from syntropic.core.matching.api import database

    for wrapper in (
        database.save_review_job,
        database.get_review_job,
        database.list_pending_review_jobs,
    ):
        assert hasattr(wrapper, "__wrapped__"), (
            f"{wrapper.__name__} must be wrapped by @enforce_tenant_isolation"
        )
        assert asyncio.iscoroutinefunction(wrapper)


def test_gated_database_wrappers_still_execute_end_to_end():
    """The decorator must be transparent for real, session-bound DB calls."""
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from syntropic.core.matching.api import database

    async def round_trip():
        engine = create_async_engine("sqlite+aiosqlite://")
        async with engine.begin() as conn:
            await conn.run_sync(database.Base.metadata.create_all)
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await database.save_review_job(
                session,
                "job-gated",
                "quote.pdf",
                "flagged_for_review",
                {"confidence_score": 0.2},
            )
            job = await database.get_review_job(session, "job-gated")
            pending = await database.list_pending_review_jobs(session)
        await engine.dispose()
        return job, pending

    job, pending = asyncio.run(round_trip())
    assert job is not None
    assert job.filename == "quote.pdf"
    assert pending == [{"job_id": "job-gated", "filename": "quote.pdf"}]
