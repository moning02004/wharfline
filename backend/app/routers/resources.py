import asyncio
import re
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .. import sshkeys
from .. import store as s
from ..db import get_db
from ..deps import require_login, require_sudo

router = APIRouter(prefix="/api", tags=["resources"], dependencies=[Depends(require_login)])

LOCAL_ROOT = "/var/lib/wharfline/playbooks/"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ·-]{0,63}$")
IMAGE_RE = re.compile(r"^[a-z0-9.-]+(:\d+)?(/[a-z0-9._-]+)+$")
TAG_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$")


# ---------- registries & images ----------

@router.get("/registries")
def list_registries(db: Session = Depends(get_db)):
    images = list(db.scalars(select(m.Image).order_by(m.Image.ord)))
    jobs = list(db.scalars(select(m.Job).order_by(m.Job.ord)))
    return {
        "registries": [{**r.to_dict(), "imageCount": sum(1 for i in images if i.registry_id == r.id)}
                       for r in db.scalars(select(m.Registry).order_by(m.Registry.ord))],
        "images": [{**i.to_dict(), "usedBy": [j.name for j in jobs if j.image == i.ref]} for i in images],
    }


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


@router.post("/registries", dependencies=[Depends(require_sudo)])
def add_registry(body: RegistryIn, db: Session = Depends(get_db)):
    host = body.host.strip().lower().removeprefix("https://").rstrip("/")
    if not re.match(r"^[a-z0-9.-]+(:\d+)?$", host):
        raise HTTPException(400, "주소는 ghcr.io나 git.example.com처럼 호스트 이름만 넣어 주세요.")
    token = body.token.strip()
    if token and not body.user.strip():
        raise HTTPException(400, "토큰을 쓰려면 사용자 이름도 넣어 주세요.")
    name = registry_name(host)
    scope = "read:packages" if name.startswith("GitHub") else "read:package"
    reg = m.Registry(id=s.new_id("r"), name=name, host=host, namespace=body.namespace.strip(), user=body.user.strip(),
                     auth=f"토큰 · {scope}" if token else "없음 · 공개 이미지")
    if token:
        reg.set_secret(token)  # envelope-encrypted; never returned
    db.add(reg)
    s.log_act(db, "레지스트리 추가", f"{host}/{reg.namespace}")
    db.commit()
    return reg.to_dict()


class ImageIn(BaseModel):
    ref: str
    registry: str | None = None
    tags: list[str] = ["latest"]


@router.post("/images")
def add_image(body: ImageIn, db: Session = Depends(get_db)):
    """Register an image to deploy. Tags are entered by hand here; digests are pinned at deploy time."""
    ref = body.ref.strip().split("@")[0]
    if ":" in ref.split("/")[-1]:
        ref, tag = ref.rsplit(":", 1)
        body.tags = [tag, *body.tags]
    if not IMAGE_RE.match(ref):
        raise HTTPException(400, "이미지 주소는 ghcr.io/조직/이름처럼 소문자로 넣어 주세요.")
    tags = list(dict.fromkeys(t.strip() for t in body.tags if t.strip()))
    if not tags or any(not TAG_RE.match(t) for t in tags):
        raise HTTPException(400, "태그는 영문, 숫자, . _ - 만 쓸 수 있어요. 예: v1.2.0")
    if body.registry and not db.get(m.Registry, body.registry):
        raise HTTPException(400, "레지스트리를 찾을 수 없어요.")
    img = db.get(m.Image, ref)
    if not img:
        img = m.Image(ref=ref, registry_id=body.registry)
        db.add(img)
    known = {t.name for t in img.tags}
    # The first tag given is the newest: give it the latest timestamp.
    now = time.time()
    for i, t in enumerate(t for t in tags if t not in known):
        img.tags.append(m.ImageTag(name=t, digest="", pushed="방금 등록", pushed_at=now - i * 0.001))
    s.log_act(db, "이미지 등록", f"{ref} ({', '.join(tags)})")
    db.commit()
    return img.to_dict()


