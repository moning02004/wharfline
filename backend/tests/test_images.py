"""Image name parsing and playbook path rules used when a job is created."""

import pytest
from fastapi import HTTPException

from app import store as s


@pytest.mark.parametrize("text, expected", [
    ("postgres:15", ("docker.io/library/postgres", "15")),
    ("bitnami/redis", ("docker.io/bitnami/redis", "latest")),
    ("ghcr.io/acme/api:v1.2", ("ghcr.io/acme/api", "v1.2")),
    ("localhost:5000/app:dev", ("localhost:5000/app", "dev")),
    ("localhost:5000/app", ("localhost:5000/app", "latest")),
    ("postgres", ("docker.io/library/postgres", "latest")),
    ("postgres:latest", ("docker.io/library/postgres", "latest")),
    ("  https://GHCR.io/Acme/API:V1.2  ", ("ghcr.io/acme/api", "V1.2")),
    ("docker.io/postgres:16", ("docker.io/library/postgres", "16")),
    ("git.acme.kr/acme/batch-worker:v0.9.4", ("git.acme.kr/acme/batch-worker", "v0.9.4")),
])
def test_parse_image(text, expected):
    assert s.parse_image(text) == expected


@pytest.mark.parametrize("text", [
    "postgres@sha256:" + "a" * 64,
    "ghcr.io/acme/api:v1@sha256:abc",
    "",
    "   ",
    "ghcr.io/acme/api:bad tag",
    "ghcr.io/acme/api:-dash",
    "ghcr.io",
    "bad name!/x",
])
def test_parse_image_rejects(text):
    with pytest.raises(HTTPException) as e:
        s.parse_image(text)
    assert e.value.status_code == 400


@pytest.mark.parametrize("path", ["deploy/app.yml", "site.yaml", "a/b/c-d_e.v2.yml", "container.yml"])
def test_playbook_path_ok(path):
    assert s.PLAYBOOK_PATH_RE.match(path)


@pytest.mark.parametrize("path", ["/etc/app.yml", "../app.yml", "deploy/../x.yml", "deploy/app.json", "app.yml.txt",
                                  "deploy app.yml", "", ".yml/", "deploy/app.YML"])
def test_playbook_path_rejected(path):
    assert not s.PLAYBOOK_PATH_RE.match(path)


def test_app_slug():
    assert s.app_slug("api-server · production") == "api-server-production"
    assert s.app_slug("API Server") == "api-server"
    assert s.app_slug("배포") == "app"


def test_extra_vars():
    from app import runner

    job = {"name": "api-server · production", "image": "ghcr.io/acme/api-server"}
    assert runner.extra_vars(job, "v1.8.2", True) == {
        "image": "ghcr.io/acme/api-server", "image_tag": "v1.8.2", "image_ref": "ghcr.io/acme/api-server:v1.8.2",
        "env_file": "/srv/wharfline/api-server-production/.env", "app_name": "api-server-production",
    }
    assert runner.extra_vars({**job, "image": None}, "-", False) == {"app_name": "api-server-production"}
