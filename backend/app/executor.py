"""Real deploy runner: runs a job against its servers and streams what happens.

Playbook jobs: the repo is cloned (or copied) into a private temp folder, a temporary inventory,
SSH key, known_hosts and extra-vars file are written next to it, and `ansible-playbook` runs with
its output streamed into the run log. SSH script jobs: Wharfline logs in to every server with
asyncssh, uploads the job's files and .env, and runs each script step in order.

Host keys are pinned: the fingerprint seen when the server was added (or on its first run) is kept
on the host row. A server that answers with another key is marked "changed" and skipped until an
Admin accepts the new key. The temp folder (key, .env, playbook copy) is deleted when the run ends.

Secrets (SSH key, registry token, .env values) are decrypted when the run starts, written only to
files with mode 0600 inside the temp folder, and masked in every log line.

`runner` decides whether a run is real or simulated (tests and demos: WHARFLINE_SSH_SIMULATE=1 or
WHARFLINE_RUN_SIMULATE=1).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shlex
import shutil
import signal
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

import asyncssh
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import crypto
from . import models as m
from . import store as s
from .db import SessionLocal
from .sshcheck import HOST_KEY_ALGS

Line = tuple[str, str]

CONNECT_TIMEOUT = 15.0
LINE_LIMIT = 1024 * 1024  # longest output line read from a process
MASK = "••••••••"
PLAYBOOK_STEPS = ["준비", "플레이북 가져오기", "서버 연결", "플레이북 실행", "마무리"]
# Shipped in the image at store.BUILTIN_URL; a checkout (local dev) uses backend/playbooks/builtin.
BUILTIN_FALLBACK = Path(__file__).resolve().parent.parent / "playbooks" / "builtin"

# Servers in use by a running deploy: "ip:port" -> run number. One backend process (runs live in memory).
BUSY: dict[str, int] = {}


def simulated() -> bool:
    return os.environ.get("WHARFLINE_RUN_SIMULATE") == "1" or os.environ.get("WHARFLINE_SSH_SIMULATE") == "1"


class PlanError(Exception):
    """Something the run needs is missing (key, repo, inventory): the run fails before touching a server."""


# ---------- what a run needs, read from the database when it starts ----------

@dataclass
class Target:
    id: int
    name: str
    ip: str
    port: int
    user: str
    group: str
    fingerprint: str | None

    @property
    def addr(self) -> str:
        return f"{self.ip}:{self.port}"


@dataclass
class Registry:
    host: str
    user: str
    password: str


@dataclass
class Plan:
    no: int
    kind: str  # playbook | script
    job_name: str
    steps: list[str]
    head: list[Line] = field(default_factory=list)
    error: str | None = None
    targets: list[Target] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    ssh_key: str = ""
    key_name: str = ""
    # playbook jobs
    repo: dict[str, Any] = field(default_factory=dict)
    book: str = ""
    extra_vars: dict[str, Any] = field(default_factory=dict)
    # script jobs
    script: list[dict[str, str]] = field(default_factory=list)
    files: list[dict[str, str]] = field(default_factory=list)
    service_path: str = ""
    variables: dict[str, str] = field(default_factory=dict)
    # both
    env_label: str = ""
    env_vars: list[list[str]] | None = None
    env_path: str = ""
    registries: list[Registry] = field(default_factory=list)
    done_label: str = ""
    secrets: list[str] = field(default_factory=list)


def _registry_rows(db: Session, job: dict) -> list[m.Registry]:
    """Registries with a pull token for the job's images (main and extra), one per host."""
    refs = ([job["image"]] if job.get("image") else []) + [x["ref"] for x in job.get("extraImages") or []]
    out: dict[str, m.Registry] = {}
    for ref in refs:
        host = ref.split("/")[0]
        if host in out:
            continue
        img = db.get(m.Image, ref)
        reg = db.get(m.Registry, img.registry_id) if img and img.registry_id else None
        reg = reg or db.scalar(select(m.Registry).where(m.Registry.host == host).order_by(m.Registry.ord).limit(1))
        if reg and reg.has_secret:
            out[host] = reg
    return list(out.values())


def script_steps(job: dict, has_env: bool, has_registry: bool) -> list[str]:
    names = ["준비", "서버 연결"]
    if job.get("files"):
        names.append("파일 올리기")
    if has_env:
        names.append(".env 전송")
    if has_registry:
        names.append("레지스트리 로그인")
    return names + [st["name"] for st in job.get("script") or []] + ["마무리"]