# ---------- playbook repos ----------

@router.get("/repos")
def list_repos(db: Session = Depends(get_db)):
    return [r.to_dict() for r in db.scalars(select(m.Repo).order_by(m.Repo.id))]


class RepoIn(BaseModel):
    name: str = ""
    kind: str = Field(pattern="^(git|local)$")
    url: str = ""
    branch: str = "main"
    key: str = ""
    path: str = ""


def _add_repo(db: Session, repo: m.Repo, log: tuple[str, str]) -> dict:
    if db.scalar(select(m.Repo).where(m.Repo.name == repo.name)):
        raise HTTPException(400, "같은 이름의 레포가 있어요.")
    db.add(repo)
    s.log_act(db, *log)
    db.commit()
    return repo.to_dict()


@router.post("/repos")
def add_repo(body: RepoIn, db: Session = Depends(get_db)):
    if body.kind == "local":
        p = body.path.strip().rstrip("/")
        if not p.startswith(LOCAL_ROOT) or ".." in p:
            raise HTTPException(400, f"경로는 {LOCAL_ROOT} 아래여야 하고 ..은 쓸 수 없어요.")
        repo = m.Repo(name=body.name.strip() or p.split("/")[-1], kind="local", url=p, branch="-", auth="-", commit="-", books=["site.yml", "deploy-app.yml"])
        return _add_repo(db, repo, ("플레이북 경로 연결", p))
    u = body.url.strip()
    found = re.search(r"[:/]([^/:]+/[^/]+?)(\.git)?$", u)
    if not found or not re.match(r"^(git@|ssh://|https://)", u):
        raise HTTPException(400, "저장소 주소를 확인해 주세요. 예: git@github.com:org/ansible.git 또는 https://github.com/org/ansible.git")
    is_ssh = bool(re.match(r"^(git@|ssh://)", u))
    key = None
    if body.key:
        key = db.scalar(select(m.Key).where(m.Key.name == body.key))
        if not key:
            raise HTTPException(400, "고른 키를 찾을 수 없어요.")
        if key.kind != ("ssh" if is_ssh else "token"):
            raise HTTPException(400, "SSH 주소에는 SSH 키를, HTTPS 주소에는 액세스 토큰을 골라 주세요.")
    elif is_ssh:
        raise HTTPException(400, "SSH 주소는 SSH 키가 있어야 해요.")
    auth = (("SSH 키 · " if is_ssh else "토큰 · ") + key.name) if key else "공개 저장소"
    name = body.name.strip() or found.group(1)
    repo = m.Repo(name=name, kind="git", url=u, branch=body.branch.strip() or "main", auth=auth, commit="1a2b3c4", books=["site.yml", "deploy-app.yml"])
    if key:
        key.used_count += 1
    return _add_repo(db, repo, ("플레이북 레포 연결", name))


# ---------- inventory ----------

@router.get("/inventory")
def list_inventory(db: Session = Depends(get_db)):
    return [i.to_dict() for i in db.scalars(select(m.Inventory).order_by(m.Inventory.ord))]


class InventoryIn(BaseModel):
    name: str
    key: str


@router.post("/inventory")
def add_inventory(body: InventoryIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,63}$", name):
        raise HTTPException(400, "인벤토리 이름은 production처럼 영문 소문자, 숫자, -, _ 로 넣어 주세요.")
    if db.scalar(select(m.Inventory).where(m.Inventory.name == name)):
        raise HTTPException(400, "같은 이름의 인벤토리가 있어요.")
    key = db.scalar(select(m.Key).where(m.Key.name == body.key, m.Key.kind == "ssh"))
    if not key:
        raise HTTPException(400, "서버 접속에 쓸 SSH 키를 골라 주세요.")
    inv = m.Inventory(id=s.new_id("i"), name=name, key=key.name)
    key.used_count += 1
    db.add(inv)
    s.log_act(db, "인벤토리 생성", f"{name} · 키 {key.name}")
    db.commit()
    return inv.to_dict()


