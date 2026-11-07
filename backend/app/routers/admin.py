import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import authn, githooks
from .. import models as m
from .. import store as s
from ..db import get_db
from ..deps import require, require_login, require_owner, require_sudo, viewer

router = APIRouter(prefix="/api", tags=["admin"], dependencies=[Depends(require_login)])

# The prototype shows the activity count as if older history existed.


@router.get("/activity")
def activity(db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(m.Activity)) or 0
    items = db.scalars(select(m.Activity).order_by(m.Activity.id.desc()).limit(500))
    return {"total": total, "items": [a.to_dict() for a in items]}


@router.get("/logins")
def logins(db: Session = Depends(get_db)):
    return [x.to_dict() for x in db.scalars(select(m.Login).order_by(m.Login.id.desc()).limit(500))]


@router.get("/members")
def members(db: Session = Depends(get_db)):
    return [x.to_dict() for x in db.scalars(select(m.Member).order_by(m.Member.ord))]


class RoleIn(BaseModel):
    role: str


@router.put("/members/{email}/role", dependencies=[Depends(require_owner)])
def set_role(email: str, body: RoleIn, db: Session = Depends(get_db)):
    member = db.get(m.Member, email)
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없어요.")
    if body.role not in s.ROLES:
        raise HTTPException(400, "알 수 없는 역할이에요.")
    if member.role == body.role:
        return member.to_dict()
    owners = db.scalar(select(func.count()).select_from(m.Member).where(m.Member.role == "Owner")) or 0
    if member.role == "Owner" and owners <= 1:
        raise HTTPException(400, "Owner가 한 명은 있어야 해요. 다른 멤버를 먼저 Owner로 바꿔 주세요.")
    s.log_act(db, "역할 변경", f"{member.name} · {member.role} → {body.role}", "warn" if "Owner" in (member.role, body.role) else "ok")
    member.role = body.role
    db.commit()
    return member.to_dict()


class MemberGroupsIn(BaseModel):
    groups: list[str]


@router.put("/members/{email}/groups", dependencies=[Depends(require_owner)])
def set_member_groups(email: str, body: MemberGroupsIn, db: Session = Depends(get_db)):
    member = db.get(m.Member, email)
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없어요.")
    groups = [db.get(m.Group, gid) for gid in dict.fromkeys(body.groups)]
    if None in groups:
        raise HTTPException(400, "없는 그룹이 들어 있어요.")
    member.groups = groups
    s.log_act(db, "멤버 그룹 변경", f"{member.name} · {', '.join(g.name for g in groups) or '그룹 없음'}")
    db.commit()
    return member.to_dict()


# ---------- groups: which menus and builds their members see ----------

@router.get("/access")
def get_access(who: m.Member | None = Depends(viewer)):
    """Menus the viewer sees (null = all). Follows X-View-As while an Owner previews another member."""
    return {"menus": s.visible_menus(who), "role": who.role if who else None}


@router.get("/groups")
def list_groups(db: Session = Depends(get_db)):
    return {"groups": [g.to_dict() for g in db.scalars(select(m.Group).order_by(m.Group.ord))], "repos": githooks.build_repos(db),
            "menus": s.MENUS}


class GroupIn(BaseModel):
    name: str
    menus: list[str] = []
    allBuilds: bool = False
    repos: list[str] = []
    members: list[str] | None = None  # emails; None leaves membership unchanged


def _apply_group(db: Session, g: m.Group, body: GroupIn) -> None:
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "그룹 이름을 넣어 주세요.")
    if len(name) > 64:
        raise HTTPException(400, "그룹 이름은 64자까지예요.")
    if db.scalar(select(m.Group).where(func.lower(m.Group.name) == name.lower(), m.Group.id != g.id)):
        raise HTTPException(400, "같은 이름의 그룹이 있어요.")
    unknown = set(body.menus) - set(s.MENUS)
    if unknown:
        raise HTTPException(400, f"알 수 없는 메뉴예요: {', '.join(sorted(unknown))}")
    repos: list[str] = []
    for raw in body.repos:
        r = raw.strip().lower().removesuffix(".git")
        if not r:
            continue
        if r.count("/") != 1 or not all(r.split("/")):
            raise HTTPException(400, f"레포는 owner/name 형식으로 넣어 주세요: {raw}")
        if r not in repos:
            repos.append(r)
    if body.members is not None:
        found = [db.get(m.Member, e) for e in dict.fromkeys(body.members)]
        if None in found:
            raise HTTPException(400, "없는 멤버가 들어 있어요.")
        g.members = found
    g.name = name
    g.menus = [x for x in s.MENUS if x in body.menus]  # keep menu order stable
    g.all_builds = body.allBuilds
    g.repos = [] if body.allBuilds else repos


