"""Bulk add from a "| 그룹 | 계정 |" table: Owner only, new accounts are Viewers on 0000 who must change it."""

import uuid

from app.routers.admin import parse_member_table
from tests.conftest import DEPLOYER, OWNER, set_session_cookie


def _table(*rows: tuple[str, str]) -> str:
    return "\n".join(["| 그룹 | 계정 |", "|---|---|", *(f"| {g} | {e} |" for g, e in rows)])


def test_parse_member_table():
    rows, errors = parse_member_table(_table(("ifdo", "Hong@Ermore.co.kr"), ("배치팀", "kim@ermore.co.kr")) + "\n\n그냥 줄\n| a |\n| x | not-an-email |")
    assert [(g, e) for _, g, e in rows] == [("ifdo", "hong@ermore.co.kr"), ("배치팀", "kim@ermore.co.kr")]
    assert [x["line"] for x in errors] == [6, 7, 8]


def test_preview_then_apply(client, login):
    tag = uuid.uuid4().hex[:6]
    a, b = f"imp-a-{tag}@ermore.co.kr", f"imp-b-{tag}@ermore.co.kr"
    group = f"팀-{tag}"
    text = _table((group, a), (group, b), ("Viewer 기본", a), (group, DEPLOYER))

    # Preview changes nothing and needs no password re-check.
    r = client.post("/api/members/import", json={"text": text})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["applied"] is False and p["errors"] == []
    assert p["newMembers"] == [a, b] and p["existingMembers"] == [DEPLOYER] and p["newGroups"] == [group] and p["joins"] == 4
    assert not any(x["email"] == a for x in client.get("/api/members").json())

    # Applying needs a recent password re-check.
    r = client.post("/api/members/import", json={"text": text, "apply": True})
    assert r.status_code == 403 and r.json()["detail"] == "sudo_required"
    login(OWNER, sudo=True)
    r = client.post("/api/members/import", json={"text": text, "apply": True})
    assert r.status_code == 200 and r.json()["applied"] is True, r.text

    members = {x["email"]: x for x in client.get("/api/members").json()}
    groups = {g["name"]: g for g in client.get("/api/groups").json()["groups"]}
    assert members[a]["role"] == "Viewer" and members[a]["mustChangePassword"] is True
    assert members[DEPLOYER]["role"] == "Deployer" and not members[DEPLOYER]["mustChangePassword"]  # existing accounts keep role and password
    assert set(groups[group]["members"]) == {a, b, DEPLOYER}
    assert groups[group]["menus"] == ["jobs", "runs", "security"]
    assert a in groups["Viewer 기본"]["members"]

    # Uploading the same table again adds nothing.
    again = client.post("/api/members/import", json={"text": text}).json()
    assert again["newMembers"] == [] and again["newGroups"] == [] and again["joins"] == 0

    # The new account signs in with 0000 and has to pick a new password first.
    set_session_cookie(client, None)
    body = client.post("/api/auth/login", json={"email": a, "password": "0000"}).json()
    assert body["loggedIn"] is False and body["step"] == "password"
    assert client.get("/api/members").status_code == 401


def test_errors_block_apply(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/members/import", json={"text": "| ifdo | 이메일아님 |", "apply": True})
    assert r.status_code == 400
    assert client.post("/api/members/import", json={"text": ""}).json()["errors"]


def test_owner_only(client, login):
    login(DEPLOYER, sudo=True)
    r = client.post("/api/members/import", json={"text": _table(("x", "x@ermore.co.kr"))})
    assert r.status_code == 403
