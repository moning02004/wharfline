"""배포 알림: message building (unit) and the settings API / sending on run events (flow)."""

import time

import pytest

from app import notify
from tests.conftest import DEPLOYER, OWNER, builtin_job, wait_run

ADMIN = "admin-notify@acme.kr"

BASE = "https://deploy.acme.kr"
SLACK = "https://hooks.slack.com/services/T000/B000/secretXYZ9"
NTFY_TOKEN = "tk_supersecret1234"


def _ev(event: str, **over) -> dict:
    return {"event": event, "no": 42, "job": "api · prod", "tag": "v1.4.0", "extra": {"WEB_TAG": "v2.0.1"},
            "duration": "1m 05s", "trigger": "새 이미지 push", "by": None, "target": "전체"} | over


def _cfg(**over) -> dict:
    cfg = {**notify.DEFAULTS, "baseUrl": BASE}
    cfg["ntfy"] = {"on": True, "server": "https://ntfy.sh", "topic": "acme-deploys"}
    cfg["slack"] = {"on": True}
    cfg["discord"] = {"on": False}
    return cfg | over


# ---------- unit: the message each channel gets ----------

def test_message_for_a_success():
    msg = notify.message(_ev("ok"), BASE)
    assert msg["title"] == "✅ 배포 성공 · api · prod"
    assert msg["lines"] == ["버전: v1.4.0 · WEB_TAG=v2.0.1", "#42 · 1m 05s · 새 이미지 push"]
    assert msg["url"] == f"{BASE}/runs?run=42"


def test_ntfy_payload_marks_failures_high():
    url, body, headers = notify.ntfy_request(_cfg()["ntfy"], NTFY_TOKEN, notify.message(_ev("bad", by="민지"), BASE), "bad")
    assert url == "https://ntfy.sh/"
    assert body["topic"] == "acme-deploys" and body["title"].startswith("❌ 배포 실패")
    assert body["priority"] == 4 and body["tags"] == ["x"] and body["click"] == f"{BASE}/runs?run=42"
    assert "민지" in body["message"]
    assert headers == {"Authorization": f"Bearer {NTFY_TOKEN}"}
    _, ok, no_auth = notify.ntfy_request(_cfg()["ntfy"], None, notify.message(_ev("ok"), BASE), "ok")
    assert ok["priority"] == 3 and ok["tags"] == ["white_check_mark"] and no_auth == {}


def test_approval_message():
    msg = notify.message(_ev("approval", trigger="수동 실행", by="민지"), BASE)
    assert msg["title"].startswith("⏳ 승인 대기")
    assert "1m 05s" not in " ".join(msg["lines"])  # it hasn't run yet
    assert "승인이 필요해요" in msg["lines"][-1]
    _, body, _ = notify.ntfy_request(_cfg()["ntfy"], None, msg, "approval")
    assert body["tags"] == ["hourglass"] and body["priority"] == 4


def test_slack_payload_links_the_run_and_escapes():
    body = notify.slack_body(notify.message(_ev("ok", job="a<b>&c"), BASE))
    text = body["blocks"][0]["text"]["text"]
    assert text.startswith("*✅ 배포 성공 · a&lt;b&gt;&amp;c*")
    assert f"<{BASE}/runs?run=42|실행 #42 보기>" in text
    assert body["text"]  # notification fallback


def test_no_link_without_an_address():
    msg = notify.message(_ev("ok"), "")
    assert msg["url"] == ""
    assert "<" not in notify.slack_body(msg)["blocks"][0]["text"]["text"]
    assert "click" not in notify.ntfy_request(_cfg()["ntfy"], None, msg, "ok")[1]


def test_discord_payload():
    body = notify.discord_body(notify.message(_ev("bad"), BASE), "bad")
    assert body["embeds"][0]["url"] == f"{BASE}/runs?run=42" and body["allowed_mentions"] == {"parse": []}


def test_requests_only_for_channels_that_are_on_and_complete():
    reqs = notify.requests_for(_cfg(), {"slackUrl": SLACK}, _ev("ok"))
    assert [r[0] for r in reqs] == ["ntfy", "slack"]
    assert [r[0] for r in notify.requests_for(_cfg(), {}, _ev("ok"))] == ["ntfy"]  # Slack on but no URL


def test_toggles():
    cfg = _cfg()
    assert notify.wanted(cfg, _ev("ok")) and not notify.wanted(cfg, _ev("cancel"))
    auto_only = cfg | {"autoOnly": True}
    assert notify.wanted(auto_only, _ev("ok")) and not notify.wanted(auto_only, _ev("ok", trigger="수동 실행"))


# ---------- flow ----------

@pytest.fixture
def sent(client, notify_sent):
    """Start and end each test with no notification settings, and an empty outbox."""
    from app import models as m
    from app.db import SessionLocal

    def wipe():
        notify._pool.submit(lambda: None).result()  # let queued sends finish first
        with SessionLocal() as db:
            for key in (notify.SETTING, notify.SECRET_SETTING, notify.STATUS_SETTING):
                row = db.get(m.Setting, key)
                if row:
                    db.delete(row)
            db.commit()
        notify_sent.clear()

    wipe()
    yield notify_sent
    wipe()


