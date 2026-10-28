"""Layer 5 — Commercial instrumentation & revenue-share proof test suite.

Covers the three LAYER 5 market-readiness criteria:
* 5.1 ROI value ledger — per-job immutable money records, idempotent on
  (tenant, job), anchored to the Taelin hash chain, gated by
  ROI_LEDGER_ENABLED, and currency-correct end to end (mixed-currency
  money is never summed),
* 5.2 ROI summary API — cumulative captured per currency bucket, period
  filtering, payback progress against the deployment cost, tenant-scoped,
* 5.3 revenue-share statement — deterministic per calendar month, hashed
  over canonical JSON, share math per currency bucket, UNKNOWN bucket
  never billed, tamper detection via verify_statement.
"""

import asyncio
import json
import sqlite3
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from syntropic.core import stream as stream_module
from syntropic.core.stream import taelin as taelin_module
from syntropic.core.matching import margin_defender
from syntropic.core.matching.api import main as api
from syntropic.core.matching.api.auth import require_authenticated_user
from syntropic.core.matching.api.database import (
    Base,
    RoiValueLedger,
    margin_stream_payload,
    record_margin_intervention,
    save_review_job,
)
from syntropic.core.roi.reporting import (
    monthly_statement,
    roi_summary,
    verify_statement,
)
from syntropic.core.stream import TaelinStream


# pytest-asyncio runs in STRICT mode: coroutine tests carry explicit markers.


