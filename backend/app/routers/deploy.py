import asyncio
import base64
import binascii
import json
import re
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import bundles
from .. import events
from .. import executor
from .. import githooks
from .. import models as m
from .. import playinspect
from .. import runner
from .. import store as s
from ..db import get_db
from ..deps import build_scope, require, require_login, require_sudo, viewer
from .envs import replace_vars

router = APIRouter(prefix="/api", tags=["deploy"], dependencies=[Depends(require_login)])


def job_view(db: Session, job: m.Job, scope: set[str] | None, who: m.Member | None) -> dict:
    """`who` is the viewer (an Owner's X-View-As preview included); `canEdit` is shown for them."""
    j = job.to_dict()
    inv = s.inv_of(db, j)
    img = s.image_of(db, j)
    has_image = bool(j["image"])
    with_skip = lambda hs: [{**h, "skip": s.host_skip(h)} for h in hs]  # noqa: E731
    return {
        **j,
        "inventoryHostCount": len(inv["hosts"]) if inv else 0,
        "targetLabel": s.target_label(j["targets"], inv),
        "targetHosts": with_skip(s.target_hosts(inv, j["targets"])),
        "groups": {g: with_skip(hs) for g, hs in s.groups_of(inv).items()},
        "imageTags": img["tags"],
        "latestTag": img["tags"][0]["name"] if img["tags"] else None,
        "prevTag": s.prev_tag(db, j, img),
        "build": githooks.build_for_image(db, j["image"], scope) if has_image else None,
        "imageSourceRepo": db.get(m.Image, j["image"]).source_repo if has_image and db.get(m.Image, j["image"]) else None,
        "extraImages": [extra_view(db, x, scope) for x in job.extra_images or []],
        "canEdit": s.can_edit(who, job),
        # Who made the job: their name, or the email when the account is gone; None for jobs made before this was kept.
        "createdByName": (maker.name if (maker := db.get(m.Member, job.created_by)) else job.created_by) if job.created_by else None,
        # Playbook variables: plain ones with values, secret ones by name only (values never leave the server).
        "playVars": [list(x) for x in job.play_vars or []],
        "secretVarNames": list(secret.var_names) if (secret := db.get(m.JobSecretVars, job.id)) else [],
    }


def extra_view(db: Session, x: dict, scope: set[str] | None = None) -> dict:
    """An extra watched image with the tags Wharfline knows (newest first), its build repo and its CI build worth showing."""
    img = db.get(m.Image, x["ref"])
    tags = [t.name for t in img.tags] if img else []
    return {**x, "tags": tags, "latestTag": tags[0] if tags else None, "sourceRepo": img.source_repo if img else None,
            "build": githooks.build_for_image(db, x["ref"], scope)}


def member_names(db: Session) -> dict[str, str]:
    return {x.email: x.name for x in db.scalars(select(m.Member))}


def run_view(rec: m.Run, names: dict[str, str]) -> dict:
    """A run with the names of who asked for and decided an approval."""
    d = rec.to_dict()
    d["requestedByName"] = names.get(rec.requested_by or "", rec.requested_by)
    d["decidedByName"] = names.get(rec.decided_by or "", rec.decided_by)
    return d


def all_jobs(db: Session, who: m.Member | None) -> list[m.Job]:
    """The jobs `who` may see (store.can_see_job), in list order."""
    return [j for j in db.scalars(select(m.Job).order_by(m.Job.ord)) if s.can_see_job(who, j)]


NO_JOB = "작업을 찾을 수 없어요."
NO_RUN = "실행 기록을 찾을 수 없어요."


def seen_job(db: Session, job_id: str, who: m.Member | None) -> m.Job:
    """The job, or 404 when it is missing or hidden from `who`: a hidden job looks the same as a missing one."""
    job = db.get(m.Job, job_id)
    if not job or not s.can_see_job(who, job):
        raise HTTPException(404, NO_JOB)
    return job


def runs_query(db: Session, who: m.Member | None):
    """select(Run) limited to runs of jobs `who` may see."""
    ids = s.visible_job_ids(db, who)
    q = select(m.Run)
    return q if ids is None else q.where(m.Run.job_id.in_(ids))


def seen_run(db: Session, no: int, who: m.Member | None) -> m.Run:
    """The run, or 404 when it is missing or belongs to a job hidden from `who` (or a deleted job, for non-Admins)."""
    rec = db.get(m.Run, no)
    ids = s.visible_job_ids(db, who) if rec else set()
    if not rec or (ids is not None and rec.job_id not in ids):
        raise HTTPException(404, NO_RUN)
    return rec


ALERT_LIMIT = 8  # the dashboard's 알림 card shows this many, then "+N"
FAILED_DAYS = 7  # failed deploys older than this drop off the card


def ago(ts: float) -> str:
    sec = max(0, time.time() - ts)
    if sec < 60:
        return "방금"
    if sec < 3600:
        return f"{int(sec // 60)}분 전"
    if sec < 86400:
        return f"{int(sec // 3600)}시간 전"
    return f"{int(sec // 86400)}일 전"


def dashboard_alerts(db: Session, who: m.Member | None, hosts: list[m.Host], names: dict[str, str]) -> list[dict]:
    """What the viewer should look at now, most serious first.

    Each: {kind, tone, title, sub, to (route) or run (run no to open)}. Only things the viewer can see:
    deploys need the jobs or runs menu, servers the inventory menu, approvals the approve permission.
    """
    menus = s.visible_menus(who)
    sees = lambda menu: menus is None or menu in menus  # noqa: E731
    out: list[dict] = []

    if sees("inventory"):
        for h in hosts:
            if h.host_key == "changed":
                out.append({"kind": "hostKey", "tone": "bad", "title": f"{h.name} 호스트 키가 바뀌었어요",
                            "sub": f"{h.inventory.name} · {h.ip} · 확인 전까지 배포가 막혀요", "to": "/inventory"})

    if sees("jobs") or sees("runs"):
        jobs = {j.id for j in all_jobs(db, who)}
        cutoff = time.time() - FAILED_DAYS * 86400
        seen: set[str] = set()
        recent = db.scalars(select(m.Run).where(m.Run.started_at >= cutoff, m.Run.status.notin_(("approval", "rejected")))
                            .order_by(m.Run.no.desc()))
        for r in recent:
            if r.job_id in seen or r.job_id not in jobs:
                continue
            seen.add(r.job_id)  # only each job's latest run counts: a later success clears the failure
            if r.status == "bad":
                tags = [r.tag] if r.tag and r.tag != "-" else []
                tags += [f"{k} {v}" for k, v in (r.extra_tags or {}).items()]
                out.append({"kind": "failed", "tone": "bad", "title": f"{r.job} 배포 실패",
                            "sub": " · ".join([f"#{r.no}", *tags, ago(r.started_at or 0)]), "run": r.no})

    if s.can(who, "approve"):
        for r in db.scalars(select(m.Run).where(m.Run.status == "approval").order_by(m.Run.no)):
            asker = names.get(r.requested_by or "", r.requested_by) or r.by
            out.append({"kind": "approval", "tone": "warn", "title": f"{r.job} 승인 대기",
                        "sub": " · ".join(x for x in (f"#{r.no}", f"{asker}님 요청", r.tag if r.tag != "-" else "") if x), "run": r.no})

    if sees("inventory"):
        off: dict[str, list[m.Host]] = {}
        for h in hosts:
            if h.status == "off" and h.host_key != "changed":  # a changed key is already listed above
                off.setdefault(h.inventory.name, []).append(h)
        for inv, hs in off.items():
            if len(hs) == 1:
                title, sub = f"{hs[0].name} 응답 없음", f"{inv} · {hs[0].ip} · 배포에서 빠져요"
            else:
                title, sub = f"{inv} 서버 {len(hs)}대 응답 없음", f"{', '.join(h.name for h in hs)} · 배포에서 빠져요"
            out.append({"kind": "offline", "tone": "warn", "title": title, "sub": sub, "to": "/inventory"})

    if s.can(who, "admin"):  # the Owner can require 2FA for everyone (보안 설정)
        members = list(db.scalars(select(m.Member)))
        missing = sum(1 for x in members if not x.tfa)
        if missing:
            out.append({"kind": "tfa", "tone": "neutral", "title": f"2단계 인증 안 쓴 멤버 {missing}명",
                        "sub": f"멤버 {len(members)}명 중 {len(members) - missing}명 사용 중", "to": "/security"})
    return out


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    scope = s.build_scope(who)
    hosts = list(db.scalars(select(m.Host).order_by(m.Host.id)))
    online = sum(1 for h in hosts if h.status == "on")
    names = member_names(db)
    alerts = dashboard_alerts(db, who, hosts, names)
    return {
        "me": s.me_dict(who) if who else None,
        "stats": {
            "today": 7, "todayOk": 6, "todayBad": 1,
            "successRate": "96.4%", "successDelta": "+2.1%p",
            "hostsOnline": online, "hostsTotal": len(hosts),
            "avgDuration": "1m 31s",
        },
        "alerts": alerts[:ALERT_LIMIT],
        "alertsMore": max(0, len(alerts) - ALERT_LIMIT),
        "recentRuns": [run_view(r, names) for r in db.scalars(runs_query(db, who).order_by(m.Run.no.desc()).limit(5))],
        "pendingApprovals": [run_view(r, names) for r in db.scalars(runs_query(db, who).where(m.Run.status == "approval").order_by(m.Run.no))],
        "jobs": [job_view(db, j, scope, who) for j in all_jobs(db, who)],
    }


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
              who: m.Member | None = Depends(viewer)):
    """Only the jobs the viewer may see (store.can_see_job)."""
    return [job_view(db, j, scope, who) for j in all_jobs(db, who)]


