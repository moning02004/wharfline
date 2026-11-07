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
    with TestClient(app) as c:
        yield c
    engine.dispose()
    _drop_db()


@pytest.fixture
def login(client):
    """login("minji@acme.kr", sudo=True): become that member for the next requests."""
    from app import store as s
    from app.db import SessionLocal

    def as_member(email: str, sudo: bool = False) -> None:
        with SessionLocal() as db:
            s.set_setting(db, "session", logged_in=True, email=email, pending_login=False, sudo_until=time.time() + 300 if sudo else 0.0)
            db.commit()

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
