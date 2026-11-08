import asyncio
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

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
        "canEdit": s.can_edit(who, job),
    }


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


class JobIn(BaseModel):
    name: str
    playbook: PlaybookIn
    script: list[ScriptStep] = []  # used when playbook.source == "script"
    inventory: str
    targets: list[str] = []
    image: str = ""
    envMode: str = Field(default="paste", pattern="^(paste|existing|none)$")
    envName: str | None = None
    envVars: list[list[str]] = []
    editors: EditorsIn = Field(default_factory=EditorsIn)
    hook: bool = False
    protected: bool = True
    lock: bool = True
    rollback: bool = True


class JobUpdate(JobIn):
    envMode: str = Field(default="keep", pattern="^(keep|paste|existing|none)$")  # keep: leave the .env as it is


BAD_PATH = "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml"
NO_EDIT = "이 작업을 고칠 권한이 없어요."

# Activity log labels for PUT, in form order.
FIELD_LABELS = {
    "name": "이름", "playbook": "배포 방법", "target": "배포 대상", "image": "이미지", "env": "환경 변수",
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


def resolve_playbook(db: Session, body: JobIn) -> tuple[m.Repo | None, str | None, str | None, str, list[dict[str, str]] | None]:
    """Validate the deploy method + image; reuse or create the repo and register the image.

    Returns (repo, path, image ref, tag, script). An SSH script job has no repo or path.
    """
    pb = body.playbook
    image_text = body.image.strip()
    ref, tag = s.parse_image(image_text) if image_text else (None, "latest")
    script = None
    if pb.source == "script":
        script = check_script(body.script)
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
    return repo, path, ref, tag, script


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
        body.protected, body.hook = True, False  # Deployers: protected on, auto-deploy off
    name = check_name(db, body.name)
    check_target(db, body.inventory, body.targets)
    editors = check_editors(db, body.editors)
    repo, path, ref, tag, script = resolve_playbook(db, body)

    if body.envMode == "none":
        env_name = ""  # no .env for this job; one can be attached later
    elif body.envMode == "existing":
        env_name = existing_env(db, body.envName)
    else:
        env_name = new_env_set(db, name, body.envVars)

    job = m.Job(
        id=s.new_id("j"), name=name, image=ref, default_tag=tag, repo=repo.name if repo else None, book=path, script=script,
        inventory=body.inventory, targets=body.targets, env=env_name, hook=body.hook, protected=body.protected,
        lock=body.lock, rollback=body.rollback, editors=editors, created_by=me.email if me else None,
    )
    db.add(job)
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
        body.protected, body.hook = job.protected, job.hook  # Deployers can't change 운영 보호 or 자동 배포
    name = check_name(db, body.name, self_id=job.id)
    check_target(db, body.inventory, body.targets)
    editors = check_editors(db, body.editors)

    # Pasting over the job's current set overwrites secrets: that needs a recent password re-check.
    current_set = db.scalar(select(m.EnvSet).where(m.EnvSet.name == job.env)) if job.env else None
    if body.envMode == "paste" and current_set and not s.sudo_active(db):
        raise HTTPException(403, "sudo_required")

    repo, path, ref, tag, script = resolve_playbook(db, body)

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
        "name": name, "playbook": (repo.name if repo else None, path, script), "target": (body.inventory, list(body.targets)),
        "image": (ref, tag), "env": env_name, "editors": editors,
        "hook": body.hook, "protected": body.protected, "lock": body.lock, "rollback": body.rollback,
    }
    old = {
        "name": job.name, "playbook": (job.repo, job.book, job.script), "target": (job.inventory, list(job.targets or [])),
        "image": (job.image, job.default_tag), "env": job.env, "editors": job.to_dict()["editors"],
        "hook": job.hook, "protected": job.protected, "lock": job.lock, "rollback": job.rollback,
    }
    changed += [k for k in new if new[k] != old[k] and k not in changed]

    job.name, job.repo, job.book, job.script = name, repo.name if repo else None, path, script
    job.inventory, job.targets = body.inventory, list(body.targets)
    job.image, job.default_tag = ref, tag
    job.env, job.editors = env_name, editors
    job.hook, job.protected, job.lock, job.rollback = body.hook, body.protected, body.lock, body.rollback

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
    trigger = "되돌리기" if body.rollback else "수동 실행"
    me = s.current_member(db)
    email = me.email if me else None
    if job.protected and not s.can(me, "run_protected"):
        return runner.request_approval(db, j, body.groups, tag, trigger, email)
    return runner.start_run(db, j, body.groups, tag, trigger, requested_by=email)


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
