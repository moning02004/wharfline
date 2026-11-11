"""One-time setup of a new server, with the account and password it came with.

Logs in once with the password (never stored), then: creates the deploy user, adds the inventory's public
key, installs Docker and the rollout plugin and hands /srv to the deploy user. Safe to run again.

The host key is compared with the fingerprint the person confirmed before the password is sent. At the end
Wharfline logs in as the deploy user with the key, so a saved server is one that really works.

Tests set WHARFLINE_SSH_SIMULATE=1, so they don't need a reachable SSH server.
"""

from __future__ import annotations

import asyncio
import base64
import shlex

import asyncssh

from . import sshcheck
from .sshcheck import HOST_KEY_ALGS, TIMEOUT

SETUP_TIMEOUT = 600.0  # installing Docker on a slow server takes minutes
MARK = "@@wharfline-step "
MASK = "••••"
ROLLOUT_URL = "https://github.com/wowu/docker-rollout/releases/latest/download/docker-rollout"
ROLLOUT_PATH = "/usr/local/lib/docker/cli-plugins/docker-rollout"
VERIFY_STEP = "접속 확인"
SIMULATED_BAD_PASSWORD = "wrong-password"  # tests: the login that fails


def step_names(full_sudo: bool) -> list[str]:
    return ["배포 사용자", "공개 키", "Docker", "docker rollout", "서비스 폴더"] + (["sudo 권한"] if full_sudo else [])


def init_script(user: str, key_line: str, full_sudo: bool) -> str:
    """POSIX sh run as root on the server. Every step can run twice; each announces itself on a MARK line."""
    names = step_names(full_sudo)
    mark = lambda i: f"echo {shlex.quote(MARK + names[i])}"  # noqa: E731
    lines = [
        "set -eu",
        f"U={shlex.quote(user)}",
        f"KEY={shlex.quote(key_line)}",
        mark(0),
        'id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"',
        'H=$(getent passwd "$U" | cut -d: -f6)',
        mark(1),
        'mkdir -p "$H/.ssh"',
        'touch "$H/.ssh/authorized_keys"',
        'grep -qxF -- "$KEY" "$H/.ssh/authorized_keys" || printf \'%s\\n\' "$KEY" >> "$H/.ssh/authorized_keys"',
        'chown -R "$U:$U" "$H/.ssh"',
        'chmod 700 "$H/.ssh"',
        'chmod 600 "$H/.ssh/authorized_keys"',
        mark(2),
        "if ! command -v docker >/dev/null 2>&1; then",
        "  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }",
        "  curl -fsSL https://get.docker.com | sh",
        "fi",
        "docker compose version",
        'usermod -aG docker "$U"',
        mark(3),
        f"if [ ! -x {ROLLOUT_PATH} ]; then",
        f"  mkdir -p {ROLLOUT_PATH.rsplit('/', 1)[0]}",
        f"  if curl -fsSL {ROLLOUT_URL} -o {ROLLOUT_PATH}; then chmod 755 {ROLLOUT_PATH}; "
        f"else rm -f {ROLLOUT_PATH}; echo 'docker rollout을 받지 못했어요. 일반 배포에는 영향이 없어요.'; fi",
        "fi",
        mark(4),
        "mkdir -p /srv",
        'chown "$U:$U" /srv',
    ]
    if full_sudo:
        lines += [
            mark(5),
            'F="/etc/sudoers.d/wharfline-$U"',
            'printf \'%s ALL=(ALL) NOPASSWD:ALL\\n\' "$U" > "$F"',
            'chmod 440 "$F"',
            'visudo -cf "$F" || { rm -f "$F"; exit 1; }',
        ]
    return "\n".join(lines) + "\n"


def remote_command(script: str, as_root: bool) -> str:
    """The command that runs `script` as root.

    The script arrives inside the command, never on stdin: stdin carries only the sudo password, so a
    NOPASSWD account can't run the password as a command. The script's own stdin is /dev/null, so apt or
    the Docker installer can't swallow anything.
    """
    encoded = base64.b64encode(script.encode()).decode()
    inner = f'f=$(mktemp) && echo {encoded} | base64 -d > "$f" && sh "$f" </dev/null; r=$?; rm -f "$f"; exit $r'
    return f"sh -c {shlex.quote(inner)}" if as_root else f"sudo -S -p '' sh -c {shlex.quote(inner)}"


