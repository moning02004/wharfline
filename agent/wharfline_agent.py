"""Wharfline agent: deploys on this server for Wharfline, without Wharfline holding a key to it.

Runs as a Docker container (see Dockerfile and backend/app/agentinstall.py for the `docker run`):
  --privileged --pid host --network host -v /var/run/docker.sock:... -v wharfline-agent:/data

It only ever connects out: it long-polls Wharfline over HTTP(S), gets tasks sealed to its own X25519 key and
signed with Wharfline's Ed25519 key (pinned at enrollment), runs them on this server and posts the output back,
signing every request with its own Ed25519 key.

Tasks run on the host as a server account, the way an SSH login would: `nsenter -t 1` into the host's
namespaces, then `runuser -u <account>`. Which accounts and folders it accepts is set here, on the server:
  WHARFLINE_ALLOWED_USERS   e.g. deploy,ubuntu   (never root)
  WHARFLINE_ALLOWED_PATHS   e.g. /srv,/home/ubuntu/apps   (files may only be written below these)

Playbooks run with ansible-playbook inside this container against the server itself (SSH to 127.0.0.1 as the
account, with a key that never leaves the server). Files a playbook fetches to its controller are sealed to
Wharfline's key and sent back with the result.

  python wharfline_agent.py            run (the container's default)
  python wharfline_agent.py replace OLD IMAGE   swap the agent container for one on IMAGE (self-update)
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

from cryptography.exceptions import InvalidSignature, InvalidTag
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

VERSION = os.environ.get("WHARFLINE_AGENT_VERSION", "dev")
DATA = Path(os.environ.get("WHARFLINE_AGENT_DATA", "/data"))
HOST_ROOT = Path(os.environ.get("WHARFLINE_HOST_ROOT", "/proc/1/root"))
POLL_WAIT = 25
TASK_MAX_AGE = 300.0
MAX_ARTIFACTS = 5 * 1024 * 1024
HOST_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
LOCAL_KEY_MARK = "wharfline-agent-local"
INFO = b"wharfline-agent-seal-v1"


def log(*a: Any) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def unb64(t: str) -> bytes:
    return base64.b64decode(t, validate=True)


def raw_public(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def raw_private(key) -> bytes:
    return key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())


# ---------- policy (set on the server, not by Wharfline) ----------

class Policy:
    def __init__(self, users: str, paths: str):
        self.users = [u for u in (x.strip() for x in users.split(",")) if u and USER_RE.match(u) and u != "root"]
        self.paths = [p for p in (normalize(x.strip()) for x in paths.split(",") if x.strip()) if p and p != "/"]

    @classmethod
    def from_env(cls) -> Policy:
        return cls(os.environ.get("WHARFLINE_ALLOWED_USERS", "deploy"), os.environ.get("WHARFLINE_ALLOWED_PATHS", "/srv"))

    def check_user(self, user: str) -> None:
        if user not in self.users:
            raise PolicyError(f"이 서버의 에이전트는 계정 {user!r}을(를) 허용하지 않아요 (허용: {', '.join(self.users) or '없음'}). "
                              "서버에서 WHARFLINE_ALLOWED_USERS를 바꿔 에이전트를 다시 띄워 주세요.")

    def path_allowed(self, real: str) -> bool:
        return any(real == p or real.startswith(p + "/") for p in self.paths)

    def as_dict(self) -> dict[str, list[str]]:
        return {"users": self.users, "paths": self.paths}


class PolicyError(Exception):
    pass


def normalize(path: str) -> str:
    """An absolute path with . and .. resolved lexically; "" if it is not absolute."""
    if not path.startswith("/"):
        return ""
    parts: list[str] = []
    for p in PurePosixPath(path).parts[1:]:
        if p == "..":
            if parts:
                parts.pop()
        elif p not in ("", "."):
            parts.append(p)
    return "/" + "/".join(parts)


# ---------- crypto, the agent side of backend/app/agentproto.py ----------

def canonical(method: str, path: str, ts: str, body: bytes) -> bytes:
    return f"{method.upper()}\n{path}\n{ts}\n{hashlib.sha256(body).hexdigest()}".encode()


def _box_key(shared: bytes, epk: bytes, rpk: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=INFO + epk + rpk).derive(shared)


def seal(recipient_b64: str, plaintext: bytes) -> dict[str, str]:
    rpk = unb64(recipient_b64)
    eph = X25519PrivateKey.generate()
    epk = raw_public(eph)
    key = _box_key(eph.exchange(X25519PublicKey.from_public_bytes(rpk)), epk, rpk)
    nonce = os.urandom(12)
    return {"epk": b64(epk), "nonce": b64(nonce), "ct": b64(AESGCM(key).encrypt(nonce, plaintext, None))}


def unseal(priv: X25519PrivateKey, box: dict[str, str]) -> bytes:
    epk, nonce, ct = unb64(box["epk"]), unb64(box["nonce"]), unb64(box["ct"])
    key = _box_key(priv.exchange(X25519PublicKey.from_public_bytes(epk)), epk, raw_public(priv))
    return AESGCM(key).decrypt(nonce, ct, None)


class Identity:
    def __init__(self, d: dict[str, str]):
        self.d = d
        self.id = d["id"]
        self.url = d["url"].rstrip("/")
        self.sign = Ed25519PrivateKey.from_private_bytes(unb64(d["sign"]))
        self.box = X25519PrivateKey.from_private_bytes(unb64(d["box"]))
        self.server_sign = Ed25519PublicKey.from_public_bytes(unb64(d["serverKey"]))
        self.server_box = d["serverBox"]

    def headers(self, method: str, path: str, body: bytes) -> dict[str, str]:
        ts = str(int(time.time()))
        return {"X-Wharfline-Agent": self.id, "X-Wharfline-Time": ts,
                "X-Wharfline-Sig": b64(self.sign.sign(canonical(method, path, ts, body)))}

    def open_task(self, sealed: str, sig: str) -> dict[str, Any]:
        try:
            self.server_sign.verify(unb64(sig), sealed.encode())
        except (InvalidSignature, ValueError) as e:
            raise PolicyError("작업의 서명이 맞지 않아요") from e
        try:
            return json.loads(unseal(self.box, json.loads(sealed)))
        except (InvalidTag, ValueError, KeyError) as e:
            raise PolicyError("작업을 풀지 못했어요") from e


def load_identity() -> Identity | None:
    f = DATA / "identity.json"
    if not f.is_file():
        return None
    try:
        return Identity(json.loads(f.read_text()))
    except (ValueError, KeyError):
        return None


def write_private(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


# ---------- HTTP ----------

class Http:
    def __init__(self, url: str):
        self.url = url.rstrip("/")
        self.prefix = urllib.request.urlparse(self.url).path.rstrip("/")

    def _do(self, method: str, path: str, body: bytes, headers: dict[str, str], timeout: float) -> tuple[int, Any]:
        req = urllib.request.Request(self.url + path, data=body if method != "GET" else None, method=method,
                                     headers={"Content-Type": "application/json", "User-Agent": f"wharfline-agent/{VERSION}", **headers})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, json.loads(raw or b"null")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"null")
            except ValueError:
                detail = None
            return e.code, detail

    async def post(self, path: str, data: Any, ident: Identity | None, timeout: float = 30) -> tuple[int, Any]:
        body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
        headers = ident.headers("POST", self.prefix + path, body) if ident else {}
        return await asyncio.to_thread(self._do, "POST", path, body, headers, timeout)


# ---------- the host ----------

def nsenter(*argv: str) -> list[str]:
    return ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", *argv]


def host_home(user: str) -> str:
    try:
        for line in (HOST_ROOT / "etc/passwd").read_text().splitlines():
            parts = line.split(":")
            if len(parts) >= 7 and parts[0] == user:
                return parts[5] or "/"
    except OSError:
        pass
    raise PolicyError(f"서버에 계정 {user}이(가) 없어요")


def as_user(user: str, command: str) -> list[str]:
    """argv that runs `command` with sh on the host as `user`, in a clean login-like environment."""
    home = host_home(user)
    return nsenter("runuser", "-u", user, "--", "env", "-i", f"HOME={home}", f"USER={user}", f"LOGNAME={user}",
                   "SHELL=/bin/bash", f"PATH={HOST_PATH}", "LANG=C.UTF-8", "sh", "-c", f'cd "$HOME" 2>/dev/null || cd /; {command}')


def host_realpath(path: str) -> str:
    r = subprocess.run(nsenter("realpath", "-m", "--", path), capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise PolicyError(f"{path} 경로를 확인하지 못했어요: {r.stderr.strip()}")
    return r.stdout.strip()


def primary_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # no packet is sent
            return s.getsockname()[0]
    except OSError:
        return ""


def ssh_port() -> int:
    if os.environ.get("WHARFLINE_SSH_PORT"):
        return int(os.environ["WHARFLINE_SSH_PORT"])
    try:
        for line in (HOST_ROOT / "etc/ssh/sshd_config").read_text().splitlines():
            m = re.match(r"\s*Port\s+(\d+)", line)
            if m:
                return int(m.group(1))
    except OSError:
        pass
    return 22


def docker_cli(*args: str, timeout: float = 30) -> str:
    try:
        r = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def containers() -> list[dict[str, Any]]:
    """Running containers with the image digest they run: what Wharfline shows as "on this server"."""
    ids = docker_cli("ps", "-q").split()[:100]
    if not ids:
        return []
    try:
        rows = json.loads(docker_cli("inspect", *ids) or "[]")
    except ValueError:
        return []
    images: dict[str, list[str]] = {}
    image_ids = sorted({r.get("Image", "") for r in rows if r.get("Image")})
    if image_ids:
        try:
            for im in json.loads(docker_cli("image", "inspect", *image_ids) or "[]"):
                images[im.get("Id", "")] = im.get("RepoDigests") or []
        except ValueError:
            pass
    out = []
    for r in rows:
        labels = (r.get("Config") or {}).get("Labels") or {}
        out.append({"name": (r.get("Name") or "").lstrip("/"), "image": (r.get("Config") or {}).get("Image", ""),
                    "digests": images.get(r.get("Image", ""), [])[:3], "state": (r.get("State") or {}).get("Status", ""),
                    "project": labels.get("com.docker.compose.project", ""),
                    "dir": labels.get("com.docker.compose.project.working_dir", ""), "started": (r.get("State") or {}).get("StartedAt", "")})
    return out


def sudo_state(policy: Policy) -> dict[str, bool]:
    return {u: (HOST_ROOT / f"etc/sudoers.d/wharfline-{u}").exists() for u in policy.users}


def rollout_present() -> bool:
    return any((HOST_ROOT / p).exists() for p in ("usr/local/lib/docker/cli-plugins/docker-rollout",
                                                  "usr/libexec/docker/cli-plugins/docker-rollout",
                                                  "usr/lib/docker/cli-plugins/docker-rollout"))


def hostname() -> str:
    try:
        return (HOST_ROOT / "etc/hostname").read_text().strip()[:128]
    except OSError:
        return socket.gethostname()


def base_info(policy: Policy) -> dict[str, Any]:
    return {"version": VERSION, "hostname": hostname(), "ip": primary_ip(), "policy": policy.as_dict(),
            "sudo": sudo_state(policy), "rollout": rollout_present(), "sshPort": ssh_port()}


# ---------- the agent ----------

class Agent:
    def __init__(self, http: Http, ident: Identity, policy: Policy):
        self.http, self.ident, self.policy = http, ident, policy
        self.procs: dict[str, asyncio.subprocess.Process] = {}
        self.seen: dict[str, float] = {}
        self.inventory_at = 0.0
        self.lines_out: dict[str, list[str]] = {}

    def info(self, full: bool) -> dict[str, Any]:
        d = base_info(self.policy)
        if full:
            d["containers"] = containers()
            d["docker"] = docker_cli("version", "--format", "{{.Server.Version}}").strip()
        return d

    async def run(self) -> None:
        backoff = 1.0
        while True:
            full = time.time() - self.inventory_at > 60
            try:
                info = await asyncio.to_thread(self.info, full)
                if full:
                    self.inventory_at = time.time()
                code, data = await self.http.post("/api/agent/poll", {"info": info, "wait": POLL_WAIT}, self.ident, timeout=POLL_WAIT + 20)
            except (OSError, urllib.error.URLError, TimeoutError) as e:
                log(f"poll failed: {e}; retry in {backoff:.0f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            if code == 401:
                log(f"Wharfline refused this agent: {data}. Re-enroll with a new token (re-run the install command).")
                await asyncio.sleep(30)
                continue
            if code != 200 or not isinstance(data, dict):
                log(f"poll answered {code}; retry in {backoff:.0f}s")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)
                continue
            backoff = 1.0
            if data.get("task"):
                try:
                    task = self.ident.open_task(data["task"], data.get("sig", ""))
                except PolicyError as e:
                    log(f"refused a task: {e}")
                    continue
                if not self.fresh(task):
                    log("refused a stale or repeated task")
                    continue
                asyncio.get_running_loop().create_task(self.handle(task))

    def fresh(self, task: dict[str, Any]) -> bool:
        now = time.time()
        self.seen = {k: t for k, t in self.seen.items() if now - t < TASK_MAX_AGE * 2}
        tid = str(task.get("id") or "")
        if not tid or tid in self.seen or abs(now - float(task.get("at") or 0)) > TASK_MAX_AGE:
            return False
        self.seen[tid] = now
        return True

    # ----- output -----

    async def flusher(self, tid: str, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), 0.3)
            except asyncio.TimeoutError:
                pass
            await self.flush(tid)

    async def flush(self, tid: str) -> None:
        buf = self.lines_out.get(tid)
        if not buf:
            return
        batch, self.lines_out[tid] = buf[:400], buf[400:]
        try:
            await self.http.post(f"/api/agent/tasks/{tid}/lines", {"lines": batch}, self.ident)
        except (OSError, urllib.error.URLError, TimeoutError) as e:
            log(f"lines for {tid} lost: {e}")

    def say(self, tid: str, text: str) -> None:
        self.lines_out.setdefault(tid, []).append(text)

    async def handle(self, task: dict[str, Any]) -> None:
        tid, op = task["id"], task.get("op")
        if op == "cancel":
            p = self.procs.get(str(task.get("task")))
            if p and p.returncode is None:
                try:
                    os.killpg(p.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            return
        stop = asyncio.Event()
        flusher = asyncio.get_running_loop().create_task(self.flusher(tid, stop))
        try:
            fn = {"exec": self.op_exec, "write": self.op_write, "playbook": self.op_playbook, "sudo": self.op_sudo,
                  "update": self.op_update, "inspect": self.op_inspect}.get(op)
            result = await fn(tid, task) if fn else {"ok": False, "error": f"이 에이전트({VERSION})가 모르는 작업이에요: {op}"}
        except PolicyError as e:
            result = {"ok": False, "error": str(e)}
        except Exception as e:  # noqa: BLE001 - the task must always get an answer
            result = {"ok": False, "error": f"에이전트 오류: {type(e).__name__}: {e}"}
        finally:
            stop.set()
            await flusher
            await self.flush(tid)
            self.lines_out.pop(tid, None)
            self.procs.pop(tid, None)
        for _ in range(5):
            try:
                await self.http.post(f"/api/agent/tasks/{tid}/finish", {"result": result}, self.ident, timeout=60)
                break
            except (OSError, urllib.error.URLError, TimeoutError):
                await asyncio.sleep(2)

    async def stream(self, tid: str, argv: list[str], stdin: bytes | None = None, env: dict[str, str] | None = None,
                     cwd: str | None = None) -> int:
        proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                    env=env, cwd=cwd, start_new_session=True, limit=1024 * 1024)
        self.procs[tid] = proc
        if stdin is not None:
            assert proc.stdin is not None
            proc.stdin.write(stdin)
            await proc.stdin.drain()
            proc.stdin.close()
        assert proc.stdout is not None
        async for raw in proc.stdout:
            self.say(tid, raw.decode(errors="replace").rstrip("\r\n"))
        return await proc.wait()

    # ----- operations -----

    async def op_exec(self, tid: str, t: dict[str, Any]) -> dict[str, Any]:
        user = str(t.get("user") or "")
        self.policy.check_user(user)
        stdin = t.get("stdin")
        rc = await self.stream(tid, as_user(user, str(t.get("cmd") or "true")), stdin.encode() if isinstance(stdin, str) else None)
        return {"ok": rc == 0, "rc": rc}

    async def op_write(self, tid: str, t: dict[str, Any]) -> dict[str, Any]:
        user = str(t.get("user") or "")
        self.policy.check_user(user)
        for f in t.get("files") or []:
            path, mode = normalize(str(f.get("path") or "")), int(f.get("mode") or 0o644) & 0o777
            if not path:
                raise PolicyError(f"절대 경로가 아니에요: {f.get('path')}")
            real = await asyncio.to_thread(host_realpath, path)
            if not self.policy.path_allowed(real):
                raise PolicyError(f"{path} 은(는) 이 서버의 에이전트가 허용한 경로 밖이에요 (허용: {', '.join(self.policy.paths)}). "
                                  "작업의 서비스 경로를 허용 경로 안으로 바꾸거나, 서버에서 WHARFLINE_ALLOWED_PATHS를 넓혀 주세요.")
            script = ('d=$(dirname -- "$1") && mkdir -p -- "$d" && umask 077 && cat > "$1" && chmod "$2" "$1"')
            argv = as_user(user, f"set -e; {script}") + ["sh", path, oct(mode)[2:]]
            proc = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate(unb64(str(f.get("content") or "")))
            if proc.returncode != 0:
                said = out.decode(errors="replace").strip()
                raise PolicyError(f"{path} 쓰기 실패: {said or proc.returncode} · 계정 {user}에게 이 경로의 쓰기 권한이 있는지 "
                                  f"확인해 주세요 (서버에서 `ls -ld {shlex.quote(str(PurePosixPath(path).parent))}`).")
        return {"ok": True}

    async def op_sudo(self, tid: str, t: dict[str, Any]) -> dict[str, Any]:
        user = str(t.get("user") or "")
        self.policy.check_user(user)
        f = f"/etc/sudoers.d/wharfline-{user}"
        if t.get("enable"):
            script = (f"printf '%s ALL=(ALL) NOPASSWD:ALL\\n' {shlex.quote(user)} > {f} && chmod 440 {f} && "
                      f"visudo -cf {f} >/dev/null || {{ rm -f {f}; exit 1; }}")
        else:
            script = f"rm -f {f}"
        r = await asyncio.to_thread(subprocess.run, nsenter("sh", "-c", script), capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return {"ok": False, "error": (r.stdout + r.stderr).strip() or "sudo 설정을 바꾸지 못했어요"}
        return {"ok": True, "sudo": sudo_state(self.policy)}

    async def op_inspect(self, tid: str, t: dict[str, Any]) -> dict[str, Any]:
        self.inventory_at = 0
        return {"ok": True, "info": await asyncio.to_thread(self.info, True)}

    async def op_update(self, tid: str, t: dict[str, Any]) -> dict[str, Any]:
        image = str(t.get("image") or "")
        if not re.match(r"^[A-Za-z0-9._/:@-]+$", image):
            return {"ok": False, "error": "이미지 이름이 이상해요"}
        rc = await self.stream(tid, ["docker", "pull", image])
        if rc != 0:
            return {"ok": False, "error": f"docker pull {image} 실패"}
        cid = docker_cli("ps", "-q", "--filter", "label=wharfline.agent=1").split()
        if not cid:
            return {"ok": False, "error": "에이전트 컨테이너를 찾지 못했어요"}
        subprocess.Popen(["docker", "run", "-d", "--rm", "--name", f"wharfline-agent-updater-{int(time.time())}",
                          "-v", "/var/run/docker.sock:/var/run/docker.sock", "--entrypoint", "python", image,
                          "/agent/wharfline_agent.py", "replace", cid[0], image],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"ok": True, "message": f"{image}(으)로 바꾸는 중이에요"}

    async def op_playbook(self, tid: str, t: dict[str, Any]) -> dict[str, Any]:
        user = str(t.get("user") or "")
        self.policy.check_user(user)
        if shutil.which("ansible-playbook") is None:
            return {"ok": False, "error": "에이전트 이미지에 ansible-playbook이 없어요"}
        port = ssh_port()
        run = Path(tempfile.mkdtemp(prefix="run-", dir=str(DATA)))
        try:
            src = run / "src"
            src.mkdir(mode=0o700)
            with tarfile.open(fileobj=io.BytesIO(unb64(str(t.get("bundle") or ""))), mode="r:gz") as tar:
                tar.extractall(src, filter="data")
            book = normalize("/" + str(t.get("book") or ""))[1:]
            if not book or not (src / book).is_file():
                return {"ok": False, "error": f"플레이북 {t.get('book')}이(가) 묶음에 없어요"}
            variables = json.loads(json.dumps(t.get("vars") or {}).replace("@@RUNDIR@@", str(src).replace("\\", "/")))
            inv = t.get("inventory") or {}
            for g in ((inv.get("all") or {}).get("children") or {}).values():
                for h in (g.get("hosts") or {}).values():
                    if isinstance(h, dict) and "ansible_host" in h:
                        h.update(ansible_host="127.0.0.1", ansible_port=port, ansible_user=user)
            key = await asyncio.to_thread(self.local_key, user)
            kh = run / "known_hosts"
            kh.write_text(host_known_hosts(port))
            vars_file = run / "vars.json"
            write_private(vars_file, json.dumps(variables, ensure_ascii=False))
            inv_file = run / "inventory.json"
            inv_file.write_text(json.dumps(inv))
            before = snapshot(src)
            env = {"PATH": os.environ.get("PATH", HOST_PATH), "HOME": str(run), "LANG": "C.UTF-8", "PYTHONUNBUFFERED": "1",
                   "ANSIBLE_HOST_KEY_CHECKING": "True", "ANSIBLE_NOCOLOR": "1", "ANSIBLE_FORCE_COLOR": "0",
                   "ANSIBLE_RETRY_FILES_ENABLED": "0", "ANSIBLE_STDOUT_CALLBACK": "default", "ANSIBLE_LOCAL_TEMP": str(run / "tmp"),
                   "ANSIBLE_SSH_CONTROL_PATH_DIR": str(run / "cp"), "ANSIBLE_PRIVATE_KEY_FILE": str(key),
                   "ANSIBLE_SSH_ARGS": f"-o UserKnownHostsFile={kh} -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes "
                                       "-o BatchMode=yes -o ControlMaster=auto -o ControlPersist=60s"}
            (run / "cp").mkdir(mode=0o700)
            argv = ["ansible-playbook", book, "-i", str(inv_file), "--limit", str(t.get("limit") or "all"),
                    "-e", f"@{vars_file}", "--private-key", str(key)]
            rc = await self.stream(tid, argv, env=env, cwd=str(src))
            result: dict[str, Any] = {"ok": rc == 0, "rc": rc}
            fetched = collect(src, before)
            if fetched:
                result["sealed"] = seal(self.ident.server_box, json.dumps(fetched).encode())
            return result
        finally:
            shutil.rmtree(run, ignore_errors=True)

    def local_key(self, user: str) -> Path:
        """This server's own key for playbooks (SSH to 127.0.0.1), authorized for `user` from localhost only."""
        key = DATA / "local_ssh_key"
        if not key.is_file():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", LOCAL_KEY_MARK, "-f", str(key)], check=True)
        pub = (DATA / "local_ssh_key.pub").read_text().strip()
        line = f'from="127.0.0.1,::1",no-agent-forwarding,no-port-forwarding,no-X11-forwarding {pub}'
        home = host_home(user)
        script = ('set -e; h="$1"; u="$2"; l="$3"; mkdir -p "$h/.ssh"; touch "$h/.ssh/authorized_keys"; '
                  f'grep -v {shlex.quote(LOCAL_KEY_MARK)} "$h/.ssh/authorized_keys" > "$h/.ssh/.ak.tmp" || true; '
                  'printf "%s\\n" "$l" >> "$h/.ssh/.ak.tmp"; mv "$h/.ssh/.ak.tmp" "$h/.ssh/authorized_keys"; '
                  'chown -R "$u:$u" "$h/.ssh"; chmod 700 "$h/.ssh"; chmod 600 "$h/.ssh/authorized_keys"')
        subprocess.run(nsenter("sh", "-c", script, "sh", home, user, line), check=True, capture_output=True, timeout=30)
        return key


