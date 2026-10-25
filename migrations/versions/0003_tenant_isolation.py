"""Add tenant isolation columns and composite indexes.

Pre-isolation rows are backfilled with the ``__legacy__`` sentinel tenant and
require operational reassignment before multi-tenant go-live. The columns are
then constrained NOT NULL so every future row must carry a tenant.
"""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0003_tenant_isolation"
down_revision: str | None = "0002_webhook_outbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_TENANT_ID = "__legacy__"


def upgrade() -> None:
    op.add_column(
        "rfq_jobs",
        sa.Column("tenant_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "webhook_outbox",
        sa.Column("tenant_id", sa.String(length=64), nullable=True),
    )

    # Forward-compatible migration: seed first, then constrain, so the deploy
    # never violates NOT NULL mid-flight.
    op.execute(
        "UPDATE rfq_jobs SET tenant_id = '__legacy__' WHERE tenant_id IS NULL"
    )
    op.execute(
        "UPDATE webhook_outbox SET tenant_id = '__legacy__' "
        "WHERE tenant_id IS NULL"
    )

    op.alter_column("rfq_jobs", "tenant_id", nullable=False)
    op.alter_column("webhook_outbox", "tenant_id", nullable=False)

    op.create_index(
        "ix_rfq_jobs_tenant_status", "rfq_jobs", ["tenant_id", "status"]
    )
    op.create_index(
        "ix_webhook_outbox_tenant_status", "webhook_outbox", ["tenant_id", "status"]
    )


def downgrade() -> None:
    op.drop_index(
        "ix_webhook_outbox_tenant_status", table_name="webhook_outbox"
    )
    op.drop_index("ix_rfq_jobs_tenant_status", table_name="rfq_jobs")
    op.alter_column("webhook_outbox", "tenant_id", nullable=True)
    op.alter_column("rfq_jobs", "tenant_id", nullable=True)
    op.drop_column("webhook_outbox", "tenant_id")
    op.drop_column("rfq_jobs", "tenant_id")
