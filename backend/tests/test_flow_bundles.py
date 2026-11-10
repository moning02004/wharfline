"""File bundles (compose file or zip) and several watched images on SSH script jobs."""

import base64
import io
import stat
import zipfile

from tests.conftest import builtin_job, last_run_no, log_text, send_hook, wait_auto_run, wait_run

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
    }
    return body


def test_job_with_files_and_images(client, login):
    r = client.post("/api/jobs", json=script_job("bundle · app", hook=True))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["files"] == [{"path": "docker-compose.yaml", "size": len(COMPOSE.encode())}]
    # read from the compose file: ${API_TAG} and ${WEB_TAG}
    assert [(x["ref"], x["var"], x["defaultTag"], x["tagNow"]) for x in job["extraImages"]] == [
        ("ghcr.io/acme/api-server", "API", "latest", "-"), ("ghcr.io/acme/web-front", "WEB", "latest", "-")]
    files = client.get(f"/api/jobs/{job['id']}/files").json()
    assert files[0]["content"] == COMPOSE

    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"groups": [], "extraTags": {"WEB": "v2.3.1"}}).json()["no"])
    assert run["status"] == "ok" and run["extraTags"]["WEB"] == "v2.3.1" and run["extraTags"]["API"]  # API: newest known tag
    log = log_text(run)
    assert "파일 올리기 → /srv/bundle-app (1개)" in log and "docker-compose.yaml" in log
    assert f"API_TAG={run['extraTags']['API']}" in log and "WEB_TAG=v2.3.1" in log and "WEB_IMAGE=ghcr.io/acme/web-front" in log
    after = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert {x["var"]: x["tagNow"] for x in after["extraImages"]} == run["extraTags"]
    assert "v2.3.1" in next(x for x in after["extraImages"] if x["var"] == "WEB")["tags"]  # a typed tag is remembered


def test_new_tag_of_an_extra_image_deploys_only_that_image(client, login):
    from app import githooks
    from app.db import SessionLocal

    with SessionLocal() as db:
        secret = githooks.new_secret(db)
        db.commit()
    before = last_run_no(client)
    pkg = {"action": "created", "package": {"type": "container", "name": "api-server", "version": "v1.9.0", "owner": {"login": "acme"}}}
    r = send_hook(client, secret, "package", pkg).json()
    assert "bundle · app" in r["queued"]
    run = wait_run(client, wait_auto_run(client, "bundle · app", before)["no"])
    assert run["extraTags"]["API"] == "v1.9.0" and run["extraTags"]["WEB"] == "v2.3.1"  # WEB keeps the version running now


def test_files_and_images_are_checked(client, login):
    def post(**over):
        return client.post("/api/jobs", json=script_job("bundle · bad") | over).status_code

    assert post(files=[{"path": ".env", "content": "A=1"}]) == 400
    assert post(files=[{"path": "../x.yaml", "content": "a"}]) == 400
    assert post(files=[{"path": "a.yaml", "content": "x"}, {"path": "a.yaml", "content": "y"}]) == 400
    typo = client.post("/api/jobs", json=script_job("bundle · bad") | {"files": [{"path": "c.yaml", "content": "services:\n  a:\n    image: ghrc.io/acme/app:${APP_TAG}\n"}]})
    assert typo.status_code == 400 and "ghcr.io의 오타" in typo.json()["detail"]
    # images of a git/builtin job are still entered by hand and checked
    hand = builtin_job("bundle · bad images", "staging", "nginx:1")
    assert client.post("/api/jobs", json=hand | {"extraImages": [{"image": "nginx:1", "var": "1BAD"}]}).status_code == 400
    assert client.post("/api/jobs", json=hand | {"extraImages": [{"image": "nginx:1", "var": "A"}, {"image": "redis:7", "var": "A"}]}).status_code == 400


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


def test_tracked_images_come_from_the_files(client, login):
    files = [{"path": "docker-compose.yaml", "content": "services:\n  b:\n    image: ghcr.io/acme/track-back:${BACK_TAG}\n"
              "  w:\n    image: ghcr.io/acme/track-web:latest\n  db:\n    image: postgres:16-alpine\n"}]
    job = client.post("/api/jobs", json=script_job("bundle · derived") | {"files": files}).json()
    got = {(x["ref"], x["var"], x.get("literal")) for x in job["extraImages"]}
    assert got == {("ghcr.io/acme/track-back", "BACK", None), ("ghcr.io/acme/track-web", "", "latest"),
                   ("docker.io/library/postgres", "", "16-alpine")}
    # editing the file changes what is tracked
    files2 = [{"path": "docker-compose.yaml", "content": "services:\n  b:\n    image: ghcr.io/acme/track-back:${BACK_TAG}\n"
               "  w:\n    image: ghcr.io/acme/track-web:${WEB_TAG}\n"}]
    body = script_job("bundle · derived") | {"files": files2, "envMode": "keep"}
    job2 = client.put(f"/api/jobs/{job['id']}", json=body).json()
    assert {x["var"] for x in job2["extraImages"]} == {"BACK", "WEB"}


def test_a_tag_variable_not_ending_in_tag_is_exported_as_written(client, login):
    files = [{"path": "docker-compose.yaml", "content": "services:\n  a:\n    image: ghcr.io/acme/ver-app:${APP_VERSION}\n"}]
    job = client.post("/api/jobs", json=script_job("bundle · version var") | {"files": files}).json()
    x = job["extraImages"][0]
    assert (x["var"], x["tagVar"]) == ("APP_VERSION", "APP_VERSION")
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"groups": [], "extraTags": {"APP_VERSION": "v3"}}).json()["no"])
    assert run["status"] == "ok"
    assert "APP_VERSION=v3" in log_text(run) and "APP_VERSION_TAG=v3" in log_text(run)


