"""pin each server's SSH host key

hosts.host_fingerprint: the "SHA256:…" fingerprint seen by the connection check when the server
was added (or on its first real deploy). Every deploy compares the server's key with it.

Revision ID: 7a1d3e9c4b52
Revises: f3c9a1d7e526
Create Date: 2026-11-10 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '7a1d3e9c4b52'
down_revision: str | None = 'f3c9a1d7e526'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('hosts', sa.Column('host_fingerprint', sa.String(length=128), nullable=True))


def downgrade() -> None:
    op.drop_column('hosts', 'host_fingerprint')
