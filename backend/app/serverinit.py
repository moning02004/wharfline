"""One-time setup of a server so it deploys through a Wharfline agent.

New server (`init_server`): log in once with the account and password it came with (never stored), then as root:
create the run accounts, install Docker and docker rollout, prepare the allowed folders, optionally give the
first account password-less sudo (for playbooks with become: true), and start the agent with a one-time
enrollment token. Wharfline keeps no SSH key: once the agent has enrolled, the server only needs outbound HTTPS.

Existing SSH server (`convert_server`): log in one last time with the inventory's key as the deploy account
(it is in the docker group) and start the agent the same way. After that the SSH key can be removed.

The host key is compared with the fingerprint the person confirmed before the password is sent. The token goes
to the server on stdin (after the sudo password), never in a command line or the agent's environment.

Tests set WHARFLINE_SSH_SIMULATE=1, so they don't need a reachable SSH server.
"""

from __future__ import annotations

import asyncio
import base64
import shlex
from collections.abc import Awaitable, Callable

import asyncssh

from . import agentinstall, sshcheck
from .sshcheck import HOST_KEY_ALGS, TIMEOUT

SETUP_TIMEOUT = 900.0  # installing Docker and pulling the agent image on a slow server takes minutes
ENROLL_WAIT = 90.0
MARK = "@@wharfline-step "
MASK = "••••"
ROLLOUT_URL = agentinstall.ROLLOUT_URL
ROLLOUT_PATH = agentinstall.ROLLOUT_PATH
VERIFY_STEP = "에이전트 연결"
SIMULATED_BAD_PASSWORD = "wrong-password"  # tests: the login that fails


def step_names(full_sudo: bool) -> list[str]:
    return ["실행 계정", "Docker", "docker rollout", "서비스 폴더"] + (["sudo 권한"] if full_sudo else []) + ["에이전트"]


def convert_step_names() -> list[str]:
    return ["에이전트"]


def _mark(names: list[str], i: int) -> str:
    return f"echo {shlex.quote(MARK + names[i])}"


def _head() -> list[str]:
    # The token is the first line on stdin; after that nothing the script starts may read stdin.
    return ["set -eu", "IFS= read -r TOKEN", "exec </dev/null"]


def init_script(users: str, paths: str, full_sudo: bool, url: str, image: str) -> str:
    """POSIX sh run as root on the server. Every step can run twice; each announces itself on a MARK line."""
    names = step_names(full_sudo)
    user_list = users.split(",")
    first = user_list[0]
    q = shlex.quote
    lines = _head() + [
        f"USERS={q(' '.join(user_list))}",
        f"FIRST={q(first)}",
        _mark(names, 0),
        'for U in $USERS; do id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"; done',
        _mark(names, 1),
        "if ! command -v docker >/dev/null 2>&1; then",
        "  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }",
        "  curl -fsSL https://get.docker.com | sh",
        "fi",
        "docker compose version",
        'for U in $USERS; do usermod -aG docker "$U"; done',
        _mark(names, 2),
        f"if [ ! -x {ROLLOUT_PATH} ]; then",
        f"  mkdir -p {ROLLOUT_PATH.rsplit('/', 1)[0]}",
        f"  if curl -fsSL {ROLLOUT_URL} -o {ROLLOUT_PATH}; then chmod 755 {ROLLOUT_PATH}; "
        f"else rm -f {ROLLOUT_PATH}; echo 'docker rollout을 받지 못했어요. 일반 배포에는 영향이 없어요.'; fi",
        "fi",
        _mark(names, 3),
        f"USERS_CSV={q(users)}",
        f"for P in {' '.join(q(p) for p in paths.split(','))}; do",
        *[line.replace('$USERS"', '$USERS_CSV"') for line in agentinstall.OWNER_LINES],
        '  if [ ! -e "$P" ]; then mkdir -p "$P" && chown "$O:$O" "$P"; '
        'elif [ "$P" = /srv ] && [ "$(stat -c %U /srv)" = root ]; then chown "$O:$O" /srv; fi',
        "done",
    ]
    i = 4
    if full_sudo:
        lines += [
            _mark(names, i),
            'F="/etc/sudoers.d/wharfline-$FIRST"',
            'printf \'%s ALL=(ALL) NOPASSWD:ALL\\n\' "$FIRST" > "$F"',
            'chmod 440 "$F"',
            'visudo -cf "$F" || { rm -f "$F"; exit 1; }',
        ]
        i += 1
    lines += [_mark(names, i), *agentinstall.run_lines(url, image, users, paths)]
    return "\n".join(lines) + "\n"