def step_names(db: Session, job: dict) -> list[str]:
    if job.get("script") is None:
        return list(PLAYBOOK_STEPS)
    return script_steps(job, bool(job.get("env")), bool(_registry_rows(db, job)))


def build_plan(db: Session, job: dict, groups: list[str], no: int, tag: str, head: list[Line]) -> Plan:
    """Everything the run needs, with secrets decrypted. Problems end up in `plan.error`."""
    from . import runner  # imported here: runner imports this module at load time

    kind = "script" if job.get("script") is not None else "playbook"
    plan = Plan(no=no, kind=kind, job_name=job["name"], steps=step_names(db, job), head=head)
    try:
        _fill(db, plan, job, groups, tag, runner)
    except PlanError as e:
        plan.error = str(e)
    except crypto.CryptoError as e:
        plan.error = f"암호화된 키나 환경 변수를 풀지 못했어요: {e}"
    plan.secrets = sorted({x for x in plan.secrets if x and len(x) >= 4}, key=len, reverse=True)
    return plan


def _fill(db: Session, plan: Plan, job: dict, groups: list[str], tag: str, runner) -> None:
    inv = db.scalar(select(m.Inventory).where(m.Inventory.name == job["inventory"]))
    if not inv:
        raise PlanError(f"인벤토리 {job['inventory']}을(를) 찾을 수 없어요.")
    key = db.scalar(select(m.Key).where(m.Key.name == inv.key, m.Key.kind == "ssh"))
    if not key or not key.has_secret:
        raise PlanError(f"인벤토리 {inv.name}의 SSH 키 {inv.key}를 찾을 수 없어요.")
    plan.ssh_key, plan.key_name = key.get_secret() or "", key.name
    key.last_used = time.strftime("%Y-%m-%d %H:%M")
    for h in inv.hosts:
        if groups and h.grp not in groups:
            continue
        reason = s.host_skip(h.to_dict())
        if reason:
            plan.skipped.append((h.name, reason))
        else:
            plan.targets.append(Target(h.id, h.name, h.ip, h.port, h.ssh_user, h.grp, h.host_fingerprint))
    if not plan.targets:
        raise PlanError("배포할 수 있는 서버가 없어요.")

    env = db.scalar(select(m.EnvSet).where(m.EnvSet.name == job["env"])) if job.get("env") else None
    if job.get("env") and not env:
        raise PlanError(f"환경 변수 {job['env']}을(를) 찾을 수 없어요.")
    if env:
        plan.env_vars = env.get_vars()
        plan.env_label = f"{env.name} v{env.ver}"
        plan.secrets += [v for _, v in plan.env_vars]

    plan.registries = [Registry(host=r.host, user=r.user, password=r.get_secret() or "") for r in _registry_rows(db, job)]
    plan.secrets += [r.password for r in plan.registries]
    plan.done_label = f"{job['image'].split('/')[-1]}:{tag}" if job.get("image") else runner.method_label(job)

    if plan.kind == "script":
        row = db.get(m.Job, job["id"])
        plan.script = list(job["script"] or [])
        plan.files = [dict(f) for f in (row.files if row else None) or []]
        plan.variables = runner.script_env(job, tag, bool(env))
        plan.service_path = plan.variables["SERVICE_PATH"]
        plan.env_path = plan.variables.get("ENV_FILE", "")
        return

    pb = job["playbook"]
    repo = db.scalar(select(m.Repo).where(m.Repo.name == pb["repo"]))
    if not repo:
        raise PlanError(f"플레이북 레포 {pb['repo']}을(를) 찾을 수 없어요.")
    if not s.PLAYBOOK_PATH_RE.match(pb["path"] or ""):
        raise PlanError(f"플레이북 경로를 확인해 주세요: {pb['path']}")
    plan.book = pb["path"]
    plan.repo = {"name": repo.name, "kind": repo.kind, "url": repo.url, "branch": repo.branch, "auth": repo.auth}
    if repo.kind == "git":
        key_name = repo.auth.split(" · ", 1)[1] if " · " in repo.auth else ""
        if key_name:
            k = db.scalar(select(m.Key).where(m.Key.name == key_name))
            if not k or not k.has_secret:
                raise PlanError(f"레포 {repo.name}에 쓰는 키 {key_name}를 찾을 수 없어요.")
            secret = k.get_secret() or ""
            if k.kind == "ssh":
                plan.repo["ssh_key"] = secret
            else:
                user = k.fingerprint.split(" · ")[0].strip()
                plan.repo["token"], plan.repo["token_user"] = secret, (user if user and user != "-" else "git")
                plan.secrets.append(secret)
    xv: dict[str, Any] = runner.extra_vars(job, tag, bool(env))
    if plan.registries:
        main = next((r for r in plan.registries if job.get("image") and job["image"].startswith(r.host + "/")), plan.registries[0])
        xv.update(registry_host=main.host, registry_user=main.user, registry_password=main.password)
    plan.extra_vars = xv
    plan.env_path = xv.get("env_file", "")