@pytest.fixture
def session_factory(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/roi.sqlite3")

    async def create_schema():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(create_schema())
    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    asyncio.run(engine.dispose())


@pytest.fixture
def stream(tmp_path):
    return TaelinStream(root=tmp_path / "streams", rotate_mb=64)


# ----------------------------------------------------------------- helpers


def _delta(line_index, pushed, quoted, currency=None, **extra):
    entry = {
        "line_index": line_index,
        "part_number": f"PN-{line_index}",
        "sku_id": f"SKU-{line_index}",
        "quantity": 10,
        "quoted_price": quoted,
        "pushed_price": pushed,
        "unit_cost": max((quoted or 0) - 2.0, 1.0),
        "price_floor": None,
        "currency": currency,
        "margin_pct_at_push": 0.3,
        "repriced": pushed != quoted,
        "reason_code": "below_floor" if pushed != quoted else None,
    }
    entry.update(extra)
    return entry


def _execution_result(deltas, decisions=None):
    report = decisions or [
        {"decision": "reprice", "sku_id": delta["sku_id"]} for delta in deltas
    ]
    return {
        "price_deltas": deltas,
        "margin_report": report,
    }


def _ledger_payload_usd_eur():
    """Two USD lines + one EUR line + one unresolvable-currency line."""
    deltas = [
        _delta(0, pushed=42.0, quoted=40.0, currency="USD"),
        _delta(1, pushed=41.0, quoted=40.0, currency="usd"),
        _delta(2, pushed=52.0, quoted=50.0, currency="EUR"),
        _delta(3, pushed=45.0, quoted=40.0, currency=None),
    ]
    return _execution_result(deltas)


# --------------------------------------------- 5.1 currency-correct money


def test_price_delta_telemetry_carries_currency():
    """Line currency resolves decision > extracted > catalog, else None."""
    extracted = {
        "line_items": [
            {"unit_price": 10.0, "currency": "USD"},
            {"unit_price": 20.0},
        ]
    }
    matched = [
        {
            "extracted_item": {"unit_price": 10.0},
            "catalog_item": {"sku_id": "S1", "unit_cost": 8.0, "currency": "EUR"},
        },
        {
            "extracted_item": {"unit_price": 20.0, "currency": "gbp"},
            "catalog_item": {"sku_id": "S2", "unit_cost": 18.0},
        },
    ]
    report = [{"decision": "pass", "quoted_price": 10.0, "currency": "CHF"}, {}]
    deltas = margin_defender.build_price_delta_telemetry(
        extracted, matched, report
    )
    assert deltas[0]["currency"] == "CHF"  # decision wins
    assert deltas[1]["currency"] == "GBP"  # extracted next, uppercased
    assert all(delta["currency"] is not None for delta in deltas)


def test_margin_payload_buckets_by_currency():
    """Payload adds margin_delta_by_currency; scalar stays for compat."""
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    assert payload["margin_delta_by_currency"] == {
        "USD": 3.0,  # 2.0 + 1.0 (case-normalised bucket)
        "EUR": 2.0,
        "UNKNOWN": 5.0,
    }
    assert payload["margin_delta"] == pytest.approx(10.0)  # legacy scalar
    assert payload["decision"] == "reprice"


def test_margin_payload_empty_deltas_yields_zero_buckets():
    payload = margin_stream_payload(
        _execution_result([], decisions=[{"decision": "veto"}])
    )
    assert payload["margin_delta_by_currency"] == {}
    assert payload["margin_delta"] == 0.0
    assert payload["decision"] == "veto"


# --------------------------------------------------- 5.1 ledger behaviour


async def _record(factory, tenant_id, job_id, payload, **kwargs):
    async with factory() as session:
        row = await record_margin_intervention(
            session, tenant_id, job_id, payload, **kwargs
        )
        await session.commit()
    return row


@pytest.mark.asyncio
async def test_ledger_record_is_idempotent_per_job(session_factory):
    """Re-saving a job never duplicates money (first-wins, unique key)."""
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    first = await _record(session_factory, "acme", "job-1", payload)
    again = await _record(session_factory, "acme", "job-1", payload)
    other = await _record(session_factory, "acme", "job-2", payload)
    assert first.id == again.id  # same row returned, not duplicated
    assert other.id != first.id
    async with session_factory() as session:
        rows = list(
            (
                await session.execute(
                    RoiValueLedger.__table__.select().where(
                        RoiValueLedger.tenant_id == "acme"
                    )
                )
            ).scalars()
        )
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_ledger_gating_disabled(session_factory, monkeypatch):
    monkeypatch.setenv("ROI_LEDGER_ENABLED", "false")
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    row = await _record(session_factory, "acme", "job-1", payload)
    assert row is None
    async with session_factory() as session:
        count = len(
            list(
                (
                    await session.execute(
                        RoiValueLedger.__table__.select()
                    )
                ).scalars()
            )
        )
    assert count == 0


@pytest.mark.asyncio
async def test_save_review_job_anchors_ledger_to_stream(
    session_factory, tmp_path, monkeypatch
):
    """End-to-end hook: stream emit + ledger row sharing the seq/hash anchor."""
    monkeypatch.setattr(taelin_module.settings, "STREAM_ROOT", str(tmp_path / "s"))
    stream_module.reset_stream()
    try:
        async with session_factory() as session:
            job = await save_review_job(
                session,
                "job-anchor-1",
                "quote.pdf",
                "completed",
                _ledger_payload_usd_eur(),
                tenant_id="acme",
            )
            await session.commit()
        assert job is not None
        stream = stream_module.get_stream()
        records = stream.range("acme", event="margin_adjusted")
        assert len(records) == 1
        stream_record = records[0]
        assert stream_record["payload"]["margin_delta_by_currency"] == {
            "USD": 3.0,
            "EUR": 2.0,
            "UNKNOWN": 5.0,
        }
    finally:
        stream_module.reset_stream()

    async with session_factory() as session:
        row = (
            await session.execute(
                select(RoiValueLedger).where(
                    RoiValueLedger.job_id == "job-anchor-1"
                )
            )
        ).scalar_one()
    assert row.stream_seq == stream_record["seq"]
    assert row.stream_hash == stream_record["hash"]
    assert row.delta_by_currency == {"USD": 3.0, "EUR": 2.0, "UNKNOWN": 5.0}
    # The anchor is independently verifiable against the hash chain.
    assert stream.verify("acme")["ok"] is True


@pytest.mark.asyncio
async def test_ledger_tenant_isolation_in_summary(session_factory):
    """Tenant A's money never appears in tenant B's reporting."""
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-1", payload)
    await _record(session_factory, "other", "job-2", payload)
    async with session_factory() as session:
        summary = await roi_summary(session, "acme", deployment_cost=10.0)
    assert summary["interventions"] == 1
    assert summary["captured_by_currency"]["USD"] == 3.0


# ------------------------------------------------- 5.2 summary + payback


@pytest.mark.asyncio
async def test_roi_summary_math_and_payback(session_factory):
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-1", payload)
    await _record(session_factory, "acme", "job-2", payload)
    async with session_factory() as session:
        summary = await roi_summary(
            session,
            "acme",
            share_pct=0.20,
            deployment_cost=50.0,
            reporting_currency="USD",
        )
    assert summary["interventions"] == 2
    assert summary["repriced_count"] == 8  # 4 repriced lines x 2 jobs
    assert summary["captured_by_currency"] == {
        "USD": 6.0,
        "EUR": 4.0,
        "UNKNOWN": 10.0,
    }
    # Payback uses ONLY the reporting-currency bucket: 6.0 / 50.0 = 12%.
    assert summary["captured_reporting_currency"] == 6.0
    assert summary["payback_pct"] == pytest.approx(12.0)
    assert summary["share_reporting_currency"] == pytest.approx(1.2)
    # Mixed-currency money is never summed: EUR/UNKNOWN stay visible but
    # outside the payback denominator.
    assert summary["captured_by_currency"]["EUR"] == 4.0


@pytest.mark.asyncio
async def test_roi_summary_no_reporting_currency_no_payback(session_factory):
    """Without a reporting-currency bucket, payback is None — not guessed."""
    deltas = [_delta(0, pushed=52.0, quoted=50.0, currency="EUR")]
    payload = margin_stream_payload(_execution_result(deltas))
    await _record(session_factory, "acme", "job-1", payload)
    async with session_factory() as session:
        summary = await roi_summary(
            session, "acme", deployment_cost=100.0, reporting_currency="USD"
        )
    assert summary["captured_reporting_currency"] is None
    assert summary["payback_pct"] is None
    assert summary["share_reporting_currency"] is None


async def _backdate(factory, job_id, when):
    """Pin a ledger row's captured_at (rows default to wall-clock now)."""
    async with factory() as session:
        await session.execute(
            update(RoiValueLedger)
            .where(RoiValueLedger.job_id == job_id)
            .values(captured_at=when)
        )
        await session.commit()


@pytest.mark.asyncio
async def test_roi_summary_period_filter_half_open(session_factory):
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-in", payload)
    await _record(session_factory, "acme", "job-out", payload)
    await _backdate(
        session_factory, "job-in", datetime(2026, 11, 5, tzinfo=timezone.utc)
    )
    await _backdate(
        session_factory, "job-out", datetime(2026, 10, 15, tzinfo=timezone.utc)
    )
    async with session_factory() as session:
        summary = await roi_summary(
            session,
            "acme",
            start=datetime(2026, 11, 1, tzinfo=timezone.utc),
            end=datetime(2026, 12, 1, tzinfo=timezone.utc),
        )
    assert summary["interventions"] == 1
    assert summary["captured_by_currency"]["USD"] == 3.0


# ------------------------------------------------------- 5.3 statements


@pytest.mark.asyncio
async def test_statement_is_deterministic_and_hash_bound(session_factory):
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-1", payload)
    await _backdate(
        session_factory, "job-1", datetime(2026, 11, 9, tzinfo=timezone.utc)
    )
    async with session_factory() as session:
        first = await monthly_statement(session, "acme", 2026, 11, share_pct=0.20)
        second = await monthly_statement(session, "acme", 2026, 11, share_pct=0.20)
    assert first["statement_hash"] == second["statement_hash"]
    assert first["period"]["end_exclusive"] == "2026-12-01T00:00:00+00:00"
    assert verify_statement(first) is True
    assert verify_statement(second) is True


@pytest.mark.asyncio
async def test_statement_share_math_and_unknown_bucket(session_factory):
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-1", payload)
    await _backdate(
        session_factory, "job-1", datetime(2026, 11, 9, tzinfo=timezone.utc)
    )
    async with session_factory() as session:
        statement = await monthly_statement(session, "acme", 2026, 11, share_pct=0.20)
    assert statement["captured_by_currency"] == {
        "USD": 3.0,
        "EUR": 2.0,
        "UNKNOWN": 5.0,
    }
    assert statement["share_by_currency"] == {"USD": 0.6, "EUR": 0.4}
    assert "UNKNOWN" not in statement["share_by_currency"]
    assert statement["non_billable_buckets"] == ["UNKNOWN"]
    assert statement["share_reporting_currency"] == 0.6


@pytest.mark.asyncio
async def test_statement_detects_mutated_money(session_factory):
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-1", payload)
    await _backdate(
        session_factory, "job-1", datetime(2026, 11, 9, tzinfo=timezone.utc)
    )
    async with session_factory() as session:
        statement = await monthly_statement(session, "acme", 2026, 11)
    tampered = json.loads(json.dumps(statement))
    tampered["captured_by_currency"]["USD"] = 99999.0
    assert verify_statement(tampered) is False
    missing = {k: v for k, v in statement.items() if k != "statement_hash"}
    assert verify_statement(missing) is False
    assert verify_statement({"nope": True}) is False


@pytest.mark.asyncio
async def test_statement_anchors_to_stream_records(
    session_factory, tmp_path, monkeypatch
):
    monkeypatch.setattr(taelin_module.settings, "STREAM_ROOT", str(tmp_path / "s"))
    stream_module.reset_stream()
    try:
        async with session_factory() as session:
            await save_review_job(
                session,
                "job-stmt-1",
                "quote.pdf",
                "completed",
                _ledger_payload_usd_eur(),
                tenant_id="acme",
            )
            await session.commit()
    finally:
        stream_module.reset_stream()
    await _backdate(
        session_factory, "job-stmt-1", datetime(2026, 11, 20, tzinfo=timezone.utc)
    )
    async with session_factory() as session:
        statement = await monthly_statement(session, "acme", 2026, 11)
    assert statement["anchors"]["ledger_rows"] == 1
    assert statement["anchors"]["stream_anchored_rows"] == 1
    assert statement["anchors"]["first"]["seq"] >= 1
    assert len(statement["anchors"]["first"]["hash"]) == 64


@pytest.mark.asyncio
async def test_statement_month_and_year_boundaries(session_factory):
    """December rolls into the next year; January money stays out."""
    payload = margin_stream_payload(_ledger_payload_usd_eur())
    await _record(session_factory, "acme", "job-dec", payload)
    await _record(session_factory, "acme", "job-jan", payload)
    await _backdate(
        session_factory, "job-dec", datetime(2026, 12, 5, tzinfo=timezone.utc)
    )
    await _backdate(
        session_factory, "job-jan", datetime(2027, 1, 5, tzinfo=timezone.utc)
    )
    async with session_factory() as session:
        december = await monthly_statement(session, "acme", 2026, 12)
        january = await monthly_statement(session, "acme", 2027, 1)
    assert december["period"]["end_exclusive"] == "2027-01-01T00:00:00+00:00"
    assert december["interventions"] == 1
    assert january["interventions"] == 1
    assert january["period"]["year"] == 2027

    async with session_factory() as session:
        with pytest.raises(ValueError):
            await monthly_statement(session, "acme", 2026, 13)
        with pytest.raises(ValueError):
            await monthly_statement(session, "acme", 2201, 1)


# --------------------------------------------------------- 5.2/5.3 API


@pytest.fixture
def roi_client(tmp_path, monkeypatch):
    database_path = (tmp_path / "roi_api.sqlite3").as_posix()
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{database_path}")
    api.app.state.test_db_path = tmp_path / "roi_api.sqlite3"
    api.app.state.testing = True
    api.app.dependency_overrides[require_authenticated_user] = lambda: {
        "sub": "acme"
    }
    with TestClient(api.app) as client:
        yield client
    api.app.dependency_overrides.clear()
    api.app.state.testing = False


def _seed_ledger_row(
    db_path,
    job_id,
    tenant_id,
    usd,
    eur,
    unknown=0.0,
    captured_at="2026-11-09T10:00:00",
):
    with sqlite3.connect(db_path) as connection:
        connection.execute(
            """INSERT INTO roi_value_ledger
               (tenant_id, job_id, decision, line_count, repriced_count,
                veto_count, margin_delta, delta_by_currency, captured_at)
               VALUES (?, ?, 'reprice', 3, 2, 0, ?, ?, ?)""",
            (
                tenant_id,
                job_id,
                usd + eur + unknown,
                json.dumps(
                    {
                        "USD": usd,
                        "EUR": eur,
                        **({"UNKNOWN": unknown} if unknown else {}),
                    }
                ),
                captured_at,
            ),
        )


def test_roi_summary_api_tenant_scoped(roi_client):
    db_path = str(roi_client.app.state.test_db_path)
    _seed_ledger_row(db_path, "job-1", "acme", 100.0, 40.0)
    _seed_ledger_row(db_path, "job-2", "rival-co", 999.0, 0.0)
    response = roi_client.get("/api/v1/roi/summary")
    assert response.status_code == 200
    body = response.json()
    assert body["tenant_id"] == "acme"
    assert body["captured_by_currency"] == {"USD": 100.0, "EUR": 40.0}
    assert body["payback_pct"] == pytest.approx(0.2)  # 100 / 50_000
    assert body["share_reporting_currency"] == pytest.approx(20.0)


def test_roi_summary_api_rejects_bad_bounds(roi_client):
    response = roi_client.get("/api/v1/roi/summary?start=not-a-date")
    assert response.status_code == 400
    assert "start" in response.json()["detail"]


def test_roi_statement_api_hash_verified(roi_client):
    db_path = str(roi_client.app.state.test_db_path)
    _seed_ledger_row(db_path, "job-1", "acme", 100.0, 40.0, unknown=5.0)
    response = roi_client.get("/api/v1/roi/statement/2026/11")
    assert response.status_code == 200
    body = response.json()
    assert body["hash_verified"] is True
    statement = body["statement"]
    assert statement["tenant_id"] == "acme"
    assert statement["share_by_currency"] == {"USD": 20.0, "EUR": 8.0}
    assert "UNKNOWN" not in statement["share_by_currency"]
    # The API-issued statement re-verifies with the standalone verifier —
    # the same recomputation an external auditor would run.
    assert verify_statement(statement) is True
    tampered = dict(statement)
    tampered["captured_by_currency"] = {"USD": 99999.0}
    assert verify_statement(tampered) is False


def test_roi_statement_api_rejects_bad_period(roi_client):
    response = roi_client.get("/api/v1/roi/statement/2026/13")
    assert response.status_code == 400
    assert "month" in response.json()["detail"]


def test_roi_statement_api_empty_month_is_zeroed(roi_client):
    response = roi_client.get("/api/v1/roi/statement/2030/5")
    assert response.status_code == 200
    body = response.json()
    statement = body["statement"]
    assert statement["interventions"] == 0
    assert statement["captured_by_currency"] == {}
    assert statement["share_by_currency"] == {}
    assert statement["statement_hash"]


def test_build_monthly_statement_jev_balanced():
    """GL Journal Entry Voucher must produce balanced double-entry GL lines (Debits = Credits)."""
    from syntropic.core.roi.jev_accounting import build_monthly_statement_jev

    statement = {
        "tenant_id": "acme",
        "period": {"year": 2026, "month": 11},
        "share_by_currency": {"USD": 20.0, "EUR": 8.0},
        "statement_hash": "abc123def4567890",
    }
    voucher = build_monthly_statement_jev(statement)
    assert voucher.tenant_id == "acme"
    assert voucher.accounting_period == "2026-11"
    assert voucher.is_balanced is True
    assert voucher.total_debit == voucher.total_credit == 28.0
    assert len(voucher.entries) == 4  # 2 entries per currency bucket (1 Debit, 1 Credit)


def test_roi_jev_api_endpoint(roi_client):
    """API endpoint /api/v1/roi/jev/{year}/{month} returns balanced GL vouchers."""
    db_path = str(roi_client.app.state.test_db_path)
    _seed_ledger_row(db_path, "job-jev-1", "acme", 100.0, 40.0)
    response = roi_client.get("/api/v1/roi/jev/2026/11")
    assert response.status_code == 200
    voucher = response.json()
    assert voucher["tenant_id"] == "acme"
    assert voucher["is_balanced"] is True
    assert voucher["total_debit"] == voucher["total_credit"] == 28.0  # 20% of (100 USD + 40 EUR)
    assert len(voucher["entries"]) == 4
