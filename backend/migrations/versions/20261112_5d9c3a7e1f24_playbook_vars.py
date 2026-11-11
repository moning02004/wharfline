"""playbook variables and password login for Git playbook jobs

jobs.play_vars: plain playbook variables [[name, value], ...] (None for other jobs).
jobs.login_key / jobs.become_key: password keys (keys.kind = "password") used to log in
and as the sudo password. job_secret_vars: the job's secret variables, envelope-encrypted
like env_sets (only the names are readable).

Revision ID: 5d9c3a7e1f24
Revises: 8b2e4f6a1c73
Create Date: 2026-11-12 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = '5d9c3a7e1f24'
down_revision: str | None = '8b2e4f6a1c73'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('play_vars', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('jobs', sa.Column('login_key', sa.String(length=128), nullable=True))
    op.add_column('jobs', sa.Column('become_key', sa.String(length=128), nullable=True))
    op.create_table(
        'job_secret_vars',
        sa.Column('job_id', sa.String(length=32), nullable=False),
        sa.Column('var_names', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('kek_id', sa.String(length=32), nullable=False),
        sa.Column('wrapped_dek', sa.LargeBinary(), nullable=False),
        sa.Column('nonce', sa.LargeBinary(), nullable=False),
        sa.Column('ciphertext', sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], name=op.f('fk_job_secret_vars_job_id_jobs'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('job_id', name=op.f('pk_job_secret_vars')),
    )


def downgrade() -> None:
    op.drop_table('job_secret_vars')
    op.drop_column('jobs', 'become_key')
    op.drop_column('jobs', 'login_key')
    op.drop_column('jobs', 'play_vars')