# ---------- small pure helpers (unit tested) ----------

def mask(text: str, secrets: list[str]) -> str:
    for x in secrets:
        if x in text:
            text = text.replace(x, MASK)
    return text


def classify(line: str) -> str:
    """Log colour for a line of ansible-playbook output."""
    t = line.strip()
    if t.startswith(("PLAY [", "TASK [", "PLAY RECAP", "RUNNING HANDLER [")):
        return "h"
    if re.search(r"\bok=\d+", t):  # a recap row
        bad = re.search(r"\b(unreachable|failed)=([1-9]\d*)", t)
        return "r" if bad else "g"
    if t.startswith(("fatal:", "failed:", "ERROR!", "[ERROR]")) or "UNREACHABLE!" in t:
        return "r"
    if t.startswith(("changed:", "skipping:", "[WARNING]", "[DEPRECATION WARNING]", "...ignoring")):
        return "y"
    if t.startswith("ok:"):
        return "g"
    return ""


def inventory_name(name: str) -> str:
    """A host name safe for an Ansible inventory and --limit."""
    return re.sub(r"[^A-Za-z0-9._-]", "-", name) or "host"


def inventory(targets: list[Target]) -> dict[str, Any]:
    groups: dict[str, dict[str, Any]] = {}
    for t in targets:
        hosts = groups.setdefault(t.group, {"hosts": {}})["hosts"]
        hosts[inventory_name(t.name)] = {"ansible_host": t.ip, "ansible_port": t.port, "ansible_user": t.user}
    return {"all": {"children": groups}}


def known_hosts_line(ip: str, port: int, key: asyncssh.SSHKey) -> str:
    alg, blob = key.export_public_key("openssh").decode().split()[:2]
    host = ip if port == 22 else f"[{ip}]:{port}"
    return f"{host} {alg} {blob}"


def env_file_text(vars_: list[list[str]]) -> str:
    """KEY=value lines for docker compose / --env-file. Values that need it are double-quoted."""
    out = []
    for k, v in vars_:
        if re.search(r"[\s#\"'\\$]", v) or v != v.strip():
            v = '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
        out.append(f"{k}={v}")
    return "\n".join(out) + "\n"


def safe_remote_path(base: str, rel: str) -> str:
    """base/rel, refusing anything that would leave base."""
    parts = PurePosixPath(rel).parts
    if not parts or PurePosixPath(rel).is_absolute() or any(p in ("", ".", "..") for p in parts):
        raise ValueError(f"올릴 수 없는 파일 경로예요: {rel}")
    return str(PurePosixPath(base, *parts))


def script_text(variables: dict[str, str], run: str) -> str:
    exports = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in variables.items())
    return f"set -e\n{exports}{run}\n"


# ---------- the run ----------

class Out:
    """Emits events for one run, with secrets masked."""

    def __init__(self, plan: Plan):
        from . import runner

        self.plan, self.runner = plan, runner
        self.cur, self.next, self.t0 = -1, 0, time.time()
        self.failed = False

    def line(self, cls: str, text: str) -> None:
        self.runner._emit(self.plan.no, {"t": "line", "c": cls, "text": mask(text, self.plan.secrets), "ts": s.now_hms()})

    def start(self, name: str) -> int:
        """Steps run in order; names can repeat (two script steps called the same), so look from the last one on."""
        i = self.plan.steps.index(name, self.next)
        self.cur, self.next, self.t0 = i, i + 1, time.time()
        self.runner._emit(self.plan.no, {"t": "step", "i": i, "state": "run"})
        return i

    def end(self, name: str, ok: bool = True) -> None:
        i = self.cur
        d = f"{time.time() - self.t0:.1f}s"
        self.runner._emit(self.plan.no, {"t": "step", "i": i, "state": "ok" if ok else "bad", "d": d})
        if not ok:
            self.failed = True


