"""job editors and creator

Jobs remember who made them (member email) and who else may edit them:
`editors` holds group ids and member emails. Owners and Admins can always
edit; Viewers never can.

Revision ID: e7b3d1f02a64
Revises: c5e2a9f4b781
Create Date: 2026-11-07 23:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'e7b3d1f02a64'
down_revision: str | None = 'c5e2a9f4b781'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('editors', postgresql.JSONB(astext_type=sa.Text()),
                                    server_default=sa.text('\'{"groups": [], "members": []}\'::jsonb'), nullable=False))
    op.add_column('jobs', sa.Column('created_by', sa.String(length=255), nullable=True))


def downgrade() -> None:
    op.drop_column('jobs', 'created_by')
    op.drop_column('jobs', 'editors')
