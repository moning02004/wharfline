"""Who may edit a deploy job: Owner/Admin always, Viewer never, others when they made it or are listed as editors."""

import pytest

from app import models as m
from app import store as s


def group(gid: str) -> m.Group:
    return m.Group(id=gid, name=gid, menus=[], all_builds=False, repos=[])


def member(role: str, email: str | None = None, *groups: m.Group) -> m.Member:
    return m.Member(email=email or f"{role.lower()}@acme.kr", name=role, role=role, tfa=False, last="-", groups=list(groups))


def job(created_by: str | None = None, groups: list[str] | None = None, members: list[str] | None = None) -> m.Job:
    return m.Job(id="j1", name="api", created_by=created_by, editors={"groups": groups or [], "members": members or []})


@pytest.mark.parametrize("role", ["Owner", "Admin"])
def test_owner_and_admin_can_always_edit(role):
    assert s.can_edit(member(role), job(created_by="someone@acme.kr"))


def test_viewer_can_never_edit_even_when_listed():
    g = group("g-batch")
    v = member("Viewer", "v@acme.kr", g)
    assert not s.can_edit(v, job(created_by="v@acme.kr", groups=["g-batch"], members=["v@acme.kr"]))


def test_signed_out_cannot_edit():
    assert not s.can_edit(None, job())


def test_deployer_who_made_the_job_can_edit():
    assert s.can_edit(member("Deployer", "d@acme.kr"), job(created_by="d@acme.kr"))


def test_deployer_listed_as_member_can_edit():
    assert s.can_edit(member("Deployer", "d@acme.kr"), job(created_by="o@acme.kr", members=["x@acme.kr", "d@acme.kr"]))


def test_deployer_in_an_editor_group_can_edit():
    d = member("Deployer", "d@acme.kr", group("g-a"), group("g-b"))
    assert s.can_edit(d, job(created_by="o@acme.kr", groups=["g-b"]))


def test_deployer_not_listed_cannot_edit():
    d = member("Deployer", "d@acme.kr", group("g-a"))
    assert not s.can_edit(d, job(created_by="o@acme.kr", groups=["g-b"], members=["x@acme.kr"]))


def test_job_without_creator_or_editors():
    assert not s.can_edit(member("Deployer"), m.Job(id="j1", name="api", created_by=None, editors=None))


def test_job_dict_includes_editors_and_creator():
    d = job(created_by="o@acme.kr", groups=["g-a"]).to_dict()
    assert d["editors"] == {"groups": ["g-a"], "members": []}
    assert d["createdBy"] == "o@acme.kr"