def _base_env(tmp: Path) -> dict[str, str]:
    """A minimal environment for child processes: nothing of Wharfline's own (DB url, master key path)."""
    home = tmp / "home"
    home.mkdir(mode=0o700, exist_ok=True)
    keep = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT")}
    return {**keep, "HOME": str(home), "TMPDIR": str(tmp), "PYTHONUNBUFFERED": "1", "GIT_TERMINAL_PROMPT": "0"}


def _write_secret(path: Path, text: str) -> Path:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", newline="\n") as f:
        f.write(text if text.endswith("\n") else text + "\n")
    return path


async def _stream(argv: list[str], out: Out, cwd: Path, env: dict[str, str], colour=classify, prefix: str = "") -> int:
    """Run a process, stream stdout+stderr into the log, return its exit code. Killed if the run is cancelled."""
    kw: dict[str, Any] = {"start_new_session": True} if os.name == "posix" else {}
    proc = await asyncio.create_subprocess_exec(*argv, cwd=str(cwd), env=env, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                                                limit=LINE_LIMIT, **kw)
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            text = raw.decode(errors="replace").rstrip("\r\n")
            if text.strip():
                out.line(colour(text), prefix + text)
        return await proc.wait()
    finally:
        if proc.returncode is None:
            try:
                if os.name == "posix":
                    os.killpg(proc.pid, signal.SIGTERM)
                else:
                    proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                proc.kill()


async def _capture(argv: list[str], cwd: Path, env: dict[str, str]) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(*argv, cwd=str(cwd), env=env, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.DEVNULL)
    stdout, _ = await proc.communicate()
    return proc.returncode or 0, stdout.decode(errors="replace").strip()


def _save_host(host_id: int, **values: Any) -> None:
    with SessionLocal() as db:
        h = db.get(m.Host, host_id)
        if h:
            for k, v in values.items():
                setattr(h, k, v)
            db.commit()


async def _host_key(t: Target) -> asyncssh.SSHKey:
    key = await asyncio.wait_for(asyncssh.get_server_host_key(t.ip, t.port, server_host_key_algs=HOST_KEY_ALGS), CONNECT_TIMEOUT)
    if key is None:
        raise OSError("호스트 키를 보내지 않았어요")
    return key


async def verify_hosts(plan: Plan, out: Out) -> list[tuple[Target, asyncssh.SSHKey]]:
    """Read each server's host key and compare it with the pinned one; lock the servers that pass."""
    async def one(t: Target):
        try:
            return t, await _host_key(t), None
        except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
            return t, None, ("연결 시간 초과" if isinstance(e, asyncio.TimeoutError) else str(e) or type(e).__name__)

    ok: list[tuple[Target, asyncssh.SSHKey]] = []
    for t, key, err in await asyncio.gather(*(one(t) for t in plan.targets)):
        if key is None:
            out.line("r", f"unreachable: [{t.name}] {t.user}@{t.addr} · {err}")
            continue
        fp = key.get_fingerprint("sha256")
        if t.fingerprint and fp != t.fingerprint:
            _save_host(t.id, host_key="changed")
            out.line("r", f"failed: [{t.name}] 호스트 키가 바뀌었어요 ({fp}, 저장된 키 {t.fingerprint}). "
                          "서버를 다시 설치한 게 맞으면 인벤토리에서 새 키를 승인해 주세요.")
            continue
        if not t.fingerprint:
            _save_host(t.id, host_fingerprint=fp)
            out.line("y", f"ok: [{t.name}] {t.user}@{t.addr} · 호스트 키를 처음 저장했어요 ({fp})")
        else:
            out.line("g", f"ok: [{t.name}] {t.user}@{t.addr} · 호스트 키 확인됨 ({fp})")
        holder = BUSY.get(t.addr)
        if holder is not None and holder != plan.no:
            out.line("r", f"failed: [{t.name}] 실행 #{holder}이(가) 이 서버에 배포하는 중이에요. 끝난 뒤 다시 실행해 주세요.")
            continue
        BUSY[t.addr] = plan.no
        ok.append((t, key))
    for name, reason in plan.skipped:
        out.line("y", f"skipping: [{name}] {reason}")
    return ok


