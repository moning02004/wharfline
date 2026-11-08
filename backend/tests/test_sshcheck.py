"""Connection check against a real SSH server started in the test (asyncssh), and through the API."""

import asyncio

import asyncssh
import pytest

from app import sshcheck, sshkeys


@pytest.fixture
def real_ssh(monkeypatch):
    monkeypatch.delenv("WHARFLINE_SSH_SIMULATE", raising=False)


def _serve(authorized_line: str):
    """A local SSH server that accepts `deploy` with the given key; returns (server, port, host key)."""
    host_key = asyncssh.generate_private_key("ssh-ed25519")

    class Server(asyncssh.SSHServer):
        def begin_auth(self, username):
            return True

        def public_key_auth_supported(self):
            return True

        def validate_public_key(self, username, key):
            return username == "deploy" and key.export_public_key("openssh").split()[1] == authorized_line.split()[1].encode()

    async def handle(process):
        process.stdout.write("deploy\ndocker\n")
        process.exit(0)

    async def start():
        server = await asyncssh.create_server(Server, "127.0.0.1", 0, server_host_keys=[host_key], process_factory=handle)
        port = server.sockets[0].getsockname()[1]
        return server, port

    return start, host_key


def test_check_logs_in_with_the_right_key(real_ssh):
    key = sshkeys.generate("t@wharfline")
    start, host_key = _serve(key.public_line)

    async def run():
        server, port = await start()
        try:
            return await sshcheck.check("127.0.0.1", port, "deploy", key.private_openssh)
        finally:
            server.close()

    r = asyncio.run(run())
    assert r["reachable"] and r["login"], r
    assert r["type"] == "ED25519"
    assert r["fingerprint"] == host_key.get_fingerprint("sha256")
    assert r["loginUser"] == "deploy" and r["docker"] == "docker"


def test_check_reports_a_key_the_server_does_not_know(real_ssh):
    good, other = sshkeys.generate("a@wharfline"), sshkeys.generate("b@wharfline")
    start, _ = _serve(good.public_line)

    async def run():
        server, port = await start()
        try:
            return await sshcheck.check("127.0.0.1", port, "deploy", other.private_openssh)
        finally:
            server.close()

    r = asyncio.run(run())
    assert r["reachable"] and not r["login"]
    assert r["fingerprint"].startswith("SHA256:")  # still shown, to compare
    assert "로그인하지 못했어요" in r["error"]


def test_check_reports_a_closed_port(real_ssh):
    import socket

    with socket.socket() as sock:  # a free port nothing listens on
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    r = asyncio.run(sshcheck.check("127.0.0.1", port, "deploy", sshkeys.generate("c@wharfline").private_openssh))
    assert not r["reachable"] and not r["login"]
    assert "127.0.0.1" in r["error"]


def test_check_endpoint(client, login):
    r = client.post("/api/inventory/check", json={"ip": "10.9.0.21", "port": 22, "user": "deploy", "key": "prod-deploy"})
    assert r.status_code == 200, r.text
    assert r.json()["login"] is True and r.json()["fingerprint"].startswith("SHA256:")
    assert r.json()["keyName"] == "prod-deploy" and r.json()["keyFingerprint"].startswith("SHA256:")
    assert client.post("/api/inventory/check", json={"ip": "10.9.0.21", "port": 22, "user": "root", "key": "prod-deploy"}).status_code == 400
    assert client.post("/api/inventory/check", json={"ip": "10.9.0.21", "port": 22, "user": "deploy", "key": "nope"}).status_code == 400
    assert client.post("/api/inventory/check", json={"ip": "bad host!", "port": 22, "user": "deploy", "key": "prod-deploy"}).status_code == 400
