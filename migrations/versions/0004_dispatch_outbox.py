"""Create the durable Outlook draft dispatch outbox (Layer 4 Vector 1).

Mirrors the ERP ``webhook_outbox`` pattern: lease-claim queue with
exponential backoff plus Layer 4 telemetry columns (``sla_ms`` /
``sla_breached`` for the 90-second ingest-to-draft SLA) and the terminal
``backbone`` status with a machine-readable ``backbone_reason`` for
manual-resolution escalation.
"""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0004_dispatch_outbox"
down_revision: str | None = "0003_tenant_isolation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dispatch_outbox",
        sa.Column("event_id", sa.String(length=36), primary_key=True),
        sa.Column("tenant_id", sa.String(length=64), nullable=False),
        sa.Column(
            "job_id",
            sa.String(length=36),
            sa.ForeignKey("rfq_jobs.job_id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column(
            "status",
            sa.String(length=16),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("backbone_reason", sa.String(length=64), nullable=True),
        sa.Column("sla_ms", sa.Integer(), nullable=True),
        sa.Column("sla_breached", sa.Boolean(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("injected_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "ix_dispatch_outbox_status_available",
        "dispatch_outbox",
        ["status", "available_at"],
    )
    op.create_index(
        "ix_dispatch_outbox_tenant_status",
        "dispatch_outbox",
        ["tenant_id", "status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_dispatch_outbox_tenant_status", table_name="dispatch_outbox"
    )
    op.drop_index(
        "ix_dispatch_outbox_status_available", table_name="dispatch_outbox"
    )
    op.drop_table("dispatch_outbox")
