"""The real deploy runner (app/executor.py): helpers, and script runs through a fake agent on the task hub."""

import asyncio
import base64
import os
import stat
import subprocess

import pytest

from app import executor, runner
from app.agenthub import HUB


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


# ---------- playbook variables ----------

def _play_plan(**kw) -> executor.Plan:
    return executor.Plan(no=990100, kind="playbook", job_name="t", steps=list(executor.PLAYBOOK_STEPS), run_user="deploy",
                         extra_vars={"app_name": "shop", "registry_password": "reg-token-1"}, **kw)


def test_playbook_vars_order_wharfline_wins():
    plan = _play_plan(play_vars={"region": "kr", "app_name": "mine"}, secret_vars={"db_pass": "s3cret-db"})
    xv = executor.playbook_vars(plan, {**plan.extra_vars, "env_src": "/tmp/x/app.env"})
    assert xv == {"region": "kr", "app_name": "shop", "db_pass": "s3cret-db", "registry_password": "reg-token-1", "env_src": "/tmp/x/app.env"}


def test_playbook_vars_without_options_is_wharfline_only():
    plan = _play_plan()
    assert executor.playbook_vars(plan) == plan.extra_vars


def test_playbook_vars_turn_yes_no_and_lists_into_values():
    plan = _play_plan(play_vars={"tls": "true", "off": "false", "peers": "[laptop, phone]", "opts": '{"live-restore": true}',
                                 "port": "2222", "text": "[not a list", "note": "a [b]"},
                      secret_vars={"pw": "true"})
    xv = executor.playbook_vars(plan)
    assert xv["tls"] is True and xv["off"] is False
    assert xv["peers"] == ["laptop", "phone"] and xv["opts"] == {"live-restore": True}
    assert xv["port"] == "2222" and xv["text"] == "[not a list" and xv["note"] == "a [b]"
    assert xv["pw"] == "true"  # secrets are passed as typed


def test_shown_vars_masks_secrets():
    plan = _play_plan(play_vars={"region": "kr"}, secret_vars={"db_pass": "s3cret-db"})
    shown = executor.shown_vars(plan, {**plan.extra_vars, "env_src": "/tmp/x/app.env"})
    assert shown == f"-e region=kr -e db_pass={executor.MASK} -e app_name=shop"
    for secret in ("s3cret-db", "reg-token-1", "env_src"):
        assert secret not in shown


def test_access_lines_name_the_account_not_secrets():
    assert executor.access_lines(_play_plan()) == [("", "실행: 각 서버의 에이전트 · 서버 계정 deploy")]
    lines = executor.access_lines(_play_plan(play_vars={"region": "kr"}, secret_vars={"db_pass": "s3cret-db"}))
    assert lines[1] == ("", "플레이북 변수: 일반 1개 · 비밀 1개")


# ---------- compose file from a repo ----------

class _Lines:
    def __init__(self):
        self.seen: list[tuple[str, str]] = []

    def line(self, colour, text):
        self.seen.append((colour, text))


def _compose_plan() -> executor.Plan:
    plan = executor.Plan(no=990101, kind="script", job_name="t", steps=[], compose_path="deploy/compose.yml", compose_tag="v2")
    plan.repo = {"url": "https://git.acme.kr/a/b.git", "branch": "main", "auth": "공개 저장소"}
    return plan


def test_compose_ref_tag_prefers_the_pinned_version():
    extras = [{"var": "API", "defaultTag": "latest"}, {"var": "WEB", "defaultTag": "v3"}]
    assert executor.compose_ref_tag({"extraImages": []}, "v1") == "v1"
    assert executor.compose_ref_tag({"extraImages": extras}, "-") == "v3"
    assert executor.compose_ref_tag({"extraImages": extras, "extraTags": {"API": "v9"}}, "latest") == "v9"
    assert executor.compose_ref_tag({"extraImages": [{"var": "API", "defaultTag": "latest"}]}, "-") == ""


def test_refresh_compose_uses_the_tag(monkeypatch):
    asked = []

    async def fake(repo, ref, path):
        asked.append((ref, path))
        return "services: {}\n", "abc1234"

    monkeypatch.setattr(executor, "read_repo_file", fake)
    plan, out = _compose_plan(), _Lines()
    assert asyncio.run(executor.refresh_compose(plan, out)) is True
    assert asked == [("v2", "deploy/compose.yml")]
    assert plan.files == [{"path": "compose.yml", "content": "services: {}\n"}]  # the repo file keeps its compose name


def test_refresh_compose_falls_back_to_the_branch_when_the_tag_is_missing(monkeypatch):
    async def fake(repo, ref, path):
        if ref == "v2":
            raise executor.RefNotFound("없어요")
        return "from branch\n", "abc1234"

    monkeypatch.setattr(executor, "read_repo_file", fake)
    plan, out = _compose_plan(), _Lines()
    assert asyncio.run(executor.refresh_compose(plan, out)) is True
    assert plan.files[0]["content"] == "from branch\n"
    assert any(c == "y" and "v2" in t for c, t in out.seen)


