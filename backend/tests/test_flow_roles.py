"""Role rules enforced by the server, and the approval flow for protected jobs (docs/security-hardening.md, B)."""

import pytest

from tests.conftest import DEPLOYER, OWNER, VIEWER, builtin_job, last_run_no, send_hook, wait_auto_run, wait_run

ADMIN = "admin-roles@acme.kr"
NO_PERM = "이 작업을 할 권한이 없어요."
HOOK_REPO = "acme/roles-hook"
HOOK_IMAGE = "ghcr.io/acme/roles-hook"


@pytest.fixture
def admin(client):
    """An Admin member (the seed has none)."""
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        if not db.get(m.Member, ADMIN):
            db.add(m.Member(email=ADMIN, name="관리자", role="Admin", tfa=False, last="방금"))
            db.commit()
    return ADMIN


def _job(client, name: str, **extra) -> dict:
    """A job on the staging inventory, made by the Owner once."""
    found = next((j for j in client.get("/api/jobs").json() if j["name"] == name), None)
    if found:
        return found
    r = client.post("/api/jobs", json=builtin_job(name, "staging", "nginx:1.27", **extra))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def open_job(client, login):
    return _job(client, "roles · open", protected=False)


@pytest.fixture
def prod_job(client, login):
    return _job(client, "roles · prod", protected=True)


def _run(client, job: dict, **headers):
    return client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "latest", "groups": []}, headers=headers)


def _forbidden(r) -> bool:
    return r.status_code == 403 and r.json()["detail"] == NO_PERM


def _edit_body(job: dict, **changes) -> dict:
    body = {"name": job["name"], "playbook": {"source": "builtin"}, "inventory": job["inventory"], "targets": job["targets"],
            "image": f"{job['image']}:{job['defaultTag']}", "envMode": "keep", "envVars": [], "hook": job["hook"],
            "protected": job["protected"], "lock": job["lock"], "rollback": job["rollback"], "editors": job["editors"]}
    return body | changes


# ---------- Viewer ----------

def test_viewer_sees_but_cannot_change_anything(client, login, open_job):
    login(VIEWER, sudo=True)  # even with a fresh password re-check
    assert client.get("/api/runs").status_code == 200
    assert client.get("/api/jobs").status_code == 200
    assert _forbidden(_run(client, open_job))
    assert _forbidden(client.post("/api/jobs", json=builtin_job("roles · viewer", "staging", "nginx:1.27")))
    assert _forbidden(client.post("/api/inventory", json={"name": "viewer-inv", "key": "prod-deploy"}))
    assert _forbidden(client.post("/api/keys", json={"mode": "gen", "name": "viewer-key"}))
    assert _forbidden(client.post("/api/registries", json={"host": "ghcr.io"}))
    assert _forbidden(client.post("/api/images", json={"image": "nginx:1.29"}))
    assert _forbidden(client.put("/api/images/source", json={"ref": "x", "sourceRepo": "a/b"}))
    assert _forbidden(client.post("/api/integrations/git/secret"))
    envs = client.get("/api/envs").json()
    assert _forbidden(client.get(f"/api/envs/{envs[0]['id']}/values"))
    assert _forbidden(client.post("/api/envs", json={"name": "viewer-env", "vars": [["A", "1"]]}))


# ---------- Deployer ----------

def test_deployer_runs_an_unprotected_job(client, login, open_job):
    login(DEPLOYER)
    r = _run(client, open_job)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "run"
    run = wait_run(client, r.json()["no"])
    assert run["status"] == "ok" and run["requestedBy"] == DEPLOYER


def test_deployer_on_a_protected_job_asks_for_approval(client, login, prod_job):
    from app import runner

    login(DEPLOYER)
    r = _run(client, prod_job)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approval"
    no = r.json()["no"]
    assert no not in runner.live  # nothing started

    run = client.get(f"/api/runs/{no}").json()
    assert run["status"] == "approval" and run["events"] == [] and not run["live"]
    assert run["requestedBy"] == DEPLOYER and run["requestedByName"] == "민지" and run["decidedBy"] is None
    assert any(x["no"] == no and x["status"] == "approval" for x in client.get("/api/runs").json())
    assert no in [x["no"] for x in client.get("/api/dashboard").json()["pendingApprovals"]]

    # A Deployer can't approve, not even their own request, nor by claiming to be the Owner.
    assert _forbidden(client.post(f"/api/runs/{no}/approve"))
    assert _forbidden(client.post(f"/api/runs/{no}/approve", headers={"X-View-As": OWNER}))
    assert _forbidden(client.post(f"/api/runs/{no}/reject"))

    login(OWNER)
    acts = client.get("/api/activity").json()["items"]
    assert any(a["action"] == "배포 승인 요청" and f"#{no}" in a["object"] for a in acts)


def test_deployer_cannot_manage_resources_or_env_values(client, login):
    login(DEPLOYER, sudo=True)
    assert _forbidden(client.post("/api/inventory", json={"name": "dep-inv", "key": "prod-deploy"}))
    inv = client.get("/api/inventory").json()[0]
    host = {"name": "x-01", "ip": "10.0.0.9", "port": "22", "user": "deploy", "group": "app"}
    assert _forbidden(client.post(f"/api/inventory/{inv['id']}/hosts", json=host))
    assert _forbidden(client.post(f"/api/inventory/{inv['id']}/ping"))
    assert _forbidden(client.delete("/api/keys/whatever"))
    # Pasting a .env into a new job writes secret values.
    assert _forbidden(client.post("/api/jobs", json=builtin_job("roles · dep env", "staging", "redis:7", envMode="paste", envVars=[["A", "1"]])))


