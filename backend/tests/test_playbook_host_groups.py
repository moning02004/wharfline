"""The groups a playbook targets (hosts:) get the servers chosen in Wharfline, so `hosts: gitea` runs on them."""

from app import executor, playinspect

BASE = """
- name: "01 base"
  hosts: "{{ base_hosts | default('all') }}"
  become: true
  tasks: []
"""

GITEA = """
- import_playbook: 01-base.yaml
  vars:
    base_hosts: gitea

- name: "03 gitea"
  hosts: gitea
  become: true
  tasks: []
"""


def _reader(files: dict[str, str]):
    return lambda path: files.get(path)


def test_groups_follow_imports_and_their_vars():
    files = {"03-gitea.yaml": GITEA, "01-base.yaml": BASE}
    assert playinspect.host_groups(_reader(files), "03-gitea.yaml") == ["gitea"]
    # 01-base on its own falls back to its default
    assert playinspect.host_groups(_reader(files), "01-base.yaml") == []  # 'all' is not a group to fill


def test_patterns_and_templates():
    files = {
        "a.yml": """
- hosts: "web:&prod:!db"
  tasks: []
- hosts: "{{ target | default('workers') }}"
  tasks: []
- hosts: "{{ unknown }}"
  tasks: []
- hosts: [api, "web*", localhost]
  tasks: []
- import_playbook: sub/b.yml
""",
        "sub/b.yml": "- hosts: cache\n  tasks: []\n- import_playbook: ../a.yml\n",
    }
    assert playinspect.host_groups(_reader(files), "a.yml") == ["web", "prod", "db", "workers", "api", "cache"]
    assert playinspect.host_groups(_reader(files), "a.yml", {"target": "batch"})[3] == "batch"  # the job's variables win


def test_inventory_puts_chosen_servers_in_the_playbook_groups():
    t = executor.Target(id=1, name="babyverse-ops", ip="10.0.0.5", port=22, user="deploy", group="servers", fingerprint=None)
    inv = executor.inventory([t], ["gitea", "servers"])["all"]["children"]
    assert inv["servers"]["hosts"]["babyverse-ops"]["ansible_host"] == "10.0.0.5"
    assert list(inv["gitea"]["hosts"]) == ["babyverse-ops"]  # a group the playbook wants, filled with the chosen server
    assert list(inv) == ["servers", "gitea"]  # an existing group is left as it is


def test_vaulted_vars_files_are_left_out(tmp_path):
    vault = "$ANSIBLE_VAULT;1.1;AES256\n3132\n"
    (tmp_path / "group_vars" / "all").mkdir(parents=True)
    (tmp_path / "group_vars" / "all" / "vault.yaml").write_text(vault)
    (tmp_path / "group_vars" / "all" / "main.yaml").write_text("app_port: 8080\n")
    (tmp_path / "host_vars").mkdir()
    (tmp_path / "host_vars" / "web1.yml").write_text(vault)
    (tmp_path / "inventory").mkdir()
    (tmp_path / "inventory" / "all.ini.vault").write_text(vault)  # not read by the run: Wharfline writes its own inventory
    (tmp_path / "deploy" / "group_vars").mkdir(parents=True)
    (tmp_path / "deploy" / "group_vars" / "web.yml").write_text(vault)

    assert executor.skip_vaulted_vars(tmp_path, "deploy/site.yml") == [
        "group_vars/all/vault.yaml", "host_vars/web1.yml", "deploy/group_vars/web.yml"]
    assert (tmp_path / "group_vars" / "all" / "main.yaml").exists()  # plain vars stay
    assert (tmp_path / "inventory" / "all.ini.vault").exists()
    assert executor.skip_vaulted_vars(tmp_path, "site.yml") == []


def test_missing_sudo_password_says_what_to_run():
    ops = executor.Target(id=1, name="ops", ip="10.0.0.5", port=22, user="deploy", group="ops", fingerprint=None)
    web = executor.Target(id=2, name="web", ip="10.0.0.6", port=22, user="ubuntu", group="ops", fingerprint=None)
    said = ["TASK [Gathering Facts] ***", "fatal: [ops]: FAILED! => ", "    msg: Missing sudo password"]
    hint = executor.sudo_hint(said, [ops, web])
    assert any("deploy ALL=(ALL) NOPASSWD:ALL" in h and "/etc/sudoers.d/wharfline-deploy" in h for h in hint)
    assert not any("ubuntu" in h for h in hint)  # only the server that asked
    assert executor.sudo_hint(["ok: [ops]"], [ops]) == []
