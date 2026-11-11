"""Playbook variables (plain and secret) for Git playbook jobs, through the real API."""

from sqlalchemy import select

from tests.conftest import DEPLOYER, OWNER, builtin_job

SECRET = "pv-s3cr3t-value"


def _git_job(name: str, **extra) -> dict:
    return builtin_job(name, "staging", "") | {
        "playbook": {"source": "git", "url": "https://git.acme.kr/ops/pvars.git", "branch": "main", "path": "site.yml", "key": ""}} | extra


def _script_job(name: str, **extra) -> dict:
    return builtin_job(name, "staging", "") | {"playbook": {"source": "script"}, "script": [{"name": "hello", "run": "echo hi"}]} | extra


def _job(client, job_id: str) -> dict:
    return next(j for j in client.get("/api/jobs").json() if j["id"] == job_id)


def _edit_body(job: dict, **changes) -> dict:
    pb = job["playbook"]
    body = {"name": job["name"], "playbook": {"source": "git", "url": pb["url"], "branch": pb["branch"], "path": pb["path"], "key": ""},
            "inventory": job["inventory"], "targets": job["targets"], "image": "", "envMode": "keep", "envVars": [],
            "hook": job["hook"], "protected": job["protected"], "lock": job["lock"], "rollback": job["rollback"], "editors": job["editors"],
            "playVars": job["playVars"], "secretVars": None}
    return body | changes


def _secret_vars(job_id: str):
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        row = db.get(m.JobSecretVars, job_id)
        return row.get_vars() if row else None


def test_create_edit_keep_and_replace(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/jobs", json=_git_job("pv · app", playVars=[["app_port", "8080"], ["ansible_pubkey", "x"]],
                                               secretVars=[["db_password", SECRET]]))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["playVars"] == [["app_port", "8080"], ["ansible_pubkey", "x"]]
    assert job["secretVarNames"] == ["db_password"]
    assert SECRET not in r.text and SECRET not in client.get("/api/jobs").text
    assert _secret_vars(job["id"]) == [["db_password", SECRET]]

    # secretVars null keeps the saved values (no password check needed)
    login(OWNER)
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, playVars=[["app_port", "9090"]]))
    assert r.status_code == 200, r.text
    assert r.json()["playVars"] == [["app_port", "9090"]] and r.json()["secretVarNames"] == ["db_password"]
    assert _secret_vars(job["id"]) == [["db_password", SECRET]]

    # replacing saved secret values needs a recent password check
    body = _edit_body(job, secretVars=[["db_password", "new-value"], ["api_token", "t-1"]])
    assert client.put(f"/api/jobs/{job['id']}", json=body).json()["detail"] == "sudo_required"
    login(OWNER, sudo=True)
    r = client.put(f"/api/jobs/{job['id']}", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["secretVarNames"] == ["db_password", "api_token"] and "new-value" not in r.text
    assert _secret_vars(job["id"]) == [["db_password", "new-value"], ["api_token", "t-1"]]

    from app import models as m
    from app.db import SessionLocal
    with SessionLocal() as db:
        acts = [a.object for a in db.scalars(select(m.Activity).where(m.Activity.action == "배포 작업 수정"))]
    assert any(o.startswith("pv · app") and "플레이북 변수" in o for o in acts)
    assert not any("new-value" in o or SECRET in o for o in acts)

    # an empty list removes them all
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, secretVars=[]))
    assert r.status_code == 200 and r.json()["secretVarNames"] == []
    assert _secret_vars(job["id"]) is None


def test_bad_and_reserved_names(client, login):
    login(OWNER, sudo=True)
    extra = {"extraImages": [{"image": "ghcr.io/acme/pv-worker:v1", "var": "WORKER"}]}
    bad = [
        {"playVars": [["1abc", "x"]]},
        {"playVars": [["a-b", "x"]]},
        {"playVars": [["x" * 65, "x"]]},
        {"playVars": [["ok", "v" * 4097]]},
        {"playVars": [["dup", "1"]], "secretVars": [["dup", "2"]]},
        {"playVars": [[f"v{i}", "x"] for i in range(30)], "secretVars": [[f"s{i}", "x"] for i in range(21)]},
        {"playVars": [["only-one"]]},
    ]
    reserved = ["image", "image_tag", "env_file", "app_name", "registry_password", "env_src", "ansible_host", "ansible_user",
                "ansible_password", "ansible_ssh_private_key_file", "ansible_become_pass", "ansible_sudo_pass", "ansible_connection",
                "ansible_python_interpreter", "hostvars", "inventory_hostname", "omit", "worker_image", "worker_tag", "worker_image_ref"]
    for i, b in enumerate(bad):
        r = client.post("/api/jobs", json=_git_job(f"pv · bad {i}", **extra, **b))
        assert r.status_code == 400, (b, r.text)
    for name in reserved:
        r = client.post("/api/jobs", json=_git_job(f"pv · reserved {name}", **extra, secretVars=[[name, "x"]]))
        assert r.status_code == 400, name
        assert "Wharfline이나 Ansible" in r.json()["detail"]
    # 50 in all is fine; ansible_* names that are not connection settings are fine
    r = client.post("/api/jobs", json=_git_job("pv · fifty", **extra, playVars=[[f"v{i}", "x"] for i in range(49)] + [["ansible_pubkey", "k"]]))
    assert r.status_code == 200, r.text


