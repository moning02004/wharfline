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


# ---------- playbook variables and password login ----------

def _play_plan(**kw) -> executor.Plan:
    return executor.Plan(no=990100, kind="playbook", job_name="t", steps=list(executor.PLAYBOOK_STEPS), key_name="deploy-key",
                         extra_vars={"app_name": "shop", "registry_password": "reg-token-1"}, **kw)


def test_playbook_vars_order_wharfline_wins_and_passwords_last():
    plan = _play_plan(play_vars={"region": "kr", "app_name": "mine"}, secret_vars={"db_pass": "s3cret-db"},
                      login=("ops", "login-pw-1"), login_key_name="ops-pw", become_password="sudo-pw-1", become_key_name="sudo")
    xv = executor.playbook_vars(plan, {**plan.extra_vars, "env_src": "/tmp/x/app.env"})
    assert xv == {"region": "kr", "app_name": "shop", "db_pass": "s3cret-db", "registry_password": "reg-token-1",
                  "env_src": "/tmp/x/app.env", "ansible_password": "login-pw-1", "ansible_become_password": "sudo-pw-1"}
    assert list(xv)[-2:] == ["ansible_password", "ansible_become_password"]


def test_playbook_vars_without_options_is_wharfline_only():
    plan = _play_plan()
    assert executor.playbook_vars(plan) == plan.extra_vars
    assert "ansible_password" not in executor.playbook_vars(plan)


def test_shown_vars_masks_secrets_and_hides_passwords():
    plan = _play_plan(play_vars={"region": "kr"}, secret_vars={"db_pass": "s3cret-db"},
                      login=("ops", "login-pw-1"), login_key_name="ops-pw", become_password="sudo-pw-1", become_key_name="sudo")
    shown = executor.shown_vars(plan, {**plan.extra_vars, "env_src": "/tmp/x/app.env"})
    assert shown == f"-e region=kr -e db_pass={executor.MASK} -e app_name=shop"
    for secret in ("s3cret-db", "login-pw-1", "sudo-pw-1", "reg-token-1", "ansible_password", "ansible_become_password", "env_src"):
        assert secret not in shown


def test_ssh_args_keep_the_host_key_pinned():
    key = executor.ssh_args("/tmp/r/known_hosts", False)
    assert key == ("-o UserKnownHostsFile=/tmp/r/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes "
                   "-o ControlMaster=auto -o ControlPersist=60s")
    pw = executor.ssh_args("/tmp/r/known_hosts", True)
    assert "-o UserKnownHostsFile=/tmp/r/known_hosts -o StrictHostKeyChecking=yes" in pw
    assert "-o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no" in pw
    assert "BatchMode" not in pw and "IdentitiesOnly" not in pw


def test_access_lines_name_keys_not_secrets():
    assert executor.access_lines(_play_plan()) == [("", "접속: SSH 키 deploy-key")]
    plan = _play_plan(play_vars={"region": "kr"}, secret_vars={"db_pass": "s3cret-db"},
                      login=("ops", "login-pw-1"), login_key_name="ops-pw", become_password="sudo-pw-1", become_key_name="sudo")
    lines = executor.access_lines(plan)
    assert lines == [("", "접속: 비밀번호 · 계정 ops (키 ops-pw)"), ("", "sudo 비밀번호: 키 sudo"),
                     ("", "플레이북 변수: 일반 1개 · 비밀 1개")]
    assert not any(x in text for _, text in lines for x in ("login-pw-1", "sudo-pw-1", "s3cret-db"))


def test_password_login_user_goes_into_the_inventory():
    t = executor.Target(1, "web-1", "10.0.0.5", 22, "ops", "web", None)
    assert executor.inventory([t])["all"]["children"]["web"]["hosts"]["web-1"]["ansible_user"] == "ops"


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


@pytest.mark.parametrize("url,expected", [
    ("https://git.ermore.ai/ermore/infra", ("git.ermore.ai", 443)),
    ("https://git.example.com:8443/o/r.git", ("git.example.com", 8443)),
    ("git@github.com:org/ansible.git", ("github.com", 22)),
    ("ssh://git@git.example.com:2222/o/r.git", ("git.example.com", 2222)),
])
def test_git_host(url, expected):
    assert executor.git_host(url) == expected


@pytest.mark.parametrize("line,says", [
    ("fatal: unable to access 'https://git.ermore.ai/ermore/infra/': Failed to connect to git.ermore.ai port 443 after 2 ms: "
     "Could not connect to server", "git.ermore.ai:443에 연결하지 못했어요"),
    ("fatal: unable to access 'https://git.ermore.ai/x/': Could not resolve host: git.ermore.ai", "주소를 찾지 못했어요(DNS)"),
    ("fatal: Authentication failed for 'https://git.ermore.ai/ermore/infra/'", "로그인하지 못했어요 (토큰 · ops-read)"),
    ("remote: Repository not found.", "저장소를 찾지 못했어요"),
    ("warning: Could not find remote branch prod to clone.", "브랜치 main가 저장소에 없어요"),
    ("fatal: unable to access 'https://x/': SSL certificate problem: certificate has expired", "인증서를 믿을 수 없어요"),
    ("something else", "주소, 브랜치, 키/토큰 권한을 확인해 주세요."),
])
def test_git_clone_hint_names_the_cause(line, says):
    assert says in executor.git_clone_hint([line], "https://git.ermore.ai/ermore/infra", "main", "토큰 · ops-read")
