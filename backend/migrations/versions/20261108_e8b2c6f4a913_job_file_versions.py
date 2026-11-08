"""keep every version of a job's file bundle, and which one each run deployed

job_file_versions holds the full files of each version with who, when and what
changed; jobs.files_ver points at the current one and runs.files_ver at the
one a run used. Jobs that already have files get them as version 1.

Revision ID: e8b2c6f4a913
Revises: d5f1a7b3c824
Create Date: 2026-11-08 15:00:00.000000
"""

import json
import time
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'e8b2c6f4a913'
down_revision: str | None = 'd5f1a7b3c824'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'job_file_versions',
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('job_id', sa.String(length=32), nullable=False),
        sa.Column('ver', sa.Integer(), nullable=False),
        sa.Column('files', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('changes', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column('created_at', sa.Float(), nullable=False),
        sa.Column('created_by', sa.String(length=128), nullable=False),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], name=op.f('fk_job_file_versions_job_id_jobs'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_job_file_versions')),
        sa.UniqueConstraint('job_id', 'ver', name=op.f('uq_job_file_versions_job_id')),
    )
    op.create_index(op.f('ix_job_file_versions_job_id'), 'job_file_versions', ['job_id'], unique=False)
    op.add_column('jobs', sa.Column('files_ver', sa.Integer(), nullable=True))
    op.add_column('runs', sa.Column('files_ver', sa.Integer(), nullable=True))

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, files FROM jobs WHERE files IS NOT NULL AND jsonb_array_length(files) > 0")).all()
    for job_id, files in rows:
        changes = {"added": [f["path"] for f in files], "changed": [], "removed": []}
        conn.execute(sa.text("INSERT INTO job_file_versions (job_id, ver, files, changes, created_at, created_by) "
                             "VALUES (:j, 1, CAST(:f AS jsonb), CAST(:c AS jsonb), :t, '이전 기록')"),
                     {"j": job_id, "f": json.dumps(files), "c": json.dumps(changes), "t": time.time()})
        conn.execute(sa.text("UPDATE jobs SET files_ver = 1 WHERE id = :j"), {"j": job_id})


def downgrade() -> None:
    op.drop_column('runs', 'files_ver')
    op.drop_column('jobs', 'files_ver')
    op.drop_index(op.f('ix_job_file_versions_job_id'), table_name='job_file_versions')
    op.drop_table('job_file_versions')
