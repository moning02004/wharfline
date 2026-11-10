"""Make an inventory and a server, then deploy to it, through the real API."""

from tests.conftest import builtin_job, log_text, wait_run


def _add_server(client, inv_id: str, **over) -> "object":
    body = {"name": "app-01", "ip": "10.9.0.11", "port": "22", "user": "deploy", "group": "app", "key": "prod-deploy"} | over
    return client.post(f"/api/inventory/{inv_id}/hosts", json=body)


def test_make_inventory_and_server(client, login):
    r = client.post("/api/inventory", json={"name": "itest", "key": "prod-deploy"})
    assert r.status_code == 200, r.text
    inv = r.json()

    fp = client.post("/api/inventory/fingerprint", json={"ip": "10.9.0.11", "port": 22}).json()
    assert fp["type"] == "ED25519" and fp["fingerprint"].startswith("SHA256:")

    assert _add_server(client, inv["id"], fingerprint=fp["fingerprint"]).status_code == 200
    assert _add_server(client, inv["id"], name="app-02", ip="10.9.0.12").status_code == 200
    assert _add_server(client, inv["id"], name="app-03", fingerprint="nope").status_code == 400
    hosts = next(i for i in client.get("/api/inventory").json() if i["name"] == "itest")["hosts"]
    assert [h["name"] for h in hosts] == ["app-01", "app-02"]
    # The host key seen by the connection check is pinned for deploys; none yet means the first deploy pins it.
    assert [h["fingerprint"] for h in hosts] == [fp["fingerprint"], None]


def test_server_input_is_checked(client, login):
    inv = next(i for i in client.get("/api/inventory").json() if i["name"] == "staging")
    assert _add_server(client, inv["id"], user="root").json()["detail"].startswith("root로는")
    assert _add_server(client, inv["id"], port="70000").status_code == 400
    assert _add_server(client, inv["id"], group="Web Servers").status_code == 400
    existing = inv["hosts"][0]["name"]
    assert "이미 있어요" in _add_server(client, inv["id"], name=existing).json()["detail"]
    assert client.post("/api/inventory", json={"name": "Bad Name", "key": "prod-deploy"}).status_code == 400


def test_deploy_to_the_new_servers(client, login):
    r = client.post("/api/jobs", json=builtin_job("itest · app", "itest", "postgres:15", envMode="paste", envVars=[["POSTGRES_PASSWORD", "x"]]))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["image"] == "docker.io/library/postgres" and job["defaultTag"] == "15"
    assert [h["name"] for h in job["targetHosts"]] == ["app-01", "app-02"]

    started = client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "16", "groups": []})
    assert started.status_code == 200, started.text
    run = wait_run(client, started.json()["no"])
    assert run["status"] == "ok"
    log = log_text(run)
    assert "-e image=docker.io/library/postgres -e image_tag=16" in log
    assert "-e env_file=/srv/wharfline/itest-app/.env" in log
    assert "배포 성공 · postgres:16 · 서버 2대" in log

    after = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert after["tagNow"] == "16" and after["last"]["status"] == "ok"
    assert "16" in [t["name"] for t in after["imageTags"]]  # a typed tag is remembered


def test_unreachable_servers_are_skipped(client, login):
    inv = next(i for i in client.get("/api/inventory").json() if i["name"] == "production")
    job = client.post("/api/jobs", json=builtin_job("itest · prod", "production", "nginx:1.27")).json()
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "latest", "groups": []}).json()["no"])
    assert run["status"] == "ok"
    skipped = [h["name"] for h in inv["hosts"] if h["hostKey"] != "ok" or h["status"] != "on"]
    assert skipped, "the sample production inventory has hosts that must be skipped"
    for name in skipped:
        assert f"skipping: [{name}]" in log_text(run)


def test_playbook_only_job_without_image(client, login):
    body = builtin_job("itest · playbook only", "itest", "") | {
        "playbook": {"source": "git", "url": "git@git.acme.kr:ops/ansible-playbooks.git", "branch": "main", "path": "ops/patch.yml", "key": ""}}
    job = client.post("/api/jobs", json=body).json()
    assert job["image"] is None and job["playbook"]["path"] == "ops/patch.yml"
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "latest", "groups": []}).json()["no"])
    log = log_text(run)
    assert run["status"] == "ok"
    assert "ansible-playbook ops/patch.yml" in log and "-e image=" not in log


def test_builtin_playbook_needs_an_image(client, login):
    r = client.post("/api/jobs", json=builtin_job("itest · no image", "itest", ""))
    assert r.status_code == 400
