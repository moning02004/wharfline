"""real login: password hashes, TOTP, per-browser sessions

- `sessions`: one row per signed-in browser, keyed by the SHA-256 of the cookie token.
  Replaces the single demo session in `settings` and the fake `device_sessions` list.
- `members`: bcrypt password hash, lockout counters, envelope-encrypted TOTP secret
  (context `member_tfa:{email}`), hashed recovery codes.

Existing members get WHARFLINE_SEED_PASSWORD (default "wharfline") and must change it at
their next login. Nobody has a TOTP secret yet, so `tfa` is cleared and the policy
"모든 멤버에게 2단계 인증 강제" is turned off (members turn 2FA on themselves).

Revision ID: a4c7e2f91b36
Revises: e7b3d1f02a64
Create Date: 2026-11-08 10:00:00.000000
"""

import os
from collections.abc import Sequence

import bcrypt
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'a4c7e2f91b36'
down_revision: str | None = 'e7b3d1f02a64'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENVELOPE_COMPLETE = (
    "(kek_id IS NULL AND wrapped_dek IS NULL AND nonce IS NULL AND ciphertext IS NULL) OR "
    "(kek_id IS NOT NULL AND wrapped_dek IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL)"
)


def upgrade() -> None:
    op.add_column('members', sa.Column('password_hash', sa.String(length=255), nullable=True))
    op.add_column('members', sa.Column('must_change_password', sa.Boolean(), server_default=sa.text('false'), nullable=False))
    op.add_column('members', sa.Column('failed_logins', sa.Integer(), server_default=sa.text('0'), nullable=False))
    op.add_column('members', sa.Column('locked_until', sa.Float(), nullable=True))
    op.add_column('members', sa.Column('recovery_codes', postgresql.JSONB(astext_type=sa.Text()),
                                       server_default=sa.text("'[]'::jsonb"), nullable=False))
    op.add_column('members', sa.Column('tfa_last_step', sa.BigInteger(), nullable=True))
    op.add_column('members', sa.Column('kek_id', sa.String(length=32), nullable=True))
    op.add_column('members', sa.Column('wrapped_dek', sa.LargeBinary(), nullable=True))
    op.add_column('members', sa.Column('nonce', sa.LargeBinary(), nullable=True))
    op.add_column('members', sa.Column('ciphertext', sa.LargeBinary(), nullable=True))
    op.create_check_constraint('envelope_complete', 'members', ENVELOPE_COMPLETE)

    op.create_table(
        'sessions',
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('member_email', sa.String(length=255), nullable=False),
        sa.Column('stage', sa.String(length=16), nullable=False),
        sa.Column('created_at', sa.Float(), nullable=False),
        sa.Column('last_seen', sa.Float(), nullable=False),
        sa.Column('expires_at', sa.Float(), nullable=False),
        sa.Column('sudo_until', sa.Float(), nullable=False),
        sa.Column('user_agent', sa.String(length=512), nullable=False),
        sa.Column('ip', sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(['member_email'], ['members.email'], name=op.f('fk_sessions_member_email_members'),
                                ondelete='CASCADE', onupdate='CASCADE'),
        sa.PrimaryKeyConstraint('token_hash', name=op.f('pk_sessions')),
    )
    op.create_index(op.f('ix_sessions_member_email'), 'sessions', ['member_email'], unique=False)
    op.drop_table('device_sessions')

    conn = op.get_bind()
    seed = (os.getenv("WHARFLINE_SEED_PASSWORD") or "wharfline").encode()[:72]
    for (email,) in conn.execute(sa.text("SELECT email FROM members WHERE password_hash IS NULL")).all():
        conn.execute(sa.text("UPDATE members SET password_hash = :h, must_change_password = true WHERE email = :e"),
                     {"h": bcrypt.hashpw(seed, bcrypt.gensalt(12)).decode(), "e": email})
    op.execute("UPDATE members SET tfa = false")
    op.execute("""UPDATE settings SET value = jsonb_set(value, '{enforce2fa}', 'false'::jsonb) WHERE key = 'policy'""")
    op.execute("DELETE FROM settings WHERE key = 'session'")


def downgrade() -> None:
    op.create_table(
        'device_sessions',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('agent', sa.String(length=255), nullable=False),
        sa.Column('ip', sa.String(length=64), nullable=False),
        sa.Column('location', sa.String(length=128), nullable=False),
        sa.Column('time', sa.String(length=64), nullable=False),
        sa.Column('current', sa.Boolean(), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_device_sessions')),
    )
    op.drop_index(op.f('ix_sessions_member_email'), table_name='sessions')
    op.drop_table('sessions')
    op.drop_constraint('envelope_complete', 'members', type_='check')
    for col in ('ciphertext', 'nonce', 'wrapped_dek', 'kek_id', 'tfa_last_step', 'recovery_codes', 'locked_until',
                'failed_logins', 'must_change_password', 'password_hash'):
        op.drop_column('members', col)
    # The old demo session: signed in as the first Owner.
    op.execute("""INSERT INTO settings (key, value)
                  SELECT 'session', jsonb_build_object('logged_in', true, 'email', email, 'pending_login', false, 'sudo_until', 0.0)
                  FROM members WHERE role = 'Owner' ORDER BY ord LIMIT 1
                  ON CONFLICT (key) DO NOTHING""")
