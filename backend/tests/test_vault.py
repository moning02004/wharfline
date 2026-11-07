"""Integration tests against a real Vault/OpenBao dev server.

    docker run -d --name bao -p 18200:8200 -e BAO_DEV_ROOT_TOKEN_ID=dev-root openbao/openbao:2.1.0
    WHARFLINE_TEST_VAULT_ADDR=http://localhost:18200 WHARFLINE_TEST_VAULT_TOKEN=dev-root pytest tests/test_vault.py
"""

import os
import uuid

import pytest

from app import crypto
from app.keys import vault_setup

ADDR = os.getenv("WHARFLINE_TEST_VAULT_ADDR")
TOKEN = os.getenv("WHARFLINE_TEST_VAULT_TOKEN", "dev-root")
pytestmark = pytest.mark.skipif(not ADDR, reason="set WHARFLINE_TEST_VAULT_ADDR to run Vault tests")


@pytest.fixture
def vault():
    v = crypto.VaultTransit(ADDR, TOKEN, key=f"t{uuid.uuid4().hex[:12]}")
    vault_setup(v)
    return v


def test_roundtrip_and_kek_never_leaves_vault(vault):
    ring = crypto.KeyRing(vault=vault)
    env = crypto.seal_json([["A", "1"]], "env_set:e1", ring)
    assert env.kek_id == vault.kek_id
    assert env.wrapped_dek.startswith(b"vault:v1:")
    assert crypto.open_json(env, "env_set:e1", ring) == [["A", "1"]]


def test_derivation_context_binds_record(vault):
    ring = crypto.KeyRing(vault=vault)
    env = crypto.seal_json(["x"], "env_set:e1", ring)
    with pytest.raises(crypto.CryptoError):
        crypto.open_json(env, "env_set:e2", ring)


def test_vault_key_rotation_rewraps(vault):
    ring = crypto.KeyRing(vault=vault)
    env = crypto.seal_json(["x"], "ctx", ring)
    vault.call("POST", f"{vault.mount}/keys/{vault.key}/rotate", {})
    vault._latest = None
    assert ring.needs_rewrap(env.kek_id, env.wrapped_dek)
    moved = crypto.rewrap(env, "ctx", ring)
    assert moved.wrapped_dek.startswith(b"vault:v2:") and moved.ciphertext == env.ciphertext
    assert crypto.open_json(moved, "ctx", ring) == ["x"]


def test_move_from_local_key_to_vault(vault):
    local = [("old", os.urandom(32))]
    env = crypto.seal_json(["x"], "ctx", crypto.KeyRing(local))
    both = crypto.KeyRing(local, vault)
    moved = crypto.rewrap(env, "ctx", both)
    assert moved.kek_id == vault.kek_id
    assert crypto.open_json(moved, "ctx", crypto.KeyRing(vault=vault)) == ["x"]  # local key no longer needed


def test_unreachable_vault_fails_closed():
    ring = crypto.KeyRing(vault=crypto.VaultTransit("http://127.0.0.1:1", "t", timeout=0.5))
    with pytest.raises(crypto.CryptoError, match="unreachable"):
        crypto.seal_json(["x"], "ctx", ring)


def test_move_back_from_vault_to_local_key(vault):
    env = crypto.seal_json(["x"], "ctx", crypto.KeyRing(vault=vault))
    local = [("new-local", os.urandom(32))]
    back = crypto.rewrap(env, "ctx", crypto.KeyRing(local, vault, vault_active=False))
    assert back.kek_id == "new-local"
    assert crypto.open_json(back, "ctx", crypto.KeyRing(local)) == ["x"]  # Vault no longer needed
