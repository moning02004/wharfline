"""Playbook variables (plain and secret) and password login for Git playbook jobs, through the real API."""

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
            "playVars": job["playVars"], "secretVars": None, "loginKey": job["loginKey"] or "", "becomeKey": job["becomeKey"] or ""}
    return body | changes


def _secret_vars(job_id: str):
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        row = db.get(m.JobSecretVars, job_id)
        return row.get_vars() if row else None


def _key(client, name: str) -> dict:
    return next(k for k in client.get("/api/keys").json() if k["name"] == name)


def _password_key(client, login, name: str, user: str = "ops") -> dict:
    login(OWNER, sudo=True)
    r = client.post("/api/keys", json={"mode": "password", "name": name, "user": user, "password": "pw with spaces 1!"})
    assert r.status_code == 200, r.text
    return r.json()


# ---------- key store ----------

def test_add_a_password_key(client, login):
    k = _password_key(client, login, "pv-login", user="deploy")
    assert k["kind"] == "password" and k["type"] == "비밀번호" and k["fingerprint"] == "deploy · 비밀번호" and k["hasSecret"] is True
    assert "pw with spaces" not in str(client.get("/api/keys").json())

    from app import models as m
    from app.db import SessionLocal
    with SessionLocal() as db:
        assert db.get(m.Key, k["id"]).get_secret() == "pw with spaces 1!"  # stored as typed, encrypted
        assert db.scalar(select(m.Activity).where(m.Activity.action == "로그인 비밀번호 추가", m.Activity.object == "pv-login"))

    bad = [{"user": "Bad User", "password": "x"}, {"user": "root", "password": "x"},{"user": "deploy", "password": ""}, {"user": "deploy", "password": "x" * 1025}]
    for i, b in enumerate(bad):
        r = client.post("/api/keys", json={"mode": "password", "name": f"pv-bad-{i}", **b})
        assert r.status_code == 400, b
    login(OWNER)  # adding keys needs the password check
    assert client.post("/api/keys", json={"mode": "password", "name": "pv-nosudo", "user": "deploy", "password": "x"}).status_code in (401, 403)


# ---------- create, edit, keep, replace ----------

def test_create_edit_keep_and_replace(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/jobs", json=_git_job("pv · app", playVars=[["app_port", "8080"], ["ansible_pubkey", "x"]],
                                               secretVars=[["db_password", SECRET]]))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["playVars"] == [["app_port", "8080"], ["ansible_pubkey", "x"]]
    assert job["secretVarNames"] == ["db_password"] and job["loginKey"] is None and job["becomeKey"] is None
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
    key = _password_key(client, login, "pv-only-git")["name"]
    for i, extra in enumerate([{"playVars": [["a", "1"]]}, {"secretVars": [["a", "1"]]}, {"loginKey": key, "protected": True},
                               {"becomeKey": key}, {"copySecretVarsFrom": "j1"}]):
        for kind, make in (("script", _script_job), ("builtin", lambda n, **e: builtin_job(n, "staging", "nginx:1.27", **e))):
            r = client.post("/api/jobs", json=make(f"pv · not git {i} {kind}", **extra))
            assert r.status_code == 400, (extra, r.text)
            assert "Git 플레이북 작업에서만" in r.json()["detail"]
    # nothing set: such jobs store no playbook variables
    job = client.post("/api/jobs", json=_script_job("pv · script ok", secretVars=None, playVars=[])).json()
    assert job["playVars"] == [] and job["secretVarNames"] == [] and job["loginKey"] is None

    # turning a Git job into a built-in one drops its variables and login
    g = client.post("/api/jobs", json=_git_job("pv · to builtin", playVars=[["a", "1"]], secretVars=[["s", "2"]],
                                               loginKey=key, protected=True)).json()
    assert _key(client, key)["usedCount"] == 1
    body = _edit_body(g, playbook={"source": "builtin"}, image="nginx:1.27", playVars=[], loginKey="", becomeKey="")
    r = client.put(f"/api/jobs/{g['id']}", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["playVars"] == [] and r.json()["secretVarNames"] == [] and r.json()["loginKey"] is None
    assert _secret_vars(g["id"]) is None and _key(client, key)["usedCount"] == 0


# ---------- permissions ----------

def test_deployer_cannot_write_secrets_or_login(client, login):
    key = _password_key(client, login, "pv-deployer")["name"]
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=_git_job("pv · shared", secretVars=[["s", SECRET]], loginKey=key, protected=True,
                                                 editors={"groups": [], "members": [DEPLOYER]})).json()

    login(DEPLOYER, sudo=True)
    # plain variables are fine for a Deployer
    r = client.post("/api/jobs", json=_git_job("pv · deployer plain", playVars=[["a", "1"]]))
    assert r.status_code == 200, r.text
    assert client.post("/api/jobs", json=_git_job("pv · deployer secret", secretVars=[["s", "1"]])).status_code == 403
    assert client.post("/api/jobs", json=_git_job("pv · deployer login", loginKey=key)).status_code == 403
    assert client.post("/api/jobs", json=_git_job("pv · deployer copy", copySecretVarsFrom=job["id"])).status_code == 403

    # editing: the saved secrets and login stay as they are; changing them is refused
    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, playVars=[["b", "2"]]))
    assert r.status_code == 200, r.text
    assert r.json()["loginKey"] == key and r.json()["secretVarNames"] == ["s"]
    assert client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, secretVars=[["s", "x"]])).status_code == 403
    assert client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, loginKey="")).status_code == 403
    assert client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, becomeKey=key)).status_code == 403
    assert _secret_vars(job["id"]) == [["s", SECRET]]


