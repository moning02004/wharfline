"""File bundles (compose file or zip) and several watched images on SSH script jobs."""

import base64
import io
import stat
import zipfile

from tests.conftest import builtin_job, log_text, send_hook, wait_run

COMPOSE = """services:
  api:
    image: ghcr.io/acme/api-server:${API_TAG}
    env_file: .env
  web:
    image: ghcr.io/acme/web-front:${WEB_TAG}
"""


def upload(client, name: str, data: bytes):
    return client.post("/api/bundles/parse", json={"name": name, "data": base64.b64encode(data).decode()})


def make_zip(entries: dict[str, bytes], links: tuple[str, ...] = ()) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for path, blob in entries.items():
            zf.writestr(path, blob)
        for path in links:
            info = zipfile.ZipInfo(path)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, "/etc/passwd")
    return buf.getvalue()


def test_single_compose_file(client, login):
    r = upload(client, "docker-compose.yaml", COMPOSE.encode())
    assert r.status_code == 200, r.text
    d = r.json()
    assert [f["path"] for f in d["files"]] == ["docker-compose.yaml"] and d["env"] == [] and d["warnings"] == []


def test_zip_of_a_kubernetes_folder(client, login):
    z = make_zip({
        "k8s/01_namespace.yaml": b"kind: Namespace\n",
        "k8s/02_secrets.yaml": b"kind: Secret\n",
        "k8s/05_deployment.yaml": b"spec:\n  hostNetwork: true\n  volumes:\n    - hostPath: {path: /}\n",
        "k8s/Makefile": b"deploy:\n\tkubectl apply -f .\n",
        "k8s/.env": b"# comment\nDB_HOST=10.0.3.31\nexport API_KEY='abc'\n",
        "k8s/logo.png": b"\x89PNG\r\n\x1a\n\x00\xff",
        "k8s/__MACOSX/._x": b"junk",
    }, links=("k8s/evil",))
    d = upload(client, "deploy.zip", z).json()
    assert [f["path"] for f in d["files"]] == ["01_namespace.yaml", "02_secrets.yaml", "05_deployment.yaml", "Makefile"]  # folder stripped
    assert d["env"] == [["DB_HOST", "10.0.3.31"], ["API_KEY", "abc"]]
    reasons = {x["path"]: x["reason"] for x in d["dropped"]}
    assert reasons[".env"] == "환경 변수로 옮겼어요" and "텍스트" in reasons["logo.png"] and "링크" in reasons["k8s/evil"]
    msgs = [w["message"] for w in d["warnings"] if w["path"] == "05_deployment.yaml"]
    assert any("hostNetwork" in x for x in msgs) and any("hostPath" in x for x in msgs)


def test_unsafe_zip_paths_are_dropped(client, login):
    d = upload(client, "x.zip", make_zip({"../escape.yaml": b"a", "ok.yaml": b"b", "dir/../../x": b"c"})).json()
    assert [f["path"] for f in d["files"]] == ["ok.yaml"]
    assert upload(client, "x.zip", b"not a zip").status_code == 400


def script_job(name: str, **extra) -> dict:
    body = builtin_job(name, "staging", "", **extra) | {
        "playbook": {"source": "script"},
        "script": [{"name": "올리기", "run": 'cd "$SERVICE_PATH"\ndocker compose up -d'}],
        "files": [{"path": "docker-compose.yaml", "content": COMPOSE}],
        "extraImages": [{"image": "ghcr.io/acme/api-server:v1.8.1", "var": "API"}, {"image": "ghcr.io/acme/web-front:v2.3.0", "var": "web"}],
    }
    return body


def test_job_with_files_and_images(client, login):
    r = client.post("/api/jobs", json=script_job("bundle · app", hook=True))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["files"] == [{"path": "docker-compose.yaml", "size": len(COMPOSE.encode())}]
    assert [(x["var"], x["defaultTag"], x["tagNow"]) for x in job["extraImages"]] == [("API", "v1.8.1", "-"), ("WEB", "v2.3.0", "-")]
    files = client.get(f"/api/jobs/{job['id']}/files").json()
    assert files[0]["content"] == COMPOSE

    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"groups": [], "extraTags": {"WEB": "v2.3.1"}}).json()["no"])
    assert run["status"] == "ok" and run["extraTags"] == {"API": "v1.8.1", "WEB": "v2.3.1"}
    log = log_text(run)
    assert "파일 올리기 → /srv/bundle-app (1개)" in log and "docker-compose.yaml" in log
    assert "API_TAG=v1.8.1" in log and "WEB_TAG=v2.3.1" in log and "WEB_IMAGE=ghcr.io/acme/web-front" in log
    after = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert {x["var"]: x["tagNow"] for x in after["extraImages"]} == {"API": "v1.8.1", "WEB": "v2.3.1"}
    assert "v2.3.1" in next(x for x in after["extraImages"] if x["var"] == "WEB")["tags"]  # a typed tag is remembered


