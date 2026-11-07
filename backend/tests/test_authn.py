"""TOTP against the RFC 6238 test vectors, and the small auth helpers."""

import pytest

from app import authn

# RFC 6238 Appendix B: 8-digit codes, seeds are ASCII "1234567890" repeated to the hash's block size.
SEEDS = {
    "sha1": b"12345678901234567890",
    "sha256": b"12345678901234567890123456789012",
    "sha512": b"1234567890123456789012345678901234567890123456789012345678901234",
}
VECTORS = [
    (59, "94287082", "46119246", "90693936"),
    (1111111109, "07081804", "68084774", "25091201"),
    (1111111111, "14050471", "67062674", "99943326"),
    (1234567890, "89005924", "91819424", "93441116"),
    (2000000000, "69279037", "90698825", "38618901"),
    (20000000000, "65353130", "77737706", "47863826"),
]


@pytest.mark.parametrize("t,sha1,sha256,sha512", VECTORS)
def test_totp_rfc6238_vectors(t, sha1, sha256, sha512):
    assert authn.totp(SEEDS["sha1"], t, digits=8, digest="sha1") == sha1
    assert authn.totp(SEEDS["sha256"], t, digits=8, digest="sha256") == sha256
    assert authn.totp(SEEDS["sha512"], t, digits=8, digest="sha512") == sha512


def test_rfc4226_hotp_vectors():
    expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]
    assert [authn.hotp(SEEDS["sha1"], i) for i in range(10)] == expected


def test_verify_accepts_one_step_of_drift_and_no_replays():
    secret = authn.new_totp_secret()
    key = authn.totp_key(secret)
    t = 1_700_000_000
    step = t // 30
    assert authn.verify_totp(secret, authn.totp(key, t), at=t) == step
    assert authn.verify_totp(secret, authn.totp(key, t - 30), at=t) == step - 1
    assert authn.verify_totp(secret, authn.totp(key, t + 30), at=t) == step + 1
    assert authn.verify_totp(secret, authn.totp(key, t - 60), at=t) is None
    assert authn.verify_totp(secret, authn.totp(key, t), at=t, after_step=step) is None
    assert authn.verify_totp(secret, "12345", at=t) is None
    assert authn.verify_totp(authn.spaced(secret), authn.totp(key, t), at=t) == step  # spaces as shown to people


def test_passwords_and_recovery_codes():
    h = authn.hash_password("correct horse battery", 4)
    assert authn.check_password("correct horse battery", h)
    assert not authn.check_password("wrong", h)
    assert not authn.check_password("anything", None)
    codes = authn.new_recovery_codes()
    hashes = [authn.hash_recovery(c) for c in codes[:3]]
    assert authn.match_recovery(codes[1].upper().replace("-", " "), hashes) == 1
    assert authn.match_recovery("123456", hashes) is None


def test_policy_strings():
    assert authn.session_limits({"session": "8시간 (활동 없으면 30분)"}) == (8 * 3600, 30 * 60)
    assert authn.session_limits({"session": "12시간 (활동 없으면 1시간)"}) == (12 * 3600, 3600)
    assert authn.lockout_rule({"lockout": "10회 실패 시 1시간 잠금"}) == (10, 3600)
    assert authn.lockout_rule({}) == (5, 15 * 60)


def test_describe_agent():
    ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
    assert authn.describe_agent(ua) == "Chrome 141 · macOS"
