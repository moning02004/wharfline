"""Envelope encryption for secrets at rest.

Every record gets its own random 256-bit data key (DEK). The data is sealed
with AES-256-GCM under that DEK, and the DEK is wrapped by a master key (KEK).
Only the wrapped DEK is stored; KEKs never touch the DB.

- A leaked DEK exposes one record, not all of them.
- Rotating the master key only re-wraps DEKs (`python -m app.keys rotate`).
- Ciphertext and wrapped DEK are bound to their record (AAD / derivation
  context), so copying them onto another row makes decryption fail.

Where the master key lives (first match wins for new data):

1. Vault / OpenBao Transit (recommended): WHARFLINE_KMS=vault. The KEK never
   leaves the KMS; this process only asks it to wrap/unwrap DEKs.
     VAULT_ADDR, VAULT_TOKEN or VAULT_TOKEN_FILE,
     WHARFLINE_VAULT_KEY (default "wharfline"), WHARFLINE_VAULT_MOUNT (default "transit")
2. Local key file: WHARFLINE_MASTER_KEYS, or the file named by
   WHARFLINE_MASTER_KEYS_FILE (default /run/secrets/master_keys).
   One `<id>:<base64 32 bytes>` per line; the first one is active.

Local keys stay usable for decryption when Vault is active, so moving from a
key file to Vault is: configure Vault, keep the file, run `rotate`.
To move back off Vault, set WHARFLINE_KMS=vault-decrypt (Vault only unwraps,
the first local key wraps) and run `rotate`.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

NONCE_LEN = 12  # 96-bit nonces, random per encryption (GCM's recommended size)
KEY_LEN = 32  # AES-256
KEK_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
DEFAULT_KEYS_FILE = "/run/secrets/master_keys"
VAULT_PREFIX = "vault:"


class CryptoError(Exception):
    """Raised for missing keys, bad key config, KMS failures, or data that fails authentication."""


@dataclass(frozen=True)
class Envelope:
    kek_id: str
    wrapped_dek: bytes  # local: nonce || AES-GCM(KEK, DEK); vault: b"vault:vN:..."
    nonce: bytes
    ciphertext: bytes  # AES-GCM(DEK, plaintext), includes the 16-byte tag


def _aad(context: str, part: str) -> bytes:
    return f"wharfline/v1/{part}/{context}".encode()


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


# ---------- Vault / OpenBao Transit ----------

class VaultTransit:
    """Wraps DEKs with a Transit key created with `derived=true`.

    The per-record context is sent as the derivation context, so a wrapped DEK
    only unwraps for the record it was made for. Least-privilege policy:

        path "transit/encrypt/wharfline" { capabilities = ["update"] }
        path "transit/decrypt/wharfline" { capabilities = ["update"] }
        path "transit/rewrap/wharfline"  { capabilities = ["update"] }
        path "transit/keys/wharfline"    { capabilities = ["read"] }
    """

    def __init__(self, addr: str, token: str, key: str = "wharfline", mount: str = "transit", timeout: float = 5.0):
        if not addr or not token:
            raise CryptoError("Vault needs VAULT_ADDR and VAULT_TOKEN (or VAULT_TOKEN_FILE)")
        if not re.match(r"^[A-Za-z0-9_-]{1,25}$", key):
            raise CryptoError(f"invalid Vault transit key name {key!r}")
        self.addr, self.token, self.key, self.mount, self.timeout = addr.rstrip("/"), token, key, mount.strip("/"), timeout
        self.kek_id = f"{VAULT_PREFIX}{key}"
        self._latest: tuple[float, int] | None = None

    @classmethod
    def from_env(cls) -> VaultTransit:
        token = os.getenv("VAULT_TOKEN", "")
        token_file = os.getenv("VAULT_TOKEN_FILE")
        if not token and token_file:
            p = Path(token_file)
            if not p.is_file():
                raise CryptoError(f"VAULT_TOKEN_FILE {p} not found")
            token = p.read_text().strip()
        return cls(os.getenv("VAULT_ADDR", ""), token, os.getenv("WHARFLINE_VAULT_KEY", "wharfline"),
                   os.getenv("WHARFLINE_VAULT_MOUNT", "transit"))

    def call(self, method: str, path: str, body: dict | None = None) -> dict:
        req = urllib.request.Request(
            f"{self.addr}/v1/{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"X-Vault-Token": self.token, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            raise CryptoError(f"Vault {method} {path} failed: HTTP {e.code} {detail}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise CryptoError(f"Vault unreachable at {self.addr}: {e}") from e

    def _op(self, op: str, body: dict) -> dict:
        return self.call("POST", f"{self.mount}/{op}/{self.key}", body)["data"]

    def wrap(self, dek: bytes, context: str) -> bytes:
        return self._op("encrypt", {"plaintext": _b64(dek), "context": _b64(_aad(context, "dek"))})["ciphertext"].encode()

    def unwrap(self, wrapped: bytes, context: str) -> bytes:
        try:
            return base64.b64decode(self._op("decrypt", {"ciphertext": wrapped.decode(), "context": _b64(_aad(context, "dek"))})["plaintext"])
        except CryptoError as e:
            raise CryptoError(f"data key failed to unwrap in Vault (wrong context, key or tampered record): {e}") from e

    def rewrap(self, wrapped: bytes, context: str) -> bytes:
        return self._op("rewrap", {"ciphertext": wrapped.decode(), "context": _b64(_aad(context, "dek"))})["ciphertext"].encode()

    def latest_version(self) -> int:
        now = time.monotonic()
        if self._latest and now - self._latest[0] < 60:
            return self._latest[1]
        v = int(self.call("GET", f"{self.mount}/keys/{self.key}")["data"]["latest_version"])
        self._latest = (now, v)
        return v

    @staticmethod
    def version_of(wrapped: bytes) -> int:
        m = re.match(rb"^vault:v(\d+):", wrapped)
        if not m:
            raise CryptoError("not a Vault ciphertext")
        return int(m.group(1))


# ---------- key ring ----------

class KeyRing:
    """Local master keys and/or a Vault Transit key. New data uses Vault if configured."""

    def __init__(self, keys: list[tuple[str, bytes]] | tuple = (), vault: VaultTransit | None = None, vault_active: bool = True):
        keys = list(keys)
        if not keys and vault is None:
            raise CryptoError("no master key configured")
        ids = [k for k, _ in keys]
        if len(set(ids)) != len(ids):
            raise CryptoError("duplicate master key id")
        for kid, key in keys:
            if not KEK_ID_RE.match(kid) or kid.startswith(VAULT_PREFIX):
                raise CryptoError(f"invalid master key id {kid!r}")
            if len(key) != KEY_LEN:
                raise CryptoError(f"master key {kid!r} must be {KEY_LEN} bytes, got {len(key)}")
        if vault and not vault_active and not keys:
            raise CryptoError("vault-decrypt mode needs a local master key to wrap new data")
        self._keys = dict(keys)
        self.vault = vault
        self.active_id = vault.kek_id if vault and vault_active else ids[0]

    @property
    def ids(self) -> list[str]:
        return ([self.vault.kek_id] if self.vault else []) + list(self._keys)

    @staticmethod
    def parse_keys(text: str) -> list[tuple[str, bytes]]:
        keys: list[tuple[str, bytes]] = []
        for item in re.split(r"[\n,]", text):
            item = item.strip()
            if not item or item.startswith("#"):
                continue
            kid, sep, b64 = item.partition(":")
            if not sep:
                raise CryptoError("master key entries must look like <id>:<base64>")
            try:
                key = base64.b64decode(b64.strip(), validate=True)
            except binascii.Error as e:
                raise CryptoError(f"master key {kid!r} is not valid base64") from e
            keys.append((kid.strip(), key))
        return keys

    @classmethod
    def parse(cls, text: str) -> KeyRing:
        return cls(cls.parse_keys(text))

    @classmethod
    def from_env(cls) -> KeyRing:
        mode = os.getenv("WHARFLINE_KMS", "local").lower()
        if mode not in ("local", "vault", "vault-decrypt"):
            raise CryptoError(f"WHARFLINE_KMS must be local, vault or vault-decrypt, not {mode!r}")
        vault = VaultTransit.from_env() if mode.startswith("vault") else None
        inline = os.getenv("WHARFLINE_MASTER_KEYS")
        path = Path(os.getenv("WHARFLINE_MASTER_KEYS_FILE", DEFAULT_KEYS_FILE))
        if inline:
            keys = cls.parse_keys(inline)
        elif path.is_file():
            keys = cls.parse_keys(path.read_text())
        elif vault:
            keys = []
        else:
            raise CryptoError(
                f"master key not found: set WHARFLINE_MASTER_KEYS, put keys in {path} "
                "(run `make keygen`), or configure Vault with WHARFLINE_KMS=vault"
            )
        return cls(keys, vault, vault_active=mode == "vault")

    def _local(self, kek_id: str) -> AESGCM:
        key = self._keys.get(kek_id)
        if key is None:
            raise CryptoError(f"master key {kek_id!r} is not loaded; add it back to read this data")
        return AESGCM(key)

    def _vault_for(self, kek_id: str) -> VaultTransit:
        if not self.vault or self.vault.kek_id != kek_id:
            raise CryptoError(f"master key {kek_id!r} is not loaded; configure Vault key {kek_id[len(VAULT_PREFIX):]!r}")
        return self.vault

    def wrap(self, dek: bytes, context: str) -> tuple[str, bytes]:
        if self.vault and self.active_id == self.vault.kek_id:
            return self.vault.kek_id, self.vault.wrap(dek, context)
        nonce = os.urandom(NONCE_LEN)
        return self.active_id, nonce + self._local(self.active_id).encrypt(nonce, dek, _aad(context, "dek"))

    def unwrap(self, kek_id: str, wrapped: bytes, context: str) -> bytes:
        if kek_id.startswith(VAULT_PREFIX):
            return self._vault_for(kek_id).unwrap(wrapped, context)
        try:
            return self._local(kek_id).decrypt(wrapped[:NONCE_LEN], wrapped[NONCE_LEN:], _aad(context, "dek"))
        except InvalidTag as e:
            raise CryptoError("data key failed authentication (wrong key or tampered record)") from e

    def needs_rewrap(self, kek_id: str, wrapped: bytes) -> bool:
        if kek_id != self.active_id:
            return True
        if self.vault and kek_id == self.vault.kek_id:
            return VaultTransit.version_of(wrapped) < self.vault.latest_version()
        return False

    def rewrap_dek(self, kek_id: str, wrapped: bytes, context: str) -> tuple[str, bytes]:
        if self.vault and kek_id == self.vault.kek_id == self.active_id:
            return kek_id, self.vault.rewrap(wrapped, context)  # Vault re-encrypts with its latest key version
        return self.wrap(self.unwrap(kek_id, wrapped, context), context)


@lru_cache(maxsize=1)
def keyring() -> KeyRing:
    return KeyRing.from_env()


# ---------- envelope operations ----------

def encrypt(plaintext: bytes, context: str, ring: KeyRing | None = None) -> Envelope:
    ring = ring or keyring()
    dek = AESGCM.generate_key(bit_length=256)
    nonce = os.urandom(NONCE_LEN)
    ciphertext = AESGCM(dek).encrypt(nonce, plaintext, _aad(context, "data"))
    kek_id, wrapped = ring.wrap(dek, context)
    return Envelope(kek_id, wrapped, nonce, ciphertext)


def decrypt(env: Envelope, context: str, ring: KeyRing | None = None) -> bytes:
    ring = ring or keyring()
    dek = ring.unwrap(env.kek_id, env.wrapped_dek, context)
    try:
        return AESGCM(dek).decrypt(env.nonce, env.ciphertext, _aad(context, "data"))
    except InvalidTag as e:
        raise CryptoError("data failed authentication (tampered or moved record)") from e


def rewrap(env: Envelope, context: str, ring: KeyRing | None = None) -> Envelope:
    """Re-wrap the record's DEK with the active master key. The data is untouched."""
    ring = ring or keyring()
    if not ring.needs_rewrap(env.kek_id, env.wrapped_dek):
        return env
    kek_id, wrapped = ring.rewrap_dek(env.kek_id, env.wrapped_dek, context)
    return Envelope(kek_id, wrapped, env.nonce, env.ciphertext)


def seal_json(value: Any, context: str, ring: KeyRing | None = None) -> Envelope:
    return encrypt(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(), context, ring)


def open_json(env: Envelope, context: str, ring: KeyRing | None = None) -> Any:
    return json.loads(decrypt(env, context, ring))


def generate_key_line(kek_id: str) -> str:
    return f"{kek_id}:{_b64(os.urandom(KEY_LEN))}"