def test_watched_only_image_redeploys_and_build_repo_links_itself(client, login):
    from app import githooks
    from app.db import SessionLocal

    files = [{"path": "docker-compose.yaml", "content": "services:\n  w:\n    image: ghcr.io/acme/watch-web:latest\n"}]
    job = client.post("/api/jobs", json=script_job("bundle · watch", hook=True, hookRule="any") | {"files": files}).json()
    with SessionLocal() as db:
        secret = githooks.new_secret(db)
        db.commit()
    pkg = {"action": "published", "repository": {"full_name": "acme/watch"},
           "registry_package": {"name": "watch-web", "package_type": "CONTAINER", "owner": {"login": "acme"},
                                "package_version": {"version": "sha256:cc", "container_metadata": {"tag": {"name": "v7"}}}}}
    before = last_run_no(client)
    r = send_hook(client, secret, "registry_package", pkg, provider="github").json()
    assert "bundle · watch" in r["queued"]  # a watched-only image still redeploys
    assert wait_run(client, wait_auto_run(client, "bundle · watch", before)["no"])["extraTags"] == {}  # the file decides the version
    view = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert view["extraImages"][0]["sourceRepo"] == "acme/watch"  # learned from the event


def test_build_repo_for_hand_entered_images(client, login):
    from tests.conftest import DEPLOYER

    body = builtin_job("bundle · builds", "staging", "ghcr.io/acme/track-main:v1") | {
        "imageSourceRepo": "acme/track",
        "extraImages": [{"image": "ghcr.io/acme/track-side:v1", "var": "SIDE", "sourceRepo": "acme/track-side"}],
    }
    job = client.post("/api/jobs", json=body).json()
    assert job["imageSourceRepo"] == "acme/track" and job["extraImages"][0]["sourceRepo"] == "acme/track-side"
    login(DEPLOYER)  # a Deployer can't change build repos: the value is ignored
    body2 = builtin_job("bundle · builds 2", "staging", "ghcr.io/acme/track-main:v1") | {"imageSourceRepo": "evil/repo"}
    assert client.post("/api/jobs", json=body2).json()["imageSourceRepo"] == "acme/track"


def test_registry_lists_how_each_job_uses_an_image(client, login):
    files = [{"path": "docker-compose.yaml", "content": "services:\n  a:\n    image: ghcr.io/acme/usage-api:${API_TAG}\n  d:\n    image: redis:7\n"}]
    assert client.post("/api/jobs", json=script_job("bundle · usage") | {"files": files}).status_code == 200
    images = {i["ref"]: i for i in client.get("/api/registries").json()["images"]}
    api = next(u for u in images["ghcr.io/acme/usage-api"]["usage"] if u["job"] == "bundle · usage")
    assert api["role"] == "var" and api["var"] == "API_TAG" and api["inventory"] == "staging"
    redis = next(u for u in images["docker.io/library/redis"]["usage"] if u["job"] == "bundle · usage")
    assert redis["role"] == "fixed" and redis["literal"] == "7"


def test_required_variable_with_a_message_is_a_tag_variable(client, login):
    """`${V:?set V in .env}` (spaces inside) is one variable; backend and frontend may share it."""
    from app import bundles

    compose = ("services:\n"
               "  backend:\n    image: ghcr.io/acme/req-backend:${WHARFLINE_VERSION:?set WHARFLINE_VERSION in .env, e.g. 2026.11.08-1}\n"
               "  frontend:\n    image: ghcr.io/acme/req-frontend:${WHARFLINE_VERSION:?set WHARFLINE_VERSION in .env}\n"
               "  web:\n    image: ghcr.io/acme/req-web:${WEB_TAG-latest}\n"
               "  db:\n    image: postgres:16-alpine\n")
    found = bundles.file_images([{"path": "docker-compose.yml", "content": compose}])
    assert [(x["ref"], x["var"], x["literal"]) for x in found] == [
        ("ghcr.io/acme/req-backend", "WHARFLINE_VERSION", None),
        ("ghcr.io/acme/req-frontend", "WHARFLINE_VERSION", None),
        ("ghcr.io/acme/req-web", "WEB", None),
        ("postgres", None, "16-alpine"),
    ]
    assert bundles.split_image("ghcr.io/a/b:${V:?see docs/x: here}") == ("ghcr.io/a/b", "${V:?see docs/x: here}")

    r = client.post("/api/jobs", json=script_job("bundle · required") | {"files": [{"path": "docker-compose.yml", "content": compose}]})
    assert r.status_code == 200, r.text
    tracked = {x["ref"]: x for x in r.json()["extraImages"]}
    assert tracked["ghcr.io/acme/req-backend"]["var"] == tracked["ghcr.io/acme/req-frontend"]["var"] == "WHARFLINE_VERSION"
    run = wait_run(client, client.post(f"/api/jobs/{r.json()['id']}/runs", json={"tag": "-", "groups": [], "extraTags": {"WHARFLINE_VERSION": "v2026.11.11-1"}}).json()["no"])
    assert run["extraTags"]["WHARFLINE_VERSION"] == "v2026.11.11-1"
    assert "WHARFLINE_VERSION=v2026.11.11-1" in log_text(run)  # the name the file reads
