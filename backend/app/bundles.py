"""File bundles for SSH script jobs: a docker-compose.yaml, or a zip of files (a Kubernetes yaml set, a Makefile...).

The files are stored with the job and uploaded to SERVICE_PATH before the script runs. Only text files
are kept. A `.env` file is never stored: its variables move to the job's environment variables instead.
"""

from __future__ import annotations

import io
import re
import stat
import zipfile

from fastapi import HTTPException

MAX_FILES = 200
MAX_FILE_BYTES = 512 * 1024
MAX_TOTAL_BYTES = 2 * 1024 * 1024
MAX_UPLOAD_BYTES = 5 * 1024 * 1024  # the zip itself
PART_RE = re.compile(r"^[A-Za-z0-9._@+-]{1,128}$")
SKIP_PARTS = {"__MACOSX", ".git"}
SKIP_NAMES = {".DS_Store", "Thumbs.db"}
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Settings that hand a container (or pod) control of the server. Shown as warnings: they can be on purpose.
RISKY: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"privileged:\s*true"), "privileged: true (컨테이너가 서버 전체 권한을 가져요)"),
    (re.compile(r"docker\.sock"), "docker.sock 마운트 (서버의 Docker를 마음대로 쓸 수 있어요)"),
    (re.compile(r"network_mode:\s*[\"']?host"), "network_mode: host"),
    (re.compile(r"pid:\s*[\"']?host"), "pid: host"),
    (re.compile(r"cap_add:"), "cap_add (추가 권한)"),
    (re.compile(r"hostPath:"), "hostPath (서버 디스크를 직접 마운트해요)"),
    (re.compile(r"hostNetwork:\s*true"), "hostNetwork: true"),
    (re.compile(r"hostPID:\s*true"), "hostPID: true"),
]


def clean_path(raw: str) -> str | None:
    """A safe relative path inside SERVICE_PATH, or None if the path can't be used."""
    p = raw.replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    if not p or p.startswith("/") or "\x00" in p:
        return None
    parts = [x for x in p.split("/") if x]
    if not parts or any(x in (".", "..") or not PART_RE.match(x) for x in parts):
        return None
    return "/".join(parts)


def is_env_file(path: str) -> bool:
    return path.rsplit("/", 1)[-1] == ".env"