def read_output(output: str, code: int, names: list[str], password: str) -> dict:
    """Which steps finished, from the MARK lines, and the last lines to show when something failed."""
    reached: list[str] = []
    shown: list[str] = []
    for line in output.splitlines():
        if line.startswith(MARK):
            reached.append(line[len(MARK):])
        elif line.strip():
            shown.append(line.replace(password, MASK) if password else line)
    steps = []
    for name in names:
        if name not in reached:
            steps.append({"name": name, "status": "skip"})
        elif code != 0 and name == reached[-1]:
            steps.append({"name": name, "status": "fail"})
        else:
            steps.append({"name": name, "status": "ok"})
    return {"ok": code == 0, "reached": bool(reached), "steps": steps, "log": shown[-30:]}


def _failed(names: list[str], error: str, log: list[str] | None = None) -> dict:
    return {"ok": False, "steps": [{"name": n, "status": "skip"} for n in names], "log": log or [], "error": error}


async def init_server(ip: str, port: int, fingerprint: str, account: str, password: str,
                      user: str, key_line: str, private_key: str, full_sudo: bool) -> dict:
    """{ok, steps: [{name, status: ok | fail | skip}], log, error}. `error` says what to do when ok is false."""
    names = step_names(full_sudo)
    if sshcheck.simulated():
        if password == SIMULATED_BAD_PASSWORD:
            return _failed(names, f"{account} 계정으로 로그인하지 못했어요. 계정과 비밀번호를 확인해 주세요.")
        return {"ok": True, "steps": [{"name": n, "status": "ok"} for n in names + [VERIFY_STEP]], "log": [], "error": None}

    # Compare the host key first: the password goes only to the server the person confirmed.
    try:
        key = await asyncio.wait_for(asyncssh.get_server_host_key(ip, port, server_host_key_algs=HOST_KEY_ALGS), TIMEOUT)
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        return _failed(names, f"{ip}:{port}에 연결하지 못했어요. ({str(e) or type(e).__name__})")
    if key is None or key.get_fingerprint("sha256") != fingerprint:
        return _failed(names, "확인한 지문과 서버의 호스트 키가 달라요. 비밀번호를 보내지 않았어요. 지문을 다시 확인해 주세요.")

    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(ip, port, username=account, password=password, client_keys=None, known_hosts=([key], [], []),
                             agent_path=None, preferred_auth=("password", "keyboard-interactive"),
                             server_host_key_algs=HOST_KEY_ALGS, config=[]),
            TIMEOUT,
        )
    except asyncssh.PermissionDenied:
        return _failed(names, f"{account} 계정으로 로그인하지 못했어요. 계정과 비밀번호를 확인하고, 서버가 비밀번호 로그인을 받는지 확인해 주세요.")
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        return _failed(names, f"{ip}:{port}에 로그인하지 못했어요. ({str(e) or type(e).__name__})")

    async with conn:
        try:
            who = await asyncio.wait_for(conn.run("id -u; command -v sudo || true", check=False), TIMEOUT)
            facts = str(who.stdout or "").split()
            as_root = bool(facts) and facts[0] == "0"
            if not as_root and len(facts) < 2:
                return _failed(names, f"{account} 계정은 root가 아닌데 서버에 sudo가 없어요. root로 초기화해 주세요.")
            r = await conn.run(remote_command(init_script(user, key_line, full_sudo), as_root),
                               input=None if as_root else password + "\n", stderr=asyncssh.STDOUT, check=False, timeout=SETUP_TIMEOUT)
        except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
            return _failed(names, f"서버에서 설정하는 중에 끊겼어요. 다시 실행해도 괜찮아요. ({str(e) or type(e).__name__})")
    result = read_output(str(r.stdout or ""), r.exit_status if r.exit_status is not None else 1, names, password)
    if not result.pop("reached") and not result["ok"]:
        return _failed(names, f"{account} 계정으로 root 권한을 얻지 못했어요. sudo 비밀번호와 sudo 권한을 확인해 주세요.", result["log"])
    if not result["ok"]:
        return {**result, "error": "설정하는 중에 실패했어요. 아래 내용을 확인하고 다시 실행해 주세요."}

    check = await sshcheck.check(ip, port, user, private_key)
    if not check["login"] or check["fingerprint"] != fingerprint:
        return {**result, "ok": False, "steps": result["steps"] + [{"name": VERIFY_STEP, "status": "fail"}],
                "error": check.get("error") or f"{user} 사용자로 키 로그인을 확인하지 못했어요."}
    if check["docker"] != "docker":
        return {**result, "ok": False, "steps": result["steps"] + [{"name": VERIFY_STEP, "status": "fail"}],
                "error": f"{user} 사용자가 docker를 쓰지 못해요. docker 그룹을 확인해 주세요."}
    return {**result, "steps": result["steps"] + [{"name": VERIFY_STEP, "status": "ok"}], "error": None}
