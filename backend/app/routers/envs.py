"""Environment variable sets.

Values are stored with envelope encryption and only leave the server as
plaintext through /values, which needs a recent password re-check.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require, require_login, require_sudo

router = APIRouter(prefix="/api/envs", tags=["envs"], dependencies=[Depends(require_login)])


def masked(db: Session, e: m.EnvSet) -> dict:
    """Names only. Value lengths are not exposed either."""
    return {
        "id": e.id, "name": e.name, "ver": e.ver, "updated": e.updated,
        "vars": [{"key": k} for k in e.var_names],
        "usedBy": list(db.scalars(select(m.Job.name).where(m.Job.env == e.name).order_by(m.Job.ord))),
    }


def get_env(db: Session, env_id: str) -> m.EnvSet:
    e = db.get(m.EnvSet, env_id)
    if not e:
        raise HTTPException(404, "환경 변수를 찾을 수 없어요.")
    return e


def plain_text(vars_: list[list[str]]) -> str:
    """KEY=value lines for a set saved before its text was kept."""
    return "".join(f"{k}={v}\n" for k, v in vars_)


def vars_from(vars_: list[list[str]], text: str | None) -> list[list[str]]:
    """The variables of a request: parsed from text when it is sent (the text is what gets kept), else vars."""
    return s.parse_env_text(text) if text is not None else vars_


def replace_vars(e: m.EnvSet, new_vars: list[list[str]], updated: str, text: str | None = None) -> None:
    """Keep the current contents as a version, then store the new ones under a new DEK."""
    old = m.EnvVersion(env_id=e.id, ver=e.ver, updated=e.updated)
    old.set_vars(*e.get_payload())
    e.versions.append(old)
    e.set_vars(new_vars, text)
    e.ver += 1
    e.updated = updated


@router.get("")
def list_envs(db: Session = Depends(get_db)):
    return [masked(db, e) for e in db.scalars(select(m.EnvSet).order_by(m.EnvSet.ord))]


class EnvIn(BaseModel):
    name: str
    vars: list[list[str]] = []
    text: str | None = None  # the .env as written; comments and blank lines are kept with it


@router.post("", dependencies=[Depends(require("env"))])
def create_env(body: EnvIn, db: Session = Depends(get_db)):
    name = body.name.strip()
    vars_ = vars_from(body.vars, body.text)
    if not name or not vars_:
        raise HTTPException(400, "이름과 변수를 하나 이상 넣어 주세요")
    if db.scalar(select(m.EnvSet).where(m.EnvSet.name == name)):
        raise HTTPException(400, "같은 이름이 있어요.")
    s.validate_vars(vars_)
    e = m.EnvSet(id=s.new_id("e"), name=name, ver=1, updated=f"방금 · {s.actor_name(db)}")
    e.set_vars(vars_, body.text)
    db.add(e)
    s.log_act(db, "환경 변수 추가", name)
    db.commit()
    return masked(db, e)


@router.get("/{env_id}/values", dependencies=[Depends(require("env")), Depends(require_sudo)])
def reveal(env_id: str, purpose: str = "view", ver: int | None = None, db: Session = Depends(get_db)):
    """The current values, or those of an older version (`ver`, to compare in the editor)."""
    e = get_env(db, env_id)
    src: m.EnvSet | m.EnvVersion = e
    if ver is not None and ver != e.ver:
        src = next((v for v in e.versions if v.ver == ver), None)
        if src is None:
            raise HTTPException(404, "그 버전을 찾을 수 없어요.")
    if purpose == "view" or src is not e:
        s.log_act(db, "민감 정보 열람", f".env {e.name}" + (f" v{ver}" if src is not e else ""))
        db.commit()
    vars_, text = src.get_payload()
    return {"vars": vars_, "text": text if text is not None else plain_text(vars_)}


@router.post("/{env_id}/copied", dependencies=[Depends(require("env")), Depends(require_sudo)])
def copied(env_id: str, db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    s.log_act(db, "민감 정보 복사", f".env {e.name}")
    db.commit()
    return {"ok": True}


class EnvUpdate(BaseModel):
    vars: list[list[str]] = []
    text: str | None = None


@router.put("/{env_id}", dependencies=[Depends(require("env")), Depends(require_sudo)])
def update_env(env_id: str, body: EnvUpdate, db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    new_vars = vars_from(body.vars, body.text)
    s.validate_vars(new_vars)
    cur_vars, cur_text = e.get_payload()
    d = s.diff_vars(cur_vars, new_vars)
    # A comment or line-order change is a change too, when the text is sent.
    text_changed = body.text is not None and body.text != (cur_text if cur_text is not None else plain_text(cur_vars))
    if not any(d.values()) and not text_changed:
        raise HTTPException(400, "바뀐 내용이 없어요.")
    replace_vars(e, new_vars, f"방금 · {s.actor_name(db)}", body.text)
    parts = " / ".join(p for p in [
        d["add"] and "추가 " + ", ".join(d["add"]),
        d["chg"] and "수정 " + ", ".join(d["chg"]),
        d["del"] and "삭제 " + ", ".join(d["del"]),
    ] if p) or "주석·순서만 수정"
    # Only variable names go to the activity log, never values.
    s.log_act(db, "환경 변수 수정", f"{e.name} v{e.ver} · {parts}")
    db.commit()
    return masked(db, e)


@router.get("/{env_id}/history")
def history(env_id: str, db: Session = Depends(get_db)):
    """Version list with changed variable names. Values are decrypted only to compute the diff."""
    e = get_env(db, env_id)
    items = [{"ver": e.ver, "updated": e.updated, "vars": e.get_vars(), "current": True}]
    items += [{"ver": v.ver, "updated": v.updated, "vars": v.get_vars(), "current": False} for v in sorted(e.versions, key=lambda v: -v.ver)]
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


@router.post("/{env_id}/restore", dependencies=[Depends(require("env")), Depends(require_sudo)])
def restore(env_id: str, body: RestoreIn, db: Session = Depends(get_db)):
    e = get_env(db, env_id)
    src = next((v for v in e.versions if v.ver == body.ver), None)
    if not src:
        raise HTTPException(404, "그 버전을 찾을 수 없어요.")
    src_vars, src_text = src.get_payload()
    replace_vars(e, src_vars, f"방금 · {s.actor_name(db)} (v{body.ver}로 되돌림)", src_text)
    s.log_act(db, "환경 변수 되돌리기", f"{e.name} v{body.ver} 내용으로 v{e.ver} 생성", "warn")
    db.commit()
    return masked(db, e)
