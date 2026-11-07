import asyncio
import json
import re

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
from ..deps import build_scope, require_login, viewer

router = APIRouter(prefix="/api", tags=["deploy"], dependencies=[Depends(require_login)])


def job_view(db: Session, job: m.Job, scope: set[str] | None) -> dict:
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
    }


def all_jobs(db: Session) -> list[m.Job]:
    return list(db.scalars(select(m.Job).order_by(m.Job.ord)))


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), who: m.Member | None = Depends(viewer)):
    scope = s.build_scope(who)
    hosts = list(db.scalars(select(m.Host)))
    online = sum(1 for h in hosts if h.status == "on")
    changed = next((h for h in hosts if h.host_key == "changed"), None)
    members = list(db.scalars(select(m.Member)))
    return {
        "me": s.me_dict(who) if who else None,
        "stats": {
            "today": 7, "todayOk": 6, "todayBad": 1,
            "successRate": "96.4%", "successDelta": "+2.1%p",
            "hostsOnline": online, "hostsTotal": len(hosts),
            "avgDuration": "1m 31s",
        },
        "hostKeyAlert": changed.to_dict() if changed else None,
        "recentRuns": [r.to_dict() for r in db.scalars(select(m.Run).order_by(m.Run.no.desc()).limit(5))],
        "jobs": [job_view(db, j, scope) for j in all_jobs(db)],
        "security": {"tfaUsers": sum(1 for x in members if x.tfa), "members": len(members)},
    }


@router.get("/jobs")
def list_jobs(db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope)):
    return [job_view(db, j, scope) for j in all_jobs(db)]


class PlaybookIn(BaseModel):
    source: str = Field(pattern="^(git|builtin)$")
    url: str = ""
    branch: str = "main"
    path: str = ""
    key: str = ""


class JobIn(BaseModel):
    name: str
    playbook: PlaybookIn
    inventory: str
    targets: list[str] = []
    image: str = ""
    envMode: str = Field(default="paste", pattern="^(paste|existing|none)$")
    envName: str | None = None
    envVars: list[list[str]] = []
    hook: bool = False
    protected: bool = True
    lock: bool = True
    rollback: bool = True


BAD_PATH = "플레이북 경로는 레포 안의 .yml 파일이에요. 예: deploy/app.yml"


@router.post("/jobs")
def create_job(body: JobIn, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "이름을 넣어 주세요.")
    if db.scalar(select(m.Job).where(m.Job.name == name)):
        raise HTTPException(400, "같은 이름의 작업이 있어요.")
    inv = db.scalar(select(m.Inventory).where(m.Inventory.name == body.inventory))
    if not inv:
        raise HTTPException(400, "인벤토리를 찾을 수 없어요.")
    if not inv.hosts:
        raise HTTPException(400, "인벤토리에 서버가 없어요. 서버를 먼저 추가해 주세요.")
    unknown = set(body.targets) - {h.grp for h in inv.hosts}
    if unknown:
        raise HTTPException(400, f"인벤토리에 없는 그룹이에요: {', '.join(sorted(unknown))}")

    pb = body.playbook
    image_text = body.image.strip()
    ref, tag = s.parse_image(image_text) if image_text else (None, "latest")
    if pb.source == "builtin":
        if not ref:
            raise HTTPException(400, "기본 플레이북은 띄울 이미지가 있어야 해요.")
        path = s.BUILTIN_BOOK
    else:
        path = pb.path.strip()
        if not s.PLAYBOOK_PATH_RE.match(path):
            raise HTTPException(400, BAD_PATH)
    repo = s.builtin_repo(db) if pb.source == "builtin" else s.ensure_git_repo(db, pb.url, pb.branch, pb.key.strip())
    if ref:
        s.ensure_image(db, ref, tag)

    if body.envMode == "none":
        env_name = ""  # no .env for this job; one can be attached later
    elif body.envMode == "existing":
        if not s.env_by_name(db, body.envName or ""):
            raise HTTPException(400, "저장된 환경 변수를 찾을 수 없어요.")
        env_name = body.envName
    else:
        env_name = re.sub(r"\s+", "-", re.sub(r"\s*·\s*", ".", name))
        if s.env_by_name(db, env_name):
            raise HTTPException(400, f"환경 변수 {env_name}이(가) 이미 있어요. '저장된 것 쓰기'를 골라 주세요.")
        s.validate_vars(body.envVars)
        env = m.EnvSet(id=s.new_id("e"), name=env_name, ver=1, updated=f"방금 · {s.actor_name(db)}")
        env.set_vars(body.envVars)
        db.add(env)

    job = m.Job(
        id=s.new_id("j"), name=name, image=ref, default_tag=tag, repo=repo.name, book=path,
        inventory=body.inventory, targets=body.targets, env=env_name, hook=body.hook, protected=body.protected,
        lock=body.lock, rollback=body.rollback,
    )
    db.add(job)
    s.log_act(db, "배포 작업 생성", f"{name} · {repo.name}/{path}")
    db.commit()
    return job_view(db, job, scope)


class RunIn(BaseModel):
    tag: str = "latest"
    groups: list[str] = []
    rollback: bool = False


@router.post("/jobs/{job_id}/runs")
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
    return runner.start_run(db, j, body.groups, tag, "되돌리기" if body.rollback else "수동 실행")


@router.get("/runs")
def list_runs(db: Session = Depends(get_db)):
    return [r.to_dict() for r in db.scalars(select(m.Run).order_by(m.Run.no.desc()))]


@router.get("/runs/{no}")
def get_run(no: int, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope)):
    rec = db.get(m.Run, no)
    if not rec:
        raise HTTPException(404, "실행 기록을 찾을 수 없어요.")
    job = db.get(m.Job, rec.job_id)
    base = rec.to_dict()
    if job:
        j = job.to_dict()
        base.update(method=runner.method_label(j), playbook=j["playbook"], image=job.image, inventory=job.inventory)
        built = githooks.build_for_tag(db, job.image, rec.tag, scope) if job.image else None
        base["build"] = built.to_dict() if built else None
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


@router.post("/runs/{no}/cancel")
def cancel(no: int, db: Session = Depends(get_db)):
    if not runner.cancel_run(no, s.actor_name(db)):
        raise HTTPException(400, "이미 끝난 실행이에요.")
    return {"ok": True}
