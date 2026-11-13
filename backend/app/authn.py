"""Passwords, TOTP, session tokens and the per-request auth context.

Nothing here touches the database; `store.py` and `routers/auth.py` use these helpers.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import re
import secrets
import struct
import time
from contextvars import ContextVar
from dataclasses import dataclass
from urllib.parse import quote

import bcrypt

COOKIE = "wharfline_session"
CSRF_HEADER = "x-requested-with"
CSRF_VALUE = "wharfline"

PASSWORD_MIN = 10
PASSWORD_MAX_BYTES = 72  # bcrypt ignores anything longer
BCRYPT_ROUNDS = 12
RECOVERY_ROUNDS = 10  # recovery codes are long and random; a lighter cost keeps checking ten of them quick
PENDING_SECONDS = 10 * 60  # a half-finished login (waiting for TOTP, a new password or 2FA setup) expires after this
TOUCH_SECONDS = 60  # last_seen is written at most this often per session

TOTP_STEP = 30
TOTP_DIGITS = 6
TOTP_WINDOW = 1  # accept the previous and next 30-second step too (clock drift)


def cookie_secure() -> bool:
    return os.getenv("WHARFLINE_COOKIE_SECURE", "").strip().lower() in ("1", "true", "yes", "on")


def seed_password() -> str:
    return os.getenv("WHARFLINE_SEED_PASSWORD") or "wharfline"


# ---------- per-request context ----------

@dataclass
class RequestAuth:
    """Set by the middleware for each request. Mutable so a login can switch the token mid-request."""

    token: str | None = None
    ip: str = ""
    agent: str = ""
    touched: bool = False


request_auth: ContextVar[RequestAuth | None] = ContextVar("wharfline_request_auth", default=None)


def current() -> RequestAuth:
    ra = request_auth.get()
    if ra is None:  # outside a request (scripts, background tasks started elsewhere)
        ra = RequestAuth()
    return ra


# ---------- passwords ----------

_dummy_hash: bytes | None = None


def hash_password(password: str, rounds: int = BCRYPT_ROUNDS) -> str:
    return bcrypt.hashpw(password.encode()[:PASSWORD_MAX_BYTES], bcrypt.gensalt(rounds)).decode()


def check_password(password: str, hashed: str | None) -> bool:
    """Constant-ish time: without a hash, still spend the time of one bcrypt check."""
    global _dummy_hash
    pw = (password or "").encode()[:PASSWORD_MAX_BYTES]
    if not hashed:
        if _dummy_hash is None:
            _dummy_hash = bcrypt.hashpw(b"not-a-password", bcrypt.gensalt(BCRYPT_ROUNDS))
        bcrypt.checkpw(pw, _dummy_hash)
        return False
    try:
        return bcrypt.checkpw(pw, hashed.encode())
    except ValueError:
        return False


def password_problem(password: str) -> str | None:
    """Why a new password is not acceptable, or None."""
    if len(password) < PASSWORD_MIN:
        return f"비밀번호는 {PASSWORD_MIN}자 이상으로 정해 주세요."
    if len(password.encode()) > PASSWORD_MAX_BYTES:
        return "비밀번호가 너무 길어요 (최대 72바이트)."
    return None


def temporary_password() -> str:
    alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(14))


# ---------- TOTP (RFC 4226 / RFC 6238) ----------

def hotp(key: bytes, counter: int, digits: int = TOTP_DIGITS, digest: str = "sha1") -> str:
    mac = hmac.new(key, struct.pack(">Q", counter), digest).digest()
    off = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[off:off + 4])[0] & 0x7FFFFFFF) % 10 ** digits
    return str(code).zfill(digits)


def totp(key: bytes, at: float, step: int = TOTP_STEP, digits: int = TOTP_DIGITS, digest: str = "sha1") -> str:
    return hotp(key, int(at // step), digits, digest)


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def totp_key(secret: str) -> bytes:
    s = secret.replace(" ", "").upper()
    return base64.b32decode(s + "=" * (-len(s) % 8))


def verify_totp(secret: str, code: str, at: float | None = None, after_step: int | None = None) -> int | None:
    """The matching time step, or None. Steps at or before `after_step` were already used (no replays)."""
    code = (code or "").strip().replace(" ", "")
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return None
    key = totp_key(secret)
    now_step = int((time.time() if at is None else at) // TOTP_STEP)
    for step in range(now_step - TOTP_WINDOW, now_step + TOTP_WINDOW + 1):
        if after_step is not None and step <= after_step:
            continue
        if hmac.compare_digest(hotp(key, step), code):
            return step
    return None


def otpauth_uri(secret: str, email: str) -> str:
    label = quote(f"Wharfline:{email}")
    return f"otpauth://totp/{label}?secret={secret}&issuer=Wharfline&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_STEP}"


def spaced(secret: str) -> str:
    return " ".join(secret[i:i + 4] for i in range(0, len(secret), 4))


# ---------- recovery codes ----------

def new_recovery_codes(n: int = 10) -> list[str]:
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return ["".join(secrets.choice(alphabet) for _ in range(5)) + "-" + "".join(secrets.choice(alphabet) for _ in range(5)) for _ in range(n)]


def normalize_code(code: str) -> str:
    c = re.sub(r"[\s-]", "", (code or "").lower())
    return f"{c[:5]}-{c[5:]}" if len(c) == 10 else c


def hash_recovery(code: str) -> str:
    return hash_password(normalize_code(code), RECOVERY_ROUNDS)


def match_recovery(code: str, hashes: list[str]) -> int | None:
    c = normalize_code(code)
    if len(c) != 11:
        return None
    for i, h in enumerate(hashes):
        if check_password(c, h):
            return i
    return None


# ---------- session tokens ----------

def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ---------- policy strings ----------

def _seconds(n: str, unit: str) -> int:
    return int(n) * (3600 if unit == "시간" else 60)


SESSION_DEFAULT = "6시간"


def session_limits(policy: dict) -> tuple[int, int]:
    """(absolute lifetime, idle timeout) in seconds, from e.g. "6시간" or "8시간 (활동 없으면 30분)".

    Without an idle part the session simply lasts the whole lifetime.
    """
    text = str(policy.get("session") or SESSION_DEFAULT)
    absolute = re.search(r"^\s*(\d+)\s*(시간|분)", text)
    idle = re.search(r"활동 없으면\s*(\d+)\s*(시간|분)", text)
    total = _seconds(*absolute.groups()) if absolute else 6 * 3600
    return total, min(total, _seconds(*idle.groups())) if idle else total


def lockout_rule(policy: dict) -> tuple[int, int]:
    """(failures, lock seconds), from e.g. "5회 실패 시 15분 잠금"."""
    found = re.search(r"(\d+)\s*회 실패 시\s*(\d+)\s*(시간|분)", str(policy.get("lockout") or ""))
    if not found:
        return 5, 15 * 60
    n, t, unit = found.groups()
    return max(1, int(n)), _seconds(t, unit)


# ---------- display ----------

def describe_agent(ua: str) -> str:
    """"Chrome 141 · macOS" from a User-Agent string; good enough for a device list."""
    if not ua:
        return "알 수 없는 기기"
    browser = None
    for name, pat in (("Edge", r"Edg/(\d+)"), ("Firefox", r"Firefox/(\d+)"), ("Chrome", r"Chrome/(\d+)"), ("Safari", r"Version/(\d+).*Safari")):
        found = re.search(pat, ua)
        if found:
            browser = f"{name} {found.group(1)}"
            break
    os_name = next((label for key, label in (("iPhone", "iOS"), ("iPad", "iPadOS"), ("Android", "Android"), ("Mac OS X", "macOS"),
                                             ("Windows", "Windows"), ("Linux", "Linux")) if key in ua), None)
    if not browser:
        browser = ua.split(" ")[0][:40]
    return f"{browser} · {os_name}" if os_name else browser


# ---------- middleware ----------

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
CSRF_EXEMPT = ("/api/hooks/",)  # called by Git hosts, authenticated by the webhook secret


class AuthMiddleware:
    """Puts the session token (and client ip/agent) in a contextvar, and checks the CSRF header on writes.

    The header check works because a browser never lets another site add a custom header to a
    cross-site request without a CORS preflight, which only our own origins pass.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        from starlette.requests import Request
        from starlette.responses import JSONResponse

        req = Request(scope)
        if (req.method in WRITE_METHODS and not scope["path"].startswith(CSRF_EXEMPT)
                and req.headers.get(CSRF_HEADER, "").lower() != CSRF_VALUE):
            await JSONResponse({"detail": "csrf_required"}, status_code=403)(scope, receive, send)
            return
        # Behind the bundled nginx, X-Real-IP is the browser's address; the backend port is not published.
        ip = req.headers.get("x-real-ip") or (req.client.host if req.client else "")
        reset = request_auth.set(RequestAuth(token=req.cookies.get(COOKIE) or None, ip=ip[:64],
                                             agent=req.headers.get("user-agent", "")[:512]))
        try:
            await self.app(scope, receive, send)
        finally:
            request_auth.reset(reset)