def parse_env(text: str) -> list[list[str]]:
    """KEY=VALUE lines (comments, `export`, quotes allowed), like the web form's .env parser."""
    out: list[list[str]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, sep, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if not sep or not ENV_KEY_RE.match(key):
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out.append([key, value])
    return out


def risky_warnings(path: str, content: str) -> list[dict[str, str]]:
    return [{"path": path, "message": msg} for rx, msg in RISKY if rx.search(content)]


def _strip_common_root(entries: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    """A zip of a folder ("k8s/01_ns.yaml", "k8s/02_...") keeps the files, not the folder."""
    roots = {p.split("/", 1)[0] for p, _ in entries}
    if len(roots) == 1 and all("/" in p for p, _ in entries):
        return [(p.split("/", 1)[1], b) for p, b in entries]
    return entries


def parse_upload(name: str, data: bytes, playbook: bool = False) -> dict:
    """Read an uploaded file or zip. Returns files to keep, .env variables, dropped entries and warnings.

    playbook: an Ansible playbook set. A .env is left out instead of becoming environment variables,
    and so is anything that looks like a private key (a zip or folder of a repo can carry one).
    """
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "파일이 너무 커요. 5MB까지 올릴 수 있어요.")
    entries: list[tuple[str, bytes]] = []
    dropped: list[dict[str, str]] = []
    if name.lower().endswith(".zip"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as e:
            raise HTTPException(400, "zip 파일을 열 수 없어요.") from e
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES * 2:
            raise HTTPException(400, f"zip 안의 파일이 너무 많아요. {MAX_FILES}개까지 올릴 수 있어요.")
        for info in infos:
            parts = info.filename.replace("\\", "/").split("/")
            if SKIP_PARTS & set(parts) or parts[-1] in SKIP_NAMES:
                continue
            if stat.S_ISLNK(info.external_attr >> 16):
                dropped.append({"path": info.filename, "reason": "링크 파일은 올릴 수 없어요"})
                continue
            if info.file_size > MAX_FILE_BYTES:
                dropped.append({"path": info.filename, "reason": "512KB가 넘는 파일이에요"})
                continue
            # Windows zip tools (PowerShell Compress-Archive) write "folder\file": use / so the folder is stripped
            entries.append((info.filename.replace("\\", "/"), zf.read(info)))
        entries = _strip_common_root(entries)
    else:
        entries = [(name.replace("\\", "/").rsplit("/", 1)[-1], data)]
    return _keep(entries, dropped, playbook)


def parse_folder(entries: list[tuple[str, bytes]], playbook: bool = False) -> dict:
    """A folder picked in the browser: (relative path, bytes) per file, each path starting with the folder name."""
    if len(entries) > MAX_FILES * 2:
        raise HTTPException(400, f"폴더 안의 파일이 너무 많아요. {MAX_FILES}개까지 올릴 수 있어요.")
    if sum(len(b) for _, b in entries) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "폴더가 너무 커요. 모두 합쳐 5MB까지 올릴 수 있어요.")
    kept: list[tuple[str, bytes]] = []
    dropped: list[dict[str, str]] = []
    for raw, blob in entries:
        parts = raw.replace("\\", "/").split("/")
        if SKIP_PARTS & set(parts) or parts[-1] in SKIP_NAMES:
            continue
        if len(blob) > MAX_FILE_BYTES:
            dropped.append({"path": raw, "reason": "512KB가 넘는 파일이에요"})
            continue
        kept.append((raw.replace("\\", "/"), blob))
    return _keep(_strip_common_root(kept), dropped, playbook)


PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")


def _keep(entries: list[tuple[str, bytes]], dropped: list[dict[str, str]], playbook: bool) -> dict:
    """The text files to keep from an upload, and what was left out and why."""
    files: list[dict] = []
    env: list[list[str]] = []
    warnings: list[dict[str, str]] = []
    total = 0
    for raw, blob in entries:
        path = clean_path(raw)
        if not path:
            dropped.append({"path": raw, "reason": "쓸 수 없는 경로예요"})
            continue
        try:
            text = blob.decode("utf-8")
        except UnicodeDecodeError:
            dropped.append({"path": path, "reason": "텍스트 파일만 올릴 수 있어요"})
            continue
        if playbook and PRIVATE_KEY.search(text):
            dropped.append({"path": path, "reason": "개인키로 보여서 올리지 않았어요"})
            continue
        if is_env_file(path):
            if playbook:
                dropped.append({"path": path, "reason": ".env는 올리지 않아요 (비밀 값은 비밀 변수에 넣어요)"})
                continue
            env += parse_env(text)
            dropped.append({"path": path, "reason": "환경 변수로 옮겼어요"})
            continue
        if len(blob) > MAX_FILE_BYTES:
            dropped.append({"path": path, "reason": "512KB가 넘는 파일이에요"})
            continue
        total += len(blob)
        if total > MAX_TOTAL_BYTES or len(files) >= MAX_FILES:
            raise HTTPException(400, f"파일이 너무 많거나 커요. {MAX_FILES}개, 모두 합쳐 2MB까지예요.")
        files.append({"path": path, "size": len(blob), "content": text})
        warnings += risky_warnings(path, text)
    files.sort(key=lambda f: f["path"])
    return {"files": files, "env": env, "dropped": dropped, "warnings": warnings}


def check_files(files: list[dict]) -> list[dict[str, str]]:
    """Validate files sent with a job save. Returns [{path, content}] sorted by path."""
    if len(files) > MAX_FILES:
        raise HTTPException(400, f"파일은 {MAX_FILES}개까지 올릴 수 있어요.")
    out: dict[str, str] = {}
    total = 0
    for f in files:
        path = clean_path(str(f.get("path", "")))
        content = str(f.get("content", ""))
        if not path:
            raise HTTPException(400, f"쓸 수 없는 파일 경로예요: {f.get('path')}")
        if is_env_file(path):
            raise HTTPException(400, ".env는 파일로 올리지 않아요. 환경 변수 단계에 넣어 주세요.")
        size = len(content.encode())
        if size > MAX_FILE_BYTES:
            raise HTTPException(400, f"{path}이(가) 512KB를 넘어요.")
        total += size
        if path in out:
            raise HTTPException(400, f"{path}이(가) 두 번 들어 있어요.")
        out[path] = content
    if total > MAX_TOTAL_BYTES:
        raise HTTPException(400, "파일은 모두 합쳐 2MB까지 올릴 수 있어요.")
    bad = image_line_problem([{"path": p, "content": c} for p, c in out.items()])
    if bad:
        raise HTTPException(400, bad)
    for path, content in out.items():
        for value in IMAGE_LINE.findall(content):
            host = value.split("/", 1)[0].lower() if "/" in value else ""
            if host in REGISTRY_TYPOS:
                raise HTTPException(400, f"{path}의 {value}: {host}는 {REGISTRY_TYPOS[host]}의 오타 같아요. 이 주소로는 이미지를 받을 수 없어요.")
    return [{"path": p, "content": out[p]} for p in sorted(out)]


def image_line_problem(files: list[dict]) -> str | None:
    """An `image:` line with something after its value (not a comment), e.g. a leftover
    ` WHARFLINE_VERSION in .env}` — docker compose would fail with "invalid reference format"."""
    for f in files:
        for n, line in enumerate(str(f.get("content", "")).splitlines(), 1):
            m = IMAGE_LINE.match(line)
            if not m:
                continue
            rest = line[m.end():]
            quote = re.match(r"""^\s*-?\s*image:\s*(["'])""", line)
            if quote and rest.startswith(quote.group(1)):
                rest = rest[1:]
            rest = rest.strip()
            if rest and not rest.startswith("#"):
                return f"{f.get('path')} {n}번째 줄의 이미지 뒤에 \"{rest}\"가 붙어 있어요. 지우거나 이미지 이름을 고쳐 주세요."
    return None


# Registry hosts that are easy to mistype; pulls from them fail on every server.
REGISTRY_TYPOS = {"ghrc.io": "ghcr.io", "gchr.io": "ghcr.io", "ghcr.com": "ghcr.io", "gcr.com": "gcr.io", "docker.com": "docker.io"}


# The value of an `image:` line; a ${...} may hold spaces (`${V:?set V in .env}`).
IMAGE_LINE = re.compile(r"""^\s*-?\s*image:\s*["']?((?:\$\{[^}\n]*\}|[^\s"'#])+)""", re.M)
# A tag that is one variable: ${V}, ${V:-default}, ${V-default}, ${V:?message}, ${V?message}.
TAG_VAR = re.compile(r"^\$\{([A-Z_][A-Z0-9_]*)(?::?[-?][^}]*)?\}$")


def split_image(value: str) -> tuple[str, str | None]:
    """(ref, tag) of an image value; colons and slashes inside ${...} don't count."""
    plain = re.sub(r"\$\{[^}]*\}", lambda m: "x" * len(m.group(0)), value)
    colon = plain.find(":", plain.rfind("/") + 1)
    return (value[:colon], value[colon + 1:]) if colon >= 0 else (value, None)


def file_images(files: list[dict]) -> list[dict]:
    """Images named on `image:` lines of compose / Kubernetes files.

    Returns [{ref, var, literal, tagVar}]: `ghcr.io/x/api:${API_TAG}` -> var "API" (IMAGE_TAG -> var "" = the main image);
    a written tag (or none) -> var None and literal = that tag ("latest" when none). Names built from variables are skipped.
    tagVar is the variable the file reads, as written: `${APP_VERSION}` -> var "APP_VERSION", tagVar "APP_VERSION".
    """
    out: list[dict] = []
    seen: set[tuple] = set()
    for f in files:
        for value in IMAGE_LINE.findall(f.get("content", "")):
            if "@" in value:
                continue
            ref, tag = split_image(value)
            if "${" in ref:
                continue
            m = TAG_VAR.match(tag or "")
            item = {"ref": ref, "var": ("" if m.group(1) == "IMAGE_TAG" else re.sub(r"_TAG$", "", m.group(1))) if m else None,
                    "literal": None if m else (tag or "latest"), "tagVar": m.group(1) if m else None}
            key = (item["ref"], item["var"], item["literal"])
            if key not in seen:
                seen.add(key)
                out.append(item)
    return out
