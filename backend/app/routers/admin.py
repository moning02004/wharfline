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


class NameIn(BaseModel):
    name: str


NAME_MAX = 64  # e.g. "브랜드마케팅2팀 이미지 대리"


@router.put("/members/{email}/name")
def set_name(email: str, body: NameIn, db: Session = Depends(get_db)):
    """Owner or Admin: rename any member, themselves included. Others can't change names, not even their own."""
    me = s.current_member(db)
    if not me:
        raise HTTPException(401, "login_required")
    if me.role not in ("Owner", "Admin"):
        raise HTTPException(403, "Owner나 Admin만 이름을 바꿀 수 있어요.")
    member = db.get(m.Member, email)
    if not member:
        raise HTTPException(404, "멤버를 찾을 수 없어요.")
    name = " ".join(body.name.split())  # trim, and one space between words
    if not name:
        raise HTTPException(400, "이름을 적어 주세요.")
    if len(name) > NAME_MAX:
        raise HTTPException(400, f"이름은 {NAME_MAX}자까지예요.")
    if name != member.name:
        s.log_act(db, "이름 변경", f"{member.email} · {member.name} → {name}")
        member.name = name
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


# ---------- bulk add: one "그룹 계정" per line (a "| 그룹 | 계정 |" table works too) ----------

IMPORT_PASSWORD = "0000"  # everyone added in bulk starts here and must pick a new password at the first login
IMPORT_MAX_ROWS = 1000
NEW_GROUP_MENUS = ["jobs", "runs", "security"]  # a group made by the import; the Owner widens it afterwards
_EMAIL_RE = re.compile(r"^[^@\s|]+@[^@\s|]+\.[^@\s|]+$")
_SEPARATOR_RE = re.compile(r"^:?-{3,}:?$")
_PLAIN_RE = re.compile(r"^(.*?)[\s,]+([^\s,]+)$")  # "그룹 계정", split at the last space, tab or comma
_HEADERS = ({"그룹", "group"}, {"계정", "이메일", "account", "email"})


def parse_member_table(text: str) -> tuple[list[tuple[int, str, str]], list[dict]]:
    """Rows (line, group, email) and errors from lines "그룹 계정" or a Markdown table with the columns 그룹 and 계정."""
    rows: list[tuple[int, str, str]] = []
    errors: list[dict] = []
    for n, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line:
            continue

        def bad(reason: str) -> None:
            errors.append({"line": n, "text": line[:200], "reason": reason})

        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(_SEPARATOR_RE.match(c) for c in cells):
                continue
        else:  # "marketing2 user1@a.com": the last word is the account, everything before it the group
            parts = _PLAIN_RE.match(line)
            if not parts:
                bad("그룹 계정 형식으로 적어 주세요. 예: marketing2 user1@a.com")
                continue
            cells = [parts[1].strip(), parts[2]]
        if len(cells) == 2 and cells[0].lower() in _HEADERS[0] and cells[1].lower() in _HEADERS[1]:
            continue
        if len(cells) != 2:
            bad(f"칸이 {len(cells)}개예요. 그룹과 계정 두 칸만 적어 주세요.")
            continue
        group, email = cells[0], cells[1].lower()
        if not group:
            bad("그룹이 비어 있어요.")
        elif len(group) > 64:
            bad("그룹 이름은 64자까지예요.")
        elif not _EMAIL_RE.match(email) or len(email) > 255:
            bad(f"계정은 이메일로 적어 주세요: {cells[1] or '(빈 칸)'}")
        else:
            rows.append((n, group, email))
    if len(rows) > IMPORT_MAX_ROWS:
        errors.append({"line": 0, "text": "", "reason": f"한 번에 {IMPORT_MAX_ROWS}줄까지 올릴 수 있어요."})
    return rows, errors


class ImportIn(BaseModel):
    text: str
    apply: bool = False  # false: only show what would happen


@router.post("/members/import", dependencies=[Depends(require_owner)])
def import_members(body: ImportIn, db: Session = Depends(get_db)):
    """Owner only. New accounts are Viewers with the password 0000 and must change it at the first login;
    existing accounts keep their role and password and only join the listed groups. Missing groups are created."""
    if body.apply and not s.sudo_active(db):
        raise HTTPException(403, "sudo_required")
    rows, errors = parse_member_table(body.text)
    if not rows and not errors:
        errors.append({"line": 0, "text": "", "reason": "추가할 줄이 없어요. 한 줄에 하나씩 그룹 계정으로 적어 주세요."})

    groups = {g.name.lower(): g for g in db.scalars(select(m.Group))}
    new_groups: list[str] = []
    new_keys: set[str] = set()
    new_members: list[str] = []
    existing: list[str] = []
    joins: list[tuple[str, str]] = []  # (group name key, email)
    for _, group, email in rows:
        key = group.lower()
        if key not in groups and key not in new_keys:
            new_groups.append(group)
            new_keys.add(key)
        if email not in new_members and email not in existing:
            (existing if db.get(m.Member, email) else new_members).append(email)
        g = groups.get(key)
        if (key, email) not in joins and not (g and any(x.email == email for x in g.members)):
            joins.append((key, email))

    out = {"rows": len(rows), "newMembers": new_members, "existingMembers": existing, "newGroups": new_groups,
           "joins": len(joins), "errors": errors, "applied": False}
    if not body.apply:
        return out
    if errors:
        raise HTTPException(400, "틀린 줄을 고친 뒤 다시 올려 주세요.")

    base = s.new_id("g")
    for i, name in enumerate(new_groups):
        g = m.Group(id=f"{base}{i}", name=name, menus=list(NEW_GROUP_MENUS), all_builds=False, repos=[])
        db.add(g)
        groups[name.lower()] = g
    temp_hash = authn.hash_password(IMPORT_PASSWORD)  # one bcrypt for the whole upload
    for email in new_members:
        db.add(m.Member(email=email, name=email.split("@", 1)[0], role="Viewer", tfa=False, last="-",
                        password_hash=temp_hash, must_change_password=True))
    db.flush()
    for key, email in joins:
        member = db.get(m.Member, email)
        g = groups[key]
        if g not in member.groups:
            member.groups.append(g)
    s.log_act(db, "멤버 일괄 추가", f"새 멤버 {len(new_members)}명 · 기존 멤버 {len(existing)}명 · 새 그룹 {len(new_groups)}개 · 그룹 추가 {len(joins)}건",
              "warn" if new_members else "ok")
    db.commit()
    return {**out, "applied": True}


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