class PlaybookIn(BaseModel):
    # upload: a playbook uploaded with its files (JobIn.files); path is the playbook among them
    source: str = Field(pattern="^(git|builtin|script|upload)$")
    url: str = ""
    branch: str = "main"
    path: str = ""
    key: str = ""


class ComposeIn(BaseModel):
    """A Docker Compose app. url: where its compose file lives; empty when the file was pasted in."""
    url: str = ""
    branch: str = "main"
    path: str = ""
    key: str = ""


class EditorsIn(BaseModel):
    groups: list[str] = []  # group ids
    members: list[str] = []  # member emails


class ScriptStep(BaseModel):
    """One step of an SSH script: a name for the log, and shell commands run on every target server."""
    name: str
    run: str


class FileIn(BaseModel):
    path: str
    content: str


class ExtraImageIn(BaseModel):
    """A watched image besides the main one. VAR becomes $VAR_IMAGE, $VAR_TAG and $VAR_IMAGE_REF."""
    image: str
    var: str
    sourceRepo: str | None = None  # Git repo whose CI builds it (owner/name); None leaves it as it is


class JobIn(BaseModel):
    name: str
    playbook: PlaybookIn
    script: list[ScriptStep] = []  # used when playbook.source == "script"
    servicePath: str = ""  # SSH script jobs: folder on the servers; default /srv/<job slug>
    files: list[FileIn] | None = None  # SSH script jobs: uploaded to SERVICE_PATH; None keeps the current files on edit
    extraImages: list[ExtraImageIn] = []
    imageSourceRepo: str | None = None  # build repo of the main image; None leaves it as it is
    inventory: str
    targets: list[str] = []
    image: str = ""
    envMode: str = Field(default="paste", pattern="^(paste|existing|none|copy)$")  # copy: a new set with envName's values
    envName: str | None = None
    envVars: list[list[str]] = []
    editors: EditorsIn = Field(default_factory=EditorsIn)
    hook: bool = False
    hookRule: str = "v"  # v | date | any | re:<regex>
    protected: bool = True
    lock: bool = True
    rollback: bool = True
    # Git playbook jobs only (playbook.source == "git"):
    playVars: list[list[str]] = []  # plain playbook variables [[name, value], ...]
    secretVars: list[list[str]] | None = None  # secret ones; None: none on create, keep the saved ones on edit
    copySecretVarsFrom: str | None = None  # create only (복제): copy the secret variables of this job id
    # Secret names whose saved value stays (edit: this job's, 복제: copySecretVarsFrom's) while secretVars
    # brings new values for others. The form never has the saved values, so it can change one without the rest.
    keepSecretVars: list[str] = []
    compose: ComposeIn | None = None  # a Docker Compose app: Wharfline writes the script (playbook.source must be "script")


class JobUpdate(JobIn):
    envMode: str = Field(default="keep", pattern="^(keep|paste|existing|none)$")  # keep: leave the .env as it is


BAD_PATH = "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml"
NO_EDIT = "이 작업을 고칠 권한이 없어요."

# Activity log labels for PUT, in form order.
FIELD_LABELS = {
    "name": "이름", "playbook": "배포 방법", "files": "파일", "images": "추가 이미지", "vars": "플레이북 변수",
    "target": "배포 대상", "image": "이미지", "env": "환경 변수",
    "editors": "편집 권한", "hook": "자동 배포", "protected": "운영 보호", "lock": "동시 실행 잠금", "rollback": "실패 시 되돌리기",
}


# ---------- shared by create and update ----------

def check_name(db: Session, raw: str, self_id: str | None = None) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(400, "이름을 넣어 주세요.")
    q = select(m.Job).where(m.Job.name == name)
    if self_id:
        q = q.where(m.Job.id != self_id)
    if db.scalar(q):
        raise HTTPException(400, "같은 이름의 작업이 있어요.")
    return name


def check_target(db: Session, inventory: str, targets: list[str]) -> None:
    inv = db.scalar(select(m.Inventory).where(m.Inventory.name == inventory))
    if not inv:
        raise HTTPException(400, "인벤토리를 찾을 수 없어요.")
    if not inv.hosts:
        raise HTTPException(400, "인벤토리에 서버가 없어요. 서버를 먼저 추가해 주세요.")
    unknown = set(targets) - {h.grp for h in inv.hosts}
    if unknown:
        raise HTTPException(400, f"인벤토리에 없는 그룹이에요: {', '.join(sorted(unknown))}")


def check_editors(db: Session, ed: EditorsIn) -> dict[str, list[str]]:
    """Known group ids and member emails, de-duplicated in the order given."""
    groups = list(dict.fromkeys(g.strip() for g in ed.groups if g.strip()))
    members = list(dict.fromkeys(e.strip() for e in ed.members if e.strip()))
    known_groups = set(db.scalars(select(m.Group.id).where(m.Group.id.in_(groups)))) if groups else set()
    if missing := [g for g in groups if g not in known_groups]:
        raise HTTPException(400, f"없는 그룹이에요: {', '.join(missing)}")
    known_members = set(db.scalars(select(m.Member.email).where(m.Member.email.in_(members)))) if members else set()
    if missing := [e for e in members if e not in known_members]:
        raise HTTPException(400, f"없는 멤버예요: {', '.join(missing)}")
    return {"groups": groups, "members": members}


