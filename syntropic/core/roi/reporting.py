"""Deterministic ROI reporting over the value ledger (Layer 5).

Two read-side surfaces, both tenant-scoped and currency-scoped:

* :func:`roi_summary` — cumulative value captured, intervention counts and
  payback progress against the deployment cost.
* :func:`monthly_statement` — the contractual revenue-share statement for
  one calendar month. The statement is hashed over its canonical JSON
  (sorted keys, compact separators), so ``verify_statement`` can prove on
  either side of the contract that the numbers were not altered after the
  fact. Statements intentionally contain no wall-clock field — the same
  ledger state always produces the same statement hash.

Currency policy: value captured is aggregated per ISO 4217 bucket. The
share is computed per bucket against the deployment's reporting currency
config; money in the ``UNKNOWN`` bucket (lines whose currency could not be
resolved at extraction time) is reported for transparency but is never
billed and never mixed into other buckets.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from syntropic.core.matching.api.database import RoiValueLedger

STATEMENT_SCHEMA = "syntropic.roi.statement/1"

# Buckets excluded from revenue-share math (reported, never billed).
NON_BILLABLE_BUCKETS = ("UNKNOWN",)


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _aggregate_by_currency(rows: list[RoiValueLedger]) -> dict[str, float]:
    """Sum per-currency buckets across ledger rows. Buckets never mix."""
    totals: dict[str, float] = {}
    for row in rows:
        buckets = row.delta_by_currency if isinstance(row.delta_by_currency, dict) else {}
        for code, value in buckets.items():
            amount = _float(value)
            if amount is None:
                continue
            bucket = str(code or "UNKNOWN").upper()
            totals[bucket] = totals.get(bucket, 0.0) + amount
    return {code: round(total, 6) for code, total in sorted(totals.items())}


async def _load_rows(
    session: AsyncSession,
    tenant_id: str,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
) -> list[RoiValueLedger]:
    query = select(RoiValueLedger).where(RoiValueLedger.tenant_id == tenant_id)
    if start is not None:
        query = query.where(RoiValueLedger.captured_at >= start)
    if end is not None:
        query = query.where(RoiValueLedger.captured_at < end)
    query = query.order_by(RoiValueLedger.captured_at, RoiValueLedger.id)
    return list((await session.execute(query)).scalars())


async def roi_summary(
    session: AsyncSession,
    tenant_id: str,
    *,
    start: datetime | None = None,
    end: datetime | None = None,
    share_pct: float = 0.20,
    deployment_cost: float = 50_000.0,
    reporting_currency: str = "USD",
) -> dict[str, Any]:
    """Cumulative value captured for one tenant (payback-ready summary).

    ``captured_by_currency`` is the unit of account. Payback progress is
    computed strictly against the reporting-currency bucket — money in
    other currencies is visible but never converts itself implicitly.
    """
    rows = await _load_rows(session, tenant_id, start=start, end=end)
    captured = _aggregate_by_currency(rows)
    primary = reporting_currency.upper()
    primary_captured = captured.get(primary)
    payback_pct: float | None = None
    if primary_captured is not None and deployment_cost and deployment_cost > 0:
        payback_pct = round(min(primary_captured / deployment_cost, 1.0) * 100.0, 4)
    return {
        "tenant_id": tenant_id,
        "period": {
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
        },
        "interventions": len(rows),
        "repriced_count": int(sum(row.repriced_count for row in rows)),
        "veto_count": int(sum(row.veto_count for row in rows)),
        "line_count": int(sum(row.line_count for row in rows)),
        "captured_by_currency": captured,
        "reporting_currency": primary,
        "captured_reporting_currency": (
            round(primary_captured, 6) if primary_captured is not None else None
        ),
        "share_pct": round(share_pct, 6),
        "share_reporting_currency": (
            round(primary_captured * share_pct, 6)
            if primary_captured is not None
            else None
        ),
        "deployment_cost": round(deployment_cost, 6),
        "payback_pct": payback_pct,
    }


def _statement_hash(statement: dict[str, Any]) -> str:
    canonical = json.dumps(
        statement, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def monthly_statement(
    session: AsyncSession,
    tenant_id: str,
    year: int,
    month: int,
    *,
    share_pct: float = 0.20,
    reporting_currency: str = "USD",
) -> dict[str, Any]:
    """Contractual revenue-share statement for one calendar month (UTC).

    Deterministic by construction: no wall-clock field enters the hashed
    payload, so re-running against the same ledger state reproduces the
    exact same ``statement_hash`` — the property that makes the statement
    signable and independently auditable against the Taelin stream.
    """
    if not 1 <= month <= 12:
        raise ValueError(f"month must be 1-12, got {month!r}")
    if not 1900 <= year <= 2200:
        raise ValueError(f"year must be 1900-2200, got {year!r}")

    start = datetime(year, month, 1, tzinfo=timezone.utc)
    # Half-open window [start, next_month): robust across month lengths
    # and DST-free (UTC) — a December statement rolls cleanly into the
    # next calendar year.
    if month == 12:
        next_month = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        next_month = datetime(year, month + 1, 1, tzinfo=timezone.utc)

    rows = await _load_rows(session, tenant_id, start=start, end=next_month)
    captured = _aggregate_by_currency(rows)
    share_by_currency = {
        code: round(amount * share_pct, 6)
        for code, amount in captured.items()
        if code not in NON_BILLABLE_BUCKETS
    }
    primary = reporting_currency.upper()
    anchored = [row for row in rows if row.stream_hash]

    statement: dict[str, Any] = {
        "schema": STATEMENT_SCHEMA,
        "tenant_id": tenant_id,
        "period": {
            "year": year,
            "month": month,
            "start": start.isoformat(),
            "end_exclusive": next_month.isoformat(),
        },
        "interventions": len(rows),
        "repriced_count": int(sum(row.repriced_count for row in rows)),
        "veto_count": int(sum(row.veto_count for row in rows)),
        "captured_by_currency": captured,
        "non_billable_buckets": list(NON_BILLABLE_BUCKETS),
        "share_pct": round(share_pct, 6),
        "share_by_currency": share_by_currency,
        "reporting_currency": primary,
        "share_reporting_currency": share_by_currency.get(primary),
        "anchors": {
            "ledger_rows": len(rows),
            "stream_anchored_rows": len(anchored),
            "first": (
                {"seq": anchored[0].stream_seq, "hash": anchored[0].stream_hash}
                if anchored
                else None
            ),
            "last": (
                {"seq": anchored[-1].stream_seq, "hash": anchored[-1].stream_hash}
                if anchored
                else None
            ),
        },
    }
    statement["statement_hash"] = _statement_hash(statement)
    return statement


def verify_statement(statement: dict[str, Any]) -> bool:
    """Recompute the statement hash over its canonical form.

    True only when no money field, anchor or count was mutated after the
    statement was produced. Unknown extra keys are part of the canonical
    form only if the producer hashed them; a mutated copy fails here.
    """
    if not isinstance(statement, dict) or "statement_hash" not in statement:
        return False
    expected = statement["statement_hash"]
    candidate = {key: value for key, value in statement.items() if key != "statement_hash"}
    try:
        return _statement_hash(candidate) == expected
    except (TypeError, ValueError):
        return False
