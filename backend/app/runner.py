"""Deploy runs: start, stream, cancel, and record them.

A run really deploys through app/executor.py (ansible-playbook for playbook jobs, SSH for script
jobs). With WHARFLINE_RUN_SIMULATE=1 or WHARFLINE_SSH_SIMULATE=1 (tests, demos) it instead plays
back a simulated step/log script built here.

Runs keep going in a background task even if nobody is watching the stream,
so closing the log window in the UI does not stop a deploy. Live events are
kept in memory while a run plays; the result and full log are written to the
database when it ends.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
import time
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from . import executor
from . import githooks
from . import notify
from . import models as m
from . import store as s
from .db import SessionLocal

Line = tuple[str, str]  # (css class, text)

# Playback speed of the simulated run: 1 = real-time feel, 0 = instant (tests set this).
PACE = 1.0


def method_label(job: dict) -> str:
    pb = job["playbook"]
    if job.get("script") is not None:
        return f"SSH 스크립트 ({len(job['script'])}단계)"
    return f"기본 플레이북 {pb['path']}" if pb["kind"] == "builtin" else f"플레이북 {pb['repo']} / {pb['path']}"


def extra_vars(job: dict, tag: str, has_env: bool) -> dict[str, str]:
    """Variables passed to the playbook with -e. Image vars only when the job has an image."""
    app = s.app_slug(job["name"])
    out: dict[str, str] = {}
    if job.get("image"):
        out.update(image=job["image"], image_tag=tag, image_ref=f"{job['image']}:{tag}")
    if has_env:
        out["env_file"] = f"/srv/wharfline/{app}/.env"
    out["app_name"] = app
    for k, v in extra_image_vars(job).items():
        out[k.lower()] = v
    return out


def extra_image_vars(job: dict) -> dict[str, str]:
    """VAR_IMAGE, VAR_TAG, VAR_IMAGE_REF for each extra watched image, with the tag this run uses."""
    tags = job.get("extraTags") or {}
    out: dict[str, str] = {}
    for x in job.get("extraImages") or []:
        if not x["var"]:
            continue  # watched only: the file decides the version
        tag = tags.get(x["var"]) or x.get("defaultTag") or "latest"
        out.update({f"{x['var']}_IMAGE": x["ref"], f"{x['var']}_TAG": tag, f"{x['var']}_IMAGE_REF": f"{x['ref']}:{tag}"})
        if x.get("tagVar"):  # the file reads ${APP_VERSION}, not ${APP_VERSION_TAG}
            out[x["tagVar"]] = tag
    return out


def extra_image_lines(job: dict) -> list[Line]:
    tags = job.get("extraTags") or {}
    return [("", f"이미지 {x['var']}: {x['ref']}:{tags.get(x['var']) or x.get('defaultTag')}") if x["var"]
            else ("", f"이미지 {x['ref']}:{x.get('literal') or 'latest'} (파일에 적힌 버전)") for x in job.get("extraImages") or []]


# Simulation only: a step whose commands contain a line like `exit 1` or `false` fails on every server,
# so the failure path (failed / skipped / recap) can be seen without real servers.
FAIL_LINE = re.compile(r"^\s*(exit\s+[1-9]\d*|false)\s*$", re.M)


def script_env(job: dict, tag: str, has_env: bool) -> dict[str, str]:
    """Environment variables an SSH script gets. The .env goes into the service folder, where compose reads it."""
    path = job.get("servicePath") or f"/srv/{s.app_slug(job['name'])}"
    out: dict[str, str] = {"SERVICE_PATH": path}
    if job.get("image"):
        out.update(IMAGE=job["image"], IMAGE_TAG=tag, IMAGE_REF=f"{job['image']}:{tag}")
    if has_env:
        out["ENV_FILE"] = f"{path}/.env"
    out.update(extra_image_vars(job))
    return out


def build_ssh_script(db: Session, job: dict, groups: list[str], no: int, tag: str, trigger: str) -> list[dict[str, Any]]:
    """Steps for an SSH script job: each script step runs on every reachable server, in order.

    A server whose step fails skips its remaining steps; the other servers carry on. The log ends with a
    per-server recap (ok / failed / skipped), like an Ansible PLAY RECAP.
    """
    inv = s.inv_of(db, job)
    img = s.image_of(db, job)
    has_image = bool(job.get("image"))
    all_hosts = s.target_hosts(inv, groups)
    hosts = [h for h in all_hosts if not s.host_skip(h)]
    unreachable = [h for h in all_hosts if s.host_skip(h)]
    env = s.env_by_name(db, job["env"]) if job["env"] else None
    reg = s.registry_of(db, job)
    private = has_image and not reg.get("public")
    names = ", ".join(h["name"] for h in hosts)
    variables = script_env(job, tag, bool(env))
    script = job["script"] or []

    head_lines: list[Line] = [
        ("h", f"▶ 실행 #{no} · {job['name']}"),
        ("y", f"트리거: {trigger} · {s.actor_name(db)}") if trigger != "수동 실행" else ("", f"트리거: 수동 실행 · {s.actor_name(db)}"),
        ("", f"방식: {method_label(job)}"),
    ]
    if has_image:
        ti = s.tag_info(img, tag)
        head_lines.append(("", f"이미지: {job['image']}:{tag} (sha256:{ti['digest']}…)"))
    head_lines += extra_image_lines(job)
    head_lines += [
        ("", f"대상: {job['inventory']} / {s.target_label(groups, inv)} → {', '.join(h['ip'] for h in all_hosts)}"),
        ("", f"잠금 획득: {names} (동시 실행 금지)"),
    ]
    steps: list[dict[str, Any]] = [{"name": "준비", "lines": head_lines}]

    def header(title: str) -> Line:
        return ("h", f"TASK [{title}] " + "*" * max(4, 40 - len(title)))

    # Per-server tally for the recap.
    tally = {h["name"]: {"ok": 0, "failed": 0, "skipped": 0} for h in hosts}
    alive = [h for h in hosts]  # servers that haven't failed yet

    connect: list[Line] = [header("SSH 연결")]
    for h in hosts:
        connect.append(("g", f"ok: [{h['name']}] {h.get('user', 'deploy')}@{h['ip']}:{h.get('port', 22)} · 호스트 키 확인됨"))
        tally[h["name"]]["ok"] += 1
    connect += [("y", f"skipping: [{h['name']}] {s.host_skip(h)}") for h in unreachable]
    connect.append(("", "환경 변수: " + " ".join(f"{k}={v}" for k, v in variables.items())))
    steps.append({"name": "서버 연결", "lines": connect})

    files = job.get("files") or []
    if files:
        lines: list[Line] = [header(f"파일 올리기 → {variables['SERVICE_PATH']} ({len(files)}개)")]
        lines += [("", f"  {f['path']}") for f in files[:8]]
        if len(files) > 8:
            lines.append(("", f"  … 외 {len(files) - 8}개"))
        for h in alive:
            lines.append(("y", f"changed: [{h['name']}] mkdir -p {variables['SERVICE_PATH']} · {len(files)}개 파일"))
            tally[h["name"]]["ok"] += 1
        steps.append({"name": "파일 올리기", "lines": lines})
    if env:
        lines = [header(f"Upload .env → {variables['ENV_FILE']} ({env['name']} v{env['ver']})")]
        for h in alive:
            # The service folder may not exist yet on a new server: create it before the upload.
            lines.append(("y", f"changed: [{h['name']}] mkdir -p {variables['SERVICE_PATH']} · .env mode=0600"))
            tally[h["name"]]["ok"] += 1
        lines += [("m", f"  {k}=••••••••") for k in env["keys"][:3]]
        steps.append({"name": ".env 전송", "lines": lines})
    if private:
        lines = [header("레지스트리 로그인 (읽기 전용 토큰, 스크립트에 노출하지 않아요)")]
        for h in alive:
            lines.append(("g", f"ok: [{h['name']}] docker login {job['image'].split('/')[0]}"))
        steps.append({"name": "레지스트리 로그인", "lines": lines})

    failed_at: str | None = None
    for st in script:
        lines = [header(st["name"])]
        lines += [("", f"$ {cmd}") for cmd in st["run"].splitlines() if cmd.strip()][:6]
        fails = bool(FAIL_LINE.search(st["run"]))
        step = {"name": st["name"], "lines": lines}
        for h in hosts:
            if h not in alive:
                lines.append(("y", f"skipping: [{h['name']}] 앞 단계가 실패했어요"))
                tally[h["name"]]["skipped"] += 1
            elif fails:
                lines.append(("r", f"failed: [{h['name']}] exit 1"))
                tally[h["name"]]["failed"] += 1
                step["fail"] = True
            else:
                lines.append(("g", f"ok: [{h['name']}]"))
                tally[h["name"]]["ok"] += 1
        if fails:
            alive = []
            failed_at = failed_at or st["name"]
        steps.append(step)

    finish: list[Line] = []
    if private:
        finish.append(header("레지스트리 로그아웃"))
        finish += [("g", f"ok: [{h['name']}]") for h in hosts]
    finish.append(("h", "PLAY RECAP " + "*" * 30))
    for h in hosts:
        t = tally[h["name"]]
        cls = "r" if t["failed"] else "g"
        finish.append((cls, f"{h['name']:<14}: ok={t['ok']}  failed={t['failed']}  skipped={t['skipped']}"))
    finish += [("y", f"{h['name']:<14}: unreachable · {s.host_skip(h)}") for h in unreachable]
    finish.append(("", f"잠금 해제: {names}"))
    bad = [h for h in hosts if tally[h["name"]]["failed"]]
    if bad:
        finish.append(("r", f"✘ 배포 실패 · '{failed_at}' 단계에서 서버 {len(bad)}대 실패"))
    else:
        done = f"{job['image'].split('/')[-1]}:{tag}" if has_image else method_label(job)
        finish.append(("g", f"✔ 배포 성공 · {done} · 서버 {len(hosts)}대"))
    steps.append({"name": "마무리", "lines": finish, **({"fail": True} if bad else {})})
    return steps


def build_script(db: Session, job: dict, groups: list[str], no: int, tag: str, trigger: str) -> list[dict[str, Any]]:
    if job.get("script") is not None:
        return build_ssh_script(db, job, groups, no, tag, trigger)
    inv = s.inv_of(db, job)
    img = s.image_of(db, job)
    has_image = bool(job.get("image"))
    all_hosts = s.target_hosts(inv, groups)
    hosts = [h for h in all_hosts if not s.host_skip(h)]
    skipped = [h for h in all_hosts if s.host_skip(h)]
    env = s.env_by_name(db, job["env"]) if job["env"] else None
    reg = s.registry_of(db, job)
    pb = job["playbook"]
    book = pb["path"]
    names = ", ".join(h["name"] for h in hosts)
    env_label = f"{env['name']} v{env['ver']}" if env else ""
    xv = extra_vars(job, tag, bool(env))

    head_lines: list[Line] = [
        ("h", f"▶ 실행 #{no} · {job['name']}"),
        ("y", f"트리거: {trigger} · {s.actor_name(db)}") if trigger != "수동 실행" else ("", f"트리거: 수동 실행 · {s.actor_name(db)}"),
        ("", f"방식: {method_label(job)}"),
    ]
    if has_image:
        ti = s.tag_info(img, tag)
        head_lines.append(("", f"이미지: {job['image']}:{tag} (sha256:{ti['digest']}…)"))
    else:
        head_lines.append(("", "이미지: 없음 · 플레이북만 실행"))
    head_lines += extra_image_lines(job)
    head_lines += [
        ("", f"대상: {job['inventory']} / {s.target_label(groups, inv)} → {', '.join(h['ip'] for h in all_hosts)}"),
        ("", f"잠금 획득: {names} (동시 실행 금지)"),
    ]
    built = githooks.build_for_tag(db, job["image"], tag) if has_image else None
    if built:
        head_lines.insert(4, ("", githooks.build_line(built)))
    head = {"name": "준비", "lines": head_lines}
    done = f"{job['image'].split('/')[-1]}:{tag}" if has_image else book
    tail = {"name": "마무리", "lines": [("", f"잠금 해제: {names}"), ("g", f"✔ 배포 성공 · {done} · 서버 {len(hosts)}대")]}
    masked: list[Line] = [("m", f"  {k}=••••••••") for k in (env["keys"][:3] if env else [])]

    repo = s.repo_by_name(db, pb["repo"]) or {"commit": "0000000", "branch": pb["branch"], "kind": pb["kind"], "url": pb["url"], "auth": "-"}
    limit = ":".join(groups) if groups else "all"

    def task(name: str, suffix=None, st: str = "changed") -> list[Line]:
        out: list[Line] = [("h", f"TASK [{name}] " + "*" * max(4, 40 - len(name)))]
        for h in hosts:
            out.append(("g" if st == "ok" else "y", f"{st}: [{h['name']}]" + (suffix(h) if suffix else "")))
        return out

    if repo["kind"] == "builtin":
        fetch: list[Line] = [("", f"Wharfline 기본 플레이북 {book}: 이미지를 .env와 함께 컨테이너로 띄워요")]
    elif repo["kind"] == "local":
        fetch = [("", f"로컬 경로: {repo['url']}"), ("", "작업 폴더로 읽기 전용 복사 (실행 후 삭제)")]
    else:
        fetch = [("", f"$ git clone --depth 1 --branch {repo['branch']} {repo['url']}   # {repo['auth']}"), ("", f"HEAD → {repo['commit']}")]

    steps: list[dict[str, Any]] = [
        head,
        {"name": "플레이북 가져오기", "lines": [
            *fetch,
            ("", f"임시 인벤토리 생성: {job['inventory']} ({len(all_hosts)}대, 실행 후 삭제)"),
            ("g", f"✓ {book} 확인"),
        ]},
        {"name": "서버 연결", "lines": [
            ("", f"$ ansible-playbook {book} -i <임시 인벤토리> --limit {limit} \\"),
            ("", "    " + " ".join(f"-e {k}={v}" for k, v in xv.items())),
            ("h", f"PLAY [{job['name']}] " + "*" * 30),
            *task("Gathering Facts", None, "ok"),
            *[("y", f"skipping: [{h['name']}] {s.host_skip(h)}") for h in skipped],
        ]},
        {"name": ".env 전송", "lines": [*task(f"Upload .env → {xv.get('env_file')} ({env_label})", lambda h: " mode=0600"), *masked] if env
         else [("", "환경 변수 없음 · 건너뜀")]},
    ]
    if has_image:
        short = job["image"].split("/")[-1]
        login = [("", "공개 이미지 · 로그인 없이 받아요")] if reg.get("public") else task("Registry login (read-only token)")
        steps += [
            {"name": "이미지 받기", "lines": [
                *login,
                *task(f"Pull {short}:{tag}"),
                *([] if reg.get("public") else task("Registry logout")),
            ]},
            {"name": "컨테이너 교체", "lines": task("Recreate container", lambda h: f" → {tag}")},
        ]
    else:
        steps.append({"name": "플레이북 실행", "lines": task(f"Run {book}")})
    steps += [
        {"name": "상태 확인", "lines": [
            *task("Wait for /healthz", lambda h: " 200 OK", "ok"),
            ("h", "PLAY RECAP " + "*" * 30),
            *[("g", f"{h['name']:<14}: ok=7  changed=5  unreachable=0  failed=0") for h in hosts],
            *[("y", f"{h['name']:<14}: skipped") for h in skipped],
        ]},
        tail,
    ]
    return steps


def fmt_duration(sec: float) -> str:
    sec = round(sec)
    return f"{sec // 60}m {sec % 60:02d}s"


# Live run state: no -> {"events": [...], "done": bool, "cancelled": bool, ...}
live: dict[int, dict[str, Any]] = {}


def _emit(no: int, ev: dict) -> None:
    live[no]["events"].append(ev)


async def _play(no: int, steps: list[dict]) -> None:
    run = live[no]
    await asyncio.sleep(0.3 * PACE)
    for i, step in enumerate(steps):
        if run["cancelled"]:
            return
        step_t0 = time.time()
        _emit(no, {"t": "step", "i": i, "state": "run"})
        for cls, text in step["lines"]:
            await asyncio.sleep((0.16 + random.random() * 0.3) * PACE)
            if run["cancelled"]:
                return
            _emit(no, {"t": "line", "c": cls, "text": text, "ts": s.now_hms()})
        await asyncio.sleep(0.25 * PACE)
        if run["cancelled"]:
            return
        _emit(no, {"t": "step", "i": i, "state": "bad" if step.get("fail") else "ok", "d": f"{time.time() - step_t0:.1f}s"})
    _finish(no, "bad" if any(st.get("fail") for st in steps) else "ok")


def _finish(no: int, status: str) -> None:
    run = live[no]
    if run["done"]:
        return
    d = fmt_duration(time.time() - run["t0"])
    run["done"] = True
    _emit(no, {"t": "done", "status": status, "duration": d})
    with SessionLocal() as db:
        db.execute(update(m.Run).where(m.Run.no == no).values(status=status, duration=d, time="방금", log=list(run["events"])))
        job = db.get(m.Job, run["job_id"])
        if job:
            job.last_status, job.last_time, job.last_duration, job.last_at = status, "방금", d, time.time()
            if status == "ok":
                job.tag_now = run["tag"]
                if run.get("extra") and job.extra_images:
                    job.extra_images = [{**x, "tagNow": run["extra"].get(x["var"], x.get("tagNow", "-"))} for x in job.extra_images]
        action = "배포 취소" if status == "cancel" else "배포 실행"
        result = "ok" if status == "ok" else "warn" if status == "cancel" else "bad"
        s.log_act(db, action, f"{run['job_name']} #{no} · {run['tag']}", result)
        db.commit()
        notify.notify_run(db, no, status)  # queued for a background thread; never raises


def run_groups(db: Session, rec: m.Run, job: dict) -> list[str]:
    """The inventory groups a run targets, read back from its target label."""
    inv = s.inv_of(db, job)
    return [] if rec.target == "전체" else [g.strip() for g in rec.target.split(",") if g.strip() in s.groups_of(inv)]


def _script(db: Session, job: dict, groups: list[str], no: int, tag: str, trigger: str, requested_tag: str | None) -> list[dict[str, Any]]:
    steps = build_script(db, job, groups, no, tag, trigger)
    if job.get("image") and requested_tag == "latest":
        steps[0]["lines"].insert(3, ("", f"latest → {tag} (digest로 고정해서 배포)"))
    if trigger == "되돌리기":
        steps[0]["lines"][1] = ("y", f"트리거: 되돌리기 · {s.actor_name(db)} · {job['tagNow']} → {tag}")
    return steps


def pin_extra_tags(db: Session, job: dict, asked: dict[str, str] | None) -> dict[str, str]:
    """The tag each extra image runs with: what was asked, else the one running now, else the job's default; latest is pinned."""
    out: dict[str, str] = {}
    for x in job.get("extraImages") or []:
        if not x["var"]:
            continue
        want = (asked or {}).get(x["var"]) or (x["tagNow"] if x.get("tagNow") not in (None, "", "-") else x["defaultTag"])
        img = db.get(m.Image, x["ref"])
        out[x["var"]] = s.resolve_tag(img.to_dict(), want) if img else want
    return out


