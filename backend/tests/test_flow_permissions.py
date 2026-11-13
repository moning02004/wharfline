"""Who may edit a deploy job, through the real API (docs/deploy-edit.md)."""

from tests.conftest import DEPLOYER, OWNER, VIEWER, builtin_job


def _job(client, name: str) -> dict:
    return next(j for j in client.get("/api/jobs").json() if j["name"] == name)


def _edit_body(job: dict, **changes) -> dict:
    pb = job["playbook"]
    playbook = {"source": "builtin"} if pb["kind"] == "builtin" else {"source": "git", "url": pb["url"], "branch": pb["branch"], "path": pb["path"], "key": ""}
    image = f"{job['image']}:{job['defaultTag']}" if job["image"] else ""
    body = {"name": job["name"], "playbook": playbook, "inventory": job["inventory"], "targets": job["targets"], "image": image,
            "envMode": "keep", "envVars": [], "hook": job["hook"], "protected": job["protected"], "lock": job["lock"],
            "rollback": job["rollback"], "editors": job["editors"]}
    return body | changes


def test_owner_can_edit_any_job(client, login):
    job = _job(client, "api-server · production")
    assert job["canEdit"] is True
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, lock=not job["lock"]))
    assert r.status_code == 200, r.text
    assert r.json()["lock"] is (not job["lock"])


def test_viewer_cannot_edit(client, login):
    login(VIEWER)
    job = _job(client, "batch-worker · production")  # the Viewer's group 배치팀 is listed as its editor
    assert job["canEdit"] is False
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job))
    assert r.status_code == 403
    assert r.json()["detail"] == "이 작업을 할 권한이 없어요."  # Viewers may not edit any job


def test_deployer_edits_only_what_they_made_or_were_given(client, login):
    login(DEPLOYER)
    jobs = {j["name"]: j for j in client.get("/api/jobs").json()}
    mine = jobs["api-server · staging"]  # created by minji in the seed
    assert mine["canEdit"]
    assert "api-server · production" not in jobs  # not hers and not given to her: hidden
    login(OWNER)
    other = _job(client, "api-server · production")
    login(DEPLOYER)
    assert client.put(f"/api/jobs/{mine['id']}", json=_edit_body(mine)).status_code == 200
    assert client.put(f"/api/jobs/{other['id']}", json=_edit_body(other)).status_code == 404


def test_editor_group_grants_edit(client, login):
    # The Owner makes a job and lets the Deployer group edit it.
    groups = client.get("/api/groups").json()["groups"]
    deployer_group = next(g for g in groups if "minji@acme.kr" in g["members"])
    r = client.post("/api/jobs", json=builtin_job("perm · group", "staging", "nginx:1.27", editors={"groups": [deployer_group["id"]], "members": []}))
    assert r.status_code == 200, r.text
    assert r.json()["createdBy"] == OWNER

    login(DEPLOYER)
    job = _job(client, "perm · group")
    assert job["canEdit"] is True
    assert client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, image="nginx:1.28")).json()["defaultTag"] == "1.28"


def test_previewing_as_viewer_does_not_take_edit_away_from_owner(client, login):
    job = _job(client, "batch-worker · production")
    shown = next(j for j in client.get("/api/jobs", headers={"X-View-As": VIEWER}).json() if j["id"] == job["id"])
    assert shown["canEdit"] is False  # what the Viewer would see
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job), headers={"X-View-As": VIEWER})
    assert r.status_code == 200  # the change is still checked against the signed-in Owner


def test_unknown_editor_is_rejected(client, login):
    r = client.post("/api/jobs", json=builtin_job("perm · bad editor", "staging", "nginx:1.27", editors={"groups": [], "members": ["nobody@acme.kr"]}))
    assert r.status_code == 400
    assert "없는 멤버" in r.json()["detail"]


def test_pasting_env_over_an_existing_set_needs_password(client, login):
    r = client.post("/api/jobs", json=builtin_job("perm · env", "staging", "redis:7", envMode="paste", envVars=[["A", "1"]]))
    assert r.status_code == 200, r.text
    job = r.json()
    body = _edit_body(job, envMode="paste", envVars=[["A", "2"]])
    assert client.put(f"/api/jobs/{job['id']}", json=body).json()["detail"] == "sudo_required"
    login(OWNER, sudo=True)
    assert client.put(f"/api/jobs/{job['id']}", json=body).status_code == 200
