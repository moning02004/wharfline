"""Security policy: the default session is now 6 hours without an idle timeout

The old default "8시간 (활동 없으면 30분)" signed people out after 30 idle minutes. Servers still on that
old default move to "6시간"; a session length someone picked on purpose is left alone.

Revision ID: 4b8d2e6a9c13
Revises: 9e4b2c7a1f30
Create Date: 2026-11-15 10:00:00.000000
"""

from collections.abc import Sequence

from alembic import op


revision: str = '4b8d2e6a9c13'
down_revision: str | None = '9e4b2c7a1f30'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD = "8시간 (활동 없으면 30분)"
NEW = "6시간"


def upgrade() -> None:
    op.execute(f"""UPDATE settings SET value = jsonb_set(value, '{{session}}', '"{NEW}"')
                   WHERE key = 'policy' AND value->>'session' = '{OLD}'""")


def downgrade() -> None:
    op.execute(f"""UPDATE settings SET value = jsonb_set(value, '{{session}}', '"{OLD}"')
                   WHERE key = 'policy' AND value->>'session' = '{NEW}'""")
