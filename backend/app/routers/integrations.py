"""Gitea webhook receiver, integration settings, and the build list."""

import asyncio
import json
import random
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import gitea
from .. import models as m
from .. import runner
from .. import store as s
from ..db import SessionLocal, get_db
from ..deps import require_login, require_sudo

MAX_BODY = 1024 * 1024

hooks = APIRouter(prefix="/api/hooks", tags=["hooks"])  # called by Gitea: no session, HMAC instead
router = APIRouter(prefix="/api", tags=["integrations"], dependencies=[Depends(require_login)])


def auto_deploy(db: Session, released: list[tuple[m.Image, str]]) -> list[int]:
    """Start runs for jobs with auto-deploy on, for each newly pushed release tag."""
    started: list[int] = []
    for img, tag in released:
        for job in db.scalars(select(m.Job).where(m.Job.image == img.ref, m.Job.hook.is_(True))):
            j = job.to_dict()
            if not [h for h in s.target_hosts(s.inv_of(db, j), j["targets"]) if not s.host_skip(h)]:
                continue
            started.append(runner.start_run(db, j, j["targets"], tag, "새 이미지 push")["no"])
    return started


def process(db: Session, event: str, payload: dict) -> dict:
    if event == "workflow_run":
        b = gitea.handle_workflow_run(db, payload)
        db.commit()
        return {"build": b.id if b else None}
    if event == "workflow_job":
        b = gitea.handle_workflow_job(db, payload)
        db.commit()
        return {"build": b.id if b else None}
    if event == "package":
        released = gitea.handle_package(db, payload)
        db.commit()
        return {"tags": [f"{i.ref}:{t}" for i, t in released], "runs": auto_deploy(db, released)}
    return {"ignored": event}


@hooks.post("/gitea")
async def gitea_hook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if len(body) > MAX_BODY:
        raise HTTPException(413, "payload too large")
    secret = gitea.load_secret(db)
    if not secret:
        raise HTTPException(503, "Gitea webhook secret is not configured")
    headers = {k.lower(): v for k, v in request.headers.items()}
    if not gitea.verify_signature(secret, body, headers):
        raise HTTPException(401, "bad signature")
    event = headers.get("x-gitea-event") or headers.get("x-github-event") or ""
    try:
        payload = json.loads(body)
    except ValueError as e:
        raise HTTPException(400, "invalid JSON") from e
    return {"ok": True, **process(db, event, payload)}


# ---------- settings ----------

@router.get("/integrations/gitea")
def gitea_settings(db: Session = Depends(get_db)):
    v = s.get_setting(db, gitea.SETTING)
    return {"path": "/api/hooks/gitea", "secretSet": bool(v.get("ciphertext")), "secretCreated": v.get("created"),
            "events": ["workflow_run", "workflow_job", "package"]}


@router.post("/integrations/gitea/secret", dependencies=[Depends(require_sudo)])
def gitea_new_secret(db: Session = Depends(get_db)):
    value = gitea.new_secret(db)
    s.log_act(db, "Gitea 웹훅 비밀값 발급", "이전 비밀값은 더 이상 쓸 수 없어요", "warn")
    db.commit()
    return {"secret": value}


class SourceRepoIn(BaseModel):
    ref: str
    sourceRepo: str


@router.put("/images/source")
def set_source_repo(body: SourceRepoIn, db: Session = Depends(get_db)):
    img = db.get(m.Image, body.ref)
    if not img:
        raise HTTPException(404, "이미지를 찾을 수 없어요.")
    repo = body.sourceRepo.strip().lower().removesuffix(".git")
    if repo and (repo.count("/") != 1 or not all(repo.split("/"))):
        raise HTTPException(400, "레포는 owner/name 형식으로 넣어 주세요. 예: acme/batch-worker")
    img.source_repo = repo or None
    s.log_act(db, "빌드 레포 연결", f"{img.ref} ← {repo or '없음'}")
    db.commit()
    return img.to_dict()


@router.get("/builds")
def list_builds(db: Session = Depends(get_db)):
    return [b.to_dict() for b in db.scalars(select(m.Build).order_by(m.Build.updated_at.desc()).limit(30))]


# ---------- test event (no real Gitea needed) ----------

class TestIn(BaseModel):
    ref: str
    fail: bool = False


def next_tag(img: m.Image) -> str:
    for t in img.tags:
        parts = t.name.lstrip("v").split(".")
        if t.name.startswith("v") and len(parts) == 3 and all(p.isdigit() for p in parts):
            return f"v{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"
    return "v0.1.0"


async def _simulate(ref: str, fail: bool) -> None:
    """Feeds the same handlers Gitea's webhooks reach, with a realistic sequence of payloads."""
    with SessionLocal() as db:
        img = db.get(m.Image, ref)
        owner, name = ref.split("/")[-2:]
        repo, tag = img.source_repo or f"{owner}/{name}", next_tag(img)
    run_id = random.randint(10_000, 99_999)
    base = {"repository": {"full_name": repo}}
    run = {"id": run_id, "run_number": run_id % 1000, "name": "image", "display_title": f"release {tag}",
           "head_branch": "main", "head_sha": f"{random.getrandbits(40):010x}", "html_url": f"https://gitea.example/{repo}/actions/runs/{run_id % 1000}"}
    steps = ["Set up job", "Checkout", "Login to registry", "Build and push", "Post job"]
    sequence: list[tuple[float, str, dict]] = [(0, "workflow_run", {**base, "action": "requested", "workflow_run": {**run, "status": "queued"}}),
                                               (1, "workflow_run", {**base, "action": "in_progress", "workflow_run": {**run, "status": "in_progress"}})]
    for i, st in enumerate(steps if not fail else steps[:4]):
        sequence.append((1.6, "workflow_job", {**base, "action": "in_progress", "workflow_job": {
            "run_id": run_id, "name": "build", "status": "in_progress", "steps": [{"name": st, "status": "in_progress", "number": i + 1}]}}))
    done = {**run, "status": "completed", "conclusion": "failure" if fail else "success"}
    if not fail:
        sequence.append((1.2, "package", {"action": "created", "package": {"type": "container", "name": name, "version": tag, "owner": {"login": owner}}}))
    sequence.append((0.4, "workflow_run", {**base, "action": "completed", "workflow_run": done}))
    for delay, event, payload in sequence:
        await asyncio.sleep(delay)
        with SessionLocal() as db:
            process(db, event, payload)


@router.post("/integrations/gitea/test")
async def gitea_test(body: TestIn, db: Session = Depends(get_db)):
    img = db.get(m.Image, body.ref)
    if not img:
        raise HTTPException(404, "이미지를 찾을 수 없어요.")
    if not img.source_repo:
        raise HTTPException(400, "먼저 이 이미지를 빌드하는 레포를 연결해 주세요.")
    s.log_act(db, "시험 빌드 이벤트", f"{img.ref} · {'실패' if body.fail else '성공'} 시나리오")
    db.commit()
    asyncio.get_running_loop().create_task(_simulate(body.ref, body.fail))
    return {"ok": True, "startedAt": time.time()}