def test_only_git_playbook_jobs(client, login):
    login(OWNER, sudo=True)
    for i, extra in enumerate([{"playVars": [["a", "1"]]}, {"secretVars": [["a", "1"]]}, {"copySecretVarsFrom": "j1"}]):
        for kind, make in (("script", _script_job), ("builtin", lambda n, **e: builtin_job(n, "staging", "nginx:1.27", **e))):
            r = client.post("/api/jobs", json=make(f"pv · not git {i} {kind}", **extra))
            assert r.status_code == 400, (extra, r.text)
            assert "Git 플레이북 작업에서만" in r.json()["detail"]
    # nothing set: such jobs store no playbook variables
    job = client.post("/api/jobs", json=_script_job("pv · script ok", secretVars=None, playVars=[])).json()
    assert job["playVars"] == [] and job["secretVarNames"] == []

    # turning a Git job into a built-in one drops its variables
    g = client.post("/api/jobs", json=_git_job("pv · to builtin", playVars=[["a", "1"]], secretVars=[["s", "2"]])).json()
    body = _edit_body(g, playbook={"source": "builtin"}, image="nginx:1.27", playVars=[])
    r = client.put(f"/api/jobs/{g['id']}", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["playVars"] == [] and r.json()["secretVarNames"] == []
    assert _secret_vars(g["id"]) is None


# ---------- permissions ----------

def test_deployer_cannot_write_secrets(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=_git_job("pv · shared", secretVars=[["s", SECRET]], protected=True,
                                                 editors={"groups": [], "members": [DEPLOYER]})).json()

    login(DEPLOYER, sudo=True)
    # plain variables are fine for a Deployer
    r = client.post("/api/jobs", json=_git_job("pv · deployer plain", playVars=[["a", "1"]]))
    assert r.status_code == 200, r.text
    assert client.post("/api/jobs", json=_git_job("pv · deployer secret", secretVars=[["s", "1"]])).status_code == 403
    assert client.post("/api/jobs", json=_git_job("pv · deployer copy", copySecretVarsFrom=job["id"])).status_code == 403

    # editing: the saved secrets stay as they are; changing them is refused
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, playVars=[["b", "2"]]))
    assert r.status_code == 200, r.text
    assert r.json()["secretVarNames"] == ["s"]
    assert client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, secretVars=[["s", "x"]])).status_code == 403
    assert _secret_vars(job["id"]) == [["s", SECRET]]


# ---------- copy ----------

def test_copy_takes_the_secret_values_on_the_server(client, login):
    login(OWNER, sudo=True)
    src = client.post("/api/jobs", json=_git_job("pv · copy src", playVars=[["a", "1"]], secretVars=[["s", SECRET]])).json()
    body = _git_job("pv · copy", playVars=src["playVars"], copySecretVarsFrom=src["id"])
    r = client.post("/api/jobs", json=body)
    assert r.status_code == 200, r.text
    copy = r.json()
    assert copy["secretVarNames"] == ["s"] and copy["playVars"] == [["a", "1"]] and SECRET not in r.text
    assert _secret_vars(copy["id"]) == [["s", SECRET]]

    # secretVars sent with it win
    r = client.post("/api/jobs", json=_git_job("pv · copy own", copySecretVarsFrom=src["id"], secretVars=[["t", "mine"]]))
    assert r.status_code == 200 and r.json()["secretVarNames"] == ["t"]
    assert _secret_vars(r.json()["id"]) == [["t", "mine"]]

    assert client.post("/api/jobs", json=_git_job("pv · copy missing", copySecretVarsFrom="j-nope")).status_code == 400
    # deleting the copy leaves the source's secrets alone
    assert client.delete(f"/api/jobs/{copy['id']}").status_code == 200
    assert _secret_vars(copy["id"]) is None and _secret_vars(src["id"]) == [["s", SECRET]]
