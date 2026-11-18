"""Agents: enrolling with a one-time token, signed polls, sealed tasks, and the server-side endpoints around them."""

import base64
import importlib.util
import json
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from sqlalchemy import select

from app import agentinstall, agentproto
from app import models as m
from app.agenthub import HUB
from app.db import SessionLocal
from tests.conftest import OWNER

AGENT_FILE = Path(__file__).resolve().parents[2] / "agent" / "wharfline_agent.py"


def _raw_pub(key) -> str:
    return base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()


class FakeAgent:
    """Holds an agent's keys and signs requests like agent/wharfline_agent.py does."""

    def __init__(self):
        self.sign, self.box = Ed25519PrivateKey.generate(), X25519PrivateKey.generate()
        self.id = ""
        self.server_key = ""

    def enroll(self, client, token: str, users=("deploy",)):
        r = client.post("/api/agent/enroll", json={"token": token, "key": _raw_pub(self.sign), "box": _raw_pub(self.box),
                                                   "info": {"version": "test", "hostname": "srv-a", "ip": "10.1.2.3",
                                                            "policy": {"users": list(users), "paths": ["/srv"]}}})
        if r.status_code == 200:
            self.id, self.server_key = r.json()["id"], r.json()["serverKey"]
        return r

    def headers(self, path: str, body: bytes, ts: float | None = None) -> dict:
        t = str(int(ts if ts is not None else time.time()))
        sig = base64.b64encode(self.sign.sign(agentproto.canonical("POST", path, t, body))).decode()
        return {agentproto.HDR_ID: self.id, agentproto.HDR_TIME: t, agentproto.HDR_SIG: sig, "Content-Type": "application/json"}

    def post(self, client, path: str, data: dict, ts: float | None = None):
        body = json.dumps(data).encode()
        return client.post(path, content=body, headers=self.headers(path, body, ts))

    def open(self, resp: dict) -> dict:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(self.server_key)).verify(base64.b64decode(resp["sig"]), resp["task"].encode())
        return json.loads(agentproto.unseal(self.box, json.loads(resp["task"])))


def _inventory(client, name="staging") -> dict:
    return next(i for i in client.get("/api/inventory").json() if i["name"] == name)


def _pending(client, name: str, **kw) -> tuple[dict, str]:
    inv = _inventory(client)
    r = client.post(f"/api/inventory/{inv['id']}/hosts/pending", json={"name": name, "group": "web", **kw})
    assert r.status_code == 200, r.text
    command = r.json()["command"]
    token = command.split(" -- ")[1].split()[0]
    return r.json(), token


def test_a_pending_server_enrolls_once_with_its_token(client, login):
    login(OWNER, sudo=True)
    made, token = _pending(client, "agent-1", users="ubuntu", paths="/srv,/home/ubuntu/apps")
    assert made["host"]["mode"] == "pending" and made["host"]["ip"] == ""
    assert "install.sh | sudo sh -s -- wfe_" in made["command"] and " deploy,ubuntu /srv,/home/ubuntu/apps" in made["command"]
    with SessionLocal() as db:  # only the hash is kept
        assert not db.scalar(select(m.EnrollToken).where(m.EnrollToken.token_hash == token))
        assert db.get(m.EnrollToken, agentproto.token_hash(token))

    a = FakeAgent()
    r = a.enroll(client, token)
    assert r.status_code == 200, r.text
    assert r.json()["host"] == "agent-1" and r.json()["serverBox"]
    host = next(h for h in _inventory(client)["hosts"] if h["name"] == "agent-1")
    assert host["mode"] == "agent" and host["ip"] == "10.1.2.3" and host["agent"]["version"] == "test"

    assert FakeAgent().enroll(client, token).status_code == 401  # used
    with SessionLocal() as db:
        row = db.get(m.EnrollToken, agentproto.token_hash(token))
        assert row.used_at


