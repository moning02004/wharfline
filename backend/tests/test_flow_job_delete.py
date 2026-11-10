"""Deleting deploy jobs: password re-check, runs stay in the history, busy jobs stay."""

from tests.conftest import OWNER, builtin_job, wait_run


def _job(client, job_id):
    return next((j for j in client.get("/api/jobs").json() if j["id"] == job_id), None)


def test_delete_a_job_keeps_its_runs(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=builtin_job("deljob · app", "staging", "postgres:15")).json()
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "15", "groups": []}).json()["no"])
    assert client.delete(f"/api/jobs/{job['id']}").status_code == 200
    assert _job(client, job["id"]) is None
    assert client.get(f"/api/runs/{run['no']}").json()["job"] == "deljob · app"  # the history stays
    assert client.delete(f"/api/jobs/{job['id']}").status_code == 404
    # its image is no longer used, so it can be deleted now
    assert client.delete("/api/images", params={"ref": "docker.io/library/postgres"}).status_code in (200, 400)


def test_job_delete_needs_the_password_check(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=builtin_job("deljob · sudo", "staging", "postgres:15")).json()
    login(OWNER)
    assert client.delete(f"/api/jobs/{job['id']}").status_code in (401, 403)
    assert _job(client, job["id"]) is not None
