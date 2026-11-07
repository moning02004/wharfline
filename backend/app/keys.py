"""Master key operations.

    python -m app.keys status   # which master key each encrypted row uses
    python -m app.keys verify   # decrypt every row to prove the loaded keys work
    python -m app.keys rotate   # re-wrap every data key with the active (first) master key

Rotation: put a new key first in the key file, restart, run `rotate`, check
`status` shows only the new key, then remove the old key from the file.
"""

import sys
from collections import Counter

from sqlalchemy import select

from . import crypto
from . import models as m
from .db import SessionLocal

ENCRYPTED = (m.EnvSet, m.EnvVersion)


def status() -> int:
    ring = crypto.keyring()
    with SessionLocal() as db:
        counts = Counter(kid for model in ENCRYPTED for kid in db.scalars(select(model.kek_id)))
    print(f"active key: {ring.active_id}")
    print(f"loaded keys: {', '.join(ring.ids)}")
    for kid, n in sorted(counts.items()):
        flag = "" if kid in ring.ids else "  (NOT LOADED: these rows cannot be read)"
        print(f"  {kid}: {n} rows{flag}")
    stale = sum(n for kid, n in counts.items() if kid != ring.active_id)
    print("all rows use the active key" if not stale else f"{stale} rows still use an older key; run `rotate`")
    return 0


def verify() -> int:
    bad = 0
    with SessionLocal() as db:
        for model in ENCRYPTED:
            for row in db.scalars(select(model)):
                try:
                    row.get_vars()
                except crypto.CryptoError as e:
                    bad += 1
                    print(f"  {row.crypto_context()}: {e}")
    print("all encrypted rows decrypt" if not bad else f"{bad} rows failed")
    return 1 if bad else 0


def rotate() -> int:
    ring = crypto.keyring()
    moved = 0
    with SessionLocal() as db:
        for model in ENCRYPTED:
            for row in db.scalars(select(model).where(model.kek_id != ring.active_id).with_for_update()):
                row.envelope = crypto.rewrap(row.envelope, row.crypto_context(), ring)
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