MAX_SCRIPT_STEPS, MAX_STEP_NAME, MAX_STEP_RUN = 20, 60, 4000
SERVICE_PATH_RE = re.compile(r"^/(?!.*(^|/)\.\.?(/|$))[A-Za-z0-9._/-]{1,254}$")


def check_service_path(text: str, job_name: str) -> str:
    """Absolute folder for an SSH script job; empty means /srv/<job slug>."""
    raw = text.strip()
    path = raw.rstrip("/") or ("/" if raw else f"/srv/{s.app_slug(job_name)}")
    if not SERVICE_PATH_RE.match(path):
        raise HTTPException(400, "서비스 경로는 /srv/api-server처럼 /로 시작하는 폴더예요. ..은 쓸 수 없어요.")
    return path


def check_script(steps: list[ScriptStep]) -> list[dict[str, str]]:
    """Validate SSH script steps and return them as stored ([{name, run}])."""
    if not steps:
        raise HTTPException(400, "스크립트 단계를 하나 이상 넣어 주세요.")
    if len(steps) > MAX_SCRIPT_STEPS:
        raise HTTPException(400, f"스크립트 단계는 {MAX_SCRIPT_STEPS}개까지 넣을 수 있어요.")
    out = []
    for i, st in enumerate(steps, 1):
        name, run = st.name.strip(), st.run.replace("\r\n", "\n").strip()
        if not name or len(name) > MAX_STEP_NAME:
            raise HTTPException(400, f"{i}번째 단계의 이름을 1~{MAX_STEP_NAME}자로 적어 주세요.")
        if not run:
            raise HTTPException(400, f"'{name}' 단계에 실행할 명령을 적어 주세요.")
        if len(run) > MAX_STEP_RUN or "\x00" in run:
            raise HTTPException(400, f"'{name}' 단계의 명령이 너무 길거나 쓸 수 없는 문자가 있어요.")
        out.append({"name": name, "run": run})
    return out


VAR_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,23}$")
RESERVED_VARS = {"SERVICE_PATH", "ENV_FILE", "IMAGE", "IMAGE_TAG", "IMAGE_REF"}
MAX_EXTRA_IMAGES = 10


SOURCE_REPO_RE = re.compile(r"^[^/\s]+(/[^/\s]+)+$")  # owner/name, or group/subgroup/name on GitLab


def set_source_repo(db: Session, ref: str | None, repo: str | None) -> None:
    """Link an image to the Git repo whose CI builds it (shared by every job using the image). None: leave it."""
    if ref is None or repo is None or not s.can(s.current_member(db), "resources"):
        return  # build repos are an Owner/Admin setting; a Deployer's value is ignored
    repo = repo.strip().lower().removesuffix(".git")
    if repo and not SOURCE_REPO_RE.match(repo):
        raise HTTPException(400, f"빌드 레포 {repo}는 owner/name 형식으로 넣어 주세요. 예: moning02004/wharfline")
    img = db.get(m.Image, ref)
    if img and (img.source_repo or "") != repo:
        img.source_repo = repo or None
        s.log_act(db, "빌드 레포 연결", f"{ref} ← {repo or '없음'}")


def derived_images(db: Session, files: list[dict] | None, current: list[dict] | None) -> tuple[str | None, list[dict]]:
    """SSH script jobs track what their files name, so nobody enters it twice.

    Returns (main image ref, other watched images). `${IMAGE_TAG}` is the main image; `${NAME_TAG}` becomes
    variable NAME; a written tag is watched too (a new push redeploys, the file decides the version).
    """
    before = {(x["ref"], x.get("var", "")): x for x in current or []}
    main: str | None = None
    out: list[dict] = []
    for it in bundles.file_images(files or []):
        try:
            ref, _ = s.parse_image(it["ref"])  # docker.io/library/... for Docker Hub names
        except HTTPException:
            continue
        if it["var"] == "":
            main = main or ref
            s.ensure_image(db, ref, "latest")
            continue
        var = it["var"] or ""
        names = {f"{var}_IMAGE", f"{var}_TAG", f"{var}_IMAGE_REF", it.get("tagVar") or ""}
        if var and (not VAR_RE.match(var) or names & RESERVED_VARS):
            continue
        if any(x["ref"] == ref and x["var"] == var for x in out):
            continue  # images may share a variable (one version for backend and frontend)
        s.ensure_image(db, ref, "latest")
        item = {"ref": ref, "var": var, "defaultTag": "latest", "literal": it["literal"],
                "tagNow": before.get((ref, var), {}).get("tagNow", "-")}
        if var and it.get("tagVar") and it["tagVar"] != f"{var}_TAG":
            item["tagVar"] = it["tagVar"]  # ${APP_VERSION}: the file reads this name, so the run exports it too
        out.append(item)
    return main, out


def check_extra_images(db: Session, items: list[ExtraImageIn], current: list[dict] | None) -> list[dict[str, str]]:
    """Validate extra watched images; register them so new tags and webhooks are tracked. Keeps tagNow of unchanged ones."""
    if len(items) > MAX_EXTRA_IMAGES:
        raise HTTPException(400, f"이미지는 {MAX_EXTRA_IMAGES}개까지 더할 수 있어요.")
    before = {(x["ref"], x["var"]): x for x in current or []}
    out, seen = [], set()
    for it in items:
        var = it.var.strip().upper()
        if not VAR_RE.match(var):
            raise HTTPException(400, f'변수 이름 "{it.var}"은(는) 쓸 수 없어요. 영문 대문자, 숫자, _로 적어 주세요. 예: API')
        names = {f"{var}_IMAGE", f"{var}_TAG", f"{var}_IMAGE_REF"}
        if names & RESERVED_VARS or var in seen:
            raise HTTPException(400, f"변수 이름 {var}이(가) 다른 이미지나 Wharfline 변수와 겹쳐요.")
        seen.add(var)
        ref, tag = s.parse_image(it.image.strip())
        s.ensure_image(db, ref, tag)
        db.flush()
        set_source_repo(db, ref, it.sourceRepo)
        out.append({"ref": ref, "var": var, "defaultTag": tag, "tagNow": before.get((ref, var), {}).get("tagNow", "-")})
    return out


MAX_FILE_VERSIONS = 50


def check_hook_rule(rule: str) -> str:
    rule = rule.strip() or "v"
    if rule in githooks.HOOK_RULES:
        return rule
    if rule.startswith("re:") and 3 < len(rule) <= 200:
        try:
            re.compile(rule[3:])
            return rule
        except re.error as e:
            raise HTTPException(400, f"자동 배포 규칙의 정규식이 틀렸어요: {e}") from e
    raise HTTPException(400, "자동 배포 규칙은 v, 날짜, 전부, 또는 정규식(re:…) 중에서 골라 주세요.")


def file_changes(old: list[dict] | None, new: list[dict] | None) -> dict[str, list[str]]:
    a = {f["path"]: f["content"] for f in old or []}
    b = {f["path"]: f["content"] for f in new or []}
    return {"added": sorted(set(b) - set(a)), "changed": sorted(p for p in set(a) & set(b) if a[p] != b[p]),
            "removed": sorted(set(a) - set(b))}


