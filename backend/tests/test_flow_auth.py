"""Real login through the API: passwords, lockout, optional TOTP, sudo, sessions, CSRF (docs/security-hardening.md A)."""

import time
import uuid

import pytest

from tests.conftest import CSRF, OWNER, send_hook, set_session_cookie

BAD_LOGIN = "이메일 또는 비밀번호가 맞지 않아요."
PASSWORD = "correct horse battery"


def new_member(password: str = PASSWORD, role: str = "Deployer") -> str:
    """A throwaway member, so lockouts and 2FA changes never touch the seed accounts other tests use."""
    from app import authn
    from app import models as m
    from app.db import SessionLocal

    email = f"auth-{uuid.uuid4().hex[:8]}@acme.kr"
    with SessionLocal() as db:
        db.add(m.Member(email=email, name=email.split("@")[0], role=role, tfa=False, last="-", password_hash=authn.hash_password(password, 4)))
        db.commit()
    return email


@pytest.fixture
def fresh(client):
    """The shared client with no session: like a browser that has not signed in."""
    set_session_cookie(client, None)
    return client


@pytest.fixture
def other_client(client):
    """A second browser."""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, headers=CSRF)


def sign_in(c, email: str, password: str = PASSWORD) -> dict:
    r = c.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def code_at(secret: str, offset: float = 0) -> str:
    from app import authn

    return authn.totp(authn.totp_key(secret), time.time() + offset)


def enable_tfa(c, password: str = PASSWORD) -> tuple[str, list[str]]:
    """Turn 2FA on for whoever `c` is signed in as. Returns (secret, recovery codes)."""
    assert c.post("/api/auth/tfa/begin").json()["detail"] == "sudo_required"
    assert c.post("/api/auth/sudo", json={"password": password}).status_code == 200
    begun = c.post("/api/auth/tfa/begin").json()
    secret = begun["secret"].replace(" ", "")
    assert begun["uri"].startswith("otpauth://totp/") and f"secret={secret}" in begun["uri"]
    assert c.post("/api/auth/tfa/verify", json={"code": "000000" if code_at(secret) != "000000" else "111111"}).status_code == 400
    r = c.post("/api/auth/tfa/verify", json={"code": code_at(secret)})
    assert r.status_code == 200, r.text
    assert r.json()["session"]["tfa"] is True
    return secret, r.json()["codes"]


def test_wrong_password_and_unknown_email_get_the_same_answer(fresh):
    email = new_member()
    wrong = fresh.post("/api/auth/login", json={"email": email, "password": "nope-nope-nope"})
    unknown = fresh.post("/api/auth/login", json={"email": "nobody@acme.kr", "password": "nope-nope-nope"})
    assert (wrong.status_code, wrong.json()["detail"]) == (400, BAD_LOGIN)
    assert (unknown.status_code, unknown.json()["detail"]) == (400, BAD_LOGIN)
    assert fresh.get("/api/auth/me").json()["loggedIn"] is False
    assert fresh.get("/api/jobs").status_code == 401


def test_password_only_login_when_2fa_is_off(fresh):
    r = fresh.post("/api/auth/login", json={"email": "Minji@acme.kr", "password": "wharfline"})  # seed password, any case of email
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["loggedIn"] is True and body["step"] is None and body["me"]["email"] == "minji@acme.kr"
    cookie = r.headers["set-cookie"]
    assert "wharfline_session=" in cookie and "HttpOnly" in cookie and "SameSite=lax" in cookie and "Secure" not in cookie
    assert fresh.get("/api/jobs").status_code == 200


