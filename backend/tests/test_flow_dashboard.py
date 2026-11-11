"""The dashboard's 알림 card: real alerts only, limited to what the viewer can see and act on."""

import time

import pytest

from tests.conftest import DEPLOYER, OWNER, VIEWER, builtin_job

FAKE = ("로그인 실패", "45.148.10.77", "오래된 RSA 키", "legacy-rsa")
INV = "dash-inv"


def _alerts(client, **headers) -> list[dict]:
    r = client.get("/api/dashboard", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "hostKeyAlert" not in body and "security" not in body
    return body["alerts"]


def _all_alerts(client) -> dict:
    return client.get("/api/dashboard").json()


@pytest.fixture
def dash_job(client, login):
    found = next((j for j in client.get("/api/jobs").json() if j["name"] == "dash · job"), None)
    if found:
        return found
    r = client.post("/api/jobs", json=builtin_job("dash · job", "staging", "nginx:1.27", protected=False))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def hosts(client):
    """An inventory with a changed host key and two offline servers."""
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        if not db.get(m.Inventory, "i-dash"):
            db.add(m.Inventory(id="i-dash", name=INV, key="staging-deploy", hosts=[
                m.Host(name="dash-key", ip="10.9.0.1", port=22, ssh_user="deploy", grp="web", host_key="changed", status="on"),
                m.Host(name="dash-off-1", ip="10.9.0.2", port=22, ssh_user="deploy", grp="web", host_key="ok", status="off"),
                m.Host(name="dash-off-2", ip="10.9.0.3", port=22, ssh_user="deploy", grp="web", host_key="ok", status="off"),
            ]))
            db.commit()
    yield
    with SessionLocal() as db:
        inv = db.get(m.Inventory, "i-dash")
        if inv:
            db.delete(inv)
            db.commit()


def _add_run(job: dict, status: str, started_at: float | None = None, **extra) -> int:
    from sqlalchemy import select

    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        no = db.scalar(select(m.run_no_seq.next_value()))
        db.add(m.Run(no=no, job=job["name"], job_id=job["id"], target="전체", tag="1.27", status=status, by="정훈", trigger="수동 실행",
                     time="방금", duration="-", started_at=started_at if started_at is not None else time.time(), **extra))
        db.commit()
    return no


def test_no_fake_items(client, login):
    text = str(_all_alerts(client))
    for fake in FAKE:
        assert fake not in text


def test_failed_run_shows_until_a_later_success(client, login, dash_job):
    no = _add_run(dash_job, "bad")
    failed = [a for a in _alerts(client) if a["kind"] == "failed" and a.get("run") == no]
    assert failed and failed[0]["tone"] == "bad" and "dash · job" in failed[0]["title"] and "1.27" in failed[0]["sub"]

    login(VIEWER)  # runs are visible to everyone with the runs menu
    assert any(a.get("run") == no for a in _alerts(client))

    login(OWNER)
    _add_run(dash_job, "ok")
    assert not any(a["kind"] == "failed" and a["title"].startswith("dash · job") for a in _alerts(client))


def test_old_failure_is_not_shown(client, login, dash_job):
    no = _add_run(dash_job, "bad", started_at=time.time() - 30 * 86400)
    assert not any(a.get("run") == no for a in _alerts(client))


def test_approval_shows_for_approvers_only(client, login, dash_job):
    from app import models as m
    from app.db import SessionLocal

    no = _add_run(dash_job, "approval", requested_by=DEPLOYER)
    try:
        mine = [a for a in _alerts(client) if a["kind"] == "approval" and a.get("run") == no]
        assert mine and "민지님 요청" in mine[0]["sub"]
        for who in (VIEWER, DEPLOYER):
            login(who)
            assert not any(a.get("run") == no for a in _alerts(client))
    finally:
        with SessionLocal() as db:
            db.get(m.Run, no).status = "rejected"
            db.commit()


def test_host_alerts(client, login, hosts):
    alerts = _alerts(client)
    keyed = [a for a in alerts if a["kind"] == "hostKey" and a["title"].startswith("dash-key ")]
    assert keyed and keyed[0]["tone"] == "bad" and keyed[0]["to"] == "/inventory"
    off = [a for a in alerts if a["kind"] == "offline" and INV in a["title"]]
    assert len(off) == 1 and "2대" in off[0]["title"] and "dash-off-1" in off[0]["sub"] and off[0]["to"] == "/inventory"
    # most serious first: every blocked server comes before any offline one
    kinds = [a["kind"] for a in alerts]
    if "offline" in kinds:
        assert all(k != "hostKey" for k in kinds[kinds.index("offline"):])

    login(VIEWER)  # no inventory menu: no server alerts
    assert not any(a["kind"] in ("hostKey", "offline") for a in _alerts(client))
    login(OWNER)
    assert not any(a["kind"] in ("hostKey", "offline") for a in _alerts(client, **{"X-View-As": VIEWER}))


def test_list_is_capped(client, login, hosts):
    body = _all_alerts(client)
    assert len(body["alerts"]) <= 8 and body["alertsMore"] >= 0


def test_empty_when_nothing_to_check(client, login):
    """A member who sees no menus and can't approve has nothing to check."""
    from app import models as m
    from app.db import SessionLocal

    email = "dash-empty@acme.kr"
    with SessionLocal() as db:
        if not db.get(m.Member, email):
            db.add(m.Member(email=email, name="빈칸", role="Viewer", tfa=False, last="방금"))
            db.commit()
    login(email)
    body = _all_alerts(client)
    assert body["alerts"] == [] and body["alertsMore"] == 0