def save_file_version(db: Session, job: m.Job, old: list[dict] | None, new: list[dict] | None) -> bool:
    """A new version of the job's files when they changed. Keeps the last MAX_FILE_VERSIONS versions."""
    changes = file_changes(old, new)
    if not any(changes.values()):
        return False
    ver = (job.files_ver or 0) + 1
    db.add(m.JobFileVersion(job_id=job.id, ver=ver, files=list(new or []), changes=changes, created_at=time.time(),
                            created_by=s.actor_name(db)))
    job.files_ver = ver
    stale = db.scalars(select(m.JobFileVersion).where(m.JobFileVersion.job_id == job.id, m.JobFileVersion.ver <= ver - MAX_FILE_VERSIONS))
    for v in stale:
        db.delete(v)
    return True


BAD_COMPOSE_PATH = "compose 파일 경로는 레포 안의 .yml 파일이에요. 예: docker-compose.yml"
COMPOSE_STEPS = [
    {"name": "이미지 받기", "run": 'cd "$SERVICE_PATH"\ndocker compose pull'},
    {"name": "컨테이너 교체", "run": 'cd "$SERVICE_PATH"\ndocker compose up -d --remove-orphans'},
    {"name": "정리", "run": "docker image prune -f"},
]


def compose_files(files: list[dict] | None) -> list[dict]:
    """A Compose job has exactly one file, always saved under the name docker compose looks for."""
    if not files or len(files) != 1 or not files[0]["content"].strip():
        raise HTTPException(400, "compose 파일을 넣어 주세요.")
    return [{"path": executor.COMPOSE_FILE, "content": files[0]["content"]}]


def resolve_playbook(db: Session, body: JobIn) -> tuple[m.Repo | None, str | None, str | None, str, list[dict[str, str]] | None, str | None]:
    """Validate the deploy method + image; reuse or create the repo and register the image.

    Returns (repo, path, image ref, tag, script, service path). An SSH script job has no repo or path.
    """
    pb = body.playbook
    image_text = body.image.strip()
    ref, tag = s.parse_image(image_text) if image_text else (None, "latest")
    script = service_path = None
    if body.compose is not None:
        if pb.source != "script":
            raise HTTPException(400, "Compose 배포는 SSH로 실행해요. 배포 방법을 확인해 주세요.")
        body.script = [ScriptStep(**st) for st in COMPOSE_STEPS]
    if pb.source == "script":
        script = check_script(body.script)
        service_path = check_service_path(body.servicePath, body.name)
        repo, path = None, None
        if body.compose is not None and body.compose.url.strip():
            path = body.compose.path.strip()
            if not s.PLAYBOOK_PATH_RE.match(path):
                raise HTTPException(400, BAD_COMPOSE_PATH)
            repo = s.ensure_git_repo(db, body.compose.url, body.compose.branch, body.compose.key.strip())
    elif pb.source == "builtin":
        if not ref:
            raise HTTPException(400, "기본 플레이북은 띄울 이미지가 있어야 해요.")
        repo, path = s.builtin_repo(db), s.BUILTIN_BOOK
    elif pb.source == "upload":
        path = pb.path.strip()
        if not s.PLAYBOOK_PATH_RE.match(path):
            raise HTTPException(400, "실행할 플레이북을 골라 주세요. 올린 파일 중 .yml 파일이에요.")
        repo = None
    else:
        path = pb.path.strip()
        if not s.PLAYBOOK_PATH_RE.match(path):
            raise HTTPException(400, BAD_PATH)
        repo = s.ensure_git_repo(db, pb.url, pb.branch, pb.key.strip())
    if ref:
        s.ensure_image(db, ref, tag)
    return repo, path, ref, tag, script, service_path


def playbook_files(files: list[FileIn] | None, book: str, current: list[dict] | None = None) -> list[dict[str, str]]:
    """An uploaded playbook's files: checked like script files, holding the playbook, and no private key.

    files None keeps the current ones (edit without a new upload)."""
    if files is None:
        if not current:
            raise HTTPException(400, "플레이북 파일을 올려 주세요.")
        out = [dict(f) for f in current]
    else:
        out = bundles.check_files([f.model_dump() for f in files])
    if not any(f["path"] == book for f in out):
        raise HTTPException(400, f"올린 파일에 {book}이(가) 없어요.")
    bad = next((f["path"] for f in out if bundles.PRIVATE_KEY.search(f["content"])), None)
    if bad:
        raise HTTPException(400, f"{bad}은(는) 개인키로 보여요. 개인키는 플레이북과 함께 올리지 않아요.")
    return out


def existing_env(db: Session, env_name: str | None) -> str:
    if not s.env_by_name(db, env_name or ""):
        raise HTTPException(400, "저장된 환경 변수를 찾을 수 없어요.")
    return env_name or ""


def new_env_set(db: Session, job_name: str, vars_: list[list[str]]) -> str:
    """A new .env set named after the job ("api · prod" -> "api.prod")."""
    env_name = re.sub(r"\s+", "-", re.sub(r"\s*·\s*", ".", job_name))
    if s.env_by_name(db, env_name):
        raise HTTPException(400, f"환경 변수 {env_name}이(가) 이미 있어요. '저장된 것 쓰기'를 골라 주세요.")
    s.validate_vars(vars_)
    env = m.EnvSet(id=s.new_id("e"), name=env_name, ver=1, updated=f"방금 · {s.actor_name(db)}")
    env.set_vars(vars_)
    db.add(env)
    return env_name


# ---------- playbook variables (Git playbook jobs only) ----------

NOT_GIT_PLAY = "플레이북 변수는 Git 플레이북 작업에서만 쓸 수 있어요."
PLAY_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
MAX_PLAY_VARS, MAX_PLAY_VALUE = 50, 4096
# Variables Wharfline passes to every playbook (runner.extra_vars); extra images add <var>_image, <var>_tag, <var>_image_ref.
WHARFLINE_PLAY_VARS = {"image", "image_tag", "image_ref", "env_file", "app_name", "registry_host", "registry_user",
                       "registry_password", "env_src"}
# Connection settings and magic variables a playbook variable must never override.
ANSIBLE_CONN_RE = re.compile(r"^ansible_(host|port|user|password|pass|ssh_\w*|private_key_file|become\w*|sudo\w*|su\w*|connection"
                             r"|shell_\w*|python_interpreter|remote_\w*|timeout|pipelining)$")
ANSIBLE_SPECIAL = {"hostvars", "groups", "group_names", "inventory_hostname", "inventory_hostname_short", "play_hosts",
                   "ansible_play_hosts", "environment", "omit"}


def reserved_play_var(name: str, extra_images: list[dict] | None) -> bool:
    if name in WHARFLINE_PLAY_VARS or name in ANSIBLE_SPECIAL or ANSIBLE_CONN_RE.match(name):
        return True
    image_vars = runner.extra_image_vars({"extraImages": extra_images or []})
    return name in {k.lower() for k in image_vars}


def clean_play_vars(pairs: list[list[str]]) -> list[list[str]]:
    """[[name, value], ...] with names trimmed; each name and value checked on its own."""
    out = []
    for pair in pairs:
        if len(pair) != 2:
            raise HTTPException(400, "변수는 [이름, 값] 형식이어야 해요.")
        name, value = pair[0].strip(), pair[1]
        if not PLAY_VAR_RE.match(name):
            raise HTTPException(400, f'"{name or "(빈 이름)"}"은(는) 변수 이름으로 쓸 수 없어요. 영문, 숫자, _로 적고 숫자로 시작하지 않게 해 주세요.')
        if len(value) > MAX_PLAY_VALUE:
            raise HTTPException(400, f"{name} 값이 너무 길어요 (최대 {MAX_PLAY_VALUE}자).")
        out.append([name, value])
    return out


