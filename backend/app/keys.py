"""Master key operations.

    python -m app.keys status       # which master key wraps each encrypted row
    python -m app.keys verify       # decrypt every row to prove the loaded keys work
    python -m app.keys rotate       # re-wrap every data key with the active master key

Key rotation: put a new key first in the key file, restart, run `rotate`,
check `status`, then remove the old key.
"""

import sys
from collections import Counter

from sqlalchemy import select

from . import crypto
from . import githooks
from . import models as m
from .db import SessionLocal

ENCRYPTED = (m.EnvSet, m.EnvVersion, m.Key, m.Registry, m.Member)


def encrypted_rows(db, model, lock: bool = False):
    q = select(model).where(model.kek_id.is_not(None))
    return db.scalars(q.with_for_update() if lock else q)


def _label(row) -> str:
    return row.kek_id


def status() -> int:
    ring = crypto.keyring()
    with SessionLocal() as db:
        rows = [row for model in ENCRYPTED for row in encrypted_rows(db, model)]
        counts = Counter(_label(r) for r in rows)
        stale = sum(1 for r in rows if ring.needs_rewrap(r.kek_id, r.wrapped_dek))
        hook = githooks.secret_envelope(db)
        if hook:
            counts[_label(hook)] += 1
            stale += ring.needs_rewrap(hook.kek_id, hook.wrapped_dek)
    print(f"active key: {ring.active_id}")
    print(f"loaded keys: {', '.join(ring.ids)}")
    for label, n in sorted(counts.items()):
        kid = label.split(" ")[0]
        flag = "" if kid in ring.ids else "  (NOT LOADED: these rows cannot be read)"
        print(f"  {label}: {n} rows{flag}")
    print("all rows use the active key" if not stale else f"{stale} rows still use an older key; run `rotate`")
    return 0


def verify() -> int:
    bad = 0
    with SessionLocal() as db:
        for model in ENCRYPTED:
            for row in encrypted_rows(db, model):
                try:
                    row.check_secret()
                except crypto.CryptoError as e:
                    bad += 1
                    print(f"  {row.crypto_context()}: {e}")
        try:
            githooks.load_secret(db)
        except crypto.CryptoError as e:
            bad += 1
            print(f"  {githooks.CONTEXT}: {e}")
    print("all encrypted rows decrypt" if not bad else f"{bad} rows failed")
    return 1 if bad else 0


def rotate() -> int:
    ring = crypto.keyring()
    moved = 0
    with SessionLocal() as db:
        for model in ENCRYPTED:
            for row in encrypted_rows(db, model, lock=True):
                if ring.needs_rewrap(row.kek_id, row.wrapped_dek):
                    row.envelope = crypto.rewrap(row.envelope, row.crypto_context(), ring)
                    moved += 1
        hook = githooks.secret_envelope(db)
        if hook and ring.needs_rewrap(hook.kek_id, hook.wrapped_dek):
            githooks.set_secret_envelope(db, crypto.rewrap(hook, githooks.CONTEXT, ring))
            moved += 1
        db.commit()
    print(f"re-wrapped {moved} data keys with {ring.active_id}")
    return 0


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    commands = {"status": status, "verify": verify, "rotate": rotate}
    if cmd not in commands:
        print(__doc__)
        return 2
    try:
        return commands[cmd]()
    except crypto.CryptoError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