def convert_script(users: str, paths: str, url: str, image: str) -> str:
    """Run as the deploy account (docker group, no root needed) on a server that deploys over SSH today."""
    names = convert_step_names()
    lines = _head() + ["docker info >/dev/null 2>&1 || { echo 'docker를 쓸 수 없어요 (docker 그룹을 확인해 주세요)'; exit 1; }",
                       _mark(names, 0), *agentinstall.run_lines(url, image, users, paths)]
    return "\n".join(lines) + "\n"


def remote_command(script: str, as_root: bool) -> str:
    """The command that runs `script` (as root unless `as_root` is None: then as the login account).

    The script arrives inside the command, never on stdin: stdin carries the sudo password (consumed by sudo)
    and then the enrollment token, which the script reads first and then closes stdin."""
    encoded = base64.b64encode(script.encode()).decode()
    inner = f'f=$(mktemp) && echo {encoded} | base64 -d > "$f" && sh "$f"; r=$?; rm -f "$f"; exit $r'
    return f"sh -c {shlex.quote(inner)}" if as_root else f"sudo -S -p '' sh -c {shlex.quote(inner)}"


def read_output(output: str, code: int, names: list[str], secrets: list[str]) -> dict:
    """Which steps finished, from the MARK lines, and the last lines to show when something failed."""
    reached: list[str] = []
    shown: list[str] = []
    for line in output.splitlines():
        if line.startswith(MARK):
            reached.append(line[len(MARK):])
        elif line.strip():
            for x in secrets:
                if x:
                    line = line.replace(x, MASK)
            shown.append(line)
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


async def _pinned_key(ip: str, port: int, fingerprint: str, names: list[str]) -> tuple[asyncssh.SSHKey | None, dict | None]:
    try:
        key = await asyncio.wait_for(asyncssh.get_server_host_key(ip, port, server_host_key_algs=HOST_KEY_ALGS), TIMEOUT)
    except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
        return None, _failed(names, f"{ip}:{port}에 연결하지 못했어요. ({str(e) or type(e).__name__})")
    if key is None or key.get_fingerprint("sha256") != fingerprint:
        return None, _failed(names, "확인한 지문과 서버의 호스트 키가 달라요. 비밀번호와 토큰을 보내지 않았어요. 지문을 다시 확인해 주세요.")
    return key, None


async def _agent_logs(conn: asyncssh.SSHClientConnection, as_root: bool | None, password: str) -> list[str]:
    cmd = "docker logs --tail 15 wharfline-agent 2>&1"
    if as_root is False:
        cmd = f"sudo -S -p '' sh -c {shlex.quote(cmd)}"
    try:
        r = await conn.run(cmd, input=(password + "\n") if as_root is False else None, check=False, timeout=30)
        return [x for x in str(r.stdout or "").splitlines() if x.strip()][-15:]
    except (OSError, asyncio.TimeoutError, asyncssh.Error):
        return []


EnrollWait = Callable[[float], Awaitable[bool]]


async def _finish(conn, result: dict, enrolled: EnrollWait, as_root: bool | None, password: str, url: str) -> dict:
    if await enrolled(ENROLL_WAIT):
        return {**result, "steps": result["steps"] + [{"name": VERIFY_STEP, "status": "ok"}], "error": None}
    logs = await _agent_logs(conn, as_root, password)
    return {**result, "ok": False, "steps": result["steps"] + [{"name": VERIFY_STEP, "status": "fail"}],
            "log": result["log"] + (["$ docker logs wharfline-agent"] + logs if logs else []),
            "error": f"에이전트가 {int(ENROLL_WAIT)}초 안에 Wharfline({url})에 등록하지 못했어요. 서버에서 이 주소로 나가는 연결이 되는지 "
                     "확인하거나, 서버 관리의 '에이전트 접속 주소'를 서버에서 닿는 주소로 바꾼 뒤 다시 실행해 주세요."}