def check_play_var_names(names: list[str], extra_images: list[dict] | None) -> None:
    """Plain and secret names together: at most MAX_PLAY_VARS, no repeats, none Wharfline or Ansible uses."""
    if len(names) > MAX_PLAY_VARS:
        raise HTTPException(400, f"플레이북 변수는 일반과 비밀을 합쳐 {MAX_PLAY_VARS}개까지 넣을 수 있어요.")
    seen: set[str] = set()
    for name in names:
        if reserved_play_var(name, extra_images):
            raise HTTPException(400, f"변수 이름 {name}은(는) Wharfline이나 Ansible 접속에 쓰는 이름이라 쓸 수 없어요.")
        if name in seen:
            raise HTTPException(400, f"변수 이름 {name}이(가) 두 번 들어 있어요.")
        seen.add(name)


def resolve_play_vars(db: Session, me: m.Member | None, body: JobIn, job: m.Job | None,
                      extra_images: list[dict] | None) -> tuple[list[list[str]] | None, list[list[str]], list[list[str]]]:
    """Validate the playbook variables. Returns (play_vars to store, secret vars to store, the job's current secret vars).

    Writing secret values (new ones, a copy, or changing/removing saved ones) needs the "env" permission;
    changing saved ones also needs a recent password check, like pasting over a .env.
    """
    git = body.playbook.source in ("git", "upload")  # playbooks the member brings (not the built-in one)
    copy_from = (body.copySecretVarsFrom or "").strip() if job is None else ""  # create only
    if not git and (body.playVars or body.secretVars or copy_from):
        raise HTTPException(400, NOT_GIT_PLAY)
    row = db.get(m.JobSecretVars, job.id) if job else None
    current = row.get_vars() if row else []
    if not git:
        plain, secret = None, []
    else:
        plain = clean_play_vars(body.playVars)
        base = current
        if copy_from:
            src = db.get(m.Job, copy_from)
            if not src or not s.can_see_job(s.current_member(db), src):
                raise HTTPException(400, "복제할 작업을 찾을 수 없어요.")
            src_row = db.get(m.JobSecretVars, src.id)
            base = src_row.get_vars() if src_row else []
        keep = {n.strip() for n in body.keepSecretVars}
        if keep:  # new values for some, the saved value for the names kept
            typed = clean_play_vars(body.secretVars or [])
            have = {k for k, _ in typed}
            secret = typed + [[k, v] for k, v in base if k in keep and k not in have]
        elif body.secretVars is not None:
            secret = clean_play_vars(body.secretVars)
        else:
            secret = base  # edit without new values: keep the saved ones (복제: the source's)
        check_play_var_names([k for k, _ in plain] + [k for k, _ in secret], extra_images)
    if secret != current:
        if not s.can(me, "env"):
            raise HTTPException(403, s.NO_PERM)
        if current and not s.sudo_active(db):
            raise HTTPException(403, "sudo_required")
    return plain, secret, current


def save_secret_vars(db: Session, job_id: str, vars_: list[list[str]]) -> None:
    """Replace the job's secret variables; an empty list removes them."""
    row = db.get(m.JobSecretVars, job_id)
    if not vars_:
        if row:
            db.delete(row)
        return
    if not row:
        row = m.JobSecretVars(job_id=job_id)
        db.add(row)
    row.set_vars(vars_)


# ---------- endpoints ----------

@router.post("/jobs", dependencies=[Depends(require("job_create"))])
def create_job(body: JobIn, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
               who: m.Member | None = Depends(viewer)):
    me = s.current_member(db)
    if body.envMode == "paste" and not s.can(me, "env"):
        raise HTTPException(403, s.NO_PERM)  # pasting writes new .env values
    if not s.can(me, "run_protected"):
        body.protected, body.hook, body.hookRule = True, False, "v"  # Deployers: protected on, auto-deploy off
    name = check_name(db, body.name)
    check_target(db, body.inventory, body.targets)
    editors = check_editors(db, body.editors)
    repo, path, ref, tag, script, service_path = resolve_playbook(db, body)
    db.flush()
    set_source_repo(db, ref, body.imageSourceRepo)

    if body.envMode == "none":
        env_name = ""  # no .env for this job; one can be attached later
    elif body.envMode == "existing":
        env_name = existing_env(db, body.envName)
    elif body.envMode == "copy":  # 복제: the values of another set, in a set of its own (never shown to the member)
        src = db.scalar(select(m.EnvSet).where(m.EnvSet.name == existing_env(db, body.envName)))
        env_name = new_env_set(db, name, src.get_vars())
    else:
        env_name = new_env_set(db, name, body.envVars)

    files = bundles.check_files([f.model_dump() for f in body.files or []]) if script is not None else None
    if body.playbook.source == "upload":
        files = playbook_files(body.files, path or "")
    if body.compose is not None:
        files = compose_files(files)
    if script is not None:  # SSH script: tracked images come from the files
        ref, extras = derived_images(db, files, None)
        tag = "latest"
    else:
        extras = check_extra_images(db, body.extraImages, None)
    play_vars, secret_vars, _ = resolve_play_vars(db, me, body, None, extras)
    job = m.Job(
        id=s.new_id("j"), name=name, image=ref, default_tag=tag, repo=repo.name if repo else None, book=path, script=script, service_path=service_path,
        files=files,
        extra_images=extras,
        inventory=body.inventory, targets=body.targets, env=env_name, hook=body.hook, hook_rule=check_hook_rule(body.hookRule), protected=body.protected,
        lock=body.lock, rollback=body.rollback, editors=editors, created_by=me.email if me else None,
        play_vars=play_vars, compose=body.compose is not None,
    )
    db.add(job)
    db.flush()
    save_secret_vars(db, job.id, secret_vars)
    save_file_version(db, job, None, job.files)
    how = f"{repo.name}/{path}" if repo else f"올린 플레이북 {path}" if body.playbook.source == "upload" else f"SSH 스크립트 {len(script or [])}단계"
    s.log_act(db, "배포 작업 생성", f"{name} · {how}")
    db.commit()
    return job_view(db, job, scope, who)


