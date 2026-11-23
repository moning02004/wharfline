"""Read a Git repo and draft a file + script deploy job from what is in it. Rules only: no AI, no outside service.

`detect(files, url)` looks at the repo's text files (executor.read_repo_files) and returns what the job form fills in:

- a compose file (compose.yaml, docker-compose.yml …): the shallowest one, preferring deploy-ish folders. Its folder
  becomes the job's files: the compose file, its override file, and the repo files it points to (bind mounts,
  env_file, configs/secrets `file:`). A `.env` there turns into environment variables, like an upload;
  `.env.example` and friends give the variable names with their example values.
- no compose file but Kubernetes manifests: those files, and kubectl steps for them.
- playbooks or only a Dockerfile: no draft, a note on which kind of job fits instead.

The script steps are one of the job form's examples (`guide`): docker rollout when some service can be replaced
without downtime (bundles.rollout_choice), plain compose otherwise. Kubernetes gets steps of its own (`steps`).
Images the repo seems to build itself (ghcr.io/<owner>/<repo>, registry/<group>/<project>/…) come back in `own`,
so the form can make their tag a variable Wharfline fills in.
"""

from __future__ import annotations

import posixpath
import re

import yaml

from . import bundles, playinspect

# Folder names that usually hold how an app is deployed, best first. Others rank after these, then by depth.
DEPLOY_DIRS = ("", "deploy", "deployment", "docker", "infra", "ops", ".deploy", "compose")
SKIP_DIRS = {"node_modules", "vendor", "test", "tests", "testdata", "example", "examples", "fixtures", "samples", "docs"}
OVERRIDE_NAMES = ("compose.override.yaml", "compose.override.yml", "docker-compose.override.yaml", "docker-compose.override.yml")
ENV_EXAMPLES = (".env.example", ".env.sample", ".env.template", ".env.dist", ".env.defaults", "example.env", "env.example", "sample.env")
# Production compose files by name: docker-compose.prod.yml, compose.production.yaml, compose-live.yml …
PROD_RE = re.compile(r"^(docker-)?compose[.-](prod|production|prd|live|release|deploy|deployment)\.ya?ml$", re.I)
K8S_DIRS = ("k8s", "kubernetes", "manifests", "deploy", "deployment", "kube", ".k8s")
K8S_KIND = re.compile(r"^kind:\s*(Deployment|StatefulSet|DaemonSet|Service|Ingress|ConfigMap|Secret|Namespace|Job|CronJob)\b", re.M)
ROLLOUT_KINDS = ("Deployment", "StatefulSet", "DaemonSet")
MAX_REF_FILES = 60  # files one bind-mounted folder may bring along


def repo_name(url: str) -> str:
    """https://github.com/org/app.git, git@host:org/app.git → app."""
    return url.strip().rstrip("/").removesuffix(".git").replace(":", "/").rsplit("/", 1)[-1]


def repo_path(url: str) -> str:
    """The repo's owner/name part, lower case: https://github.com/Org/App.git → org/app, git@host:g/sub/p.git → g/sub/p."""
    u = url.strip().rstrip("/").removesuffix(".git")
    m = re.match(r"^[a-z+]+://(?:[^@/]+@)?[^/]+/(.+)$", u) or re.match(r"^[^@/]+@[^:/]+:(.+)$", u)
    return m.group(1).lower().strip("/") if m else ""


def own_images(refs: list[str], url: str) -> list[str]:
    """The image refs that look built from this repo: their path is the repo's owner/name (or under it)."""
    path = repo_path(url)
    if "/" not in path:
        return []
    out = []
    for ref in refs:
        first, _, rest = ref.partition("/")
        img = (rest if rest and ("." in first or ":" in first or first == "localhost") else ref).lower()
        if img == path or img.startswith(path + "/"):
            out.append(ref)
    return out


def _dir(path: str) -> str:
    return posixpath.dirname(path)


def is_prod_name(path: str) -> bool:
    return bool(PROD_RE.match(posixpath.basename(path)))


def _name_order(name: str) -> int:
    low = name.lower()
    return bundles.COMPOSE_NAMES.index(low) if low in bundles.COMPOSE_NAMES else len(bundles.COMPOSE_NAMES)


def _rank(path: str) -> tuple:
    d = _dir(path)
    top = d.split("/", 1)[0] if d else ""
    pref = DEPLOY_DIRS.index(d) if d in DEPLOY_DIRS else len(DEPLOY_DIRS)
    # A production file (compose.prod.yaml) wins over the plain one, which is often the developer's setup.
    return (0 if is_prod_name(path) else 1, d.count("/") + (1 if d else 0), pref, top, _name_order(posixpath.basename(path)), path)


