"""Gitea integration: webhook secret, signature check, and build/package event handling.

Gitea sends (Settings → Webhooks → Gitea, "custom events"):
  - workflow_run  : a workflow run was requested / started / completed
  - workflow_job  : a job inside a run changed state (used for the current step)
  - package       : a package version was published (a container image tag was pushed)

Payloads follow the GitHub-compatible shapes. Parsing is tolerant: unknown
fields are ignored and missing ones fall back to safe defaults.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import crypto
from . import models as m
from . import store as s

log = logging.getLogger("wharfline.gitea")

SETTING = "gitea_webhook"
CONTEXT = "setting:gitea_webhook"
RELEASE_TAG = re.compile(r"^v\d")


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


def verify_signature(secret: str, body: bytes, headers: dict[str, str]) -> bool:
    """Gitea signs the raw body with HMAC-SHA256: X-Gitea-Signature (hex) or X-Hub-Signature-256 (sha256=hex)."""
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    given = headers.get("x-gitea-signature") or headers.get("x-hub-signature-256", "").removeprefix("sha256=")
    return bool(given) and hmac.compare_digest(expected, given.strip().lower())


# ---------- event handling ----------

def _status(raw: dict) -> str:
    status = str(raw.get("status") or "").lower()
    if status == "completed":
        conclusion = str(raw.get("conclusion") or "").lower()
        return {"success": "success", "failure": "failure", "cancelled": "cancelled", "skipped": "skipped"}.get(conclusion, "failure")
    if status in ("in_progress", "running"):
        return "in_progress"
    if status in ("success", "failure", "cancelled", "skipped"):  # some Gitea payloads report the final state directly
        return status
    return "queued"  # queued, waiting, requested, pending, blocked


def _repo(payload: dict) -> str:
    return str((payload.get("repository") or {}).get("full_name") or "").lower()


def _upsert_build(db: Session, repo: str, run_id: int) -> m.Build:
    b = db.scalar(select(m.Build).where(m.Build.repo == repo, m.Build.run_id == run_id))
    if not b:
        now = time.time()
        b = m.Build(repo=repo, run_id=run_id, status="queued", started_at=now, updated_at=now)
        db.add(b)
    return b


def handle_workflow_run(db: Session, payload: dict) -> m.Build | None:
    run, repo = payload.get("workflow_run") or {}, _repo(payload)
    if not repo or not run.get("id"):
        return None
    b = _upsert_build(db, repo, int(run["id"]))
    was_active = b.active
    b.run_number = run.get("run_number") or b.run_number
    b.workflow = str(run.get("name") or (payload.get("workflow") or {}).get("name") or b.workflow or "")[:255]
    b.title = str(run.get("display_title") or run.get("head_commit", {}).get("message", "") or b.title or "")[:512]
    b.branch = run.get("head_branch") or b.branch
    b.sha = run.get("head_sha") or b.sha
    b.url = run.get("html_url") or b.url
    b.status = _status(run)
    b.updated_at = time.time()
    if not b.active:
        b.step = None
    if b.active and not was_active:
        s.log_act(db, "이미지 빌드 시작", f"{repo} #{b.run_number or b.run_id} · {b.branch or '-'}")
    elif not b.active and was_active:
        s.log_act(db, "이미지 빌드 " + ("성공" if b.status == "success" else "종료"), f"{repo} #{b.run_number or b.run_id} · {b.status}",
                  "ok" if b.status == "success" else "bad" if b.status == "failure" else "warn")
    return b


def handle_workflow_job(db: Session, payload: dict) -> m.Build | None:
    job, repo = payload.get("workflow_job") or {}, _repo(payload)
    if not repo or not job.get("run_id"):
        return None
    b = _upsert_build(db, repo, int(job["run_id"]))
    st = _status(job)
    if st == "in_progress":
        steps = [x for x in job.get("steps") or [] if str(x.get("status")).lower() in ("in_progress", "running")]
        b.step = str(steps[0].get("name") if steps else job.get("name") or "")[:255] or None
        if not b.active:
            b.status = "in_progress"
    b.url = b.url or job.get("html_url")
    b.updated_at = time.time()
    return b


def images_for_package(db: Session, owner: str, name: str) -> list[m.Image]:
    """Container package owner/name → registered images on any registry host (ref ends with /owner/name)."""
    suffix = f"/{owner}/{name}".lower()
    return [i for i in db.scalars(select(m.Image)) if i.ref.lower().endswith(suffix)]


def handle_package(db: Session, payload: dict) -> list[tuple[m.Image, str]]:
    """Record a pushed tag. Returns (image, tag) pairs that are new release tags (candidates for auto-deploy)."""
    pkg = payload.get("package") or {}
    if str(payload.get("action")) != "created" or str(pkg.get("type", "container")) != "container":
        return []
    owner = str((pkg.get("owner") or {}).get("login") or "").lower()
    name, version = str(pkg.get("name") or "").lower(), str(pkg.get("version") or "")
    if not owner or not name or not version or version.startswith("sha256:"):  # digest-only pushes carry no tag
        return []
    released: list[tuple[m.Image, str]] = []
    for img in images_for_package(db, owner, name):
        if any(t.name == version for t in img.tags):
            continue
        img.tags.append(m.ImageTag(name=version, digest="", pushed="방금", pushed_at=time.time()))
        s.log_act(db, "새 이미지 태그", f"{img.ref}:{version}")
        if img.source_repo:
            recent = db.scalar(select(m.Build).where(m.Build.repo == img.source_repo, m.Build.tag.is_(None),
                                                     m.Build.updated_at > time.time() - 3600).order_by(m.Build.updated_at.desc()).limit(1))
            if recent:
                recent.tag = version
        if RELEASE_TAG.match(version):
            released.append((img, version))
    return released


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
    """The CI run that pushed this tag, if Gitea told us about it."""
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
    return f"빌드: {b.repo} #{b.run_number or b.run_id} · {ref} · {'성공' if b.status == 'success' else b.status} → {b.tag}"
