import asyncio
import base64
import binascii
import json
import re
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import bundles
from .. import githooks
from .. import models as m
from .. import runner
from .. import store as s
from ..db import get_db
from ..deps import build_scope, require, require_login, viewer
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


def all_jobs(db: Session) -> list[m.Job]:
    return list(db.scalars(select(m.Job).order_by(m.Job.ord)))


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    scope = s.build_scope(who)
    hosts = list(db.scalars(select(m.Host)))
    online = sum(1 for h in hosts if h.status == "on")
    changed = next((h for h in hosts if h.host_key == "changed"), None)
    members = list(db.scalars(select(m.Member)))
    names = {x.email: x.name for x in members}
    return {
        "me": s.me_dict(who) if who else None,
        "stats": {
            "today": 7, "todayOk": 6, "todayBad": 1,
            "successRate": "96.4%", "successDelta": "+2.1%p",
            "hostsOnline": online, "hostsTotal": len(hosts),
            "avgDuration": "1m 31s",
        },
        "hostKeyAlert": changed.to_dict() if changed else None,
        "recentRuns": [run_view(r, names) for r in db.scalars(select(m.Run).order_by(m.Run.no.desc()).limit(5))],
        "pendingApprovals": [run_view(r, names) for r in db.scalars(select(m.Run).where(m.Run.status == "approval").order_by(m.Run.no))],
        "jobs": [job_view(db, j, scope, who) for j in all_jobs(db)],
        "security": {"tfaUsers": sum(1 for x in members if x.tfa), "members": len(members)},
    }


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
              who: m.Member | None = Depends(viewer)):
    return [job_view(db, j, scope, who) for j in all_jobs(db)]


class PlaybookIn(BaseModel):
    source: str = Field(pattern="^(git|builtin|script)$")
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
    envMode: str = Field(default="paste", pattern="^(paste|existing|none)$")
    envName: str | None = None
    envVars: list[list[str]] = []
    editors: EditorsIn = Field(default_factory=EditorsIn)
    hook: bool = False
    hookRule: str = "v"  # v | date | any | re:<regex>
    protected: bool = True
    lock: bool = True
    rollback: bool = True


class JobUpdate(JobIn):
    envMode: str = Field(default="keep", pattern="^(keep|paste|existing|none)$")  # keep: leave the .env as it is


BAD_PATH = "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml"
NO_EDIT = "이 작업을 고칠 권한이 없어요."

# Activity log labels for PUT, in form order.
FIELD_LABELS = {
    "name": "이름", "playbook": "배포 방법", "files": "파일", "images": "추가 이미지", "target": "배포 대상", "image": "이미지", "env": "환경 변수",
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


def resolve_playbook(db: Session, body: JobIn) -> tuple[m.Repo | None, str | None, str | None, str, list[dict[str, str]] | None, str | None]:
    """Validate the deploy method + image; reuse or create the repo and register the image.

    Returns (repo, path, image ref, tag, script, service path). An SSH script job has no repo or path.
    """
    pb = body.playbook
    image_text = body.image.strip()
    ref, tag = s.parse_image(image_text) if image_text else (None, "latest")
    script = service_path = None
    if pb.source == "script":
        script = check_script(body.script)
        service_path = check_service_path(body.servicePath, body.name)
        repo, path = None, None
    elif pb.source == "builtin":
        if not ref:
            raise HTTPException(400, "기본 플레이북은 띄울 이미지가 있어야 해요.")
        repo, path = s.builtin_repo(db), s.BUILTIN_BOOK
    else:
        path = pb.path.strip()
        if not s.PLAYBOOK_PATH_RE.match(path):
            raise HTTPException(400, BAD_PATH)
        repo = s.ensure_git_repo(db, pb.url, pb.branch, pb.key.strip())
    if ref:
        s.ensure_image(db, ref, tag)
    return repo, path, ref, tag, script, service_path


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
    else:
        env_name = new_env_set(db, name, body.envVars)

    job = m.Job(
        id=s.new_id("j"), name=name, image=ref, default_tag=tag, repo=repo.name if repo else None, book=path, script=script, service_path=service_path,
        files=bundles.check_files([f.model_dump() for f in body.files or []]) if script is not None else None,
        extra_images=check_extra_images(db, body.extraImages, None),
        inventory=body.inventory, targets=body.targets, env=env_name, hook=body.hook, hook_rule=check_hook_rule(body.hookRule), protected=body.protected,
        lock=body.lock, rollback=body.rollback, editors=editors, created_by=me.email if me else None,
    )
    db.add(job)
    db.flush()
    save_file_version(db, job, None, job.files)
    s.log_act(db, "배포 작업 생성", f"{name} · " + (f"{repo.name}/{path}" if repo else f"SSH 스크립트 {len(script or [])}단계"))
    db.commit()
    return job_view(db, job, scope, who)


@router.put("/jobs/{job_id}", dependencies=[Depends(require("job_edit"))])
def update_job(job_id: str, body: JobUpdate, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope),
               who: m.Member | None = Depends(viewer)):
    job = db.get(m.Job, job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없어요.")
    me = s.current_member(db)
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
    extra_images = check_extra_images(db, body.extraImages, job.extra_images)

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
        "name": name, "playbook": (repo.name if repo else None, path, script, service_path), "files": files, "images": [{k: x[k] for k in ("ref", "var", "defaultTag")} for x in extra_images], "target": (body.inventory, list(body.targets)),
        "image": (ref, tag), "env": env_name, "editors": editors,
        "hook": (body.hook, check_hook_rule(body.hookRule)), "protected": body.protected, "lock": body.lock, "rollback": body.rollback,
    }
    old = {
        "name": job.name, "playbook": (job.repo, job.book, job.script, job.service_path), "files": job.files,
        "images": [{k: x[k] for k in ("ref", "var", "defaultTag")} for x in job.extra_images or []], "target": (job.inventory, list(job.targets or [])),
        "image": (job.image, job.default_tag), "env": job.env, "editors": job.to_dict()["editors"],
        "hook": (job.hook, job.hook_rule), "protected": job.protected, "lock": job.lock, "rollback": job.rollback,
    }
    changed += [k for k in new if new[k] != old[k] and k not in changed]

    job.name, job.repo, job.book, job.script, job.service_path = name, repo.name if repo else None, path, script, service_path
    save_file_version(db, job, job.files, files)
    job.files, job.extra_images = files, extra_images
    job.inventory, job.targets = body.inventory, list(body.targets)
    job.image, job.default_tag = ref, tag
    job.env, job.editors = env_name, editors
    job.hook, job.protected, job.lock, job.rollback = body.hook, body.protected, body.lock, body.rollback
    job.hook_rule = check_hook_rule(body.hookRule)

    if changed:
        labels = ", ".join(FIELD_LABELS[k] for k in FIELD_LABELS if k in changed)
        s.log_act(db, "배포 작업 수정", f"{name} · {labels}")
    db.commit()
    db.refresh(job)  # reload playbook_repo when the repo changed
    return job_view(db, job, scope, who)


