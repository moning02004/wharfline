"""Limit where a stolen Wharfline key can be used from (docs/security-hardening.md, C).

The addresses Wharfline connects from are kept in the `ssh_from` setting. The public-key view turns
them into an authorized_keys line with `from="…"` and the forwarding options switched off, so a copy
of the private key is useless anywhere else.
"""

from __future__ import annotations

import ipaddress

from sqlalchemy.orm import Session

from . import store as s

SETTING = "ssh_from"
MAX_ADDRESSES = 32
RESTRICTIONS = "no-agent-forwarding,no-port-forwarding,no-X11-forwarding"


class AddressError(ValueError):
    pass


def normalize(items: list[str]) -> list[str]:
    """Check each IP or CIDR with `ipaddress` and return them in canonical form, without duplicates."""
    out: list[str] = []
    for raw in items:
        text = raw.strip()
        if not text:
            continue
        try:
            addr = str(ipaddress.ip_network(text, strict=True)) if "/" in text else str(ipaddress.ip_address(text))
        except ValueError as e:
            raise AddressError(f"주소를 확인해 주세요: {text} (예: 203.0.113.10, 10.0.0.0/24)") from e
        if addr not in out:
            out.append(addr)
    if len(out) > MAX_ADDRESSES:
        raise AddressError(f"주소는 {MAX_ADDRESSES}개까지 넣을 수 있어요.")
    return out


def get_addresses(db: Session) -> list[str]:
    return list(s.get_setting(db, SETTING).get("addresses") or [])


def set_addresses(db: Session, addresses: list[str]) -> list[str]:
    s.set_setting(db, SETTING, addresses=addresses)
    return addresses


def authorized_keys_line(public_line: str, addresses: list[str]) -> str:
    """`from="a,b",no-agent-forwarding,… ssh-ed25519 AAAA… comment`, or the plain line when no address is set."""
    if not addresses:
        return public_line
    return f'from="{",".join(addresses)}",{RESTRICTIONS} {public_line}'
