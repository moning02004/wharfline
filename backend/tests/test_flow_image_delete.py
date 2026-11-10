"""Deleting registered images: password re-check, and images a job deploys or watches stay."""

from tests.conftest import OWNER, builtin_job


def _image(client, ref):
    return next((i for i in client.get("/api/registries").json()["images"] if i["ref"] == ref), None)


def test_delete_an_unused_image(client, login):
    login(OWNER, sudo=True)
    assert client.post("/api/images", json={"image": "ghcr.io/acme/del-me:v1"}).status_code == 200
    assert _image(client, "ghcr.io/acme/del-me")["usedBy"] == []
    assert client.delete("/api/images", params={"ref": "ghcr.io/acme/del-me"}).status_code == 200
    assert _image(client, "ghcr.io/acme/del-me") is None
    assert client.delete("/api/images", params={"ref": "ghcr.io/acme/del-me"}).status_code == 404


def test_an_image_a_job_uses_stays(client, login):
    login(OWNER, sudo=True)
    assert client.post("/api/jobs", json=builtin_job("delimg · app", "staging", "ghcr.io/acme/del-used:v1")).status_code == 200
    assert "delimg · app" in _image(client, "ghcr.io/acme/del-used")["usedBy"]
    r = client.delete("/api/images", params={"ref": "ghcr.io/acme/del-used"})
    assert r.status_code == 400 and "delimg · app" in r.json()["detail"]
    assert _image(client, "ghcr.io/acme/del-used") is not None


def test_image_delete_needs_the_password_check(client, login):
    login(OWNER, sudo=True)
    client.post("/api/images", json={"image": "ghcr.io/acme/del-sudo:v1"})
    login(OWNER)
    assert client.delete("/api/images", params={"ref": "ghcr.io/acme/del-sudo"}).status_code in (401, 403)
    assert _image(client, "ghcr.io/acme/del-sudo") is not None