class FingerprintIn(BaseModel):
    ip: str
    port: int


@router.post("/inventory/fingerprint")
def fingerprint(body: FingerprintIn):
    # A real implementation connects and reads the server's ED25519 host key.
    return {"type": "ED25519", "fingerprint": "SHA256:pX0c7Lq2vRz9Hn4Wb1Ke8YsT3mJ6fDaUgQ5iEoN"}


class HostIn(BaseModel):
    name: str
    ip: str
    port: str
    user: str
    group: str = "default"
    key: str = ""


@router.post("/inventory/{inv_id}/hosts")
def add_host(inv_id: str, body: HostIn, db: Session = Depends(get_db)):
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    name, ip, user, group = body.name.strip(), body.ip.strip(), body.user.strip(), body.group.strip() or "default"
    if user == "root":
        raise HTTPException(400, "root로는 접속할 수 없어요. 권한이 제한된 deploy 사용자를 만들어 주세요.")
    if not re.match(r"^[a-z_][a-z0-9_-]{0,31}$", user):
        raise HTTPException(400, "SSH 사용자 이름을 확인해 주세요. 예: deploy")
    if not body.port.strip().isdigit() or not 1 <= int(body.port) <= 65535:
        raise HTTPException(400, "포트는 1~65535 사이 숫자여야 해요.")
    if not re.match(r"^[A-Za-z0-9.:-]{1,253}$", ip):
        raise HTTPException(400, "IP 또는 호스트 이름을 확인해 주세요.")
    if not re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", group):
        raise HTTPException(400, "그룹 이름은 web, worker처럼 영문 소문자로 넣어 주세요.")
    if not name or any(h.name == name for h in inv.hosts):
        raise HTTPException(400, "서버 이름이 비었거나 이 인벤토리에 이미 있어요.")
    h = m.Host(name=name, ip=ip, port=int(body.port), ssh_user=user, grp=group)
    inv.hosts.append(h)
    s.log_act(db, "서버 추가", f"{inv.name} · {h.name} ({h.ip})")
    db.commit()
    return h.to_dict()


@router.post("/inventory/{inv_id}/ping")
async def ping(inv_id: str, db: Session = Depends(get_db)):
    inv = db.get(m.Inventory, inv_id)
    if not inv:
        raise HTTPException(404, "인벤토리를 찾을 수 없어요.")
    total, ok = len(inv.hosts), sum(1 for h in inv.hosts if h.status == "on")
    await asyncio.sleep(1.0)
    return {"total": total, "ok": ok}


@router.post("/inventory/{inv_id}/hosts/{ix}/accept-key", dependencies=[Depends(require_sudo)])
def accept_host_key(inv_id: str, ix: int, db: Session = Depends(get_db)):
    inv = db.get(m.Inventory, inv_id)
    if not inv or not (0 <= ix < len(inv.hosts)):
        raise HTTPException(404, "서버를 찾을 수 없어요.")
    h = inv.hosts[ix]
    h.host_key = "ok"
    s.log_act(db, "호스트 키 변경 승인", f"{h.name} ({h.ip})", "warn")
    db.commit()
    return h.to_dict()


# ---------- key store ----------

@router.get("/keys")
def list_keys(db: Session = Depends(get_db)):
    return [k.to_dict() for k in db.scalars(select(m.Key).order_by(m.Key.ord))]


class KeyIn(BaseModel):
    mode: str = Field(pattern="^(gen|paste|token)$")
    name: str
    privateKey: str = ""
    passphrase: str = ""
    user: str = ""
    token: str = ""


@router.post("/keys", dependencies=[Depends(require_sudo)])
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
    return {"publicKey": k.public_key}


@router.delete("/keys/{key_id}", dependencies=[Depends(require_sudo)])
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
