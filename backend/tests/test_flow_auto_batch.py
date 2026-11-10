"""One release, one deploy: pushes close together go out as one run, and runs of a job never overlap."""

import time

from app import runner
from tests.conftest import builtin_job, last_run_no, send_hook, wait_run

STEPS = [{"name": "교체", "run": "cd \"$SERVICE_PATH\"\ndocker compose pull\ndocker compose up -d"}]
COMPOSE = (
    "services:\n"
    "  backend:\n    image: ghcr.io/acme/batch-backend:${BACKEND_TAG}\n"
    "  frontend:\n    image: ghcr.io/acme/batch-frontend:${FRONTEND_TAG}\n"
)
NAME = "batch · release"


def _secret():
    from app import githooks
    from app.db import SessionLocal

    with SessionLocal() as db:
        value = githooks.new_secret(db)
        db.commit()
    return value


def _job(client):
    existing = next((j for j in client.get("/api/jobs").json() if j["name"] == NAME), None)
    if existing:
        return existing
    body = builtin_job(NAME, "staging", "", hook=True) | {
        "playbook": {"source": "script"}, "script": STEPS, "files": [{"path": "docker-compose.yaml", "content": COMPOSE}]}
    r = client.post("/api/jobs", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _push(client, secret, name, tag):
    pkg = {"action": "created", "package": {"type": "container", "name": name, "version": tag, "owner": {"login": "acme"}}}
    return send_hook(client, secret, "package", pkg).json()


def _runs(client, after):
    return sorted((r for r in client.get("/api/runs").json() if r["job"] == NAME and r["no"] > after), key=lambda r: r["no"])


def _wait_runs(client, after, n, timeout=10):
    end = time.time() + timeout
    while time.time() < end:
        runs = _runs(client, after)
        if len(runs) >= n and all(r["status"] not in ("run",) for r in runs[:n]):
            return runs
        time.sleep(0.05)
    raise AssertionError(f"expected {n} runs, got {_runs(client, after)}")


def test_backend_and_frontend_of_one_release_deploy_in_one_run(client, login, monkeypatch):
    secret = _secret()
    _job(client)
    monkeypatch.setattr(runner, "AUTO_DELAY", 0.6)
    before = last_run_no(client)

    assert _push(client, secret, "batch-backend", "v2.0.0")["queued"] == [NAME]
    assert _push(client, secret, "batch-frontend", "v2.0.0")["queued"] == [NAME]

    runs = _wait_runs(client, before, 1)
    time.sleep(0.8)  # nothing else starts later
    runs = _runs(client, before)
    assert len(runs) == 1, runs
    run = wait_run(client, runs[0]["no"])
    assert run["status"] == "ok" and run["trigger"] == "새 이미지 push"
    assert run["extraTags"] == {"BACKEND": "v2.0.0", "FRONTEND": "v2.0.0"}


def test_a_push_during_a_run_deploys_after_it_on_top_of_it(client, login, monkeypatch):
    secret = _secret()
    job = _job(client)
    monkeypatch.setattr(runner, "PACE", 0.3)  # runs take a moment
    before = last_run_no(client)

    _push(client, secret, "batch-backend", "v2.1.0")
    end = time.time() + 5
    while not _runs(client, before) and time.time() < end:
        time.sleep(0.02)
    first = _runs(client, before)[0]
    assert first["status"] == "run"

    # a manual run is refused while it plays (동시 실행 잠금)
    r = client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "-", "groups": []})
    assert r.status_code == 409 and f"#{first['no']}" in r.json()["detail"]

    _push(client, secret, "batch-frontend", "v2.1.0")  # arrives mid-run: waits for it
    runs = _wait_runs(client, before, 2, timeout=20)
    a, b = wait_run(client, runs[0]["no"], timeout=20), wait_run(client, runs[1]["no"], timeout=20)
    assert a["extraTags"]["BACKEND"] == "v2.1.0"
    # the second run keeps the backend the first one deployed, and brings the new frontend
    assert b["extraTags"] == {"BACKEND": "v2.1.0", "FRONTEND": "v2.1.0"}
    assert b["no"] > a["no"]
