"""The real deploy runner (app/executor.py): helpers, and an SSH script run against a local asyncssh server."""

import asyncio
import os
import stat

import asyncssh
import pytest

from app import executor, runner, sshkeys


def test_mask_hides_every_secret():
    assert executor.mask("token=abcd1234 pw=hunter22", ["hunter22", "abcd1234"]) == f"token={executor.MASK} pw={executor.MASK}"


@pytest.mark.parametrize("line,cls", [
    ("TASK [Gathering Facts] *********", "h"),
    ("PLAY RECAP *****", "h"),
    ("ok: [web-1]", "g"),
    ("changed: [web-1]", "y"),
    ("skipping: [web-1]", "y"),
    ("fatal: [web-1]: UNREACHABLE! => {}", "r"),
    ("web-1   : ok=3    changed=1    unreachable=0    failed=0    skipped=0", "g"),
    ("web-1   : ok=2    changed=0    unreachable=0    failed=1    skipped=0", "r"),
    ("[WARNING]: Platform linux", "y"),
    ("plain output", ""),
])
def test_classify_ansible_lines(line, cls):
    assert executor.classify(line) == cls


def test_inventory_groups_hosts_with_safe_names():
    t = executor.Target(1, "web 1", "10.0.0.5", 2222, "deploy", "web", None)
    inv = executor.inventory([t])
    assert inv == {"all": {"children": {"web": {"hosts": {"web-1": {"ansible_host": "10.0.0.5", "ansible_port": 2222, "ansible_user": "deploy"}}}}}}


def test_known_hosts_line_uses_brackets_for_other_ports():
    key = asyncssh.generate_private_key("ssh-ed25519")
    assert executor.known_hosts_line("10.0.0.5", 22, key).startswith("10.0.0.5 ssh-ed25519 ")
    assert executor.known_hosts_line("10.0.0.5", 2222, key).startswith("[10.0.0.5]:2222 ssh-ed25519 ")


ENV_CASES = [["A", "plain-v1.2"], ["B", "has space"], ["C", 'q"uote'], ["D", "pa$word"], ["E", "it's $x"], ["F", "a #b"], ["G", ""]]


def test_env_file_for_compose_keeps_dollar_signs_literal():
    text = executor.env_file_text(ENV_CASES)
    assert text == ("A=plain-v1.2\nB='has space'\nC='q\"uote'\nD='pa$word'\n"
                    "E=\"it's \\$x\"\nF='a #b'\nG=\n")


def test_env_file_for_docker_run_is_raw():
    text = executor.env_file_text(ENV_CASES, "docker")
    assert text == "A=plain-v1.2\nB=has space\nC=q\"uote\nD=pa$word\nE=it's $x\nF=a #b\nG=\n"
    with pytest.raises(ValueError):
        executor.env_file_text([["K", "two\nlines"]], "docker")


def test_safe_remote_path_stays_inside_the_service_folder():
    assert executor.safe_remote_path("/srv/app", "conf/nginx.conf") == "/srv/app/conf/nginx.conf"
    for bad in ["../etc/passwd", "/etc/passwd", "a/../../b", ""]:
        with pytest.raises(ValueError):
            executor.safe_remote_path("/srv/app", bad)


def test_script_text_exports_quoted_variables():
    assert executor.script_text({"IMAGE_TAG": "v1; rm -rf /"}, "echo $IMAGE_TAG") == "set -e\nexport IMAGE_TAG='v1; rm -rf /'\necho $IMAGE_TAG\n"


def test_step_names_follow_the_job():
    job = {"script": [{"name": "올리기", "run": "x"}, {"name": "확인", "run": "y"}], "files": [{"path": "a"}]}
    assert executor.script_steps(job, True, False) == ["준비", "서버 연결", "파일 올리기", ".env 전송", "올리기", "확인", "마무리"]


# ---------- an SSH script run against a real (local) SSH server ----------

def _server(authorized_line: str, commands: list[str]):
    host_key = asyncssh.generate_private_key("ssh-ed25519")

    class Server(asyncssh.SSHServer):
        def begin_auth(self, username):
            return True

        def public_key_auth_supported(self):
            return True

        def validate_public_key(self, username, key):
            return username == "deploy" and key.export_public_key("openssh").split()[1] == authorized_line.split()[1].encode()

    async def handle(process):
        body = await process.stdin.read()
        commands.append(body)
        if "exit 1" in body:
            process.stdout.write("boom\n")
            process.exit(1)
            return
        process.stdout.write("ran\n")
        process.exit(0)

    async def start():
        server = await asyncssh.create_server(Server, "127.0.0.1", 0, server_host_keys=[host_key], process_factory=handle,
                                              sftp_factory=True)
        return server, server.sockets[0].getsockname()[1]

    return start, host_key


def _plan(port: int, fingerprint: str, key: str, svc: str, script: list[dict]) -> executor.Plan:
    job = {"script": script, "files": [{"path": "compose.yml"}]}
    return executor.Plan(
        no=990001, kind="script", job_name="t", steps=executor.script_steps(job, True, False),
        targets=[executor.Target(1, "web-1", "127.0.0.1", port, "deploy", "web", fingerprint)],
        ssh_key=key, key_name="k", script=script, files=[{"path": "compose.yml", "content": "services: {}\n"}],
        service_path=svc, variables={"SERVICE_PATH": svc}, env_vars=[["DB_PASSWORD", "s3cret-value"]],
        env_path=f"{svc}/.env", env_label="t v1", done_label="t", secrets=["s3cret-value"],
    )


