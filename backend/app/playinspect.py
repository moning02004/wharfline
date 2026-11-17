"""Read a playbook and tell the job form what it needs, so nobody has to know Ansible to fill it in.

- `playbooks(files)`: which .yml files in an upload (or a repo) are playbooks (a list of plays).
- `inspect(files, book)`: the variables the playbook reads but never sets (the ones to fill in), plus
  the ones its roles give a default to (optional, shown with that default), with whether each is
  required, a default, a likely secret, a yes/no switch, a description taken from the playbook's own
  comments (or the comment next to the role default), and the role it comes from (None: the playbook). A role default that is empty but checked by
  an `assert` (`x | length > 0`) counts as required. Also what the plays need (sudo, a host group) and files it copies that
  are missing from the upload.

Nothing here runs the playbook; it only reads text. Unknown or odd YAML is skipped, never an error:
the form falls back to adding variables by hand.
"""

from __future__ import annotations

import json
import posixpath
import re
from typing import Any

import yaml

MAX_TEXT = 512 * 1024

# Names Ansible or Jinja provide; never something to fill in.
MAGIC = {
    "item", "inventory_hostname", "inventory_hostname_short", "groups", "group_names", "hostvars", "play_hosts",
    "playbook_dir", "role_path", "role_name", "inventory_dir", "inventory_file", "omit", "environment", "lookup",
    "query", "q", "range", "dict", "lipsum", "cycler", "joiner", "namespace", "now", "undef", "loop", "true", "false",
    "none", "True", "False", "None", "and", "or", "not", "in", "is", "if", "else", "for", "recursive", "self", "super",
    "varargs", "kwargs", "caller", "ansible_facts", "ansible_play_hosts", "ansible_play_batch", "ansible_loop",
    "ansible_check_mode", "ansible_version", "ansible_run_tags", "ansible_skip_tags", "ansible_parent_role_names",
    "ansible_role_names", "ansible_play_name", "ansible_playbook_python", "ansible_config_file", "ansible_index_var",
    "ansible_loop_var", "ansible_search_path", "ansible_managed", "template_host", "template_path", "template_uid",
    "template_fullpath", "template_destpath", "template_run_date",
    # Jinja statement words ({% endif %}, {% elif %} …)
    "elif", "endif", "endfor", "endset", "macro", "endmacro", "block", "endblock", "with", "endwith", "filter",
    "endfilter", "call", "endcall", "include", "import", "from", "as", "extends", "raw", "endraw", "set", "ignore",
    "missing", "context", "without", "do",
}
# Wharfline passes these to every playbook (runner.extra_vars); kept in step with deploy.WHARFLINE_PLAY_VARS.
WHARFLINE = {"image", "image_tag", "image_ref", "env_file", "app_name", "registry_host", "registry_user",
             "registry_password", "env_src"}
# Keys whose value is a bare Jinja expression (no {{ }}).
BARE = {"when", "that", "failed_when", "changed_when", "until"}
TASK_LISTS = ("tasks", "pre_tasks", "post_tasks", "handlers", "block", "rescue", "always")

SECRET_NAME = re.compile(r"(pass(word|wd|phrase)?|secret|token|private_?key|api_?key|credential|_key$|^key$)", re.I)
SECRET_WORDS = re.compile(r"비밀|secret|password|비밀번호|토큰|token", re.I)
OPTIONAL_WORDS = re.compile(r"\(선택\)|선택\s*[,)]|optional", re.I)

