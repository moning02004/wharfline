"""Git integration: one webhook for Gitea (and Forgejo), GitHub and GitLab.

The sender is told apart by its headers, then each provider's payload is turned
into the same two things Wharfline cares about:

  - build progress : a CI run was queued / is running (and which step) / finished
  - pushed image tag : a new container image tag exists (candidate for auto-deploy)

What each provider sends (pick these events in the webhook settings):

  Gitea/Forgejo  X-Gitea-Event   workflow_run, workflow_job, package     HMAC-SHA256 body signature
  GitHub         X-GitHub-Event  workflow_run, workflow_job, registry_package (or package)
                                                                         HMAC-SHA256 (X-Hub-Signature-256)
  GitLab         X-Gitlab-Event  Pipeline Hook, Job Hook                 X-Gitlab-Token (the secret itself)

GitLab has no "container image pushed" event. A pipeline that succeeds on a Git
tag (image tag = Git tag) or on the default branch (image tag = 8-char short SHA)
counts as a push, which is what the repo's .gitlab-ci.yml does.

Parsing is tolerant: unknown fields are ignored and missing ones fall back to safe defaults.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import crypto
from . import models as m
from . import store as s

log = logging.getLogger("wharfline.githooks")

# The setting kept its first name: the stored secret is encrypted with this context, so renaming it would break decryption.
SETTING = "gitea_webhook"
CONTEXT = "setting:gitea_webhook"
RELEASE_TAG = re.compile(r"^v\d")
DATE_TAG = re.compile(r"^v?\d{4}\.\d{2}\.\d{2}-\d+$")
HOOK_RULES = {"v": "v로 시작", "date": "날짜 (v2026.11.08-1)", "any": "latest 빼고 전부"}


def tag_matches(rule: str, tag: str) -> bool:
    """Does a new tag trigger auto-deploy under a job's rule? (latest is never recorded, so never matches.)"""
    if rule == "any":
        return True
    if rule == "date":
        return bool(DATE_TAG.match(tag))
    if rule.startswith("re:"):
        try:
            return re.fullmatch(rule[3:], tag) is not None
        except re.error:
            return False
    return bool(RELEASE_TAG.match(tag))  # "v", the default
PROVIDERS = ("gitea", "github", "gitlab")
PROVIDER_NAMES = {"gitea": "Gitea", "github": "GitHub", "gitlab": "GitLab"}


# ---------- secret (envelope-encrypted inside the settings table) ----------

def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def secret_envelope(db: Session) -> crypto.Envelope | None:
    v = s.get_setting(db, SETTING)
    if not v.get("ciphertext"):
        return None
    return crypto.Envelope(v["kek_id"], base64.b64decode(v["wrapped_dek"]), base64.b64decode(v["nonce"]), base64.b64decode(v["ciphertext"]))


def set_secret_envelope(db: Session, env: crypto.Envelope) -> None:
    s.set_setting(db, SETTING, kek_id=env.kek_id, wrapped_dek=_b64(env.wrapped_dek), nonce=_b64(env.nonce),
                  ciphertext=_b64(env.ciphertext), created=time.time())


def new_secret(db: Session) -> str:
    value = secrets.token_urlsafe(32)
    set_secret_envelope(db, crypto.encrypt(value.encode(), CONTEXT))
    return value


def load_secret(db: Session) -> str | None:
    env = secret_envelope(db)
    return crypto.decrypt(env, CONTEXT).decode() if env else None


# ---------- who sent it, and is it really them ----------

def detect(headers: dict[str, str]) -> tuple[str, str] | None:
    """(provider, event) from lower-cased request headers, or None if no known provider sent it.

    Gitea also sends X-GitHub-Event for compatibility, so its own header is checked first.
    """
    if headers.get("x-gitea-event"):
        return "gitea", headers["x-gitea-event"]
    if headers.get("x-forgejo-event"):
        return "gitea", headers["x-forgejo-event"]
    if headers.get("x-gitlab-event"):
        return "gitlab", headers["x-gitlab-event"]
    if headers.get("x-github-event"):
        return "github", headers["x-github-event"]
    return None


def verify_signature(secret: str, body: bytes, headers: dict[str, str]) -> bool:
    """Gitea/GitHub sign the raw body with HMAC-SHA256: X-Gitea-Signature (hex) or X-Hub-Signature-256 (sha256=hex)."""
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    given = headers.get("x-gitea-signature") or headers.get("x-forgejo-signature") or headers.get("x-hub-signature-256", "").removeprefix("sha256=")
    return bool(given) and hmac.compare_digest(expected, given.strip().lower())


