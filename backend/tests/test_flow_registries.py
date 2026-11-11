"""Registries: which one pulls an image (host, then namespace), editing the token, deleting."""

from tests.conftest import OWNER


def _data(client):
    return client.get("/api/registries").json()


def _reg(client, host, ns):
    return next((r for r in _data(client)["registries"] if r["host"] == host and r["namespace"] == ns), None)


def _image_registry(client, ref):
    return next(i["registry"] for i in _data(client)["images"] if i["ref"] == ref)


def test_each_image_is_pulled_by_the_registry_of_its_address(client, login):
    login(OWNER, sudo=True)
    for body in ({"host": "registry.gitlab.com", "namespace": "team-a", "user": "bot-a", "token": "glpat-aaaa"},
                 {"host": "registry.gitlab.com", "namespace": "team-b/sub", "user": "bot-b", "token": "glpat-bbbb"},
                 {"host": "ghcr.io", "namespace": "regtest", "user": "bot-c", "token": "ghp_cccc"}):
        assert client.post("/api/registries", json=body).status_code == 200
    for ref in ("registry.gitlab.com/team-a/api:v1", "registry.gitlab.com/team-b/sub/web:v1", "ghcr.io/regtest/worker:v1",
                "registry.gitlab.com/team-c/other:v1"):
        assert client.post("/api/images", json={"image": ref}).status_code == 200

    a, b = _reg(client, "registry.gitlab.com", "team-a"), _reg(client, "registry.gitlab.com", "team-b/sub")
    assert a["auth"] == "토큰 · read_registry"
    assert _image_registry(client, "registry.gitlab.com/team-a/api") == a["id"]
    assert _image_registry(client, "registry.gitlab.com/team-b/sub/web") == b["id"]
    assert _image_registry(client, "ghcr.io/regtest/worker") == _reg(client, "ghcr.io", "regtest")["id"]
    # no namespace matches: the first registry on the host
    assert _image_registry(client, "registry.gitlab.com/team-c/other") == a["id"]
    # the same host and namespace twice is refused
    assert client.post("/api/registries", json={"host": "registry.gitlab.com", "namespace": "team-a"}).status_code == 400


def test_edit_the_token_and_delete(client, login):
    login(OWNER, sudo=True)
    reg = client.post("/api/registries", json={"host": "git.regtest.kr", "namespace": "ops", "user": "deploy", "token": "old-token"}).json()
    client.post("/api/images", json={"image": "git.regtest.kr/ops/app:v1"})

    r = client.put(f"/api/registries/{reg['id']}", json={"host": "ignored", "namespace": "ops", "user": "deploy2", "token": ""})
    assert r.status_code == 200 and r.json()["user"] == "deploy2" and r.json()["hasSecret"]  # empty token keeps the saved one
    assert client.put(f"/api/registries/{reg['id']}", json={"host": "", "namespace": "ops", "user": "deploy2", "token": "new-token"}).status_code == 200

    from app import models as m
    from app.db import SessionLocal
    with SessionLocal() as db:
        assert db.get(m.Registry, reg["id"]).get_secret() == "new-token"

    assert client.delete(f"/api/registries/{reg['id']}").status_code == 200
    assert _reg(client, "git.regtest.kr", "ops") is None
    assert _image_registry(client, "git.regtest.kr/ops/app") is None  # the image stays, now pulled without a login
    assert client.delete(f"/api/registries/{reg['id']}").status_code == 404


def test_registry_changes_need_the_password_check(client, login):
    login(OWNER, sudo=True)
    reg = client.post("/api/registries", json={"host": "git.regsudo.kr", "namespace": "ops"}).json()
    login(OWNER)
    assert client.put(f"/api/registries/{reg['id']}", json={"host": "", "namespace": "ops"}).status_code in (401, 403)
    assert client.delete(f"/api/registries/{reg['id']}").status_code in (401, 403)
