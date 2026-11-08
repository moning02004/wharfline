"""deploy jobs can run an SSH script instead of a playbook

A script job keeps its ordered steps ({name, run}) in jobs.script and has no
playbook repo, so jobs.repo and jobs.book become nullable.

Revision ID: b7e3c9d2f415
Revises: a4c7e2f91b36
Create Date: 2026-11-08 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'b7e3c9d2f415'
down_revision: str | None = 'a4c7e2f91b36'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('script', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.alter_column('jobs', 'repo', existing_type=sa.String(length=255), nullable=True)
    op.alter_column('jobs', 'book', existing_type=sa.String(length=255), nullable=True)


def downgrade() -> None:
    # Script jobs have no playbook: move them to the built-in playbook before the columns become required again.
    op.execute("UPDATE jobs SET repo = 'wharfline-builtin', book = 'container.yml' WHERE repo IS NULL OR book IS NULL")
    op.alter_column('jobs', 'book', existing_type=sa.String(length=255), nullable=False)
    op.alter_column('jobs', 'repo', existing_type=sa.String(length=255), nullable=False)
    op.drop_column('jobs', 'script')