EXPR = re.compile(r"\{\{(.*?)\}\}|\{%-?(.*?)-?%\}", re.S)
RAW = re.compile(r"\{%-?\s*raw\s*-?%\}.*?\{%-?\s*endraw\s*-?%\}", re.S)
STRING = re.compile(r"""'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*\"""")
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
FOR_VARS = re.compile(r"^\s*for\s+([A-Za-z_][\w\s,]*?)\s+in\s", re.S)
SET_VAR = re.compile(r"^\s*set\s+([A-Za-z_]\w*)\s*=")
# After a name (and attribute / index access): `| default(…)`, `| d(…)`, `is defined`, `is not defined`, `is undefined`.
ACCESS = re.compile(r"""^(?:\s*\.\s*[A-Za-z_]\w*|\s*\[[^\]]*\])*""")
GUARD = re.compile(r"^\s*(?:\|\s*(?:default|d)\s*\(|is\s+(?:not\s+)?defined\b|is\s+undefined\b)")
DEFAULT_ARGS = re.compile(r"""^\s*\|\s*(?:default|d)\s*\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|True|False|none|None)?\s*(?:,\s*(true|True))?""")
# assert conditions that make an empty role default required: `x | length > 0`, `x | length >= 10`, `x != ''`, `x == 'yes'`.
ASSERT_FILLED = re.compile(r"""^\s*\(?\s*([A-Za-z_]\w*)\s*(?:\|\s*(?:string\s*\|\s*)?length\s*(?:>\s*0|>=\s*[1-9]\d*)|!=\s*(?:''|"")|==\s*(?:'[^']+'|"[^"]+"))\s*\)?\s*$""")
# `not some_enabled or (…)`: what follows is required only while that switch is on.
ASSERT_UNLESS = re.compile(r"^\s*not\s+([A-Za-z_]\w*)\s+or\s+(.+)$", re.S)
INLINE_COMMENT = re.compile(r"\s#\s?(.*)$")
TOP_KEY = re.compile(r"^([A-Za-z_]\w*)\s*:")
BOOL_USE = re.compile(r"^(?:\s*\|\s*(?:default|d)\s*\([^)]*\))?\s*\|\s*bool\b")


REQUIRED_PREFIX = re.compile(r"^필수\s*(?:\([^)]*\))?\s*[.,·:]?\s*")


def _load(text: str) -> Any:
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError:
        return None


def is_playbook(text: str) -> bool:
    """A list of plays: mappings with hosts or import_playbook."""
    data = _load(text)
    return isinstance(data, list) and bool(data) and all(isinstance(p, dict) for p in data) and any(
        "hosts" in p or "import_playbook" in p or "ansible.builtin.import_playbook" in p for p in data)


# Folders whose playbooks are not offered as the job's playbook: role internals and tests (tests/test.yml …).
# Their files still go up with the rest, so a playbook can still import them.
SKIP_DIRS = {"roles", "test", "tests"}


def playbooks(files: list[dict[str, str]]) -> list[str]:
    """Paths of the playbooks in a file set, top-level ones first (stack.yml before deploy/…); none from roles/ or tests/."""
    found = [f["path"] for f in files
             if f["path"].endswith((".yml", ".yaml")) and len(f.get("content", "")) <= MAX_TEXT
             and not SKIP_DIRS & {d.lower() for d in f["path"].split("/")[:-1]} and is_playbook(f.get("content", ""))]
    return sorted(found, key=lambda p: (p.count("/"), p))


class _Uses:
    """Every name an expression reads, and how."""

    def __init__(self) -> None:
        self.names: dict[str, dict[str, Any]] = {}
        self.local: set[str] = set()

    def expr(self, text: str) -> None:
        text = RAW.sub("", text)
        for m in FOR_VARS.finditer(text):
            self.local |= {x.strip() for x in m.group(1).split(",") if x.strip()}
        for m in SET_VAR.finditer(text):
            self.local.add(m.group(1))
        clean = STRING.sub(lambda m: " " * len(m.group(0)), text)
        for m in IDENT.finditer(clean):
            name, start, end = m.group(0), m.start(), m.end()
            before = clean[:start].rstrip()
            after = clean[end:]
            if before.endswith((".", "|")) or re.search(r"\bis(\s+not)?$", before):
                continue  # attribute, filter or test
            if re.match(r"\s*\(", after) or re.match(r"\s*=(?!=)", after):
                continue  # a function call (lookup, range…) or keyword argument
            if name in MAGIC or re.match(r"^\d", name):
                continue
            rest = after[ACCESS.match(after).end():]
            u = self.names.setdefault(name, {"guarded": 0, "plain": 0, "default": None, "bool": False})
            orig_rest = text[end + (len(after) - len(rest)):]
            if GUARD.match(rest):
                u["guarded"] += 1
                d = DEFAULT_ARGS.match(orig_rest)
                if d and d.group(1) is not None and u["default"] is None:
                    raw = d.group(1)
                    u["default"] = raw[1:-1] if raw[:1] in "'\"" else raw
            else:
                u["plain"] += 1
            if BOOL_USE.match(rest) or (u["default"] or "").lower() in ("true", "false"):
                u["bool"] = True

    def text(self, value: str) -> None:
        for m in EXPR.finditer(RAW.sub("", value)):
            self.expr(m.group(1) if m.group(1) is not None else m.group(2))