def test_login_key_rules_and_use_count(client, login):
    key = _password_key(client, login, "pv-login-rules", user="ops")["name"]
    login(OWNER, sudo=True)
    # needs 운영 보호
    r = client.post("/api/jobs", json=_git_job("pv · unprotected", loginKey=key, protected=False))
    assert r.status_code == 400 and "운영 보호" in r.json()["detail"]
    # only password keys
    assert client.post("/api/jobs", json=_git_job("pv · ssh as login", loginKey="prod-deploy", protected=True)).status_code == 400
    assert client.post("/api/jobs", json=_git_job("pv · no such key", becomeKey="pv-nope")).status_code == 400
    # becomeKey alone does not need 운영 보호
    r = client.post("/api/jobs", json=_git_job("pv · become only", becomeKey=key, protected=False))
    assert r.status_code == 200 and r.json()["becomeKey"] == key

    r = client.post("/api/jobs", json=_git_job("pv · login", loginKey=key, becomeKey=key, protected=True))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["loginKey"] == key and job["becomeKey"] == key
    assert _key(client, key)["usedCount"] == 3

    # turning 운영 보호 off while logging in with a password is refused
    assert client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, protected=False)).status_code == 400
    # a key in use can't be deleted
    r = client.delete(f"/api/keys/{_key(client, key)['id']}")
    assert r.status_code == 400 and "배포 작업" in r.json()["detail"]

    r = client.put(f"/api/jobs/{job['id']}", json=_edit_body(job, becomeKey=""))
    assert r.status_code == 200 and r.json()["becomeKey"] is None
    assert _key(client, key)["usedCount"] == 2
    from app import models as m
    from app.db import SessionLocal
    with SessionLocal() as db:
        acts = [a.object for a in db.scalars(select(m.Activity).where(m.Activity.action == "배포 작업 수정"))]
    assert any(o.startswith("pv · login") and "접속 방식" in o for o in acts)

    assert client.delete(f"/api/jobs/{job['id']}").status_code == 200
    become_only = next(j for j in client.get("/api/jobs").json() if j["name"] == "pv · become only")
    assert client.delete(f"/api/jobs/{become_only['id']}").status_code == 200
    assert _key(client, key)["usedCount"] == 0
    assert client.delete(f"/api/keys/{_key(client, key)['id']}").status_code == 200


# ---------- copy ----------

def test_copy_takes_the_secret_values_on_the_server(client, login):
    key = _password_key(client, login, "pv-copy")["name"]
    login(OWNER, sudo=True)
    src = client.post("/api/jobs", json=_git_job("pv · copy src", playVars=[["a", "1"]], secretVars=[["s", SECRET]],
                                                 loginKey=key, protected=True)).json()
    body = _git_job("pv · copy", playVars=src["playVars"], copySecretVarsFrom=src["id"], loginKey=key, protected=True)
    r = client.post("/api/jobs", json=body)
    assert r.status_code == 200, r.text
    copy = r.json()
    assert copy["secretVarNames"] == ["s"] and copy["playVars"] == [["a", "1"]] and SECRET not in r.text
    assert _secret_vars(copy["id"]) == [["s", SECRET]]
    assert _key(client, key)["usedCount"] == 2

    # secretVars sent with it win
    r = client.post("/api/jobs", json=_git_job("pv · copy own", copySecretVarsFrom=src["id"], secretVars=[["t", "mine"]]))
    assert r.status_code == 200 and r.json()["secretVarNames"] == ["t"]
    assert _secret_vars(r.json()["id"]) == [["t", "mine"]]

    assert client.post("/api/jobs", json=_git_job("pv · copy missing", copySecretVarsFrom="j-nope")).status_code == 400
    # deleting the copy leaves the source's secrets alone
    assert client.delete(f"/api/jobs/{copy['id']}").status_code == 200
    assert _secret_vars(copy["id"]) is None and _secret_vars(src["id"]) == [["s", SECRET]]