def _release(plan: Plan) -> None:
    for addr, no in list(BUSY.items()):
        if no == plan.no:
            del BUSY[addr]


async def execute(plan: Plan) -> None:
    """The background task of a real run. Always ends the run (ok / bad); a cancel ends it from runner.cancel_run."""
    from . import runner

    out = Out(plan)
    tmp = Path(tempfile.mkdtemp(prefix=f"wharfline-run-{plan.no}-"))
    status = "bad"
    try:
        out.start("준비")
        for cls, text in plan.head:
            out.line(cls, text)
        if plan.error:
            out.line("r", f"✘ {plan.error}")
            out.end("준비", False)
        else:
            out.end("준비")
            ok = await (_run_playbook(plan, out, tmp) if plan.kind == "playbook" else _run_script(plan, out))
            status = "ok" if ok else "bad"
    except asyncio.CancelledError:
        status = "cancel"
    except Exception as e:  # noqa: BLE001 - any runner bug must still end the run
        out.line("r", f"✘ 실행기 오류: {type(e).__name__}: {e}")
    finally:
        _release(plan)
        shutil.rmtree(tmp, ignore_errors=True)
        if status != "cancel":
            runner._finish(plan.no, status)


# ---------- playbook jobs ----------

async def _fetch(plan: Plan, out: Out, tmp: Path, env: dict[str, str]) -> Path | None:
    repo, dest = plan.repo, tmp / "src"
    if repo["kind"] == "builtin":
        src = Path(repo["url"]) if Path(repo["url"]).is_dir() else BUILTIN_FALLBACK
        out.line("", f"Wharfline 기본 플레이북 {plan.book}: 이미지를 .env와 함께 컨테이너로 띄워요")
        shutil.copytree(src, dest)
    elif repo["kind"] == "local":
        if not Path(repo["url"]).is_dir():
            out.line("r", f"✘ 로컬 경로가 없어요: {repo['url']} (backend 컨테이너 안의 경로여야 해요)")
            return None
        out.line("", f"로컬 경로: {repo['url']} → 작업 폴더로 복사 (실행 후 삭제)")
        shutil.copytree(repo["url"], dest, symlinks=True)
    else:
        genv = dict(env)
        if repo.get("ssh_key"):
            key = _write_secret(tmp / "git_key", repo["ssh_key"])
            genv["GIT_SSH_COMMAND"] = (f"ssh -i {shlex.quote(str(key))} -o IdentitiesOnly=yes -o BatchMode=yes "
                                       f"-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={shlex.quote(str(tmp / 'git_known_hosts'))}")
        if repo.get("token"):
            basic = base64.b64encode(f"{repo['token_user']}:{repo['token']}".encode()).decode()
            plan.secrets.append(basic)
            genv.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.extraHeader", GIT_CONFIG_VALUE_0=f"Authorization: Basic {basic}")
        out.line("", f"$ git clone --depth 1 --branch {repo['branch']} {repo['url']}   # {repo['auth']}")
        rc = await _stream(["git", "clone", "--depth", "1", "--single-branch", "--branch", repo["branch"], "--", repo["url"], str(dest)],
                           out, tmp, genv, colour=lambda t: "r" if t.startswith(("fatal:", "error:")) else "")
        if rc != 0:
            out.line("r", f"✘ 저장소를 받지 못했어요 (git 종료 코드 {rc}). 주소, 브랜치, 키/토큰 권한을 확인해 주세요.")
            return None
        _, head = await _capture(["git", "rev-parse", "--short", "HEAD"], dest, env)
        if head:
            out.line("", f"HEAD → {head}")
            with SessionLocal() as db:
                r = db.scalar(select(m.Repo).where(m.Repo.name == repo["name"]))
                if r:
                    r.commit = head[:64]
                    db.commit()
    book = dest / plan.book
    if not book.is_file():
        out.line("r", f"✘ 저장소에 {plan.book} 파일이 없어요.")
        return None
    out.line("g", f"✓ {plan.book} 확인")
    return dest


