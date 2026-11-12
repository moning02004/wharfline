"""Job.last_at: when the job's last run ended

The run lists showed the stored label "방금" forever. Runs already keep started_at; jobs now keep
last_at, and the screens turn both into "N분 전". Filled from each job's latest run.

Revision ID: 9e4b2c7a1f30
Revises: 7c1e9b3d5a02
Create Date: 2026-11-14 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '9e4b2c7a1f30'
down_revision: str | None = '7c1e9b3d5a02'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('last_at', sa.Float(), nullable=True))
    op.execute("UPDATE jobs SET last_at = (SELECT max(r.started_at) FROM runs r WHERE r.job_id = jobs.id)")


def downgrade() -> None:
    op.drop_column('jobs', 'last_at')