def test_deployer_jobs_are_protected_without_auto_deploy(client, login):
    login(DEPLOYER)
    r = client.post("/api/jobs", json=builtin_job("roles · by deployer", "staging", "nginx:1.27", protected=False, hook=True))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["protected"] is True and job["hook"] is False and job["createdBy"] == DEPLOYER

    # They can edit their own job, but 운영 보호 and 자동 배포 keep their values.
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, protected=False, hook=True, lock=False))
    assert r.status_code == 200, r.text
    after = r.json()
    assert after["protected"] is True and after["hook"] is False and after["lock"] is False

    # And running it needs an approval.
    assert _run(client, job).json()["status"] == "approval"


def test_owner_still_changes_protection(client, login):
    job = _job(client, "roles · owner flips", protected=True)
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, protected=False, hook=True))
    assert r.status_code == 200 and r.json()["protected"] is False and r.json()["hook"] is True


# ---------- approve / reject ----------

def _last(client, job: dict) -> str:
    """The job's 최근 실행 status as the job list shows it."""
    return next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])["last"]["status"]


def test_owner_approves_and_the_run_starts(client, login, prod_job):
    login(DEPLOYER)
    no = _run(client, prod_job).json()["no"]
    assert _last(client, prod_job) == "approval"  # the list says 대기 while it waits

    login(OWNER)
    r = client.post(f"/api/runs/{no}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "run"
    assert _last(client, prod_job) in ("run", "ok")  # 진행중 from the start (a simulated run may already be done)
    run = wait_run(client, no)
    assert run["status"] == "ok"
    assert _last(client, prod_job) == "ok"
    assert run["requestedBy"] == DEPLOYER and run["decidedBy"] == OWNER and run["decidedAt"]
    assert any("승인: 정훈" in e.get("text", "") for e in run["events"])
    assert no not in [x["no"] for x in client.get("/api/dashboard").json()["pendingApprovals"]]
    assert client.post(f"/api/runs/{no}/approve").status_code == 400  # already decided


def test_admin_rejects(client, login, admin, prod_job):
    from app import runner

    login(DEPLOYER)
    no = _run(client, prod_job).json()["no"]

    login(ADMIN)
    r = client.post(f"/api/runs/{no}/reject")
    assert r.status_code == 200, r.text
    run = client.get(f"/api/runs/{no}").json()
    assert run["status"] == "rejected" and run["decidedBy"] == ADMIN and run["decidedByName"] == "관리자"
    assert _last(client, prod_job) == "rejected"
    assert no not in runner.live
    assert client.post(f"/api/runs/{no}/approve").status_code == 400  # a rejected run can't be started


def test_admin_runs_protected_jobs_and_approves(client, login, admin, prod_job):
    login(ADMIN)
    r = _run(client, prod_job)
    assert r.json()["status"] == "run"  # no approval needed
    assert wait_run(client, r.json()["no"])["status"] == "ok"

    login(DEPLOYER)
    no = _run(client, prod_job).json()["no"]
    login(ADMIN)
    assert client.post(f"/api/runs/{no}/approve").status_code == 200
    assert wait_run(client, no)["status"] == "ok"


def test_admin_cannot_change_security_policy(client, login, admin):
    login(OWNER)
    policy = client.get("/api/security").json()["policy"]
    login(ADMIN)
    assert _forbidden(client.put("/api/security/policy", json=policy))
    login(OWNER)
    assert client.put("/api/security/policy", json=policy).status_code == 200


def test_view_as_does_not_grant_or_take_away(client, login, open_job):
    # The Owner previewing as a Viewer still acts as the Owner.
    r = _run(client, open_job, **{"X-View-As": VIEWER})
    assert r.status_code == 200 and r.json()["status"] == "run"
    wait_run(client, r.json()["no"])
    # A Viewer naming the Owner gets nothing.
    login(VIEWER)
    assert _forbidden(_run(client, open_job, **{"X-View-As": OWNER}))
    assert _forbidden(client.post("/api/inventory", json={"name": "va-inv", "key": "prod-deploy"}, headers={"X-View-As": OWNER}))


# ---------- auto-deploy ----------

def test_auto_deploy_of_a_protected_job_waits_for_approval(client, login):
    from app import githooks, runner
    from app.db import SessionLocal

    with SessionLocal() as db:
        secret = githooks.new_secret(db)
        db.commit()
    inv = "staging"
    r = client.post("/api/jobs", json=builtin_job("roles · hook prod", inv, f"{HOOK_IMAGE}:v1.0.0", hook=True, protected=True))
    assert r.status_code == 200, r.text
    assert client.put("/api/images/source", json={"ref": HOOK_IMAGE, "sourceRepo": HOOK_REPO}).status_code == 200

    before = last_run_no(client)
    pkg = {"action": "created", "package": {"type": "container", "name": "roles-hook", "version": "v1.0.1", "owner": {"login": "acme"}}}
    out = send_hook(client, secret, "package", pkg).json()
    assert out["tags"] == [f"{HOOK_IMAGE}:v1.0.1"] and out["queued"] == ["roles · hook prod"]
    no = wait_auto_run(client, "roles · hook prod", before, status="approval")["no"]
    assert no not in runner.live
    run = client.get(f"/api/runs/{no}").json()
    assert run["status"] == "approval" and run["trigger"] == "새 이미지 push" and run["tag"] == "v1.0.1"
    assert run["requestedBy"] is None

    assert client.post(f"/api/runs/{no}/approve").status_code == 200
    run = wait_run(client, no)
    assert run["status"] == "ok" and run["tag"] == "v1.0.1"