def mark_job(db: Session, job_id: str, status: str) -> None:
    """The job's 최근 실행 as a run changes: "run" when it starts, "approval" while it waits, "rejected"; _finish sets the end."""
    job = db.get(m.Job, job_id)
    if job:
        job.last_status, job.last_time, job.last_duration, job.last_at = status, "방금", "-", time.time()


def create_run(db: Session, job: dict, groups: list[str], requested_tag: str, trigger: str,
               status: str = "run", requested_by: str | None = None, extra_tags: dict[str, str] | None = None) -> m.Run:
    """Add the run row (not committed). Tags are pinned now, so an approval later deploys what was asked for."""
    no = db.scalar(select(m.run_no_seq.next_value()))
    tag = s.resolve_tag(s.image_of(db, job), requested_tag) if job.get("image") else "-"
    extras = pin_extra_tags(db, job, extra_tags)
    job = {**job, "extraTags": extras}
    step_names = (executor.step_names(db, job) if not executor.simulated()
                  else [st["name"] for st in build_script(db, job, groups, no, tag, trigger)])
    rec = m.Run(no=no, job=job["name"], job_id=job["id"], target=s.target_label(groups, s.inv_of(db, job)), tag=tag,
                status=status, by=s.actor_name(db), trigger=trigger, time="방금", started_at=time.time(), duration="-", steps=step_names,
                requested_by=requested_by, extra_tags=extras or None, files_ver=job.get("filesVer"))
    db.add(rec)
    mark_job(db, job["id"], status)
    db.flush()
    return rec