class _Walk:
    def __init__(self, files: dict[str, str], base: str):
        self.files, self.base = files, base
        self.uses = _Uses()
        self.defined: set[str] = set()
        self.copies: list[str] = []  # copy/template sources, relative to the playbook folder
        self.templates: list[str] = []
        self.role_copies: list[tuple[str, str]] = []  # (role folder, src) — looked up in that role's files/
        self.role_defaults: dict[str, dict[str, Any]] = {}  # name -> {value, desc, order}
        self.asserted: dict[str, str | None] = {}  # names an assert requires to be non-empty -> unless this switch is off
        self.roles_seen: set[str] = set()
        self.role_root: str | None = None  # the role whose tasks are being read
        self.prompts: list[dict[str, Any]] = []  # vars_prompt entries: asked at a terminal, so Wharfline asks instead
        self.source: str | None = None  # the imported playbook being read (None: the chosen playbook itself)

    def value(self, v: Any, bare: bool = False) -> None:
        if isinstance(v, str):
            self.uses.expr(v) if bare and "{{" not in v else self.uses.text(v)
        elif isinstance(v, list):
            for x in v:
                self.value(x, bare)
        elif isinstance(v, dict):
            for k, x in v.items():
                self.value(x, bare or k in BARE)

    def vars_block(self, v: Any) -> None:
        if isinstance(v, dict):
            self.defined |= {str(k) for k in v}
            self.value(list(v.values()))

    def task(self, t: Any) -> None:
        if not isinstance(t, dict):
            return
        if isinstance(t.get("register"), str):
            self.defined.add(t["register"])
        lc = t.get("loop_control")
        if isinstance(lc, dict) and isinstance(lc.get("loop_var"), str):
            self.defined.add(lc["loop_var"])
        self.vars_block(t.get("vars"))
        for key, val in t.items():
            mod = str(key).rsplit(".", 1)[-1]
            if mod == "set_fact" and isinstance(val, dict):
                self.defined |= {str(k) for k in val if k != "cacheable"}
            if mod in ("copy", "template", "synchronize") and isinstance(val, dict) and isinstance(val.get("src"), str):
                if self.role_root is None:
                    (self.templates if mod == "template" else self.copies).append(val["src"])
                elif mod != "template":  # a role's templates/ are all read in role(); its copies come from its files/
                    self.role_copies.append((self.role_root, val["src"]))
            if mod == "assert" and isinstance(val, dict):
                that = val.get("that")
                for line in that if isinstance(that, list) else [that]:
                    if isinstance(line, str):
                        self.assertion(line)
            if mod in ("include_role", "import_role") and isinstance(val, dict) and isinstance(val.get("name"), str) \
                    and "{{" not in val["name"]:
                self.role(val["name"])
            if key in TASK_LISTS:
                for sub in val or []:
                    self.task(sub)
            elif key != "vars":
                self.value(val, key in BARE)

    def play(self, p: dict) -> None:
        self.vars_block(p.get("vars"))
        for vp in p.get("vars_prompt") or []:
            if isinstance(vp, dict) and vp.get("name"):
                self.defined.add(str(vp["name"]))
                if all(x["name"] != str(vp["name"]) for x in self.prompts):
                    self.prompts.append(vp)
        for key in ("hosts", "become", "become_user", "name", "environment"):
            self.value(p.get(key))
        for role in p.get("roles") or []:
            name = role if isinstance(role, str) else (role.get("role") or role.get("name")) if isinstance(role, dict) else None
            if isinstance(role, dict):
                self.vars_block(role.get("vars"))
                self.value({k: v for k, v in role.items() if k not in ("role", "name", "vars")})
            if isinstance(name, str):
                self.role(name)
        for key in TASK_LISTS:
            for t in p.get(key) or []:
                self.task(t)

    def assertion(self, line: str) -> None:
        """Which names one assert line requires: `a | length > 0 and b == 'yes'`, or the same behind `not switch or (…)`.
        Anything joined by a plain `or` is a choice, not a requirement."""
        switch = None
        m = ASSERT_UNLESS.match(line)
        if m:
            switch, line = m.group(1), m.group(2).strip()
            if line.startswith("(") and line.endswith(")"):
                line = line[1:-1]
        if re.search(r"\bor\b", STRING.sub("''", line)):
            return
        for part in re.split(r"\s+and\s+", line):
            hit = ASSERT_FILLED.match(part)
            if hit:
                self.asserted.setdefault(hit.group(1), switch)

    def role(self, name: str) -> None:
        root = posixpath.normpath(posixpath.join(self.base, "roles", name))
        if root in self.roles_seen:
            return
        self.roles_seen.add(root)
        outer, self.role_root = self.role_root, root
        for part in ("defaults", "vars", "tasks", "handlers"):
            text = self.files.get(f"{root}/{part}/main.yml") or self.files.get(f"{root}/{part}/main.yaml")
            data = _load(text) if text else None
            if part == "defaults":
                self.defaults(data, text or "")
            elif part == "vars":
                self.vars_block(data)
            elif isinstance(data, list):
                for t in data:
                    self.task(t)
        for path, text in self.files.items():
            if path.startswith(f"{root}/templates/"):
                self.uses.text(text)
        self.role_root = outer

    def defaults(self, data: Any, text: str) -> None:
        """A role's defaults/main.yml: values the job may change. Each keeps its value and its comment."""
        if not isinstance(data, dict):
            return
        self.value(list(data.values()))
        notes = _default_comments(text)
        for k, v in data.items():
            name = str(k)
            if name not in self.role_defaults:
                self.role_defaults[name] = {"value": v, "desc": notes.get(name, ""), "order": len(self.role_defaults),
                                            "role": posixpath.basename(self.role_root or ""), "from": self.source}


