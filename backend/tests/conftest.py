"""Shared setup for the flow tests (tests/test_flow_*.py).

They run the real API against a throwaway database, `wharfline_test`, on the same Postgres server
as DATABASE_URL: it is created, migrated and seeded once per test session, then dropped. The dev
database is never touched. Without a reachable database or master key the flow tests are skipped;
the unit tests run either way.
"""

import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlsplit, urlunsplit

import pytest

# Point the app at the test database before any app module creates its engine.
_base = urlsplit(os.environ.get("DATABASE_URL", "postgresql+psycopg://wharfline:wharfline@localhost:55432/wharfline"))
TEST_DB = os.environ.get("WHARFLINE_TEST_DB", "wharfline_test")
os.environ["DATABASE_URL"] = urlunsplit(_base._replace(path=f"/{TEST_DB}"))
os.environ["WHARFLINE_SSH_SIMULATE"] = "1"
os.environ["WHARFLINE_AUTO_DELAY"] = "0"  # auto-deploys start right away (they batch pushes for 20s otherwise)  # no reachable SSH servers in tests (see app/sshcheck.py)
ADMIN_URL = urlunsplit(_base._replace(path="/postgres"))


def _recreate_db() -> None:
    from sqlalchemy import create_engine, text

    eng = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    try:
        with eng.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)'))
            c.execute(text(f'CREATE DATABASE "{TEST_DB}"'))
    finally:
        eng.dispose()


def _drop_db() -> None:
    from sqlalchemy import create_engine, text

    eng = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    try:
        with eng.connect() as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{TEST_DB}" WITH (FORCE)'))
    finally:
        eng.dispose()


@pytest.fixture(scope="session")
def client():
    """The FastAPI app on a fresh, migrated and seeded test database. Runs play back instantly."""
    from sqlalchemy.exc import OperationalError

    from app import crypto

    try:
        crypto.keyring()
    except crypto.CryptoError as e:
        pytest.skip(f"no master key for the flow tests: {e}")
    try:
        _recreate_db()
    except OperationalError as e:
        pytest.skip(f"no database for the flow tests: {e.orig}")

    from fastapi.testclient import TestClient

    from app import prestart, runner
    from app.db import SessionLocal, engine
    from app.main import app
    from app.seed import seed_if_empty

    prestart.migrate()
    with SessionLocal() as db:
        seed_if_empty(db)
    runner.PACE = 0
    with TestClient(app, headers=CSRF) as c:
        yield c
    engine.dispose()
    _drop_db()


@pytest.fixture(scope="session", autouse=True)
def notify_sent():
    """Deploy notifications never leave the machine in tests: every send lands in this list instead.

    Session-wide and never undone, so a send queued late by one test can't reach the network after it.
    """
    from app import notify

    sent: list[tuple[str, dict, dict]] = []
    notify.post = lambda url, body, headers: sent.append((url, body, headers))
    return sent


CSRF = {"X-Requested-With": "wharfline"}  # the browser app sends this on every write
COOKIE_DOMAIN = "testserver.local"  # how the cookie jar stores cookies the TestClient's "testserver" host sets


def set_session_cookie(client, token: str | None) -> None:
    from app import authn

    client.cookies.clear()
    if token:
        client.cookies.set(authn.COOKIE, token, domain=COOKIE_DOMAIN, path="/")


def make_session(email: str, sudo: bool = False) -> str:
    """A signed-in session row for that member, as if they had logged in. Returns the cookie token."""
    from app import authn
    from app import models as m
    from app.db import SessionLocal

    token, now = authn.new_token(), time.time()
    with SessionLocal() as db:
        db.add(m.LoginSession(token_hash=authn.token_hash(token), member_email=email, stage="ok", created_at=now, last_seen=now,
                              expires_at=now + 3600, sudo_until=now + 300 if sudo else 0.0, user_agent="pytest", ip="testclient"))
        db.commit()
    return token


@pytest.fixture
def login(client):
    """login("minji@acme.kr", sudo=True): become that member for the next requests (a real session and cookie)."""

    def as_member(email: str, sudo: bool = False) -> None:
        set_session_cookie(client, make_session(email, sudo))

    as_member("jeonghoon@acme.kr")  # each test starts as the Owner
    return as_member


OWNER, DEPLOYER, VIEWER = "jeonghoon@acme.kr", "minji@acme.kr", "seojun@acme.kr"


def wait_run(client, no: int, timeout: float = 10) -> dict:
    """Poll a run until it finishes."""
    end = time.time() + timeout
    while time.time() < end:
        run = client.get(f"/api/runs/{no}").json()
        if run["status"] != "run":
            return run
        time.sleep(0.05)
    raise AssertionError(f"run #{no} did not finish in {timeout}s")


def log_text(run: dict) -> str:
    return "\n".join(e.get("text", "") for e in run.get("events", []) if e.get("t") == "line")


def send_hook(client, secret: str, event: str, payload: dict, provider: str = "gitea"):
    """POST a webhook the way each Git host signs it."""
    body = json.dumps(payload).encode()
    headers = {"content-type": "application/json"}
    if provider == "gitlab":
        headers |= {"x-gitlab-event": event, "x-gitlab-token": secret}
    else:
        sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        headers |= ({"x-gitea-event": event, "x-gitea-signature": sig} if provider == "gitea" else {"x-github-event": event, "x-hub-signature-256": f"sha256={sig}"})
    return client.post("/api/hooks/git", content=body, headers=headers)


def builtin_job(name: str, inventory: str, image: str, **extra) -> dict:
    """POST /api/jobs body for a job on the built-in playbook."""
    return {"name": name, "playbook": {"source": "builtin"}, "inventory": inventory, "targets": [], "image": image,
            "envMode": "none", "envVars": [], "hook": False, "protected": False, "lock": True, "rollback": True, **extra}


def wait_auto_run(client, job_name: str, after: int = 0, status: str | None = None, timeout: float = 10) -> dict:
    """The first run of a job numbered above `after`, started by an auto-deploy (queued, so it appears shortly)."""
    end = time.time() + timeout
    while time.time() < end:
        runs = [r for r in client.get("/api/runs").json() if r["job"] == job_name and r["no"] > after and r["trigger"] == "새 이미지 push"]
        runs = [r for r in runs if status is None or r["status"] == status]
        if runs:
            return min(runs, key=lambda r: r["no"])
        time.sleep(0.05)
    raise AssertionError(f"no auto-deploy run for {job_name}")


def last_run_no(client) -> int:
    return max((r["no"] for r in client.get("/api/runs").json()), default=0)