def launch(db: Session, rec: m.Run, job: dict, groups: list[str], requested_tag: str | None = None, note: str | None = None) -> dict:
    """Start playing a run row back in a background task; commits. `note` adds a line under the trigger (e.g. who approved)."""
    job = {**job, "extraTags": rec.extra_tags or {}}
    plan = None
    if executor.simulated():
        steps = _script(db, job, groups, rec.no, rec.tag, rec.trigger, requested_tag)
        if note:
            steps[0]["lines"].insert(2, ("y", note))
        step_names = [st["name"] for st in steps]
    else:
        head = real_head(db, job, groups, rec, requested_tag, note)
        plan = executor.build_plan(db, job, groups, rec.no, rec.tag, head)
        step_names = plan.steps
    rec.status, rec.time, rec.steps, rec.started_at = "run", "방금", step_names, time.time()
    mark_job(db, job["id"], "run")
    db.commit()

    no = rec.no
    live[no] = {"events": [], "done": False, "cancelled": False, "t0": time.time(),
                "job_id": job["id"], "job_name": job["name"], "tag": rec.tag, "extra": dict(rec.extra_tags or {})}
    coro = executor.execute(plan) if plan else _play(no, steps)
    live[no]["task"] = asyncio.get_running_loop().create_task(coro)
    return {"no": no, "tag": rec.tag, "steps": step_names, "status": "run"}