def verify(provider: str, secret: str, body: bytes, headers: dict[str, str]) -> bool:
    if provider == "gitlab":  # GitLab sends the secret token as-is instead of signing the body
        given = headers.get("x-gitlab-token", "")
        return bool(given) and hmac.compare_digest(secret.encode(), given.encode())
    return verify_signature(secret, body, headers)


# ---------- build progress ----------

def _status(raw: dict) -> str:
    """Gitea/GitHub run or job status → queued | in_progress | success | failure | cancelled | skipped."""
    status = str(raw.get("status") or "").lower()
    if status == "completed":
        conclusion = str(raw.get("conclusion") or "").lower()
        return {"success": "success", "failure": "failure", "cancelled": "cancelled", "skipped": "skipped"}.get(conclusion, "failure")
    if status in ("in_progress", "running"):
        return "in_progress"
    if status in ("success", "failure", "cancelled", "skipped"):  # some Gitea payloads report the final state directly
        return status
    return "queued"  # queued, waiting, requested, pending, blocked


def gitlab_status(status: str) -> str:
    """GitLab pipeline or job status → the same set."""
    status = status.lower()
    if status == "running":
        return "in_progress"
    if status == "success":
        return "success"
    if status == "failed":
        return "failure"
    if status in ("canceled", "canceling", "cancelled"):
        return "cancelled"
    if status == "skipped":
        return "skipped"
    return "queued"  # created, waiting_for_resource, preparing, pending, scheduled, manual


def _repo(payload: dict) -> str:
    return str((payload.get("repository") or {}).get("full_name") or "").lower()


def _gitlab_repo(payload: dict) -> str:
    """group/project (subgroups allowed). Old job payloads only carry the repository home page."""
    path = (payload.get("project") or {}).get("path_with_namespace")
    if not path:
        path = urlparse(str((payload.get("repository") or {}).get("homepage") or "")).path.strip("/")
    return str(path or "").lower()


def _upsert_build(db: Session, provider: str, repo: str, run_id: int) -> m.Build:
    b = db.scalar(select(m.Build).where(m.Build.repo == repo, m.Build.run_id == run_id))
    if not b:
        now = time.time()
        b = m.Build(provider=provider, repo=repo, run_id=run_id, status="queued", started_at=now, updated_at=now)
        db.add(b)
    return b


@dataclass
class RunInfo:
    """A CI run as every provider describes it."""

    provider: str
    repo: str
    run_id: int
    status: str
    run_number: int | None = None
    workflow: str = ""
    title: str = ""
    branch: str | None = None
    sha: str | None = None
    url: str | None = None
    step: str | None = None


def apply_run(db: Session, info: RunInfo) -> m.Build:
    """Store a run's new state and log when it starts or ends."""
    b = _upsert_build(db, info.provider, info.repo, info.run_id)
    was_active = b.active
    b.run_number = info.run_number or b.run_number
    b.workflow = (info.workflow or b.workflow or "")[:255]
    b.title = (info.title or b.title or "")[:512]
    b.branch = info.branch or b.branch
    b.sha = info.sha or b.sha
    b.url = info.url or b.url
    b.status = info.status
    b.updated_at = time.time()
    if not b.active:
        b.step = None
    elif info.step:
        b.step = info.step[:255]
    label = f"{info.repo} #{b.run_number or b.run_id}"
    if b.active and not was_active:
        s.log_act(db, "이미지 빌드 시작", f"{label} · {b.branch or '-'}")
    elif not b.active and was_active:
        s.log_act(db, "이미지 빌드 " + ("성공" if b.status == "success" else "종료"), f"{label} · {b.status}",
                  "ok" if b.status == "success" else "bad" if b.status == "failure" else "warn")
    return b


def _set_step(db: Session, provider: str, repo: str, run_id: int, step: str | None, url: str | None = None) -> m.Build:
    """A job inside the run started: remember its name as the current step."""
    b = _upsert_build(db, provider, repo, run_id)
    if step:
        b.step = step[:255]
    # A running job means the run is building, even if the run's own "in progress" event hasn't come yet.
    if b.status == "queued" or not b.active:
        b.status = "in_progress"
    b.url = b.url or url
    b.updated_at = time.time()
    return b