def _comment_lines(text: str) -> list[str]:
    return [ln.strip().lstrip("#").strip() for ln in text.splitlines() if ln.strip().startswith("#")]


def _default_comments(text: str) -> dict[str, str]:
    """For each top-level key in a defaults file: its trailing comment, else the comment lines right above it."""
    out: dict[str, str] = {}
    above: list[str] = []
    for ln in text.splitlines():
        s = ln.strip()
        if s.startswith("#"):
            above.append(s.lstrip("#").strip())
            continue
        m = TOP_KEY.match(ln)
        if m:
            inline = INLINE_COMMENT.search(STRING.sub(lambda x: " " * len(x.group(0)), ln))
            note = ln[inline.start(1):].strip() if inline else " ".join(x for x in above if x)
            out[m.group(1)] = re.sub(r"\s+", " ", note).strip()
        if not ln.startswith((" ", "\t", "-")):
            above = []
    return out


def _shown_default(v: Any) -> str | None:
    """A role default as the form shows it: true/false, a number, text, or [a, b] / {k: v} for lists and maps."""
    if v is None:
        return None
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False) if v else ("[]" if isinstance(v, list) else "{}")
    return str(v)


def _comment_for(name: str, comments: list[str], defining_only: bool = False) -> str:
    """The comment line about the variable. A line that defines it ("init_user  처음 접속할 계정",
    "비밀 변수  init_password  …") wins over one that only mentions it ("init_user 를 docker 그룹에 추가")."""
    rx = re.compile(rf"(?<![\w.]){re.escape(name)}(?![\w])")
    defining = re.compile(rf"^(?:[^\w\s]*\s*)?(?:\S+(?:\s\S+)?\s{{2,}})?{re.escape(name)}(?:\s{{2,}}|\s*[:=-]\s|$)")
    hit = next((ln for ln in comments if defining.search(ln)), None)
    if hit or defining_only:
        return hit or ""
    return next((ln for ln in comments if rx.search(ln)), "")


