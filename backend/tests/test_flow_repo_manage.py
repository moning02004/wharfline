"""Playbook repos: change the key or token a repo uses, and delete repos no job uses."""

from tests.conftest import OWNER, builtin_job


def _repo(client, name):
    return next((r for r in client.get("/api/repos").json() if r["name"] == name), None)


def _key_uses(client, name):
    return next(k for k in client.get("/api/keys").json() if k["name"] == name)["usedCount"]


def _git_job(name, url, key=""):
    return builtin_job(name, "staging", "") | {"playbook": {"source": "git", "url": url, "branch": "main", "path": "site.yml", "key": key}}


def test_change_the_token_and_delete_the_repo(client, login):
    login(OWNER, sudo=True)
    job = client.post("/api/jobs", json=_git_job("repoman · app", "https://git.acme.kr/ops/repoman.git")).json()
    repo = _repo(client, "ops/repoman")
    assert repo["auth"] == "공개 저장소"
    before = _key_uses(client, "github-readonly")

    r = client.put(f"/api/repos/{repo['id']}/key", json={"key": "github-readonly"})
    assert r.status_code == 200, r.text
    assert r.json()["auth"] == "토큰 · github-readonly" and _key_uses(client, "github-readonly") == before + 1
    # an HTTPS repo can't take an SSH key
    assert client.put(f"/api/repos/{repo['id']}/key", json={"key": "prod-deploy"}).status_code == 400

    # a repo a job uses stays
    r = client.delete(f"/api/repos/{repo['id']}")
    assert r.status_code == 400 and "repoman · app" in r.json()["detail"]
    assert client.delete(f"/api/jobs/{job['id']}").status_code == 200
    assert client.delete(f"/api/repos/{repo['id']}").status_code == 200
    assert _repo(client, "ops/repoman") is None and _key_uses(client, "github-readonly") == before


def test_ssh_repos_need_a_key_and_the_builtin_stays(client, login):
    login(OWNER, sudo=True)
    client.post("/api/jobs", json=_git_job("repoman · ssh", "git@git.acme.kr:ops/repoman-ssh.git", "prod-deploy"))
    repo = _repo(client, "ops/repoman-ssh")
    assert client.put(f"/api/repos/{repo['id']}/key", json={"key": ""}).status_code == 400
    builtin = next(r for r in client.get("/api/repos").json() if r["kind"] == "builtin")
    assert client.delete(f"/api/repos/{builtin['id']}").status_code == 400


def test_repo_changes_need_the_password_check(client, login):
    login(OWNER, sudo=True)
    client.post("/api/jobs", json=_git_job("repoman · sudo", "https://git.acme.kr/ops/repoman-sudo.git"))
    repo = _repo(client, "ops/repoman-sudo")
    login(OWNER)
    assert client.put(f"/api/repos/{repo['id']}/key", json={"key": "github-readonly"}).status_code in (401, 403)
    assert client.delete(f"/api/repos/{repo['id']}").status_code in (401, 403)
