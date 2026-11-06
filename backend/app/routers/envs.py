"""Environment variable sets. Values never leave the server without a recent sudo."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require_login, require_sudo

router = APIRouter(prefix="/api/envs", tags=["envs"], dependencies=[Depends(require_login)])


def masked(db: Session, e: m.EnvSet) -> dict:
    return {
        "id": e.id, "name": e.name, "ver": e.ver, "updated": e.updated,
        "vars": [{"key": k, "length": len(v)} for k, v in e.vars],
        "usedBy": list(db.scalars(select(m.Job.name).where(m.Job.env == e.name).order_by(m.Job.ord))),
    }


def get_env(db: Session, env_id: str) -> m.EnvSet:
    e = db.get(m.EnvSet, env_id)
    if not e:
        raise HTTPException(404, "환경 변수를 찾을 수 없어요.")
    return e


def validate(vars_: list[list[str]]) -> None:
    seen: set[str] = set()
    for pair in vars_:
        if len(pair) != 2:
            raise HTTPException(400, "변수는 [이름, 값] 형식이어야 해요.")
        k = pair[0]
        if not s.ENV_KEY_RE.match(k):
            raise HTTPException(400, f'"{k or "(빈 이름)"}"은(는) 변수 이름으로 쓸 수 없어요.')
        if k in seen:
            raise HTTPException(400, f"{k}이(가) 두 번 들어 있어요.")
        seen.add(k)


def snapshot(e: m.EnvSet) -> None:
    """Keep the current contents as a version before changing them."""
    e.versions.append(m.EnvVersion(ver=e.ver, updated=e.updated, vars=e.vars))


@router.get("")
def list_envs(db: Session = Depends(get_db)):
    return [masked(db, e) for e in db.scalars(select(m.EnvSet).order_by(m.EnvSet.ord))]


class EnvIn(BaseModel):
    name: str
    vars: list[list[str]]


@router.post("")
def create_env(body: EnvIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    if not name or not body.vars:
        raise HTTPException(400, "이름과 변수를 하나 이상 넣어 주세요")
    if db.scalar(select(m.EnvSet).where(m.EnvSet.name == name)):
        raise HTTPException(400, "같은 이름이 있어요.")
    validate(body.vars)
    e = m.EnvSet(id=s.new_id("e"), name=name, ver=1, updated=f"방금 · {s.ME['name']}", vars=body.vars)
    db.add(e)
    s.log_act(db, "환경 변수 추가", name)
    db.commit()
    return masked(db, e)


@router.get("/{env_id}/values", dependencies=[Depends(require_sudo)])
def reveal(env_id: str, purpose: str = "view", db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    if purpose == "view":
        s.log_act(db, "민감 정보 열람", f".env {e.name}")
        db.commit()
    return {"vars": e.vars}


@router.post("/{env_id}/copied", dependencies=[Depends(require_sudo)])
def copied(env_id: str, db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    s.log_act(db, "민감 정보 복사", f".env {e.name}")
    db.commit()
    return {"ok": True}


class EnvUpdate(BaseModel):
    vars: list[list[str]]


@router.put("/{env_id}", dependencies=[Depends(require_sudo)])
def update_env(env_id: str, body: EnvUpdate, db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    validate(body.vars)
    d = s.diff_vars(e.vars, body.vars)
    if not any(d.values()):
        raise HTTPException(400, "바뀐 내용이 없어요.")
    snapshot(e)
    e.vars = body.vars
    e.ver += 1
    e.updated = f"방금 · {s.ME['name']}"
    parts = " / ".join(p for p in [
        d["add"] and "추가 " + ", ".join(d["add"]),
        d["chg"] and "수정 " + ", ".join(d["chg"]),
        d["del"] and "삭제 " + ", ".join(d["del"]),
    ] if p)
    # Only variable names go to the activity log, never values.
    s.log_act(db, "환경 변수 수정", f"{e.name} v{e.ver} · {parts}")
    db.commit()
    return masked(db, e)


@router.get("/{env_id}/history")
def history(env_id: str, db: Session = Depends(get_db)):
    """Version list with changed variable names. Values are not included."""
    e = get_env(db, env_id)
    items = [{"ver": e.ver, "updated": e.updated, "vars": e.vars, "current": True}]
    items += [{"ver": v.ver, "updated": v.updated, "vars": v.vars, "current": False} for v in sorted(e.versions, key=lambda v: -v.ver)]
    out = []
    for i, it in enumerate(items):
        prev = items[i + 1] if i + 1 < len(items) else None
        out.append({
            "ver": it["ver"], "updated": it["updated"], "count": len(it["vars"]), "current": it["current"],
            "prevVer": prev["ver"] if prev else None,
            "diff": s.diff_vars(prev["vars"], it["vars"]) if prev else None,
        })
    return {"name": e.name, "ver": e.ver, "items": out}


class RestoreIn(BaseModel):
    ver: int


@router.post("/{env_id}/restore", dependencies=[Depends(require_sudo)])
def restore(env_id: str, body: RestoreIn, db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    src = next((v for v in e.versions if v.ver == body.ver), None)
    if not src:
        raise HTTPException(404, "그 버전을 찾을 수 없어요.")
    snapshot(e)
    e.vars = [list(x) for x in src.vars]
    e.ver += 1
    e.updated = f"방금 · {s.ME['name']} (v{body.ver}로 되돌림)"
    s.log_act(db, "환경 변수 되돌리기", f"{e.name} v{body.ver} 내용으로 v{e.ver} 생성", "warn")
    db.commit()
    return masked(db, e)
