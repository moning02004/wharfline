import asyncio
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .. import serverinit, sshaccess, sshcheck, sshkeys
from .. import store as s
from ..db import get_db
from ..deps import require, require_login, require_sudo

router = APIRouter(prefix="/api", tags=["resources"], dependencies=[Depends(require_login)])

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ·-]{0,63}$")


# ---------- registries & images ----------

@router.get("/registries")
def list_registries(db: Session = Depends(get_db)):
    images = list(db.scalars(select(m.Image).order_by(m.Image.ord)))
    jobs = list(db.scalars(select(m.Job).order_by(m.Job.ord)))
    regs = list(db.scalars(select(m.Registry).order_by(m.Registry.ord)))
    pulled_by = {i.ref: (r.id if (r := s.registry_for(db, i.ref, regs)) else None) for i in images}
    return {
        "registries": [{**r.to_dict(), "imageCount": sum(1 for v in pulled_by.values() if v == r.id)} for r in regs],
        "images": [{**i.to_dict(), "registry": pulled_by[i.ref], "usedBy": image_users(jobs, i.ref), "usage": image_usage(jobs, i.ref)}
                   for i in images],
    }


def image_users(jobs: list[m.Job], ref: str) -> list[str]:
    """Jobs that deploy or watch the image (main image or one of the extra / file images)."""
    return [j.name for j in jobs if j.image == ref or any(x.get("ref") == ref for x in j.extra_images or [])]


def image_usage(jobs: list[m.Job], ref: str) -> list[dict]:
    """How each job uses the image: main image, a tag variable, or a version written in its file."""
    out: list[dict] = []
    for j in jobs:
        base = {"job": j.name, "jobId": j.id, "inventory": j.inventory, "targets": list(j.targets or []),
                "hook": j.hook, "hookRule": j.hook_rule or "v"}
        if j.image == ref:
            out.append({**base, "role": "main", "var": "IMAGE", "tagNow": j.tag_now, "literal": None})
        for x in j.extra_images or []:
            if x.get("ref") != ref:
                continue
            if x.get("var"):
                out.append({**base, "role": "var", "var": x.get("tagVar") or f"{x['var']}_TAG", "tagNow": x.get("tagNow"), "literal": None})
            else:
                out.append({**base, "role": "fixed", "var": None, "tagNow": None, "literal": x.get("literal") or "latest"})
    return out


class RegistryIn(BaseModel):
    host: str
    namespace: str = ""
    user: str = ""
    token: str = ""


def registry_name(host: str) -> str:
    if re.search(r"(^|\.)ghcr\.io$", host):
        return "GitHub Container Registry"
    if host in ("docker.io", "registry-1.docker.io", "index.docker.io"):
        return "Docker Hub"
    if host == "registry.gitlab.com" or "gitlab" in host:
        return "GitLab Container Registry"
    return "Gitea"


NAMESPACE_RE = re.compile(r"^[a-z0-9._-]+(/[a-z0-9._-]+)*$")


def registry_auth(name: str, has_token: bool) -> str:
    if not has_token:
        return "없음 · 공개 이미지"
    scope = "read:packages" if name.startswith("GitHub") else "read_registry" if name.startswith("GitLab") else "read:package"
    return f"토큰 · {scope}"


def check_registry_fields(body: "RegistryIn", has_token: bool) -> tuple[str, str]:
    ns = body.namespace.strip().strip("/").lower()
    if ns and not NAMESPACE_RE.match(ns):
        raise HTTPException(400, "조직 또는 사용자는 ermore나 group/sub처럼 넣어 주세요.")
    user = body.user.strip()
    if has_token and not user:
        raise HTTPException(400, "토큰을 쓰려면 로그인 계정도 넣어 주세요.")
    return ns, user


