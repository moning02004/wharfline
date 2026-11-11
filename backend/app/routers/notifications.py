"""배포 알림 settings: Owner only (the "admin" action). Secret values are never returned."""

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import notify
from .. import store as s
from ..db import get_db
from ..deps import require, require_login

router = APIRouter(prefix="/api", tags=["notify"], dependencies=[Depends(require_login), Depends(require("admin"))])

URL_RE = re.compile(r"^https?://[^\s/]+(/\S*)?$")
NAMES = {"ntfy": "ntfy", "slack": "Slack", "discord": "Discord"}


class Events(BaseModel):
    ok: bool = True
    bad: bool = True
    cancel: bool = False
    approval: bool = True


class Ntfy(BaseModel):
    on: bool = False
    server: str = "https://ntfy.sh"
    topic: str = ""


class Toggle(BaseModel):
    on: bool = False


class Secrets(BaseModel):
    """None keeps the saved value, "" clears it, anything else replaces it."""
    ntfyToken: str | None = None
    slackUrl: str | None = None
    discordUrl: str | None = None


class NotifyIn(BaseModel):
    baseUrl: str = ""
    events: Events = Field(default_factory=Events)
    autoOnly: bool = False
    ntfy: Ntfy = Field(default_factory=Ntfy)
    slack: Toggle = Field(default_factory=Toggle)
    discord: Toggle = Field(default_factory=Toggle)
    secrets: Secrets = Field(default_factory=Secrets)


def _view(db: Session) -> dict:
    return {**notify.config(db), "secrets": notify.secret_flags(notify.load_secrets(db)), "status": notify.status(db)}


def _clean(body: NotifyIn) -> NotifyIn:
    body.baseUrl = body.baseUrl.strip().rstrip("/")
    body.ntfy.server = (body.ntfy.server.strip() or "https://ntfy.sh").rstrip("/")
    body.ntfy.topic = body.ntfy.topic.strip()
    for k in notify.SECRET_KEYS:
        v = getattr(body.secrets, k)
        if v is not None:
            setattr(body.secrets, k, v.strip())
    return body


def _check(body: NotifyIn, secrets: dict[str, str]) -> None:
    if body.baseUrl and not URL_RE.match(body.baseUrl):
        raise HTTPException(400, "Wharfline 주소는 http:// 나 https:// 로 시작해야 해요.")
    if not URL_RE.match(body.ntfy.server):
        raise HTTPException(400, "ntfy 서버 주소는 http:// 나 https:// 로 시작해야 해요.")
    if body.ntfy.topic and not notify.TOPIC_RE.match(body.ntfy.topic):
        raise HTTPException(400, "ntfy 토픽은 영문, 숫자, -, _ 로 64자까지 쓸 수 있어요.")
    for k, name in (("slackUrl", "Slack"), ("discordUrl", "Discord")):
        v = secrets.get(k)
        if v and not (v.startswith("https://") and URL_RE.match(v)):
            raise HTTPException(400, f"{name} 웹훅 주소는 https:// 로 시작해야 해요.")
    if body.ntfy.on and not body.ntfy.topic:
        raise HTTPException(400, "ntfy 토픽을 넣어 주세요.")
    if body.slack.on and not secrets.get("slackUrl"):
        raise HTTPException(400, "Slack 웹훅 주소를 넣어 주세요.")
    if body.discord.on and not secrets.get("discordUrl"):
        raise HTTPException(400, "Discord 웹훅 주소를 넣어 주세요.")


def _merged_secrets(db: Session, body: NotifyIn) -> tuple[dict[str, str], bool]:
    """The secrets after this change, and whether any of them changed."""
    saved = notify.load_secrets(db)
    out, changed = dict(saved), False
    for k in notify.SECRET_KEYS:
        v = getattr(body.secrets, k)
        if v is None or v == saved.get(k, ""):
            continue
        changed = True
        if v:
            out[k] = v
        else:
            out.pop(k, None)
    return out, changed


@router.get("/notify")
def get_notify(db: Session = Depends(get_db)):
    return _view(db)


@router.put("/notify")
def save_notify(body: NotifyIn, db: Session = Depends(get_db)):
    body = _clean(body)
    secrets, changed = _merged_secrets(db, body)
    _check(body, secrets)
    if changed and not s.sudo_active(db):  # saving a webhook URL or token needs a recent password check
        raise HTTPException(403, "sudo_required")
    cfg = body.model_dump(exclude={"secrets"})
    s.set_setting(db, notify.SETTING, **cfg)
    if changed:
        notify.save_secrets(db, secrets)
    on = [NAMES[ch] for ch in notify.CHANNELS if cfg[ch]["on"]] or ["채널 없음"]
    s.log_act(db, "배포 알림 설정", ", ".join(on) + (" · 비밀값 변경" if changed else ""), "warn" if changed else "ok")
    db.commit()
    return _view(db)


class TestIn(BaseModel):
    channel: Literal["ntfy", "slack", "discord"]
    event: Literal["ok", "bad", "cancel", "approval"] = "ok"
    # The form as it is now (unsaved edits included). Missing parts fall back to what is saved.
    draft: NotifyIn | None = None


@router.post("/notify/test")
def test_notify(body: TestIn, db: Session = Depends(get_db)):
    """Send a sample message to one channel now and report the result."""
    cfg, saved = notify.config(db), notify.load_secrets(db)
    secrets = dict(saved)
    if body.draft:
        d = _clean(body.draft)
        cfg = {**cfg, "baseUrl": d.baseUrl, "ntfy": {**cfg["ntfy"], "server": d.ntfy.server, "topic": d.ntfy.topic}}
        for k in notify.SECRET_KEYS:
            v = getattr(d.secrets, k)
            if v:
                secrets[k] = v
        # A saved ntfy token only goes to the saved server, never to one typed in just now.
        if not d.secrets.ntfyToken and d.ntfy.server != notify.config(db)["ntfy"]["server"]:
            secrets.pop("ntfyToken", None)
        _check(d.model_copy(update={"ntfy": Ntfy(on=False, server=d.ntfy.server, topic=d.ntfy.topic),
                                    "slack": Toggle(), "discord": Toggle()}), secrets)
    reqs = notify.requests_for(cfg, secrets, notify.sample_event(body.event), only=body.channel)
    if not reqs:
        need = {"ntfy": "ntfy 토픽을", "slack": "Slack 웹훅 주소를", "discord": "Discord 웹훅 주소를"}[body.channel]
        raise HTTPException(400, f"{need} 먼저 넣어 주세요.")
    _, url, payload, headers = reqs[0]
    err = notify.send_one(body.channel, url, payload, headers)
    notify.record(body.channel, err)
    if err:
        raise HTTPException(400, f"보내지 못했어요: {err}")
    return {"ok": True, "status": notify.status(db)}
