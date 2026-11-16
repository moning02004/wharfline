"""playinspect: which files are playbooks, and what a playbook needs filled in."""

import asyncio

from app import executor, playinspect

STACK = """\
# 스택 설치
#   변수        domain                   예) team.example.com → git.team.example.com
#               admin_email              알림 받을 이메일
#               gitea_admin_user         (선택) 기본 admin
#               install_dir              (선택) 설치할 폴더, 기본 /srv
#   비밀 변수   gitea_admin_password     8자 이상
#               ansible_pubkey           ansible 사용자 공개키 한 줄

- name: 스택 설치
  hosts: all
  become: true
  gather_facts: false
  vars:
    stack_root: "{{ install_dir | default('/srv', true) }}"
    git_host: "git.{{ domain }}"
    admin_name: "{{ gitea_admin_user | default('admin', true) }}"
    staging: "{{ '1' if (staging_cert | default(false) | bool) else '0' }}"
  tasks:
    - name: 확인
      ansible.builtin.assert:
        that:
          - domain | default('') is match('^[a-z.]+$')
          - gitea_admin_password | length >= 8
    - name: 키
      ansible.builtin.lineinfile:
        path: /home/ansible/.ssh/authorized_keys
        line: "{{ ansible_pubkey }}"
    - name: 폴더
      ansible.builtin.shell: |
        docker ps --format '{% raw %}{{.Names}}{% endraw %}'
        echo {{ stack_root }} {{ admin_email }}
      register: out
    - name: 결과
      ansible.builtin.debug:
        msg: "{{ out.stdout }} {{ item }} {{ inventory_hostname }} {{ ansible_facts['os_family'] }} {{ image_ref | default('') }}"
      loop: [1]
    - name: nginx
      ansible.builtin.copy:
        src: "{{ playbook_dir }}/nginx/"
        dest: "{{ stack_root }}/nginx/"
    - name: site
      ansible.builtin.template:
        src: stack/site.conf.j2
        dest: /tmp/site.conf
"""


def _vars(result):
    return {v["name"]: v for v in result["vars"]}


def test_finds_what_to_fill_in():
    files = [{"path": "stack.yml", "content": STACK}, {"path": "nginx/compose.yaml", "content": "x"},
             {"path": "stack/site.conf.j2", "content": "server_name {{ git_host }}; {% if tls_on %}ssl{% endif %}"}]
    r = playinspect.inspect(files, "stack.yml")
    v = _vars(r)
    assert set(v) == {"domain", "admin_email", "gitea_admin_user", "install_dir", "gitea_admin_password", "ansible_pubkey",
                      "staging_cert", "tls_on"}
    assert v["domain"]["required"] and not v["domain"]["secret"]
    assert v["domain"]["desc"].startswith("예) team.example.com")
    assert v["gitea_admin_password"]["required"] and v["gitea_admin_password"]["secret"]
    assert v["ansible_pubkey"]["required"]  # an ansible_* name the comments ask for
    assert not v["install_dir"]["required"] and v["install_dir"]["default"] == "/srv"
    assert not v["gitea_admin_user"]["required"] and v["gitea_admin_user"]["default"] == "admin"
    assert v["staging_cert"]["bool"] and not v["staging_cert"]["required"]
    assert r["auto"] == ["image_ref"]  # Wharfline passes it
    assert r["warnings"] == []
    assert any("sudo" in n for n in r["notes"])
    # required ones come first, in the order the comments name them
    names = [x["name"] for x in r["vars"]]
    assert names.index("domain") < names.index("admin_email") < names.index("install_dir")
    assert all(x["required"] for x in r["vars"][:4])


def test_missing_files_are_named():
    r = playinspect.inspect([{"path": "stack.yml", "content": STACK}], "stack.yml")
    assert any("nginx/ 폴더" in w for w in r["warnings"])
    assert any("stack/site.conf.j2" in w for w in r["warnings"])


