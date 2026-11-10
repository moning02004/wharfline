"""each inventory names the SSH user its servers deploy as

inventories.ssh_user: chosen when the inventory is made (default "deploy"); new servers use it.

Revision ID: 8b2e4f6a1c73
Revises: 7a1d3e9c4b52
Create Date: 2026-11-11 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '8b2e4f6a1c73'
down_revision: str | None = '7a1d3e9c4b52'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('inventories', sa.Column('ssh_user', sa.String(length=32), nullable=False, server_default='deploy'))


def downgrade() -> None:
    op.drop_column('inventories', 'ssh_user')
