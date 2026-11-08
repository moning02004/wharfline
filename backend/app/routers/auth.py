"""Sign-in, second factor, password re-check (sudo), sessions and 2FA setup.

A login is one row in `sessions`; the browser holds the random token in an HttpOnly cookie.
A row's `stage` tracks a login that still needs something before it counts:
"totp" (second factor), "password" (temporary password must be changed) or
"tfa_setup" (policy requires 2FA and the member has none). Only "ok" sessions are signed in.
"""

import os
import time
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import authn
from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require_login

router = APIRouter(prefix="/api/auth", tags=["auth"])

BAD_LOGIN = "이메일 또는 비밀번호가 맞지 않아요."  # same message either way: don't reveal who is a member
BAD_CODE = "인증 코드가 맞지 않아요."


class LoginIn(BaseModel):
    email: str
    password: str


class TotpIn(BaseModel):
    code: str


class SudoIn(BaseModel):
    password: str


class PasswordIn(BaseModel):
    current: str = ""
    new: str


class CodeIn(BaseModel):
    code: str


# ---------- helpers ----------

def _policy(db: Session) -> dict:
    return s.get_setting(db, "policy")


def _locked_msg(member: m.Member) -> str:
    minutes = max(1, int(((member.locked_until or 0) - time.time() + 59) // 60))
    return f"로그인을 여러 번 실패해서 잠겼어요. {minutes}분 뒤에 다시 해 주세요."


def _check_lock(member: m.Member) -> None:
    if member.is_locked():
        raise HTTPException(429, _locked_msg(member))


def _fail(db: Session, member: m.Member) -> bool:
    """Count a wrong password or code. Returns True when this failure locks the account."""
    attempts, seconds = authn.lockout_rule(_policy(db))
    member.failed_logins = (member.failed_logins or 0) + 1
    if member.failed_logins >= attempts:
        member.failed_logins = 0
        member.locked_until = time.time() + seconds
        _act(db, member, "계정 잠금", f"{attempts}회 실패 · {seconds // 60}분", "bad")
        return True
    return False


def _succeed(member: m.Member) -> None:
    member.failed_logins = 0
    member.locked_until = None


def _act(db: Session, member: m.Member, action: str, obj: str, result: str = "ok") -> None:
    db.add(m.Activity(time=s.now_hms(), user=member.name, action=action, object=obj, ip=s.client_ip(), result=result))


def _record(db: Session, user: str, method: str, result: str) -> None:
    ra = authn.current()
    db.add(m.Login(time=datetime.now().strftime("오늘 %H:%M"), user=user[:255], method=method, ip=s.client_ip(), location="-",
                   agent=authn.describe_agent(ra.agent)[:255], result=result))


def _next_stage(db: Session, member: m.Member) -> str:
    if member.must_change_password:
        return "password"
    if _policy(db).get("enforce2fa") and not member.tfa:
        return "tfa_setup"
    return "ok"


def _set_cookie(response: Response, token: str, max_age: int) -> None:
    response.set_cookie(authn.COOKIE, token, max_age=max_age, path="/", httponly=True, samesite="lax", secure=authn.cookie_secure())


def _start_session(db: Session, response: Response, member: m.Member, stage: str) -> m.LoginSession:
    """New token for this browser. Any session the browser had before is dropped (no session fixation)."""
    ra = authn.current()
    now = time.time()
    if ra.token:
        db.execute(delete(m.LoginSession).where(m.LoginSession.token_hash == authn.token_hash(ra.token)))
    db.execute(delete(m.LoginSession).where(m.LoginSession.member_email == member.email, m.LoginSession.expires_at < now))
    absolute, _ = authn.session_limits(_policy(db))
    token = authn.new_token()
    row = m.LoginSession(token_hash=authn.token_hash(token), member_email=member.email, member=member, stage=stage, created_at=now,
                         last_seen=now, expires_at=now + absolute, sudo_until=0.0, user_agent=ra.agent, ip=ra.ip)
    db.add(row)
    db.flush()
    ra.token, ra.touched = token, True
    _set_cookie(response, token, absolute)
    return row


def _session(db: Session, *stages: str) -> m.LoginSession:
    row = s.current_session(db)
    if not row or row.stage not in stages:
        raise HTTPException(401, "login_required")
    return row


def _me(db: Session) -> dict:
    row = s.current_session(db)
    me = row.member if row and row.stage == "ok" else None
    pending = row if row and row.stage != "ok" else None
    return {
        "loggedIn": me is not None,
        "me": s.me_dict(me) if me else None,
        "step": pending.stage if pending else None,
        "pendingEmail": pending.member_email if pending else None,
        "tfa": bool(me and me.tfa),
        "recoveryCodes": len(me.recovery_codes or []) if me else 0,
        "enforce2fa": bool(_policy(db).get("enforce2fa")),
        # Sample data is loaded (development): the login screen may list the sample accounts.
        "sampleData": os.getenv("WHARFLINE_SAMPLE_DATA", "1") != "0",
        "sudoUntil": row.sudo_until * 1000 if me and s.sudo_active(db) else 0,
        "sudoMinutes": s.sudo_minutes(db),
    }


def _complete(db: Session, member: m.Member, method: str, result: str = "ok") -> None:
    member.last = "방금"
    _record(db, member.name, method, result)
    _act(db, member, "로그인", method, result)


# ---------- sign in / out ----------

@router.get("/me")
def me(db: Session = Depends(get_db)):
    return _me(db)


@router.post("/login")
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if not email or not body.password:
        raise HTTPException(400, "이메일과 비밀번호를 넣어 주세요.")
    member = db.scalar(select(m.Member).where(func.lower(m.Member.email) == email))
    if member and member.is_locked():
        _record(db, member.name, "비밀번호", "bad")
        db.commit()
        raise HTTPException(429, _locked_msg(member))
    if not authn.check_password(body.password, member.password_hash if member else None) or not member:
        _record(db, member.name if member else email, "비밀번호", "bad")
        locked = _fail(db, member) if member else False
        db.commit()
        raise HTTPException(429, _locked_msg(member)) if locked and member else HTTPException(400, BAD_LOGIN)
    _succeed(member)
    stage = "totp" if member.tfa else _next_stage(db, member)
    _start_session(db, response, member, stage)
    if stage != "totp":
        _complete(db, member, "비밀번호")
    db.commit()
    return _me(db)


@router.post("/totp")
def totp(body: TotpIn, db: Session = Depends(get_db)):
    row = s.current_session(db)
    if not row or row.stage != "totp":
        raise HTTPException(400, "먼저 비밀번호로 로그인해 주세요.")
    member = row.member
    _check_lock(member)
    secret = member.tfa_state().get("secret")
    method, result = "비밀번호 + TOTP", "ok"
    step = authn.verify_totp(secret, body.code, after_step=member.tfa_last_step) if secret else None
    if step is not None:
        member.tfa_last_step = step
    else:
        idx = authn.match_recovery(body.code, list(member.recovery_codes or []))
        if idx is None:
            _record(db, member.name, "TOTP", "bad")
            locked = _fail(db, member)
            db.commit()
            raise HTTPException(429, _locked_msg(member)) if locked else HTTPException(400, BAD_CODE)
        member.recovery_codes = [h for i, h in enumerate(member.recovery_codes) if i != idx]
        method, result = "복구 코드", "warn"
    _succeed(member)
    row.stage = _next_stage(db, member)
    _complete(db, member, method, result)
    db.commit()
    return _me(db)


@router.post("/logout")
def logout(response: Response, db: Session = Depends(get_db)):
    ra = authn.current()
    if ra.token:
        row = db.get(m.LoginSession, authn.token_hash(ra.token))
        if row:
            if row.stage == "ok":
                _act(db, row.member, "로그아웃", "-")
            db.delete(row)
        db.commit()
    ra.token = None
    response.delete_cookie(authn.COOKIE, path="/", httponly=True, samesite="lax", secure=authn.cookie_secure())
    return _me(db)


# ---------- password ----------

@router.post("/password")
def change_password(body: PasswordIn, db: Session = Depends(get_db)):
    """Change my password. Right after signing in with a temporary password the current one is not asked again."""
    row = _session(db, "ok", "password")
    member = row.member
    if row.stage == "ok":
        _check_lock(member)
        if not authn.check_password(body.current, member.password_hash):
            locked = _fail(db, member)
            db.commit()
            raise HTTPException(429, _locked_msg(member)) if locked else HTTPException(400, "지금 비밀번호가 맞지 않아요.")
    problem = authn.password_problem(body.new)
    if problem:
        raise HTTPException(400, problem)
    if authn.check_password(body.new, member.password_hash):
        raise HTTPException(400, "지금과 다른 비밀번호로 정해 주세요.")
    member.password_hash = authn.hash_password(body.new)
    member.must_change_password = False
    _succeed(member)
    others = db.execute(delete(m.LoginSession).where(m.LoginSession.member_email == member.email,
                                                     m.LoginSession.token_hash != row.token_hash)).rowcount
    if row.stage == "password":
        row.stage = _next_stage(db, member)
    _act(db, member, "비밀번호 변경", f"다른 세션 {others}개 로그아웃" if others else "-")
    db.commit()
    return _me(db)


# ---------- password re-check (sudo) ----------

@router.post("/sudo", dependencies=[Depends(require_login)])
def sudo(body: SudoIn, db: Session = Depends(get_db)):
    row = _session(db, "ok")
    member = row.member
    _check_lock(member)
    if not body.password:
        raise HTTPException(400, "비밀번호를 입력해 주세요.")
    if not authn.check_password(body.password, member.password_hash):
        locked = _fail(db, member)
        _act(db, member, "비밀번호 재확인", "비밀번호 틀림", "bad")
        db.commit()
        raise HTTPException(429, _locked_msg(member)) if locked else HTTPException(400, "비밀번호가 맞지 않아요.")
    _succeed(member)
    minutes = s.sudo_minutes(db)
    row.sudo_until = time.time() + minutes * 60
    s.log_act(db, "비밀번호 재확인", f"{minutes}분 열람 권한")
    db.commit()
    return _me(db)


@router.delete("/sudo")
def end_sudo(db: Session = Depends(get_db)):
    row = s.current_session(db)
    if row:
        row.sudo_until = 0.0
        db.commit()
    return _me(db)


# ---------- my sessions ----------

@router.get("/sessions", dependencies=[Depends(require_login)])
def sessions(db: Session = Depends(get_db)):
    return s.session_list(db)


@router.delete("/sessions/{sid}", dependencies=[Depends(require_login)])
def end_session(sid: str, db: Session = Depends(get_db)):
    row = _session(db, "ok")
    target = db.scalar(select(m.LoginSession).where(m.LoginSession.member_email == row.member_email,
                                                    m.LoginSession.token_hash.startswith(sid, autoescape=True))) if len(sid) >= 16 else None
    if not target:
        raise HTTPException(404, "세션을 찾을 수 없어요.")
    if target.token_hash == row.token_hash:
        raise HTTPException(400, "이 기기는 로그아웃 버튼으로 나가 주세요.")
    db.delete(target)
    s.log_act(db, "세션 로그아웃", authn.describe_agent(target.user_agent))
    db.commit()
    return s.session_list(db)


@router.post("/sessions/logout-others", dependencies=[Depends(require_login)])
def end_other_sessions(db: Session = Depends(get_db)):
    row = _session(db, "ok")
    n = db.execute(delete(m.LoginSession).where(m.LoginSession.member_email == row.member_email,
                                                m.LoginSession.token_hash != row.token_hash)).rowcount
    s.log_act(db, "다른 세션 모두 로그아웃", f"{n}개")
    db.commit()
    return s.session_list(db)


# ---------- two-step verification (optional unless the policy requires it) ----------

def _tfa_session(db: Session) -> m.LoginSession:
    """2FA setup: during a login that must set it up, or a signed-in member who re-checked their password."""
    row = s.current_session(db)
    if row and row.stage == "tfa_setup":
        return row
    if not row or row.stage != "ok":
        raise HTTPException(401, "login_required")
    if not s.sudo_active(db):
        raise HTTPException(403, "sudo_required")
    return row


@router.post("/tfa/begin")
def tfa_begin(db: Session = Depends(get_db)):
    """A new secret, kept pending until a code from it is confirmed. An existing 2FA keeps working until then."""
    member = _tfa_session(db).member
    pending = authn.new_totp_secret()
    member.set_tfa_state(member.tfa_state().get("secret"), pending)
    db.commit()
    return {"secret": authn.spaced(pending), "uri": authn.otpauth_uri(pending, member.email)}


@router.post("/tfa/verify")
def tfa_verify(body: CodeIn, db: Session = Depends(get_db)):
    row = _tfa_session(db)
    member = row.member
    pending = member.tfa_state().get("pending")
    if not pending:
        raise HTTPException(400, "먼저 인증 앱 연결을 시작해 주세요.")
    step = authn.verify_totp(pending, body.code)
    if step is None:
        raise HTTPException(400, "인증 코드가 맞지 않아요. 휴대폰 시간이 맞는지도 확인해 주세요.")
    was_on = member.tfa
    member.set_tfa_state(pending, None)
    member.tfa_last_step = step
    codes = authn.new_recovery_codes()
    member.recovery_codes = [authn.hash_recovery(c) for c in codes]
    if row.stage == "tfa_setup":
        row.stage = "ok"
    _act(db, member, "2단계 인증 다시 설정" if was_on else "2단계 인증 켜기", "TOTP")
    db.commit()
    return {"codes": codes, "session": _me(db)}


@router.post("/tfa/codes", dependencies=[Depends(require_login)])
def tfa_codes(db: Session = Depends(get_db)):
    row = _tfa_session(db)
    member = row.member
    if not member.tfa:
        raise HTTPException(400, "2단계 인증을 먼저 켜 주세요.")
    codes = authn.new_recovery_codes()
    member.recovery_codes = [authn.hash_recovery(c) for c in codes]
    _act(db, member, "복구 코드 새로 발급", f"{len(codes)}개")
    db.commit()
    return {"codes": codes, "session": _me(db)}


@router.post("/tfa/disable", dependencies=[Depends(require_login)])
def tfa_disable(body: SudoIn, db: Session = Depends(get_db)):
    row = _session(db, "ok")
    member = row.member
    if _policy(db).get("enforce2fa"):
        raise HTTPException(400, "워크스페이스 정책상 2단계 인증을 끌 수 없어요.")
    _check_lock(member)
    if not authn.check_password(body.password, member.password_hash):
        locked = _fail(db, member)
        db.commit()
        raise HTTPException(429, _locked_msg(member)) if locked else HTTPException(400, "비밀번호가 맞지 않아요.")
    _succeed(member)
    member.set_tfa_state(None, None)
    member.recovery_codes = []
    member.tfa_last_step = None
    _act(db, member, "2단계 인증 끄기", "TOTP", "warn")
    db.commit()
    return _me(db)
