"""Deploy notifications: tell ntfy / Slack / Discord when a run finishes or waits for an approval.

Settings live in the settings table:
  notify          plain config (Wharfline address, events, channels on/off, ntfy server and topic)
  notify_secrets  one envelope-encrypted JSON object {ntfyToken, slackUrl, discordUrl}
  notify_status   the last send result per channel, written by the sender thread

Sending never blocks or breaks a run: the message is built in the caller (cheap), then posted from a
small thread pool with a short timeout. Failures are logged and kept in notify_status for the UI.
"""

import base64
import json
import logging
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from sqlalchemy.orm import Session

from . import crypto
from . import models as m
from . import store as s

log = logging.getLogger("wharfline.notify")

SETTING = "notify"
SECRET_SETTING = "notify_secrets"
STATUS_SETTING = "notify_status"
CONTEXT = "setting:notify_secrets"
CHANNELS = ("ntfy", "slack", "discord")
SECRET_KEYS = ("ntfyToken", "slackUrl", "discordUrl")
EVENTS = ("ok", "bad", "cancel", "approval")
AUTO_TRIGGER = "새 이미지 push"
TIMEOUT = 5.0
TOPIC_RE = re.compile(r"^[-_A-Za-z0-9]{1,64}$")

DEFAULTS: dict[str, Any] = {
    "baseUrl": "",
    "events": {"ok": True, "bad": True, "cancel": False, "approval": True},
    "autoOnly": False,
    "ntfy": {"on": False, "server": "https://ntfy.sh", "topic": ""},
    "slack": {"on": False},
    "discord": {"on": False},
}

LABEL = {"ok": "배포 성공", "bad": "배포 실패", "cancel": "배포 취소", "approval": "승인 대기"}
EMOJI = {"ok": "✅", "bad": "❌", "cancel": "⏹️", "approval": "⏳"}
NTFY_TAG = {"ok": "white_check_mark", "bad": "x", "cancel": "stop_button", "approval": "hourglass"}
NTFY_PRIORITY = {"ok": 3, "bad": 4, "cancel": 3, "approval": 4}  # 4 = high
DISCORD_COLOR = {"ok": 0x2DA44E, "bad": 0xCF222E, "cancel": 0x8C959F, "approval": 0xBF8700}


# ---------- settings ----------

def config(db: Session) -> dict[str, Any]:
    v = s.get_setting(db, SETTING)
    out = {**DEFAULTS, **{k: v[k] for k in DEFAULTS if k in v}}
    out["events"] = {**DEFAULTS["events"], **(v.get("events") or {})}
    for ch in CHANNELS:
        out[ch] = {**DEFAULTS[ch], **(v.get(ch) or {})}
    return out


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def secret_envelope(db: Session) -> crypto.Envelope | None:
    v = s.get_setting(db, SECRET_SETTING)
    if not v.get("ciphertext"):
        return None
    return crypto.Envelope(v["kek_id"], base64.b64decode(v["wrapped_dek"]), base64.b64decode(v["nonce"]), base64.b64decode(v["ciphertext"]))


def set_secret_envelope(db: Session, env: crypto.Envelope) -> None:
    s.set_setting(db, SECRET_SETTING, kek_id=env.kek_id, wrapped_dek=_b64(env.wrapped_dek), nonce=_b64(env.nonce),
                  ciphertext=_b64(env.ciphertext))


def load_secrets(db: Session) -> dict[str, str]:
    env = secret_envelope(db)
    return crypto.open_json(env, CONTEXT) if env else {}


def save_secrets(db: Session, values: dict[str, str]) -> None:
    values = {k: v for k, v in values.items() if k in SECRET_KEYS and v}
    set_secret_envelope(db, crypto.seal_json(values, CONTEXT))


def secret_flags(secrets: dict[str, str]) -> dict[str, dict[str, Any]]:
    """What the API shows about each secret: whether it is set and its last 4 characters."""
    return {k: {"set": bool(secrets.get(k)), "last4": (secrets.get(k) or "")[-4:]} for k in SECRET_KEYS}


def status(db: Session) -> dict[str, Any]:
    return s.get_setting(db, STATUS_SETTING)


# ---------- the message ----------

def run_event(rec: m.Run, event: str) -> dict[str, Any]:
    """What a message needs to know about a run."""
    return {"event": event, "no": rec.no, "job": rec.job, "tag": rec.tag, "extra": dict(rec.extra_tags or {}),
            "duration": rec.duration, "trigger": rec.trigger, "by": None if rec.by == "시스템" else rec.by,
            "target": rec.target}


def run_url(base: str, no: int) -> str:
    if not base:
        return ""
    return f"{base.rstrip('/')}/runs" + (f"?run={no}" if no else "")


def message(ev: dict[str, Any], base: str) -> dict[str, Any]:
    """Title, body lines and link shared by every channel."""
    e = ev["event"]
    title = f"{EMOJI[e]} {LABEL[e]} · {ev['job']}"
    lines: list[str] = []
    versions = [] if ev.get("tag") in (None, "", "-") else [ev["tag"]]
    versions += [f"{k}={v}" for k, v in (ev.get("extra") or {}).items()]
    if versions:
        lines.append("버전: " + " · ".join(versions))
    meta = [f"#{ev['no']}"] if ev["no"] else []
    if e != "approval" and ev.get("duration") not in (None, "", "-"):
        meta.append(ev["duration"])
    meta.append(ev.get("trigger") or "수동 실행")
    if ev.get("by"):
        meta.append(ev["by"])
    lines.append(" · ".join(meta))
    if e == "approval":
        lines.append("Owner나 Admin의 승인이 필요해요.")
    return {"title": title, "lines": lines, "url": run_url(base, ev["no"]), "linkText": f"실행 #{ev['no']} 보기" if ev["no"] else "실행 기록 보기"}