async def _run_playbook(plan: Plan, out: Out, tmp: Path) -> bool:
    env = _base_env(tmp)
    out.start("플레이북 가져오기")
    if shutil.which("ansible-playbook", path=env.get("PATH")) is None:
        out.line("r", "✘ 실행기에 ansible-playbook이 없어요. backend 이미지에 ansible-core를 설치해 주세요.")
        out.end("플레이북 가져오기", False)
        return False
    if shutil.which("git", path=env.get("PATH")) is None and plan.repo["kind"] == "git":
        out.line("r", "✘ 실행기에 git이 없어요.")
        out.end("플레이북 가져오기", False)
        return False
    src = await _fetch(plan, out, tmp, env)
    out.end("플레이북 가져오기", src is not None)
    if src is None:
        return False

    out.start("서버 연결")
    alive = await verify_hosts(plan, out)
    missing = len(plan.targets) - len(alive)  # unreachable or a changed host key: the deploy carries on, but fails
    out.end("서버 연결", not missing)
    if not alive:
        out.line("r", "✘ 연결할 수 있는 서버가 없어요.")
        return False

    out.start("플레이북 실행")
    key = _write_secret(tmp / "ssh_key", plan.ssh_key)
    kh = tmp / "known_hosts"
    kh.write_text("".join(known_hosts_line(t.ip, t.port, k) + "\n" for t, k in alive))
    inv = tmp / "inventory.yml"
    inv.write_text(json.dumps(inventory([t for t, _ in alive]), ensure_ascii=False))
    xv = dict(plan.extra_vars)
    if plan.env_vars is not None:
        xv["env_src"] = str(_write_secret(tmp / "app.env", env_file_text(plan.env_vars)))
    vars_file = _write_secret(tmp / "vars.json", json.dumps(xv, ensure_ascii=False))
    (tmp / "cp").mkdir(mode=0o700)
    limit = ",".join(inventory_name(t.name) for t, _ in alive)
    env.update(
        ANSIBLE_HOST_KEY_CHECKING="True",
        ANSIBLE_SSH_ARGS=(f"-o UserKnownHostsFile={kh} -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes "
                          "-o ControlMaster=auto -o ControlPersist=60s"),
        ANSIBLE_SSH_CONTROL_PATH_DIR=str(tmp / "cp"),
        ANSIBLE_LOCAL_TEMP=str(tmp / "ansible-local"),
        ANSIBLE_NOCOLOR="1",
        ANSIBLE_FORCE_COLOR="0",
        ANSIBLE_RETRY_FILES_ENABLED="0",
        ANSIBLE_STDOUT_CALLBACK="default",
        ANSIBLE_PRIVATE_KEY_FILE=str(key),
    )
    shown = " ".join(f"-e {k}={v}" for k, v in xv.items() if k not in ("registry_password", "env_src"))
    out.line("", f"$ ansible-playbook {plan.book} -i <임시 인벤토리> --limit {limit} {shown}")
    rc = await _stream(["ansible-playbook", plan.book, "-i", str(inv), "--limit", limit, "-e", f"@{vars_file}",
                        "--private-key", str(key)], out, src, env)
    out.end("플레이북 실행", rc == 0)

    out.start("마무리")
    names = ", ".join(t.name for t, _ in alive)
    out.line("", f"잠금 해제: {names}")
    ok = rc == 0 and not missing
    if ok:
        out.line("g", f"✔ 배포 성공 · {plan.done_label} · 서버 {len(alive)}대")
    elif rc == 0:
        out.line("r", f"✘ 배포 실패 · 서버 {len(alive)}대에는 배포했지만 {missing}대에 연결하지 못했어요")
    else:
        out.line("r", f"✘ 배포 실패 · ansible-playbook 종료 코드 {rc}")
    out.end("마무리", ok)
    return ok


# ---------- SSH script jobs ----------

async def _connect(plan: Plan, t: Target, host_key: asyncssh.SSHKey) -> asyncssh.SSHClientConnection:
    client_key = asyncssh.import_private_key(plan.ssh_key)
    return await asyncio.wait_for(asyncssh.connect(
        t.ip, t.port, username=t.user, client_keys=[client_key], known_hosts=([host_key], [], []), agent_path=None,
        preferred_auth="publickey", server_host_key_algs=HOST_KEY_ALGS, config=[],
    ), CONNECT_TIMEOUT)


