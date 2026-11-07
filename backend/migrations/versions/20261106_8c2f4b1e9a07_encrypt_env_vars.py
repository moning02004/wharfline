"""encrypt env vars with envelope encryption

Moves env_sets.vars and env_versions.vars (plaintext JSONB) into
AES-256-GCM envelopes (see app/crypto.py). Needs the master key, like the app.

Revision ID: 8c2f4b1e9a07
Revises: 6141dc7290e4
Create Date: 2026-11-06 21:30:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from app import crypto

revision: str = "8c2f4b1e9a07"
down_revision: str | None = "6141dc7290e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ENC_COLUMNS = ("kek_id", "wrapped_dek", "nonce", "ciphertext")

# Frozen table shapes for this migration (never import ORM models in migrations).
env_sets = sa.table(
    "env_sets", sa.column("id", sa.String), sa.column("vars", postgresql.JSONB), sa.column("var_names", postgresql.JSONB),
    *(sa.column(c, sa.String if c == "kek_id" else sa.LargeBinary) for c in ENC_COLUMNS),
)
env_versions = sa.table(
    "env_versions", sa.column("id", sa.Integer), sa.column("env_id", sa.String), sa.column("ver", sa.Integer),
    sa.column("vars", postgresql.JSONB), sa.column("var_names", postgresql.JSONB),
    *(sa.column(c, sa.String if c == "kek_id" else sa.LargeBinary) for c in ENC_COLUMNS),
)


def set_context(row) -> str:
    return f"env_set:{row.id}"


def version_context(row) -> str:
    return f"env_version:{row.env_id}:{row.ver}"


def add_enc_columns(table: str) -> None:
    op.add_column(table, sa.Column("var_names", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column(table, sa.Column("kek_id", sa.String(length=32), nullable=True))
    for c in ENC_COLUMNS[1:]:
        op.add_column(table, sa.Column(c, sa.LargeBinary(), nullable=True))


def upgrade() -> None:
    ring = crypto.keyring()  # fails early if no master key is configured
    conn = op.get_bind()
    for name, tbl, ctx in (("env_sets", env_sets, set_context), ("env_versions", env_versions, version_context)):
        add_enc_columns(name)
        for row in conn.execute(sa.select(tbl)).all():
            env = crypto.seal_json(row.vars, ctx(row), ring)
            conn.execute(tbl.update().where(tbl.c.id == row.id).values(
                var_names=[k for k, _ in row.vars], kek_id=env.kek_id, wrapped_dek=env.wrapped_dek,
                nonce=env.nonce, ciphertext=env.ciphertext,
            ))
        for c in ("var_names", *ENC_COLUMNS):
            op.alter_column(name, c, nullable=False)
        op.drop_column(name, "vars")


def downgrade() -> None:
    ring = crypto.keyring()
    conn = op.get_bind()
    for name, tbl, ctx in (("env_sets", env_sets, set_context), ("env_versions", env_versions, version_context)):
        op.add_column(name, sa.Column("vars", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
        for row in conn.execute(sa.select(tbl)).all():
            env = crypto.Envelope(row.kek_id, row.wrapped_dek, row.nonce, row.ciphertext)
            conn.execute(tbl.update().where(tbl.c.id == row.id).values(vars=crypto.open_json(env, ctx(row), ring)))
        op.alter_column(name, "vars", nullable=False)
        for c in ("var_names", *ENC_COLUMNS):
            op.drop_column(name, c)