def real_head(db: Session, job: dict, groups: list[str], rec: m.Run, requested_tag: str | None, note: str | None) -> list[Line]:
    """The first lines of a real run's log: who started it, what it deploys, where."""
    inv = s.inv_of(db, job)
    hosts = s.target_hosts(inv, groups)
    who = s.actor_name(db)
    lines: list[Line] = [("h", f"▶ 실행 #{rec.no} · {job['name']}")]
    if rec.trigger == "되돌리기":
        lines.append(("y", f"트리거: 되돌리기 · {who} · {job['tagNow']} → {rec.tag}"))
    else:
        lines.append(("y" if rec.trigger != "수동 실행" else "", f"트리거: {rec.trigger} · {who}"))
    if note:
        lines.append(("y", note))
    lines.append(("", f"방식: {method_label(job)}"))
    if job.get("image"):
        lines.append(("", f"이미지: {job['image']}:{rec.tag}"))
        if requested_tag == "latest":
            lines.append(("", f"latest → {rec.tag}"))
        built = githooks.build_for_tag(db, job["image"], rec.tag)
        if built:
            lines.append(("", githooks.build_line(built)))
    elif job.get("script") is None:
        lines.append(("", "이미지: 없음 · 플레이북만 실행"))
    lines += extra_image_lines(job)
    lines.append(("", f"대상: {job['inventory']} / {s.target_label(groups, inv)} → {', '.join(h['ip'] for h in hosts)}"))
    return lines


