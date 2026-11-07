import logging
import os
from contextlib import asynccontextmanager

from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select, union

from . import crypto
from . import models as m
from .db import SessionLocal, engine
from .prestart import alembic_config
from .routers import admin, auth, deploy, envs, resources
from .runner import mark_interrupted

log = logging.getLogger("wharfline")


def check_schema() -> None:
    """Schema changes go through Alembic (the `migrate` service), never on API start."""
    head = ScriptDirectory.from_config(alembic_config()).get_current_head()
    with engine.connect() as conn:
        current = MigrationContext.configure(conn).get_current_revision()
    if current != head:
        raise RuntimeError(f"database is at revision {current}, expected {head}. Run `python -m app.prestart` first.")


def check_keys() -> None:
    """Refuse to start without a master key, or if stored data needs a key that is not loaded."""
    ring = crypto.keyring()
    with SessionLocal() as db:
        used = set(db.scalars(union(select(m.EnvSet.kek_id), select(m.EnvVersion.kek_id))))
    missing = used - set(ring.ids)
    if missing:
        raise RuntimeError(f"encrypted data uses master key(s) {sorted(missing)} that are not loaded")
    log.info("master keys ok (active: %s)", ring.active_id)


@asynccontextmanager
async def lifespan(_: FastAPI):
    check_schema()
    check_keys()
    with SessionLocal() as db:
        mark_interrupted(db)
    yield


app = FastAPI(title="Wharfline API", version="0.4.0", lifespan=lifespan)

origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth, deploy, resources, envs, admin):
    app.include_router(r.router)


@app.exception_handler(crypto.CryptoError)
async def crypto_error(request: Request, exc: crypto.CryptoError):
    # Tampered rows or missing keys: log the detail, tell the client nothing about why.
    log.error("decryption failed on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(status_code=500, content={"detail": "암호화된 데이터를 읽을 수 없어요. 관리자에게 알려 주세요."})


@app.get("/healthz")
def healthz():
    return {"ok": True}
