"""Docker Compose jobs: Wharfline writes the script, the compose file is pasted or comes from a repo."""

from app import executor
from tests.conftest import OWNER, builtin_job

COMPOSE = "services:\n  api:\n    image: ghcr.io/acme/compose-api:${APP_VERSION}\n"
NO_REPO = {"url": "", "branch": "main", "path": "", "key": ""}
IN_REPO = {"url": "https://git.acme.kr/ops/compose-app.git", "branch": "main", "path": "deploy/compose.yml", "key": ""}


def _job(name: str, compose: dict, **extra) -> dict:
    return builtin_job(name, "staging", "") | {"playbook": {"source": "script"}, "compose": compose,
                                               "files": [{"path": "my-name.yaml", "content": COMPOSE}]} | extra


def test_pasted_compose_job(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/jobs", json=_job("compose · pasted", NO_REPO))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["compose"] is True and job["composePath"] is None and job["playbook"]["path"] == "Docker Compose"
    assert [st["name"] for st in job["script"]] == ["이미지 받기", "컨테이너 교체", "정리"]
    assert [f["path"] for f in job["files"]] == ["docker-compose.yml"]
    assert job["servicePath"] == "/srv/compose-pasted"
    assert job["extraImages"][0]["ref"] == "ghcr.io/acme/compose-api" and job["extraImages"][0]["tagVar"] == "APP_VERSION"


def test_the_script_is_not_taken_from_the_client(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/jobs", json=_job("compose · own script", NO_REPO, script=[{"name": "x", "run": "rm -rf /"}]))
    assert r.status_code == 200 and "rm -rf" not in r.text


def test_compose_from_a_repo_holds_the_repo(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/jobs", json=_job("compose · repo", IN_REPO))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["composePath"] == "deploy/compose.yml" and job["playbook"]["url"] == IN_REPO["url"] and job["playbook"]["kind"] == "script"

    repo = next(x for x in client.get("/api/repos").json() if x["url"] == IN_REPO["url"])
    assert client.delete(f"/api/repos/{repo['id']}").status_code == 400  # a job still reads from it


def test_edit_keeps_the_saved_file_and_can_leave_compose(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=_job("compose · edit", NO_REPO)).json()
    body = _job("compose · edit", NO_REPO, envMode="keep") | {"files": None}
    r = client.put(f"/api/jobs/{job['id']}", json=body)
    assert r.status_code == 200, r.text
    assert [f["path"] for f in r.json()["files"]] == ["docker-compose.yml"] and r.json()["compose"] is True

    plain = body | {"compose": None, "script": [{"name": "hello", "run": "echo hi"}]}
    r = client.put(f"/api/jobs/{job['id']}", json=plain)
    assert r.status_code == 200 and r.json()["compose"] is False and r.json()["playbook"]["path"] == "SSH 스크립트 · 1단계"


def test_bad_compose_jobs(client, login):
    login(OWNER, sudo=True)
    two = [{"path": "a.yml", "content": COMPOSE}, {"path": "b.yml", "content": COMPOSE}]
    assert client.post("/api/jobs", json=_job("compose · two", NO_REPO, files=two)).status_code == 400
    assert client.post("/api/jobs", json=_job("compose · none", NO_REPO, files=[])).status_code == 400
    assert client.post("/api/jobs", json=_job("compose · blank", NO_REPO, files=[{"path": "a.yml", "content": "  "}])).status_code == 400
    assert client.post("/api/jobs", json=_job("compose · path", IN_REPO | {"path": "../x.yml"})).status_code == 400
    r = client.post("/api/jobs", json=_job("compose · git", NO_REPO, playbook={"source": "git", "url": IN_REPO["url"], "path": "a.yml"}))
    assert r.status_code == 400


def test_fetch_reads_the_file(client, login, monkeypatch):
    seen = {}

    async def fake(repo, ref, path):
        seen.update(repo=repo, ref=ref, path=path)
        return COMPOSE, "abc1234"

    monkeypatch.setattr(executor, "read_repo_file", fake)
    login(OWNER)
    r = client.post("/api/compose/fetch", json={"url": "https://git.acme.kr/ops/fetch.git", "branch": "dev", "path": "compose.yml"})
    assert r.status_code == 200, r.text
    assert r.json() == {"content": COMPOSE, "commit": "abc1234"}
    assert seen["ref"] == "dev" and seen["path"] == "compose.yml" and "token" not in seen["repo"]


def test_fetch_says_what_went_wrong(client, login, monkeypatch):
    async def fake(repo, ref, path):
        raise executor.RepoFileError("저장소에 compose.yml 파일이 없어요.")

    monkeypatch.setattr(executor, "read_repo_file", fake)
    login(OWNER)
    r = client.post("/api/compose/fetch", json={"url": "https://git.acme.kr/ops/fetch.git", "path": "compose.yml"})
    assert r.status_code == 400 and "compose.yml" in r.json()["detail"]
    assert client.post("/api/compose/fetch", json={"url": "file:///etc", "path": "compose.yml"}).status_code == 400
    assert client.post("/api/compose/fetch", json={"url": "https://git.acme.kr/a/b.git", "path": "../x.yml"}).status_code == 400