# ---------- one run at a time per job ----------

def active_run(job_id: str) -> int | None:
    """The run of this job playing now, if any."""
    return next((no for no, r in live.items() if r.get("job_id") == job_id and not r["done"]), None)


# Auto-deploys wait this long for more pushes before starting, so the images of one release
# (backend and frontend pushed seconds apart) go out in a single run.
AUTO_DELAY = float(os.environ.get("WHARFLINE_AUTO_DELAY", "20"))
# job id -> {"tag": main image tag or None, "extra": {VAR: tag}, "task": asyncio.Task}
pending: dict[str, dict[str, Any]] = {}


def queue_auto(job_id: str, main_tag: str | None, extra_tags: dict[str, str]) -> None:
    """Add a pushed tag to the job's next auto-deploy, which starts after AUTO_DELAY and after any run playing now."""
    p = pending.setdefault(job_id, {"tag": None, "extra": {}, "task": None})
    if main_tag:
        p["tag"] = main_tag
    p["extra"].update(extra_tags)
    if p["task"] is None or p["task"].done():
        p["task"] = asyncio.get_running_loop().create_task(_auto_after(job_id))


async def _auto_after(job_id: str) -> None:
    await asyncio.sleep(AUTO_DELAY)
    while active_run(job_id) is not None:  # a push during a run deploys after it, on top of what it deployed
        await asyncio.sleep(1 if AUTO_DELAY else 0.05)
    p = pending.pop(job_id, None)
    if not p:
        return
    with SessionLocal() as db:
        job = db.get(m.Job, job_id)
        if not job or not job.hook:
            return
        j = job.to_dict()
        if not [h for h in s.target_hosts(s.inv_of(db, j), j["targets"]) if not s.host_skip(h)]:
            return
        main = p["tag"] or (job.tag_now if job.tag_now not in ("", "-") else job.default_tag)
        if job.protected:
            request_approval(db, j, j["targets"], main, "새 이미지 push", None, extra_tags=p["extra"])
        else:
            start_run(db, j, j["targets"], main, "새 이미지 push", extra_tags=p["extra"])