def test_lockout_after_repeated_failures_then_owner_reset(fresh, other_client):
    email = new_member()
    for _ in range(4):
        assert fresh.post("/api/auth/login", json={"email": email, "password": "wrong-password"}).status_code == 400
    fifth = fresh.post("/api/auth/login", json={"email": email, "password": "wrong-password"})
    assert fifth.status_code == 429 and "잠겼어요" in fifth.json()["detail"]
    # Locked: even the right password is refused.
    assert fresh.post("/api/auth/login", json={"email": email, "password": PASSWORD}).status_code == 429

    # The Owner resets the password (needs a fresh password re-check): a temporary one, shown once.
    set_session_cookie(other_client, None)
    sign_in(other_client, OWNER, "wharfline")
    assert other_client.post(f"/api/members/{email}/password", json={}).json()["detail"] == "sudo_required"
    assert other_client.post("/api/auth/sudo", json={"password": "wharfline"}).status_code == 200
    r = other_client.post(f"/api/members/{email}/password", json={})
    assert r.status_code == 200, r.text
    temp = r.json()["password"]
    assert r.json()["member"]["locked"] is False and r.json()["member"]["mustChangePassword"] is True

    # Signing in with it only allows changing the password.
    body = sign_in(fresh, email, temp)
    assert body["loggedIn"] is False and body["step"] == "password"
    assert fresh.get("/api/jobs").status_code == 401
    assert fresh.post("/api/auth/password", json={"new": "short"}).status_code == 400
    assert fresh.post("/api/auth/password", json={"new": temp}).status_code == 400
    done = fresh.post("/api/auth/password", json={"new": "a brand new password"})
    assert done.status_code == 200 and done.json()["loggedIn"] is True
    set_session_cookie(fresh, None)
    assert fresh.post("/api/auth/login", json={"email": email, "password": temp}).status_code == 400
    assert sign_in(fresh, email, "a brand new password")["loggedIn"] is True


def test_totp_is_asked_only_once_turned_on(fresh):
    email = new_member()
    assert sign_in(fresh, email)["loggedIn"] is True
    secret, codes = enable_tfa(fresh)
    assert len(codes) == 10
    fresh.post("/api/auth/logout")

    body = sign_in(fresh, email)
    assert body["loggedIn"] is False and body["step"] == "totp"
    assert fresh.get("/api/jobs").status_code == 401  # half signed-in is not signed in
    assert fresh.post("/api/auth/totp", json={"code": "12345"}).status_code == 400
    wrong = "000000" if code_at(secret, 30) != "000000" else "111111"
    assert fresh.post("/api/auth/totp", json={"code": wrong}).json()["detail"] == "인증 코드가 맞지 않아요."
    # The code used to confirm setup was for this 30-second step; it cannot be replayed, the next one works (±1 step).
    ok = fresh.post("/api/auth/totp", json={"code": code_at(secret, 30)})
    assert ok.status_code == 200 and ok.json()["loggedIn"] is True
    fresh.post("/api/auth/logout")

    # A recovery code works once.
    sign_in(fresh, email)
    r = fresh.post("/api/auth/totp", json={"code": codes[0].upper()})
    assert r.status_code == 200 and r.json()["loggedIn"] is True and r.json()["recoveryCodes"] == 9
    fresh.post("/api/auth/logout")
    sign_in(fresh, email)
    assert fresh.post("/api/auth/totp", json={"code": codes[0]}).status_code == 400

    # Turning it off needs the password; then login is password-only again.
    assert fresh.post("/api/auth/totp", json={"code": codes[1]}).status_code == 200
    assert fresh.post("/api/auth/tfa/disable", json={"password": "wrong-password"}).status_code == 400
    assert fresh.post("/api/auth/tfa/disable", json={"password": PASSWORD}).json()["tfa"] is False
    fresh.post("/api/auth/logout")
    assert sign_in(fresh, email)["loggedIn"] is True


def test_policy_can_require_2fa_setup_right_after_login(fresh, login):
    login(OWNER)
    policy = fresh.get("/api/security").json()["policy"]
    assert policy["enforce2fa"] is False  # off by default
    assert fresh.put("/api/security/policy", json={**policy, "enforce2fa": True}).status_code == 200
    try:
        email = new_member()
        set_session_cookie(fresh, None)
        body = sign_in(fresh, email)
        assert body["loggedIn"] is False and body["step"] == "tfa_setup"
        assert fresh.get("/api/jobs").status_code == 401
        secret = fresh.post("/api/auth/tfa/begin").json()["secret"].replace(" ", "")
        r = fresh.post("/api/auth/tfa/verify", json={"code": code_at(secret)})
        assert r.status_code == 200 and r.json()["session"]["loggedIn"] is True
        assert fresh.post("/api/auth/tfa/disable", json={"password": PASSWORD}).status_code == 400  # the policy says no
    finally:
        login(OWNER)
        assert fresh.put("/api/security/policy", json={**policy, "enforce2fa": False}).status_code == 200


