import asyncio
import base64
import random
import re
import string
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require_login, require_sudo

router = APIRouter(prefix="/api", tags=["resources"], dependencies=[Depends(require_login)])

LOCAL_ROOT = "/var/lib/wharfline/playbooks/"


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


@router.post("/registries", dependencies=[Depends(require_sudo)])
def add_registry(body: RegistryIn, db: Session = Depends(get_db)):
    host = body.host.strip()
    if not host:
        raise HTTPException(400, "주소를 넣어 주세요.")
    is_gh = bool(re.search(r"(^|\.)ghcr\.io$", host))
    # The token itself is not stored in this prototype; a real build encrypts it.
    reg = m.Registry(
        id=s.new_id("r"), name="GitHub Container Registry" if is_gh else "Gitea", host=host,
        namespace=body.namespace.strip(), user=body.user.strip(),
        auth="토큰 · " + ("read:packages" if is_gh else "read:package"),
    )
    db.add(reg)
    s.log_act(db, "레지스트리 추가", f"{host}/{reg.namespace}")
    db.commit()
    return reg.to_dict()


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
    if not found:
        raise HTTPException(400, "저장소 주소를 확인해 주세요. 예: git@git.acme.kr:ops/ansible.git")
    is_ssh = bool(re.match(r"^(git@|ssh://)", u))
    if is_ssh and not body.key:
        raise HTTPException(400, "SSH 주소는 SSH 키가 있어야 해요.")
    auth = ("SSH 키 · " if is_ssh else "토큰 · ") + body.key if body.key else "공개 저장소"
    name = body.name.strip() or found.group(1)
    repo = m.Repo(name=name, kind="git", url=u, branch=body.branch.strip() or "main", auth=auth, commit="1a2b3c4", books=["site.yml", "deploy-app.yml"])
    return _add_repo(db, repo, ("플레이북 레포 연결", name))


# ---------- inventory ----------

@router.get("/inventory")
def list_inventory(db: Session = Depends(get_db)):
    return [i.to_dict() for i in db.scalars(select(m.Inventory).order_by(m.Inventory.ord))]


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
    if body.user.strip() == "root":
        raise HTTPException(400, "root로는 접속할 수 없어요. 권한이 제한된 deploy 사용자를 만들어 주세요.")
    if not body.port.strip().isdigit():
        raise HTTPException(400, "포트는 숫자여야 해요.")
    h = m.Host(name=body.name.strip(), ip=body.ip.strip(), port=int(body.port), ssh_user=body.user.strip(), grp=body.group.strip() or "default")
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


def _rand(n: int) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=n))


def _public_key(k: m.Key) -> str:
    body = base64.b64encode((k.name + k.fingerprint).encode()).decode().replace("=", "")[:40]
    return f"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI{body} {k.name}@wharfline"


@router.post("/keys", dependencies=[Depends(require_sudo)])
def add_key(body: KeyIn, db: Session = Depends(get_db)):
    name = body.name.strip() or "new-key"
    if db.scalar(select(m.Key).where(m.Key.name == name)):
        raise HTTPException(400, "같은 이름의 키가 있어요.")
    today = time.strftime("%Y-%m-%d")
    # Secret material is never stored in this prototype; a real build encrypts it.
    if body.mode == "token":
        tok = body.token.strip()
        if not tok:
            raise HTTPException(400, "토큰을 넣어 주세요.")
        k = m.Key(id=s.new_id("k"), kind="token", name=name, type="토큰", fingerprint=f"{body.user.strip() or '-'} · ••••{tok[-4:]}",
                  created_by=s.ME["name"], created_at=today, last_used="사용 안 함", used_count=0)
        db.add(k)
        s.log_act(db, "액세스 토큰 추가", name)
        db.commit()
        return k.to_dict()
    if body.mode == "paste" and not re.search(r"BEGIN [A-Z ]*PRIVATE KEY", body.privateKey):
        raise HTTPException(400, "비공개 키 형식이 아니에요. -----BEGIN … PRIVATE KEY-----로 시작해야 해요.")
    k = m.Key(id=s.new_id("k"), kind="ssh", name=name, type="ED25519", fingerprint="SHA256:" + _rand(27),
              created_by=s.ME["name"], created_at=today, last_used="사용 안 함", used_count=0)
    db.add(k)
    s.log_act(db, "SSH 키 추가", name)
    db.commit()
    return {**k.to_dict(), "publicKey": _public_key(k)}


@router.get("/keys/{key_id}/public")
def public_key(key_id: str, db: Session = Depends(get_db)):
    k = db.get(m.Key, key_id)
    if not k or k.kind != "ssh":
        raise HTTPException(404, "SSH 키를 찾을 수 없어요.")
    return {"publicKey": _public_key(k)}


@router.delete("/keys/{key_id}", dependencies=[Depends(require_sudo)])
def delete_key(key_id: str, db: Session = Depends(get_db)):
    k = db.get(m.Key, key_id)
    if not k:
        raise HTTPException(404, "키를 찾을 수 없어요.")
    if k.used_count:
        where = "레포" if k.kind == "token" else "인벤토리"
        raise HTTPException(400, f"{where} {k.used_count}곳에서 쓰고 있어 지울 수 없어요")
    db.delete(k)
    s.log_act(db, "SSH 키 삭제", k.name, "warn")
    db.commit()
    return {"ok": True}
