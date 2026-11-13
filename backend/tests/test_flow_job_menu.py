"""Job menu actions: copy a job with its own copy of the .env, and turn auto-deploy on or off."""

from tests.conftest import DEPLOYER, OWNER, builtin_job


def _job(client, job_id):
    return next(j for j in client.get("/api/jobs").json() if j["id"] == job_id)


def test_copy_makes_a_new_env_set_with_the_same_values(client, login):
    login(OWNER, sudo=True)
    src = client.post("/api/jobs", json=builtin_job("menu · src", "staging", "postgres:15", envMode="paste", envVars=[["POSTGRES_PASSWORD", "pw-1"]])).json()
    body = builtin_job("menu · copy", "staging", "postgres:15") | {"envMode": "copy", "envName": src["env"]}
    r = client.post("/api/jobs", json=body)
    assert r.status_code == 200, r.text
    copy = r.json()
    assert copy["env"] and copy["env"] != src["env"]

    from app import models as m
    from app.db import SessionLocal
    from sqlalchemy import select
    with SessionLocal() as db:
        got = db.scalar(select(m.EnvSet).where(m.EnvSet.name == copy["env"])).get_vars()
    assert got == [["POSTGRES_PASSWORD", "pw-1"]]

    bad = builtin_job("menu · copy2", "staging", "postgres:15") | {"envMode": "copy", "envName": "no-such-set"}
    assert client.post("/api/jobs", json=bad).status_code == 400


def test_toggle_auto_deploy(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=builtin_job("menu · hook", "staging", "nginx:1.27")).json()
    assert client.put(f"/api/jobs/{job['id']}/hook", json={"on": True}).json()["hook"] is True
    assert _job(client, job["id"])["hook"] is True
    assert client.put(f"/api/jobs/{job['id']}/hook", json={"on": False}).json()["hook"] is False

    noimg = builtin_job("menu · noimg", "staging", "") | {
        "playbook": {"source": "git", "url": "git@git.acme.kr:ops/ansible-playbooks.git", "branch": "main", "path": "ops/patch.yml", "key": ""}}
    j2 = client.post("/api/jobs", json=noimg).json()
    assert client.put(f"/api/jobs/{j2['id']}/hook", json={"on": True}).status_code == 400

    login(DEPLOYER)
    assert client.put(f"/api/jobs/{job['id']}/hook", json={"on": True}).status_code == 404  # not shared with her: hidden
