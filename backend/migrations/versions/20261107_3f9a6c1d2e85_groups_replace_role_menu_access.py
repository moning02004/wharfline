"""groups replace role menu access

Menus used to be switched on per role (menu_access). Now each member belongs to
groups, and a group decides which menus and which build repos its members see.
The role stays and decides what a member can do.

Existing data keeps the same screens: each role's menus become a "<role> 기본"
group that sees every build, and members join the group of their role.

Revision ID: 3f9a6c1d2e85
Revises: 687d7079440e
Create Date: 2026-11-07 18:00:00.000000
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = '3f9a6c1d2e85'
down_revision: str | None = '687d7079440e'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ROLES = ("Admin", "Deployer", "Viewer")
# The very first seed used a placeholder Owner email; login needs a real member email.
SAMPLE_OWNER_OLD, SAMPLE_OWNER_NEW = "owner@example.invalid", "jeonghoon@acme.kr"


def upgrade() -> None:
    op.create_table('groups',
    sa.Column('id', sa.String(length=32), nullable=False),
    sa.Column('ord', sa.Integer(), sa.Identity(always=False), nullable=False),
    sa.Column('name', sa.String(length=64), nullable=False),
    sa.Column('menus', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('all_builds', sa.Boolean(), nullable=False),
    sa.Column('repos', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_groups')),
    sa.UniqueConstraint('name', name=op.f('uq_groups_name'))
    )
    op.create_table('member_groups',
    sa.Column('member_email', sa.String(length=255), nullable=False),
    sa.Column('group_id', sa.String(length=32), nullable=False),
    sa.ForeignKeyConstraint(['group_id'], ['groups.id'], name=op.f('fk_member_groups_group_id_groups'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['member_email'], ['members.email'], name=op.f('fk_member_groups_member_email_members'), onupdate='CASCADE', ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('member_email', 'group_id', name=op.f('pk_member_groups'))
    )

    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT menu, roles FROM menu_access")).all()
    if rows:  # an empty database gets its groups from the seed instead
        for role in ROLES:
            gid = f"g-{role.lower()}"
            menus = [menu for menu, roles in rows if role in (roles or []) and menu != "dashboard"]
            conn.execute(sa.text("INSERT INTO groups (id, name, menus, all_builds, repos) "
                                 "VALUES (:id, :name, CAST(:menus AS jsonb), true, '[]'::jsonb)"),
                         {"id": gid, "name": f"{role} 기본", "menus": json.dumps(menus)})
            conn.execute(sa.text("INSERT INTO member_groups (member_email, group_id) SELECT email, :gid FROM members WHERE role = :role"),
                         {"gid": gid, "role": role})

    conn.execute(sa.text("UPDATE members SET email = :new WHERE email = :old AND NOT EXISTS (SELECT 1 FROM members WHERE email = :new)"),
                 {"old": SAMPLE_OWNER_OLD, "new": SAMPLE_OWNER_NEW})
    # The session now records who is signed in. Keep the current session on the first Owner.
    conn.execute(sa.text(
        "UPDATE settings SET value = value || jsonb_build_object('email', "
        "(SELECT email FROM members WHERE role = 'Owner' ORDER BY ord LIMIT 1)) "
        "WHERE key = 'session' AND NOT value ? 'email' AND (value->>'logged_in')::boolean"))

    op.drop_table('menu_access')


def downgrade() -> None:
    op.create_table('menu_access',
    sa.Column('menu', sa.String(length=32), nullable=False),
    sa.Column('roles', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.PrimaryKeyConstraint('menu', name=op.f('pk_menu_access'))
    )
    # Rebuild role menus from the "<role> 기본" groups. Other groups have no role equivalent and are dropped.
    conn = op.get_bind()
    groups = dict(conn.execute(sa.text("SELECT name, menus FROM groups")).all())
    menus = ["jobs", "runs", "registries", "repos", "inventory", "keys", "envs", "activity", "members", "security", "notes"]
    if groups:
        for menu in menus:
            roles = ["Owner"] + [r for r in ROLES if menu in (groups.get(f"{r} 기본") or [])]
            conn.execute(sa.text("INSERT INTO menu_access (menu, roles) VALUES (:menu, CAST(:roles AS jsonb))"),
                         {"menu": menu, "roles": json.dumps(roles)})
    op.drop_table('member_groups')
    op.drop_table('groups')
