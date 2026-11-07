"""Real SSH key handling: generate ED25519 pairs, import existing private keys, compute fingerprints."""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa


@dataclass(frozen=True)
class SshKey:
    private_openssh: str  # unencrypted OpenSSH PEM; only ever stored inside an envelope
    public_line: str  # "ssh-ed25519 AAAA... comment"
    fingerprint: str  # "SHA256:..." like `ssh-keygen -lf`
    type: str  # "ED25519", "RSA 4096", "ECDSA 256"


class SshKeyError(ValueError):
    pass


def _fingerprint(public_line: str) -> str:
    blob = base64.b64decode(public_line.split()[1])
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")


def _describe(key) -> str:
    if isinstance(key, ed25519.Ed25519PrivateKey):
        return "ED25519"
    if isinstance(key, rsa.RSAPrivateKey):
        if key.key_size < 3072:
            raise SshKeyError(f"RSA {key.key_size}비트 키는 약해요. 3072비트 이상이나 ED25519를 써 주세요.")
        return f"RSA {key.key_size}"
    if isinstance(key, ec.EllipticCurvePrivateKey):
        return f"ECDSA {key.curve.key_size}"
    raise SshKeyError("지원하지 않는 키 종류예요. ED25519, RSA, ECDSA만 쓸 수 있어요.")


def _build(key, comment: str) -> SshKey:
    kind = _describe(key)
    private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption()).decode()
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    public_line = f"{public} {comment}"
    return SshKey(private, public_line, _fingerprint(public_line), kind)


def generate(comment: str) -> SshKey:
    return _build(ed25519.Ed25519PrivateKey.generate(), comment)


def load_private(text: str, passphrase: str | None, comment: str) -> SshKey:
    """Accepts OpenSSH or PEM private keys. A passphrase-protected key is decrypted once and
    stored unencrypted inside the envelope, so deploys never need the passphrase again."""
    data = text.strip().encode() + b"\n"
    pw = passphrase.encode() if passphrase else None
    try:
        if b"OPENSSH PRIVATE KEY" in data:
            key = serialization.load_ssh_private_key(data, password=pw)
        else:
            key = serialization.load_pem_private_key(data, password=pw)
    except TypeError as e:
        raise SshKeyError("암호가 걸린 키예요. 키 암호를 입력해 주세요." if pw is None else "이 키에는 암호가 없어요. 키 암호 칸을 비워 주세요.") from e
    except ValueError as e:
        if pw is None and "password" in str(e).lower():
            raise SshKeyError("암호가 걸린 키예요. 키 암호를 입력해 주세요.") from e
        raise SshKeyError("비공개 키를 읽을 수 없어요. 키 암호가 맞는지, 전체를 붙여넣었는지 확인해 주세요.") from e
    return _build(key, comment)
