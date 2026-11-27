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

import ipaddress
import os
import re
import shlex
from urllib.parse import urlsplit

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


# ---------- internal addresses (/etc/hosts) ----------
# On a private network, the public names of Wharfline and the registry often can't be reached from the servers
# (no hairpin NAT). Wharfline keeps "private IP → names" lines and writes them into each server's /etc/hosts, in
# a block of its own, so the agent, `docker pull` and everything else on the server find them.

HOSTS_BEGIN = "# BEGIN wharfline"
HOSTS_END = "# END wharfline"
HOST_NAME_RE = re.compile(r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$")
MAX_HOSTS = 50


def parse_hosts(text: str) -> list[list[str]]:
    """/etc/hosts-style lines ("10.0.1.6 deploy.example.com git.example.com", # comments) → [[ip, name], ...].
    Raises ValueError with a message for the screen."""
    out: list[list[str]] = []
    seen: dict[str, str] = {}
    for n, raw in enumerate((text or "").splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        ip_text, *names = line.split()
        try:
            ip = str(ipaddress.ip_address(ip_text))
        except ValueError:
            raise ValueError(f"{n}번째 줄: {ip_text}은(는) IP 주소가 아니에요. 예: 10.0.1.6 deploy.example.com") from None
        if not names:
            raise ValueError(f"{n}번째 줄: {ip} 뒤에 도메인을 적어 주세요.")
        for name in names:
            name = name.lower().rstrip(".")
            if not HOST_NAME_RE.match(name):
                raise ValueError(f"{n}번째 줄: {name}은(는) 도메인으로 쓸 수 없어요.")
            if seen.get(name, ip) != ip:
                raise ValueError(f"{name}이(가) {seen[name]}와 {ip} 두 곳에 적혀 있어요.")
            if name not in seen:
                seen[name] = ip
                out.append([ip, name])
    if len(out) > MAX_HOSTS:
        raise ValueError(f"내부 주소는 도메인 {MAX_HOSTS}개까지 넣을 수 있어요.")
    return out


def hosts_text(pairs: list[list[str]]) -> str:
    """One line per IP, names in the order they were given."""
    by_ip: dict[str, list[str]] = {}
    for ip, name in pairs:
        by_ip.setdefault(ip, []).append(name)
    return "".join(f"{ip} {' '.join(names)}\n" for ip, names in by_ip.items())


def hosts_lines(pairs: list[list[str]]) -> list[str]:
    """Write Wharfline's block at the top of /etc/hosts (the first match wins, so it beats an older hand-made line),
    replacing what an earlier run wrote. No pairs: nothing, /etc/hosts is left alone (a block an earlier run wrote
    stays until a run with addresses replaces it). Needs root or password-less sudo; without either it says so
    and goes on."""
    if not pairs:
        return []
    q = shlex.quote
    strip = f"awk -v b={q(HOSTS_BEGIN)} -v e={q(HOSTS_END)} '$0==b{{s=1;next}} $0==e{{s=0;next}} !s' /etc/hosts"
    block = [HOSTS_BEGIN, *hosts_text(pairs).splitlines(), HOSTS_END]
    new = f"{{ printf '%s\\n' {' '.join(q(b) for b in block)}; {strip}; }}"
    return [
        'SUDO=""; [ -w /etc/hosts ] || { sudo -n true 2>/dev/null && SUDO="sudo -n"; } || true',
        'if [ -w /etc/hosts ] || [ -n "$SUDO" ]; then',
        f'  T=$(mktemp) && {new} > "$T" && $SUDO sh -c \'cat "$1" > /etc/hosts\' sh "$T"; rm -f "$T"',
        f"  echo {q('내부 주소: ' + ', '.join(f'{name} → {ip}' for ip, name in pairs))}",
        "else",
        "  echo '내부 주소를 /etc/hosts에 쓰지 못했어요 (root 권한이 필요해요). 설치 명령을 sudo로 다시 실행해 주세요.'",
        "fi",
    ]


def curl_resolve(url: str, pairs: list[list[str]]) -> str:
    """`--resolve host:port:ip ` for curl when Wharfline's own name has an internal address, else ""."""
    u = urlsplit(url)
    host = (u.hostname or "").lower()
    ip = next((ip for ip, name in pairs if name == host), None)
    if not ip:
        return ""
    port = u.port or (443 if u.scheme == "https" else 80)
    return f"--resolve {host}:{port}:{f'[{ip}]' if ':' in ip else ip} "


def run_lines(url: str, image: str, users: str, paths: str, token_var: str = "TOKEN",
              hosts: list[list[str]] | None = None) -> list[str]:
    """POSIX sh, run as root, with the token in the shell variable `token_var`. Safe to run again.
    Internal addresses go into /etc/hosts first: docker pulls read that file, and the agent's container (host
    network) takes a copy of it when it starts."""
    q = shlex.quote
    return [
        *hosts_lines(hosts or []),
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


def install_script(url: str, image: str, hosts: list[list[str]] | None = None) -> str:
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
        *run_lines("@@URL@@", "@@IMAGE@@", "@@USERS@@", "@@PATHS@@", hosts=hosts),
        "echo '==> done: the agent is starting and will show up in Wharfline in a few seconds'",
    ]
    text = "\n".join(lines) + "\n"
    q = shlex.quote
    # users/paths come from the arguments at run time; url/image are Wharfline's
    return (text.replace(q("@@URL@@"), q(url)).replace("@@URL@@", q(url))
            .replace(q("@@IMAGE@@"), q(image)).replace("@@IMAGE@@", q(image))
            .replace(q("@@USERS@@"), '"$USERS"').replace("@@USERS@@", '"$USERS"')
            .replace(q("@@PATHS@@"), '"$PATHS"').replace("@@PATHS@@", '"$PATHS"'))