def start_run(db: Session, job: dict, groups: list[str], requested_tag: str, trigger: str, requested_by: str | None = None,
              extra_tags: dict[str, str] | None = None) -> dict:
    rec = create_run(db, job, groups, requested_tag, trigger, requested_by=requested_by, extra_tags=extra_tags)
    return launch(db, rec, job, groups, requested_tag)


def request_approval(db: Session, job: dict, groups: list[str], requested_tag: str, trigger: str, requested_by: str | None,
                     extra_tags: dict[str, str] | None = None) -> dict:
    """A protected job asked to run without the right to: a run waiting for an Owner/Admin. Commits."""
    rec = create_run(db, job, groups, requested_tag, trigger, status="approval", requested_by=requested_by, extra_tags=extra_tags)
    s.log_act(db, "배포 승인 요청", f"{job['name']} #{rec.no} · {rec.tag}", "warn")
    db.commit()
    notify.notify_run(db, rec.no, "approval")
    return {"no": rec.no, "tag": rec.tag, "steps": rec.steps or [], "status": "approval"}


def cancel_run(no: int, by: str) -> bool:
    run = live.get(no)
    if not run or run["done"]:
        return False
    run["cancelled"] = True
    task = run.get("task")
    if task and not task.done():
        task.cancel()  # a real run stops its ansible-playbook process / SSH sessions
    _emit(no, {"t": "cancel"})
    _emit(no, {"t": "line", "c": "y", "text": f"! {by}님이 실행을 취소했어요. 진행 중이던 단계를 정리하고 잠금을 풀었어요.", "ts": s.now_hms()})
    _finish(no, "cancel")
    return True