def _body(**over) -> dict:
    return {"baseUrl": BASE, "events": {"ok": True, "bad": True, "cancel": False, "approval": True}, "autoOnly": False,
            "ntfy": {"on": True, "server": "https://ntfy.sh", "topic": "acme-deploys"}, "slack": {"on": False},
            "discord": {"on": False}, "secrets": {}} | over


def _flush() -> None:
    notify._pool.submit(lambda: None).result(timeout=10)


def _wait_sent(sent: list, n: int = 1, timeout: float = 5) -> list:
    end = time.time() + timeout
    while time.time() < end and len(sent) < n:
        time.sleep(0.02)
    _flush()
    return sent


def _job(client, name: str, **extra) -> dict:
    found = next((j for j in client.get("/api/jobs").json() if j["name"] == name), None)
    if found:
        return found
    r = client.post("/api/jobs", json=builtin_job(name, "staging", "nginx:1.27", **extra))
    assert r.status_code == 200, r.text
    return r.json()


def _run(client, job: dict) -> int:
    r = client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "1.27", "groups": []})
    assert r.status_code == 200, r.text
    return r.json()["no"]


def test_only_the_owner_sees_and_changes_settings(client, login, sent):
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        if not db.get(m.Member, ADMIN):
            db.add(m.Member(email=ADMIN, name="관리자", role="Admin", tfa=False, last="방금"))
            db.commit()
    for who in (DEPLOYER, ADMIN):
        login(who, sudo=True)
        assert client.get("/api/notify").status_code == 403
        assert client.put("/api/notify", json=_body()).status_code == 403
        assert client.post("/api/notify/test", json={"channel": "ntfy"}).status_code == 403
    login(OWNER)
    assert client.get("/api/notify").json()["ntfy"]["server"] == "https://ntfy.sh"


def test_secrets_need_sudo_and_are_never_returned(client, login, sent):
    body = _body(slack={"on": True}, secrets={"slackUrl": SLACK, "ntfyToken": NTFY_TOKEN})
    r = client.put("/api/notify", json=body)
    assert r.status_code == 403 and r.json()["detail"] == "sudo_required"

    # No secret change: no password check needed.
    assert client.put("/api/notify", json=_body()).status_code == 200

    login(OWNER, sudo=True)
    r = client.put("/api/notify", json=body)
    assert r.status_code == 200, r.text
    for text in (r.text, client.get("/api/notify").text):
        assert SLACK not in text and NTFY_TOKEN not in text and "secretXYZ" not in text
    got = client.get("/api/notify").json()
    assert got["secrets"]["slackUrl"] == {"set": True, "last4": "XYZ9"} and got["secrets"]["ntfyToken"]["set"]
    assert got["secrets"]["discordUrl"] == {"set": False, "last4": ""}

    # Stored encrypted, not as plain text.
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        raw = str(db.get(m.Setting, notify.SECRET_SETTING).value) + str(db.get(m.Setting, notify.SETTING).value)
    assert SLACK not in raw and NTFY_TOKEN not in raw

    # Leaving the secrets out keeps them; "" clears one.
    login(OWNER)
    assert client.put("/api/notify", json=_body(slack={"on": True})).json()["secrets"]["slackUrl"]["set"]
    login(OWNER, sudo=True)
    got = client.put("/api/notify", json=_body(secrets={"ntfyToken": ""})).json()
    assert not got["secrets"]["ntfyToken"]["set"] and got["secrets"]["slackUrl"]["set"]


def test_settings_are_checked(client, login, sent):
    login(OWNER, sudo=True)
    assert "Slack" in client.put("/api/notify", json=_body(slack={"on": True})).json()["detail"]
    assert client.put("/api/notify", json=_body(ntfy={"on": True, "server": "https://ntfy.sh", "topic": "has space"})).status_code == 400
    assert client.put("/api/notify", json=_body(ntfy={"on": True, "server": "https://ntfy.sh", "topic": ""})).status_code == 400
    assert client.put("/api/notify", json=_body(baseUrl="deploy.acme.kr")).status_code == 400
    assert client.put("/api/notify", json=_body(slack={"on": True}, secrets={"slackUrl": "http://x"})).status_code == 400


def test_finished_run_sends_to_each_channel(client, login, sent):
    login(OWNER, sudo=True)
    assert client.put("/api/notify", json=_body(slack={"on": True}, secrets={"slackUrl": SLACK, "ntfyToken": NTFY_TOKEN})).status_code == 200
    job = _job(client, "notify · app")
    no = _run(client, job)
    assert wait_run(client, no)["status"] == "ok"
    _wait_sent(sent, 2)
    assert len(sent) == 2
    (nurl, nbody, nheaders), (surl, sbody, _) = sent
    assert nurl == "https://ntfy.sh/" and nheaders["Authorization"] == f"Bearer {NTFY_TOKEN}"
    assert nbody["title"] == "✅ 배포 성공 · notify · app" and nbody["click"] == f"{BASE}/runs?run={no}"
    assert "1.27" in nbody["message"] and "수동 실행" in nbody["message"]
    assert surl == SLACK and f"/runs?run={no}|" in sbody["blocks"][0]["text"]["text"]
    st = client.get("/api/notify").json()["status"]
    assert st["ntfy"]["ok"] and st["slack"]["ok"]