async def init_server(ip: str, port: int, fingerprint: str, account: str, password: str, token: str,
                      users: str, paths: str, full_sudo: bool, url: str, image: str, enrolled: EnrollWait) -> dict:
    """{ok, steps: [{name, status: ok | fail | skip}], log, error}. `error` says what to do when ok is false."""
    names = step_names(full_sudo)
    if sshcheck.simulated():
        if password == SIMULATED_BAD_PASSWORD:
            return _failed(names, f"{account} 계정으로 로그인하지 못했어요. 계정과 비밀번호를 확인해 주세요.")
        return {"ok": True, "steps": [{"name": n, "status": "ok"} for n in names + [VERIFY_STEP]], "log": [], "error": None}

    key, failed = await _pinned_key(ip, port, fingerprint, names)
    if failed:
        return failed
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
            stdin = (token + "\n") if as_root else (password + "\n" + token + "\n")
            r = await conn.run(remote_command(init_script(users, paths, full_sudo, url, image), as_root),
                               input=stdin, stderr=asyncssh.STDOUT, check=False, timeout=SETUP_TIMEOUT)
        except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
            return _failed(names, f"서버에서 설정하는 중에 끊겼어요. 다시 실행해도 괜찮아요. ({str(e) or type(e).__name__})")
        result = read_output(str(r.stdout or ""), r.exit_status if r.exit_status is not None else 1, names, [password, token])
        if not result.pop("reached") and not result["ok"]:
            return _failed(names, f"{account} 계정으로 root 권한을 얻지 못했어요. sudo 비밀번호와 sudo 권한을 확인해 주세요.", result["log"])
        if not result["ok"]:
            return {**result, "error": "설정하는 중에 실패했어요. 아래 내용을 확인하고 다시 실행해 주세요."}
        return await _finish(conn, result, enrolled, as_root, password, url)


async def convert_server(ip: str, port: int, fingerprint: str | None, user: str, private_key: str, token: str,
                         users: str, paths: str, url: str, image: str, enrolled: EnrollWait) -> dict:
    """Start the agent on a server Wharfline deploys to over SSH today, logging in with the inventory's key."""
    names = convert_step_names()
    if sshcheck.simulated():
        return {"ok": True, "steps": [{"name": n, "status": "ok"} for n in names + [VERIFY_STEP]], "log": [], "error": None}
    if fingerprint:
        key, failed = await _pinned_key(ip, port, fingerprint, names)
        if failed:
            return failed
        known = ([key], [], [])
    else:
        known = None
    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(ip, port, username=user, client_keys=[asyncssh.import_private_key(private_key)], known_hosts=known,
                             agent_path=None, preferred_auth="publickey", server_host_key_algs=HOST_KEY_ALGS, config=[]),
            TIMEOUT,
        )
    except asyncssh.PermissionDenied:
        return _failed(names, f"{user} 계정으로 키 로그인을 하지 못했어요. 인벤토리의 SSH 키가 서버에 등록돼 있는지 확인해 주세요.")
    except (OSError, asyncio.TimeoutError, asyncssh.Error, ValueError) as e:
        return _failed(names, f"{ip}:{port}에 로그인하지 못했어요. ({str(e) or type(e).__name__})")
    async with conn:
        try:
            r = await conn.run(remote_command(convert_script(users, paths, url, image), True), input=token + "\n",
                               stderr=asyncssh.STDOUT, check=False, timeout=SETUP_TIMEOUT)
        except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
            return _failed(names, f"서버에서 설정하는 중에 끊겼어요. 다시 실행해도 괜찮아요. ({str(e) or type(e).__name__})")
        result = read_output(str(r.stdout or ""), r.exit_status if r.exit_status is not None else 1, names, [token])
        result.pop("reached")
        if not result["ok"]:
            return {**result, "error": "에이전트를 띄우지 못했어요. 아래 내용을 확인해 주세요."}
        return await _finish(conn, result, enrolled, None, "", url)
