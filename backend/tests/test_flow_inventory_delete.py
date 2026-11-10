"""Deleting servers and inventories: password re-check, and inventories that jobs use stay."""

from tests.conftest import OWNER, builtin_job


def _inv(client, name):
    return next((i for i in client.get("/api/inventory").json() if i["name"] == name), None)


def _key_uses(client, name):
    return next(k for k in client.get("/api/keys").json() if k["name"] == name)["usedCount"]


def test_delete_server_and_inventory(client, login):
    login(OWNER, sudo=True)
    before = _key_uses(client, "prod-deploy")
    inv = client.post("/api/inventory", json={"name": "deltest", "key": "prod-deploy"}).json()
    assert _key_uses(client, "prod-deploy") == before + 1
    for n, ip in (("d-01", "10.9.1.1"), ("d-02", "10.9.1.2")):
        assert client.post(f"/api/inventory/{inv['id']}/hosts", json={"name": n, "ip": ip, "port": "22", "user": "deploy", "group": "app"}).status_code == 200

    assert client.delete(f"/api/inventory/{inv['id']}/hosts/0").status_code == 200
    assert [h["name"] for h in _inv(client, "deltest")["hosts"]] == ["d-02"]
    assert client.delete(f"/api/inventory/{inv['id']}/hosts/5").status_code == 404

    assert client.delete(f"/api/inventory/{inv['id']}").status_code == 200
    assert _inv(client, "deltest") is None
    assert _key_uses(client, "prod-deploy") == before


def test_inventory_used_by_a_job_stays(client, login):
    login(OWNER, sudo=True)
    inv = client.post("/api/inventory", json={"name": "deluse", "key": "prod-deploy"}).json()
    client.post(f"/api/inventory/{inv['id']}/hosts", json={"name": "u-01", "ip": "10.9.2.1", "port": "22", "user": "deploy", "group": "app"})
    assert client.post("/api/jobs", json=builtin_job("deluse · app", "deluse", "postgres:15")).status_code == 200
    r = client.delete(f"/api/inventory/{inv['id']}")
    assert r.status_code == 400 and "deluse · app" in r.json()["detail"]
    assert _inv(client, "deluse") is not None


def test_delete_needs_the_password_check(client, login):
    login(OWNER, sudo=True)
    inv = client.post("/api/inventory", json={"name": "delsudo", "key": "prod-deploy"}).json()
    login(OWNER)  # no recent password check
    assert client.delete(f"/api/inventory/{inv['id']}").status_code in (401, 403)
    assert _inv(client, "delsudo") is not None


def test_inventory_with_its_user_and_first_server(client, login):
    body = {"name": "withhost", "key": "prod-deploy", "user": "ops",
            "host": {"name": "w-01", "ip": "10.9.3.1", "port": "22", "group": "app", "fingerprint": "SHA256:pX0c7Lq2vRz9Hn4Wb1Ke8YsT3mJ6fDaUgQ5iEoN"}}
    r = client.post("/api/inventory", json=body)
    assert r.status_code == 200, r.text
    inv = r.json()
    assert inv["user"] == "ops" and [h["name"] for h in inv["hosts"]] == ["w-01"]
    assert inv["hosts"][0]["user"] == "ops" and inv["hosts"][0]["fingerprint"].startswith("SHA256:")
    # a server added later deploys as the inventory's user
    assert client.post(f"/api/inventory/{inv['id']}/hosts", json={"name": "w-02", "ip": "10.9.3.2", "port": "22", "group": "app"}).json()["user"] == "ops"
    assert client.post("/api/inventory", json=body | {"name": "withroot", "user": "root"}).status_code == 400
    assert client.post("/api/inventory", json=body | {"name": "badhost", "host": body["host"] | {"ip": "bad host!"}}).status_code == 400
    assert _inv(client, "badhost") is None  # nothing half-made


def test_connection_test_checks_every_server(client, login):
    inv = _inv(client, "withhost")
    r = client.post(f"/api/inventory/{inv['id']}/ping")
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["total"] == 2 and out["ok"] == 2 and {h["name"] for h in out["hosts"]} == {"w-01", "w-02"}
    hosts = {h["name"]: h for h in _inv(client, "withhost")["hosts"]}
    assert hosts["w-02"]["fingerprint"]  # first contact pins the host key
