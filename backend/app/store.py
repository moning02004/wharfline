"""Shared constants and DB-backed helpers.

Helpers return plain dicts in the API's shape so the deploy runner and the
routers can stay storage-agnostic.
"""

from __future__ import annotations

import hashlib
import re
import time
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models as m

CLIENT_IP = "211.234.10.8"

COMPOSE_TPL = (
    "services:\n"
    "  app:\n"
    "    image: ${IMAGE}:${IMAGE_TAG}\n"
    "    env_file: .env\n"
    "    restart: unless-stopped\n"
    "    ports:\n"
    '      - "8080:8080"\n'
    "    healthcheck:\n"
    '      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]\n'
    "      interval: 10s\n"
)

ROLES = ["Owner", "Admin", "Deployer", "Viewer"]

# Menus a group can be given. The dashboard is always visible; Owners see everything.
MENUS = ["jobs", "runs", "registries", "repos", "inventory", "keys", "envs", "activity", "members", "security", "notes"]


def now_hms() -> str:
    return datetime.now().strftime("%H:%M:%S")


def new_id(prefix: str) -> str:
    return f"{prefix}{int(time.time() * 1000)}"


# ---------- settings ----------

def get_setting(db: Session, key: str) -> dict[str, Any]:
    row = db.get(m.Setting, key)
    return dict(row.value) if row else {}


def set_setting(db: Session, key: str, **changes: Any) -> dict[str, Any]:
    row = db.get(m.Setting, key)
    if not row:
        row = m.Setting(key=key, value={})
        db.add(row)
    row.value = {**row.value, **changes}  # reassign so the JSONB change is saved
    return dict(row.value)


def session_state(db: Session) -> dict[str, Any]:
    return get_setting(db, "session")


def sudo_minutes(db: Session) -> int:
    return int(get_setting(db, "policy").get("sudoMinutes", 5))


def sudo_active(db: Session) -> bool:
    return time.time() < float(session_state(db).get("sudo_until", 0))


def log_act(db: Session, action: str, obj: str, result: str = "ok") -> None:
    db.add(m.Activity(time=now_hms(), user=actor_name(db), action=action, object=obj, ip=CLIENT_IP, result=result))


# ---------- who is signed in, and what they can see ----------

def current_member(db: Session) -> m.Member | None:
    """The signed-in member, from the session's email. None when signed out or the member was removed."""
    st = session_state(db)
    email = st.get("email")
    return db.get(m.Member, email) if st.get("logged_in") and email else None


def actor_name(db: Session) -> str:
    me = current_member(db)
    return me.name if me else "시스템"


def me_dict(member: m.Member) -> dict[str, Any]:
    return {"name": member.name, "role": member.role, "email": member.email, "groups": [g.name for g in member.groups]}


def visible_menus(member: m.Member | None) -> list[str] | None:
    """Menus from all of the member's groups. None means every menu (Owner)."""
    if member is None:
        return []
    if member.role == "Owner":
        return None
    return [x for x in MENUS if any(x in g.menus for g in member.groups)]


def build_scope(member: m.Member | None) -> set[str] | None:
    """Build repos (owner/name) the member may see. None means every repo."""
    if member is None:
        return set()
    if member.role == "Owner" or any(g.all_builds for g in member.groups):
        return None
    return {r for g in member.groups for r in g.repos}


def repo_allowed(scope: set[str] | None, repo: str | None) -> bool:
    return scope is None or (repo or "").lower() in scope


# ---------- lookups (dict-shaped) ----------

def inv_of(db: Session, job: dict) -> dict | None:
    inv = db.scalar(select(m.Inventory).where(m.Inventory.name == job["inventory"]))
    return inv.to_dict() if inv else None


def image_of(db: Session, job: dict) -> dict:
    img = db.get(m.Image, job["image"])
    return img.to_dict() if img else {"ref": job["image"], "tags": [], "registry": None}


def env_by_name(db: Session, name: str) -> dict | None:
    e = db.scalar(select(m.EnvSet).where(m.EnvSet.name == name))
    return {"name": e.name, "ver": e.ver, "keys": e.var_names} if e else None


def repo_by_name(db: Session, name: str | None) -> dict | None:
    r = db.scalar(select(m.Repo).where(m.Repo.name == name)) if name else None
    return r.to_dict() if r else None


