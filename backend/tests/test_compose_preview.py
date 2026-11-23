"""Compose files: the names docker compose finds, and the containers a file would start (the job form's preview)."""

import pytest
from fastapi import HTTPException

from app import bundles
from app.routers import deploy

COMPOSE = """
services:
  app:
    image: ghcr.io/acme/app:${IMAGE_TAG}
    ports: ["8080:80"]
    depends_on: [db]
  worker:
    image: ghcr.io/acme/worker:${IMAGE_TAG}
    deploy:
      replicas: 3
  db:
    image: postgres:16
    container_name: shop-db
    ports:
      - published: 5432
        target: 5432
  migrate:
    build: .
    profiles: [tools]
"""


def test_preview_lists_each_service_and_its_containers():
    r = bundles.compose_preview(COMPOSE, "Shop.API")
    assert r["ok"] and r["project"] == "shopapi"
    by = {x["name"]: x for x in r["services"]}
    assert by["app"]["containers"] == ["shopapi-app-1"] and by["app"]["ports"] == ["8080:80"] and by["app"]["dependsOn"] == ["db"]
    assert by["worker"]["containers"] == ["shopapi-worker-1", "shopapi-worker-2", "shopapi-worker-3"] and by["worker"]["replicas"] == 3
    assert by["db"]["containers"] == ["shop-db"] and by["db"]["ports"] == ["5432:5432"]
    assert by["migrate"]["build"] and by["migrate"]["profiles"] == ["tools"] and by["migrate"]["image"] == ""


def test_a_top_level_name_is_the_project():
    r = bundles.compose_preview("name: billing\nservices:\n  api:\n    image: x\n", "folder")
    assert r["project"] == "billing" and r["services"][0]["containers"] == ["billing-api-1"]


@pytest.mark.parametrize("text,needle", [("services: [\n", "YAML"), ("version: '3'\n", "services"), ("", "services")])
def test_preview_explains_what_is_wrong(text, needle):
    r = bundles.compose_preview(text, "x")
    assert not r["ok"] and needle in r["error"]


@pytest.mark.parametrize("name,ok", [("docker-compose.yml", True), ("docker-compose.yaml", True), ("compose.yml", True),
                                     ("deploy/compose.yaml", True), ("stack.yml", False), ("compose.json", False)])
def test_compose_names(name, ok):
    assert bundles.is_compose_name(name) is ok
    assert deploy.compose_path_ok(name) is ok


def test_a_compose_job_keeps_the_file_name():
    assert deploy.compose_files([{"path": "compose.yaml", "content": "services: {}"}])[0]["path"] == "compose.yaml"
    assert deploy.compose_files([{"path": "stack.yml", "content": "services: {}"}])[0]["path"] == "docker-compose.yml"
    with pytest.raises(HTTPException):
        deploy.compose_files([{"path": "compose.yaml", "content": "  "}])


ROLLOUT = """
services:
  app:
    image: ghcr.io/acme/app:${IMAGE_TAG}
    expose: ["8000"]
  api:
    build: .
    ports: ["8000"]
  web:
    image: nginx:1.27
    ports: ["8080:80"]
  db:
    image: postgres:16
  cache:
    image: redis:7
  pinned:
    image: ghcr.io/acme/pinned:1
    container_name: pinned
  tools:
    image: ghcr.io/acme/tools:1
    profiles: [tools]
  forced:
    image: postgres:16
    labels:
      wharfline.rollout: "true"
  manual:
    image: ghcr.io/acme/manual:1
    labels: ["wharfline.rollout=false"]
"""


def test_which_services_docker_rollout_replaces():
    r = bundles.compose_preview(ROLLOUT, "shop")
    assert r["rollout"] == ["app", "api", "forced"]
    why = {x["name"]: x["rolloutWhy"] for x in r["services"]}
    assert "호스트 포트" in why["web"] and "데이터" in why["db"] and "데이터" in why["cache"]
    assert "container_name" in why["pinned"] and "프로필" in why["tools"] and "라벨" in why["manual"]
    assert why["app"] is None and why["forced"] is None


def test_rollout_services_reads_the_top_level_compose_file():
    files = [{"path": "sub/compose.yaml", "content": "services: {x: {image: a}}"},
             {"path": "docker-compose.yml", "content": ROLLOUT}]
    assert bundles.rollout_services(files) == ["app", "api", "forced"]
    assert bundles.rollout_services([{"path": "compose.yaml", "content": "services: ["}]) == []
    assert bundles.rollout_services([{"path": "Makefile", "content": "x"}]) == []


def test_rollout_services_read_the_override_file_too():
    from app import bundles
    files = [{"path": "compose.yaml", "content": "services:\n  web:\n    image: x\n  api:\n    image: y\n"},
             {"path": "compose.override.yaml", "content": "services:\n  web:\n    ports: ['80:80']\n"}]
    assert bundles.rollout_services(files) == ["api"]