def host_known_hosts(port: int) -> str:
    """known_hosts lines for 127.0.0.1 from the server's own host keys (no trust-on-first-use)."""
    host = "127.0.0.1" if port == 22 else f"[127.0.0.1]:{port}"
    out = []
    for f in sorted((HOST_ROOT / "etc/ssh").glob("ssh_host_*_key.pub")):
        parts = f.read_text().split()
        if len(parts) >= 2:
            out.append(f"{host} {parts[0]} {parts[1]}")
    return "\n".join(out) + "\n"


def snapshot(root: Path) -> set[str]:
    return {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}


def collect(root: Path, before: set[str]) -> list[dict[str, str]]:
    """Files that appeared in the run folder while the playbook ran (fetch, copy to controller)."""
    out, total = [], 0
    for p in sorted(root.rglob("*")):
        rel = p.relative_to(root).as_posix()
        if not p.is_file() or p.is_symlink() or rel in before or rel.startswith((".ansible/", ".wharfline/")) or rel.endswith(".retry"):
            continue
        data = p.read_bytes()
        total += len(data)
        if total > MAX_ARTIFACTS:
            break
        out.append({"path": rel, "data": b64(data)})
    return out


# ---------- enrollment and startup ----------

async def enroll(url: str, token: str, policy: Policy) -> Identity:
    sign, box = Ed25519PrivateKey.generate(), X25519PrivateKey.generate()
    http = Http(url)
    info = base_info(policy)
    code, data = await http.post("/api/agent/enroll", {"token": token, "key": b64(raw_public(sign)), "box": b64(raw_public(box)),
                                                      "info": info}, None)
    if code != 200 or not isinstance(data, dict):
        raise SystemExit(f"enrollment failed ({code}): {data}")
    d = {"id": data["id"], "url": url, "sign": b64(raw_private(sign)), "box": b64(raw_private(box)),
         "serverKey": data["serverKey"], "serverBox": data["serverBox"], "host": data.get("host", "")}
    write_private(DATA / "identity.json", json.dumps(d))
    log(f"enrolled as {data.get('host')} ({data['id'][:8]}…)")
    return Identity(d)