@router.put("/jobs/{job_id}", dependencies=[Depends(require("job_edit"))])
def update_job(job_id: str, body: JobUpdate, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
               who: m.Member | None = Depends(viewer)):
    me = s.current_member(db)
    job = seen_job(db, job_id, me)
    if not s.can_edit(me, job):  # the signed-in member, never the X-View-As preview
        raise HTTPException(403, NO_EDIT)
    if body.envMode == "paste" and not s.can(me, "env"):
        raise HTTPException(403, s.NO_PERM)  # pasting writes .env values
    if not s.can(me, "run_protected"):
        body.protected, body.hook, body.hookRule = job.protected, job.hook, job.hook_rule  # Deployers can't change 운영 보호 or 자동 배포
    name = check_name(db, body.name, self_id=job.id)
    check_target(db, body.inventory, body.targets)
    editors = check_editors(db, body.editors)

    # Pasting over the job's current set overwrites secrets: that needs a recent password re-check.
    current_set = db.scalar(select(m.EnvSet).where(m.EnvSet.name == job.env)) if job.env else None
    if body.envMode == "paste" and current_set and not s.sudo_active(db):
        raise HTTPException(403, "sudo_required")

    repo, path, ref, tag, script, service_path = resolve_playbook(db, body)
    db.flush()
    set_source_repo(db, ref, body.imageSourceRepo)
    files = None if script is None else job.files if body.files is None else bundles.check_files([f.model_dump() for f in body.files])
    if body.playbook.source == "upload":
        files = playbook_files(body.files, path or "", job.files if job.repo is None and job.script is None else None)
    if body.compose is not None:
        files = compose_files(files)
    if script is not None:  # SSH script: tracked images come from the files
        ref, extra_images = derived_images(db, files, job.extra_images)
        tag = "latest"
    else:
        extra_images = check_extra_images(db, body.extraImages, job.extra_images)
    play_vars, secret_vars, current_secret = resolve_play_vars(db, me, body, job, extra_images)

    changed: list[str] = []
    env_name = job.env
    if body.envMode == "none":
        env_name = ""
    elif body.envMode == "existing":
        env_name = existing_env(db, body.envName)
    elif body.envMode == "paste":
        if current_set:
            s.validate_vars(body.envVars)
            if any(s.diff_vars(current_set.get_vars(), body.envVars).values()):
                replace_vars(current_set, body.envVars, f"방금 · {s.actor_name(db)}")
                changed.append("env")
        else:
            env_name = new_env_set(db, name, body.envVars)

    new = {
        "name": name, "playbook": (repo.name if repo else None, path, script, service_path, body.compose is not None), "files": files, "images": [{k: x.get(k) for k in ("ref", "var", "defaultTag", "literal", "tagVar")} for x in extra_images], "target": (body.inventory, list(body.targets)),
        "image": (ref, tag), "env": env_name, "editors": editors,
        "hook": (body.hook, check_hook_rule(body.hookRule)), "protected": body.protected, "lock": body.lock, "rollback": body.rollback,
        "vars": (play_vars or [], secret_vars),  # secret values are compared, never logged
    }
    old = {
        "name": job.name, "playbook": (job.repo, job.book, job.script, job.service_path, job.compose), "files": job.files,
        "images": [{k: x.get(k) for k in ("ref", "var", "defaultTag", "literal", "tagVar")} for x in job.extra_images or []], "target": (job.inventory, list(job.targets or [])),
        "image": (job.image, job.default_tag), "env": job.env, "editors": job.to_dict()["editors"],
        "hook": (job.hook, job.hook_rule), "protected": job.protected, "lock": job.lock, "rollback": job.rollback,
        "vars": ([list(x) for x in job.play_vars or []], current_secret),
    }
    changed += [k for k in new if new[k] != old[k] and k not in changed]

    job.name, job.repo, job.book, job.script, job.service_path = name, repo.name if repo else None, path, script, service_path
    job.compose = body.compose is not None
    save_file_version(db, job, job.files, files)
    job.files, job.extra_images = files, extra_images
    job.inventory, job.targets = body.inventory, list(body.targets)
    job.image, job.default_tag = ref, tag
    job.env, job.editors = env_name, editors
    job.hook, job.protected, job.lock, job.rollback = body.hook, body.protected, body.lock, body.rollback
    job.hook_rule = check_hook_rule(body.hookRule)
    if secret_vars != current_secret:
        save_secret_vars(db, job.id, secret_vars)
    job.play_vars = play_vars

    if changed:
        labels = ", ".join(FIELD_LABELS[k] for k in FIELD_LABELS if k in changed)
        s.log_act(db, "배포 작업 수정", f"{name} · {labels}")
    db.commit()
    db.refresh(job)  # reload playbook_repo when the repo changed
    return job_view(db, job, scope, who)


@router.delete("/jobs/{job_id}", dependencies=[Depends(require("job_edit")), Depends(require_sudo)])
def delete_job(job_id: str, db: Session = Depends(get_db)):
    """Delete a deploy job and its file versions. Its runs stay in the history; its .env set and images stay too.

    Nothing on the servers changes: running containers keep running.
    """
    me = s.current_member(db)
    job = seen_job(db, job_id, me)
    if not s.can_edit(me, job) or (job.protected and not s.can(me, "run_protected")):
        raise HTTPException(403, NO_EDIT)
    busy = db.scalar(select(m.Run.no).where(m.Run.job_id == job.id, m.Run.status.in_(("run", "approval"))).limit(1))
    if busy:
        raise HTTPException(400, f"#{busy} 실행이 진행 중이거나 승인을 기다리고 있어 지울 수 없어요. 끝나거나 취소된 뒤에 지워 주세요.")
    s.log_act(db, "배포 작업 삭제", job.name, "warn")
    db.delete(job)  # file versions and secret playbook variables go with it (ON DELETE CASCADE)
    db.commit()
    return {"ok": True}


class ComposeFetchIn(BaseModel):
    url: str
    branch: str = "main"
    path: str
    key: str = ""


@router.post("/compose/fetch")
async def fetch_compose(body: ComposeFetchIn, db: Session = Depends(get_db)):
    """Read a compose file from a repo for the job form: the same access the job will use when it runs."""
    me = s.current_member(db)
    if not s.can(me, "job_create") and not s.can(me, "job_edit"):
        raise HTTPException(403, s.NO_PERM)
    url, branch, path = body.url.strip(), body.branch.strip() or "main", body.path.strip()
    if not s.GIT_URL_RE.match(url):
        raise HTTPException(400, "저장소 주소를 확인해 주세요. 예: https://github.com/org/app.git")
    if not s.BRANCH_RE.match(branch):
        raise HTTPException(400, "브랜치 이름을 확인해 주세요. 예: main")
    if not s.PLAYBOOK_PATH_RE.match(path):
        raise HTTPException(400, BAD_COMPOSE_PATH)
    existing = db.scalar(select(m.Repo).where(m.Repo.url == url, m.Repo.branch == branch))
    key, auth = (s.repo_key(db, existing), existing.auth) if existing else s.repo_key_for(db, url, body.key.strip())
    try:
        content, commit = await executor.read_repo_file(executor.git_access("", url, branch, auth, key), branch, path)
    except executor.RepoFileError as e:
        raise HTTPException(400, str(e)) from None
    return {"content": content, "commit": commit}


class HookIn(BaseModel):
    on: bool


@router.put("/jobs/{job_id}/hook", dependencies=[Depends(require("job_edit"))])
def set_hook(job_id: str, body: HookIn, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
             who: m.Member | None = Depends(viewer)):
    """Turn 자동 배포 on or off without opening the job form (e.g. during maintenance)."""
    me = s.current_member(db)
    job = seen_job(db, job_id, me)
    if not s.can_edit(me, job) or not s.can(me, "run_protected"):  # Deployers can't change 자동 배포
        raise HTTPException(403, NO_EDIT)
    if body.on and not job.image and not job.extra_images:
        raise HTTPException(400, "추적하는 이미지가 없어서 자동 배포를 켤 수 없어요.")
    if job.hook != body.on:
        job.hook = body.on
        s.log_act(db, "자동 배포 " + ("켜기" if body.on else "끄기"), job.name, "ok" if body.on else "warn")
        db.commit()
    return job_view(db, job, scope, who)


class RunIn(BaseModel):
    tag: str = "latest"
    groups: list[str] = []
    rollback: bool = False
    extraTags: dict[str, str] = {}  # {VAR: tag} for extra images; missing ones keep their current tag