def _describe(name: str, line: str) -> str:
    """The comment line minus everything up to the name: "예) team.example.com → …". A line that only mentions
    the name mid-sentence ("관리자 IP 는 NAME 에 넣어 …") is kept whole, so it still reads as a sentence."""
    m = re.search(rf"(?<![\w.]){re.escape(name)}(?![\w])", line)
    if not m:
        return ""
    rest = line[m.end():]
    if re.search(r"\w", line[:m.start()]) and not re.match(r"\s{2,}|\s*[:=→·-]|\s*$", rest):
        return re.sub(r"\s+", " ", line).strip()
    return re.sub(r"\s+", " ", rest).strip(" :-·")


def _local(path: str, base: str) -> str | None:
    """A copy/template src as a path in the upload, or None when it is not a plain relative file."""
    src = re.sub(r"^\{\{\s*playbook_dir\s*\}\}/?", "", path.strip())
    if "{{" in src or src.startswith("/"):
        return None
    return posixpath.normpath(posixpath.join(base, src))


def inspect(files: list[dict[str, str]], book: str) -> dict[str, Any]:
    by_path = {f["path"]: f.get("content", "") for f in files}
    text = by_path.get(book)
    if text is None:
        return {"book": book, "plays": [], "vars": [], "auto": [], "notes": [], "warnings": [f"{book} 파일이 없어요."]}
    base = posixpath.dirname(book)
    data = _load(text)
    walk = _Walk(by_path, base)
    plays: list[dict[str, Any]] = []
    warnings: list[str] = []
    if not isinstance(data, list):
        warnings.append("YAML을 읽지 못했어요. 변수는 직접 더해 주세요.")
        data = []
    for p in data:
        if not isinstance(p, dict):
            continue
        imported = p.get("import_playbook") or p.get("ansible.builtin.import_playbook")
        if isinstance(imported, str):
            sub = posixpath.normpath(posixpath.join(base, imported))
            plays.append({"name": p.get("name") or imported, "import": sub})
            sub_data = _load(by_path.get(sub, "")) if sub in by_path else None
            walk.vars_block(p.get("vars"))  # `import_playbook: x.yml` + `vars:` sets those for the imported plays
            if isinstance(sub_data, list):
                walk.source = sub  # its role values are shown apart, under "불러온 플레이북"
                for sp in sub_data:
                    if isinstance(sp, dict) and "hosts" in sp:
                        walk.play(sp)
                walk.source = None
            elif sub not in by_path:
                warnings.append(f"불러오는 플레이북 {sub}이(가) 올린 파일에 없어요.")
            continue
        plays.append({"name": str(p.get("name") or ""), "hosts": str(p.get("hosts") or ""), "become": bool(p.get("become"))})
        walk.play(p)

    for src in walk.templates:
        local = _local(src, base)
        if local is None:
            continue
        # next to the playbook, in its templates/ folder, or in a role's templates/ folder
        hit = next((c for c in (local, posixpath.join(base, "templates", src)) if c in by_path), None) or next(
            (p for p in by_path if p.endswith(f"/templates/{src}")), None)
        if hit:
            walk.uses.text(by_path[hit])
        else:
            warnings.append(f"올린 파일에 없어요: {local} (플레이북이 템플릿으로 써요. 같이 올려 주세요)")
    for src in walk.copies:
        local = _local(src, base)
        if local is None:
            continue
        folder = local.rstrip("/") + "/"
        found = local in by_path or any(p.startswith(folder) for p in by_path) or any(
            p.endswith(f"/files/{src.strip('/')}") or p.startswith(f"{base}/files/{src.strip('/')}".lstrip("/")) for p in by_path)
        if not found:
            what = f"{local}/ 폴더" if src.rstrip().endswith("/") else local
            warnings.append(f"올린 파일에 없어요: {what} (플레이북이 서버로 복사해요. 같이 올려 주세요)")

    for root, src in walk.role_copies:
        if "{{" in src or src.startswith("/"):
            continue
        rel = src.strip("/")
        if not any(p == f"{root}/files/{rel}" or p.startswith(f"{root}/files/{rel}/") for p in by_path):
            warnings.append(f"올린 파일에 없어요: {root}/files/{rel} (role 이 서버로 복사해요. 같이 올려 주세요)")

    comments = _comment_lines(text)
    auto: list[str] = []
    out: list[dict[str, Any]] = []
    # Role defaults the playbook does not set itself: optional (required when empty and asserted), with the default shown.
    # vars_prompt: without a terminal Ansible skips the question and goes on with nothing (or the default), so each
    # one is an input here. A prompt is private unless it says otherwise, as in Ansible.
    for vp in walk.prompts:
        name, default = str(vp["name"]), vp.get("default")
        shown = None if default is None else str(default).lower() if isinstance(default, bool) else str(default)
        secret = vp.get("private", True) is not False
        yesno = shown is not None and shown.lower() in ("yes", "no", "true", "false")
        out.append({"name": name, "required": shown in (None, ""), "secret": secret, "default": shown or None,
                    "bool": yesno and not secret, "desc": str(vp.get("prompt") or "").strip(), "role": None})
    for name, d in walk.role_defaults.items():
        if name in walk.defined or name in WHARFLINE:
            continue
        value = d["value"]
        if isinstance(value, str) and ("{{" in value or "{%" in value):
            continue  # built from other values; changing those is enough
        if any(isinstance(x, str) and "{{" in x for x in (value if isinstance(value, list) else
                                                         value.values() if isinstance(value, dict) else [])):
            continue
        empty = value in (None, "", [], {})
        # the playbook's comment only when it describes this value; a line that merely names it loses to the role's own comment
        comment_line = _comment_for(name, comments, defining_only=True)
        desc = (_describe(name, comment_line) if comment_line else "") or d["desc"]
        u = walk.uses.names.get(name, {})
        secret = not isinstance(value, bool) and bool(
            SECRET_NAME.search(name) or (comment_line and SECRET_WORDS.search(comment_line.split(name, 1)[0])))
        switch = walk.asserted.get(name)
        on = switch is None or walk.role_defaults.get(switch, {}).get("value") is True
        out.append({"name": name, "required": empty and name in walk.asserted and on, "secret": secret,
                    "default": None if empty and not isinstance(value, (list, dict)) else _shown_default(value),
                    "bool": (isinstance(value, bool) or bool(u.get("bool"))) and not secret,
                    "desc": OPTIONAL_WORDS.sub("", desc).strip(), "role": d["role"] or None, "from": d.get("from"), "_order": d["order"]})
    for name, u in walk.uses.names.items():
        if name in walk.defined or name in walk.uses.local or name in walk.role_defaults:
            continue
        if name in WHARFLINE:
            auto.append(name)
            continue
        comment_line = _comment_for(name, comments)
        desc = _describe(name, comment_line)
        # ansible_* are facts and connection settings, unless the playbook's comments ask for one (ansible_pubkey)
        if name.startswith("ansible_") and not comment_line:
            continue
        required = u["plain"] > 0 and not OPTIONAL_WORDS.search(desc)
        secret = bool(SECRET_NAME.search(name) or SECRET_WORDS.search(comment_line.split(name, 1)[0]))
        out.append({"name": name, "required": required, "secret": secret, "default": u["default"],
                    "bool": u["bool"] and not secret, "desc": OPTIONAL_WORDS.sub("", desc).strip(), "role": None})
    # Comment order first (the author's own order), then the rest by name; required before optional.
    order = {n: i for i, n in enumerate(_comment_order(comments, [v["name"] for v in out]))}
    # then role defaults in file order, then the rest by name
    out.sort(key=lambda v: (not v["required"], order.get(v["name"], len(order)), v.get("_order", 1 << 20), v["name"]))
    for v in out:
        v.pop("_order", None)
        if v["required"]:  # it already sits under 필수: "필수 (vault). 예) …" → "예) …"
            v["desc"] = REQUIRED_PREFIX.sub("", v["desc"]).strip()

    # Only what the person has to act on. (sudo and hosts: groups need nothing here: a run that stops on a missing
    # sudo password says what to set, and runs go to the chosen servers whatever the hosts: line says.)
    notes: list[str] = []
    if "env_src" in auto or "env_file" in auto:
        notes.append("이 플레이북은 환경 변수(.env)를 받아요. 작업을 만든 뒤 환경 변수를 연결할 수 있어요.")
    return {"book": book, "plays": plays, "vars": out, "auto": sorted(auto), "notes": notes, "warnings": warnings}


