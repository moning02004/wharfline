"""Setting up a new server with its first account and password."""

import base64
import re

from sqlalchemy import select

from app import serverinit
from tests.conftest import OWNER

FP = "SHA256:pX0c7Lq2vRz9Hn4Wb1Ke8YsT3mJ6fDaUgQ5iEoN"
KEY = 'from="10.0.0.1",no-port-forwarding ssh-ed25519 AAAA deploy'


def test_script_quotes_values_and_can_run_twice():
    text = serverinit.init_script("deploy", KEY, False)
    assert text.startswith("set -eu\n")
    assert "U=deploy\n" in text
    assert "KEY='from=\"10.0.0.1\",no-port-forwarding ssh-ed25519 AAAA deploy'\n" in text
    assert 'id -u "$U" >/dev/null 2>&1 || useradd' in text  # an existing user is left alone
    assert 'grep -qxF -- "$KEY"' in text  # the key is added once
    assert "if ! command -v docker" in text  # Docker is installed only when missing
    assert "sudoers" not in text


def test_full_sudo_is_a_choice():
    names = serverinit.step_names(True)
    assert names[-1] == "sudo 권한"
    text = serverinit.init_script("deploy", KEY, True)
    assert "NOPASSWD:ALL" in text and 'visudo -cf "$F"' in text


def test_the_password_never_travels_with_the_script():
    cmd = serverinit.remote_command("echo hi\n", as_root=False)
    assert cmd.startswith("sudo -S -p '' sh -c ")
    encoded = re.search(r"echo (\S+) \| base64 -d", cmd).group(1)
    assert base64.b64decode(encoded).decode() == "echo hi\n"
    assert 'sh "$f" </dev/null' in cmd  # nothing the script starts can read stdin
    assert serverinit.remote_command("echo hi\n", as_root=True).startswith("sh -c ")


def test_read_output_marks_the_failed_step_and_masks_the_password():
    names = serverinit.step_names(False)
    out = f"{serverinit.MARK}배포 사용자\n{serverinit.MARK}공개 키\n{serverinit.MARK}Docker\nboom hunter2 boom\n"
    r = serverinit.read_output(out, 1, names, "hunter2")
    assert [x["status"] for x in r["steps"]] == ["ok", "ok", "fail", "skip", "skip"]
    assert r["ok"] is False and r["log"] == [f"boom {serverinit.MASK} boom"]


def test_read_output_all_done():
    names = serverinit.step_names(False)
    r = serverinit.read_output("".join(f"{serverinit.MARK}{n}\n" for n in names), 0, names, "pw")
    assert r["ok"] is True and all(x["status"] == "ok" for x in r["steps"])


def _inventory(client, name: str) -> dict:
    return next(i for i in client.get("/api/inventory").json() if i["name"] == name)


def _body(**kw) -> dict:
    return {"ip": "10.9.5.1", "port": "22", "fingerprint": FP, "account": "ubuntu", "password": "first-pw-1", **kw}


def test_init_endpoint_adds_a_pinned_server_and_keeps_no_password(client, login):
    login(OWNER, sudo=True)
    inv = _inventory(client, "staging")
    r = client.post(f"/api/inventory/{inv['id']}/hosts/init", json=_body(name="init-1", group="web"))
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True and r.json()["steps"][-1] == {"name": "접속 확인", "status": "ok"}
    assert "first-pw-1" not in r.text

    host = next(h for h in _inventory(client, "staging")["hosts"] if h["name"] == "init-1")
    assert host["user"] == inv["user"] and host["group"] == "web"

    from app import models as m
    from app.db import SessionLocal
    with SessionLocal() as db:
        row = db.scalar(select(m.Host).where(m.Host.name == "init-1"))
        assert row.host_fingerprint == FP
        act = db.scalar(select(m.Activity).where(m.Activity.action == "서버 초기화", m.Activity.object.contains("init-1")))
        assert act and "ubuntu" in act.object and "first-pw-1" not in act.object


def test_init_endpoint_root_may_set_up_but_a_failure_saves_nothing(client, login):
    login(OWNER, sudo=True)
    inv = _inventory(client, "staging")
    r = client.post(f"/api/inventory/{inv['id']}/hosts/init", json=_body(name="init-root", ip="10.9.5.2", account="root"))
    assert r.status_code == 200 and r.json()["ok"] is True  # the first account may be root; the deploy user never is

    r = client.post(f"/api/inventory/{inv['id']}/hosts/init", json=_body(name="init-bad", ip="10.9.5.3", password=serverinit.SIMULATED_BAD_PASSWORD))
    assert r.status_code == 200 and r.json()["ok"] is False and "로그인" in r.json()["error"] and r.json()["host"] is None
    assert not any(h["name"] == "init-bad" for h in _inventory(client, "staging")["hosts"])


def test_init_endpoint_checks_first(client, login):
    login(OWNER, sudo=True)
    inv = _inventory(client, "staging")
    url = f"/api/inventory/{inv['id']}/hosts/init"
    assert client.post(url, json=_body(fingerprint="")).status_code == 400
    assert client.post(url, json=_body(fingerprint="nope")).status_code == 400
    assert client.post(url, json=_body(account="Bad User")).status_code == 400
    assert client.post(url, json=_body(password="")).status_code == 400
    assert client.post("/api/inventory/i-none/hosts/init", json=_body()).status_code == 404
    login(OWNER)  # the password re-check is required
    assert client.post(url, json=_body(name="init-nosudo")).status_code in (401, 403)