def compose_candidates(paths: list[str]) -> list[str]:
    """Compose files in the repo, the likeliest deploy file first; ones under test/example folders are left out."""
    found = [p for p in paths if (bundles.is_compose_name(p) or is_prod_name(p)) and not (set(_dir(p).lower().split("/")) & SKIP_DIRS)]
    return sorted(found, key=_rank)


def _stem_ext(name: str) -> tuple[str, str]:
    """compose.prod.yaml → ("compose", ".yaml"), docker-compose-live.yml → ("docker-compose", ".yml")."""
    return ("docker-compose" if name.lower().startswith("docker-compose") else "compose"), posixpath.splitext(name)[1].lower()


def _base_of(by_path: dict[str, str], prod: str) -> str | None:
    """The plain compose file next to a production one, if there is one."""
    d = _dir(prod)
    for name in bundles.COMPOSE_NAMES:
        p = posixpath.join(d, name) if d else name
        if p in by_path:
            return p
    return None


def _is_overlay(prod_doc: dict, base_doc: dict) -> bool:
    """A production file written to go on top of the plain one (`-f compose.yml -f compose.prod.yml`):
    it has no services of its own, or one of its services has neither image nor build and comes from the plain file."""
    services = prod_doc.get("services")
    base_services = base_doc.get("services") if isinstance(base_doc.get("services"), dict) else {}
    if not isinstance(services, dict) or not services:
        return bool(base_services)
    return any(isinstance(svc, dict) and not svc.get("image") and not svc.get("build") and name in base_services
               or svc is None and name in base_services for name, svc in services.items())


def _merged_services(*docs: dict) -> dict:
    """Services of compose files read together, one level deep (enough to tell what each service is)."""
    out: dict = {}
    for doc in docs:
        for name, svc in (doc.get("services") or {}).items() if isinstance(doc.get("services"), dict) else []:
            out[name] = {**out.get(name, {}), **(svc if isinstance(svc, dict) else {})}
    return out


def _load(content: str) -> dict:
    try:
        doc = yaml.safe_load(content) or {}
    except yaml.YAMLError:
        return {}
    return doc if isinstance(doc, dict) else {}


def _referenced(doc: dict) -> tuple[list[str], list[str]]:
    """(relative paths the compose file reads from its folder, services built on the server)."""
    refs: list[str] = []
    builds: list[str] = []
    services = doc.get("services") if isinstance(doc.get("services"), dict) else {}
    for name, svc in services.items():
        if not isinstance(svc, dict):
            continue
        if svc.get("build"):
            builds.append(str(name))
        for v in svc.get("volumes") or []:
            src = v.get("source") if isinstance(v, dict) and v.get("type", "bind") == "bind" else v.split(":", 1)[0] if isinstance(v, str) else None
            if isinstance(src, str) and src.startswith("."):  # ./conf, ../shared; a bare name is a named volume
                refs.append(src)
        env_files = svc.get("env_file") or []
        for e in [env_files] if isinstance(env_files, (str, dict)) else env_files:
            p = e.get("path") if isinstance(e, dict) else e
            if isinstance(p, str):
                refs.append(p)
    for top in ("configs", "secrets"):
        for item in (doc.get(top) or {}).values() if isinstance(doc.get(top), dict) else []:
            if isinstance(item, dict) and isinstance(item.get("file"), str):
                refs.append(item["file"])
    return refs, builds


def _norm(base: str, rel: str) -> str | None:
    """rel (from the compose file's folder) as a repo path, or None when it leaves that folder."""
    joined = posixpath.normpath(posixpath.join(base, rel)) if base else posixpath.normpath(rel)
    if joined == "." or joined.startswith("../") or joined == "..":
        return None
    if base and not (joined == base or joined.startswith(base + "/")):
        return None
    return joined