async def _remote(conn: asyncssh.SSHClientConnection, out: Out, t: Target, command: str, stdin: str | None = None,
                  echo: bool = True) -> int:
    """Run a command on one server, streaming its output (prefixed with the server name)."""
    async with conn.create_process(command, stderr=asyncssh.STDOUT, errors="replace") as proc:
        if stdin is not None:
            proc.stdin.write(stdin)
        proc.stdin.write_eof()
        async for raw in proc.stdout:
            text = raw.rstrip("\r\n")
            if echo and text.strip():
                out.line("", f"  [{t.name}] {text}")
        await proc.wait()
        return proc.exit_status if proc.exit_status is not None else 255


def upload_error(what: str, path: str, user: str, e: asyncssh.SFTPError) -> ValueError:
    """Which upload step failed, on which path, and as whom: "Permission denied" alone doesn't say."""
    msg = f"{path} {what} 실패: {e.reason or type(e).__name__}"
    if isinstance(e, asyncssh.SFTPPermissionDenied):
        msg += (f" · {user} 사용자에게 이 경로의 쓰기 권한이 없어요. 서버에서 "
                f"`ls -ld {shlex.quote(path)}`로 소유자를 확인하고, 필요하면 "
                f"`sudo chown -R {user} {shlex.quote(path)}`로 바꿔 주세요.")
    return ValueError(msg)


async def _upload(conn: asyncssh.SSHClientConnection, path: str, content: str, mode: int, user: str) -> None:
    folder = str(PurePosixPath(path).parent)
    async with conn.start_sftp_client() as sftp:
        try:
            await sftp.makedirs(folder, exist_ok=True)
        except asyncssh.SFTPError as e:
            raise upload_error("폴더 만들기", folder, user, e) from e
        try:
            async with sftp.open(path, "w", asyncssh.SFTPAttrs(permissions=mode)) as f:
                await f.write(content)
            await sftp.chmod(path, mode)
        except asyncssh.SFTPError as e:
            # Writing into a folder that exists: the folder or the old file belongs to someone else.
            raise upload_error("파일 쓰기", path, user, e) from e


SHELL = "sh -c 'if command -v bash >/dev/null 2>&1; then exec bash -s; else exec sh -s; fi'"


