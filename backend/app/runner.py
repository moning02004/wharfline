"""Simulated deploy runner.

Builds the step/log script for a job and plays it back as a stream of events.
Runs keep going in a background task even if nobody is watching the stream,
so closing the log window in the UI does not stop a deploy. Live events are
kept in memory while a run plays; the result and full log are written to the
database when it ends.
"""

from __future__ import annotations

import asyncio
import random
import time
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from . import githooks
from . import models as m
from . import store as s
from .db import SessionLocal

Line = tuple[str, str]  # (css class, text)


def method_label(job: dict) -> str:
    pb = job["playbook"]
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
    return out


def build_script(db: Session, job: dict, groups: list[str], no: int, tag: str, trigger: str) -> list[dict[str, Any]]:
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
    await asyncio.sleep(0.3)
    for i, step in enumerate(steps):
        if run["cancelled"]:
            return
        step_t0 = time.time()
        _emit(no, {"t": "step", "i": i, "state": "run"})
        for cls, text in step["lines"]:
            await asyncio.sleep(0.16 + random.random() * 0.3)
            if run["cancelled"]:
                return
            _emit(no, {"t": "line", "c": cls, "text": text, "ts": s.now_hms()})
        await asyncio.sleep(0.25)
        if run["cancelled"]:
            return
        _emit(no, {"t": "step", "i": i, "state": "ok", "d": f"{time.time() - step_t0:.1f}s"})
    _finish(no, "ok")


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
            job.last_status, job.last_time, job.last_duration = status, "방금", d
            if status == "ok":
                job.tag_now = run["tag"]
        action = "배포 취소" if status == "cancel" else "배포 실행"
        result = "ok" if status == "ok" else "warn" if status == "cancel" else "bad"
        s.log_act(db, action, f"{run['job_name']} #{no} · {run['tag']}", result)
        db.commit()


def start_run(db: Session, job: dict, groups: list[str], requested_tag: str, trigger: str) -> dict:
    no = db.scalar(select(m.run_no_seq.next_value()))
    tag = s.resolve_tag(s.image_of(db, job), requested_tag) if job.get("image") else "-"
    steps = build_script(db, job, groups, no, tag, trigger)
    if job.get("image") and requested_tag == "latest":
        steps[0]["lines"].insert(3, ("", f"latest → {tag} (digest로 고정해서 배포)"))
    if trigger == "되돌리기":
        steps[0]["lines"][1] = ("y", f"트리거: 되돌리기 · {s.actor_name(db)} · {job['tagNow']} → {tag}")

    step_names = [st["name"] for st in steps]
    db.add(m.Run(no=no, job=job["name"], job_id=job["id"], target=s.target_label(groups, s.inv_of(db, job)), tag=tag,
                 status="run", by=s.actor_name(db), trigger=trigger, time="방금", duration="-", steps=step_names, started_at=time.time()))
    db.commit()

    live[no] = {"events": [], "done": False, "cancelled": False, "t0": time.time(),
                "job_id": job["id"], "job_name": job["name"], "tag": tag}
    asyncio.get_running_loop().create_task(_play(no, steps))
    return {"no": no, "tag": tag, "steps": step_names}


def cancel_run(no: int, by: str) -> bool:
    run = live.get(no)
    if not run or run["done"]:
        return False
    run["cancelled"] = True
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
    inv = s.inv_of(db, job)
    groups = [] if rec.target == "전체" else [g.strip() for g in rec.target.split(",") if g.strip() in s.groups_of(inv)]
    steps = build_script(db, job, groups, rec.no, rec.tag, rec.trigger)
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