def _compose_draft(by_path: dict[str, str], compose: str, url: str) -> dict:
    base = _dir(compose)
    strip = (lambda p: p[len(base) + 1:]) if base else (lambda p: p)
    content = by_path[compose]
    doc = _load(content)
    picked: dict[str, str] = {compose: content}
    saved_as: dict[str, str] = {}  # repo path → the name on the server, when it changes
    notes: list[str] = []
    docs = [doc]
    if is_prod_name(compose):
        # On the server the job runs plain `docker compose`, which reads only the standard names: the production
        # file is saved under one. The plain file's override (developer settings, mostly) is left out.
        name = posixpath.basename(compose)
        plain = _base_of(by_path, compose)
        plain_doc = _load(by_path[plain]) if plain else {}
        if plain and _is_overlay(doc, plain_doc):
            stem, ext = _stem_ext(posixpath.basename(plain))
            picked[plain] = by_path[plain]
            saved_as[compose] = f"{stem}.override{ext}"
            docs = [plain_doc, doc]
            notes.append(f"{name}은(는) {posixpath.basename(plain)} 위에 덧씌우는 파일이라 둘 다 넣고, {name}을(를) "
                         f"{saved_as[compose]}(으)로 저장해요. docker compose가 둘을 자동으로 합쳐 읽어요.")
        else:
            stem, ext = _stem_ext(name)
            saved_as[compose] = f"{stem}{ext}"
            notes.append(f"운영용 파일 {name}을(를) 골랐어요. 서버에서 docker compose가 바로 읽도록 {saved_as[compose]}(으)로 저장해요.")
        if any((posixpath.join(base, n) if base else n) in by_path for n in OVERRIDE_NAMES):
            notes.append("같은 폴더의 override 파일은 개발용으로 보고 넣지 않았어요.")
    else:
        for name in OVERRIDE_NAMES:
            p = posixpath.join(base, name) if base else name
            if p in by_path:
                picked[p] = by_path[p]
                docs.append(_load(by_path[p]))
                notes.append(f"{name}도 함께 넣었어요. docker compose가 자동으로 합쳐 읽어요.")
    refs, builds = _referenced(doc)
    for extra in [d for d in docs if d is not doc]:
        more, more_builds = _referenced(extra)
        refs += more
        builds += [b for b in more_builds if b not in builds]
    outside, missing = [], []
    for rel in dict.fromkeys(refs):
        p = _norm(base, rel)
        if p is None:
            outside.append(rel)
            continue
        if p in by_path:
            picked[p] = by_path[p]
            continue
        under = [q for q in by_path if q.startswith(p + "/")]
        if under:
            for q in under[:MAX_REF_FILES]:
                picked[q] = by_path[q]
            if len(under) > MAX_REF_FILES:
                notes.append(f"{rel} 폴더의 파일이 많아서 {MAX_REF_FILES}개만 넣었어요.")
        elif posixpath.basename(p) != ".env":
            missing.append(rel)
    env_path = posixpath.join(base, ".env") if base else ".env"
    if env_path in by_path:
        picked[env_path] = by_path[env_path]
    if outside:
        notes.append(f"배포 폴더 밖을 가리키는 경로는 넣지 않았어요: {', '.join(outside)}")
    if missing:
        notes.append(f"저장소에 없는 경로는 서버에서 만들어져요: {', '.join(missing)}")
    if builds:
        notes.append(f"{', '.join(builds)}은(는) build:로 서버에서 이미지를 만들어요. 소스는 올리지 않으니, CI에서 이미지를 만들어 image:로 바꾸는 걸 권해요.")

    kept = bundles._keep([(saved_as.get(p) or strip(p), c.encode()) for p, c in sorted(picked.items())], [], False)
    env = kept["env"]
    have = {k for k, _ in env}
    examples = [posixpath.join(base, n) if base else n for n in ENV_EXAMPLES] + ([n for n in ENV_EXAMPLES] if base else [])
    example_from = None
    for p in examples:
        if p in by_path:
            for k, v in bundles.parse_env(by_path[p]):
                if k not in have:
                    env.append([k, v])
                    have.add(k)
            example_from = example_from or p
    if example_from:
        notes.append(f"{example_from}의 변수를 환경 변수에 넣었어요. 예시 값이니 실제 값으로 바꿔 주세요.")

    services = _merged_services(*docs)
    rollout = [str(n) for n, svc in services.items() if bundles.rollout_choice(str(n), svc if isinstance(svc, dict) else {})[0]]
    named = next((d.get("name") for d in reversed(docs) if d.get("name")), None)
    folder = posixpath.basename(base)  # one app of many (apps/shop/compose.yaml): its folder names it
    refs_ = [it["ref"] for it in bundles.file_images(kept["files"])]
    return {
        "kind": "compose",
        "name": str(named) if isinstance(named, str) and "${" not in named else folder if folder not in DEPLOY_DIRS else repo_name(url),
        "composePath": compose,
        "files": kept["files"],
        "env": env,
        "guide": "rollout" if rollout else "compose",
        "steps": None,
        "rollout": rollout,
        "own": own_images(refs_, url),
        "warnings": kept["warnings"],
        "notes": notes,
    }


