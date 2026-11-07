"""Runs once before the API starts: wait for the DB, apply migrations, load sample data.

In docker compose this is the one-off `migrate` service; the API containers
only start after it exits successfully, so running several API replicas
never races on migrations. A Postgres advisory lock also makes concurrent
runs of this script safe (the second one waits, then finds nothing to do).

    python -m app.prestart            # migrate + seed an empty DB
    python -m app.prestart --no-seed  # migrate only
"""

import logging
import sys
import time
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text
from sqlalchemy.exc import OperationalError

from . import crypto
from .db import SessionLocal, engine
from .seed import seed_if_empty

log = logging.getLogger("wharfline.prestart")
ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"
LOCK_ID = 0x5768_6172  # arbitrary app-wide id for pg_advisory_lock ("Whar")


def wait_for_db(attempts: int = 30) -> None:
    for i in range(attempts):
        try:
            with engine.connect() as c:
                c.execute(text("select 1"))
            return
        except OperationalError:
            if i == attempts - 1:
                raise
            log.warning("database not ready, retrying (%d/%d)", i + 1, attempts)
            time.sleep(1)


def alembic_config() -> Config:
    cfg = Config(str(ALEMBIC_INI))
    cfg.attributes["configure_logger"] = False
    return cfg


def migrate() -> None:
    cfg = alembic_config()
    tables = set(inspect(engine).get_table_names())
    if "settings" in tables and "alembic_version" not in tables:
        # Database created by the earlier create_all() build: same schema as the
        # first migration, so mark it as applied instead of failing on existing tables.
        log.warning("existing schema without alembic_version found; stamping initial revision")
        command.stamp(cfg, "6141dc7290e4")
    command.upgrade(cfg, "head")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)-5.5s [%(name)s] %(message)s")
    try:
        ring = crypto.keyring()  # fail before touching the DB if no master key is available
    except crypto.CryptoError as e:
        log.error("%s", e)
        return 1
    log.info("master keys loaded: %s (active: %s)", ", ".join(ring.ids), ring.active_id)
    wait_for_db()
    with engine.connect() as lock_conn:
        lock_conn.execute(text("select pg_advisory_lock(:id)"), {"id": LOCK_ID})
        try:
            migrate()
            if "--no-seed" not in sys.argv:
                with SessionLocal() as db:
                    if seed_if_empty(db):
                        log.info("loaded sample data")
        finally:
            lock_conn.execute(text("select pg_advisory_unlock(:id)"), {"id": LOCK_ID})
    return 0


if __name__ == "__main__":
    sys.exit(main())