def test_an_expired_or_unknown_token_is_refused(client, login):
    login(OWNER, sudo=True)
    _, token = _pending(client, "agent-old")
    with SessionLocal() as db:
        db.get(m.EnrollToken, agentproto.token_hash(token)).expires_at = time.time() - 1
        db.commit()
    assert FakeAgent().enroll(client, token).status_code == 401
    assert FakeAgent().enroll(client, "wfe_nope").status_code == 401


def test_polls_must_be_signed_fresh_and_not_replayed(client, login):
    login(OWNER, sudo=True)
    _, token = _pending(client, "agent-sig")
    a = FakeAgent()
    assert a.enroll(client, token).status_code == 200
    path = "/api/agent/poll"
    assert client.post(path, json={"wait": 0}).status_code == 401  # unsigned
    assert a.post(client, path, {"wait": 0}, ts=time.time() - 600).status_code == 401  # clock skew
    other = FakeAgent()
    other.id = a.id
    assert other.post(client, path, {"wait": 0}).status_code == 401  # someone else's key
    body = json.dumps({"wait": 0}).encode()
    h = a.headers(path, body)
    assert client.post(path, content=body, headers=h).json() == {"task": None}
    assert client.post(path, content=body, headers=h).status_code == 401  # the same signature again


def test_a_task_reaches_the_agent_sealed_and_signed(client, login):
    login(OWNER, sudo=True)
    _, token = _pending(client, "agent-task")
    a = FakeAgent()
    a.enroll(client, token)
    with SessionLocal() as db:
        host_id = db.scalar(select(m.Host.id).where(m.Host.agent_id == a.id))
    fut = client.portal.start_task_soon(HUB.call, host_id, {"op": "exec", "user": "deploy", "cmd": "true", "stdin": "SECRET=pw"}, 10)
    resp = a.post(client, "/api/agent/poll", {"wait": 5}).json()
    assert "SECRET=pw" not in resp["task"]  # sealed on the way
    task = a.open(resp)
    assert task["op"] == "exec" and task["stdin"] == "SECRET=pw" and task["id"]
    assert a.post(client, f"/api/agent/tasks/{task['id']}/lines", {"lines": ["hello"]}).status_code == 200
    assert a.post(client, f"/api/agent/tasks/{task['id']}/finish", {"result": {"ok": True, "rc": 0}}).status_code == 200
    assert fut.result(timeout=5) == {"ok": True, "rc": 0}


def test_fetched_files_come_back_sealed(client, login):
    login(OWNER, sudo=True)
    _, token = _pending(client, "agent-art")
    a = FakeAgent()
    server_box = a.enroll(client, token).json()["serverBox"]
    with SessionLocal() as db:
        host_id = db.scalar(select(m.Host.id).where(m.Host.agent_id == a.id))
    fut = client.portal.start_task_soon(HUB.call, host_id, {"op": "playbook"}, 10)
    task = a.open(a.post(client, "/api/agent/poll", {"wait": 5}).json())
    files = [{"path": "secrets/srv/key", "data": base64.b64encode(b"k1:abc").decode()}]
    sealed = agentproto.seal(server_box, json.dumps(files).encode())
    a.post(client, f"/api/agent/tasks/{task['id']}/finish", {"result": {"ok": True, "rc": 0, "sealed": sealed}})
    assert fut.result(timeout=5)["artifacts"] == files


def test_install_sh_has_the_address_and_no_secret(client):
    text = client.get("/api/agent/install.sh").text
    assert text.startswith("#!/bin/sh") and "WHARFLINE_URL=https://deploy.test" in text
    assert "WHARFLINE_ALLOWED_USERS=\"$USERS\"" in text and "wfe_" not in text


