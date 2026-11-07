"""Demo auth: the email must belong to a member; any password and any 6-digit code work.

Replace with Argon2id password hashes, encrypted TOTP secrets and
HttpOnly/Secure/SameSite=Strict session cookies before real use.
"""

import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require_login

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


class TotpIn(BaseModel):
    code: str
    trust: bool = False


class SudoIn(BaseModel):
    password: str


def _me(db: Session) -> dict:
    me = s.current_member(db)
    return {
        "loggedIn": me is not None,
        "me": s.me_dict(me) if me else None,
        "sudoUntil": float(s.session_state(db).get("sudo_until", 0)) * 1000 if s.sudo_active(db) else 0,
        "sudoMinutes": s.sudo_minutes(db),
    }


@router.get("/me")
def me(db: Session = Depends(get_db)):
    return _me(db)


@router.post("/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    if not body.email or not body.password:
        raise HTTPException(400, "이메일과 비밀번호를 넣어 주세요.")
    member = db.scalar(select(m.Member).where(func.lower(m.Member.email) == body.email.strip().lower()))
    if not member:
        raise HTTPException(400, "이메일 또는 비밀번호가 맞지 않아요.")  # same message either way: don't reveal who is a member
    s.set_setting(db, "session", pending_login=True, pending_email=member.email)
    db.commit()
    return {"step": "totp"}


@router.post("/totp")
def totp(body: TotpIn, db: Session = Depends(get_db)):
    st = s.session_state(db)
    if not st.get("pending_login") or not st.get("pending_email"):
        raise HTTPException(400, "먼저 비밀번호로 로그인해 주세요.")
    if len(body.code) != 6 or not body.code.isdigit():
        raise HTTPException(400, "6자리 숫자를 입력해 주세요.")
    s.set_setting(db, "session", logged_in=True, pending_login=False, email=st["pending_email"], pending_email=None, sudo_until=0.0)
    db.add(m.Login(time="방금", user=s.actor_name(db), method="비밀번호 + TOTP", ip=s.CLIENT_IP, location="서울, KR", agent="Chrome 141 · macOS", result="ok"))
    s.log_act(db, "로그인", "비밀번호 + TOTP")
    db.commit()
    return _me(db)


@router.post("/logout")
def logout(db: Session = Depends(get_db)):
    s.log_act(db, "로그아웃", "-")  # before clearing the session, so the entry names who left
    s.set_setting(db, "session", logged_in=False, email=None, sudo_until=0.0)
    db.commit()
    return _me(db)


@router.post("/sudo", dependencies=[Depends(require_login)])
def sudo(body: SudoIn, db: Session = Depends(get_db)):
    if not body.password:
        raise HTTPException(400, "비밀번호를 입력해 주세요.")
    minutes = s.sudo_minutes(db)
    s.set_setting(db, "session", sudo_until=time.time() + minutes * 60)
    s.log_act(db, "비밀번호 재확인", f"{minutes}분 열람 권한")
    db.commit()
    return _me(db)


@router.delete("/sudo")
def end_sudo(db: Session = Depends(get_db)):
    s.set_setting(db, "session", sudo_until=0.0)
    db.commit()
    return _me(db)
