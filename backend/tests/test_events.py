"""Change notices for open pages (/api/events): a commit that touches jobs, runs, builds or images is announced.
(A webhook build being announced is checked in test_flow_webhooks.py.)"""

from tests.conftest import builtin_job, set_session_cookie, wait_run


def test_run_start_and_end_are_announced(client, login):
    from app import events

    inv = client.get("/api/inventory").json()[0]["name"]
    job = client.post("/api/jobs", json=builtin_job("events · demo", inv, "redis:7"))
    assert job.status_code == 200, job.text
    seq = events.current()
    r = client.post(f"/api/jobs/{job.json()['id']}/runs", json={"tag": "7", "groups": []})
    assert r.status_code == 200, r.text
    wait_run(client, r.json()["no"])
    _, topics = events.since(seq)
    assert {"jobs", "runs"} <= topics


def test_rolled_back_changes_are_not_announced(client):
    from app import events
    from app import models as m
    from app.db import SessionLocal

    seq = events.current()
    with SessionLocal() as db:
        job = db.query(m.Job).first()
        job.last_time = "롤백될 값"
        db.flush()
        db.rollback()
    assert events.since(seq)[1] == set()


def test_a_page_behind_or_from_before_a_restart_hears_everything():
    from app import events

    events.publish("jobs")
    now = events.current()
    assert events.since(now) == (now, set())
    assert events.since(now - 1) == (now, {"jobs"})
    assert events.since(now + 50)[1] == set(events.TOPICS.values())  # number from an older server process
    for _ in range(events.KEEP + 5):
        events.publish("runs")
    assert events.since(now)[1] == set(events.TOPICS.values())  # missed more than is remembered


def test_stream_needs_login(client):
    set_session_cookie(client, None)
    assert client.get("/api/events").status_code == 401