@router.post("/registries", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def add_registry(body: RegistryIn, db: Session = Depends(get_db)):
    host = body.host.strip().lower().removeprefix("https://").rstrip("/")
    if not re.match(r"^[a-z0-9.-]+(:\d+)?$", host):
        raise HTTPException(400, "주소는 ghcr.io나 git.example.com처럼 호스트 이름만 넣어 주세요.")
    token = body.token.strip()
    ns, user = check_registry_fields(body, bool(token))
    if db.scalar(select(m.Registry).where(m.Registry.host == host, m.Registry.namespace == ns)):
        raise HTTPException(400, f"{host}/{ns} 레지스트리가 이미 있어요. 토큰을 바꾸려면 목록에서 편집해 주세요.")
    name = registry_name(host)
    reg = m.Registry(id=s.new_id("r"), name=name, host=host, namespace=ns, user=user, auth=registry_auth(name, bool(token)))
    if token:
        reg.set_secret(token)  # envelope-encrypted; never returned
    db.add(reg)
    s.log_act(db, "레지스트리 추가", f"{host}/{reg.namespace}")
    db.commit()
    return reg.to_dict()


@router.put("/registries/{reg_id}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def update_registry(reg_id: str, body: RegistryIn, db: Session = Depends(get_db)):
    """Change the namespace, user or token. An empty token keeps the saved one; the host stays (add another registry instead)."""
    reg = db.get(m.Registry, reg_id)
    if not reg:
        raise HTTPException(404, "레지스트리를 찾을 수 없어요.")
    token = body.token.strip()
    ns, user = check_registry_fields(body, bool(token) or reg.has_secret)
    if db.scalar(select(m.Registry).where(m.Registry.host == reg.host, m.Registry.namespace == ns, m.Registry.id != reg.id)):
        raise HTTPException(400, f"{reg.host}/{ns} 레지스트리가 이미 있어요.")
    reg.namespace, reg.user = ns, user
    if token:
        reg.set_secret(token)
    reg.auth = registry_auth(reg.name, reg.has_secret)
    s.log_act(db, "레지스트리 수정", f"{reg.host}/{ns}" + (" · 토큰 교체" if token else ""), "warn" if token else "ok")
    db.commit()
    return reg.to_dict()


@router.delete("/registries/{reg_id}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def delete_registry(reg_id: str, db: Session = Depends(get_db)):
    """Forget a registry and its token. Its images stay; they are then pulled without a login (or by another registry on the host)."""
    reg = db.get(m.Registry, reg_id)
    if not reg:
        raise HTTPException(404, "레지스트리를 찾을 수 없어요.")
    s.log_act(db, "레지스트리 삭제", f"{reg.host}/{reg.namespace}", "warn")
    db.delete(reg)  # images.registry_id -> NULL
    db.commit()
    return {"ok": True}


class ImageIn(BaseModel):
    image: str


@router.post("/images", dependencies=[Depends(require("resources"))])
def add_image(body: ImageIn, db: Session = Depends(get_db)):
    """Register an image from "name:tag". The registry is matched by host; digests are pinned at deploy time.

    Registering an image that already exists only adds the new tag.
    """
    ref, tag = s.parse_image(body.image)
    img, created, added = s.ensure_image(db, ref, tag)
    s.log_act(db, "이미지 등록" if created else "이미지 태그 추가", f"{ref} ({', '.join(added) or '새 태그 없음'})")
    db.commit()
    return {**img.to_dict(), "created": created, "addedTags": added}


@router.delete("/images/tags", dependencies=[Depends(require("resources"))])
def delete_image_tag(ref: str, tag: str, db: Session = Depends(get_db)):
    """Forget one tag Wharfline knows for an image (a mistyped one, or one that was removed from the registry)."""
    img = db.get(m.Image, ref)
    t = next((x for x in img.tags if x.name == tag), None) if img else None
    if not t:
        raise HTTPException(404, "태그를 찾을 수 없어요.")
    img.tags.remove(t)  # delete-orphan removes the row
    s.log_act(db, "이미지 태그 삭제", f"{ref}:{tag}", "warn")
    db.commit()
    return img.to_dict()


@router.delete("/images", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def delete_image(ref: str, db: Session = Depends(get_db)):
    """Forget an image and the tags Wharfline knows. Images a job deploys or watches stay; edit the job first."""
    img = db.get(m.Image, ref)
    if not img:
        raise HTTPException(404, "이미지를 찾을 수 없어요.")
    users = image_users(list(db.scalars(select(m.Job).order_by(m.Job.name))), ref)
    if users:
        names = ", ".join(users[:3]) + (f" 외 {len(users) - 3}개" if len(users) > 3 else "")
        raise HTTPException(400, f"배포 작업 {len(users)}개에서 쓰고 있어 지울 수 없어요: {names}")
    s.log_act(db, "이미지 삭제", f"{ref} · 태그 {len(img.tags)}개", "warn")
    db.delete(img)  # its tags go with it
    db.commit()
    return {"ok": True}


# ---------- playbook repos ----------

@router.get("/repos")
def list_repos(db: Session = Depends(get_db)):
    """Repos are created when a job is saved. The built-in playbook repo is always listed first."""
    s.builtin_repo(db)
    db.commit()
    jobs = list(db.scalars(select(m.Job).order_by(m.Job.ord)))
    repos = db.scalars(select(m.Repo).order_by((m.Repo.kind != "builtin"), m.Repo.id))
    return [{**r.to_dict(), "usedBy": [{"job": j.name, "path": j.book} for j in jobs if j.repo == r.name]} for r in repos]


def git_repo(db: Session, repo_id: int) -> m.Repo:
    repo = db.get(m.Repo, repo_id)
    if not repo:
        raise HTTPException(404, "레포를 찾을 수 없어요.")
    if repo.kind != "git":
        raise HTTPException(400, "Wharfline 기본 플레이북은 바꾸거나 지울 수 없어요.")
    return repo


class RepoKeyIn(BaseModel):
    key: str = ""  # key store name; "" = a public repo (HTTPS only)


@router.put("/repos/{repo_id}/key", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def change_repo_key(repo_id: int, body: RepoKeyIn, db: Session = Depends(get_db)):
    """Use another SSH key or access token for a repo, e.g. after the old token was revoked on the Git host."""
    repo = git_repo(db, repo_id)
    new, auth = s.repo_key_for(db, repo.url, body.key.strip())
    old = s.repo_key(db, repo)
    if old is not new:
        if old and old.used_count:
            old.used_count -= 1
        if new:
            new.used_count += 1
    repo.auth = auth
    s.log_act(db, "플레이북 레포 키 변경", f"{repo.name} · {auth}", "warn")
    db.commit()
    return repo.to_dict()


@router.delete("/repos/{repo_id}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def delete_repo(repo_id: int, db: Session = Depends(get_db)):
    repo = git_repo(db, repo_id)
    users = list(db.scalars(select(m.Job.name).where(m.Job.repo == repo.name).order_by(m.Job.name)))
    if users:
        names = ", ".join(users[:3]) + (f" 외 {len(users) - 3}개" if len(users) > 3 else "")
        raise HTTPException(400, f"배포 작업 {len(users)}개에서 쓰고 있어 지울 수 없어요: {names}")
    key = s.repo_key(db, repo)
    if key and key.used_count:
        key.used_count -= 1
    s.log_act(db, "플레이북 레포 삭제", f"{repo.name} ({repo.url} · {repo.branch})", "warn")
    db.delete(repo)
    db.commit()
    return {"ok": True}


# ---------- inventory ----------

@router.get("/inventory")
def list_inventory(db: Session = Depends(get_db)):
    return [i.to_dict() for i in db.scalars(select(m.Inventory).order_by(m.Inventory.ord))]


USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


def check_ssh_user(user: str) -> str:
    user = user.strip()
    if user == "root":
        raise HTTPException(400, "root로는 접속할 수 없어요. 권한이 제한된 배포용 사용자를 만들어 주세요.")
    if not USER_RE.match(user):
        raise HTTPException(400, "SSH 사용자 이름을 확인해 주세요. 영문 소문자, 숫자, -, _ 예: deploy")
    return user


class FirstHostIn(BaseModel):
    name: str
    ip: str
    port: str = "22"
    group: str = "default"
    fingerprint: str = ""


class InventoryIn(BaseModel):
    name: str
    key: str
    user: str = "deploy"
    host: FirstHostIn | None = None  # the first server, checked with the connection check before this call


@router.post("/inventory", dependencies=[Depends(require("resources"))])
def add_inventory(body: InventoryIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
        raise HTTPException(400, "인벤토리 이름은 production처럼 영문 소문자, 숫자, -, _ 로 넣어 주세요.")
    if db.scalar(select(m.Inventory).where(m.Inventory.name == name)):
        raise HTTPException(400, "같은 이름의 인벤토리가 있어요.")
    key = db.scalar(select(m.Key).where(m.Key.name == body.key, m.Key.kind == "ssh"))
    if not key:
        raise HTTPException(400, "서버 접속에 쓸 SSH 키를 골라 주세요.")
    user = check_ssh_user(body.user or "deploy")
    inv = m.Inventory(id=s.new_id("i"), name=name, key=key.name, ssh_user=user)
    if body.host:
        h = body.host
        inv.hosts.append(new_host(inv, h.name, h.ip, h.port, user, h.group, h.fingerprint))
    key.used_count += 1
    db.add(inv)
    s.log_act(db, "인벤토리 생성", f"{name} · {user} · 키 {key.name}" + (f" · 서버 {body.host.name.strip()}" if body.host else ""))
    db.commit()
    return inv.to_dict()


class FingerprintIn(BaseModel):
    ip: str
    port: int


def _check_addr(ip: str, port: int) -> str:
    ip = ip.strip()
    if not re.match(r"^[A-Za-z0-9.:-]{1,253}$", ip):
        raise HTTPException(400, "IP 또는 호스트 이름을 확인해 주세요.")
    if not 1 <= port <= 65535:
        raise HTTPException(400, "포트는 1~65535 사이 숫자여야 해요.")
    return ip


@router.post("/inventory/fingerprint", dependencies=[Depends(require("resources"))])
async def fingerprint(body: FingerprintIn):
    """The server's host key, read over SSH without logging in."""
    r = await sshcheck.host_key(_check_addr(body.ip, body.port), body.port)
    if not r["reachable"]:
        raise HTTPException(400, r["error"])
    return {"type": r["type"], "fingerprint": r["fingerprint"]}


class CheckIn(BaseModel):
    ip: str
    port: int
    user: str
    key: str


@router.post("/inventory/check", dependencies=[Depends(require("resources"))])
async def check_connection(body: CheckIn, db: Session = Depends(get_db)):
    """Before saving a server: its host key, and whether the user can log in with the key."""
    ip = _check_addr(body.ip, body.port)
    user = body.user.strip()
    if user == "root":
        raise HTTPException(400, "root로는 접속할 수 없어요. 권한이 제한된 deploy 사용자를 만들어 주세요.")
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", user):
        raise HTTPException(400, "SSH 사용자 이름을 확인해 주세요. 예: deploy")
    key = db.scalar(select(m.Key).where(m.Key.name == body.key, m.Key.kind == "ssh"))
    if not key:
        raise HTTPException(400, "서버 접속에 쓸 SSH 키를 골라 주세요.")
    private = key.get_secret() or ""
    r = await sshcheck.check(ip, body.port, user, private)
    s.log_act(db, "서버 연결 확인", f"{user}@{ip}:{body.port} · 키 {key.name} · {'성공' if r['login'] else '실패'}")
    db.commit()
    # Which key was offered, so a failed login can be compared with the server's authorized_keys.
    return {**r, "keyName": key.name, "keyFingerprint": key.fingerprint}


class HostIn(BaseModel):
    name: str
    ip: str
    port: str
    user: str = ""  # empty: the inventory's user
    group: str = "default"
    key: str = ""
    fingerprint: str = ""  # host key seen by the connection check; pinned for deploys


FINGERPRINT_RE = re.compile(r"^SHA256:[A-Za-z0-9+/=]{20,64}$")


def new_host(inv: m.Inventory, name: str, ip: str, port: str, user: str, group: str, fingerprint: str) -> m.Host:
    """A server row after the same checks for every way in; not added to the session."""
    ip, group = ip.strip(), group.strip() or "default"
    # No name: the address (with the port when the address is already a server's name here).
    name = name.strip() or (ip if not any(h.name == ip for h in inv.hosts) else f"{ip}:{str(port).strip()}")
    user = check_ssh_user(user)
    if not str(port).strip().isdigit() or not 1 <= int(port) <= 65535:
        raise HTTPException(400, "포트는 1~65535 사이 숫자여야 해요.")
    if not re.match(r"^[A-Za-z0-9.:-]{1,253}$", ip):
        raise HTTPException(400, "IP 또는 호스트 이름을 확인해 주세요.")
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", group):
        raise HTTPException(400, "그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.")
    if not name or any(h.name == name for h in inv.hosts):
        raise HTTPException(400, "서버 이름이 비었거나 이 인벤토리에 이미 있어요.")
    fp = fingerprint.strip()
    if fp and not FINGERPRINT_RE.match(fp):
        raise HTTPException(400, "호스트 키 지문 형식이 맞지 않아요. 연결 확인을 다시 해 주세요.")
    return m.Host(name=name, ip=ip, port=int(port), ssh_user=user, grp=group, host_fingerprint=fp or None)


@router.post("/inventory/{inv_id}/hosts", dependencies=[Depends(require("resources"))])
def add_host(inv_id: str, body: HostIn, db: Session = Depends(get_db)):
    """Add a server to an inventory; it deploys as the inventory's user with the inventory's key."""
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    h = new_host(inv, body.name, body.ip, body.port, body.user or inv.ssh_user, body.group, body.fingerprint)
    inv.hosts.append(h)
    s.log_act(db, "서버 추가", f"{inv.name} · {h.name} ({h.ip})")
    db.commit()
    return h.to_dict()


class InitHostIn(BaseModel):
    name: str = ""
    ip: str
    port: str = "22"
    group: str = ""
    fingerprint: str  # the host key the person confirmed; the password is sent only to this server
    account: str  # an account the server already has; root is fine here, it is used once and not kept
    password: str
    fullSudo: bool = False  # for playbooks with become: true


MAX_INIT_PASSWORD = 1024


@router.post("/inventory/{inv_id}/hosts/init", dependencies=[Depends(require("resources")), Depends(require_sudo)])
async def init_host(inv_id: str, body: InitHostIn, db: Session = Depends(get_db)):
    """Set up a new server with its first account and password, then add it. The password is never stored."""
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    h = new_host(inv, body.name, body.ip, body.port, inv.ssh_user, body.group, body.fingerprint)  # also checks the fingerprint's format
    if not h.host_fingerprint:
        raise HTTPException(400, "서버의 호스트 키 지문을 먼저 확인해 주세요.")
    account = body.account.strip()
    if not USER_RE.match(account):
        raise HTTPException(400, "서버에 이미 있는 계정 이름을 넣어 주세요. 예: ubuntu")
    if not 1 <= len(body.password) <= MAX_INIT_PASSWORD:
        raise HTTPException(400, f"비밀번호를 1~{MAX_INIT_PASSWORD}자로 넣어 주세요.")
    key = db.scalar(select(m.Key).where(m.Key.name == inv.key, m.Key.kind == "ssh"))
    if not key or not key.public_key:
        raise HTTPException(400, f"인벤토리의 SSH 키 {inv.key}를 찾을 수 없어요.")
    line = sshaccess.authorized_keys_line(key.public_key, sshaccess.get_addresses(db))
    r = await serverinit.init_server(h.ip, h.port, h.host_fingerprint, account, body.password, inv.ssh_user, line,
                                     key.get_secret() or "", body.fullSudo)
    if r["ok"]:
        inv.hosts.append(h)
    s.log_act(db, "서버 초기화", f"{inv.name} · {h.name} ({h.ip}) · 계정 {account}", "ok" if r["ok"] else "warn")
    db.commit()
    return {**r, "host": h.to_dict() if r["ok"] else None}


@router.post("/inventory/{inv_id}/ping", dependencies=[Depends(require("resources"))])
async def ping(inv_id: str, db: Session = Depends(get_db)):
    """Connect to every server with the inventory's key: answering servers are on, others off (deploys skip them).

    A server whose host key differs from the pinned one is marked changed and blocked until someone approves the new key.
    """
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    key = db.scalar(select(m.Key).where(m.Key.name == inv.key, m.Key.kind == "ssh"))
    private = (key.get_secret() if key else None) or ""
    results = await asyncio.gather(*(sshcheck.check(h.ip, h.port, h.ssh_user, private) for h in inv.hosts))
    out = []
    for h, r in zip(inv.hosts, results):
        changed = bool(h.host_fingerprint and r["fingerprint"] and r["fingerprint"] != h.host_fingerprint)
        if changed:
            h.host_key = "changed"
        elif r["login"] and not h.host_fingerprint:
            h.host_fingerprint = r["fingerprint"]  # first contact: pin it
        h.status = "on" if r["login"] and not changed else "off"
        error = "호스트 키가 저장된 값과 달라요" if changed else r["error"]
        out.append({"name": h.name, "ok": h.status == "on", "error": error})
    ok = sum(1 for x in out if x["ok"])
    s.log_act(db, "연결 테스트", f"{inv.name} · {len(out)}대 중 {ok}대 응답", "ok" if ok == len(out) else "warn")
    db.commit()
    return {"total": len(out), "ok": ok, "hosts": out}


@router.delete("/inventory/{inv_id}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def delete_inventory(inv_id: str, db: Session = Depends(get_db)):
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    users = list(db.scalars(select(m.Job.name).where(m.Job.inventory == inv.name).order_by(m.Job.name)))
    if users:
        names = ", ".join(users[:3]) + (f" 외 {len(users) - 3}개" if len(users) > 3 else "")
        raise HTTPException(400, f"배포 작업 {len(users)}개에서 쓰고 있어 지울 수 없어요: {names}")
    key = db.scalar(select(m.Key).where(m.Key.name == inv.key))
    if key and key.used_count:
        key.used_count -= 1
    s.log_act(db, "인벤토리 삭제", f"{inv.name} · 서버 {len(inv.hosts)}대", "warn")
    db.delete(inv)
    db.commit()
    return {"ok": True}


@router.delete("/inventory/{inv_id}/hosts/{ix}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def delete_host(inv_id: str, ix: int, db: Session = Depends(get_db)):
    inv = db.get(m.Inventory, inv_id)
    if not inv or not (0 <= ix < len(inv.hosts)):
        raise HTTPException(404, "서버를 찾을 수 없어요.")
    h = inv.hosts[ix]
    s.log_act(db, "서버 삭제", f"{inv.name} · {h.name} ({h.ip})", "warn")
    inv.hosts.remove(h)  # delete-orphan removes the row
    db.commit()
    return {"ok": True}


@router.post("/inventory/{inv_id}/hosts/{ix}/accept-key", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def accept_host_key(inv_id: str, ix: int, db: Session = Depends(get_db)):
    inv = db.get(m.Inventory, inv_id)
    if not inv or not (0 <= ix < len(inv.hosts)):
        raise HTTPException(404, "서버를 찾을 수 없어요.")
    h = inv.hosts[ix]
    h.host_key = "ok"
    h.host_fingerprint = None  # the next deploy pins the server's new key
    s.log_act(db, "호스트 키 변경 승인", f"{h.name} ({h.ip})", "warn")
    db.commit()
    return h.to_dict()


# ---------- key store ----------

@router.get("/keys")
def list_keys(db: Session = Depends(get_db)):
    """Each SSH key lists the inventories that use it; one key on 2+ inventories is flagged (keep a key per environment)."""
    used: dict[str, list[str]] = {}
    for inv in db.scalars(select(m.Inventory).order_by(m.Inventory.ord)):
        used.setdefault(inv.key, []).append(inv.name)
    out = []
    for k in db.scalars(select(m.Key).order_by(m.Key.ord)):
        invs = used.get(k.name, []) if k.kind == "ssh" else []
        out.append({**k.to_dict(), "inventories": invs, "sharedAcrossInventories": len(invs) > 1})
    return out


# ---------- where Wharfline connects from (authorized_keys from="…") ----------
# Registered before the /keys/{key_id} routes so "access-from" is never read as a key id.

class AccessFromIn(BaseModel):
    addresses: list[str]


@router.get("/keys/access-from")
def get_access_from(db: Session = Depends(get_db)):
    me = s.current_member(db)
    return {"addresses": sshaccess.get_addresses(db), "canEdit": bool(me and me.role in ("Owner", "Admin"))}


@router.put("/keys/access-from")
def put_access_from(body: AccessFromIn, db: Session = Depends(get_db)):
    me = s.current_member(db)
    if not me or me.role not in ("Owner", "Admin"):
        raise HTTPException(403, "이 작업을 할 권한이 없어요.")
    try:
        addresses = sshaccess.normalize(body.addresses)
    except sshaccess.AddressError as e:
        raise HTTPException(400, str(e)) from e
    sshaccess.set_addresses(db, addresses)
    s.log_act(db, "접속 허용 주소 변경", ", ".join(addresses) or "비움", "ok" if addresses else "warn")
    db.commit()
    return {"addresses": addresses, "canEdit": True}


class KeyIn(BaseModel):
    mode: str = Field(pattern="^(gen|paste|token)$")
    name: str
    privateKey: str = ""
    passphrase: str = ""
    user: str = ""
    token: str = ""


@router.post("/keys", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def add_key(body: KeyIn, db: Session = Depends(get_db)):
    name = body.name.strip() or "new-key"
    if not NAME_RE.match(name):
        raise HTTPException(400, "키 이름은 영문, 숫자, . _ - 로 넣어 주세요.")
    if db.scalar(select(m.Key).where(m.Key.name == name)):
        raise HTTPException(400, "같은 이름의 키가 있어요.")
    k = m.Key(id=s.new_id("k"), name=name, created_by=s.actor_name(db), created_at=time.strftime("%Y-%m-%d"), last_used="사용 안 함", used_count=0)
    if body.mode == "token":
        tok = body.token.strip()
        if len(tok) < 8:
            raise HTTPException(400, "토큰을 넣어 주세요.")
        k.kind, k.type, k.fingerprint = "token", "토큰", f"{body.user.strip() or '-'} · ••••{tok[-4:]}"
        k.set_secret(tok)
        action = "액세스 토큰 추가"
    else:
        try:
            ssh = sshkeys.generate(f"{name}@wharfline") if body.mode == "gen" else sshkeys.load_private(body.privateKey, body.passphrase or None, f"{name}@wharfline")
        except sshkeys.SshKeyError as e:
            raise HTTPException(400, str(e)) from e
        k.kind, k.type, k.fingerprint, k.public_key = "ssh", ssh.type, ssh.fingerprint, ssh.public_line
        k.set_secret(ssh.private_openssh)  # envelope-encrypted; there is no API that returns it
        action = "SSH 키 추가"
    db.add(k)
    s.log_act(db, action, name)
    db.commit()
    return {**k.to_dict(), "publicKey": k.public_key}


@router.get("/keys/{key_id}/public")
def public_key(key_id: str, db: Session = Depends(get_db)):
    k = db.get(m.Key, key_id)
    if not k or k.kind != "ssh" or not k.public_key:
        raise HTTPException(404, "공개 키가 없는 키예요.")
    addresses = sshaccess.get_addresses(db)
    return {"publicKey": k.public_key, "authorizedKeysLine": sshaccess.authorized_keys_line(k.public_key, addresses),
            "restricted": bool(addresses), "accessFrom": addresses}


@router.delete("/keys/{key_id}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def delete_key(key_id: str, db: Session = Depends(get_db)):
    k = db.get(m.Key, key_id)
    if not k:
        raise HTTPException(404, "키를 찾을 수 없어요.")
    if k.used_count:
        where = "레포" if k.kind == "token" else "인벤토리·레포"
        raise HTTPException(400, f"{where} {k.used_count}곳에서 쓰고 있어 지울 수 없어요")
    db.delete(k)
    s.log_act(db, "SSH 키 삭제", k.name, "warn")
    db.commit()
    return {"ok": True}