def handle_workflow_run(db: Session, payload: dict, provider: str = "gitea") -> m.Build | None:
    run, repo = payload.get("workflow_run") or {}, _repo(payload)
    if not repo or not run.get("id"):
        return None
    return apply_run(db, RunInfo(
        provider=provider, repo=repo, run_id=int(run["id"]), status=_status(run), run_number=run.get("run_number"),
        workflow=str(run.get("name") or (payload.get("workflow") or {}).get("name") or ""),
        title=str(run.get("display_title") or (run.get("head_commit") or {}).get("message") or ""),
        branch=run.get("head_branch"), sha=run.get("head_sha"), url=run.get("html_url"),
    ))


def handle_workflow_job(db: Session, payload: dict, provider: str = "gitea") -> m.Build | None:
    job, repo = payload.get("workflow_job") or {}, _repo(payload)
    if not repo or not job.get("run_id"):
        return None
    if _status(job) != "in_progress":
        return db.scalar(select(m.Build).where(m.Build.repo == repo, m.Build.run_id == int(job["run_id"])))
    steps = [x for x in job.get("steps") or [] if str(x.get("status")).lower() in ("in_progress", "running")]
    return _set_step(db, provider, repo, int(job["run_id"]), str(steps[0].get("name") if steps else job.get("name") or "") or None, job.get("html_url"))


def handle_gitlab_pipeline(db: Session, payload: dict) -> tuple[m.Build | None, list[tuple[m.Image, str]]]:
    """Pipeline Hook. When it succeeds on a tag or the default branch, the image tag it pushed is recorded too."""
    attrs, repo = payload.get("object_attributes") or {}, _gitlab_repo(payload)
    if not repo or not attrs.get("id"):
        return None, []
    project, commit = payload.get("project") or {}, payload.get("commit") or {}
    running = [j for j in payload.get("builds") or [] if str(j.get("status")).lower() == "running"]
    web = str(project.get("web_url") or "").rstrip("/")
    b = apply_run(db, RunInfo(
        provider="gitlab", repo=repo, run_id=int(attrs["id"]), status=gitlab_status(str(attrs.get("status") or "")),
        run_number=attrs.get("iid"), workflow=str(attrs.get("name") or "pipeline"),
        title=str(commit.get("title") or str(commit.get("message") or "").split("\n")[0]),
        branch=attrs.get("ref"), sha=attrs.get("sha"),
        url=attrs.get("url") or (f"{web}/-/pipelines/{attrs['id']}" if web else None),
        step=str(running[0].get("name")) if running else None,
    ))
    if b.status != "success" or not attrs.get("ref"):
        return b, []
    if attrs.get("tag"):
        tag = str(attrs["ref"])
    elif attrs["ref"] == project.get("default_branch") and attrs.get("sha"):
        tag = str(attrs["sha"])[:8]  # CI_COMMIT_SHORT_SHA
    else:
        return b, []  # other branches only check that the image builds
    images = {i.ref: i for i in [*db.scalars(select(m.Image).where(m.Image.source_repo == repo)), *images_for_path(db, repo)]}
    return b, record_tag(db, list(images.values()), tag)


def handle_gitlab_job(db: Session, payload: dict) -> m.Build | None:
    """Job Hook: only used to show which job is running now."""
    repo = _gitlab_repo(payload)
    if not repo or not payload.get("pipeline_id") or gitlab_status(str(payload.get("build_status") or "")) != "in_progress":
        return None
    return _set_step(db, "gitlab", repo, int(payload["pipeline_id"]), str(payload.get("build_name") or "") or None)


# ---------- pushed image tags ----------

def images_for_path(db: Session, path: str) -> list[m.Image]:
    """Registered images whose ref ends with /<path> on any registry host (owner/name, or group/sub/name on GitLab)."""
    suffix = f"/{path}".lower()
    return [i for i in db.scalars(select(m.Image)) if i.ref.lower().endswith(suffix)]


def images_for_package(db: Session, owner: str, name: str) -> list[m.Image]:
    return images_for_path(db, f"{owner}/{name}")


