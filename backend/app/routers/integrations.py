"""Git webhook receiver (Gitea, GitHub, GitLab), integration settings, and the build list."""

import asyncio
import json
import random
import re
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import githooks
from .. import models as m
from .. import runner
from .. import store as s
from ..db import SessionLocal, get_db
from ..deps import build_scope, require, require_login, require_sudo

MAX_BODY = 1024 * 1024

hooks = APIRouter(prefix="/api/hooks", tags=["hooks"])  # called by the Git host: no session, the webhook secret instead
router = APIRouter(prefix="/api", tags=["integrations"], dependencies=[Depends(require_login)])


def auto_deploy(db: Session, released: list[tuple[m.Image, str]]) -> list[str]:
    """Queue auto-deploys for jobs with auto-deploy on, for each newly pushed release tag. Returns the job names.

    The tag goes to whichever watched image it belongs to (the main one or an extra one); the other
    images keep the version running now. Pushes close together go out as one run (runner.queue_auto).
    A protected job is not started: its run waits for an Owner/Admin to approve it.
    """
    queued: list[str] = []
    for img, tag in released:
        for job in db.scalars(select(m.Job).where(m.Job.hook.is_(True)).order_by(m.Job.ord)):
            extra = next((x for x in job.extra_images or [] if x["ref"] == img.ref), None)
            if job.image != img.ref and not extra:
                continue
            if not githooks.tag_matches(job.hook_rule or "v", tag):
                continue  # not a tag this job deploys automatically
            if job.image == img.ref:
                runner.queue_auto(job.id, tag, {})
            else:
                # A named image gets the new tag; a watched-only one (written tag in the file) just redeploys.
                runner.queue_auto(job.id, None, {extra["var"]: tag} if extra["var"] else {})
            if job.name not in queued:
                queued.append(job.name)
                s.log_act(db, "자동 배포 예약", f"{job.name} · {img.ref}:{tag}")
    return queued


def process(db: Session, provider: str, event: str, payload: dict) -> dict:
    """Apply one webhook event. `event` is the provider's own event name."""
    released: list[tuple[m.Image, str]] = []
    build: m.Build | None = None
    if provider == "gitlab":
        if event == "Pipeline Hook":
            build, released = githooks.handle_gitlab_pipeline(db, payload)
        elif event == "Job Hook":
            build = githooks.handle_gitlab_job(db, payload)
        else:
            return {"ignored": event}
    elif event == "workflow_run":
        build = githooks.handle_workflow_run(db, payload, provider)
    elif event == "workflow_job":
        build = githooks.handle_workflow_job(db, payload, provider)
    elif event in ("package", "registry_package"):
        released = githooks.handle_package(db, payload)
    elif event == "ping":  # GitHub and Gitea send this when the webhook is saved
        return {"pong": True}
    else:
        return {"ignored": event}
    db.commit()
    out: dict = {"build": build.id if build else None}
    if released:
        out |= {"tags": [f"{i.ref}:{t}" for i, t in released], "queued": auto_deploy(db, released)}
    return out


@hooks.post("/git")
@hooks.post("/gitea", include_in_schema=False)  # the first address; Gitea webhooks set up before keep working
async def git_hook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    if len(body) > MAX_BODY:
        raise HTTPException(413, "payload too large")
    headers = {k.lower(): v for k, v in request.headers.items()}
    sender = githooks.detect(headers)
    if not sender:
        raise HTTPException(400, "unknown sender: expected a Gitea, GitHub or GitLab webhook")
    provider, event = sender
    secret = githooks.load_secret(db)
    if not secret:
        raise HTTPException(503, "Git webhook secret is not configured")
    if not githooks.verify(provider, secret, body, headers):
        raise HTTPException(401, "bad signature" if provider != "gitlab" else "bad token")
    try:
        payload = json.loads(body)
    except ValueError as e:
        raise HTTPException(400, "invalid JSON") from e
    return {"ok": True, "provider": provider, **process(db, provider, event, payload)}