def mark_interrupted(db: Session) -> None:
    """Runs left as "run" by a previous process can never finish; mark them failed."""
    db.execute(update(m.Run).where(m.Run.status == "run").values(status="bad", time="중단됨"))
    db.commit()


def replay_events(db: Session, rec: m.Run, job: dict) -> tuple[list[str], list[dict]]:
    """Rebuild a log for runs that have no saved log (the sample history)."""
    steps = build_script(db, job, run_groups(db, rec, job), rec.no, rec.tag, rec.trigger)
    ok = rec.status == "ok"
    events: list[dict] = []
    for i, st in enumerate(steps):
        lines = st["lines"]
        if not ok and i == len(steps) - 1:
            lines = [ln for ln in lines if "배포 성공" not in ln[1]]  # a failed run never reports success
        for cls, text in lines:
            events.append({"t": "line", "c": cls, "text": text, "ts": "—"})
        events.append({"t": "step", "i": i, "state": "ok" if ok or i < 2 else "bad"})
    if not ok:
        events.append({"t": "line", "c": "r", "text": "✗ 상태 확인 실패: /healthz 503 · 이전 태그로 롤백했어요", "ts": "—"})
    events.append({"t": "done", "status": rec.status, "duration": rec.duration})
    return [st["name"] for st in steps], events