def _k8s_files(by_path: dict[str, str]) -> list[str]:
    yamls = [p for p in by_path if p.lower().endswith((".yaml", ".yml")) and K8S_KIND.search(by_path[p])
             and "apiVersion:" in by_path[p] and not (set(_dir(p).lower().split("/")) & SKIP_DIRS)]
    if not yamls:
        return []
    by_dir: dict[str, list[str]] = {}
    for p in yamls:
        by_dir.setdefault(_dir(p), []).append(p)
    def score(d: str) -> tuple:
        top = d.split("/", 1)[0].lower()
        return (0 if top in K8S_DIRS else 1, -len(by_dir[d]), d.count("/"), d)
    best = sorted(by_dir, key=score)[0]
    return sorted(by_dir[best])


def _k8s_draft(by_path: dict[str, str], paths: list[str], url: str) -> dict:
    base = _dir(paths[0])
    strip = (lambda p: p[len(base) + 1:]) if base else (lambda p: p)
    kept = bundles._keep([(posixpath.join("k8s", strip(p)), by_path[p].encode()) for p in paths], [], False)
    steps = [{"name": "적용", "run": 'cd "$SERVICE_PATH"\n' + "\n".join(f"envsubst < {f['path']} | kubectl apply -f -" for f in kept["files"])}]
    waits = []
    for f in kept["files"]:
        for doc in _all_docs(f["content"]):
            kind, meta = doc.get("kind"), doc.get("metadata") or {}
            if kind in ROLLOUT_KINDS and isinstance(meta, dict) and isinstance(meta.get("name"), str) and "${" not in meta["name"]:
                ns = f" -n {meta['namespace']}" if isinstance(meta.get("namespace"), str) and "${" not in meta["namespace"] else ""
                waits.append(f"kubectl rollout status {kind.lower()}/{meta['name']}{ns} --timeout=180s")
    if waits:
        steps.append({"name": "준비될 때까지 기다리기", "run": "\n".join(dict.fromkeys(waits))})
    refs = [it["ref"] for it in bundles.file_images(kept["files"])]
    return {
        "kind": "kubernetes", "name": repo_name(url), "composePath": None, "files": kept["files"], "env": [],
        "guide": "kubernetes", "steps": steps, "rollout": [], "own": own_images(refs, url), "warnings": kept["warnings"],
        "notes": [f"{base or '저장소 맨 위'}의 Kubernetes 파일 {len(kept['files'])}개를 k8s/ 아래에 넣었어요. 서버에 kubectl과 kubeconfig가 있어야 해요."],
    }


def _all_docs(text: str) -> list[dict]:
    try:
        return [d for d in yaml.safe_load_all(text) if isinstance(d, dict)]
    except yaml.YAMLError:
        return []


def detect(files: list[dict[str, str]], url: str, compose: str | None = None) -> dict:
    """The draft for a repo. `compose` picks one of the compose files instead of the likeliest one."""
    by_path = {f["path"]: f["content"] for f in files}
    candidates = compose_candidates(list(by_path))
    base = {"composeFiles": candidates, "playbooks": [], "dockerfiles": []}
    if compose and compose not in candidates:
        compose = None
    if candidates:
        return {**base, **_compose_draft(by_path, compose or candidates[0], url)}
    k8s = _k8s_files(by_path)
    if k8s:
        return {**base, **_k8s_draft(by_path, k8s, url)}
    books = playinspect.playbooks(files)[:30]
    dockerfiles = sorted(p for p in by_path if posixpath.basename(p) == "Dockerfile" or posixpath.basename(p).endswith(".Dockerfile"))
    if books:
        note = f"compose 파일은 없고 Ansible 플레이북이 {len(books)}개 있어요. 배포 방법에서 'Git 레포' 플레이북 작업으로 만들어 주세요."
        kind = "playbook"
    elif dockerfiles:
        note = "Dockerfile만 있어요. CI에서 이미지를 만들어 레지스트리에 올린 뒤, 그 이미지를 쓰는 compose 파일을 저장소에 두거나 기본 플레이북으로 띄워 주세요."
        kind = "dockerfile"
    else:
        note = "배포에 쓸 파일(compose 파일, Kubernetes yaml, 플레이북)을 찾지 못했어요."
        kind = "none"
    return {**base, "kind": kind, "name": repo_name(url), "composePath": None, "files": [], "env": [], "guide": None,
            "steps": None, "rollout": [], "own": [], "warnings": [], "notes": [note], "playbooks": books, "dockerfiles": dockerfiles}