def test_sudo_and_policy_endpoints(client, login):
    login(OWNER, sudo=True)
    inv = _inventory(client)
    r = client.post(f"/api/inventory/{inv['id']}/hosts/init",
                    json={"ip": "10.9.7.1", "port": "22", "fingerprint": "SHA256:pX0c7Lq2vRz9Hn4Wb1Ke8YsT3mJ6fDaUgQ5iEoN",
                          "account": "ubuntu", "password": "pw-1", "name": "agent-sudo", "users": "ubuntu"})
    assert r.json()["ok"], r.text
    ix = next(i for i, h in enumerate(_inventory(client)["hosts"]) if h["name"] == "agent-sudo")
    r = client.put(f"/api/inventory/{inv['id']}/hosts/{ix}/sudo", json={"user": inv["user"], "enable": True})
    assert r.status_code == 200 and r.json()["agent"]["sudo"][inv["user"]] is True
    bad = client.post(f"/api/inventory/{inv['id']}/hosts/pending", json={"name": "agent-root", "users": "root"})
    assert bad.status_code == 400 and "root" in bad.json()["detail"]
    bad = client.post(f"/api/inventory/{inv['id']}/hosts/pending", json={"name": "agent-slash", "paths": "/"})
    assert bad.status_code == 400


def test_runs_skip_servers_without_an_agent(client):
    from app import executor
    with SessionLocal() as db:
        h = db.scalar(select(m.Host).where(m.Host.agent_id.is_(None), m.Host.status != "pending"))
        assert "에이전트로 전환" in executor.agent_skip(h, "deploy")
        h2 = m.Host(name="x", ip="", port=22, ssh_user="deploy", grp="web", status="on", agent_id="abc",
                    agent_info={"policy": {"users": ["ubuntu"]}})
        assert "허용하지 않아요" in executor.agent_skip(h2, "deploy") and executor.agent_skip(h2, "ubuntu") == ""


def test_agent_settings(client, login):
    login(OWNER, sudo=True)
    r = client.put("/api/agent-settings", json={"url": "http://10.0.0.9:8080/"})
    assert r.status_code == 200 and r.json()["url"] == "http://10.0.0.9:8080"
    assert client.put("/api/agent-settings", json={"url": "ftp://x"}).status_code == 400
    client.put("/api/agent-settings", json={"url": ""})
    assert client.get("/api/agent-settings").json()["url"] == "https://deploy.test"


# ---------- the agent's own rules (agent/wharfline_agent.py) ----------

@pytest.fixture(scope="module")
def agent_mod():
    if not AGENT_FILE.is_file():
        pytest.skip("agent/ is not mounted next to backend/")
    spec = importlib.util.spec_from_file_location("wharfline_agent", AGENT_FILE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_agent_policy(agent_mod):
    p = agent_mod.Policy("deploy, root ,ubuntu,Bad", "/srv,/home/ubuntu/apps/,/,relative")
    assert p.users == ["deploy", "ubuntu"] and p.paths == ["/srv", "/home/ubuntu/apps"]
    assert p.path_allowed("/srv") and p.path_allowed("/srv/app/x") and p.path_allowed("/home/ubuntu/apps/a")
    assert not p.path_allowed("/srvx") and not p.path_allowed("/home/ubuntu/.ssh/authorized_keys") and not p.path_allowed("/etc")
    with pytest.raises(agent_mod.PolicyError):
        p.check_user("root")
    assert agent_mod.normalize("/srv/../etc/passwd") == "/etc/passwd" and agent_mod.normalize("rel") == ""


def test_agent_and_wharfline_seal_the_same_way(agent_mod):
    box = X25519PrivateKey.generate()
    pub = _raw_pub(box)
    assert agent_mod.unseal(box, agentproto.seal(pub, b"from wharfline")) == b"from wharfline"
    assert agentproto.unseal(box, agent_mod.seal(pub, b"from agent")) == b"from agent"
    assert agent_mod.canonical("POST", "/p", "1", b"x") == agentproto.canonical("POST", "/p", "1", b"x")


def test_install_lines_keep_the_token_off_the_command_line():
    lines = "\n".join(agentinstall.run_lines("https://w", "img:1", "deploy", "/srv"))
    assert '"$TOKEN" |' in lines and "-e TOKEN" not in lines and "--privileged --pid host --network host" in lines
