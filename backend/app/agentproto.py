"""How Wharfline and its agents trust each other.

Agent → Wharfline: every request after enrollment is signed with the agent's Ed25519 key over
    METHOD \\n PATH \\n UNIX_TIME \\n SHA256(body)
and sent as X-Wharfline-Agent (the agent id), X-Wharfline-Time and X-Wharfline-Sig. Wharfline keeps only the
public key, so nothing it stores lets anyone act as an agent. Requests older or newer than SKEW seconds, and a
signature seen before, are refused.

Wharfline → agent: every task is sealed to the agent's X25519 key (so .env values and secret variables can't be
read on the way, even over plain HTTP on a LAN) and signed with Wharfline's Ed25519 key, which the agent pinned
when it enrolled. A changed or forged task is refused. Files an agent sends back (a playbook's fetched files) are
sealed to Wharfline's X25519 key. Wharfline's private keys are sealed in the settings table with the master key,
like every other secret.

agent/wharfline_agent.py has the agent side of the same rules (it does not import this module).
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy.orm import Session

from . import crypto
from . import store as s

SKEW = 120.0
SETTING = "agent_keys"
CONTEXT = "setting:agent_keys"
HDR_ID, HDR_TIME, HDR_SIG = "x-wharfline-agent", "x-wharfline-time", "x-wharfline-sig"
ENROLL_TTL = 15 * 60  # an enrollment token is good for 15 minutes


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def unb64(text: str) -> bytes:
    return base64.b64decode(text, validate=True)


def canonical(method: str, path: str, ts: str, body: bytes) -> bytes:
    return f"{method.upper()}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode()


def public_key(text: str) -> Ed25519PublicKey:
    raw = unb64(text)
    if len(raw) != 32:
        raise ValueError("an Ed25519 public key is 32 bytes")
    return Ed25519PublicKey.from_public_bytes(raw)


def verify(key_b64: str, sig_b64: str, message: bytes) -> bool:
    try:
        public_key(key_b64).verify(unb64(sig_b64), message)
        return True
    except (InvalidSignature, ValueError):
        return False


class Replay:
    """Signatures seen in the last SKEW*2 seconds; a second use of one is a replay."""

    def __init__(self) -> None:
        self.seen: dict[str, float] = {}

    def fresh(self, sig: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        if len(self.seen) > 10000:
            self.seen = {k: t for k, t in self.seen.items() if now - t < SKEW * 2}
        if sig in self.seen:
            return False
        self.seen[sig] = now
        return True


REPLAY = Replay()


def check_request(key_b64: str, method: str, path: str, ts: str, sig: str, body: bytes, now: float | None = None) -> str | None:
    """None when the request is the agent's and fresh; otherwise why not."""
    now = time.time() if now is None else now
    try:
        t = float(ts)
    except ValueError:
        return "bad time"
    if abs(now - t) > SKEW:
        return "clock skew: check the server's time (NTP)"
    if not verify(key_b64, sig, canonical(method, path, ts, body)):
        return "bad signature"
    if not REPLAY.fresh(sig, now):
        return "replayed request"
    return None


# ---------- Wharfline's own keys ----------
# One sealed record: an Ed25519 key that signs tasks, and an X25519 key agents seal their results to.

def envelope(db: Session) -> crypto.Envelope | None:
    """The sealed keys, for the startup check that every needed master key is loaded."""
    v = s.get_setting(db, SETTING)
    if not v.get("ciphertext"):
        return None
    return crypto.Envelope(v["kek_id"], unb64(v["wrapped_dek"]), unb64(v["nonce"]), unb64(v["ciphertext"]))


class ServerKeys:
    def __init__(self, sign_raw: bytes, box_raw: bytes):
        self.sign = Ed25519PrivateKey.from_private_bytes(sign_raw)
        self.box = X25519PrivateKey.from_private_bytes(box_raw)

    @property
    def sign_public(self) -> str:
        return b64(self.sign.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))

    @property
    def box_public(self) -> str:
        return b64(self.box.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def _raw(key) -> bytes:
    return key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())


def server_keys(db: Session) -> ServerKeys:
    """Wharfline's keys, created (and committed) on first use."""
    env = envelope(db)
    if env is not None:
        v = json.loads(crypto.decrypt(env, CONTEXT))
        return ServerKeys(unb64(v["sign"]), unb64(v["box"]))
    raw = {"sign": b64(_raw(Ed25519PrivateKey.generate())), "box": b64(_raw(X25519PrivateKey.generate()))}
    env = crypto.encrypt(json.dumps(raw).encode(), CONTEXT)
    s.set_setting(db, SETTING, kek_id=env.kek_id, wrapped_dek=b64(env.wrapped_dek), nonce=b64(env.nonce),
                  ciphertext=b64(env.ciphertext), created=time.time())
    db.commit()
    return ServerKeys(unb64(raw["sign"]), unb64(raw["box"]))


def sign(key: Ed25519PrivateKey, data: bytes) -> str:
    return b64(key.sign(data))


# ---------- sealing (X25519 + HKDF-SHA256 + AES-256-GCM), the same on both sides ----------

INFO = b"wharfline-agent-seal-v1"


def _box_key(shared: bytes, epk: bytes, rpk: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=INFO + epk + rpk).derive(shared)


def seal(recipient_b64: str, plaintext: bytes) -> dict[str, str]:
    rpk = unb64(recipient_b64)
    eph = X25519PrivateKey.generate()
    epk = eph.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    key = _box_key(eph.exchange(X25519PublicKey.from_public_bytes(rpk)), epk, rpk)
    nonce = os.urandom(12)
    return {"epk": b64(epk), "nonce": b64(nonce), "ct": b64(AESGCM(key).encrypt(nonce, plaintext, None))}


def unseal(priv: X25519PrivateKey, box: dict[str, str]) -> bytes:
    epk, nonce, ct = unb64(box["epk"]), unb64(box["nonce"]), unb64(box["ct"])
    rpk = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    key = _box_key(priv.exchange(X25519PublicKey.from_public_bytes(epk)), epk, rpk)
    try:
        return AESGCM(key).decrypt(nonce, ct, None)
    except InvalidTag as e:
        raise ValueError("sealed data failed authentication") from e


def box_public_ok(text: str) -> bool:
    try:
        return len(unb64(text)) == 32
    except ValueError:
        return False


def new_token() -> tuple[str, str]:
    """(token, sha256 hex). The token is shown once; only the hash is stored."""
    token = "wfe_" + secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode()).hexdigest()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.strip().encode()).hexdigest()


def new_agent_id() -> str:
    return secrets.token_hex(16)
