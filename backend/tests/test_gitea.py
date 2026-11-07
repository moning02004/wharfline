import hashlib
import hmac

from app import gitea


def sign(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_signature_gitea_header():
    body = b'{"action":"completed"}'
    assert gitea.verify_signature("s3cret", body, {"x-gitea-signature": sign("s3cret", body)})


def test_signature_github_style_header():
    body = b"{}"
    assert gitea.verify_signature("s3cret", body, {"x-hub-signature-256": "sha256=" + sign("s3cret", body)})


def test_signature_rejects_wrong_secret_tampered_body_and_missing_header():
    body = b'{"a":1}'
    good = sign("s3cret", body)
    assert not gitea.verify_signature("other", body, {"x-gitea-signature": good})
    assert not gitea.verify_signature("s3cret", b'{"a":2}', {"x-gitea-signature": good})
    assert not gitea.verify_signature("s3cret", body, {})


def test_status_mapping():
    assert gitea._status({"status": "queued"}) == "queued"
    assert gitea._status({"status": "waiting"}) == "queued"
    assert gitea._status({"status": "in_progress"}) == "in_progress"
    assert gitea._status({"status": "running"}) == "in_progress"
    assert gitea._status({"status": "completed", "conclusion": "success"}) == "success"
    assert gitea._status({"status": "completed", "conclusion": "cancelled"}) == "cancelled"
    assert gitea._status({"status": "completed", "conclusion": "weird"}) == "failure"
    assert gitea._status({"status": "failure"}) == "failure"


def test_release_tag_pattern():
    assert gitea.RELEASE_TAG.match("v1.2.3")
    assert not gitea.RELEASE_TAG.match("sha-77d1e0b")
    assert not gitea.RELEASE_TAG.match("latest")