@router.post("/jobs/{job_id}/runs", dependencies=[Depends(require("run"))])
async def run_job(job_id: str, body: RunIn, db: Session = Depends(get_db)):  # async: the runner schedules a task on the event loop
    job = seen_job(db, job_id, s.current_member(db))
    j = job.to_dict()
    hosts = [h for h in s.target_hosts(s.inv_of(db, j), body.groups) if not s.host_skip(h)]
    if not hosts:
        raise HTTPException(400, "배포할 수 있는 서버가 없어요.")
    tag = body.tag.strip() or "latest"
    if job.image:
        if tag != "latest" and not s.TAG_RE.match(tag):
            raise HTTPException(400, "태그는 영문, 숫자, . _ - 만 쓸 수 있어요. 예: v1.2.0")
        s.ensure_image(db, job.image, tag, pushed="직접 입력")  # a typed tag is remembered on the image
        db.flush()
    else:
        tag = "-"  # nothing to pull; the tag is ignored
    extras = {x["var"]: x for x in job.extra_images or [] if x["var"]}
    for var, t in body.extraTags.items():
        t = t.strip()
        if var not in extras:
            raise HTTPException(400, f"이 작업에 {var} 이미지가 없어요.")
        if t != "latest" and not s.TAG_RE.match(t):
            raise HTTPException(400, f"{var} 태그는 영문, 숫자, . _ - 만 쓸 수 있어요.")
        s.ensure_image(db, extras[var]["ref"], t, pushed="직접 입력")
    db.flush()
    trigger = "되돌리기" if body.rollback else "수동 실행"
    me = s.current_member(db)
    email = me.email if me else None
    if job.protected and not s.can(me, "run_protected"):
        return runner.request_approval(db, j, body.groups, tag, trigger, email, extra_tags=body.extraTags)
    check_lock(job)
    return runner.start_run(db, j, body.groups, tag, trigger, requested_by=email, extra_tags=body.extraTags)


class UploadIn(BaseModel):
    name: str
    data: str  # base64


