"""Agents: servers deploy through a Wharfline agent instead of SSH

hosts.agent_*: the agent on the server (id, Ed25519 signing and X25519 sealing public keys, version, last
contact, what it reports).
agent_enroll_tokens: one-time tokens an agent trades for its place (SHA-256 only, expire in minutes).
run_artifacts: files a playbook fetched to its controller during a run, sealed with envelope encryption.
jobs.run_user: the server account a job runs as (None: the inventory's user).

Revision ID: a7f3c91e2b04
Revises: 4b8d2e6a9c13
Create Date: 2026-11-20 10:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'a7f3c91e2b04'
down_revision: str | None = '4b8d2e6a9c13'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENVELOPE_COMPLETE = (
    "(kek_id IS NULL AND wrapped_dek IS NULL AND nonce IS NULL AND ciphertext IS NULL) OR "
    "(kek_id IS NOT NULL AND wrapped_dek IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL)"
)


def upgrade() -> None:
    op.add_column('hosts', sa.Column('agent_id', sa.String(length=32), nullable=True))
    op.add_column('hosts', sa.Column('agent_key', sa.String(length=64), nullable=True))
    op.add_column('hosts', sa.Column('agent_box', sa.String(length=64), nullable=True))
    op.add_column('hosts', sa.Column('agent_version', sa.String(length=64), nullable=True))
    op.add_column('hosts', sa.Column('agent_seen', sa.Float(), nullable=True))
    op.add_column('hosts', sa.Column('agent_info', postgresql.JSONB(astext_type=sa.Text()),
                                     server_default=sa.text("'{}'::jsonb"), nullable=False))
    op.create_unique_constraint(op.f('uq_hosts_agent_id'), 'hosts', ['agent_id'])

    op.create_table(
        'agent_enroll_tokens',
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('host_id', sa.Integer(), nullable=False),
        sa.Column('expires_at', sa.Float(), nullable=False),
        sa.Column('created_by', sa.String(length=255), nullable=True),
        sa.Column('used_at', sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(['host_id'], ['hosts.id'], name=op.f('fk_agent_enroll_tokens_host_id_hosts'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('token_hash', name=op.f('pk_agent_enroll_tokens')),
    )
    op.create_index(op.f('ix_agent_enroll_tokens_host_id'), 'agent_enroll_tokens', ['host_id'], unique=False)

    op.create_table(
        'run_artifacts',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('run_no', sa.Integer(), nullable=False),
        sa.Column('host', sa.String(length=128), nullable=False),
        sa.Column('path', sa.String(length=512), nullable=False),
        sa.Column('size', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.Float(), nullable=False),
        sa.Column('kek_id', sa.String(length=32), nullable=True),
        sa.Column('wrapped_dek', sa.LargeBinary(), nullable=True),
        sa.Column('nonce', sa.LargeBinary(), nullable=True),
        sa.Column('ciphertext', sa.LargeBinary(), nullable=True),
        sa.CheckConstraint(ENVELOPE_COMPLETE, name=op.f('ck_run_artifacts_envelope_complete')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_run_artifacts')),
    )
    op.create_index(op.f('ix_run_artifacts_run_no'), 'run_artifacts', ['run_no'], unique=False)

    op.add_column('jobs', sa.Column('run_user', sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column('jobs', 'run_user')
    op.drop_index(op.f('ix_run_artifacts_run_no'), table_name='run_artifacts')
    op.drop_table('run_artifacts')
    op.drop_index(op.f('ix_agent_enroll_tokens_host_id'), table_name='agent_enroll_tokens')
    op.drop_table('agent_enroll_tokens')
    op.drop_constraint(op.f('uq_hosts_agent_id'), 'hosts', type_='unique')
    for col in ('agent_info', 'agent_seen', 'agent_version', 'agent_box', 'agent_key', 'agent_id'):
        op.drop_column('hosts', col)
