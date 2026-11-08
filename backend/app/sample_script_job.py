"""A sample SSH script job: deploying this project with docker compose.

Part of the sample data (seed). It shows the usual shape of a script job:
a compose file whose images use ${NAME_TAG} (tracked, pinned per run), a fixed
image (postgres, watched only), ordered script steps, and an env set for the
values the compose file reads.

    python -m app.sample_script_job   # add it to an existing database (skips if it exists)
"""

from __future__ import annotations

import time

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import bundles
from . import models as m
from . import store as s

NAME = "wharfline · staging"
ENV_NAME = "wharfline.staging"
SERVICE_PATH = "/srv/wharfline"
BUILD_REPO = "moning02004/wharfline"
BACKEND = "ghcr.io/moning02004/wharfline-backend"
FRONTEND = "ghcr.io/moning02004/wharfline-frontend"
TAGS = ["v2026.11.08-2", "v2026.11.08-1"]  # newest first

COMPOSE = """# Wharfline staging. Wharfline uploads this file to $SERVICE_PATH and passes the tags.
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: wharfline
      POSTGRES_USER: wharfline
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data

  backend:
    image: ghcr.io/moning02004/wharfline-backend:${BACKEND_TAG}
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgresql+psycopg://wharfline:${POSTGRES_PASSWORD}@db:5432/wharfline
    depends_on: [db]

  frontend:
    image: ghcr.io/moning02004/wharfline-frontend:${FRONTEND_TAG}
    restart: unless-stopped
    ports:
      - "8080:80"
    depends_on: [backend]

volumes:
  pgdata:
"""

SCRIPT = [
    {"name": "이미지 받기", "run": 'mkdir -p "$SERVICE_PATH"\ncd "$SERVICE_PATH"\ndocker compose pull'},
    {"name": "컨테이너 교체", "run": 'cd "$SERVICE_PATH"\ndocker compose up -d --remove-orphans'},
    {"name": "상태 확인", "run": "sleep 5\ncurl -fsS http://localhost:8080/api/healthz"},
    {"name": "정리", "run": "docker image prune -f"},
]

ENV = [
    ["POSTGRES_PASSWORD", "change-me-staging"],
    ["WHARFLINE_SEED_PASSWORD", "change-me-too"],
    ["WHARFLINE_COOKIE_SECURE", "1"],
]


def add_sample_script_job(db: Session, created_by: str | None = None) -> bool:
    """Add the sample job (and its env set and images) unless it is already there. Does not commit."""
    if db.scalar(select(m.Job).where(m.Job.name == NAME)):
        return False
    inv = db.scalar(select(m.Inventory).where(m.Inventory.name == "staging")) or db.scalar(select(m.Inventory).order_by(m.Inventory.ord))
    if not inv:
        return False

    for ref in (BACKEND, FRONTEND):
        img, _, _ = s.ensure_image(db, ref, "latest")
        for i, tag in enumerate(reversed(TAGS)):  # oldest first, so the newest ends up on top
            if tag not in {t.name for t in img.tags}:
                img.tags.insert(0, m.ImageTag(name=tag, digest="", pushed="샘플", pushed_at=time.time() + i))
        img.source_repo = img.source_repo or BUILD_REPO
    db.flush()

    if not db.scalar(select(m.EnvSet).where(m.EnvSet.name == ENV_NAME)):
        env = m.EnvSet(id=s.new_id("e"), name=ENV_NAME, ver=1, updated="샘플")
        env.set_vars(ENV)
        db.add(env)

    files = [{"path": "docker-compose.yaml", "content": COMPOSE}]
    extras = []
    for it in bundles.file_images(files):
        ref, _ = s.parse_image(it["ref"])
        s.ensure_image(db, ref, "latest")
        extras.append({"ref": ref, "var": it["var"] or "", "defaultTag": "latest", "literal": it["literal"],
                       "tagNow": TAGS[1] if it["var"] else "-"})

    job = m.Job(id=s.new_id("j"), name=NAME, image=None, default_tag="latest", repo=None, book=None,
                script=SCRIPT, service_path=SERVICE_PATH, files=files, extra_images=extras, files_ver=1,
                inventory=inv.name, targets=[], env=ENV_NAME, hook=True, hook_rule="v", protected=False,
                lock=True, rollback=True, created_by=created_by)
    db.add(job)
    db.flush()
    db.add(m.JobFileVersion(job_id=job.id, ver=1, files=files, changes={"added": ["docker-compose.yaml"], "changed": [], "removed": []},
                            created_at=time.time(), created_by="샘플"))
    return True


if __name__ == "__main__":
    from .db import SessionLocal

    with SessionLocal() as session:
        owner = session.scalar(select(m.Member).where(m.Member.role == "Owner").order_by(m.Member.ord))
        added = add_sample_script_job(session, owner.email if owner else None)
        session.commit()
    print("added the sample SSH script job" if added else "the sample job is already there (or there is no inventory)")
