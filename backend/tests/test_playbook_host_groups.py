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
