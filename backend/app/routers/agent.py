"""The API agents call. No login: enrollment takes a one-time token, everything after is signed (agentproto).

POST /api/agent/enroll                  {token, key, box, info} → {id, serverKey, serverBox, host}
POST /api/agent/poll                    {info}                  → {task: {sealed}, sig} or {task: null}
POST /api/agent/tasks/{id}/lines        {lines: [text, ...]}    output while a task runs
POST /api/agent/tasks/{id}/finish       {result: {...}}         the task's result
GET  /api/agent/install.sh                                      installer for servers Wharfline can't SSH into
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import agentinstall, agentproto
from .. import models as m
from .. import store as s
from ..agenthub import HUB, POLL_WAIT
from ..db import SessionLocal, get_db

router = APIRouter(prefix="/api/agent", tags=["agent"])

SETTING = "agent"
MAX_LINES = 500
MAX_INFO = 64 * 1024


def agent_url(db: Session) -> str:
    """The address agents use to reach Wharfline (may differ from what browsers use, e.g. a LAN address)."""
    v = s.get_setting(db, SETTING).get("url") or os.getenv("WHARFLINE_AGENT_URL") or os.getenv("WHARFLINE_URL") or ""
    if not v:
        origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]
        v = origins[0] if origins else ""
    return v.rstrip("/")


def _clean_info(info: Any) -> dict[str, Any]:
    if not isinstance(info, dict) or len(json.dumps(info)) > MAX_INFO:
        return {}
    keep = ("version", "hostname", "ip", "policy", "sudo", "containers", "docker", "rollout", "sshPort")
    return {k: info[k] for k in keep if k in info}


def _apply_info(h: m.Host, info: dict[str, Any]) -> None:
    if not info:
        return
    merged = {**(h.agent_info or {}), **info}
    h.agent_info = merged
    if info.get("version"):
        h.agent_version = str(info["version"])[:64]
    ip = str(info.get("ip") or "")[:255]
    if ip and (not h.ip or h.status == "pending"):
        h.ip = ip


# ---------- enrollment ----------

@router.post("/enroll")
async def enroll(request: Request, db: Session = Depends(get_db)):
    try:
        body = json.loads(await request.body() or b"{}")
    except ValueError as e:
        raise HTTPException(400, "invalid JSON") from e
    token, key, box = str(body.get("token") or ""), str(body.get("key") or ""), str(body.get("box") or "")
    try:
        agentproto.public_key(key)
    except ValueError as e:
        raise HTTPException(400, "bad public key") from e
    if not agentproto.box_public_ok(box):
        raise HTTPException(400, "bad sealing key")
    row = db.get(m.EnrollToken, agentproto.token_hash(token)) if token else None
    if not row or row.used_at or row.expires_at < time.time():
        raise HTTPException(401, "enrollment token is unknown, used or expired: make a new one in Wharfline")
    h = db.get(m.Host, row.host_id)
    if not h:
        raise HTTPException(401, "the server was removed from Wharfline")
    HUB.kick(h.id)
    row.used_at = time.time()
    h.agent_id, h.agent_key, h.agent_box, h.agent_seen = agentproto.new_agent_id(), key, box, time.time()
    h.agent_info = {}
    _apply_info(h, _clean_info(body.get("info")))
    h.status = "on"
    h.host_key = "ok"
    inv = h.inventory
    s.log_act(db, "에이전트 등록", f"{inv.name} · {h.name} ({h.ip or '-'})")
    keys = agentproto.server_keys(db)
    db.commit()
    return {"id": h.agent_id, "serverKey": keys.sign_public, "serverBox": keys.box_public, "host": h.name}


# ---------- signed requests ----------

async def signed_host(request: Request) -> tuple[int, bytes]:
    """(host id, body) of a request signed by an enrolled agent."""
    body = await request.body()
    aid = request.headers.get(agentproto.HDR_ID, "")
    with SessionLocal() as db:
        h = db.scalar(select(m.Host).where(m.Host.agent_id == aid)) if aid else None
        if not h or not h.agent_key:
            raise HTTPException(401, "unknown agent: enroll again")
        why = agentproto.check_request(h.agent_key, request.method, request.url.path,
                                       request.headers.get(agentproto.HDR_TIME, ""), request.headers.get(agentproto.HDR_SIG, ""), body)
        if why:
            raise HTTPException(401, why)
        return h.id, body


def _json(body: bytes) -> dict[str, Any]:
    try:
        v = json.loads(body or b"{}")
    except ValueError as e:
        raise HTTPException(400, "invalid JSON") from e
    if not isinstance(v, dict):
        raise HTTPException(400, "invalid JSON")
    return v


@router.post("/poll")
async def poll(request: Request):
    host_id, body = await signed_host(request)
    data = _json(body)
    info = _clean_info(data.get("info"))
    with SessionLocal() as db:
        h = db.get(m.Host, host_id)
        box = h.agent_box if h else None
        if h:
            h.agent_seen = time.time()
            _apply_info(h, info)
            if h.status == "off":
                h.status = "on"
            db.commit()
        keys = agentproto.server_keys(db)
    if not box:
        raise HTTPException(401, "enroll again")
    task = await HUB.next_task(host_id, min(float(data.get("wait") or POLL_WAIT), POLL_WAIT))
    if task is None:
        return {"task": None}
    plain = json.dumps({**task.op, "id": task.id, "at": time.time()}, ensure_ascii=False, separators=(",", ":")).encode()
    sealed = json.dumps(agentproto.seal(box, plain), separators=(",", ":"))
    return {"task": sealed, "sig": agentproto.sign(keys.sign, sealed.encode())}


@router.post("/tasks/{task_id}/lines")
async def lines(task_id: str, request: Request):
    host_id, body = await signed_host(request)
    if HUB.owner(task_id) not in (None, host_id):
        raise HTTPException(403, "not your task")
    items = _json(body).get("lines") or []
    for text in items[:MAX_LINES]:
        HUB.line(task_id, str(text)[:8192])
    return {"ok": True}


@router.post("/tasks/{task_id}/finish")
async def finish(task_id: str, request: Request):
    host_id, body = await signed_host(request)
    if HUB.owner(task_id) not in (None, host_id):
        raise HTTPException(403, "not your task")
    result = _json(body).get("result")
    if not isinstance(result, dict):
        result = {"ok": False, "error": "bad result"}
    if isinstance(result.get("sealed"), dict):  # fetched files: sealed to Wharfline's key
        with SessionLocal() as db:
            keys = agentproto.server_keys(db)
        try:
            result["artifacts"] = json.loads(agentproto.unseal(keys.box, result.pop("sealed")))
        except (ValueError, KeyError):
            result["artifacts"] = []
            result["artifactError"] = "가져온 파일을 풀지 못했어요"
    HUB.finish(task_id, result)
    return {"ok": True}


# ---------- installer ----------

@router.get("/install.sh", response_class=PlainTextResponse)
def install_sh(db: Session = Depends(get_db)):
    return agentinstall.install_script(agent_url(db), agentinstall.agent_image())
