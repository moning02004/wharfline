import asyncio
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import agentinstall, agentproto
from .. import models as m
from .. import serverinit, sshaccess, sshcheck, sshkeys
from .. import store as s
from ..agenthub import HUB, AgentError
from ..db import SessionLocal, get_db
from ..deps import require, require_login, require_sudo, viewer

router = APIRouter(prefix="/api", tags=["resources"], dependencies=[Depends(require_login)])

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ·-]{0,63}$")


# ---------- registries & images ----------

@router.get("/registries")
def list_registries(db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    images = list(db.scalars(select(m.Image).order_by(m.Image.ord)))
    jobs = [j for j in db.scalars(select(m.Job).order_by(m.Job.ord)) if s.can_see_job(who, j)]  # hidden jobs aren't named
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
def list_repos(db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    """Repos are created when a job is saved. The built-in playbook repo is always listed first."""
    s.builtin_repo(db)
    db.commit()
    jobs = [j for j in db.scalars(select(m.Job).order_by(m.Job.ord)) if s.can_see_job(who, j)]  # hidden jobs aren't named
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
    key: str = ""  # only for servers still deployed over SSH; agent servers need none
    user: str = "deploy"
    host: FirstHostIn | None = None  # the first server, checked with the connection check before this call


@router.post("/inventory", dependencies=[Depends(require("resources"))])
def add_inventory(body: InventoryIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
        raise HTTPException(400, "인벤토리 이름은 production처럼 영문 소문자, 숫자, -, _ 로 넣어 주세요.")
    if db.scalar(select(m.Inventory).where(m.Inventory.name == name)):
        raise HTTPException(400, "같은 이름의 인벤토리가 있어요.")
    key = db.scalar(select(m.Key).where(m.Key.name == body.key, m.Key.kind == "ssh")) if body.key.strip() else None
    if body.key.strip() and not key:
        raise HTTPException(400, f"SSH 키 {body.key}를 찾을 수 없어요.")
    user = check_ssh_user(body.user or "deploy")
    inv = m.Inventory(id=s.new_id("i"), name=name, key=key.name if key else "", ssh_user=user)
    if body.host:
        h = body.host
        inv.hosts.append(new_host(inv, h.name, h.ip, h.port, user, h.group, h.fingerprint))
    if key:
        key.used_count += 1
    db.add(inv)
    s.log_act(db, "인벤토리 생성", f"{name} · {user}" + (f" · 키 {key.name}" if key else "") + (f" · 서버 {body.host.name.strip()}" if body.host else ""))
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
    fullSudo: bool = False  # password-less sudo for the inventory's account (playbooks with become: true)
    users: str = ""  # accounts the agent may run as; the inventory's account always comes first
    paths: str = agentinstall.DEFAULT_PATHS  # folders the agent may write to


MAX_INIT_PASSWORD = 1024


def agent_policy(inv: m.Inventory, users: str, paths: str) -> tuple[str, str]:
    """(users, paths) for a new agent: the inventory's account first, then any others asked for."""
    try:
        return agentinstall.clean_users(",".join([inv.ssh_user, users])), agentinstall.clean_paths(paths)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


def new_token(db: Session, h: m.Host) -> str:
    token, digest = agentproto.new_token()
    db.add(m.EnrollToken(token_hash=digest, host_id=h.id, expires_at=time.time() + agentproto.ENROLL_TTL,
                         created_by=s.actor_name(db)))
    return token


def enrolled_check(host_id: int, before: str | None):
    """An `enrolled(timeout)` for serverinit: True once the server's agent has (re-)enrolled and is polling."""
    async def wait(timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with SessionLocal() as db:
                h = db.get(m.Host, host_id)
                if h and h.agent_id and h.agent_id != before and HUB.online(host_id):
                    return True
            await asyncio.sleep(1)
        return False
    return wait


def simulate_enroll(db: Session, h: m.Host, users: str, paths: str) -> None:
    """Tests and demos (WHARFLINE_SSH_SIMULATE=1): the server looks like it has an agent."""
    h.agent_id, h.agent_version, h.agent_seen, h.status = agentproto.new_agent_id(), "simulated", time.time(), "on"
    h.agent_info = {"hostname": h.name, "policy": {"users": users.split(","), "paths": paths.split(",")}, "sudo": {}}


@router.post("/inventory/{inv_id}/hosts/init", dependencies=[Depends(require("resources")), Depends(require_sudo)])
async def init_host(inv_id: str, body: InitHostIn, db: Session = Depends(get_db)):
    """Set up a new server with its first account and password and start its agent. The password is never stored."""
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
    users, paths = agent_policy(inv, body.users, body.paths)
    url = agent_url_of(db)
    if not url:
        raise HTTPException(400, "에이전트가 접속할 Wharfline 주소를 먼저 정해 주세요 (서버 관리 → 에이전트 접속 주소).")
    h.status = "pending"
    inv.hosts.append(h)
    db.flush()
    token = new_token(db, h)
    db.commit()
    host_id = h.id
    r = await serverinit.init_server(h.ip, h.port, h.host_fingerprint, account, body.password, token, users, paths, body.fullSudo,
                                     url, agentinstall.agent_image(), enrolled_check(host_id, None))
    db.expire_all()
    h = db.get(m.Host, host_id)
    if r["ok"] and serverinit.sshcheck.simulated() and h and not h.agent_id:
        simulate_enroll(db, h, users, paths)
    if not r["ok"] and h and not h.agent_id:
        inv.hosts.remove(h)  # nothing half-made stays behind
        h = None
    s.log_act(db, "서버 초기화", f"{inv.name} · {body.name or body.ip} ({body.ip}) · 계정 {account} · 실행 계정 {users}", "ok" if r["ok"] else "warn")
    db.commit()
    return {**r, "host": h.to_dict() if r["ok"] and h else None}


class PendingHostIn(BaseModel):
    name: str
    group: str = ""
    users: str = ""
    paths: str = agentinstall.DEFAULT_PATHS


def install_command(db: Session, token: str, users: str, paths: str) -> str:
    url = agent_url_of(db)
    return f"curl -fsSL {url}/api/agent/install.sh | sudo sh -s -- {token} {users} {paths}"


@router.post("/inventory/{inv_id}/hosts/pending", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def add_pending_host(inv_id: str, body: PendingHostIn, db: Session = Depends(get_db)):
    """A server Wharfline can't SSH into: it shows up once someone runs the install command on it."""
    inv = _inv_or_404(db, inv_id)
    name, group = body.name.strip(), body.group.strip() or "default"
    if not name or len(name) > 128 or any(h.name == name for h in inv.hosts):
        raise HTTPException(400, "서버 이름이 비었거나 이 인벤토리에 이미 있어요.")
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", group):
        raise HTTPException(400, "그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.")
    if not agent_url_of(db):
        raise HTTPException(400, "에이전트가 접속할 Wharfline 주소를 먼저 정해 주세요 (서버 관리 → 에이전트 접속 주소).")
    users, paths = agent_policy(inv, body.users, body.paths)
    h = m.Host(name=name, ip="", port=22, ssh_user=inv.ssh_user, grp=group, status="pending")
    inv.hosts.append(h)
    db.flush()
    token = new_token(db, h)
    s.log_act(db, "서버 추가 (설치 명령)", f"{inv.name} · {name} · 실행 계정 {users}")
    db.commit()
    return {"host": h.to_dict(), "command": install_command(db, token, users, paths), "expiresIn": agentproto.ENROLL_TTL}


class AgentTokenIn(BaseModel):
    users: str = ""
    paths: str = agentinstall.DEFAULT_PATHS


@router.post("/inventory/{inv_id}/hosts/{ix}/agent-token", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def agent_token(inv_id: str, ix: int, body: AgentTokenIn, db: Session = Depends(get_db)):
    """A new install command for this server (first install, re-install, or after the server was rebuilt)."""
    inv = _inv_or_404(db, inv_id)
    h = _host_or_404(inv, ix)
    users, paths = agent_policy(inv, body.users, body.paths)
    token = new_token(db, h)
    s.log_act(db, "에이전트 설치 명령 발급", f"{inv.name} · {h.name}")
    db.commit()
    return {"command": install_command(db, token, users, paths), "expiresIn": agentproto.ENROLL_TTL}


class ConvertIn(BaseModel):
    users: str = ""
    paths: str = agentinstall.DEFAULT_PATHS


@router.post("/inventory/{inv_id}/hosts/{ix}/convert", dependencies=[Depends(require("resources")), Depends(require_sudo)])
async def convert_host(inv_id: str, ix: int, body: ConvertIn, db: Session = Depends(get_db)):
    """Move a server that deploys over SSH to an agent: one last SSH login with the inventory's key starts it."""
    inv = _inv_or_404(db, inv_id)
    h = _host_or_404(inv, ix)
    if h.agent_id:
        raise HTTPException(400, "이미 에이전트로 배포하는 서버예요.")
    key = db.scalar(select(m.Key).where(m.Key.name == inv.key, m.Key.kind == "ssh")) if inv.key else None
    if not key or not key.has_secret:
        raise HTTPException(400, "이 인벤토리에 SSH 키가 없어요. '설치 명령'으로 서버에서 직접 설치해 주세요.")
    if not agent_url_of(db):
        raise HTTPException(400, "에이전트가 접속할 Wharfline 주소를 먼저 정해 주세요 (서버 관리 → 에이전트 접속 주소).")
    users, paths = agent_policy(inv, body.users, body.paths)
    token = new_token(db, h)
    db.commit()
    host_id = h.id
    r = await serverinit.convert_server(h.ip, h.port, h.host_fingerprint, h.ssh_user, key.get_secret() or "", token, users, paths,
                                        agent_url_of(db), agentinstall.agent_image(), enrolled_check(host_id, None))
    db.expire_all()
    h = db.get(m.Host, host_id)
    if r["ok"] and serverinit.sshcheck.simulated() and h and not h.agent_id:
        simulate_enroll(db, h, users, paths)
    s.log_act(db, "에이전트로 전환", f"{inv.name} · {h.name if h else host_id} · {'성공' if r['ok'] else '실패'}", "ok" if r["ok"] else "warn")
    db.commit()
    return {**r, "host": h.to_dict() if h else None}


class SudoIn(BaseModel):
    user: str
    enable: bool


@router.put("/inventory/{inv_id}/hosts/{ix}/sudo", dependencies=[Depends(require("resources")), Depends(require_sudo)])
async def set_sudo(inv_id: str, ix: int, body: SudoIn, db: Session = Depends(get_db)):
    """Give or take password-less sudo for one of the agent's accounts (playbooks with become: true need it)."""
    inv = _inv_or_404(db, inv_id)
    h = _host_or_404(inv, ix)
    if not h.agent_id:
        raise HTTPException(400, "에이전트가 있는 서버에서만 바꿀 수 있어요.")
    user = check_ssh_user(body.user)
    if serverinit.sshcheck.simulated():
        result = {"ok": True, "sudo": {**((h.agent_info or {}).get("sudo") or {}), user: body.enable}}
    else:
        try:
            result = await HUB.call(h.id, {"op": "sudo", "user": user, "enable": body.enable}, 60)
        except AgentError as e:
            raise HTTPException(400, f"{h.name}: {e}") from e
    if not result.get("ok"):
        raise HTTPException(400, f"{h.name}: {result.get('error') or 'sudo 설정을 바꾸지 못했어요'}")
    h.agent_info = {**(h.agent_info or {}), "sudo": result.get("sudo") or {}}
    s.log_act(db, "sudo 권한 " + ("부여" if body.enable else "회수"), f"{inv.name} · {h.name} · {user}", "warn" if body.enable else "ok")
    db.commit()
    return h.to_dict()


@router.post("/inventory/{inv_id}/hosts/{ix}/agent-update", dependencies=[Depends(require("resources")), Depends(require_sudo)])
async def update_agent(inv_id: str, ix: int, db: Session = Depends(get_db)):
    """Swap the agent for Wharfline's current agent image (it pulls the image and replaces its own container)."""
    inv = _inv_or_404(db, inv_id)
    h = _host_or_404(inv, ix)
    if not h.agent_id:
        raise HTTPException(400, "에이전트가 있는 서버에서만 업데이트할 수 있어요.")
    image = agentinstall.agent_image()
    try:
        result = await HUB.call(h.id, {"op": "update", "image": image}, 600)
    except AgentError as e:
        raise HTTPException(400, f"{h.name}: {e}") from e
    if not result.get("ok"):
        raise HTTPException(400, f"{h.name}: {result.get('error') or '업데이트하지 못했어요'}")
    s.log_act(db, "에이전트 업데이트", f"{inv.name} · {h.name} → {image}")
    db.commit()
    return {"ok": True, "image": image}


# ---------- where agents reach Wharfline ----------

def agent_url_of(db: Session) -> str:
    from .agent import agent_url
    return agent_url(db)


class AgentSettingsIn(BaseModel):
    url: str


@router.get("/agent-settings")
def get_agent_settings(db: Session = Depends(get_db)):
    return {"url": agent_url_of(db), "saved": s.get_setting(db, "agent").get("url") or "", "image": agentinstall.agent_image()}


@router.put("/agent-settings", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def put_agent_settings(body: AgentSettingsIn, db: Session = Depends(get_db)):
    url = body.url.strip().rstrip("/")
    if url and not re.match(r"^https?://[A-Za-z0-9.\-\[\]:]+(/[A-Za-z0-9._~/-]*)?$", url):
        raise HTTPException(400, "주소는 https://deploy.example.com 처럼 적어 주세요.")
    s.set_setting(db, "agent", url=url)
    s.log_act(db, "에이전트 접속 주소 변경", url or "기본값")
    db.commit()
    return {"url": agent_url_of(db), "saved": url, "image": agentinstall.agent_image()}


@router.post("/inventory/{inv_id}/ping", dependencies=[Depends(require("resources"))])
async def ping(inv_id: str, db: Session = Depends(get_db)):
    """Agent servers: is the agent connected now. Servers still on SSH: log in with the inventory's key.

    A server whose host key differs from the pinned one is marked changed and blocked until someone approves the new key.
    """
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    key = db.scalar(select(m.Key).where(m.Key.name == inv.key, m.Key.kind == "ssh")) if inv.key else None
    private = (key.get_secret() if key else None) or ""
    ssh_hosts = [h for h in inv.hosts if not h.agent_id and h.status != "pending"]
    results = dict(zip((h.id for h in ssh_hosts), await asyncio.gather(*(sshcheck.check(h.ip, h.port, h.ssh_user, private) for h in ssh_hosts))))
    out = []
    for h in inv.hosts:
        if h.status == "pending":
            out.append({"name": h.name, "ok": False, "error": "에이전트 등록을 기다리는 중이에요"})
            continue
        if h.agent_id:
            online = HUB.online(h.id) or h.agent_version == "simulated"
            seen = f"마지막 연결 {time.strftime('%m-%d %H:%M', time.localtime(h.agent_seen))}" if h.agent_seen else "연결된 적 없음"
            out.append({"name": h.name, "ok": online, "error": None if online else f"에이전트가 연결돼 있지 않아요 ({seen})"})
            continue
        r = results[h.id]
        changed = bool(h.host_fingerprint and r["fingerprint"] and r["fingerprint"] != h.host_fingerprint)
        if changed:
            h.host_key = "changed"
        elif r["login"] and not h.host_fingerprint:
            h.host_fingerprint = r["fingerprint"]  # first contact: pin it
        h.status = "on" if r["login"] and not changed else "off"
        error = "호스트 키가 저장된 값과 달라요" if changed else r["error"]
        out.append({"name": h.name, "ok": h.status == "on",
                    "error": (error + " · 에이전트로 전환하면 키 없이 배포해요") if error else None})
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
    s.log_act(db, "서버 삭제", f"{inv.name} · {h.name} ({h.ip})" + (" · 서버의 wharfline-agent 컨테이너는 직접 지워 주세요" if h.agent_id else ""), "warn")
    HUB.kick(h.id)
    inv.hosts.remove(h)  # delete-orphan removes the row
    db.commit()
    return {"ok": True}


# ---------- editing inventories and servers ----------
# Only what can't break logins changes freely (names, groups). A new deploy user or key, or moving a server to an
# inventory with another user or key, is applied only after every affected server accepts the login.

def _inv_or_404(db: Session, inv_id: str) -> m.Inventory:
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    return inv


def _host_or_404(inv: m.Inventory, ix: int) -> m.Host:
    if not 0 <= ix < len(inv.hosts):
        raise HTTPException(404, "서버를 찾을 수 없어요.")
    return inv.hosts[ix]


def _names(items: list[str]) -> str:
    return ", ".join(items[:3]) + (f" 외 {len(items) - 3}개" if len(items) > 3 else "")


def _left_without_servers(db: Session, inv: m.Inventory, host: m.Host, new_group: str | None) -> list[str]:
    """Jobs that would have no server left if `host` moved to `new_group` (None: left the inventory)."""
    others = [h for h in inv.hosts if h is not host]
    groups_after = {h.grp for h in others} | ({new_group} if new_group else set())
    out = []
    for j in db.scalars(select(m.Job).where(m.Job.inventory == inv.name).order_by(m.Job.name)):
        targets = list(j.targets or [])
        if targets and host.grp in targets and not set(targets) & groups_after:
            out.append(j.name)
        elif not targets and new_group is None and not others:
            out.append(j.name)
    return out


def _busy_jobs(db: Session, inv: m.Inventory) -> list[str]:
    """Jobs on this inventory with a run going or waiting for approval."""
    ids = list(db.scalars(select(m.Job.id).where(m.Job.inventory == inv.name)))
    if not ids:
        return []
    return sorted(set(db.scalars(select(m.Run.job).where(m.Run.job_id.in_(ids), m.Run.status.in_(("run", "approval"))))))


def agent_user_problem(h: m.Host, user: str) -> str | None:
    users = ((h.agent_info or {}).get("policy") or {}).get("users") or []
    if users and user not in users:
        return f"{h.name}: 에이전트가 계정 {user}을(를) 허용하지 않아요 (허용: {', '.join(users)}). 서버에서 WHARFLINE_ALLOWED_USERS에 더해 주세요"
    return None


async def _logins_ok(hosts: list[m.Host], user: str, key: m.Key | None) -> list[str]:
    """Agent servers must allow `user`; servers still on SSH must log in as `user` with `key` (pinned host key)."""
    bad = [p for h in hosts if h.agent_id and (p := agent_user_problem(h, user))]
    ssh = [h for h in hosts if not h.agent_id and h.status != "pending"]
    if not ssh:
        return bad
    if key is None:
        return bad + [f"{h.name}: SSH로 배포하는 서버라 SSH 키가 필요해요 (에이전트로 전환하면 필요 없어요)" for h in ssh]
    private = key.get_secret() or ""
    results = await asyncio.gather(*(sshcheck.check(h.ip, h.port, user, private) for h in ssh))
    for h, r in zip(ssh, results):
        if h.host_fingerprint and r.get("fingerprint") and r["fingerprint"] != h.host_fingerprint:
            bad.append(f"{h.name}: 호스트 키가 저장된 값과 달라요")
        elif not r.get("login"):
            bad.append(f"{h.name}: {r.get('error') or '로그인하지 못했어요'}")
    return bad


class HostEditIn(BaseModel):
    name: str
    group: str


@router.put("/inventory/{inv_id}/hosts/{ix}", dependencies=[Depends(require("resources"))])
def edit_host(inv_id: str, ix: int, body: HostEditIn, db: Session = Depends(get_db)):
    """A server's name and group. The address, port and user stay: changing them is a different server."""
    inv = _inv_or_404(db, inv_id)
    h = _host_or_404(inv, ix)
    name, group = body.name.strip() or h.ip, body.group.strip() or "default"
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", group):
        raise HTTPException(400, "그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.")
    if len(name) > 128 or any(o.name == name for o in inv.hosts if o is not h):
        raise HTTPException(400, "서버 이름이 너무 길거나 이 인벤토리에 이미 있어요.")
    if group != h.grp and (left := _left_without_servers(db, inv, h, group)):
        raise HTTPException(400, f"{h.grp} 그룹의 마지막 서버라 바꿀 수 없어요. 이 그룹에 배포하는 작업: {_names(left)}")
    before = f"{h.name}/{h.grp}"
    h.name, h.grp = name, group
    s.log_act(db, "서버 수정", f"{inv.name} · {before} → {name}/{group}")
    db.commit()
    return h.to_dict()


class InventoryEditIn(BaseModel):
    name: str
    user: str
    key: str = ""


@router.put("/inventory/{inv_id}", dependencies=[Depends(require("resources")), Depends(require_sudo)])
async def edit_inventory(inv_id: str, body: InventoryEditIn, db: Session = Depends(get_db)):
    """Rename (jobs follow), or switch the deploy user or SSH key once every server accepts the new login."""
    inv = _inv_or_404(db, inv_id)
    name = body.name.strip()
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
        raise HTTPException(400, "인벤토리 이름은 production처럼 영문 소문자, 숫자, -, _ 로 넣어 주세요.")
    if name != inv.name and db.scalar(select(m.Inventory).where(m.Inventory.name == name)):
        raise HTTPException(400, "같은 이름의 인벤토리가 있어요.")
    user = check_ssh_user(body.user)
    key = db.scalar(select(m.Key).where(m.Key.name == body.key, m.Key.kind == "ssh")) if body.key.strip() else None
    if body.key.strip() and not key:
        raise HTTPException(400, f"SSH 키 {body.key}를 찾을 수 없어요.")
    key_name = key.name if key else ""
    login_changes = user != inv.ssh_user or key_name != inv.key or any(h.ssh_user != user for h in inv.hosts)
    if (name != inv.name or login_changes) and (busy := _busy_jobs(db, inv)):
        raise HTTPException(400, f"이 인벤토리로 배포 중이거나 승인을 기다리는 작업이 있어요: {_names(busy)}. 끝난 뒤에 바꿔 주세요.")
    if login_changes and inv.hosts and (bad := await _logins_ok(inv.hosts, user, key)):
        raise HTTPException(400, f"새 사용자·키로 접속하지 못한 서버가 있어 바꾸지 않았어요. {' / '.join(bad)}")
    changes = []
    if name != inv.name:
        for j in db.scalars(select(m.Job).where(m.Job.inventory == inv.name)):
            j.inventory = name
        changes.append(f"이름 {inv.name} → {name}")
        inv.name = name
    if user != inv.ssh_user:
        changes.append(f"사용자 {inv.ssh_user} → {user}")
        inv.ssh_user = user
    for h in inv.hosts:
        h.ssh_user = user
    if key_name != inv.key:
        old = db.scalar(select(m.Key).where(m.Key.name == inv.key)) if inv.key else None
        if old and old.used_count:
            old.used_count -= 1
        if key:
            key.used_count += 1
        changes.append(f"키 {inv.key or '없음'} → {key_name or '없음'}")
        inv.key = key_name
    if changes:
        s.log_act(db, "인벤토리 수정", f"{inv.name} · " + " · ".join(changes), "warn" if login_changes else "ok")
    db.commit()
    return inv.to_dict()


class HostMoveIn(BaseModel):
    to: str  # inventory id


def _move_parts(db: Session, inv_id: str, ix: int, to: str) -> tuple[m.Inventory, m.Host, m.Inventory]:
    src = _inv_or_404(db, inv_id)
    h = _host_or_404(src, ix)
    dst = _inv_or_404(db, to)
    if dst.id == src.id:
        raise HTTPException(400, "같은 인벤토리예요.")
    return src, h, dst


def _move_checks(db: Session, src: m.Inventory, h: m.Host, dst: m.Inventory) -> list[dict]:
    """The quick checks before a move, each {key, label, ok, detail}. The login check is separate (slow)."""
    clash = any(o.name == h.name for o in dst.hosts)
    left = _left_without_servers(db, src, h, None)
    busy = sorted(set(_busy_jobs(db, src)) | set(_busy_jobs(db, dst)))
    return [
        {"key": "name", "label": "같은 이름의 서버", "ok": not clash,
         "detail": f"{dst.name}에 {h.name} 서버가 이미 있어요. 한쪽 이름을 바꿔 주세요." if clash else f"{dst.name}에 {h.name}이(가) 없어요."},
        {"key": "jobs", "label": "배포 작업 영향", "ok": not left,
         "detail": f"옮기면 서버가 없어지는 작업이 있어요: {_names(left)}. 작업의 대상을 바꾸거나 서버를 먼저 추가해 주세요." if left
         else "옮겨도 서버가 비는 배포 작업이 없어요."},
        {"key": "busy", "label": "진행 중인 배포", "ok": not busy,
         "detail": f"배포 중이거나 승인을 기다리는 작업이 있어요: {_names(busy)}. 끝난 뒤에 다시 해 주세요." if busy
         else "배포 중이거나 승인을 기다리는 작업이 없어요."},
    ]


async def _move_login(db: Session, h: m.Host, dst: m.Inventory) -> dict:
    """Can the server log in with the target inventory's user and key (and show its pinned host key)?"""
    if h.agent_id or h.status == "pending":
        bad = await _logins_ok([h], dst.ssh_user, None)
        return {"key": "login", "label": "서버 계정", "ok": not bad,
                "detail": bad[0].split(": ", 1)[-1] if bad else f"에이전트가 계정 {dst.ssh_user}을(를) 허용해요."}
    key = db.scalar(select(m.Key).where(m.Key.name == dst.key, m.Key.kind == "ssh")) if dst.key else None
    if not key:
        return {"key": "login", "label": "서버 연결", "ok": False, "detail": f"{dst.name}에 SSH 키가 없어요. 이 서버를 먼저 에이전트로 전환해 주세요."}
    bad = await _logins_ok([h], dst.ssh_user, key)
    return {"key": "login", "label": "서버 연결", "ok": not bad,
            "detail": bad[0].split(": ", 1)[-1] + f" ({dst.ssh_user} · 키 {dst.key})" if bad else f"{dst.ssh_user}@{h.ip} 로그인돼요 (키 {dst.key})."}


@router.post("/inventory/{inv_id}/hosts/{ix}/move/check", dependencies=[Depends(require("resources"))])
def move_host_check(inv_id: str, ix: int, body: HostMoveIn, db: Session = Depends(get_db)):
    src, h, dst = _move_parts(db, inv_id, ix, body.to)
    return {"checks": _move_checks(db, src, h, dst)}


@router.post("/inventory/{inv_id}/hosts/{ix}/move/login", dependencies=[Depends(require("resources"))])
async def move_host_login(inv_id: str, ix: int, body: HostMoveIn, db: Session = Depends(get_db)):
    _, h, dst = _move_parts(db, inv_id, ix, body.to)
    return await _move_login(db, h, dst)


@router.post("/inventory/{inv_id}/hosts/{ix}/move", dependencies=[Depends(require("resources"))])
async def move_host(inv_id: str, ix: int, body: HostMoveIn, db: Session = Depends(get_db)):
    """Move a server to another inventory once every check passes; it must log in with the target's user and key."""
    src, h, dst = _move_parts(db, inv_id, ix, body.to)
    failed = [c for c in _move_checks(db, src, h, dst) if not c["ok"]]
    if not failed:
        login = await _move_login(db, h, dst)
        if not login["ok"]:
            failed.append(login)
    if failed:
        raise HTTPException(400, f"옮기지 않았어요. {failed[0]['detail']}")
    h.ssh_user = dst.ssh_user
    h.inventory = dst  # back_populates moves it between the two lists; the row stays (not an orphan)
    s.log_act(db, "서버 이동", f"{h.name} ({h.ip}) · {src.name} → {dst.name}")
    db.commit()
    return {"ok": True, "host": h.to_dict()}


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
