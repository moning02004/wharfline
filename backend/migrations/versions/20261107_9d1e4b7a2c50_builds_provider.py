"""builds remember which Git host sent them

The integration now takes webhooks from Gitea, GitHub and GitLab. Builds that
came in before were all from Gitea.

Revision ID: 9d1e4b7a2c50
Revises: 3f9a6c1d2e85
Create Date: 2026-11-07 21:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '9d1e4b7a2c50'
down_revision: str | None = '3f9a6c1d2e85'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('builds', sa.Column('provider', sa.String(length=16), server_default='gitea', nullable=False))


def downgrade() -> None:
    op.drop_column('builds', 'provider')
