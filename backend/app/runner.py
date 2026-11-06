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

from . import models as m
from . import store as s
from .db import SessionLocal

METHODS = {"compose": "Docker Compose", "ansible": "Ansible 플레이북"}

Line = tuple[str, str]  # (css class, text)


def build_script(db: Session, job: dict, groups: list[str], no: int, tag: str, trigger: str) -> list[dict[str, Any]]:
    inv = s.inv_of(db, job)
    img = s.image_of(db, job)
    all_hosts = s.target_hosts(inv, groups)
    hosts = [h for h in all_hosts if not s.host_skip(h)]
    skipped = [h for h in all_hosts if s.host_skip(h)]
    env = s.env_by_name(db, job["env"])
    ti = s.tag_info(img, tag)
    reg = s.registry_of(db, job)
    short = job["image"].split("/")[-1]
    names = ", ".join(h["name"] for h in hosts)
    env_label = f"{env['name']} v{env['ver']}" if env else ""

    head_lines: list[Line] = [
        ("h", f"▶ 실행 #{no} · {job['name']}"),
        ("y", f"트리거: {trigger} · {s.ME['name']}") if trigger != "수동 실행" else ("", f"트리거: 수동 실행 · {s.ME['name']}"),
        ("", f"방식: {METHODS[job['method']]}"),
        ("", f"이미지: {job['image']}:{tag} (sha256:{ti['digest']}…)"),
        ("", f"대상: {job['inventory']} / {s.target_label(groups, inv)} → {', '.join(h['ip'] for h in all_hosts)}"),
        ("", f"잠금 획득: {names} (동시 실행 금지)"),
    ]
    head = {"name": "준비", "lines": head_lines}
    tail = {"name": "마무리", "lines": [("", f"잠금 해제: {names}"), ("g", f"✔ 배포 성공 · {short}:{tag} · 서버 {len(hosts)}대")]}
    masked: list[Line] = [("m", f"  {k}=••••••••") for k, _ in (env["vars"][:3] if env else [])]

    if job["method"] == "compose":
        def per(fn):
            out: list[Line] = []
            for h in hosts:
                out.append(("h", f"[{h['name']}]"))
                out.extend(fn(h))
            return out

        return [
            head,
            {"name": "서버 연결", "lines": [
                *[("", f"ssh {h['user']}@{h['ip']}:{h['port']} · 호스트 키 지문 일치") for h in hosts],
                *[("y", f"! {h['name']} 건너뜀: {s.host_skip(h)}") for h in skipped],
                ("g", f"✓ 서버 {len(hosts)}대 연결"),
            ]},
            {"name": "파일 전송", "lines": [
                ("", f"compose.yml → {job.get('dir')}/compose.yml"),
                ("", f".env {env_label} → {job.get('dir')}/.env (권한 600)"),
                *masked,
                ("g", f"✓ 서버 {len(hosts)}대에 전송"),
            ]},
            {"name": "이미지 받기", "lines": per(lambda h: [
                ("", f"$ docker login {reg['host']} -u {reg['user']} --password-stdin"),
                ("", "Login Succeeded"),
                ("", f"$ IMAGE_TAG={tag} docker compose pull"),
                ("", f"app Pulled · sha256:{ti['digest']}…"),
            ])},
            {"name": "컨테이너 교체", "lines": per(lambda h: [
                ("", f"$ IMAGE_TAG={tag} docker compose up -d --remove-orphans"),
                ("", "Container app-1  Recreated"),
                ("", "Container app-1  Started"),
                ("", f"$ docker logout {reg['host']}"),
                ("g", f"✓ {h['name']} 교체 완료"),
            ])},
            {"name": "상태 확인", "lines": [
                *[("", f"docker compose ps · app healthy · GET :8080/healthz → 200 ({h['name']})") for h in hosts],
                ("g", "✓ 모든 서버 정상 응답"),
            ]},
            tail,
        ]

    repo = s.repo_by_name(db, job.get("repo")) or {"commit": "0000000", "branch": "main", "kind": "git", "url": ""}
    limit = ":".join(groups) if groups else "all"

    def task(name: str, suffix=None, st: str = "changed") -> list[Line]:
        out: list[Line] = [("h", f"TASK [{name}] " + "*" * max(4, 40 - len(name)))]
        for h in hosts:
            out.append(("g" if st == "ok" else "y", f"{st}: [{h['name']}]" + (suffix(h) if suffix else "")))
        return out

    fetch: list[Line] = (
        [("", f"로컬 경로: {repo['url']}"), ("", "작업 폴더로 읽기 전용 복사 (실행 후 삭제)")]
        if repo.get("kind") == "local"
        else [("", f"$ git fetch --depth 1 origin {repo['branch']}  # {job.get('repo')}"), ("", f"HEAD → {repo['commit']}")]
    )
    return [
        head,
        {"name": "플레이북 가져오기", "lines": [
            *fetch,
            ("", f"임시 인벤토리 생성: {job['inventory']} ({len(all_hosts)}대, 실행 후 삭제)"),
            ("g", f"✓ {job.get('book')} 확인"),
        ]},
        {"name": "서버 연결", "lines": [
            ("", f"$ ansible-playbook {job.get('book')} -i <임시 인벤토리> --limit {limit}"),
            ("", f"    -e image={job['image']} -e image_tag={tag} -e image_digest=sha256:{ti['digest']}…"),
            ("h", f"PLAY [{job['name']}] " + "*" * 30),
            *task("Gathering Facts", None, "ok"),
            *[("y", f"skipping: [{h['name']}] {s.host_skip(h)}") for h in skipped],
        ]},
        {"name": ".env 전송", "lines": [*task(f"Upload .env → {env_label}", lambda h: " mode=0600"), *masked]},
        {"name": "이미지 받기", "lines": [
            *task("Registry login (read-only token)"),
            *task(f"Pull {short}:{tag}"),
            *task("Registry logout"),
        ]},
        {"name": "컨테이너 교체", "lines": task("Recreate container", lambda h: f" → {tag}")},
        {"name": "상태 확인", "lines": [
            *task("Wait for /healthz", lambda h: " 200 OK", "ok"),
            ("h", "PLAY RECAP " + "*" * 30),
            *[("g", f"{h['name']:<14}: ok=7  changed=5  unreachable=0  failed=0") for h in hosts],
            *[("y", f"{h['name']:<14}: skipped") for h in skipped],
        ]},
        tail,
    ]


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
    tag = s.resolve_tag(s.image_of(db, job), requested_tag)
    steps = build_script(db, job, groups, no, tag, trigger)
    if requested_tag == "latest":
        steps[0]["lines"].insert(3, ("", f"latest → {tag} (digest로 고정해서 배포)"))
    if trigger == "되돌리기":
        steps[0]["lines"][1] = ("y", f"트리거: 되돌리기 · {s.ME['name']} · {job['tagNow']} → {tag}")

    step_names = [st["name"] for st in steps]
    db.add(m.Run(no=no, job=job["name"], job_id=job["id"], target=s.target_label(groups, s.inv_of(db, job)), tag=tag,
                 status="run", by=s.ME["name"], trigger=trigger, time="방금", duration="-", steps=step_names, started_at=time.time()))
    db.commit()

    live[no] = {"events": [], "done": False, "cancelled": False, "t0": time.time(),
                "job_id": job["id"], "job_name": job["name"], "tag": tag}
    asyncio.get_running_loop().create_task(_play(no, steps))
    return {"no": no, "tag": tag, "steps": step_names}


def cancel_run(no: int) -> bool:
    run = live.get(no)
    if not run or run["done"]:
        return False
    run["cancelled"] = True
    _emit(no, {"t": "cancel"})
    _emit(no, {"t": "line", "c": "y", "text": f"! {s.ME['name']}님이 실행을 취소했어요. 진행 중이던 단계를 정리하고 잠금을 풀었어요.", "ts": s.now_hms()})
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
        for cls, text in st["lines"]:
            events.append({"t": "line", "c": cls, "text": text, "ts": "—"})
        events.append({"t": "step", "i": i, "state": "ok" if ok or i < 2 else "bad"})
    if not ok:
        events.append({"t": "line", "c": "r", "text": "✗ 상태 확인 실패: /healthz 503 · 이전 태그로 롤백했어요", "ts": "—"})
    events.append({"t": "done", "status": rec.status, "duration": rec.duration})
    return [st["name"] for st in steps], events
