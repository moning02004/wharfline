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
    assert set(v) == {"db_url", "app_secret_token"}  # app_port has a role default
    assert v["app_secret_token"]["secret"]
    assert r["warnings"] == []
    assert any("hosts: web" in n for n in r["notes"])


def test_playbooks_are_lists_of_plays():
    files = [
        {"path": "stack.yml", "content": STACK},
        {"path": "deploy/app.yaml", "content": "- import_playbook: ../stack.yml\n"},
        {"path": "nginx/compose.yaml", "content": "services:\n  web:\n    image: nginx\n"},
        {"path": "roles/app/tasks/main.yml", "content": "- hosts: x\n"},
        {"path": "broken.yml", "content": "- hosts: [\n"},
    ]
    assert playinspect.playbooks(files) == ["stack.yml", "deploy/app.yaml"]


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
