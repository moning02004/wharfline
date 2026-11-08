"""deploy jobs carry a file bundle and several watched images

- jobs.files: files uploaded to SERVICE_PATH before an SSH script runs
  ([{path, content}]; docker-compose.yaml, a Kubernetes yaml set, a Makefile...)
- jobs.extra_images: more images to watch besides the main one
  ([{ref, var, defaultTag, tagNow}]; VAR -> $VAR_IMAGE, $VAR_TAG, $VAR_IMAGE_REF)
- runs.extra_tags: the tag each extra image ran with ({VAR: tag})

Revision ID: d5f1a7b3c824
Revises: c2a8d4e6f190
Create Date: 2026-11-08 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'd5f1a7b3c824'
down_revision: str | None = 'c2a8d4e6f190'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('files', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('jobs', sa.Column('extra_images', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column('runs', sa.Column('extra_tags', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade() -> None:
    op.drop_column('runs', 'extra_tags')
    op.drop_column('jobs', 'extra_images')
    op.drop_column('jobs', 'files')
