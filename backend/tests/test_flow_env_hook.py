"""POST /api/hooks/env: a project's .env, accepted when the sender's Gitea login may push to the repo."""

import pytest

from app import envhook
from tests.conftest import OWNER

GOOD = "Basic good"
READONLY = "Basic readonly"


@pytest.fixture
def gitea(monkeypatch):
    """A fake Gitea: `good` may push to ermore-org/ergo-hook, `readonly` may only read it."""
    calls: list[tuple[str, str, str]] = []

    def fake_get(base, path, auth):
        calls.append((base, path, auth))
        users = {GOOD: "hong", READONLY: "kim"}
        if auth not in users:
            return 401, None
        if path == "user":
            return 200, {"login": users[auth]}
        if path == "repos/ermore-org/ergo-hook":
            return 200, {"permissions": {"admin": False, "push": auth == GOOD, "pull": True}}
        return 404, None

    monkeypatch.setenv("WHARFLINE_GITEA_URL", "http://gitea:3000/")
    monkeypatch.setattr(envhook, "gitea_get", fake_get)
    return calls


def _send(client, auth: str | None, env: str, repo: str = "ermore-org/ergo-hook"):
    headers = {"Authorization": auth} if auth else {}
    # Called from a terminal with no session (each test clears the cookie first).
    return client.post("/api/hooks/env", json={"repo": repo, "env": env}, headers=headers)


def _env(client, login, name: str) -> dict | None:
    login(OWNER, sudo=True)
    found = next((e for e in client.get("/api/envs").json() if e["name"] == name), None)
    if found:
        found["values"] = dict(map(tuple, client.get(f"/api/envs/{found['id']}/values?purpose=edit").json()["vars"]))
    return found


def test_upload_creates_then_versions(client, login, gitea):
    from tests.conftest import set_session_cookie

    set_session_cookie(client, None)
    r = _send(client, GOOD, "# comment\nPGPASSWORD=one\nAPI_KEY=\nexport MODE='prod'\nPGPASSWORD=two\n")
    assert r.status_code == 200, r.text
    assert r.json() | {"added": sorted(r.json()["added"])} == {"ok": True, "name": "ergo-hook-env", "ver": 1, "status": "created",
                                                                "added": ["API_KEY", "MODE", "PGPASSWORD"], "changed": [], "removed": []}
    assert gitea[0] == ("http://gitea:3000", "user", GOOD)  # only to the configured Gitea, with the caller's header

    e = _env(client, login, "ergo-hook-env")
    assert e["ver"] == 1 and e["values"] == {"PGPASSWORD": "two", "API_KEY": "", "MODE": "prod"}

    set_session_cookie(client, None)
    assert _send(client, GOOD, "PGPASSWORD=two\nAPI_KEY=\nMODE=prod\n").json()["status"] == "unchanged"
    r = _send(client, GOOD, "PGPASSWORD=three\nMODE=prod\nNEW=1\n").json()
    assert (r["status"], r["ver"], r["added"], r["changed"], r["removed"]) == ("updated", 2, ["NEW"], ["PGPASSWORD"], ["API_KEY"])

    e = _env(client, login, "ergo-hook-env")
    assert e["ver"] == 2 and e["values"] == {"PGPASSWORD": "three", "MODE": "prod", "NEW": "1"}
    acts = [a for a in client.get("/api/activity").json()["items"] if a["action"] == "환경 변수 업로드"]
    assert acts[0]["user"] == "hong (Gitea)" and "three" not in acts[0]["object"]  # names only, never values


def test_rejects(client, gitea, monkeypatch):
    from tests.conftest import set_session_cookie

    set_session_cookie(client, None)
    assert _send(client, None, "A=1").status_code == 401
    assert _send(client, "Basic wrong", "A=1").status_code == 401
    assert _send(client, READONLY, "A=1").status_code == 403
    assert _send(client, GOOD, "A=1", repo="ermore-org/other").status_code == 404
    assert _send(client, GOOD, "A=1", repo="../etc").status_code == 400
    assert _send(client, GOOD, "# nothing").status_code == 400
    monkeypatch.delenv("WHARFLINE_GITEA_URL")
    assert _send(client, GOOD, "A=1").status_code == 503