# ---------- settings ----------

EVENTS = {
    "gitea": ["workflow_run", "workflow_job", "package"],
    "github": ["workflow_run", "workflow_job", "registry_package"],
    "gitlab": ["Pipeline Hook", "Job Hook"],
}


@router.get("/integrations/git")
def git_settings(db: Session = Depends(get_db)):
    v = s.get_setting(db, githooks.SETTING)
    seen = {p: db.scalar(select(func.max(m.Build.updated_at)).where(m.Build.provider == p)) for p in githooks.PROVIDERS}
    return {"path": "/api/hooks/git", "secretSet": bool(v.get("ciphertext")), "secretCreated": v.get("created"), "events": EVENTS,
            "lastSeen": seen}


@router.post("/integrations/git/secret", dependencies=[Depends(require("resources")), Depends(require_sudo)])
def git_new_secret(db: Session = Depends(get_db)):
    value = githooks.new_secret(db)
    s.log_act(db, "Git 웹훅 비밀값 발급", "이전 비밀값은 더 이상 쓸 수 없어요", "warn")
    db.commit()
    return {"secret": value}


REPO_RE = re.compile(r"^[^/\s]+(/[^/\s]+)+$")  # owner/name, or group/subgroup/name on GitLab


class SourceRepoIn(BaseModel):
    ref: str
    sourceRepo: str


@router.put("/images/source", dependencies=[Depends(require("resources"))])
def set_source_repo(body: SourceRepoIn, db: Session = Depends(get_db)):
    img = db.get(m.Image, body.ref)
    if not img:
        raise HTTPException(404, "이미지를 찾을 수 없어요.")
    repo = body.sourceRepo.strip().lower().removesuffix(".git")
    if repo and not REPO_RE.match(repo):
        raise HTTPException(400, "레포는 owner/name 형식으로 넣어 주세요. GitLab 하위 그룹은 group/sub/name도 돼요.")
    img.source_repo = repo or None
    s.log_act(db, "빌드 레포 연결", f"{img.ref} ← {repo or '없음'}")
    db.commit()
    return img.to_dict()


@router.get("/builds")
def list_builds(image: str | None = None, db: Session = Depends(get_db), scope: set[str] | None = Depends(build_scope)):
    """Builds the viewer's groups allow (all for Owners and groups with every build)."""
    if image:
        return githooks.builds_for_image(db, image, scope=scope)
    q = select(m.Build).order_by(m.Build.updated_at.desc()).limit(30)
    if scope is not None:
        q = q.where(m.Build.repo.in_(scope))
    return [b.to_dict() for b in db.scalars(q)]


# ---------- test event (no real Git host needed) ----------

class TestIn(BaseModel):
    ref: str
    fail: bool = False
    provider: Literal["gitea", "github", "gitlab"] = "gitea"


def test_tag() -> str:
    """A tag no real build pushes: it shows on the build but never lands on the image or deploys (githooks.is_test_tag)."""
    return f"{githooks.TEST_TAG_PREFIX}{random.getrandbits(24):06x}"


STEPS = ["Set up job", "Checkout", "Login to registry", "Build and push", "Post job"]