def test_refresh_compose_stops_when_the_repo_cannot_be_read(monkeypatch):
    async def fake(repo, ref, path):
        raise executor.RepoFileError("로그인하지 못했어요")

    monkeypatch.setattr(executor, "read_repo_file", fake)
    plan, out = _compose_plan(), _Lines()
    assert asyncio.run(executor.refresh_compose(plan, out)) is False
    assert plan.files == [] and any(c == "r" and "로그인" in t for c, t in out.seen)


# ---------- script runs through a fake agent ----------
# The fake agent takes tasks off the hub the way routers/agent.py hands them out, writes files under the test's
# folder and runs commands with sh, so the executor ↔ agent protocol is exercised without a server.

def _fake_agent(host_id: int, ran: list[str], deny_under: str | None = None):
    async def serve():
        while True:
            task = await HUB.next_task(host_id, 5)
            if task is None:
                continue
            op = task.op
            if op["op"] == "write":
                result = {"ok": True}
                for f in op["files"]:
                    if deny_under and f["path"].startswith(deny_under):
                        result = {"ok": False, "error": f"{f['path']} 은(는) 이 서버의 에이전트가 허용한 경로 밖이에요"}
                        break
                    os.makedirs(os.path.dirname(f["path"]), exist_ok=True)
                    with open(f["path"], "wb") as fh:
                        fh.write(base64.b64decode(f["content"]))
                    os.chmod(f["path"], f["mode"])
            elif op["op"] == "exec":
                ran.append(op.get("stdin") or op["cmd"])
                r = subprocess.run(["sh", "-c", "sh -s" if op.get("stdin") else op["cmd"]], input=op.get("stdin") or "",
                                   capture_output=True, text=True)
                for line in (r.stdout + r.stderr).splitlines():
                    HUB.line(task.id, line)
                result = {"ok": r.returncode == 0, "rc": r.returncode}
            else:
                result = {"ok": False, "error": "unknown"}
            HUB.finish(task.id, result)
    return serve


def _plan(svc: str, script: list[dict], host_id: int = 7001) -> executor.Plan:
    job = {"script": script, "files": [{"path": "compose.yml"}]}
    return executor.Plan(
        no=990001, kind="script", job_name="t", steps=executor.script_steps(job, True, False),
        targets=[executor.Target(host_id, "web-1", "10.0.0.5", 22, "deploy", "web", None)],
        run_user="deploy", script=script, files=[{"path": "compose.yml", "content": "services: {}\n"}],
        service_path=svc, variables={"SERVICE_PATH": svc}, env_vars=[["DB_PASSWORD", "s3cret-value"]],
        env_path=f"{svc}/.env", env_label="t v1", done_label="t", secrets=["s3cret-value"],
    )


def _run(plan: executor.Plan, ran: list[str], deny_under: str | None = None, online: bool = True):
    async def go():
        runner.live[plan.no] = {"events": [], "done": False, "cancelled": False}
        agent = asyncio.get_running_loop().create_task(_fake_agent(plan.targets[0].id, ran, deny_under)()) if online else None
        try:
            return await executor._run_script(plan, executor.Out(plan))
        finally:
            if agent:
                agent.cancel()
    ok = asyncio.run(go())
    events = runner.live.pop(plan.no)["events"]
    executor._release(plan)
    HUB.seen.clear()
    HUB.queues.clear()
    return ok, events


@pytest.mark.skipif(os.name != "posix", reason="the fake agent runs sh")
def test_script_run_writes_files_and_runs_each_step(tmp_path):
    svc = str(tmp_path / "svc")
    ran: list[str] = []
    script = [{"name": "받기", "run": "echo pulled"}, {"name": "올리기", "run": "echo up"}]
    plan = _plan(svc, script)
    ok, events = _run(plan, ran)
    texts = [e.get("text", "") for e in events]
    assert ok, texts
    assert (tmp_path / "svc" / "compose.yml").read_text() == "services: {}\n"
    env = tmp_path / "svc" / ".env"
    assert env.read_text() == "DB_PASSWORD=s3cret-value\n"
    assert stat.S_IMODE(env.stat().st_mode) == 0o600
    assert len(ran) == 2 and "echo pulled" in ran[0] and f"export SERVICE_PATH={svc}" in ran[0]
    assert any("[web-1] pulled" in t for t in texts)
    assert any("✔ 배포 성공" in t for t in texts)
    assert not any("s3cret-value" in t for t in texts)
    steps = [e for e in events if e["t"] == "step" and e["state"] != "run"]
    assert [e["state"] for e in steps] == ["ok"] * len(plan.steps[1:])


