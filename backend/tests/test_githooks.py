import hashlib
import hmac

from app import githooks


def sign(secret: str, body: bytes) -> str:
    return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_signature_gitea_header():
    body = b'{"a":1}'
    assert githooks.verify_signature("s3cret", body, {"x-gitea-signature": sign("s3cret", body)})


def test_signature_github_header():
    body = b'{"a":1}'
    assert githooks.verify_signature("s3cret", body, {"x-hub-signature-256": "sha256=" + sign("s3cret", body)})


def test_signature_rejects_wrong_secret_or_body():
    body = b'{"a":1}'
    good = sign("s3cret", body)
    assert not githooks.verify_signature("other", body, {"x-gitea-signature": good})
    assert not githooks.verify_signature("s3cret", b'{"a":2}', {"x-gitea-signature": good})
    assert not githooks.verify_signature("s3cret", body, {})


def test_gitlab_token():
    assert githooks.verify("gitlab", "s3cret", b"{}", {"x-gitlab-token": "s3cret"})
    assert not githooks.verify("gitlab", "s3cret", b"{}", {"x-gitlab-token": "nope"})
    assert not githooks.verify("gitlab", "s3cret", b"{}", {})
    # a GitLab request can't pass with a body signature, and a signed request can't pass as GitLab
    assert not githooks.verify("gitlab", "s3cret", b"{}", {"x-hub-signature-256": "sha256=" + sign("s3cret", b"{}")})


def test_detect_provider():
    # Gitea also sends X-GitHub-Event, so its own header wins
    assert githooks.detect({"x-gitea-event": "workflow_run", "x-github-event": "workflow_run"}) == ("gitea", "workflow_run")
    assert githooks.detect({"x-forgejo-event": "package"}) == ("gitea", "package")
    assert githooks.detect({"x-github-event": "registry_package"}) == ("github", "registry_package")
    assert githooks.detect({"x-gitlab-event": "Pipeline Hook"}) == ("gitlab", "Pipeline Hook")
    assert githooks.detect({}) is None


def test_status_mapping():
    assert githooks._status({"status": "queued"}) == "queued"
    assert githooks._status({"status": "waiting"}) == "queued"
    assert githooks._status({"status": "in_progress"}) == "in_progress"
    assert githooks._status({"status": "running"}) == "in_progress"
    assert githooks._status({"status": "completed", "conclusion": "success"}) == "success"
    assert githooks._status({"status": "completed", "conclusion": "cancelled"}) == "cancelled"
    assert githooks._status({"status": "completed", "conclusion": "weird"}) == "failure"
    assert githooks._status({"status": "failure"}) == "failure"


def test_gitlab_status_mapping():
    assert githooks.gitlab_status("pending") == "queued"
    assert githooks.gitlab_status("created") == "queued"
    assert githooks.gitlab_status("running") == "in_progress"
    assert githooks.gitlab_status("success") == "success"
    assert githooks.gitlab_status("failed") == "failure"
    assert githooks.gitlab_status("canceled") == "cancelled"
    assert githooks.gitlab_status("skipped") == "skipped"


def test_package_push_gitea():
    p = {"action": "created", "package": {"type": "container", "name": "Batch-Worker", "version": "v1.0.0", "owner": {"login": "Acme"}}}
    assert githooks.package_push(p) == ("acme", "batch-worker", "v1.0.0")
    assert githooks.package_push({**p, "action": "deleted"}) is None
    assert githooks.package_push({"action": "created", "package": {**p["package"], "version": "sha256:abc"}}) is None
    assert githooks.package_push({"action": "created", "package": {**p["package"], "type": "npm"}}) is None


def test_package_push_github():
    pkg = {"name": "api-server", "package_type": "CONTAINER", "owner": {"login": "acme"},
           "package_version": {"version": "sha256:abc", "container_metadata": {"tag": {"name": "v2.0.0"}}}}
    assert githooks.package_push({"action": "published", "registry_package": pkg}) == ("acme", "api-server", "v2.0.0")
    untagged = {**pkg, "package_version": {"version": "sha256:abc", "container_metadata": {"tag": {"name": ""}}}}
    assert githooks.package_push({"action": "published", "registry_package": untagged}) is None


def test_release_tags():
    assert githooks.RELEASE_TAG.match("v1.2.3")
    assert not githooks.RELEASE_TAG.match("sha-77d1e0b")
    assert not githooks.RELEASE_TAG.match("latest")
