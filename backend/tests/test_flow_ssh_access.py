"""Limiting what a stolen key can do on the servers (docs/security-hardening.md, C)."""

import pytest

from tests.conftest import DEPLOYER, VIEWER

URL = "/api/keys/access-from"


@pytest.fixture
def no_addresses(client, login):
    """Each test starts with no address set, and leaves none behind."""
    client.put(URL, json={"addresses": []})
    yield
    login("jeonghoon@acme.kr")
    client.put(URL, json={"addresses": []})


def _ssh_key(client, name: str) -> dict:
    return next(k for k in client.get("/api/keys").json() if k["name"] == name)


def test_set_and_get_addresses(client, login, no_addresses):
    r = client.put(URL, json={"addresses": [" 203.0.113.10 ", "10.0.0.0/24", "203.0.113.10", "", "2001:db8::/32"]})
    assert r.status_code == 200, r.text
    assert r.json()["addresses"] == ["203.0.113.10", "10.0.0.0/24", "2001:db8::/32"]  # trimmed, deduplicated
    got = client.get(URL).json()
    assert got == {"addresses": ["203.0.113.10", "10.0.0.0/24", "2001:db8::/32"], "canEdit": True}
    acts = client.get("/api/activity").json()
    assert any(a["action"] == "접속 허용 주소 변경" for a in (acts if isinstance(acts, list) else acts.get("items", [])))


@pytest.mark.parametrize("bad", ["203.0.113.300", "example.com", "10.0.0.1/24", '1.2.3.4",command="sh', "10.0.0.0/33"])
def test_invalid_address_is_rejected(client, login, no_addresses, bad):
    client.put(URL, json={"addresses": ["198.51.100.7"]})
    r = client.put(URL, json={"addresses": ["203.0.113.10", bad]})
    assert r.status_code == 400
    assert "주소를 확인해 주세요" in r.json()["detail"]
    assert client.get(URL).json()["addresses"] == ["198.51.100.7"]  # nothing changed


@pytest.mark.parametrize("who", [DEPLOYER, VIEWER])
def test_only_owner_or_admin_can_change(client, login, no_addresses, who):
    login(who)
    got = client.get(URL)
    assert got.status_code == 200
    assert got.json()["canEdit"] is False
    r = client.put(URL, json={"addresses": ["203.0.113.10"]})
    assert r.status_code == 403
    assert r.json()["detail"] == "이 작업을 할 권한이 없어요."
    login("jeonghoon@acme.kr")
    assert client.get(URL).json()["addresses"] == []


def test_authorized_keys_line_without_addresses(client, login, no_addresses):
    k = _ssh_key(client, "prod-deploy")
    r = client.get(f"/api/keys/{k['id']}/public").json()
    assert r["restricted"] is False
    assert r["accessFrom"] == []
    assert r["authorizedKeysLine"] == r["publicKey"]


def test_authorized_keys_line_with_addresses(client, login, no_addresses):
    client.put(URL, json={"addresses": ["203.0.113.10", "10.0.0.0/24"]})
    k = _ssh_key(client, "prod-deploy")
    r = client.get(f"/api/keys/{k['id']}/public").json()
    assert r["restricted"] is True
    assert r["authorizedKeysLine"] == f'from="203.0.113.10,10.0.0.0/24",no-agent-forwarding,no-port-forwarding,no-X11-forwarding {r["publicKey"]}'
    kind, blob, comment = r["publicKey"].split(" ")
    assert kind == "ssh-ed25519" and blob.startswith("AAAA") and comment == "prod-deploy@wharfline"


def test_shared_key_is_flagged(client, login):
    login("jeonghoon@acme.kr", sudo=True)
    assert client.post("/api/keys", json={"mode": "gen", "name": "sshaccess-key"}).status_code == 200
    key = _ssh_key(client, "sshaccess-key")
    assert key["inventories"] == [] and key["sharedAcrossInventories"] is False
    token = _ssh_key(client, "github-readonly")
    assert token["inventories"] == [] and token["sharedAcrossInventories"] is False

    assert client.post("/api/inventory", json={"name": "sshaccess-prod", "key": "sshaccess-key"}).status_code == 200
    key = _ssh_key(client, "sshaccess-key")
    assert key["inventories"] == ["sshaccess-prod"] and key["sharedAcrossInventories"] is False

    assert client.post("/api/inventory", json={"name": "sshaccess-stg", "key": "sshaccess-key"}).status_code == 200
    key = _ssh_key(client, "sshaccess-key")
    assert key["inventories"] == ["sshaccess-prod", "sshaccess-stg"]
    assert key["sharedAcrossInventories"] is True
