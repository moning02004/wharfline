"""Master key operations.

    python -m app.keys status       # which master key wraps each encrypted row
    python -m app.keys verify       # decrypt every row to prove the loaded keys work
    python -m app.keys rotate       # re-wrap every data key with the active master key
    python -m app.keys vault-setup  # enable Transit and create the derived key (needs an admin token)

Local key rotation: put a new key first in the key file, restart, run `rotate`,
check `status`, then remove the old key.
Vault: rotate the Transit key in Vault (`bao write -f transit/keys/wharfline/rotate`),
then run `rotate` to re-wrap onto the newest key version.
Moving from a local key file to Vault: set WHARFLINE_KMS=vault (keep the key
file), run `rotate`, check `status`, then the key file can be retired.
"""

import sys
from collections import Counter

from sqlalchemy import select

from . import crypto
from . import models as m
from .db import SessionLocal

ENCRYPTED = (m.EnvSet, m.EnvVersion, m.Key, m.Registry)


def encrypted_rows(db, model, lock: bool = False):
    q = select(model).where(model.kek_id.is_not(None))
    return db.scalars(q.with_for_update() if lock else q)


def _label(row) -> str:
    if row.kek_id.startswith(crypto.VAULT_PREFIX):
        return f"{row.kek_id} v{crypto.VaultTransit.version_of(row.wrapped_dek)}"
    return row.kek_id


def status() -> int:
    ring = crypto.keyring()
    with SessionLocal() as db:
        rows = [row for model in ENCRYPTED for row in encrypted_rows(db, model)]
        counts = Counter(_label(r) for r in rows)
        stale = sum(1 for r in rows if ring.needs_rewrap(r.kek_id, r.wrapped_dek))
    print(f"active key: {ring.active_id}" + (f" (latest version v{ring.vault.latest_version()})" if ring.vault else ""))
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
        db.commit()
    print(f"re-wrapped {moved} data keys with {ring.active_id}")
    return 0


def vault_setup(vault: crypto.VaultTransit | None = None) -> int:
    """Idempotent: enable the Transit engine and create a derived AES-256-GCM key."""
    vault = vault or crypto.VaultTransit.from_env()
    mounts = vault.call("GET", "sys/mounts")
    mounts = mounts.get("data", mounts)
    if f"{vault.mount}/" not in mounts:
        vault.call("POST", f"sys/mounts/{vault.mount}", {"type": "transit"})
    try:
        vault.call("GET", f"{vault.mount}/keys/{vault.key}")
    except crypto.CryptoError:
        vault.call("POST", f"{vault.mount}/keys/{vault.key}", {"type": "aes256-gcm96", "derived": True})
    info = vault.call("GET", f"{vault.mount}/keys/{vault.key}")["data"]
    if not info.get("derived"):
        raise crypto.CryptoError(f"Transit key {vault.key!r} exists but is not derived; create a new key with derived=true")
    print(f"Transit key {vault.mount}/{vault.key} ready (derived, latest v{info['latest_version']})")
    return 0


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    commands = {"status": status, "verify": verify, "rotate": rotate, "vault-setup": vault_setup}
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