def _slack_escape(t: str) -> str:
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def ntfy_request(cfg: dict, token: str | None, msg: dict, event: str) -> tuple[str, dict, dict]:
    """ntfy's JSON publish: POST to the server root with the topic in the body."""
    body: dict[str, Any] = {"topic": cfg["topic"], "title": msg["title"], "message": "\n".join(msg["lines"]),
                            "priority": NTFY_PRIORITY[event], "tags": [NTFY_TAG[event]]}
    if msg["url"]:
        body["click"] = msg["url"]
        body["actions"] = [{"action": "view", "label": msg["linkText"], "url": msg["url"]}]
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return cfg["server"].rstrip("/") + "/", body, headers


def slack_body(msg: dict) -> dict:
    text = f"*{_slack_escape(msg['title'])}*\n" + "\n".join(_slack_escape(x) for x in msg["lines"])
    if msg["url"]:
        text += f"\n<{msg['url']}|{msg['linkText']}>"
    return {"text": f"{msg['title']} — " + " / ".join(msg["lines"]),
            "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": text}}]}


def discord_body(msg: dict, event: str) -> dict:
    embed: dict[str, Any] = {"title": msg["title"], "description": "\n".join(msg["lines"]), "color": DISCORD_COLOR[event]}
    if msg["url"]:
        embed["url"] = msg["url"]
    return {"embeds": [embed], "allowed_mentions": {"parse": []}}


def requests_for(cfg: dict, secrets: dict, ev: dict, only: str | None = None) -> list[tuple[str, str, dict, dict]]:
    """(channel, url, json body, headers) for each channel that is on (or just `only`, on or not)."""
    msg = message(ev, cfg["baseUrl"])
    e = ev["event"]
    out = []
    for ch in CHANNELS:
        if (only and ch != only) or (not only and not cfg[ch]["on"]):
            continue
        if ch == "ntfy" and cfg["ntfy"]["topic"]:
            out.append(("ntfy", *ntfy_request(cfg["ntfy"], secrets.get("ntfyToken"), msg, e)))
        elif ch == "slack" and secrets.get("slackUrl"):
            out.append(("slack", secrets["slackUrl"], slack_body(msg), {}))
        elif ch == "discord" and secrets.get("discordUrl"):
            out.append(("discord", secrets["discordUrl"], discord_body(msg, e), {}))
    return out


def wanted(cfg: dict, ev: dict) -> bool:
    if not cfg["events"].get(ev["event"]):
        return False
    return not cfg["autoOnly"] or ev.get("trigger") == AUTO_TRIGGER


# ---------- sending ----------

def _http_post(url: str, body: dict, headers: dict) -> None:
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "Wharfline", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            res.read(256)
    except urllib.error.HTTPError as e:
        detail = e.read(200).decode(errors="replace").strip()
        raise RuntimeError(f"HTTP {e.code}" + (f" · {detail}" if detail else "")) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"연결 실패 · {e.reason}") from e
    except TimeoutError as e:
        raise RuntimeError("응답 없음 (5초)") from e


# Tests replace this so nothing leaves the machine.
post: Callable[[str, dict, dict], None] = _http_post

_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="notify")  # one at a time: keeps order and notify_status writes simple


def send_one(channel: str, url: str, body: dict, headers: dict) -> str | None:
    """Post one message. Returns the error text, or None when it went out."""
    try:
        post(url, body, headers)
        return None
    except Exception as e:  # noqa: BLE001 - any failure is reported, never raised
        return str(e)[:200] or type(e).__name__


def record(channel: str, error: str | None) -> None:
    """Keep the last result per channel, for "마지막 전송 실패: …" in the settings page."""
    from .db import SessionLocal

    try:
        with SessionLocal() as db:
            prev = status(db).get(channel) or {}
            entry = {**prev, "at": time.time(), "ok": error is None}
            if error:
                entry |= {"error": error, "errorAt": time.time()}
            s.set_setting(db, STATUS_SETTING, **{channel: entry})
            db.commit()
    except Exception:  # noqa: BLE001
        log.exception("could not record notification status")


def _deliver(reqs: list[tuple[str, str, dict, dict]]) -> None:
    for channel, url, body, headers in reqs:
        err = send_one(channel, url, body, headers)
        if err:
            log.warning("notification to %s failed: %s", channel, err)
        record(channel, err)


def notify(db: Session, ev: dict[str, Any]) -> None:
    """Queue messages for a run event. Never raises; never waits for the network."""
    try:
        cfg = config(db)
        if not wanted(cfg, ev) or not any(cfg[ch]["on"] for ch in CHANNELS):
            return
        reqs = requests_for(cfg, load_secrets(db), ev)
        if reqs:
            _pool.submit(_deliver, reqs)
    except Exception:  # noqa: BLE001 - a notification problem must never break a run
        log.exception("could not queue notification for run #%s", ev.get("no"))


def notify_run(db: Session, no: int, event: str) -> None:
    try:
        rec = db.get(m.Run, no)
        if rec:
            notify(db, run_event(rec, event))
    except Exception:  # noqa: BLE001
        log.exception("could not queue notification for run #%s", no)


def sample_event(event: str = "ok") -> dict[str, Any]:
    return {"event": event, "no": 0, "job": "알림 시험", "tag": "v1.2.3", "extra": {}, "duration": "0m 42s",
            "trigger": "시험 보내기", "by": None, "target": "전체"}