def test_sudo_needs_the_right_password(fresh):
    email = new_member()
    sign_in(fresh, email)
    bad = fresh.post("/api/auth/sudo", json={"password": "not my password"})
    assert bad.status_code == 400 and bad.json()["detail"] == "비밀번호가 맞지 않아요."
    assert fresh.get("/api/auth/me").json()["sudoUntil"] == 0
    good = fresh.post("/api/auth/sudo", json={"password": PASSWORD})
    assert good.status_code == 200 and good.json()["sudoUntil"] > time.time() * 1000
    assert fresh.delete("/api/auth/sudo").json()["sudoUntil"] == 0


def test_logout_kills_the_session(fresh):
    from app import authn
    from app import models as m
    from app.db import SessionLocal

    email = new_member()
    sign_in(fresh, email)
    token = fresh.cookies.get(authn.COOKIE)
    assert token
    r = fresh.post("/api/auth/logout")
    assert r.json()["loggedIn"] is False
    with SessionLocal() as db:
        assert db.get(m.LoginSession, authn.token_hash(token)) is None
    set_session_cookie(fresh, token)  # replaying the old cookie does nothing
    assert fresh.get("/api/auth/me").json()["loggedIn"] is False
    assert fresh.get("/api/jobs").status_code == 401


def test_write_without_csrf_header_is_rejected(client, login):
    r = client.post("/api/auth/sudo", json={"password": "wharfline"}, headers={"X-Requested-With": ""})
    assert (r.status_code, r.json()["detail"]) == (403, "csrf_required")
    from fastapi.testclient import TestClient

    from app.main import app

    bare = TestClient(app)
    r = bare.post("/api/auth/login", json={"email": OWNER, "password": "wharfline"})
    assert (r.status_code, r.json()["detail"]) == (403, "csrf_required")
    assert bare.get("/api/auth/me").status_code == 200  # reads need no header


def test_webhooks_work_without_csrf_header(client):
    from fastapi.testclient import TestClient

    from app import githooks
    from app.db import SessionLocal
    from app.main import app

    with SessionLocal() as db:
        secret = githooks.new_secret(db)
        db.commit()
    r = send_hook(TestClient(app), secret, "ping", {"zen": "hi"})
    assert r.status_code != 403, r.text
    assert r.status_code < 300


def test_two_logins_are_two_independent_sessions(fresh, other_client):
    email = new_member()
    sign_in(fresh, email)
    sign_in(other_client, email)
    assert fresh.cookies.get("wharfline_session") != other_client.cookies.get("wharfline_session")
    listed = fresh.get("/api/auth/sessions").json()
    assert len(listed) == 2 and sum(x["current"] for x in listed) == 1

    # sudo in one browser is not sudo in the other
    assert fresh.post("/api/auth/sudo", json={"password": PASSWORD}).status_code == 200
    assert other_client.get("/api/auth/me").json()["sudoUntil"] == 0

    # logging out one leaves the other signed in
    fresh.post("/api/auth/logout")
    assert other_client.get("/api/auth/me").json()["loggedIn"] is True

    # signing out other sessions ends them
    sign_in(fresh, email)
    other = next(x for x in other_client.get("/api/auth/sessions").json() if not x["current"])
    assert len(other_client.post("/api/auth/sessions/logout-others").json()) == 1
    assert fresh.get("/api/auth/me").json()["loggedIn"] is False
    assert other_client.delete(f"/api/auth/sessions/{other['id']}").status_code == 404


def test_changing_password_signs_out_other_sessions(fresh, other_client):
    email = new_member()
    sign_in(fresh, email)
    sign_in(other_client, email)
    assert fresh.post("/api/auth/password", json={"current": "wrong-password", "new": "another long password"}).status_code == 400
    r = fresh.post("/api/auth/password", json={"current": PASSWORD, "new": "another long password"})
    assert r.status_code == 200 and r.json()["loggedIn"] is True
    assert other_client.get("/api/auth/me").json()["loggedIn"] is False
