"""Jobs a member has no access to are hidden: left out of every list, and 404 when asked for by id or URL.

Owner/Admin see every job; anyone else only jobs they made or are listed on as an editor (directly or by group).
"""

import uuid

from tests.conftest import DEPLOYER, OWNER, VIEWER, builtin_job, wait_run


def _ids(client, path="/api/jobs"):
    return {j["id"] for j in client.get(path).json()}


def test_hidden_job_is_hidden_everywhere(client, login):
    login(OWNER, sudo=True)
    name = f"vis · {uuid.uuid4().hex[:6]}"
    job = client.post("/api/jobs", json=builtin_job(name, "staging", "postgres:15")).json()
    jid = job["id"]
    run = wait_run(client, client.post(f"/api/jobs/{jid}/runs", json={"tag": "15", "groups": []}).json()["no"])
    no = run["no"]
    assert jid in _ids(client)

    for who in (DEPLOYER, VIEWER):
        login(who, sudo=True)
        assert jid not in _ids(client)
        dash = client.get("/api/dashboard").json()
        assert jid not in {j["id"] for j in dash["jobs"]}
        assert no not in {r["no"] for r in dash["recentRuns"]}
        assert no not in {r["no"] for r in client.get("/api/runs").json()}
        for path in (f"/api/jobs/{jid}/files", f"/api/jobs/{jid}/files/history", f"/api/jobs/{jid}/builds",
                     f"/api/jobs/{jid}/images", f"/api/runs/{no}", f"/api/runs/{no}/stream"):
            assert client.get(path).status_code == 404, (who, path)
        assert all(name not in i["usedBy"] for i in client.get("/api/registries").json()["images"])

    login(DEPLOYER, sudo=True)
    assert client.post(f"/api/jobs/{jid}/runs", json={"tag": "15", "groups": []}).status_code == 404
    assert client.post(f"/api/runs/{no}/cancel").status_code == 404
    assert client.delete(f"/api/jobs/{jid}").status_code == 404


def test_editors_and_creator_see_the_job(client, login):
    login(OWNER, sudo=True)
    groups = {g["name"]: g for g in client.get("/api/groups").json()["groups"]}
    viewer_group = next(g for g in groups.values() if VIEWER in g["members"])
    job = client.post("/api/jobs", json=builtin_job(f"vis · ed {uuid.uuid4().hex[:6]}", "staging", "postgres:15",
                                                   editors={"groups": [viewer_group["id"]], "members": [DEPLOYER]})).json()
    for who in (DEPLOYER, VIEWER):
        login(who)
        assert job["id"] in _ids(client), who
        assert client.get(f"/api/jobs/{job['id']}/files").status_code == 200

    # A Deployer's own job is visible to them even with no editors listed.
    login(DEPLOYER, sudo=True)
    mine = client.post("/api/jobs", json=builtin_job(f"vis · mine {uuid.uuid4().hex[:6]}", "staging", "postgres:15")).json()
    assert mine["id"] in _ids(client)
    login(VIEWER)
    assert mine["id"] not in _ids(client)


def test_owner_preview_sees_what_the_member_sees(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=builtin_job(f"vis · pv {uuid.uuid4().hex[:6]}", "staging", "postgres:15")).json()
    assert job["id"] not in {j["id"] for j in client.get("/api/jobs", headers={"X-View-As": VIEWER}).json()}
