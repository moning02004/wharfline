import logging
import os
from contextlib import asynccontextmanager

from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .db import SessionLocal, engine
from .prestart import alembic_config
from .routers import admin, auth, deploy, envs, resources
from .runner import mark_interrupted

log = logging.getLogger("wharfline")


def check_schema() -> None:
    """Schema changes go through Alembic (`python -m app.prestart`), never on API start."""
    head = ScriptDirectory.from_config(alembic_config()).get_current_head()
    with engine.connect() as conn:
        current = MigrationContext.configure(conn).get_current_revision()
    if current != head:
        raise RuntimeError(f"database is at revision {current}, expected {head}. Run `alembic upgrade head` first.")


@asynccontextmanager
async def lifespan(_: FastAPI):
    check_schema()
    with SessionLocal() as db:
        mark_interrupted(db)
    yield


app = FastAPI(title="Wharfline API", version="0.3.0", lifespan=lifespan)

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


@app.get("/healthz")
def healthz():
    return {"ok": True}