class RunIn(BaseModel):
    tag: str = "latest"
    groups: list[str] = []
    rollback: bool = False
    extraTags: dict[str, str] = {}  # {VAR: tag} for extra images; missing ones keep their current tag


@router.post("/jobs/{job_id}/runs", dependencies=[Depends(require("run"))])
async def run_job(job_id: str, body: RunIn, db: Session = Depends(get_db)):  # async: the runner schedules a task on the event loop
    job = db.get(m.Job, job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없어요.")
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
    extras = {x["var"]: x for x in job.extra_images or []}
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


@router.get("/jobs/{job_id}/files")
def job_files(job_id: str, ver: int | None = None, db: Session = Depends(get_db)):
    """The job's file bundle with contents: the current one, or an earlier version (?ver=3)."""
    job = db.get(m.Job, job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없어요.")
    files = job.files or []
    if ver is not None and ver != job.files_ver:
        v = db.scalar(select(m.JobFileVersion).where(m.JobFileVersion.job_id == job_id, m.JobFileVersion.ver == ver))
        if not v:
            raise HTTPException(404, f"파일 v{ver} 기록이 없어요. 오래된 기록은 {MAX_FILE_VERSIONS}개까지만 남아요.")
        files = v.files
    return [{"path": f["path"], "content": f["content"], "size": len(f["content"].encode()),
             "warnings": [w["message"] for w in bundles.risky_warnings(f["path"], f["content"])]} for f in files]


@router.get("/jobs/{job_id}/builds")
def job_builds(job_id: str, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope)):
    """The latest CI build of every tracked image: {"": main image's build, VAR: extra image's build} (null when none)."""
    job = db.get(m.Job, job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없어요.")
    refs = ([("", job.image)] if job.image else []) + [(x["var"], x["ref"]) for x in job.extra_images or []]
    out = {}
    for var, ref in refs:
        latest = githooks.builds_for_image(db, ref, limit=1, scope=scope)
        out[var] = latest[0] if latest else None
    return out


@router.get("/jobs/{job_id}/files/history")
def job_files_history(job_id: str, db: Session = Depends(get_db)):
    """Every saved version of the job's files, newest first: who, when, what changed."""
    if not db.get(m.Job, job_id):
        raise HTTPException(404, "작업을 찾을 수 없어요.")
    rows = db.scalars(select(m.JobFileVersion).where(m.JobFileVersion.job_id == job_id).order_by(m.JobFileVersion.ver.desc()))
    return [v.summary() for v in rows]


@router.get("/runs")
def list_runs(db: Session = Depends(get_db)):
    names = member_names(db)
    return [run_view(r, names) for r in db.scalars(select(m.Run).order_by(m.Run.no.desc()))]


@router.get("/runs/{no}")
def get_run(no: int, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope)):
    rec = db.get(m.Run, no)
    if not rec:
        raise HTTPException(404, "실행 기록을 찾을 수 없어요.")
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
async def stream_run(no: int, since: int = 0):
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


@router.post("/runs/{no}/cancel", dependencies=[Depends(require("run"))])
def cancel(no: int, db: Session = Depends(get_db)):
    if not runner.cancel_run(no, s.actor_name(db)):
        raise HTTPException(400, "이미 끝난 실행이에요.")
    return {"ok": True}


def pending(db: Session, no: int) -> m.Run:
    rec = db.get(m.Run, no, with_for_update=True)  # two Admins deciding at once: only one wins
    if not rec:
        raise HTTPException(404, "실행 기록을 찾을 수 없어요.")
    if rec.status != "approval":
        raise HTTPException(400, "승인 대기 중인 실행이 아니에요.")
    return rec


@router.post("/runs/{no}/approve", dependencies=[Depends(require("approve"))])
async def approve(no: int, db: Session = Depends(get_db)):  # async: the runner schedules a task on the event loop
    rec = pending(db, no)
    job = db.get(m.Job, rec.job_id)
    if not job:
        raise HTTPException(400, "작업이 지워져서 실행할 수 없어요.")
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
    rec.decided_by, rec.decided_at = me.email, datetime.now(timezone.utc)
    s.log_act(db, "배포 거절", f"{rec.job} #{no} · {rec.tag} · 요청 {rec.by}", "warn")
    db.commit()
    return {"no": no, "status": "rejected"}
