"""What a member sees: menus and build repos come from their groups; Owners see everything."""

from app import models as m
from app import store as s


def member(role: str, *groups: m.Group) -> m.Member:
    return m.Member(email=f"{role.lower()}@acme.kr", name=role, role=role, tfa=False, last="-", groups=list(groups))


def group(name: str, menus: list[str], all_builds: bool = False, repos: list[str] | None = None) -> m.Group:
    return m.Group(id=f"g-{name}", name=name, menus=menus, all_builds=all_builds, repos=repos or [])


def test_owner_sees_everything_without_groups():
    owner = member("Owner")
    assert s.visible_menus(owner) is None
    assert s.build_scope(owner) is None


def test_menus_are_the_union_of_groups_in_menu_order():
    u = member("Viewer", group("a", ["runs", "jobs"]), group("b", ["registries", "jobs"]))
    assert s.visible_menus(u) == ["jobs", "runs", "registries"]


def test_member_without_groups_sees_no_menus_and_no_builds():
    u = member("Deployer")
    assert s.visible_menus(u) == []
    assert s.build_scope(u) == set()
    assert not s.repo_allowed(s.build_scope(u), "acme/api")


def test_build_scope_is_the_union_of_group_repos():
    u = member("Viewer", group("a", [], repos=["acme/batch-worker"]), group("b", [], repos=["acme/web"]))
    scope = s.build_scope(u)
    assert scope == {"acme/batch-worker", "acme/web"}
    assert s.repo_allowed(scope, "ACME/Batch-Worker")
    assert not s.repo_allowed(scope, "acme/api")
    assert not s.repo_allowed(scope, None)


def test_any_group_with_all_builds_opens_every_repo():
    u = member("Viewer", group("a", [], repos=["acme/web"]), group("b", [], all_builds=True))
    assert s.build_scope(u) is None
    assert s.repo_allowed(None, "anything/else")


def test_signed_out_sees_nothing():
    assert s.visible_menus(None) == []
    assert s.build_scope(None) == set()