@pytest.mark.skipif(os.name != "posix", reason="the fake agent runs sh")
def test_script_run_stops_a_server_after_a_failed_step(tmp_path):
    ran: list[str] = []
    plan = _plan(str(tmp_path / "svc"), [{"name": "실패", "run": "exit 1"}, {"name": "다음", "run": "echo never"}])
    ok, events = _run(plan, ran)
    texts = [e.get("text", "") for e in events]
    assert not ok
    assert len(ran) == 1  # the second step never ran
    assert any("failed: [web-1] exit 1" in t for t in texts)
    assert any("skipping: [web-1]" in t for t in texts)
    assert any("✘ 배포 실패" in t for t in texts)


def test_a_path_the_agent_refuses_names_the_reason(tmp_path):
    plan = _plan(str(tmp_path / "svc"), [{"name": "x", "run": "true"}])
    ok, events = _run(plan, [], deny_under=str(tmp_path))
    texts = [e.get("text", "") for e in events]
    assert not ok
    failed = next(t for t in texts if t.startswith("failed: [web-1]"))
    assert "허용한 경로 밖" in failed, failed


def test_an_offline_agent_is_unreachable(tmp_path, monkeypatch):
    monkeypatch.setattr(executor, "AGENT_WAIT", 0.2)
    plan = _plan(str(tmp_path / "svc"), [{"name": "x", "run": "true"}], host_id=7002)
    ok, events = _run(plan, [], online=False)
    texts = [e.get("text", "") for e in events]
    assert not ok
    assert any(t.startswith("unreachable: [web-1]") and "wharfline-agent" in t for t in texts)


def test_apply_pin_points_tags_at_the_digest():
    d = "sha256:" + "a" * 64
    plan = _plan("/srv/x", [])
    plan.variables.update(IMAGE="ghcr.io/a/api", IMAGE_TAG="v1", IMAGE_REF="ghcr.io/a/api:v1", WEB_TAG="v2", APP_VERSION="v2")
    executor.apply_pin(plan, {"ref": "ghcr.io/a/api", "tag": "v1", "role": "main"}, d)
    executor.apply_pin(plan, {"ref": "ghcr.io/a/web", "tag": "v2", "role": "extra", "var": "WEB", "tagVar": "APP_VERSION"}, d)
    v = plan.variables
    assert v["IMAGE_REF"] == f"ghcr.io/a/api:v1@{d}" and v["IMAGE_TAG"] == f"v1@{d}" and v["IMAGE_VERSION"] == "v1"
    assert v["WEB_TAG"] == f"v2@{d}" and v["APP_VERSION"] == f"v2@{d}" and v["WEB_DIGEST"] == d
    pb = _play_plan()
    executor.apply_pin(pb, {"ref": "ghcr.io/a/api", "tag": "v1", "role": "main"}, d)
    assert pb.extra_vars["image_ref"] == f"ghcr.io/a/api:v1@{d}" and pb.extra_vars["image_digest"] == d


def test_a_tag_variable_shared_by_images_keeps_the_plain_tag(monkeypatch):
    """`app:${IMAGE_TAG}` and `worker:${IMAGE_TAG}`: the app's digest must not reach the worker's pull."""
    app, worker, other = "git.example.com/o/app", "git.example.com/o/worker", "git.example.com/o/web"
    d = "sha256:" + "b" * 64
    plan = _plan("/srv/x", [])
    plan.files = [{"path": "docker-compose.yml", "content":
                   f"services:\n  app:\n    image: {app}:${{IMAGE_TAG}}\n  worker:\n    image: {worker}:${{IMAGE_TAG}}\n"
                   f"  web:\n    image: \"{other}:${{WEB_TAG:-latest}}\"\n"}]
    plan.pins = [{"ref": app, "tag": "v3", "role": "main"},
                 {"ref": other, "tag": "v9", "role": "extra", "var": "WEB", "tagVar": "WEB_TAG"}]
    monkeypatch.setattr(executor.registryclient, "resolve", lambda *a: d)
    monkeypatch.setattr(executor, "_stored_digest", lambda *a: "")
    monkeypatch.setattr(executor, "_save_digest", lambda *a: None)
    runner.live[plan.no] = {"events": [], "done": False, "cancelled": False}
    assert asyncio.run(executor.pin_images(plan, executor.Out(plan)))
    v = plan.variables
    assert v["IMAGE_TAG"] == "v3" and v["IMAGE_REF"] == f"{app}:v3@{d}" and v["IMAGE_DIGEST"] == d
    assert v["WEB_TAG"] == f"v9@{d}"  # read by one image only: pinned
    texts = [e.get("text", "") for e in runner.live[plan.no]["events"]]
    assert any("IMAGE_TAG" in t and "worker" in t for t in texts)


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