async def main() -> None:
    url = os.environ.get("WHARFLINE_URL", "").rstrip("/")
    if not url:
        raise SystemExit("set WHARFLINE_URL")
    policy = Policy.from_env()
    log(f"wharfline agent {VERSION} · {url} · users {policy.users} · paths {policy.paths}")
    token_file = DATA / "enroll.token"
    ident = load_identity()
    if token_file.is_file():
        token = token_file.read_text().strip()
        while True:
            try:
                ident = await enroll(url, token, policy)
                break
            except (OSError, urllib.error.URLError, TimeoutError) as e:
                log(f"cannot reach {url}: {e}; retry in 5s")
                await asyncio.sleep(5)
        token_file.unlink(missing_ok=True)
    if ident is None:
        raise SystemExit("not enrolled: run the install command from Wharfline (it brings a one-time token)")
    if ident.url != url:
        ident.url = url
    await Agent(Http(url), ident, policy).run()


def replace(old: str, image: str) -> None:
    """Run by a short-lived helper container: recreate the agent container `old` on `image` with the same settings."""
    try:
        cfg = json.loads(subprocess.run(["docker", "inspect", old], capture_output=True, text=True, check=True).stdout)[0]
    except (subprocess.CalledProcessError, ValueError, IndexError) as e:
        raise SystemExit(f"cannot inspect {old}: {e}")
    env = [e for e in (cfg.get("Config") or {}).get("Env") or [] if e.split("=", 1)[0].startswith("WHARFLINE_")
           and not e.startswith("WHARFLINE_AGENT_VERSION=")]
    name = (cfg.get("Name") or "/wharfline-agent").lstrip("/")
    subprocess.run(["docker", "rm", "-f", old], check=False)
    argv = ["docker", "run", "-d", "--name", name, "--restart", "unless-stopped", "--privileged", "--pid", "host", "--network", "host",
            "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", "wharfline-agent:/data", "--label", "wharfline.agent=1"]
    for e in env:
        argv += ["-e", e]
    subprocess.run([*argv, image], check=True)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "replace":
        replace(sys.argv[2], sys.argv[3])
    else:
        try:
            asyncio.run(main())
        except KeyboardInterrupt:
            pass
