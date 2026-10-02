"""Create the PostgreSQL RFQ review queue."""

from typing import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "0001_review_jobs"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rfq_jobs",
        sa.Column("job_id", sa.String(length=36), primary_key=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("execution_result", sa.JSON(), nullable=False),
        sa.Column("review_decision", sa.String(length=16), nullable=True),
        sa.Column("review_note", sa.String(length=1000), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_rfq_jobs_status", "rfq_jobs", ["status"])


def downgrade() -> None:
    op.drop_index("ix_rfq_jobs_status", table_name="rfq_jobs")
    op.drop_table("rfq_jobs")
