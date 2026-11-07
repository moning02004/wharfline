import base64
import hashlib

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

from app import sshkeys


def test_generate_ed25519_matches_ssh_keygen_fingerprint_format():
    k = sshkeys.generate("deploy@wharfline")
    assert k.type == "ED25519"
    assert k.public_line.startswith("ssh-ed25519 ") and k.public_line.endswith(" deploy@wharfline")
    blob = base64.b64decode(k.public_line.split()[1])
    assert k.fingerprint == "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    assert "BEGIN OPENSSH PRIVATE KEY" in k.private_openssh


def test_import_passphrase_protected_key():
    key = ed25519.Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                            serialization.BestAvailableEncryption(b"pw")).decode()
    with pytest.raises(sshkeys.SshKeyError, match="암호"):
        sshkeys.load_private(pem, None, "c")
    with pytest.raises(sshkeys.SshKeyError):
        sshkeys.load_private(pem, "wrong", "c")
    k = sshkeys.load_private(pem, "pw", "c")
    assert "ENCRYPTED" not in k.private_openssh  # stored decrypted, inside the envelope


def test_weak_rsa_rejected():
    weak = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = weak.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    with pytest.raises(sshkeys.SshKeyError, match="약해요"):
        sshkeys.load_private(pem, None, "c")


def test_garbage_rejected():
    with pytest.raises(sshkeys.SshKeyError):
        sshkeys.load_private("-----BEGIN OPENSSH PRIVATE KEY-----\nnope\n-----END OPENSSH PRIVATE KEY-----", None, "c")