def _builds_label(g: m.Group) -> str:
    return "모든 빌드" if g.all_builds else (f"빌드 {len(g.repos)}개 레포" if g.repos else "빌드 없음")


@router.post("/groups", dependencies=[Depends(require_owner)])
def create_group(body: GroupIn, db: Session = Depends(get_db)):
    g = m.Group(id=s.new_id("g"), name="", menus=[], all_builds=False, repos=[])
    _apply_group(db, g, body)
    db.add(g)
    s.log_act(db, "그룹 생성", f"{g.name} · 메뉴 {len(g.menus)}개 · {_builds_label(g)}")
    db.commit()
    return g.to_dict()


@router.put("/groups/{group_id}", dependencies=[Depends(require_owner)])
def update_group(group_id: str, body: GroupIn, db: Session = Depends(get_db)):
    g = db.get(m.Group, group_id)
    if not g:
        raise HTTPException(404, "그룹을 찾을 수 없어요.")
    _apply_group(db, g, body)
    s.log_act(db, "그룹 권한 변경", f"{g.name} · 메뉴 {len(g.menus)}개 · {_builds_label(g)}")
    db.commit()
    return g.to_dict()


@router.delete("/groups/{group_id}", dependencies=[Depends(require_owner)])
def delete_group(group_id: str, db: Session = Depends(get_db)):
    g = db.get(m.Group, group_id)
    if not g:
        raise HTTPException(404, "그룹을 찾을 수 없어요.")
    s.log_act(db, "그룹 삭제", f"{g.name} · 멤버 {len(g.members)}명", "warn")
    db.delete(g)
    db.commit()
    return {"ok": True}


@router.get("/security")
def security(db: Session = Depends(get_db)):
    return {"sessions": s.session_list(db), "policy": s.get_setting(db, "policy")}


class PolicyIn(BaseModel):
    enforce2fa: bool
    sudoMinutes: int
    session: str
    lockout: str
    allowIps: str


@router.put("/security/policy", dependencies=[Depends(require("admin"))])
def save_policy(body: PolicyIn, db: Session = Depends(get_db)):
    if body.sudoMinutes not in (1, 5, 10, 15):
        raise HTTPException(400, "열람 유지 시간은 1, 5, 10, 15분 중에서 골라 주세요.")
    if not re.match(r"^\s*\d+\s*(시간|분)", body.session):
        raise HTTPException(400, "세션 만료 시간을 골라 주세요.")
    if not re.search(r"\d+\s*회 실패 시\s*\d+\s*(시간|분)", body.lockout):
        raise HTTPException(400, "로그인 실패 잠금 규칙을 골라 주세요.")
    ips = [x.strip() for x in body.allowIps.splitlines() if x.strip()]
    if ips and not any(ip.startswith("211.234.10.") or ip == s.CLIENT_IP for ip in ips):
        raise HTTPException(400, "내 IP가 허용 목록에 없어서 저장할 수 없어요.")
    before = s.get_setting(db, "policy")
    policy = s.set_setting(db, "policy", **body.model_dump())
    tfa = ""
    if body.enforce2fa != bool(before.get("enforce2fa")):
        tfa = " · 2단계 인증 강제 " + ("켬" if body.enforce2fa else "끔")
    s.log_act(db, "보안 정책 저장", f"열람 {body.sudoMinutes}분 · IP {len(ips)}개{tfa}", "warn" if tfa and not body.enforce2fa else "ok")
    db.commit()
    return policy


class ResetPasswordIn(BaseModel):
    clearTfa: bool = False


@router.post("/members/{email}/password", dependencies=[Depends(require_owner), Depends(require_sudo)])
def reset_password(email: str, body: ResetPasswordIn, db: Session = Depends(get_db)):
    """Owner sets a temporary password (shown once). The member must pick a new one at the next login."""
    member = db.get(m.Member, email)
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없어요.")
    if member.email == s.current_member(db).email:
        raise HTTPException(400, "내 비밀번호는 보안 화면에서 바꿔 주세요.")
    temp = authn.temporary_password()
    member.password_hash = authn.hash_password(temp)
    member.must_change_password = True
    member.failed_logins, member.locked_until = 0, None
    if body.clearTfa:
        member.set_tfa_state(None, None)
        member.recovery_codes, member.tfa_last_step = [], None
    db.execute(delete(m.LoginSession).where(m.LoginSession.member_email == member.email))
    s.log_act(db, "비밀번호 재설정", f"{member.name}" + (" · 2단계 인증 해제" if body.clearTfa else ""), "warn")
    db.commit()
    return {"password": temp, "member": member.to_dict()}
