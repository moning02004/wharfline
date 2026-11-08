"""Connection check for a new server: read its host key, then log in with the stored key.

Run before a server is saved, so the person can compare the fingerprint with the one on the
server and know the key works. Nothing is changed on the server: the only command is a probe
for the login name and whether docker is there.

Tests set WHARFLINE_SSH_SIMULATE=1, so they don't need a reachable SSH server.
"""

from __future__ import annotations

import asyncio
import os

import asyncssh

TIMEOUT = 8.0
FAKE_FINGERPRINT = "SHA256:pX0c7Lq2vRz9Hn4Wb1Ke8YsT3mJ6fDaUgQ5iEoN"
# The host key the person checks with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`.
HOST_KEY_ALGS = ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256"]
TYPE_NAMES = {"ssh-ed25519": "ED25519", "ecdsa-sha2-nistp256": "ECDSA", "rsa-sha2-512": "RSA", "rsa-sha2-256": "RSA", "ssh-rsa": "RSA"}


def simulated() -> bool:
    return os.environ.get("WHARFLINE_SSH_SIMULATE") == "1"


def _describe(key: asyncssh.SSHKey) -> tuple[str, str]:
    alg = key.get_algorithm()
    return TYPE_NAMES.get(alg, alg), key.get_fingerprint("sha256")


async def host_key(ip: str, port: int) -> dict:
    """{reachable, type, fingerprint, error}: the server's host key, without logging in."""
    if simulated():
        return {"reachable": True, "type": "ED25519", "fingerprint": FAKE_FINGERPRINT, "error": None}
    try:
        key = await asyncio.wait_for(asyncssh.get_server_host_key(ip, port, server_host_key_algs=HOST_KEY_ALGS), TIMEOUT)
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        return {"reachable": False, "type": None, "fingerprint": None, "error": _unreachable(ip, port, e)}
    if key is None:
        return {"reachable": False, "type": None, "fingerprint": None, "error": f"{ip}:{port}가 호스트 키를 보내지 않았어요."}
    kind, fp = _describe(key)
    return {"reachable": True, "type": kind, "fingerprint": fp, "error": None}


async def check(ip: str, port: int, user: str, private_openssh: str) -> dict:
    """Host key, plus whether `user` can log in with the key.

    {reachable, type, fingerprint, login, loginUser, docker: "docker" | "noperm" | "none" | None, error}
    """
    hk = await host_key(ip, port)
    out = {**hk, "login": False, "loginUser": None, "docker": None}
    if not hk["reachable"]:
        return out
    if simulated():
        return {**out, "login": True, "loginUser": user, "docker": "docker"}
    try:
        client_key = asyncssh.import_private_key(private_openssh)
        conn = await asyncio.wait_for(
            asyncssh.connect(
                ip, port, username=user, client_keys=[client_key], known_hosts=None, agent_path=None,
                preferred_auth="publickey", server_host_key_algs=HOST_KEY_ALGS, config=[],
            ),
            TIMEOUT,
        )
    except asyncssh.PermissionDenied:
        return {**out, "error": f"{user} 사용자로 로그인하지 못했어요. authorized_keys에 넣은 줄과 사용자 이름을 확인해 주세요."}
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        return {**out, "error": _unreachable(ip, port, e)}
    async with conn:
        # The key that answered must be the one shown, or someone swapped in between.
        seen = conn.get_server_host_key()
        if seen is not None and _describe(seen)[1] != hk["fingerprint"]:
            return {**out, "error": "확인하는 사이에 호스트 키가 바뀌었어요. 다시 확인해 주세요."}
        try:
            # docker: usable by this user | noperm: installed, but the user can't reach it | none
            probe = "id -un; if docker ps -q >/dev/null 2>&1; then echo docker; elif command -v docker >/dev/null 2>&1; then echo noperm; else echo none; fi"
            r = await asyncio.wait_for(conn.run(probe, check=False), TIMEOUT)
            lines = str(r.stdout or "").split()
        except (asyncio.TimeoutError, asyncssh.Error):
            lines = []
    docker = lines[1] if len(lines) > 1 and lines[1] in ("docker", "noperm", "none") else None
    return {**out, "login": True, "loginUser": lines[0] if lines else user, "docker": docker}


def _unreachable(ip: str, port: int, e: BaseException) -> str:
    if isinstance(e, asyncio.TimeoutError):
        return f"{ip}:{port}에 {int(TIMEOUT)}초 안에 연결하지 못했어요. 주소, 포트, 방화벽을 확인해 주세요."
    if isinstance(e, ConnectionRefusedError):
        return f"{ip}:{port}가 연결을 거부했어요. SSH 서버가 켜져 있고 포트가 맞는지 확인해 주세요."
    if isinstance(e, OSError):
        return f"{ip}:{port}에 연결하지 못했어요. 주소를 확인해 주세요. ({e.strerror or e})"
    return f"SSH 연결 중 문제가 생겼어요: {e}"