@router.post("/bundles/parse", dependencies=[Depends(require("job_create"))])
def parse_bundle(body: UploadIn):
    """Read an uploaded docker-compose.yaml or zip: the files to keep, .env variables, what was left out, warnings."""
    if len(body.data) > bundles.MAX_UPLOAD_BYTES * 4 // 3 + 16:
        raise HTTPException(400, "파일이 너무 커요. 5MB까지 올릴 수 있어요.")
    try:
        data = base64.b64decode(body.data, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(400, "파일을 읽을 수 없어요.") from e
    return bundles.parse_upload(body.name, data)


class PlaybookUploadIn(BaseModel):
    """A zip or one .yml (name + base64 data), or a folder picked in the browser (entries: path + base64 content)."""
    name: str = ""
    data: str = ""
    entries: list[FileIn] | None = None


def _b64(text: str) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(400, "파일을 읽을 수 없어요.") from e


def _inspected(files: list[dict], book: str) -> dict:
    """playinspect.inspect without the names Wharfline or Ansible keep for themselves (saving them is refused)."""
    out = playinspect.inspect(files, book)
    out["vars"] = [v for v in out["vars"] if not reserved_play_var(v["name"], None)]
    return out


@router.post("/playbooks/parse", dependencies=[Depends(require("job_create"))])
def parse_playbook_upload(body: PlaybookUploadIn):
    """Read an uploaded playbook set: the files to keep, what was left out (private keys, .env, binaries), and
    which files are playbooks. The upload is not stored until the job is saved."""
    limit = bundles.MAX_UPLOAD_BYTES * 4 // 3 + 16
    if body.entries is not None:
        if sum(len(e.content) for e in body.entries) > limit:
            raise HTTPException(400, "폴더가 너무 커요. 모두 합쳐 5MB까지 올릴 수 있어요.")
        res = bundles.parse_folder([(e.path, _b64(e.content)) for e in body.entries], playbook=True)
    else:
        if len(body.data) > limit:
            raise HTTPException(400, "파일이 너무 커요. 5MB까지 올릴 수 있어요.")
        res = bundles.parse_upload(body.name, _b64(body.data), playbook=True)
    res.pop("env", None)
    res["playbooks"] = playinspect.playbooks(res["files"])
    return res


class PlaybookInspectIn(BaseModel):
    files: list[FileIn]
    book: str


@router.post("/playbooks/inspect")
def inspect_playbook(body: PlaybookInspectIn, db: Session = Depends(get_db)):
    """What a playbook needs filled in (variables, secrets, sudo), read from the uploaded files."""
    me = s.current_member(db)
    if not s.can(me, "job_create") and not s.can(me, "job_edit"):
        raise HTTPException(403, s.NO_PERM)
    return _inspected([f.model_dump() for f in body.files], body.book.strip())


class PlaybookGitIn(BaseModel):
    url: str
    branch: str = "main"
    key: str = ""


@router.post("/playbooks/git")
async def git_playbooks(body: PlaybookGitIn, db: Session = Depends(get_db)):
    """The playbooks in a Git repo and what each needs, read with the access the job will use when it runs."""
    me = s.current_member(db)
    if not s.can(me, "job_create") and not s.can(me, "job_edit"):
        raise HTTPException(403, s.NO_PERM)
    url, branch = body.url.strip(), body.branch.strip() or "main"
    if not s.GIT_URL_RE.match(url):
        raise HTTPException(400, "저장소 주소를 확인해 주세요. 예: https://github.com/org/ansible.git")
    if not s.BRANCH_RE.match(branch):
        raise HTTPException(400, "브랜치 이름을 확인해 주세요. 예: main")
    existing = db.scalar(select(m.Repo).where(m.Repo.url == url, m.Repo.branch == branch))
    key, auth = (s.repo_key(db, existing), existing.auth) if existing else s.repo_key_for(db, url, body.key.strip())
    try:
        files, commit = await executor.read_repo_files(executor.git_access("", url, branch, auth, key), branch)
    except executor.RepoFileError as e:
        raise HTTPException(400, str(e)) from None
    books = playinspect.playbooks(files)[:30]
    return {"commit": commit, "playbooks": books, "inspect": {b: _inspected(files, b) for b in books}}


@router.get("/jobs/{job_id}/files")
def job_files(job_id: str, ver: int | None = None, db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    """The job's file bundle with contents: the current one, or an earlier version (?ver=3)."""
    job = seen_job(db, job_id, who)
    files = job.files or []
    if ver is not None and ver != job.files_ver:
        v = db.scalar(select(m.JobFileVersion).where(m.JobFileVersion.job_id == job_id, m.JobFileVersion.ver == ver))
        if not v:
            raise HTTPException(404, f"파일 v{ver} 기록이 없어요. 오래된 기록은 {MAX_FILE_VERSIONS}개까지만 남아요.")
        files = v.files
    return [{"path": f["path"], "content": f["content"], "size": len(f["content"].encode()),
             "warnings": [w["message"] for w in bundles.risky_warnings(f["path"], f["content"])]} for f in files]


@router.get("/jobs/{job_id}/builds")
def job_builds(job_id: str, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
               who: m.Member | None = Depends(viewer)):
    """The current CI build of every tracked image (githooks.current_build): {"": main image's, VAR: an extra image's} (null when none)."""
    job = seen_job(db, job_id, who)
    refs = ([("", job.image)] if job.image else []) + [(x["var"] or x["ref"], x["ref"]) for x in job.extra_images or []]
    out = {}
    for var, ref in refs:
        out[var] = githooks.current_build(db, ref, scope)
    return out


@router.get("/jobs/{job_id}/images")
def job_images(job_id: str, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
               who: m.Member | None = Depends(viewer)):
    """이미지 빌드 on the job page: each image the job follows, the tags Wharfline collected (newest first, each with the
    build that pushed it when known) and the image's recent CI builds. Builds only from repos the viewer may see."""
    job = seen_job(db, job_id, who)
    items = ([{"ref": job.image, "var": "", "tagNow": job.tag_now, "literal": None}] if job.image else []) + [
        {"ref": x["ref"], "var": x.get("var") or "", "tagNow": x.get("tagNow") or "-", "literal": x.get("literal")}
        for x in job.extra_images or []]
    out: list[dict] = []
    for it in items:
        if any(o["ref"] == it["ref"] for o in out):
            continue  # images sharing a variable, or the main image listed again
        img = db.get(m.Image, it["ref"])
        builds = githooks.builds_for_image(db, it["ref"], limit=20, scope=scope)
        by_tag: dict[str, dict] = {}
        for b in builds:  # newest first: the first build with a tag is the one that pushed it
            if b.get("tag"):
                by_tag.setdefault(b["tag"], b)
        # Sample tags carry a placeholder time (1e9 − n): no time rather than a date in 2001.
        tags = [{"name": t.name, "digest": t.digest, "pushedAt": t.pushed_at if t.pushed_at and t.pushed_at > 1.5e9 else None,
                 "build": by_tag.get(t.name)} for t in (img.tags if img else [])[:50]]
        out.append({**it, "sourceRepo": img.source_repo if img else None, "tags": tags, "builds": builds})
    return out


@router.get("/jobs/{job_id}/files/history")
def job_files_history(job_id: str, db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    """Every saved version of the job's files, newest first: who, when, what changed."""
    seen_job(db, job_id, who)
    rows = db.scalars(select(m.JobFileVersion).where(m.JobFileVersion.job_id == job_id).order_by(m.JobFileVersion.ver.desc()))
    return [v.summary() for v in rows]


@router.get("/runs")
def list_runs(db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    """Runs of the jobs the viewer may see."""
    names = member_names(db)
    return [run_view(r, names) for r in db.scalars(runs_query(db, who).order_by(m.Run.no.desc()))]


@router.get("/runs/{no}")
def get_run(no: int, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
            who: m.Member | None = Depends(viewer)):
    rec = seen_run(db, no, who)
    job = db.get(m.Job, rec.job_id)
    base = run_view(rec, member_names(db))
    if job:
        j = job.to_dict()
        base.update(method=runner.method_label(j), playbook=j["playbook"], image=job.image, inventory=job.inventory)
        built = githooks.build_for_tag(db, job.image, rec.tag, scope) if job.image else None
        base["build"] = built.to_dict() if built else None
    if rec.status in ("approval", "rejected"):  # never started: nothing to show yet
        return {**base, "live": False, "events": []}
    if no in runner.live:
        return {**base, "live": not runner.live[no]["done"], "events": runner.live[no]["events"]}
    if rec.log is not None:
        return {**base, "live": False, "events": rec.log}
    if not job:
        return {**base, "live": False, "steps": [], "events": []}
    steps, events = runner.replay_events(db, rec, job.to_dict())
    return {**base, "steps": steps, "live": False, "events": events}


@router.get("/runs/{no}/stream")
async def stream_run(no: int, since: int = 0, db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    seen_run(db, no, who)
    db.close()  # the stream can stay open for minutes; don't hold a connection for it
    if no not in runner.live:
        raise HTTPException(404, "실행 중인 기록이 아니에요.")

    async def gen():
        i = since
        run = runner.live[no]
        while True:
            events = run["events"]
            while i < len(events):
                yield f"data: {json.dumps(events[i], ensure_ascii=False)}\n\n"
                i += 1
            if run["done"]:
                break
            await asyncio.sleep(0.1)

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


EVENTS_TICK = 0.5  # how often a stream looks for new notices
EVENTS_KEEPALIVE = 20.0  # a comment line so proxies keep the connection and a closed tab is noticed


@router.get("/events")
async def stream_events(request: Request, since: int | None = None):
    """Change notices for open pages: `data: {"seq": n, "topics": ["jobs", …]}` when a webhook, run or edit changes
    data. Pages refetch through the normal API. The first message gives the current number; a page that reconnects
    passes it back as `since` (or EventSource's Last-Event-ID) and hears what it missed."""
    last_id = request.headers.get("last-event-id")
    seq = since if since is not None else int(last_id) if last_id and last_id.isdigit() else None

    async def gen():
        nonlocal seq
        if seq is None:
            seq = events.current()
            yield f"id: {seq}\ndata: {json.dumps({'seq': seq, 'topics': []})}\n\n"
        quiet = 0.0
        while not await request.is_disconnected():
            new, topics = events.since(seq)
            if topics:
                seq = new
                quiet = 0.0
                yield f"id: {seq}\ndata: {json.dumps({'seq': seq, 'topics': sorted(topics)})}\n\n"
            elif quiet >= EVENTS_KEEPALIVE:
                quiet = 0.0
                yield ": keepalive\n\n"
            await asyncio.sleep(EVENTS_TICK)
            quiet += EVENTS_TICK

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/runs/{no}/cancel", dependencies=[Depends(require("run"))])
def cancel(no: int, db: Session = Depends(get_db)):
    seen_run(db, no, s.current_member(db))
    if not runner.cancel_run(no, s.actor_name(db)):
        raise HTTPException(400, "이미 끝난 실행이에요.")
    return {"ok": True}


def pending(db: Session, no: int) -> m.Run:
    rec = db.get(m.Run, no, with_for_update=True)  # two Admins deciding at once: only one wins
    if not rec:
        raise HTTPException(404, NO_RUN)
    if rec.status != "approval":
        raise HTTPException(400, "승인 대기 중인 실행이 아니에요.")
    return rec


def check_lock(job: m.Job) -> None:
    """동시 실행 잠금: one run at a time per job, so two runs never replace each other's containers."""
    no = runner.active_run(job.id) if job.lock else None
    if no is not None:
        raise HTTPException(409, f"이 작업은 지금 #{no}이(가) 실행 중이에요. 끝난 뒤 다시 실행해 주세요.")


@router.post("/runs/{no}/approve", dependencies=[Depends(require("approve"))])
async def approve(no: int, db: Session = Depends(get_db)):  # async: the runner schedules a task on the event loop
    rec = pending(db, no)
    job = db.get(m.Job, rec.job_id)
    if not job:
        raise HTTPException(400, "작업이 지워져서 실행할 수 없어요.")
    check_lock(job)
    me = s.current_member(db)
    rec.decided_by, rec.decided_at = me.email, datetime.now(timezone.utc)
    s.log_act(db, "배포 승인", f"{rec.job} #{no} · {rec.tag} · 요청 {rec.by}")
    j = job.to_dict()
    return runner.launch(db, rec, j, runner.run_groups(db, rec, j), note=f"승인: {me.name} · 요청: {rec.by}")


@router.post("/runs/{no}/reject", dependencies=[Depends(require("approve"))])
def reject(no: int, db: Session = Depends(get_db)):
    rec = pending(db, no)
    me = s.current_member(db)
    rec.status, rec.time = "rejected", "방금"
    runner.mark_job(db, rec.job_id, "rejected")
    rec.decided_by, rec.decided_at = me.email, datetime.now(timezone.utc)
    s.log_act(db, "배포 거절", f"{rec.job} #{no} · {rec.tag} · 요청 {rec.by}", "warn")
    db.commit()
    return {"no": no, "status": "rejected"}
