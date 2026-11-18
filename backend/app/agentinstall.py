"""The shell lines that put a Wharfline agent on a server, shared by server setup (serverinit) and install.sh.

The enrollment token never goes on a command line or into the container's environment (both show up in
`ps` / `docker inspect`): it is piped into the agent's volume as a 0600 file, which the agent deletes as soon
as it has enrolled.

The agent runs with the Docker socket, host PID namespace and host network: it deploys with the server's
own docker / docker compose / docker rollout, and runs commands as a server account (nsenter + runuser), the
same way an SSH login would. Which accounts and folders it accepts is fixed here, on the server
(WHARFLINE_ALLOWED_USERS / _PATHS), not by Wharfline.
"""

from __future__ import annotations

import os
import re
import shlex

CONTAINER = "wharfline-agent"
VOLUME = "wharfline-agent"
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]*$")
DEFAULT_PATHS = "/srv"


def agent_image() -> str:
    return os.getenv("WHARFLINE_AGENT_IMAGE", "").strip() or "ghcr.io/moning02004/wharfline-agent:latest"


def clean_users(text: str) -> str:
    users = [u.strip() for u in re.split(r"[,\s]+", text or "") if u.strip()]
    bad = [u for u in users if not USER_RE.match(u) or u == "root"]
    if bad:
        raise ValueError(f"실행 사용자는 deploy, ubuntu처럼 영문 소문자로 적어 주세요 (root는 안 돼요): {', '.join(bad)}")
    if not users:
        raise ValueError("실행 사용자를 하나 이상 적어 주세요.")
    return ",".join(dict.fromkeys(users))


def clean_paths(text: str) -> str:
    paths = [p.strip().rstrip("/") or "/" for p in re.split(r"[,\s]+", text or "") if p.strip()]
    bad = [p for p in paths if not PATH_RE.match(p) or ".." in p.split("/") or p == "/"]
    if bad:
        raise ValueError(f"허용 경로는 /srv, /home/ubuntu/apps처럼 /로 시작하는 폴더로 적어 주세요 (/ 전체는 안 돼요): {', '.join(bad)}")
    return ",".join(dict.fromkeys(paths or [DEFAULT_PATHS]))


def run_lines(url: str, image: str, users: str, paths: str, token_var: str = "TOKEN") -> list[str]:
    """POSIX sh, run as root, with the token in the shell variable `token_var`. Safe to run again."""
    q = shlex.quote
    return [
        f"docker pull {q(image)} || docker image inspect {q(image)} >/dev/null",  # a local or mirrored image works too
        f"docker volume create {VOLUME} >/dev/null",
        f'printf \'%s\' "${token_var}" | docker run --rm -i -v {VOLUME}:/data --entrypoint sh {q(image)} '
        "-c 'umask 077; cat > /data/enroll.token'",
        f"docker rm -f {CONTAINER} >/dev/null 2>&1 || true",
        # removal can still be finishing: wait until the name is free
        f"i=0; while docker inspect {CONTAINER} >/dev/null 2>&1 && [ $i -lt 20 ]; do sleep 1; "
        f"docker rm -f {CONTAINER} >/dev/null 2>&1 || true; i=$((i+1)); done",
        f"docker run -d --name {CONTAINER} --restart unless-stopped --privileged --pid host --network host "
        f"-v /var/run/docker.sock:/var/run/docker.sock -v {VOLUME}:/data "
        f"-e WHARFLINE_URL={q(url)} -e WHARFLINE_ALLOWED_USERS={q(users)} -e WHARFLINE_ALLOWED_PATHS={q(paths)} "
        f"--label wharfline.agent=1 {q(image)} >/dev/null",
    ]


# A new allowed folder belongs to the run account whose home it is in (/home/ubuntu/apps → ubuntu), else the first.
OWNER_LINES = [
    '  O="$FIRST"',
    '  for U in $(echo "$USERS" | tr "," " "); do H=$(getent passwd "$U" | cut -d: -f6); '
    'case "$P" in "$H"/*) O="$U";; esac; done',
]

ROLLOUT_URL = "https://github.com/wowu/docker-rollout/releases/latest/download/docker-rollout"
ROLLOUT_PATH = "/usr/local/lib/docker/cli-plugins/docker-rollout"


def install_script(url: str, image: str) -> str:
    """install.sh: `curl -fsSL <url>/api/agent/install.sh | sudo sh -s -- <token> [users] [paths]`.

    Installs Docker and docker rollout when missing, creates the run users, hands them the allowed folders that
    don't exist yet, and starts the agent. Holds no secret: the token comes as an argument."""
    lines = [
        "#!/bin/sh",
        "# Wharfline agent installer. Usage: curl -fsSL <wharfline>/api/agent/install.sh | sudo sh -s -- <token> [users] [paths]",
        "set -eu",
        'TOKEN="${1:-}"',
        f'USERS="${{2:-deploy}}"',
        f'PATHS="${{3:-{DEFAULT_PATHS}}}"',
        '[ -n "$TOKEN" ] || { echo "usage: sh -s -- <token> [users] [paths]" >&2; exit 2; }',
        '[ "$(id -u)" = 0 ] || { echo "run as root (sudo)" >&2; exit 2; }',
        'case "$USERS" in *root*) echo "root is not allowed as a run user" >&2; exit 2;; esac',
        "echo '==> Docker'",
        "if ! command -v docker >/dev/null 2>&1; then",
        "  command -v curl >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq curl; }",
        "  curl -fsSL https://get.docker.com | sh",
        "fi",
        "docker compose version",
        "echo '==> docker rollout'",
        f"if [ ! -x {ROLLOUT_PATH} ]; then mkdir -p {ROLLOUT_PATH.rsplit('/', 1)[0]}; "
        f"curl -fsSL {ROLLOUT_URL} -o {ROLLOUT_PATH} && chmod 755 {ROLLOUT_PATH} || rm -f {ROLLOUT_PATH}; fi",
        "echo '==> run users'",
        'FIRST=""',
        'for U in $(echo "$USERS" | tr "," " "); do',
        '  id -u "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"',
        '  usermod -aG docker "$U"',
        '  [ -n "$FIRST" ] || FIRST="$U"',
        "done",
        "echo '==> folders'",
        'for P in $(echo "$PATHS" | tr "," " "); do',
        *OWNER_LINES,
        '  if [ ! -e "$P" ]; then mkdir -p "$P" && chown "$O:$O" "$P"; fi',
        "done",
        "echo '==> agent'",
        *run_lines("@@URL@@", "@@IMAGE@@", "@@USERS@@", "@@PATHS@@"),
        "echo '==> done: the agent is starting and will show up in Wharfline in a few seconds'",
    ]
    text = "\n".join(lines) + "\n"
    q = shlex.quote
    # users/paths come from the arguments at run time; url/image are Wharfline's
    return (text.replace(q("@@URL@@"), q(url)).replace("@@URL@@", q(url))
            .replace(q("@@IMAGE@@"), q(image)).replace("@@IMAGE@@", q(image))
            .replace(q("@@USERS@@"), '"$USERS"').replace("@@USERS@@", '"$USERS"')
            .replace(q("@@PATHS@@"), '"$PATHS"').replace("@@PATHS@@", '"$PATHS"'))