def record_tag(db: Session, images: list[m.Image], tag: str) -> list[tuple[m.Image, str]]:
    """Add a pushed tag to each image. Returns (image, tag) pairs that are new release tags (candidates for auto-deploy)."""
    released: list[tuple[m.Image, str]] = []
    if tag == "latest":  # a moving pointer, not a version: the newest known tag already plays this role
        return released
    for img in images:
        if any(t.name == tag for t in img.tags):
            continue
        img.tags.append(m.ImageTag(name=tag, digest="", pushed="방금", pushed_at=time.time()))
        s.log_act(db, "새 이미지 태그", f"{img.ref}:{tag}")
        if img.source_repo:
            recent = db.scalar(select(m.Build).where(m.Build.repo == img.source_repo, m.Build.tag.is_(None),
                                                     m.Build.updated_at > time.time() - 3600).order_by(m.Build.updated_at.desc()).limit(1))
            if recent:
                recent.tag = tag
        released.append((img, tag))  # each job's auto-deploy rule decides which of these deploy
    return released


def package_push(payload: dict) -> tuple[str, str, str] | None:
    """(owner, name, tag) of a pushed container image, from Gitea's `package` or GitHub's `registry_package`/`package` event."""
    pkg = payload.get("package") or payload.get("registry_package") or {}
    if str(payload.get("action")) not in ("created", "published"):
        return None
    if str(pkg.get("type") or pkg.get("package_type") or "container").lower() != "container":
        return None
    owner = str((pkg.get("owner") or {}).get("login") or "").lower()
    version = pkg.get("package_version") or {}
    tag = ((version.get("container_metadata") or {}).get("tag") or {}).get("name")  # GitHub: the tag, version is a digest
    tag = str(tag or (pkg.get("version") if isinstance(pkg.get("version"), str) else "") or version.get("version") or "")
    name = str(pkg.get("name") or "").lower()
    if not owner or not name or not tag or tag.startswith("sha256:"):  # digest-only pushes carry no tag
        return None
    return owner, name, tag


def handle_package(db: Session, payload: dict) -> list[tuple[m.Image, str]]:
    pushed = package_push(payload)
    if not pushed:
        return []
    owner, name, tag = pushed
    return record_tag(db, images_for_package(db, owner, name), tag)


# ---------- reading builds ----------

def build_for_image(db: Session, image_ref: str, scope: set[str] | None = None) -> dict[str, Any] | None:
    """The build worth showing next to a job: running now, succeeded in the last 15 minutes, or failed in the last day.

    `scope` limits which build repos may be shown (None = all).
    """
    img = db.get(m.Image, image_ref)
    if not img or not img.source_repo or not s.repo_allowed(scope, img.source_repo):
        return None
    b = db.scalar(select(m.Build).where(m.Build.repo == img.source_repo).order_by(m.Build.updated_at.desc()).limit(1))
    if not b:
        return None
    age = time.time() - b.updated_at
    if b.active or (b.status == "success" and age < 900) or (b.status == "failure" and age < 86400):
        return b.to_dict()
    return None


def builds_for_image(db: Session, image_ref: str, limit: int = 5, scope: set[str] | None = None) -> list[dict[str, Any]]:
    img = db.get(m.Image, image_ref)
    if not img or not img.source_repo or not s.repo_allowed(scope, img.source_repo):
        return []
    return [b.to_dict() for b in db.scalars(select(m.Build).where(m.Build.repo == img.source_repo).order_by(m.Build.updated_at.desc()).limit(limit))]


def build_for_tag(db: Session, image_ref: str, tag: str, scope: set[str] | None = None) -> m.Build | None:
    """The CI run that pushed this tag, if the Git host told us about it."""
    img = db.get(m.Image, image_ref)
    if not img or not img.source_repo or not s.repo_allowed(scope, img.source_repo):
        return None
    return db.scalar(select(m.Build).where(m.Build.repo == img.source_repo, m.Build.tag == tag).order_by(m.Build.updated_at.desc()).limit(1))


def build_repos(db: Session) -> list[str]:
    """Every build repo Wharfline knows about: linked to an image, or seen in a build event."""
    linked = db.scalars(select(m.Image.source_repo).where(m.Image.source_repo.is_not(None)))
    seen = db.scalars(select(m.Build.repo).distinct())
    return sorted({*linked, *seen})


def build_line(b: m.Build) -> str:
    ref = f"{b.branch or '-'}@{(b.sha or '')[:7]}" if b.sha else (b.branch or "-")
    host = PROVIDER_NAMES.get(b.provider, b.provider)
    return f"빌드({host}): {b.repo} #{b.run_number or b.run_id} · {ref} · {'성공' if b.status == 'success' else b.status} → {b.tag}"
