"""Create the ROI value ledger (Layer 5 — commercial instrumentation).

One immutable row per RFQ margin intervention: the billing-grade
projection of the Taelin ``margin_adjusted`` stream events. Unique on
(tenant_id, job_id) so revenue-share money can never double-count; every
row carries the stream seq/hash anchor that lets an auditor re-verify it
against the tamper-evident hash chain.
"""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0005_roi_value_ledger"
down_revision: str | None = "0004_dispatch_outbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "roi_value_ledger",
        sa.Column("id", sa.Integer(), autoincrement=True, primary_key=True),
        sa.Column("tenant_id", sa.String(length=64), nullable=False),
        sa.Column("job_id", sa.String(length=36), nullable=False),
        sa.Column("decision", sa.String(length=16), nullable=False),
        sa.Column("line_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("repriced_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("veto_count", sa.Integer(), nullable=False, server_default="0"),
        # Legacy mixed-currency scalar (stream payload compat). Reporting
        # never sums this blind — per-currency truth is delta_by_currency.
        sa.Column("margin_delta", sa.Float(), nullable=False, server_default="0"),
        sa.Column("delta_by_currency", sa.JSON(), nullable=False),
        sa.Column("stream_seq", sa.Integer(), nullable=True),
        sa.Column("stream_hash", sa.String(length=64), nullable=True),
        sa.Column(
            "captured_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id", "job_id", name="uq_roi_ledger_tenant_job"
        ),
    )
    op.create_index(
        "ix_roi_ledger_tenant_captured",
        "roi_value_ledger",
        ["tenant_id", "captured_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_roi_ledger_tenant_captured", table_name="roi_value_ledger")
    op.drop_table("roi_value_ledger")