def _comment_order(comments: list[str], names: list[str]) -> list[str]:
    seen: list[str] = []
    for ln in comments:
        for n in names:
            if n not in seen and re.search(rf"(?<![\w.]){re.escape(n)}(?![\w])", ln):
                seen.append(n)
    return seen


# ---------- which inventory groups a playbook runs on ----------

_HOST_VAR = re.compile(r"""\{\{\s*([A-Za-z_]\w*)\s*(?:\|\s*(?:default|d)\s*\(\s*(?:'([^']*)'|"([^"]*)")\s*\)\s*)?\}\}""")
_NOT_GROUPS = {"all", "*", "localhost", "127.0.0.1", "ungrouped"}


def _resolve_hosts(value: Any, scope: dict[str, Any]) -> str | None:
    """`hosts:` with simple templates filled in ("{{ base_hosts }}", "{{ x | default('web') }}"); None when unknown."""
    if isinstance(value, list):
        value = ",".join(str(v) for v in value)
    if not isinstance(value, str):
        return None

    def fill(m: re.Match[str]) -> str:
        v = scope.get(m[1])
        if v is None:
            v = m[2] if m[2] is not None else m[3]
        return "{{?}}" if v is None else (",".join(map(str, v)) if isinstance(v, list) else str(v))

    out = _HOST_VAR.sub(fill, value)
    return None if "{{" in out else out


