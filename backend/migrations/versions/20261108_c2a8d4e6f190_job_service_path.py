"""SSH script jobs have a service path on the target servers

The folder the script works in (SERVICE_PATH), e.g. /srv/api-server. The job's
.env is uploaded there too, so docker compose picks it up.

Revision ID: c2a8d4e6f190
Revises: b7e3c9d2f415
Create Date: 2026-11-08 13:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = 'c2a8d4e6f190'
down_revision: str | None = 'b7e3c9d2f415'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('service_path', sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column('jobs', 'service_path')
