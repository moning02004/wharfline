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