def test_roles_defaults_and_templates():
    book = "- hosts: web\n  roles:\n    - app\n"
    files = [
        {"path": "site.yml", "content": book},
        {"path": "roles/app/defaults/main.yml", "content": "app_port: 8080\n"},
        {"path": "roles/app/tasks/main.yml", "content": "- ansible.builtin.template:\n    src: app.conf.j2\n    dest: /etc/app.conf\n"
                                                        "- ansible.builtin.debug:\n    msg: '{{ app_port }} {{ db_url }}'\n"},
        {"path": "roles/app/templates/app.conf.j2", "content": "{{ app_secret_token }}"},
    ]
    r = playinspect.inspect(files, "site.yml")
    v = _vars(r)
    assert set(v) == {"db_url", "app_secret_token", "app_port"}
    # a role default is optional, shown with its default
    assert not v["app_port"]["required"] and v["app_port"]["default"] == "8080"
    assert v["db_url"]["required"]
    assert v["app_secret_token"]["secret"]
    assert r["warnings"] == []
    assert any("hosts: web" in n for n in r["notes"])


def test_a_role_template_is_read_from_that_role_only():
    # two roles with a template of the same name: each task reads its own role's file, never the other's
    book = "- hosts: vpn\n  roles:\n    - wireguard\n"
    task = "- ansible.builtin.template:\n    src: docker-compose.yml.j2\n    dest: /opt/x/docker-compose.yml\n"
    files = [
        {"path": "12-vpn.yaml", "content": book},
        {"path": "roles/crowdsec/templates/docker-compose.yml.j2", "content": "{{ crowdsec_version }} {{ crowdsec_lapi_port }}"},
        {"path": "roles/crowdsec/defaults/main.yaml", "content": "crowdsec_version: v1\n"},
        {"path": "roles/wireguard/defaults/main.yaml", "content": "wireguard_version: '1.0'\n"},
        {"path": "roles/wireguard/tasks/main.yaml", "content": task},
        {"path": "roles/wireguard/templates/docker-compose.yml.j2", "content": "{{ wireguard_version }}"},
    ]
    r = playinspect.inspect(files, "12-vpn.yaml")
    assert set(_vars(r)) == {"wireguard_version"}
    assert r["warnings"] == []


ROLE_DEFAULTS = """\
app_version: "1.2"                 # https://example.com/releases
app_domain: ""                     # 필수. 예) app.example.com
app_db_password: ""
# 접속할 기기 이름 (영문, 숫자)
app_peers: [laptop]
app_tls: true
app_note: ""                       # 비우면 안 씀
app_url: "https://{{ app_domain }}/"
app_registration_password_auth: false
app_queue_enabled: true
app_queue_user: ""
app_queue_password: ""
app_cache_enabled: false
app_cache_url: ""
app_confirm: ""
"""
ROLE_TASKS = """\
- name: Check
  ansible.builtin.assert:
    that:
      - app_domain | length > 0
      - app_db_password | length >= 8
      - ansible_architecture == 'x86_64' or app_note | length > 0
      - not app_queue_enabled or (app_queue_user | length > 0 and app_queue_password | length >= 8)
      - not app_cache_enabled or app_cache_url | length > 0
      - app_confirm == 'yes'
- ansible.builtin.include_role:
    name: helper
- ansible.builtin.copy:
    src: app.conf
    dest: /etc/app.conf
- ansible.builtin.debug:
    msg: "{{ app_url }} {{ app_peers }} {{ app_tls }}"
"""


