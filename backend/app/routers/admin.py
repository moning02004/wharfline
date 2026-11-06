import random
import string

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require_login, require_sudo

router = APIRouter(prefix="/api", tags=["admin"], dependencies=[Depends(require_login)])

# The prototype shows the activity count as if older history existed.
HISTORY_OFFSET = 1276


@router.get("/activity")
def activity(db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(m.Activity)) or 0
    items = db.scalars(select(m.Activity).order_by(m.Activity.id.desc()).limit(500))
    return {"chainVerified": True, "total": HISTORY_OFFSET + total, "items": [a.to_dict() for a in items]}


@router.get("/logins")
def logins(db: Session = Depends(get_db)):
    return [x.to_dict() for x in db.scalars(select(m.Login).order_by(m.Login.id.desc()).limit(500))]


@router.get("/members")
def members(db: Session = Depends(get_db)):
    return [x.to_dict() for x in db.scalars(select(m.Member).order_by(m.Member.ord))]


def access_map(db: Session) -> dict[str, list[str]]:
    return {a.menu: a.roles for a in db.scalars(select(m.MenuAccess))}


@router.get("/access")
def get_access(db: Session = Depends(get_db)):
    return access_map(db)


class AccessIn(BaseModel):
    menu: str
    role: str
    visible: bool


@router.put("/access")
def set_access(body: AccessIn, db: Session = Depends(get_db)):
    if body.role == "Owner" or body.menu == "dashboard":
        raise HTTPException(400, "바꿀 수 없어요.")
    if body.role not in s.ROLES:
        raise HTTPException(400, "알 수 없는 역할이에요.")
    row = db.get(m.MenuAccess, body.menu)
    if not row:
        row = m.MenuAccess(menu=body.menu, roles=[])
        db.add(row)
    roles = [r for r in row.roles if r != body.role]
    if body.visible:
        roles.append(body.role)
    row.roles = roles
    s.log_act(db, "메뉴 권한 변경", f"{body.role} · {body.menu} {'표시' if body.visible else '숨김'}")
    db.commit()
    return access_map(db)


@router.get("/security")
def security(db: Session = Depends(get_db)):
    return {
        "sessions": [x.to_dict() for x in db.scalars(select(m.DeviceSession).order_by(m.DeviceSession.id))],
        "policy": s.get_setting(db, "policy"),
    }


class PolicyIn(BaseModel):
    enforce2fa: bool
    sudoMinutes: int
    session: str
    lockout: str
    allowIps: str


@router.put("/security/policy")
def save_policy(body: PolicyIn, db: Session = Depends(get_db)):
    if body.sudoMinutes not in (1, 5, 10, 15):
        raise HTTPException(400, "열람 유지 시간은 1, 5, 10, 15분 중에서 골라 주세요.")
    ips = [x.strip() for x in body.allowIps.splitlines() if x.strip()]
    if ips and not any(ip.startswith("211.234.10.") or ip == s.CLIENT_IP for ip in ips):
        raise HTTPException(400, "내 IP가 허용 목록에 없어서 저장할 수 없어요.")
    policy = s.set_setting(db, "policy", **body.model_dump())
    s.log_act(db, "보안 정책 저장", f"열람 {body.sudoMinutes}분 · IP {len(ips)}개")
    db.commit()
    return policy


def _code() -> str:
    a = string.ascii_lowercase + string.digits
    return "".join(random.choices(a, k=4)) + "-" + "".join(random.choices(a, k=4))


@router.post("/security/codes", dependencies=[Depends(require_sudo)])
def new_codes(db: Session = Depends(get_db)):
    s.log_act(db, "복구 코드 새로 발급", "10개")
    db.commit()
    return {"codes": [_code() for _ in range(10)]}


@router.post("/security/tfa", dependencies=[Depends(require_sudo)])
def tfa_begin():
    return {"secret": "JBSW Y3DP EHPK 3PXP", "uri": "otpauth://totp/Wharfline:jeonghoon?secret=JBSWY3DPEHPK3PXP&issuer=Wharfline"}


class TfaVerifyIn(BaseModel):
    code: str


@router.post("/security/tfa/verify", dependencies=[Depends(require_sudo)])
def tfa_verify(body: TfaVerifyIn, db: Session = Depends(get_db)):
    if len(body.code) != 6 or not body.code.isdigit():
        raise HTTPException(400, "6자리 숫자를 입력해 주세요.")
    s.log_act(db, "2단계 인증 재설정", "TOTP")
    db.commit()
    return {"codes": [_code() for _ in range(10)]}