def test_failed_run_and_event_toggles(client, login, sent):
    from tests.test_flow_ssh_script import script_job

    # Success turned off: a good run sends nothing.
    assert client.put("/api/notify", json=_body(events={"ok": False, "bad": True, "cancel": False, "approval": True})).status_code == 200
    assert wait_run(client, _run(client, _job(client, "notify · app")))["status"] == "ok"
    _flush()
    assert sent == []

    steps = [{"name": "확인", "run": "exit 1"}]
    job = next((j for j in client.get("/api/jobs").json() if j["name"] == "notify · fail"), None) \
        or client.post("/api/jobs", json=script_job("notify · fail", steps)).json()
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "v1.8.1", "groups": []}).json()["no"])
    assert run["status"] == "bad"
    _wait_sent(sent)
    assert len(sent) == 1 and sent[0][1]["title"].startswith("❌ 배포 실패") and sent[0][1]["priority"] == 4


def test_auto_only_skips_manual_runs(client, login, sent):
    assert client.put("/api/notify", json=_body(autoOnly=True)).status_code == 200
    assert wait_run(client, _run(client, _job(client, "notify · app")))["status"] == "ok"
    _flush()
    assert sent == []


def test_approval_request_is_sent(client, login, sent):
    assert client.put("/api/notify", json=_body()).status_code == 200
    job = _job(client, "notify · prod", protected=True)
    login(DEPLOYER)
    r = client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "1.27", "groups": []})
    assert r.json()["status"] == "approval"
    _wait_sent(sent)
    assert len(sent) == 1
    body = sent[0][1]
    assert body["title"] == "⏳ 승인 대기 · notify · prod" and body["tags"] == ["hourglass"]
    assert "승인이 필요해요" in body["message"]


def test_nothing_sent_when_no_channel_is_on(client, login, sent):
    assert client.put("/api/notify", json=_body(ntfy={"on": False, "server": "https://ntfy.sh", "topic": "acme-deploys"})).status_code == 200
    assert wait_run(client, _run(client, _job(client, "notify · app")))["status"] == "ok"
    _flush()
    assert sent == []


def test_send_test_message(client, login, sent, monkeypatch):
    # Unsaved form values are used as they are.
    draft = _body(ntfy={"on": False, "server": "https://ntfy.example.kr", "topic": "draft-topic"})
    r = client.post("/api/notify/test", json={"channel": "ntfy", "draft": draft})
    assert r.status_code == 200, r.text
    assert sent[-1][0] == "https://ntfy.example.kr/" and sent[-1][1]["topic"] == "draft-topic"
    assert sent[-1][1]["click"] == f"{BASE}/runs"
    assert r.json()["status"]["ntfy"]["ok"]

    assert "먼저 넣어 주세요" in client.post("/api/notify/test", json={"channel": "slack"}).json()["detail"]

    def boom(url, body, headers):
        raise RuntimeError("HTTP 404 · topic not found")

    monkeypatch.setattr(notify, "post", boom)
    r = client.post("/api/notify/test", json={"channel": "ntfy", "draft": draft})
    assert r.status_code == 400 and "HTTP 404" in r.json()["detail"]
    st = client.get("/api/notify").json()["status"]["ntfy"]
    assert st["ok"] is False and "HTTP 404" in st["error"]


def test_saved_ntfy_token_is_not_sent_to_a_new_server(client, login, sent):
    login(OWNER, sudo=True)
    assert client.put("/api/notify", json=_body(secrets={"ntfyToken": NTFY_TOKEN})).status_code == 200
    client.post("/api/notify/test", json={"channel": "ntfy", "draft": _body()})
    assert sent[-1][2] == {"Authorization": f"Bearer {NTFY_TOKEN}"}
    client.post("/api/notify/test", json={"channel": "ntfy", "draft": _body(ntfy={"on": True, "server": "https://evil.example", "topic": "t"})})
    assert sent[-1][0] == "https://evil.example/" and sent[-1][2] == {}


def test_a_broken_sender_does_not_break_runs(client, login, sent, monkeypatch):
    assert client.put("/api/notify", json=_body()).status_code == 200

    def boom(url, body, headers):
        raise OSError("network down")

    monkeypatch.setattr(notify, "post", boom)
    assert wait_run(client, _run(client, _job(client, "notify · app")))["status"] == "ok"
    _flush()
    assert client.get("/api/notify").json()["status"]["ntfy"]["error"] == "network down"
