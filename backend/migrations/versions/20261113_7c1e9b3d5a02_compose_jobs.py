"""Compose jobs; password login removed

jobs.compose: the job is a Docker Compose app; jobs.repo / jobs.book then point at the repo and the
compose file in it (empty when the file was pasted). Server setup replaced password login, so
jobs.login_key, jobs.become_key and the "password" keys go away.

Revision ID: 7c1e9b3d5a02
Revises: 5d9c3a7e1f24
Create Date: 2026-11-13 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '7c1e9b3d5a02'
down_revision: str | None = '5d9c3a7e1f24'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('compose', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.drop_column('jobs', 'become_key')
    op.drop_column('jobs', 'login_key')
    op.execute("DELETE FROM keys WHERE kind = 'password'")


def downgrade() -> None:
    op.add_column('jobs', sa.Column('login_key', sa.String(length=128), nullable=True))
    op.add_column('jobs', sa.Column('become_key', sa.String(length=128), nullable=True))
    op.drop_column('jobs', 'compose')