@pytest.mark.skipif(os.name != "posix", reason="the test SFTP server writes POSIX paths")
def test_script_run_uploads_files_and_runs_each_step(tmp_path):
    key = sshkeys.generate("t@wharfline")
    commands: list[str] = []
    start, host_key = _server(key.public_line, commands)
    svc = str(tmp_path / "svc")
    script = [{"name": "받기", "run": "docker compose pull"}, {"name": "올리기", "run": "docker compose up -d"}]

    async def go():
        server, port = await start()
        plan = _plan(port, host_key.get_fingerprint("sha256"), key.private_openssh, svc, script)
        runner.live[plan.no] = {"events": [], "done": False, "cancelled": False}
        try:
            return plan, await executor._run_script(plan, executor.Out(plan))
        finally:
            server.close()

    plan, ok = asyncio.run(go())
    events = runner.live.pop(plan.no)["events"]
    executor._release(plan)
    texts = [e.get("text", "") for e in events]
    assert ok, texts
    assert (tmp_path / "svc" / "compose.yml").read_text() == "services: {}\n"
    env = tmp_path / "svc" / ".env"
    assert env.read_text() == "DB_PASSWORD=s3cret-value\n"
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert len(commands) == 2 and "docker compose pull" in commands[0] and f"export SERVICE_PATH={svc}" in commands[0]
    assert any("✔ 배포 성공" in t for t in texts)
    assert not any("s3cret-value" in t for t in texts)
    steps = [e for e in events if e["t"] == "step" and e["state"] != "run"]
    assert [e["state"] for e in steps] == ["ok"] * len(plan.steps[1:])


@pytest.mark.skipif(os.name != "posix", reason="the test SFTP server writes POSIX paths")
def test_script_run_stops_a_server_after_a_failed_step(tmp_path):
    key = sshkeys.generate("t@wharfline")
    commands: list[str] = []
    start, host_key = _server(key.public_line, commands)
    script = [{"name": "실패", "run": "exit 1"}, {"name": "다음", "run": "echo never"}]

    async def go():
        server, port = await start()
        plan = _plan(port, host_key.get_fingerprint("sha256"), key.private_openssh, str(tmp_path / "svc"), script)
        runner.live[plan.no] = {"events": [], "done": False, "cancelled": False}
        try:
            return plan, await executor._run_script(plan, executor.Out(plan))
        finally:
            server.close()

    plan, ok = asyncio.run(go())
    events = runner.live.pop(plan.no)["events"]
    executor._release(plan)
    texts = [e.get("text", "") for e in events]
    assert not ok
    assert len(commands) == 1  # the second step never ran
    assert any("failed: [web-1] exit 1" in t for t in texts)
    assert any("skipping: [web-1]" in t for t in texts)
    assert any("✘ 배포 실패" in t for t in texts)


@pytest.mark.skipif(os.name != "posix" or (hasattr(os, "geteuid") and os.geteuid() == 0), reason="needs POSIX permissions (root ignores them)")
def test_a_folder_the_user_cannot_write_names_the_path(tmp_path):
    key = sshkeys.generate("t@wharfline")
    start, host_key = _server(key.public_line, [])
    locked = tmp_path / "locked"
    locked.mkdir(mode=0o500)  # exists, not writable: like a service folder owned by another user

    async def go():
        server, port = await start()
        plan = _plan(port, host_key.get_fingerprint("sha256"), key.private_openssh, str(locked / "svc"), [{"name": "x", "run": "true"}])
        runner.live[plan.no] = {"events": [], "done": False, "cancelled": False}
        try:
            return plan, await executor._run_script(plan, executor.Out(plan))
        finally:
            server.close()

    try:
        plan, ok = asyncio.run(go())
    finally:
        locked.chmod(0o700)
    texts = [e.get("text", "") for e in runner.live.pop(plan.no)["events"]]
    executor._release(plan)
    assert not ok
    failed = next(t for t in texts if t.startswith("failed: [web-1]"))
    assert f"{locked}/svc 폴더 만들기 실패" in failed and "deploy 사용자에게" in failed and "chown" in failed, failed


def test_a_changed_host_key_skips_the_server(tmp_path, monkeypatch):
    key = sshkeys.generate("t@wharfline")
    start, _ = _server(key.public_line, [])
    saved: list[dict] = []
    monkeypatch.setattr(executor, "_save_host", lambda host_id, **v: saved.append(v))

    async def go():
        server, port = await start()
        plan = _plan(port, "SHA256:" + "A" * 43, key.private_openssh, str(tmp_path / "svc"), [{"name": "x", "run": "true"}])
        runner.live[plan.no] = {"events": [], "done": False, "cancelled": False}
        try:
            return plan, await executor._run_script(plan, executor.Out(plan))
        finally:
            server.close()

    plan, ok = asyncio.run(go())
    texts = [e.get("text", "") for e in runner.live.pop(plan.no)["events"]]
    executor._release(plan)
    assert not ok
    assert saved == [{"host_key": "changed"}]
    assert any("호스트 키가 바뀌었어요" in t for t in texts)