def test_new_tag_of_an_extra_image_deploys_only_that_image(client, login):
    from app import githooks
    from app.db import SessionLocal

    with SessionLocal() as db:
        secret = githooks.new_secret(db)
        db.commit()
    pkg = {"action": "created", "package": {"type": "container", "name": "api-server", "version": "v1.9.0", "owner": {"login": "acme"}}}
    r = send_hook(client, secret, "package", pkg).json()
    jobs = {j["name"]: j for j in client.get("/api/jobs").json()}
    job = jobs["bundle · app"]
    runs = [no for no in r["runs"] if client.get(f"/api/runs/{no}").json()["jobId"] == job["id"]]
    assert len(runs) == 1
    run = wait_run(client, runs[0])
    assert run["extraTags"] == {"API": "v1.9.0", "WEB": "v2.3.1"}  # WEB keeps the version running now


def test_files_and_images_are_checked(client, login):
    def post(**over):
        return client.post("/api/jobs", json=script_job("bundle · bad") | over).status_code

    assert post(files=[{"path": ".env", "content": "A=1"}]) == 400
    assert post(files=[{"path": "../x.yaml", "content": "a"}]) == 400
    assert post(files=[{"path": "a.yaml", "content": "x"}, {"path": "a.yaml", "content": "y"}]) == 400
    assert post(extraImages=[{"image": "nginx:1", "var": "1BAD"}]) == 400
    assert post(extraImages=[{"image": "nginx:1", "var": "A"}, {"image": "redis:7", "var": "A"}]) == 400


def test_edit_keeps_files_unless_sent(client, login):
    job = next(j for j in client.get("/api/jobs").json() if j["name"] == "bundle · app")
    body = script_job("bundle · app", hook=True) | {"envMode": "keep"}
    body.pop("files")
    assert client.put(f"/api/jobs/{job['id']}", json=body).status_code == 200
    assert client.get(f"/api/jobs/{job['id']}/files").json()[0]["path"] == "docker-compose.yaml"
    body["files"] = []
    assert client.put(f"/api/jobs/{job['id']}", json=body).json()["files"] == []


def test_file_versions_and_the_version_each_run_used(client, login):
    body = script_job("bundle · versions")
    job = client.post("/api/jobs", json=body).json()
    assert job["filesVer"] == 1
    run1 = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"groups": []}).json()["no"])
    assert run1["filesVer"] == 1

    # change the compose file, add a Makefile
    body2 = body | {"envMode": "keep", "files": [{"path": "docker-compose.yaml", "content": COMPOSE + "# v2\n"},
                                                 {"path": "Makefile", "content": "deploy:\n\ttrue\n"}]}
    assert client.put(f"/api/jobs/{job['id']}", json=body2).json()["filesVer"] == 2
    # saving the same files again makes no new version
    assert client.put(f"/api/jobs/{job['id']}", json=body2).json()["filesVer"] == 2
    run2 = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"groups": []}).json()["no"])
    assert run2["filesVer"] == 2

    hist = client.get(f"/api/jobs/{job['id']}/files/history").json()
    assert [h["ver"] for h in hist] == [2, 1]
    assert hist[0]["changes"] == {"added": ["Makefile"], "changed": ["docker-compose.yaml"], "removed": []}
    assert hist[0]["createdBy"] == "정훈" and hist[0]["count"] == 2
    old = client.get(f"/api/jobs/{job['id']}/files", params={"ver": 1}).json()
    assert [f["path"] for f in old] == ["docker-compose.yaml"] and old[0]["content"] == COMPOSE
    assert client.get(f"/api/jobs/{job['id']}/files", params={"ver": 9}).status_code == 404
