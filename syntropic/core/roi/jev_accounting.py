"""General Ledger (GL) Journal Entry Voucher (JEV) Module.

Layer 5 commercial instrumentation. Converts Syntropic ROI statements and
margin value captures into balanced double-entry accounting records
(Debits = Credits) suitable for enterprise General Ledger systems
(SAP BAPI, NetSuite, Oracle Financials, Dynamics 365).
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class JournalEntryLine(BaseModel):
    """Single balanced debit or credit line item in a GL Journal Entry."""

    account_code: str = Field(
        ...,
        description="General Ledger account code (e.g., '1200-AR-SYNTROPIC', '4900-MARGIN-CAPTURE-GAIN')",
    )
    description: str = Field(
        ...,
        description="Accounting memo or line item description",
    )
    debit_amount: float = Field(
        0.0,
        ge=0.0,
        description="Debit amount in line currency",
    )
    credit_amount: float = Field(
        0.0,
        ge=0.0,
        description="Credit amount in line currency",
    )
    currency: str = Field(
        ...,
        min_length=3,
        max_length=3,
        description="ISO 4217 currency code for this GL line item",
    )


class JournalEntryVoucher(BaseModel):
    """Balanced double-entry Journal Entry Voucher (JEV) document."""

    jev_id: str = Field(..., description="Unique Journal Entry Voucher identifier")
    tenant_id: str = Field(..., description="Client Enclave tenant ID")
    posting_date: str = Field(..., description="ISO 8601 posting date")
    accounting_period: str = Field(..., description="Accounting period string (e.g. '2026-11')")
    reference: str = Field(..., description="External audit reference or statement hash")
    entries: List[JournalEntryLine] = Field(
        default_factory=list,
        description="List of balanced GL line entries",
    )
    total_debit: float = Field(0.0, ge=0.0, description="Total debits across all lines")
    total_credit: float = Field(0.0, ge=0.0, description="Total credits across all lines")
    is_balanced: bool = Field(True, description="True when total debits equals total credits")


def build_monthly_statement_jev(statement: Dict[str, Any]) -> JournalEntryVoucher:
    """Generates a balanced GL Journal Entry Voucher from a monthly ROI statement."""
    tenant_id = str(statement.get("tenant_id", ""))
    period = statement.get("period", {})
    year = period.get("year", datetime.now(timezone.utc).year)
    month = period.get("month", datetime.now(timezone.utc).month)
    period_str = f"{year:04d}-{month:02d}"
    statement_hash = str(statement.get("statement_hash", ""))[:12]

    lines: List[JournalEntryLine] = []
    total = 0.0

    share_by_currency = statement.get("share_by_currency", {})
    for curr, share_amount in share_by_currency.items():
        if not isinstance(share_amount, (int, float)) or share_amount <= 0:
            continue
        amt = round(float(share_amount), 2)
        curr_code = str(curr).upper()

        # Debit Accounts Receivable (Syntropic ROI Fee)
        lines.append(
            JournalEntryLine(
                account_code="1200-AR-SYNTROPIC",
                description=f"Syntropic ROI Share - Period {period_str} ({curr_code})",
                debit_amount=amt,
                credit_amount=0.0,
                currency=curr_code,
            )
        )
        # Credit Margin Enhancement Revenue / Realized Value Gain
        lines.append(
            JournalEntryLine(
                account_code="4900-MARGIN-CAPTURE-GAIN",
                description=f"Syntropic Value Capture Realized ({curr_code})",
                debit_amount=0.0,
                credit_amount=amt,
                currency=curr_code,
            )
        )
        total += amt

    total_debit = round(sum(line.debit_amount for line in lines), 2)
    total_credit = round(sum(line.credit_amount for line in lines), 2)

    return JournalEntryVoucher(
        jev_id=f"JEV-{tenant_id}-{year:04d}{month:02d}",
        tenant_id=tenant_id,
        posting_date=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        accounting_period=period_str,
        reference=f"Syntropic Statement Hash {statement_hash}",
        entries=lines,
        total_debit=total_debit,
        total_credit=total_credit,
        is_balanced=(total_debit == total_credit),
    )
