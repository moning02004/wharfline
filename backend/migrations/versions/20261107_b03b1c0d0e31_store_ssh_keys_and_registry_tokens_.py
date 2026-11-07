"""store ssh keys and registry tokens encrypted

Revision ID: b03b1c0d0e31
Revises: 8c2f4b1e9a07
Create Date: 2026-11-07 01:13:55.743724
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = 'b03b1c0d0e31'
down_revision: str | None = '8c2f4b1e9a07'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


ENVELOPE_COMPLETE = (
    "(kek_id IS NULL AND wrapped_dek IS NULL AND nonce IS NULL AND ciphertext IS NULL) OR "
    "(kek_id IS NOT NULL AND wrapped_dek IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL)"
)


def upgrade() -> None:
    op.add_column('keys', sa.Column('public_key', sa.Text(), nullable=True))
    op.add_column('keys', sa.Column('kek_id', sa.String(length=32), nullable=True))
    op.add_column('keys', sa.Column('wrapped_dek', sa.LargeBinary(), nullable=True))
    op.add_column('keys', sa.Column('nonce', sa.LargeBinary(), nullable=True))
    op.add_column('keys', sa.Column('ciphertext', sa.LargeBinary(), nullable=True))
    op.add_column('registries', sa.Column('kek_id', sa.String(length=32), nullable=True))
    op.add_column('registries', sa.Column('wrapped_dek', sa.LargeBinary(), nullable=True))
    op.add_column('registries', sa.Column('nonce', sa.LargeBinary(), nullable=True))
    op.add_column('registries', sa.Column('ciphertext', sa.LargeBinary(), nullable=True))
    # A secret is either fully present or absent; never half-written.
    for table in ("keys", "registries"):
        op.create_check_constraint("envelope_complete", table, ENVELOPE_COMPLETE)


def downgrade() -> None:
    op.drop_column('registries', 'ciphertext')
    op.drop_column('registries', 'nonce')
    op.drop_column('registries', 'wrapped_dek')
    op.drop_column('registries', 'kek_id')
    op.drop_column('keys', 'ciphertext')
    op.drop_column('keys', 'nonce')
    op.drop_column('keys', 'wrapped_dek')
    op.drop_column('keys', 'kek_id')
    op.drop_column('keys', 'public_key')
