"""Envelope encryption for secrets at rest.

Every record gets its own random 256-bit data key (DEK). The data is sealed
with AES-256-GCM under that DEK, and the DEK is wrapped by a master key (KEK).
Only the wrapped DEK is stored; KEKs never touch the DB.

- A leaked DEK exposes one record, not all of them.
- Rotating the master key only re-wraps DEKs (`python -m app.keys rotate`).
- Ciphertext and wrapped DEK are bound to their record (AAD / derivation
  context), so copying them onto another row makes decryption fail.

The master key file: WHARFLINE_MASTER_KEYS, or the file named by
WHARFLINE_MASTER_KEYS_FILE (default /run/secrets/master_keys).
One `<id>:<base64 32 bytes>` per line; the first one is active, the others
stay usable for reading data that was wrapped before a rotation.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
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


class CryptoError(Exception):
    """Raised for missing keys, bad key config, or data that fails authentication."""


@dataclass(frozen=True)
class Envelope:
    kek_id: str
    wrapped_dek: bytes  # nonce || AES-GCM(KEK, DEK)
    nonce: bytes
    ciphertext: bytes  # AES-GCM(DEK, plaintext), includes the 16-byte tag


def _aad(context: str, part: str) -> bytes:
    return f"wharfline/v1/{part}/{context}".encode()


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


# ---------- key ring ----------

class KeyRing:
    """The loaded master keys. The first one wraps new data."""

    def __init__(self, keys: list[tuple[str, bytes]] | tuple = ()):
        keys = list(keys)
        if not keys:
            raise CryptoError("no master key configured")
        ids = [k for k, _ in keys]
        if len(set(ids)) != len(ids):
            raise CryptoError("duplicate master key id")
        for kid, key in keys:
            if not KEK_ID_RE.match(kid):
                raise CryptoError(f"invalid master key id {kid!r}")
            if len(key) != KEY_LEN:
                raise CryptoError(f"master key {kid!r} must be {KEY_LEN} bytes, got {len(key)}")
        self._keys = dict(keys)
        self.active_id = ids[0]

    @property
    def ids(self) -> list[str]:
        return list(self._keys)

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
        inline = os.getenv("WHARFLINE_MASTER_KEYS")
        path = Path(os.getenv("WHARFLINE_MASTER_KEYS_FILE", DEFAULT_KEYS_FILE))
        if inline:
            return cls(cls.parse_keys(inline))
        if path.is_file():
            return cls(cls.parse_keys(path.read_text()))
        raise CryptoError(f"master key not found: set WHARFLINE_MASTER_KEYS or put keys in {path} (run `make keygen`)")

    def _local(self, kek_id: str) -> AESGCM:
        key = self._keys.get(kek_id)
        if key is None:
            raise CryptoError(f"master key {kek_id!r} is not loaded; add it back to read this data")
        return AESGCM(key)

    def wrap(self, dek: bytes, context: str) -> tuple[str, bytes]:
        nonce = os.urandom(NONCE_LEN)
        return self.active_id, nonce + self._local(self.active_id).encrypt(nonce, dek, _aad(context, "dek"))

    def unwrap(self, kek_id: str, wrapped: bytes, context: str) -> bytes:
        try:
            return self._local(kek_id).decrypt(wrapped[:NONCE_LEN], wrapped[NONCE_LEN:], _aad(context, "dek"))
        except InvalidTag as e:
            raise CryptoError("data key failed authentication (wrong key or tampered record)") from e

    def needs_rewrap(self, kek_id: str, wrapped: bytes) -> bool:
        return kek_id != self.active_id

    def rewrap_dek(self, kek_id: str, wrapped: bytes, context: str) -> tuple[str, bytes]:
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