def test_role_defaults_are_optional_unless_an_assert_needs_them():
    book = "# 앱 설치\n#   app_peers 를 바꾸고 다시 실행\n- hosts: all\n  roles:\n    - app\n"
    files = [
        {"path": "site.yml", "content": book},
        {"path": "roles/app/defaults/main.yml", "content": ROLE_DEFAULTS},
        {"path": "roles/app/tasks/main.yml", "content": ROLE_TASKS},
        {"path": "roles/helper/defaults/main.yml", "content": "helper_port: 9000\n"},
    ]
    r = playinspect.inspect(files, "site.yml")
    v = _vars(r)
    # empty and asserted non-empty → required; an assert joined by `or` does not make app_note required
    assert v["app_domain"]["required"] and v["app_domain"]["default"] is None
    assert v["app_db_password"]["required"] and v["app_db_password"]["secret"]
    assert not v["app_note"]["required"]
    # behind a switch that is on by default → required; behind one that is off → optional
    assert v["app_queue_user"]["required"] and v["app_queue_password"]["required"]
    assert not v["app_cache_url"]["required"]
    assert v["app_confirm"]["required"]  # must be a given value
    # the role's comment: trailing, or the lines just above; a playbook line that only names it doesn't win
    assert v["app_domain"]["desc"] == "필수. 예) app.example.com"
    assert v["app_peers"]["desc"] == "접속할 기기 이름 (영문, 숫자)"
    assert v["app_version"]["default"] == "1.2" and v["app_version"]["desc"] == "https://example.com/releases"
    # lists as [..], yes/no as a switch; a yes/no named like a password is not a secret
    assert v["app_peers"]["default"] == '["laptop"]'
    assert v["app_tls"]["bool"] and v["app_tls"]["default"] == "true"
    assert not v["app_registration_password_auth"]["secret"]
    # built from other values → not offered
    assert "app_url" not in v
    # include_role is followed
    assert v["helper_port"]["default"] == "9000"
    # each role default says which role it belongs to; values the playbook itself reads have none
    assert v["app_peers"]["role"] == "app" and v["helper_port"]["role"] == "helper"
    # required first
    assert [x["name"] for x in r["vars"] if x["required"]] == ["app_domain", "app_db_password", "app_queue_user",
                                                                "app_queue_password", "app_confirm"]
    # the role copies app.conf from its own files/
    assert r["warnings"] == ["올린 파일에 없어요: roles/app/files/app.conf (role 이 서버로 복사해요. 같이 올려 주세요)"]
    files.append({"path": "roles/app/files/app.conf", "content": "x"})
    assert playinspect.inspect(files, "site.yml")["warnings"] == []


def test_playbooks_are_lists_of_plays():
    files = [
        {"path": "stack.yml", "content": STACK},
        {"path": "deploy/app.yaml", "content": "- import_playbook: ../stack.yml\n"},
        {"path": "nginx/compose.yaml", "content": "services:\n  web:\n    image: nginx\n"},
        {"path": "roles/app/tasks/main.yml", "content": "- hosts: x\n"},
        {"path": "broken.yml", "content": "- hosts: [\n"},
        {"path": "tests/test.yml", "content": "- hosts: localhost\n"},
        {"path": "roles/web/tests/test.yml", "content": "- hosts: localhost\n"},
        {"path": "deploy/Tests/smoke.yml", "content": "- hosts: all\n"},
        {"path": "contest.yml", "content": "- hosts: all\n"},
    ]
    # role internals and test folders aren't offered; a file merely named like "test" is
    assert playinspect.playbooks(files) == ["contest.yml", "stack.yml", "deploy/app.yaml"]


def test_odd_yaml_is_not_an_error():
    r = playinspect.inspect([{"path": "a.yml", "content": "key: [unclosed\n"}], "a.yml")
    assert r["vars"] == [] and r["warnings"]


class _Out:
    def __init__(self):
        self.lines = []

    def line(self, cls, text):
        self.lines.append((cls, text))


def test_an_uploaded_playbook_is_written_to_the_run_folder(tmp_path):
    plan = executor.Plan(no=1, kind="playbook", job_name="x", steps=[])
    plan.book = "stack.yml"
    plan.repo = {"name": "", "kind": "upload", "url": "", "branch": "-", "auth": "-"}
    plan.files = [{"path": "stack.yml", "content": "- hosts: all\n"}, {"path": "nginx/conf.d/a.conf", "content": "server {}"}]
    out = _Out()
    src = asyncio.run(executor._fetch(plan, out, tmp_path, {}))
    assert src == tmp_path / "src"
    assert (src / "nginx/conf.d/a.conf").read_text() == "server {}"
    assert ("g", "✓ stack.yml 확인") in out.lines