def host_groups(read: Any, book: str, scope: dict[str, Any] | None = None) -> list[str]:
    """Group names the playbook's plays target (`hosts:`), following import_playbook and its `vars:`.

    `read(path)` returns a file's text or None; paths are relative to the repo root. Patterns that are not plain
    names (all, localhost, wildcards, ranges, regexes) are left out; `!x` and `&x` count as x."""
    found: list[str] = []
    seen: set[str] = set()

    def visit(path: str, sc: dict[str, Any], depth: int) -> None:
        if depth > 10 or path in seen:
            return
        seen.add(path)
        data = _load(read(path) or "")
        if not isinstance(data, list):
            return
        for p in data:
            if not isinstance(p, dict):
                continue
            here = {**sc, **(p.get("vars") if isinstance(p.get("vars"), dict) else {})}
            imported = p.get("import_playbook") or p.get("ansible.builtin.import_playbook")
            if isinstance(imported, str):
                visit(posixpath.normpath(posixpath.join(posixpath.dirname(path), imported)), here, depth + 1)
                continue
            hosts = _resolve_hosts(p.get("hosts"), here)
            for pat in re.split(r"[,:]", hosts or ""):
                name = pat.strip().lstrip("!&")
                if name and name not in _NOT_GROUPS and re.fullmatch(r"[A-Za-z0-9_.-]+", name) and name not in found:
                    found.append(name)
        seen.discard(path)  # the same file imported twice with other vars is read again

    visit(posixpath.normpath(book), dict(scope or {}), 0)
    return found