def actions_sequence(provider: str, repo: str, owner: str, name: str, tag: str, fail: bool) -> list[tuple[float, str, dict]]:
    """Gitea Actions / GitHub Actions payloads for one image build."""
    run_id = random.randint(10_000, 99_999)
    host = "github.com" if provider == "github" else "gitea.example"
    base = {"repository": {"full_name": repo}}
    run = {"id": run_id, "run_number": run_id % 1000, "name": "image", "display_title": f"release {tag}",
           "head_branch": "main", "head_sha": f"{random.getrandbits(40):010x}", "html_url": f"https://{host}/{repo}/actions/runs/{run_id % 1000}"}
    seq: list[tuple[float, str, dict]] = [(0, "workflow_run", {**base, "action": "requested", "workflow_run": {**run, "status": "queued"}}),
                                          (1, "workflow_run", {**base, "action": "in_progress", "workflow_run": {**run, "status": "in_progress"}})]
    for i, st in enumerate(STEPS if not fail else STEPS[:4]):
        seq.append((1.6, "workflow_job", {**base, "action": "in_progress", "workflow_job": {
            "run_id": run_id, "name": "build", "status": "in_progress", "steps": [{"name": st, "status": "in_progress", "number": i + 1}]}}))
    if not fail:
        if provider == "github":
            pkg = {"name": name, "package_type": "CONTAINER", "owner": {"login": owner},
                   "package_version": {"version": f"sha256:{random.getrandbits(64):016x}", "container_metadata": {"tag": {"name": tag}}}}
            seq.append((1.2, "registry_package", {"action": "published", "registry_package": pkg}))
        else:
            seq.append((1.2, "package", {"action": "created", "package": {"type": "container", "name": name, "version": tag, "owner": {"login": owner}}}))
    seq.append((0.4, "workflow_run", {**base, "action": "completed", "workflow_run": {**run, "status": "completed", "conclusion": "failure" if fail else "success"}}))
    return seq


def gitlab_sequence(repo: str, tag: str, fail: bool) -> list[tuple[float, str, dict]]:
    """GitLab Pipeline Hook / Job Hook payloads for a tag pipeline (the image tag is the Git tag)."""
    pid = random.randint(100_000, 999_999)
    web = f"https://gitlab.example/{repo}"
    project = {"path_with_namespace": repo, "web_url": web, "default_branch": "main"}

    def pipeline(status: str, running: str | None = None) -> dict:
        return {"object_kind": "pipeline", "project": project, "commit": {"title": f"release {tag}"},
                "object_attributes": {"id": pid, "iid": pid % 1000, "name": "image", "ref": tag, "tag": True,
                                      "sha": f"{random.getrandbits(40):010x}", "status": status, "url": f"{web}/-/pipelines/{pid}"},
                "builds": [{"name": "build-push", "stage": "build", "status": "running" if running else status}]}

    seq: list[tuple[float, str, dict]] = [(0, "Pipeline Hook", pipeline("pending")), (1, "Pipeline Hook", pipeline("running", "build-push"))]
    for st in ["docker info", "docker login", "docker build", "docker push"][: 3 if fail else 4]:
        seq.append((1.6, "Job Hook", {"object_kind": "build", "pipeline_id": pid, "build_name": f"build-push · {st}",
                                      "build_status": "running", "project": project}))
    seq.append((0.8, "Pipeline Hook", pipeline("failed" if fail else "success")))
    return seq


async def _simulate(ref: str, fail: bool, provider: str) -> None:
    """Feeds the same handlers the real webhooks reach, with a realistic sequence of payloads."""
    with SessionLocal() as db:
        img = db.get(m.Image, ref)
        owner, name = ref.split("/")[-2:]
        repo, tag = img.source_repo or f"{owner}/{name}", test_tag()
    seq = gitlab_sequence(repo, tag, fail) if provider == "gitlab" else actions_sequence(provider, repo, owner, name, tag, fail)
    for delay, event, payload in seq:
        await asyncio.sleep(delay)
        with SessionLocal() as db:
            process(db, provider, event, payload)


@router.post("/integrations/git/test", dependencies=[Depends(require("resources"))])
async def git_test(body: TestIn, db: Session = Depends(get_db)):
    img = db.get(m.Image, body.ref)
    if not img:
        raise HTTPException(404, "이미지를 찾을 수 없어요.")
    if not img.source_repo:
        raise HTTPException(400, "먼저 이 이미지를 빌드하는 레포를 연결해 주세요.")
    s.log_act(db, "시험 빌드 이벤트", f"{img.ref} · {githooks.PROVIDER_NAMES[body.provider]} · {'실패' if body.fail else '성공'} 시나리오")
    db.commit()
    asyncio.get_running_loop().create_task(_simulate(body.ref, body.fail, body.provider))
    return {"ok": True, "startedAt": time.time()}
