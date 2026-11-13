"""`.env` upload from a project folder, signed in with the uploader's own Gitea login.

No Wharfline account or API token is handed out. The caller sends the same Authorization header it
uses for the Gitea API (Basic with the saved git login, or `token ...`). Wharfline passes it on to
the Gitea at WHARFLINE_GITEA_URL, only there, and accepts the upload when that login may push to the
repository. The values go to the env set `<repo name>-env` as a new version.
"""

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import bundles
from . import models as m
from . import store as s

TIMEOUT = 10
MAX_BODY = 256 * 1024
REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$")  # no "." or ".." parts in the Gitea API path


class Rejected(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


def gitea_url() -> str | None:
    """Where Wharfline asks Gitea (inside the server, e.g. http://gitea:3000). Never taken from the request."""
    return os.getenv("WHARFLINE_GITEA_URL", "").strip().rstrip("/") or None


def gitea_get(base: str, path: str, auth: str) -> tuple[int, Any]:
    """GET <base>/api/v1/<path> with the caller's Authorization header. (status, JSON or None); 0 when unreachable."""
    req = urllib.request.Request(f"{base}/api/v1/{path}", headers={"Authorization": auth, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, TimeoutError, ValueError):
        return 0, None


def check_push(base: str, auth: str, repo: str) -> str:
    """The Gitea login name when it may push to `repo`; raises Rejected otherwise."""
    code, user = gitea_get(base, "user", auth)
    if code == 0:
        raise Rejected(502, "Gitea 에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.")
    if code != 200 or not isinstance(user, dict) or not user.get("login"):
        raise Rejected(401, "Gitea 로그인이 맞지 않아요. git 로그인을 다시 한 뒤 해 주세요.")
    code, info = gitea_get(base, f"repos/{repo}", auth)
    if code == 0:
        raise Rejected(502, "Gitea 에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.")
    if code != 200 or not isinstance(info, dict):
        raise Rejected(404, f"Gitea 에서 {repo} 저장소를 찾지 못했어요(또는 볼 권한이 없어요).")
    perms = info.get("permissions") or {}
    if not (perms.get("push") or perms.get("admin")):
        raise Rejected(403, f"{user['login']} 은(는) {repo} 에 push 할 권한이 없어요.")
    return str(user["login"])


def parse(payload: Any) -> tuple[str, list[list[str]]]:
    """(owner/name, [[KEY, value], ...]) from {"repo": ..., "env": "<.env text>"}. A key given twice keeps the last value."""
    if not isinstance(payload, dict):
        raise Rejected(400, '{"repo": "owner/name", "env": ".env 내용"} 형식으로 보내 주세요.')
    repo = str(payload.get("repo") or "").strip().removesuffix(".git")
    text = payload.get("env")
    if not REPO_RE.match(repo):
        raise Rejected(400, "repo 는 owner/name 형식으로 보내 주세요.")
    if not isinstance(text, str):
        raise Rejected(400, "env 에 .env 파일 내용을 넣어 주세요.")
    values: dict[str, str] = {}
    for k, v in bundles.parse_env(text):
        values[k] = v
    if not values:
        raise Rejected(400, ".env 에 KEY=VALUE 줄이 없어요.")
    return repo, [[k, v] for k, v in values.items()]


def env_name(repo: str) -> str:
    return f"{repo.split('/', 1)[1].lower()}-env"


def save(db: Session, name: str, vars_: list[list[str]], login: str) -> dict[str, Any]:
    """Create the set, or store the upload as its next version. Only variable names are logged or returned."""
    from .routers.envs import replace_vars

    who = f"{login} (Gitea)"
    e = db.scalar(select(m.EnvSet).where(m.EnvSet.name == name))
    if not e:
        e = m.EnvSet(id=s.new_id("e"), name=name, ver=1, updated=f"방금 · {who}")
        e.set_vars(vars_)
        db.add(e)
        d = {"add": [k for k, _ in vars_], "chg": [], "del": []}
        status = "created"
    else:
        d = s.diff_vars(e.get_vars(), vars_)
        if not any(d.values()):
            return {"name": name, "ver": e.ver, "status": "unchanged", "added": [], "changed": [], "removed": []}
        replace_vars(e, vars_, f"방금 · {who}")
        status = "updated"
    parts = " / ".join(p for p in [
        d["add"] and "추가 " + ", ".join(d["add"]),
        d["chg"] and "수정 " + ", ".join(d["chg"]),
        d["del"] and "삭제 " + ", ".join(d["del"]),
    ] if p)
    db.add(m.Activity(time=s.now_hms(), user=who[:128], action="환경 변수 업로드", object=f"{name} v{e.ver} · {parts}"[:500],
                      ip=s.client_ip(), result="ok"))
    db.commit()
    return {"name": name, "ver": e.ver, "status": status, "added": d["add"], "changed": d["chg"], "removed": d["del"]}
