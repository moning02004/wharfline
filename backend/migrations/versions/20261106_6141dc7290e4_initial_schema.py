"""initial schema

Revision ID: 6141dc7290e4
Revises: 
Create Date: 2026-11-06 20:59:27.891149
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '6141dc7290e4'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Autogenerate does not detect standalone sequences, so this one is written by hand.
    # Run numbers continue after the sample history (#179–#184).
    op.execute(sa.schema.CreateSequence(sa.Sequence("run_no_seq", start=185)))
    op.create_table('activity',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('time', sa.String(length=32), nullable=False),
    sa.Column('username', sa.String(length=128), nullable=False),
    sa.Column('action', sa.String(length=128), nullable=False),
    sa.Column('object', sa.Text(), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=False),
    sa.Column('result', sa.String(length=16), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_activity'))
    )
    op.create_table('device_sessions',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('agent', sa.String(length=255), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=False),
    sa.Column('location', sa.String(length=128), nullable=False),
    sa.Column('time', sa.String(length=64), nullable=False),
    sa.Column('current', sa.Boolean(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_device_sessions'))
    )
    op.create_table('env_sets',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('ver', sa.Integer(), nullable=False),
    sa.Column('updated', sa.String(length=128), nullable=False),
    sa.Column('vars', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_env_sets')),
    sa.UniqueConstraint('name', name=op.f('uq_env_sets_name'))
    )
    op.create_table('inventories',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('key', sa.String(length=128), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_inventories')),
    sa.UniqueConstraint('name', name=op.f('uq_inventories_name'))
    )
    op.create_table('jobs',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('method', sa.String(length=16), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('image', sa.String(length=512), nullable=False),
    sa.Column('tag_now', sa.String(length=128), nullable=False),
    sa.Column('default_tag', sa.String(length=128), nullable=False),
    sa.Column('repo', sa.String(length=255), nullable=True),
    sa.Column('book', sa.String(length=255), nullable=True),
    sa.Column('dir', sa.String(length=512), nullable=True),
    sa.Column('compose', sa.Text(), nullable=True),
    sa.Column('inventory', sa.String(length=128), nullable=False),
    sa.Column('targets', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('env', sa.String(length=255), nullable=False),
    sa.Column('hook', sa.Boolean(), nullable=False),
    sa.Column('protected', sa.Boolean(), nullable=False),
    sa.Column('lock', sa.Boolean(), nullable=False),
    sa.Column('rollback', sa.Boolean(), nullable=False),
    sa.Column('last_status', sa.String(length=16), nullable=False),
    sa.Column('last_time', sa.String(length=64), nullable=False),
    sa.Column('last_duration', sa.String(length=32), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_jobs')),
    sa.UniqueConstraint('name', name=op.f('uq_jobs_name'))
    )
    op.create_table('keys',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('type', sa.String(length=32), nullable=False),
    sa.Column('fingerprint', sa.String(length=256), nullable=False),
    sa.Column('created_by', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.String(length=32), nullable=False),
    sa.Column('last_used', sa.String(length=64), nullable=False),
    sa.Column('used_count', sa.Integer(), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_keys')),
    sa.UniqueConstraint('name', name=op.f('uq_keys_name'))
    )
    op.create_table('logins',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('time', sa.String(length=32), nullable=False),
    sa.Column('username', sa.String(length=255), nullable=False),
    sa.Column('method', sa.String(length=64), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=False),
    sa.Column('location', sa.String(length=128), nullable=False),
    sa.Column('agent', sa.String(length=255), nullable=False),
    sa.Column('result', sa.String(length=16), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_logins'))
    )
    op.create_table('members',
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('tfa', sa.Boolean(), nullable=False),
    sa.Column('last', sa.String(length=64), nullable=False),
    sa.PrimaryKeyConstraint('email', name=op.f('pk_members'))
    )
    op.create_table('menu_access',
    sa.Column('menu', sa.String(length=32), nullable=False),
    sa.Column('roles', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('menu', name=op.f('pk_menu_access'))
    )
    op.create_table('registries',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('host', sa.String(length=255), nullable=False),
    sa.Column('namespace', sa.String(length=128), nullable=False),
    sa.Column('auth', sa.String(length=128), nullable=False),
    sa.Column('username', sa.String(length=128), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_registries'))
    )
    op.create_table('repos',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('url', sa.Text(), nullable=False),
    sa.Column('branch', sa.String(length=128), nullable=False),
    sa.Column('auth', sa.String(length=255), nullable=False),
    sa.Column('commit', sa.String(length=64), nullable=False),
    sa.Column('books', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_repos')),
    sa.UniqueConstraint('name', name=op.f('uq_repos_name'))
    )
    op.create_table('runs',
    sa.Column('no', sa.Integer(), autoincrement=False, nullable=False),
    sa.Column('job', sa.String(length=255), nullable=False),
    sa.Column('job_id', sa.String(length=32), nullable=False),
    sa.Column('target', sa.String(length=255), nullable=False),
    sa.Column('tag', sa.String(length=128), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('by', sa.String(length=64), nullable=False),
    sa.Column('trigger', sa.String(length=64), nullable=False),
    sa.Column('time', sa.String(length=64), nullable=False),
    sa.Column('duration', sa.String(length=32), nullable=False),
    sa.Column('steps', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('log', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('started_at', sa.Float(), nullable=True),
    sa.PrimaryKeyConstraint('no', name=op.f('pk_runs'))
    )
    op.create_index(op.f('ix_runs_job_id'), 'runs', ['job_id'], unique=False)
    op.create_table('settings',
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('value', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('key', name=op.f('pk_settings'))
    )
    op.create_table('env_versions',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('env_id', sa.String(length=32), nullable=False),
    sa.Column('ver', sa.Integer(), nullable=False),
    sa.Column('updated', sa.String(length=128), nullable=False),
    sa.Column('vars', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.ForeignKeyConstraint(['env_id'], ['env_sets.id'], name=op.f('fk_env_versions_env_id_env_sets'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_env_versions'))
    )
    op.create_index(op.f('ix_env_versions_env_id'), 'env_versions', ['env_id'], unique=False)
    op.create_table('hosts',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('inventory_id', sa.String(length=32), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('ip', sa.String(length=255), nullable=False),
    sa.Column('port', sa.Integer(), nullable=False),
    sa.Column('ssh_user', sa.String(length=64), nullable=False),
    sa.Column('grp', sa.String(length=64), nullable=False),
    sa.Column('host_key', sa.String(length=16), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(['inventory_id'], ['inventories.id'], name=op.f('fk_hosts_inventory_id_inventories'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_hosts'))
    )
    op.create_index(op.f('ix_hosts_inventory_id'), 'hosts', ['inventory_id'], unique=False)
    op.create_table('images',
    sa.Column('ref', sa.String(length=512), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('registry_id', sa.String(length=32), nullable=True),
    sa.ForeignKeyConstraint(['registry_id'], ['registries.id'], name=op.f('fk_images_registry_id_registries'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('ref', name=op.f('pk_images'))
    )
    op.create_table('image_tags',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('image_ref', sa.String(length=512), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('digest', sa.String(length=128), nullable=False),
    sa.Column('pushed', sa.String(length=64), nullable=False),
    sa.ForeignKeyConstraint(['image_ref'], ['images.ref'], name=op.f('fk_image_tags_image_ref_images'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_image_tags'))
    )
    op.create_index(op.f('ix_image_tags_image_ref'), 'image_tags', ['image_ref'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_image_tags_image_ref'), table_name='image_tags')
    op.drop_table('image_tags')
    op.drop_table('images')
    op.drop_index(op.f('ix_hosts_inventory_id'), table_name='hosts')
    op.drop_table('hosts')
    op.drop_index(op.f('ix_env_versions_env_id'), table_name='env_versions')
    op.drop_table('env_versions')
    op.drop_table('settings')
    op.drop_index(op.f('ix_runs_job_id'), table_name='runs')
    op.drop_table('runs')
    op.drop_table('repos')
    op.drop_table('registries')
    op.drop_table('menu_access')
    op.drop_table('members')
    op.drop_table('logins')
    op.drop_table('keys')
    op.drop_table('jobs')
    op.drop_table('inventories')
    op.drop_table('env_sets')
    op.drop_table('device_sessions')
    op.drop_table('activity')
    op.execute(sa.schema.DropSequence(sa.Sequence("run_no_seq")))
