"""Editing servers and inventories, and moving servers between inventories, without breaking logins or jobs."""

from app import sshcheck
from tests.conftest import OWNER, builtin_job


def _inv(client, name):
    return next((i for i in client.get("/api/inventory").json() if i["name"] == name), None)


def _make(client, name, key="prod-deploy", user="deploy", hosts=()):
    inv = client.post("/api/inventory", json={"name": name, "key": key, "user": user}).json()
    for n, ip, grp in hosts:
        r = client.post(f"/api/inventory/{inv['id']}/hosts", json={"name": n, "ip": ip, "port": "22", "group": grp})
        assert r.status_code == 200, r.text
    return _inv(client, name)


def _refuse_logins(monkeypatch):
    async def fail(ip, port, user, private):
        return {"reachable": True, "type": "ED25519", "fingerprint": sshcheck.FAKE_FINGERPRINT, "login": False, "error": "로그인 실패"}
    monkeypatch.setattr(sshcheck, "check", fail)


def test_rename_server_and_change_group(client, login):
    login(OWNER, sudo=True)
    inv = _make(client, "edit-a", hosts=[("a-01", "10.8.1.1", "web"), ("a-02", "10.8.1.2", "web")])
    r = client.put(f"/api/inventory/{inv['id']}/hosts/0", json={"name": "front-1", "group": "edge"})
    assert r.status_code == 200, r.text
    h = _inv(client, "edit-a")["hosts"][0]
    assert (h["name"], h["group"], h["ip"], h["user"]) == ("front-1", "edge", "10.8.1.1", "deploy")
    # names stay unique in an inventory; groups follow the usual format
    assert client.put(f"/api/inventory/{inv['id']}/hosts/1", json={"name": "front-1", "group": "web"}).status_code == 400
    assert client.put(f"/api/inventory/{inv['id']}/hosts/1", json={"name": "a-02", "group": "Bad Group"}).status_code == 400


def test_last_server_of_a_targeted_group_keeps_its_group(client, login):
    login(OWNER, sudo=True)
    inv = _make(client, "edit-b", hosts=[("b-01", "10.8.2.1", "api")])
    job = builtin_job("edit-b · api", "edit-b", "postgres:15") | {"targets": ["api"]}
    assert client.post("/api/jobs", json=job).status_code == 200
    r = client.put(f"/api/inventory/{inv['id']}/hosts/0", json={"name": "b-01", "group": "other"})
    assert r.status_code == 400 and "edit-b · api" in r.json()["detail"]
    assert client.put(f"/api/inventory/{inv['id']}/hosts/0", json={"name": "b-renamed", "group": "api"}).status_code == 200


def test_rename_inventory_moves_its_jobs(client, login):
    login(OWNER, sudo=True)
    _make(client, "edit-c", hosts=[("c-01", "10.8.3.1", "app")])
    inv = _inv(client, "edit-c")
    assert client.post("/api/jobs", json=builtin_job("edit-c job", "edit-c", "postgres:15")).status_code == 200
    r = client.put(f"/api/inventory/{inv['id']}", json={"name": "edit-c2", "user": "deploy", "key": "prod-deploy"})
    assert r.status_code == 200, r.text
    job = next(j for j in client.get("/api/jobs").json() if j["name"] == "edit-c job")
    assert job["inventory"] == "edit-c2" and _inv(client, "edit-c") is None


def test_change_user_and_key_only_after_logins_work(client, login, monkeypatch):
    login(OWNER, sudo=True)
    inv = _make(client, "edit-d", hosts=[("d-01", "10.8.4.1", "app")])
    keys = {k["name"]: k["usedCount"] for k in client.get("/api/keys").json()}
    other = next(n for n, k in ((k["name"], k) for k in client.get("/api/keys").json()) if k["kind"] == "ssh" and n != "prod-deploy")

    with monkeypatch.context() as mp:
        _refuse_logins(mp)
        r = client.put(f"/api/inventory/{inv['id']}", json={"name": "edit-d", "user": "ops", "key": other})
        assert r.status_code == 400 and "d-01" in r.json()["detail"]
    assert _inv(client, "edit-d")["user"] == "deploy"  # nothing changed

    r = client.put(f"/api/inventory/{inv['id']}", json={"name": "edit-d", "user": "ops", "key": other})
    assert r.status_code == 200, r.text
    after = _inv(client, "edit-d")
    assert after["user"] == "ops" and after["key"] == other and after["hosts"][0]["user"] == "ops"
    now = {k["name"]: k["usedCount"] for k in client.get("/api/keys").json()}
    assert now["prod-deploy"] == keys["prod-deploy"] - 1 and now[other] == keys[other] + 1
    assert client.put(f"/api/inventory/{inv['id']}", json={"name": "edit-d", "user": "root", "key": other}).status_code == 400