def test_the_defining_comment_line_wins():
    book = ("#   5) Docker 설치와 init_user 를 docker 그룹에 추가\n"
            "#     init_user      처음 접속할 기존 계정 (예: ermore)\n"
            "#   비밀 변수\n"
            "#     init_password  init_user 의 비밀번호\n"
            "- hosts: all\n  tasks:\n    - ansible.builtin.debug:\n        msg: '{{ init_user }} {{ init_password }}'\n")
    v = _vars(playinspect.inspect([{"path": "a.yml", "content": book}], "a.yml"))
    assert v["init_user"]["desc"] == "처음 접속할 기존 계정 (예: ermore)"
    assert v["init_password"]["secret"] and v["init_password"]["desc"] == "init_user 의 비밀번호"


def test_a_windows_zip_drops_its_folder():
    import io
    import zipfile

    from app import bundles

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(r"infra\stack.yml", "- hosts: all\n")
        z.writestr(r"infra\nginx\a.conf", "x")
    res = bundles.parse_upload("infra.zip", buf.getvalue(), playbook=True)
    assert [f["path"] for f in res["files"]] == ["nginx/a.conf", "stack.yml"]


def test_vars_prompt_becomes_inputs():
    """Without a terminal Ansible skips vars_prompt and goes on with nothing, so each prompt is asked in the job."""
    book = "\n".join([
        "- hosts: \"{{ account_hosts | default('all') }}\"",
        "  become: true",
        "  vars_prompt:",
        "    - { name: account_name, prompt: 계정 이름, private: false }",
        "    - { name: account_password, prompt: 비밀번호 (8자 이상), confirm: true }",
        "    - { name: account_sudo, prompt: sudo 권한 (yes/no), private: false, default: 'no' }",
        "  roles: [account]",
    ])
    files = [{"path": "13-user.yaml", "content": book},
             {"path": "roles/account/defaults/main.yaml", "content": "account_name: \"\"\naccount_shell: /bin/bash\n"},
             {"path": "roles/account/tasks/main.yaml",
              "content": "- ansible.builtin.user: { name: \"{{ account_name }}\", shell: \"{{ account_shell }}\" }\n"}]
    out = {v["name"]: v for v in playinspect.inspect(files, "13-user.yaml")["vars"]}
    assert out["account_name"] == {"name": "account_name", "required": True, "secret": False, "default": None,
                                   "bool": False, "desc": "계정 이름", "role": None}
    assert out["account_password"]["required"] and out["account_password"]["secret"]  # private unless said otherwise
    assert out["account_sudo"]["default"] == "no" and out["account_sudo"]["bool"] and not out["account_sudo"]["required"]
    assert "account_shell" in out
    assert [n for n in out if n == "account_name"] == ["account_name"]  # the prompt, not also the role default
    notes = playinspect.inspect(files, "13-user.yaml")["notes"]
    assert any("고른 서버에서 실행돼요" in n for n in notes)


def test_role_values_of_an_imported_playbook_say_where_they_come_from():
    files = [
        {"path": "01-base.yaml", "content": "- hosts: all\n  roles:\n    - common\n"},
        {"path": "03-app.yaml", "content": "- import_playbook: 01-base.yaml\n- hosts: app\n  roles:\n    - web\n"},
        {"path": "roles/common/defaults/main.yaml", "content": "timezone: Asia/Seoul\n"},
        {"path": "roles/web/defaults/main.yaml", "content": "web_port: 8080\n"},
    ]
    got = {v["name"]: v for v in playinspect.inspect(files, "03-app.yaml")["vars"]}
    assert got["web_port"]["role"] == "web" and got["web_port"]["from"] is None
    assert got["timezone"]["role"] == "common" and got["timezone"]["from"] == "01-base.yaml"
    # the base playbook on its own: its roles are its own
    assert playinspect.inspect(files, "01-base.yaml")["vars"][0]["from"] is None


def test_vars_given_on_an_import_are_not_asked():
    files = [
        {"path": "01-base.yaml", "content": "- hosts: \"{{ base_hosts | default('all') }}\"\n  tasks: []\n"},
        {"path": "03-app.yaml", "content": "- import_playbook: 01-base.yaml\n  vars:\n    base_hosts: app\n"},
    ]
    assert "base_hosts" not in [v["name"] for v in playinspect.inspect(files, "03-app.yaml")["vars"]]
    assert "base_hosts" in [v["name"] for v in playinspect.inspect(files, "01-base.yaml")["vars"]]
