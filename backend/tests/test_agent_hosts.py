"""Internal addresses: "private IP → names" kept in the agent settings, written into the servers' /etc/hosts and used
by the install command's curl, so a server on the private network needs no hand edit before it can reach Wharfline."""

import shutil
import subprocess

import pytest

from app import agentinstall, serverinit
from tests.conftest import OWNER


def test_parse_hosts_reads_etc_hosts_lines():
    pairs = agentinstall.parse_hosts("# 사내망\n10.0.1.6  deploy.Example.com git.example.com.\n\n10.0.1.9 db.example.com # 메모\n")
    assert pairs == [["10.0.1.6", "deploy.example.com"], ["10.0.1.6", "git.example.com"], ["10.0.1.9", "db.example.com"]]
    assert agentinstall.hosts_text(pairs) == "10.0.1.6 deploy.example.com git.example.com\n10.0.1.9 db.example.com\n"


@pytest.mark.parametrize("text,msg", [
    ("deploy.example.com 10.0.1.6", "IP 주소가 아니에요"),
    ("10.0.1.6", "도메인을 적어 주세요"),
    ("10.0.1.6 bad_name.example.com", "도메인으로 쓸 수 없어요"),
    ("10.0.1.6 a.example.com\n10.0.1.7 a.example.com", "두 곳에"),
])
def test_parse_hosts_rejects_what_hosts_files_cannot_hold(text, msg):
    with pytest.raises(ValueError, match=msg):
        agentinstall.parse_hosts(text)


def test_curl_goes_straight_to_the_internal_address():
    pairs = [["10.0.1.6", "deploy.example.com"]]
    assert agentinstall.curl_resolve("https://deploy.example.com", pairs) == "--resolve deploy.example.com:443:10.0.1.6 "
    assert agentinstall.curl_resolve("http://deploy.example.com:8080", pairs) == "--resolve deploy.example.com:8080:10.0.1.6 "
    assert agentinstall.curl_resolve("https://other.example.com", pairs) == ""
    assert agentinstall.curl_resolve("https://deploy.example.com", [["fd00::6", "deploy.example.com"]]) == \
        "--resolve deploy.example.com:443:[fd00::6] "


def _run_hosts_lines(tmp_path, pairs, before: str) -> str:
    """Run the generated shell against a copy of /etc/hosts and return what it wrote."""
    sh = shutil.which("sh")
    if not sh or not shutil.which("awk"):
        pytest.skip("needs sh and awk")
    hosts = tmp_path / "hosts"
    hosts.write_text(before, encoding="utf-8", newline="\n")
    script = "set -eu\n" + "\n".join(agentinstall.hosts_lines(pairs)).replace("/etc/hosts", hosts.as_posix()) + "\n"
    r = subprocess.run([sh, "-c", script], capture_output=True, text=True, encoding="utf-8", timeout=20)
    assert r.returncode == 0, r.stdout + r.stderr
    return hosts.read_text(encoding="utf-8")


def test_the_block_goes_on_top_and_replaces_the_last_one(tmp_path):
    before = "127.0.0.1 localhost\n10.0.1.7 deploy.example.com\n"
    once = _run_hosts_lines(tmp_path, [["10.0.1.6", "deploy.example.com"], ["10.0.1.6", "git.example.com"]], before)
    assert once == ("# BEGIN wharfline\n10.0.1.6 deploy.example.com git.example.com\n# END wharfline\n"
                    "127.0.0.1 localhost\n10.0.1.7 deploy.example.com\n")  # ahead of the old hand-made line
    twice = _run_hosts_lines(tmp_path, [["10.0.1.8", "deploy.example.com"]], once)
    assert twice == "# BEGIN wharfline\n10.0.1.8 deploy.example.com\n# END wharfline\n127.0.0.1 localhost\n10.0.1.7 deploy.example.com\n"
    assert agentinstall.hosts_lines([]) == []  # nothing set: /etc/hosts is not touched (and no sudo is tried)


def test_every_install_path_writes_the_block():
    pairs = [["10.0.1.6", "deploy.example.com"]]
    for text in (agentinstall.install_script("https://deploy.example.com", "img:1", pairs),
                 serverinit.init_script("deploy", "/srv", False, "https://deploy.example.com", "img:1", pairs),
                 serverinit.convert_script("deploy", "/srv", "https://deploy.example.com", "img:1", pairs)):
        assert "'# BEGIN wharfline' '10.0.1.6 deploy.example.com' '# END wharfline'" in text
        assert text.index("BEGIN wharfline") < text.index("docker run -d --name wharfline-agent")  # before the agent starts
    assert "BEGIN wharfline' '" not in agentinstall.install_script("https://deploy.example.com", "img:1")


def test_agent_settings_keep_internal_addresses(client, login):
    login(OWNER, sudo=True)
    r = client.put("/api/agent-settings", json={"url": "", "hosts": "10.0.1.6 deploy.test git.test\n"})
    assert r.status_code == 200, r.text
    assert r.json()["hosts"] == "10.0.1.6 deploy.test git.test\n"
    assert client.put("/api/agent-settings", json={"url": "", "hosts": "nope deploy.test"}).status_code == 400
    assert client.put("/api/agent-settings", json={"url": ""}).json()["hosts"] == "10.0.1.6 deploy.test git.test\n"  # kept

    inv = next(i for i in client.get("/api/inventory").json() if i["name"] == "staging")
    made = client.post(f"/api/inventory/{inv['id']}/hosts/pending", json={"name": "agent-hosts", "group": "web"}).json()
    assert made["command"].startswith("curl -fsSL --resolve deploy.test:443:10.0.1.6 https://deploy.test/api/agent/install.sh")
    assert "10.0.1.6 deploy.test git.test" in client.get("/api/agent/install.sh").text

    client.put("/api/agent-settings", json={"url": "", "hosts": ""})
    assert "--resolve" not in client.post(f"/api/inventory/{inv['id']}/hosts/pending", json={"name": "agent-hosts-2"}).json()["command"]
