"""Uploaded playbooks: parse an upload, save the job with its files and variables, run it, edit it."""

import base64
import io
import zipfile

from tests.conftest import DEPLOYER, OWNER, builtin_job, log_text, wait_run

BOOK = """\
#   변수       domain    예) team.example.com
#   비밀 변수  admin_password
- name: 설치
  hosts: all
  become: true
  tasks:
    - ansible.builtin.copy:
        src: "{{ playbook_dir }}/nginx/"
        dest: /srv/nginx/
    - ansible.builtin.debug:
        msg: "{{ domain }} {{ admin_password }} {{ install_dir | default('/srv', true) }}"
"""
KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n"
SECRET = "up-s3cr3t-pw"


def _zip(files: dict[str, str]) -> str:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for path, text in files.items():
            z.writestr(path, text)
    return base64.b64encode(buf.getvalue()).decode()


def _files():
    return [{"path": "stack.yml", "content": BOOK}, {"path": "nginx/compose.yaml", "content": "services: {}\n"}]


def _job(name: str, **extra) -> dict:
    return builtin_job(name, "staging", "") | {"playbook": {"source": "upload", "path": "stack.yml"}, "files": _files()} | extra


def test_parse_drops_keys_and_env_and_finds_playbooks(client, login):
    login(OWNER)
    data = _zip({"infra/stack.yml": BOOK, "infra/nginx/compose.yaml": "services: {}\n", "infra/ansible-key": KEY,
                 "infra/nginx/.env": "A=1\n", "infra/.git/config": "x"})
    r = client.post("/api/playbooks/parse", json={"name": "infra.zip", "data": data})
    assert r.status_code == 200, r.text
    res = r.json()
    assert [f["path"] for f in res["files"]] == ["nginx/compose.yaml", "stack.yml"]
    reasons = {d["path"]: d["reason"] for d in res["dropped"]}
    assert "개인키" in reasons["ansible-key"] and ".env" in reasons["nginx/.env"]
    assert res["playbooks"] == ["stack.yml"] and "env" not in res

    # a folder picked in the browser: same result
    enc = lambda t: base64.b64encode(t.encode()).decode()  # noqa: E731
    r = client.post("/api/playbooks/parse", json={"entries": [
        {"path": "infra/stack.yml", "content": enc(BOOK)}, {"path": "infra/ansible-key", "content": enc(KEY)}]})
    assert r.status_code == 200, r.text
    assert [f["path"] for f in r.json()["files"]] == ["stack.yml"] and r.json()["playbooks"] == ["stack.yml"]

    r = client.post("/api/playbooks/inspect", json={"files": _files(), "book": "stack.yml"})
    assert r.status_code == 200, r.text
    v = {x["name"]: x for x in r.json()["vars"]}
    assert v["domain"]["required"] and v["admin_password"]["secret"] and v["install_dir"]["default"] == "/srv"
    assert r.json()["warnings"] == []


def test_create_run_and_edit(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/jobs", json=_job("up · stack", playVars=[["domain", "team.example.com"]],
                                            secretVars=[["admin_password", SECRET]]))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["playbook"]["kind"] == "upload" and job["playbook"]["path"] == "stack.yml"
    assert [f["path"] for f in job["files"]] == ["nginx/compose.yaml", "stack.yml"] and job["filesVer"] == 1
    assert job["secretVarNames"] == ["admin_password"] and SECRET not in r.text
    assert [f["path"] for f in client.get(f"/api/jobs/{job['id']}/files").json()] == ["nginx/compose.yaml", "stack.yml"]

    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "latest", "groups": []}).json()["no"])
    assert run["status"] == "ok", run
    text = log_text(run)
    assert "올린 파일 2개" in text and SECRET not in text

    # files None keeps the uploaded files; a new value for a plain variable is saved
    body = _job(job["name"], files=None, envMode="keep", playVars=[["domain", "b.example.com"]], secretVars=None)
    r = client.put(f"/api/jobs/{job['id']}", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["playVars"] == [["domain", "b.example.com"]] and r.json()["filesVer"] == 1
    assert r.json()["secretVarNames"] == ["admin_password"]

    # a new upload makes a new file version
    r = client.put(f"/api/jobs/{job['id']}", json=body | {"files": _files() + [{"path": "README.md", "content": "hi"}]})
    assert r.status_code == 200, r.text
    assert r.json()["filesVer"] == 2


def test_save_checks_the_upload(client, login):
    login(OWNER)
    r = client.post("/api/jobs", json=_job("up · nobook", playbook={"source": "upload", "path": "missing.yml"}))
    assert r.status_code == 400 and "missing.yml" in r.json()["detail"]
    r = client.post("/api/jobs", json=_job("up · key", files=_files() + [{"path": "id_ed25519", "content": KEY}]))
    assert r.status_code == 400 and "개인키" in r.json()["detail"]
    r = client.post("/api/jobs", json=_job("up · none", files=None))
    assert r.status_code == 400
    # a Wharfline name can't be a variable here either
    r = client.post("/api/jobs", json=_job("up · reserved", playVars=[["image", "x"]]))
    assert r.status_code == 400


def test_deployer_cannot_write_secret_values(client, login):
    login(DEPLOYER)
    r = client.post("/api/jobs", json=_job("up · deployer", secretVars=[["admin_password", "x"]]))
    assert r.status_code == 403
    r = client.post("/api/jobs", json=_job("up · deployer", playVars=[["domain", "a.example.com"]]))
    assert r.status_code == 200, r.text


def _saved_secrets(job_id: str):
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        row = db.get(m.JobSecretVars, job_id)
        return row.get_vars() if row else None


def test_keep_saved_secrets_while_changing_one(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=_job("up · keep", playVars=[["domain", "a.example.com"]],
                                              secretVars=[["admin_password", SECRET], ["api_token", "t-1"]])).json()
    body = _job(job["name"], files=None, envMode="keep", playVars=[["domain", "a.example.com"]])
    # change api_token only; admin_password keeps its saved value without the form knowing it
    r = client.put(f"/api/jobs/{job['id']}", json=body | {"secretVars": [["api_token", "t-2"]], "keepSecretVars": ["admin_password"]})
    assert r.status_code == 200, r.text
    assert sorted(_saved_secrets(job["id"])) == [["admin_password", SECRET], ["api_token", "t-2"]]
    # keep everything, type nothing: no change
    r = client.put(f"/api/jobs/{job['id']}", json=body | {"secretVars": [], "keepSecretVars": ["admin_password", "api_token"]})
    assert r.status_code == 200 and sorted(r.json()["secretVarNames"]) == ["admin_password", "api_token"]
    # 복제 keeps the source's value for the names kept, new values for the rest
    r = client.post("/api/jobs", json=_job("up · keep copy", copySecretVarsFrom=job["id"], keepSecretVars=["admin_password"],
                                            secretVars=[["api_token", "t-3"]]))
    assert r.status_code == 200, r.text
    assert sorted(_saved_secrets(r.json()["id"])) == [["admin_password", SECRET], ["api_token", "t-3"]]
