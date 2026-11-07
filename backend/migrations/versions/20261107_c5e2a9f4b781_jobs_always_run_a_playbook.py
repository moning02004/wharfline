"""jobs always run a playbook

The Docker Compose deploy method is gone. Compose jobs move to the built-in
playbook (wharfline-builtin / container.yml), which runs one image with its
.env. Repos no longer keep a list of playbooks; each job names its own path.
Jobs may have no image.

Revision ID: c5e2a9f4b781
Revises: 9d1e4b7a2c50
Create Date: 2026-11-07 23:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = 'c5e2a9f4b781'
down_revision: str | None = '9d1e4b7a2c50'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BUILTIN = 'wharfline-builtin'
BOOK = 'container.yml'

repos = sa.table('repos', sa.column('name', sa.String), sa.column('kind', sa.String), sa.column('url', sa.Text),
                 sa.column('branch', sa.String), sa.column('auth', sa.String), sa.column('commit', sa.String))
jobs = sa.table('jobs', sa.column('id', sa.String), sa.column('name', sa.String), sa.column('method', sa.String),
                sa.column('image', sa.String), sa.column('repo', sa.String), sa.column('book', sa.String),
                sa.column('dir', sa.String), sa.column('compose', sa.Text))

# Same template the compose jobs were seeded with; used only by downgrade.
COMPOSE_TPL = (
    "services:\n"
    "  app:\n"
    "    image: ${IMAGE}:${IMAGE_TAG}\n"
    "    env_file: .env\n"
    "    restart: unless-stopped\n"
    "    ports:\n"
    '      - "8080:8080"\n'
    "    healthcheck:\n"
    '      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]\n'
    "      interval: 10s\n"
)


def upgrade() -> None:
    conn = op.get_bind()
    op.drop_column('repos', 'books')
    if not conn.scalar(sa.select(repos.c.name).where(repos.c.name == BUILTIN)):
        op.bulk_insert(repos, [{'name': BUILTIN, 'kind': 'builtin', 'url': '/var/lib/wharfline/playbooks/builtin',
                                'branch': '-', 'auth': '-', 'commit': '-'}])
    op.execute(jobs.update()
               .where(sa.or_(jobs.c.method == 'compose', jobs.c.repo.is_(None), jobs.c.book.is_(None)))
               .values(repo=BUILTIN, book=BOOK))
    op.drop_column('jobs', 'compose')
    op.drop_column('jobs', 'dir')
    op.drop_column('jobs', 'method')
    op.alter_column('jobs', 'image', existing_type=sa.String(length=512), nullable=True)
    op.alter_column('jobs', 'repo', existing_type=sa.String(length=255), nullable=False)
    op.alter_column('jobs', 'book', existing_type=sa.String(length=255), nullable=False)


def downgrade() -> None:
    # Best effort: built-in playbook jobs become compose jobs again; jobs without an image get an empty one.
    op.alter_column('jobs', 'book', existing_type=sa.String(length=255), nullable=True)
    op.alter_column('jobs', 'repo', existing_type=sa.String(length=255), nullable=True)
    op.execute(jobs.update().where(jobs.c.image.is_(None)).values(image=''))
    op.alter_column('jobs', 'image', existing_type=sa.String(length=512), nullable=False)
    op.add_column('jobs', sa.Column('method', sa.String(length=16), server_default='ansible', nullable=False))
    op.add_column('jobs', sa.Column('dir', sa.String(length=512), nullable=True))
    op.add_column('jobs', sa.Column('compose', sa.Text(), nullable=True))
    op.alter_column('jobs', 'method', server_default=None)
    conn = op.get_bind()
    for job_id, name in conn.execute(sa.select(jobs.c.id, jobs.c.name).where(jobs.c.repo == BUILTIN)).all():
        slug = ''.join(c if c.isalnum() and c.isascii() else '-' for c in name.lower()).strip('-') or 'app'
        while '--' in slug:
            slug = slug.replace('--', '-')
        op.execute(jobs.update().where(jobs.c.id == job_id)
                   .values(method='compose', dir=f'/srv/{slug}', compose=COMPOSE_TPL, repo=None, book=None))
    op.execute(repos.delete().where(repos.c.name == BUILTIN))
    op.add_column('repos', sa.Column('books', postgresql.JSONB(astext_type=sa.Text()), server_default='[]', nullable=False))
    op.alter_column('repos', 'books', server_default=None)