async def _run_script(plan: Plan, out: Out) -> bool:
    tally: dict[str, dict[str, int]] = {}
    conns: dict[str, asyncssh.SSHClientConnection] = {}
    alive: list[Target] = []
    failed_at: str | None = None

    def bump(t: Target, what: str) -> None:
        tally.setdefault(t.name, {"ok": 0, "failed": 0, "skipped": 0})[what] += 1

    def header(step: str, title: str) -> None:
        """Start a step: its lines follow."""
        out.start(step)
        out.line("h", f"TASK [{title}] " + "*" * max(4, 40 - len(title)))

    async def each(name: str, fn) -> bool:
        """Run fn(target, conn) on every live server at once; a server that fails is dropped. Ends the step."""
        nonlocal alive, failed_at
        targets = list(alive)

        async def one(t: Target):
            try:
                return t, await fn(t, conns[t.name]), None
            except (OSError, asyncssh.Error, ValueError) as e:
                return t, False, str(e) or type(e).__name__

        results = await asyncio.gather(*(one(t) for t in targets))
        bad = False
        for t, ok, err in results:
            if ok:
                out.line("g", f"ok: [{t.name}]")
                bump(t, "ok")
            else:
                out.line("r", f"failed: [{t.name}]" + (f" {err}" if err else ""))
                bump(t, "failed")
                alive.remove(t)
                bad = True
        for t in plan.targets:
            if t.name in conns and t not in targets:
                out.line("y", f"skipping: [{t.name}] 앞 단계가 실패했어요")
                bump(t, "skipped")
        if bad:
            failed_at = failed_at or name
        out.end(name, not bad)
        return bool(alive)

    try:
        out.start("서버 연결")
        out.line("h", "TASK [SSH 연결] " + "*" * 30)
        for t, hk in await verify_hosts(plan, out):
            try:
                conns[t.name] = await _connect(plan, t, hk)
                alive.append(t)
                bump(t, "ok")
            except asyncssh.PermissionDenied:
                out.line("r", f"failed: [{t.name}] {t.user} 사용자로 로그인하지 못했어요 (키 {plan.key_name}). authorized_keys를 확인해 주세요.")
            except (OSError, asyncio.TimeoutError, asyncssh.Error) as e:
                out.line("r", f"failed: [{t.name}] SSH 연결 실패: {str(e) or type(e).__name__}")
        out.line("", "환경 변수: " + " ".join(f"{k}={v}" for k, v in plan.variables.items()))
        out.end("서버 연결", bool(alive))
        if not alive:
            out.start("마무리")
            out.line("r", "✘ 배포 실패 · 연결할 수 있는 서버가 없어요")
            out.end("마무리", False)
            return False

        if plan.files and "파일 올리기" in plan.steps:
            header("파일 올리기", f"파일 올리기 → {plan.service_path} ({len(plan.files)}개)")
            for f in plan.files[:8]:
                out.line("", f"  {f['path']}")

            async def upload_files(t, conn):
                for f in plan.files:
                    await _upload(conn, safe_remote_path(plan.service_path, f["path"]), f["content"], 0o644, t.user)
                return True

            await each("파일 올리기", upload_files)

        if plan.env_vars is not None and ".env 전송" in plan.steps and alive:
            header(".env 전송", f"Upload .env → {plan.env_path} ({plan.env_label})")
            text = env_file_text(plan.env_vars)
            for k, _ in plan.env_vars[:3]:
                out.line("m", f"  {k}={MASK}")

            async def upload_env(t, conn):
                await _upload(conn, plan.env_path, text, 0o600, t.user)
                return True

            await each(".env 전송", upload_env)

        if plan.registries and "레지스트리 로그인" in plan.steps and alive:
            header("레지스트리 로그인", "레지스트리 로그인 (읽기 전용 토큰, 스크립트에 노출하지 않아요)")

            async def login(t, conn):
                for r in plan.registries:
                    rc = await _remote(conn, out, t, f"docker login {shlex.quote(r.host)} -u {shlex.quote(r.user)} --password-stdin",
                                       stdin=r.password + "\n")
                    if rc != 0:
                        raise ValueError(f"docker login {r.host} 실패 (종료 코드 {rc})")
                return True

            await each("레지스트리 로그인", login)

        for st in plan.script:
            if not alive:
                out.start(st["name"])
                for t in plan.targets:
                    if t.name in conns:
                        out.line("y", f"skipping: [{t.name}] 앞 단계가 실패했어요")
                        bump(t, "skipped")
                out.end(st["name"], True)
                continue
            header(st["name"], st["name"])
            for cmd in [c for c in st["run"].splitlines() if c.strip()][:6]:
                out.line("", f"$ {cmd}")
            body = script_text(plan.variables, st["run"])

            async def step(t, conn, body=body):
                rc = await _remote(conn, out, t, SHELL, stdin=body)
                if rc != 0:
                    raise ValueError(f"exit {rc}")
                return True

            await each(st["name"], step)

        out.start("마무리")
        if plan.registries:
            out.line("h", "TASK [레지스트리 로그아웃] " + "*" * 24)
            for t in plan.targets:
                conn = conns.get(t.name)
                if conn:
                    for r in plan.registries:
                        await _remote(conn, out, t, f"docker logout {shlex.quote(r.host)}", echo=False)
                    out.line("g", f"ok: [{t.name}]")
        out.line("h", "PLAY RECAP " + "*" * 30)
        for t in plan.targets:
            x = tally.get(t.name)
            if x is None:
                out.line("r", f"{t.name:<14}: unreachable")
                continue
            out.line("r" if x["failed"] else "g", f"{t.name:<14}: ok={x['ok']}  failed={x['failed']}  skipped={x['skipped']}")
        for name, reason in plan.skipped:
            out.line("y", f"{name:<14}: unreachable · {reason}")
        out.line("", "잠금 해제: " + ", ".join(conns))
        bad = [n for n, x in tally.items() if x["failed"]] + [t.name for t in plan.targets if t.name not in tally]
        if bad:
            out.line("r", f"✘ 배포 실패 · {('“' + failed_at + '” 단계에서 ') if failed_at else ''}서버 {len(bad)}대 실패")
        else:
            out.line("g", f"✔ 배포 성공 · {plan.done_label} · 서버 {len(alive)}대")
        out.end("마무리", not bad)
        return not bad
    finally:
        for conn in conns.values():
            conn.close()
