"""order image tags by pushed_at

Revision ID: 687d7079440e
Revises: 6b277058de16
Create Date: 2026-11-07 06:24:33.239845
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '687d7079440e'
down_revision: str | None = '6b277058de16'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Existing rows were ordered "lower id = newer"; keep that order with a decreasing value
    # that sorts below any real timestamp added from now on.
    op.add_column('image_tags', sa.Column('pushed_at', sa.Float(), nullable=True))
    op.execute("UPDATE image_tags SET pushed_at = 1000000000 - id")
    op.alter_column('image_tags', 'pushed_at', nullable=False)


def downgrade() -> None:
    op.drop_column('image_tags', 'pushed_at')
