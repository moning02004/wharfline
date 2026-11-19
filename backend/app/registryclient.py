"""Ask a container registry which digest a tag points to (Docker Registry HTTP API v2 / OCI distribution).

Wharfline uses it so a webhook is only a hint: before an auto-deploy, and when any run starts, the tag is looked
up at the registry itself and the run deploys `image:tag@sha256:…`. A tag that the registry doesn't have is not
deployed, and a tag that was pushed again (another digest under the same name) is caught.

Auth follows the registry's challenge: anonymous, Basic, or a Bearer token from the realm it names (Docker Hub,
GHCR, GitLab, Gitea all use the token flow), with the pull token Wharfline has for that registry, if any.

Tests and demos (WHARFLINE_SSH_SIMULATE=1 / WHARFLINE_REGISTRY_SIMULATE=1) get a made-up digest per ref:tag.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 10.0
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def simulated() -> bool:
    return os.environ.get("WHARFLINE_REGISTRY_SIMULATE") == "1" or os.environ.get("WHARFLINE_SSH_SIMULATE") == "1"


def split(ref: str) -> tuple[str, str]:
    """(registry host, repository) of an image ref without tag: nginx → (registry-1.docker.io, library/nginx)."""
    first, _, rest = ref.partition("/")
    if rest and ("." in first or ":" in first or first == "localhost"):
        host, repo = first, rest
    else:
        host, repo = "registry-1.docker.io", ref
    if host in ("docker.io", "index.docker.io"):
        host = "registry-1.docker.io"
    if host == "registry-1.docker.io" and "/" not in repo:
        repo = f"library/{repo}"
    return host, repo


def _challenge(header: str) -> tuple[str, dict[str, str]]:
    scheme, _, rest = header.partition(" ")
    return scheme.lower(), dict(re.findall(r'(\w+)="([^"]*)"', rest))


def _basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()


def _head(url: str, auth: str | None) -> tuple[int, dict[str, str]]:
    headers = {"Accept": ACCEPT, "User-Agent": "wharfline"}
    if auth:
        headers["Authorization"] = auth
    req = urllib.request.Request(url, method="HEAD", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}


def _token(params: dict[str, str], scope: str, user: str, password: str) -> str | None:
    realm = params.get("realm")
    if not realm or not realm.startswith("https://") and not realm.startswith("http://"):
        return None
    q = {"scope": params.get("scope") or scope}
    if params.get("service"):
        q["service"] = params["service"]
    headers = {"User-Agent": "wharfline"}
    if user and password:
        headers["Authorization"] = _basic(user, password)
    req = urllib.request.Request(f"{realm}?{urllib.parse.urlencode(q)}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.loads(r.read() or b"{}")
    except (urllib.error.URLError, ValueError, TimeoutError):
        return None
    return data.get("token") or data.get("access_token")


def resolve(ref: str, tag: str, user: str = "", password: str = "") -> str | None:
    """sha256:… for ref:tag, or None when the registry doesn't have it (or can't be reached)."""
    if simulated():
        return "sha256:" + hashlib.sha256(f"{ref}:{tag}".encode()).hexdigest()
    host, repo = split(ref)
    scheme = "http" if host.startswith(("localhost", "127.0.0.1")) else "https"
    url = f"{scheme}://{host}/v2/{repo}/manifests/{urllib.parse.quote(tag, safe='')}"
    try:
        code, headers = _head(url, None)
        if code == 401:
            kind, params = _challenge(headers.get("www-authenticate", ""))
            if kind == "bearer":
                token = _token(params, f"repository:{repo}:pull", user, password)
                code, headers = _head(url, f"Bearer {token}") if token else (401, {})
            elif kind == "basic" and user:
                code, headers = _head(url, _basic(user, password))
    except (urllib.error.URLError, OSError, TimeoutError):
        return None
    digest = headers.get("docker-content-digest", "") if code == 200 else ""
    return digest if DIGEST_RE.match(digest) else None
