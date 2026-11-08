"""each job chooses which new tags trigger auto-deploy

jobs.hook_rule: "v" (starts with v and a digit, the default), "date"
(2026.11.08-1 or v2026.11.08-1), "any" (every tag but latest), or
"re:<regex>".

Revision ID: f3c9a1d7e526
Revises: e8b2c6f4a913
Create Date: 2026-11-08 16:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = 'f3c9a1d7e526'
down_revision: str | None = 'e8b2c6f4a913'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('hook_rule', sa.String(length=200), server_default='v', nullable=False))


def downgrade() -> None:
    op.drop_column('jobs', 'hook_rule')
