import base64
import os

import pytest

from app import crypto


def ring(*ids: str) -> crypto.KeyRing:
    return crypto.KeyRing([(i, os.urandom(32)) for i in ids])


def test_roundtrip():
    r = ring("k1")
    env = crypto.seal_json([["A", "1"], ["B", "비밀"]], "env_set:e1", r)
    assert crypto.open_json(env, "env_set:e1", r) == [["A", "1"], ["B", "비밀"]]
    assert "비밀".encode() not in env.ciphertext  # no plaintext in the stored bytes


def test_each_record_gets_fresh_dek_and_nonce():
    r = ring("k1")
    a = crypto.seal_json(["same"], "ctx", r)
    b = crypto.seal_json(["same"], "ctx", r)
    assert a.ciphertext != b.ciphertext
    assert a.nonce != b.nonce
    assert a.wrapped_dek != b.wrapped_dek


def test_moving_ciphertext_to_another_row_fails():
    r = ring("k1")
    env = crypto.seal_json(["x"], "env_set:e1", r)
    with pytest.raises(crypto.CryptoError):
        crypto.open_json(env, "env_set:e2", r)


@pytest.mark.parametrize("field", ["ciphertext", "nonce", "wrapped_dek"])
def test_tampering_is_detected(field):
    r = ring("k1")
    env = crypto.seal_json(["x"], "ctx", r)
    raw = bytearray(getattr(env, field))
    raw[-1] ^= 0x01
    bad = crypto.Envelope(**{**env.__dict__, field: bytes(raw)})
    with pytest.raises(crypto.CryptoError):
        crypto.open_json(bad, "ctx", r)


def test_wrong_master_key_fails():
    env = crypto.seal_json(["x"], "ctx", ring("k1"))
    with pytest.raises(crypto.CryptoError):
        crypto.open_json(env, "ctx", ring("k1"))  # same id, different key bytes


def test_missing_master_key_is_a_clear_error():
    env = crypto.seal_json(["x"], "ctx", ring("old"))
    with pytest.raises(crypto.CryptoError, match="not loaded"):
        crypto.open_json(env, "ctx", ring("new"))


def test_rotation_rewraps_dek_without_touching_data():
    old_key, new_key = os.urandom(32), os.urandom(32)
    old = crypto.KeyRing([("old", old_key)])
    env = crypto.seal_json(["x"], "ctx", old)

    both = crypto.KeyRing([("new", new_key), ("old", old_key)])
    moved = crypto.rewrap(env, "ctx", both)
    assert moved.kek_id == "new"
    assert moved.ciphertext == env.ciphertext and moved.nonce == env.nonce
    assert crypto.open_json(moved, "ctx", crypto.KeyRing([("new", new_key)])) == ["x"]
    assert crypto.rewrap(moved, "ctx", both) is moved  # already on the active key


def test_parse_key_file():
    k1, k2 = base64.b64encode(os.urandom(32)).decode(), base64.b64encode(os.urandom(32)).decode()
    r = crypto.KeyRing.parse(f"# comment\nnew:{k1}\n\nold:{k2}\n")
    assert r.ids == ["new", "old"] and r.active_id == "new"
    assert crypto.KeyRing.parse(f"a:{k1},b:{k2}").ids == ["a", "b"]


@pytest.mark.parametrize("text, msg", [
    ("", "no master key"),
    ("k1", "<id>:<base64>"),
    ("k1:not-base64!!", "base64"),
    (f"k1:{base64.b64encode(b'short').decode()}", "32 bytes"),
    (f"bad id:{base64.b64encode(os.urandom(32)).decode()}", "invalid master key id"),
])
def test_bad_key_config_is_rejected(text, msg):
    with pytest.raises(crypto.CryptoError, match=msg):
        crypto.KeyRing.parse(text)


def test_duplicate_ids_rejected():
    k = base64.b64encode(os.urandom(32)).decode()
    with pytest.raises(crypto.CryptoError, match="duplicate"):
        crypto.KeyRing.parse(f"a:{k}\na:{k}")