def test_inventory_edit_needs_the_password_check(client, login):
    login(OWNER, sudo=True)
    inv = _make(client, "edit-e")
    login(OWNER)
    assert client.put(f"/api/inventory/{inv['id']}", json={"name": "edit-e2", "user": "deploy", "key": "prod-deploy"}).status_code in (401, 403)


def test_move_server_between_inventories(client, login, monkeypatch):
    login(OWNER, sudo=True)
    a = _make(client, "move-a", hosts=[("m-01", "10.8.5.1", "app"), ("m-02", "10.8.5.2", "app")])
    b = _make(client, "move-b", user="ops", hosts=[("x-01", "10.8.6.1", "app")])

    # another user there: the server must log in as that user first
    with monkeypatch.context() as mp:
        _refuse_logins(mp)
        r = client.post(f"/api/inventory/{a['id']}/hosts/0/move", json={"to": b["id"]})
        assert r.status_code == 400
    assert len(_inv(client, "move-a")["hosts"]) == 2

    r = client.post(f"/api/inventory/{a['id']}/hosts/0/move", json={"to": b["id"]})
    assert r.status_code == 200, r.text
    assert [h["name"] for h in _inv(client, "move-a")["hosts"]] == ["m-02"]
    moved = next(h for h in _inv(client, "move-b")["hosts"] if h["name"] == "m-01")
    assert moved["user"] == "ops" and moved["ip"] == "10.8.5.1"

    # same name there, or a job left without servers: refused
    client.post(f"/api/inventory/{a['id']}/hosts", json={"name": "x-01", "ip": "10.8.5.3", "port": "22", "group": "app"})
    assert client.post(f"/api/inventory/{a['id']}/hosts/1/move", json={"to": b["id"]}).status_code == 400
    assert client.post("/api/jobs", json=builtin_job("move-a job", "move-a", "postgres:15")).status_code == 200
    client.delete(f"/api/inventory/{a['id']}/hosts/1")
    r = client.post(f"/api/inventory/{a['id']}/hosts/0/move", json={"to": b["id"]})
    assert r.status_code == 400 and "move-a job" in r.json()["detail"]


def test_move_checklist(client, login, monkeypatch):
    login(OWNER, sudo=True)
    a = _make(client, "chk-a", hosts=[("k-01", "10.8.7.1", "app"), ("k-02", "10.8.7.2", "app")])
    b = _make(client, "chk-b", hosts=[("k-02", "10.8.8.2", "app")])
    r = client.post(f"/api/inventory/{a['id']}/hosts/0/move/check", json={"to": b["id"]})
    assert r.status_code == 200 and all(c["ok"] for c in r.json()["checks"])
    checks = {c["key"]: c for c in client.post(f"/api/inventory/{a['id']}/hosts/1/move/check", json={"to": b["id"]}).json()["checks"]}
    assert not checks["name"]["ok"] and checks["jobs"]["ok"] and checks["busy"]["ok"]
    assert client.post(f"/api/inventory/{a['id']}/hosts/0/move/login", json={"to": b["id"]}).json()["ok"]
    with monkeypatch.context() as mp:
        _refuse_logins(mp)
        out = client.post(f"/api/inventory/{a['id']}/hosts/0/move/login", json={"to": b["id"]}).json()
        assert not out["ok"] and "로그인 실패" in out["detail"]
        # same user and key, but the move still needs a working login
        assert client.post(f"/api/inventory/{a['id']}/hosts/0/move", json={"to": b["id"]}).status_code == 400
    assert client.post(f"/api/inventory/{a['id']}/hosts/0/move", json={"to": a["id"]}).status_code == 400
