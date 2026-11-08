"""Image builds reported by Git webhooks: 빌드 중 → 완료, new tags, auto-deploy (docs/deploy-simplify.md)."""

import pytest

from tests.conftest import builtin_job, send_hook, wait_run

REPO = "acme/hook-demo"
IMAGE = "ghcr.io/acme/hook-demo"


@pytest.fixture
def secret(client):
    from app import githooks
    from app.db import SessionLocal

    with SessionLocal() as db:
        value = githooks.new_secret(db)
        db.commit()
    return value


@pytest.fixture
def hook_job(client, login):
    """A job on ghcr.io/acme/hook-demo with auto-deploy on, built from acme/hook-demo."""
    existing = next((j for j in client.get("/api/jobs").json() if j["name"] == "hook · demo"), None)
    if existing:
        return existing
    inv = client.get("/api/inventory").json()[0]["name"]
    job = client.post("/api/jobs", json=builtin_job("hook · demo", inv, f"{IMAGE}:v1.0.0", hook=True))
    assert job.status_code == 200, job.text
    assert client.put("/api/images/source", json={"ref": IMAGE, "sourceRepo": REPO}).status_code == 200
    return job.json()


def _build(client, job_id: str):
    return next(j for j in client.get("/api/jobs").json() if j["id"] == job_id)["build"]


def run_payload(run_id: int, status: str, conclusion: str | None = None) -> dict:
    run = {"id": run_id, "run_number": 7, "name": "image", "display_title": "release", "head_branch": "main", "head_sha": "abc1234def",
           "status": status, "html_url": f"https://git.example/{REPO}/actions/runs/7"}
    if conclusion:
        run["conclusion"] = conclusion
    return {"repository": {"full_name": REPO}, "workflow_run": run}


def test_gitea_build_progress_then_success_and_auto_deploy(client, login, secret, hook_job):
    assert send_hook(client, secret, "workflow_run", run_payload(5001, "queued")).status_code == 200
    b = _build(client, hook_job["id"])
    assert b["active"] and b["status"] == "queued" and b["runNumber"] == 7

    job_event = {"repository": {"full_name": REPO}, "workflow_job": {"run_id": 5001, "name": "build", "status": "in_progress",
                                                                     "steps": [{"name": "Build and push", "status": "in_progress"}]}}
    send_hook(client, secret, "workflow_job", job_event)
    b = _build(client, hook_job["id"])
    assert b["status"] == "in_progress" and b["step"] == "Build and push"  # 빌드 중

    pkg = {"action": "created", "package": {"type": "container", "name": "hook-demo", "version": "v1.0.1", "owner": {"login": "acme"}}}
    r = send_hook(client, secret, "package", pkg).json()
    assert r["tags"] == [f"{IMAGE}:v1.0.1"]
    assert len(r["runs"]) == 1  # auto-deploy started for the job with 자동 배포 on

    send_hook(client, secret, "workflow_run", run_payload(5001, "completed", "success"))
    b = _build(client, hook_job["id"])
    assert b["status"] == "success" and not b["active"] and b["tag"] == "v1.0.1"  # 빌드 성공 → v1.0.1

    run = wait_run(client, r["runs"][0])
    assert run["status"] == "ok" and run["tag"] == "v1.0.1" and run["trigger"] == "새 이미지 push"


def test_failed_build(client, login, secret, hook_job):
    send_hook(client, secret, "workflow_run", run_payload(5002, "in_progress"))
    assert _build(client, hook_job["id"])["status"] == "in_progress"
    send_hook(client, secret, "workflow_run", run_payload(5002, "completed", "failure"))
    b = _build(client, hook_job["id"])
    assert b["status"] == "failure" and not b["active"]


def test_github_registry_package_records_tag(client, login, secret, hook_job):
    pkg = {"name": "hook-demo", "package_type": "CONTAINER", "owner": {"login": "acme"},
           "package_version": {"version": "sha256:aa", "container_metadata": {"tag": {"name": "v1.1.0"}}}}
    r = send_hook(client, secret, "registry_package", {"action": "published", "registry_package": pkg}, provider="github").json()
    assert r["provider"] == "github" and r["tags"] == [f"{IMAGE}:v1.1.0"]


def test_gitlab_pipeline_success_on_tag(client, login, secret, hook_job):
    project = {"path_with_namespace": REPO, "web_url": f"https://gitlab.example/{REPO}", "default_branch": "main"}

    def pipeline(status: str) -> dict:
        return {"object_kind": "pipeline", "project": project, "commit": {"title": "release"},
                "object_attributes": {"id": 9001, "iid": 3, "ref": "v1.2.0", "tag": True, "sha": "fedcba9876", "status": status}}

    send_hook(client, secret, "Pipeline Hook", pipeline("running"), provider="gitlab")
    assert _build(client, hook_job["id"])["status"] == "in_progress"
    r = send_hook(client, secret, "Pipeline Hook", pipeline("success"), provider="gitlab").json()
    assert r["tags"] == [f"{IMAGE}:v1.2.0"]
    b = _build(client, hook_job["id"])
    assert b["provider"] == "gitlab" and b["status"] == "success" and b["tag"] == "v1.2.0"


def test_latest_is_not_recorded(client, login, secret, hook_job):
    pkg = {"action": "created", "package": {"type": "container", "name": "hook-demo", "version": "latest", "owner": {"login": "acme"}}}
    assert "tags" not in send_hook(client, secret, "package", pkg).json()


def test_bad_signatures_are_rejected(client, login, secret):
    payload = run_payload(5003, "queued")
    assert send_hook(client, "wrong-secret", "workflow_run", payload).status_code == 401
    assert send_hook(client, "wrong-secret", "Pipeline Hook", {}, provider="gitlab").status_code == 401
    assert client.post("/api/hooks/git", json=payload).status_code == 400  # no Git host headers


def test_hook_rule_decides_which_tags_deploy(client, login, secret):
    from app.githooks import tag_matches

    assert tag_matches("v", "v2026.11.08-1") and tag_matches("v", "v1.2.0") and not tag_matches("v", "2026.11.08-1")
    assert tag_matches("date", "2026.11.08-1") and tag_matches("date", "v2026.11.08-2") and not tag_matches("date", "v1.2.0")
    assert tag_matches("any", "sha-77d1e0b")
    assert tag_matches("re:release-\\d+", "release-12") and not tag_matches("re:release-\\d+", "release-12a")

    inv = client.get("/api/inventory").json()[0]["name"]
    img = "ghcr.io/acme/rule-demo"
    v_job = client.post("/api/jobs", json=builtin_job("rule · v", inv, f"{img}:v1", hook=True)).json()
    d_job = client.post("/api/jobs", json=builtin_job("rule · date", inv, f"{img}:v1", hook=True, hookRule="date")).json()
    assert v_job["hookRule"] == "v" and d_job["hookRule"] == "date"
    assert client.post("/api/jobs", json=builtin_job("rule · bad", inv, f"{img}:v1", hook=True, hookRule="re:(")).status_code == 400

    def push(tag: str) -> set[str]:
        pkg = {"action": "created", "package": {"type": "container", "name": "rule-demo", "version": tag, "owner": {"login": "acme"}}}
        runs = send_hook(client, secret, "package", pkg).json().get("runs", [])
        return {client.get(f"/api/runs/{no}").json()["job"] for no in runs}

    assert push("v2026.11.08-1") == {"rule · v", "rule · date"}
    assert push("2026.11.09-1") == {"rule · date"}
    assert push("v2.0.0") == {"rule · v"}
    assert push("sha-abc1234") == set()