def registry_of(db: Session, job: dict) -> dict:
    """The registry the image was registered with; falls back to the first one on the same host."""
    host = job["image"].split("/")[0]
    img = db.get(m.Image, job["image"])
    r = db.get(m.Registry, img.registry_id) if img and img.registry_id else None
    r = r or db.scalar(select(m.Registry).where(m.Registry.host == host).order_by(m.Registry.ord))
    return r.to_dict() if r else {"host": host, "user": "", "public": True}


def groups_of(inv: dict | None) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for h in (inv or {}).get("hosts", []):
        out.setdefault(h["group"], []).append(h)
    return out


def target_hosts(inv: dict | None, groups: list[str]) -> list[dict]:
    if not inv:
        return []
    return [h for h in inv["hosts"] if not groups or h["group"] in groups]


def target_label(groups: list[str], inv: dict | None) -> str:
    all_groups = list(groups_of(inv).keys())
    return "전체" if not groups or len(groups) == len(all_groups) else ", ".join(groups)


def host_skip(h: dict) -> str:
    if h["hostKey"] != "ok":
        return "호스트 키 확인 필요"
    if h["status"] != "on":
        return "응답 없음"
    return ""


def resolve_tag(img: dict, tag: str) -> str:
    if tag != "latest":
        return tag
    return img["tags"][0]["name"] if img["tags"] else "latest"


def tag_info(img: dict, tag: str) -> dict:
    t = next((t for t in img["tags"] if t["name"] == tag), {"name": tag, "digest": "", "pushed": "-"})
    if not t["digest"]:
        # Simulated: a real runner resolves the tag in the registry and pins this digest.
        t = {**t, "digest": hashlib.sha256(f"{img['ref']}:{tag}".encode()).hexdigest()[:8]}
    return t


def prev_tag(db: Session, job: dict, img: dict) -> str | None:
    """Last successful different tag, else the release tag one step below the current one."""
    r = db.scalar(
        select(m.Run)
        .where(m.Run.job == job["name"], m.Run.status == "ok", m.Run.tag != job["tagNow"])
        .order_by(m.Run.no.desc())
        .limit(1)
    )
    if r:
        return r.tag
    tags = [t["name"] for t in img["tags"] if not t["name"].startswith("sha-")]
    if job["tagNow"] in tags:
        i = tags.index(job["tagNow"])
        if i + 1 < len(tags):
            return tags[i + 1]
    return None


# ---------- validation ----------

COMPOSE_RULES = [
    (re.compile(r"privileged:\s*true"), "privileged: true"),
    (re.compile(r"network_mode:\s*[\"']?host"), "network_mode: host"),
    (re.compile(r"docker\.sock"), "docker.sock 마운트"),
    (re.compile(r"^\s*build:", re.M), "build: (서버에서 빌드)"),
    (re.compile(r"pid:\s*[\"']?host"), "pid: host"),
    (re.compile(r"cap_add:"), "cap_add"),
]


def compose_risk(txt: str) -> list[str]:
    """Compose options that hand server-level privileges to a container."""
    return [label for rx, label in COMPOSE_RULES if rx.search(txt)]


ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ENV_MAX_VARS = 500
ENV_MAX_VALUE = 32 * 1024


def validate_vars(vars_: list[list[str]]) -> None:
    from fastapi import HTTPException

    if len(vars_) > ENV_MAX_VARS:
        raise HTTPException(400, f"변수는 {ENV_MAX_VARS}개까지 넣을 수 있어요.")
    seen: set[str] = set()
    for pair in vars_:
        if len(pair) != 2:
            raise HTTPException(400, "변수는 [이름, 값] 형식이어야 해요.")
        k, v = pair
        if not ENV_KEY_RE.match(k):
            raise HTTPException(400, f'"{k or "(빈 이름)"}"은(는) 변수 이름으로 쓸 수 없어요.')
        if len(v) > ENV_MAX_VALUE:
            raise HTTPException(400, f"{k} 값이 너무 길어요 (최대 32KB).")
        if k in seen:
            raise HTTPException(400, f"{k}이(가) 두 번 들어 있어요.")
        seen.add(k)


def diff_vars(a: list[list[str]], b: list[list[str]]) -> dict[str, list[str]]:
    A, B = dict(map(tuple, a)), dict(map(tuple, b))
    return {
        "add": [k for k in B if k not in A],
        "chg": [k for k in B if k in A and A[k] != B[k]],
        "del": [k for k in A if k not in B],
    }
