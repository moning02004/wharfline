"""run approvals

Deployers running a protected job (and auto-deploys of protected jobs) create
a run with status "approval" that only starts once an Owner or Admin approves
it; a rejected one ends as "rejected". Runs remember who asked, who decided,
and when.

Revision ID: a4c81e5d39f2
Revises: e7b3d1f02a64
Create Date: 2026-11-08 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = 'a4c81e5d39f2'
down_revision: str | None = 'e7b3d1f02a64'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('runs', sa.Column('requested_by', sa.String(length=255), nullable=True))
    op.add_column('runs', sa.Column('decided_by', sa.String(length=255), nullable=True))
    op.add_column('runs', sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('runs', 'decided_at')
    op.drop_column('runs', 'decided_by')
    op.drop_column('runs', 'requested_by')
