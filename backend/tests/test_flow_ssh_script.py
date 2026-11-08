"""Deploy jobs that run an SSH script (ordered steps) on every target server instead of a playbook."""

from tests.conftest import builtin_job, log_text, wait_run

STEPS = [
    {"name": "이미지 받기", "run": "mkdir -p \"$SERVICE_PATH\"\ncd \"$SERVICE_PATH\"\ndocker compose pull"},
    {"name": "교체", "run": "docker compose up -d --remove-orphans"},
    {"name": "정리", "run": "docker image prune -f"},
]


MAIN_COMPOSE = "services:\n  api:\n    image: ghcr.io/acme/api-server:${IMAGE_TAG}\n"


def script_job(name: str, steps: list[dict], **extra) -> dict:
    """An SSH script job whose compose file makes ghcr.io/acme/api-server the main image (${IMAGE_TAG})."""
    return builtin_job(name, "staging", "", **extra) | {"playbook": {"source": "script"}, "script": steps,
                                                       "files": [{"path": "docker-compose.yaml", "content": MAIN_COMPOSE}]}


def test_create_script_job(client, login):
    r = client.post("/api/jobs", json=script_job("script · ok", STEPS))
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["playbook"]["kind"] == "script" and job["playbook"]["path"] == "SSH 스크립트 · 3단계"
    assert [s["name"] for s in job["script"]] == ["이미지 받기", "교체", "정리"]


def test_script_steps_are_checked(client, login):
    bad = [
        [],                                           # no steps
        [{"name": "", "run": "echo hi"}],             # no name
        [{"name": "x", "run": "   "}],                # no command
        [{"name": "x" * 61, "run": "echo hi"}],       # name too long
        [{"name": "x", "run": "a" * 4001}],           # command too long
        [{"name": f"s{i}", "run": "true"} for i in range(21)],  # too many steps
    ]
    for steps in bad:
        assert client.post("/api/jobs", json=script_job("script · bad", steps)).status_code == 400, steps


def test_script_run_succeeds_on_every_server(client, login):
    job = next(j for j in client.get("/api/jobs").json() if j["name"] == "script · ok")
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "v1.8.1", "groups": []}).json()["no"])
    assert run["status"] == "ok"
    log = log_text(run)
    assert "IMAGE=ghcr.io/acme/api-server IMAGE_TAG=v1.8.1 IMAGE_REF=ghcr.io/acme/api-server:v1.8.1" in log
    assert "SERVICE_PATH=/srv/script-ok" in log and "APP_NAME" not in log
    for st in STEPS:
        assert f"TASK [{st['name']}]" in log
    hosts = job["targetHosts"]
    for h in hosts:
        if not h["skip"]:
            assert f"{h['name']:<14}: ok=" in log and "failed=0" in log
    assert "배포 성공" in log
    assert run["steps"] == ["준비", "서버 연결", "파일 올리기", "레지스트리 로그인", "이미지 받기", "교체", "정리", "마무리"]


def test_failed_step_skips_the_rest_and_fails_the_run(client, login):
    steps = [{"name": "받기", "run": "docker compose pull"}, {"name": "확인", "run": "curl -fsS localhost/healthz\nexit 1"},
             {"name": "정리", "run": "docker image prune -f"}]
    job = client.post("/api/jobs", json=script_job("script · fail", steps)).json()
    before = job["tagNow"]
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "v1.8.1", "groups": []}).json()["no"])
    assert run["status"] == "bad"
    log = log_text(run)
    reachable = [h["name"] for h in job["targetHosts"] if not h["skip"]]
    for name in reachable:
        assert f"failed: [{name}] exit 1" in log
        assert f"skipping: [{name}] 앞 단계가 실패했어요" in log  # 정리 didn't run
        assert f"{name:<14}: ok=3  failed=1  skipped=1" in log  # SSH 연결, 파일 올리기, 받기 / 확인 / 정리
    assert "'확인' 단계에서 서버" in log
    after = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert after["last"]["status"] == "bad" and after["tagNow"] == before  # a failed run doesn't move the deployed tag


def test_switch_a_job_to_a_script_by_editing(client, login):
    job = client.post("/api/jobs", json=builtin_job("script · switch", "staging", "nginx:1.27")).json()
    body = {"name": job["name"], "playbook": {"source": "script"}, "script": [{"name": "재시작", "run": "docker restart web"}],
            "inventory": "staging", "targets": [], "image": "nginx:1.27", "envMode": "keep", "envVars": [],
            "hook": False, "protected": False, "lock": True, "rollback": True, "editors": job["editors"]}
    r = client.put(f"/api/jobs/{job['id']}", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["playbook"]["kind"] == "script" and r.json()["script"][0]["name"] == "재시작"
    acts = client.get("/api/activity").json()["items"]
    assert any(a["action"] == "배포 작업 수정" and "배포 방법" in a["object"] for a in acts)


def test_service_path(client, login):
    r = client.post("/api/jobs", json=script_job("script · path", STEPS, envMode="paste", envVars=[["A", "1"]]) | {"servicePath": "/opt/apps/web/"})
    assert r.status_code == 200, r.text
    job = r.json()
    assert job["servicePath"] == "/opt/apps/web"  # trailing slash dropped
    run = wait_run(client, client.post(f"/api/jobs/{job['id']}/runs", json={"tag": "v1.8.1", "groups": []}).json()["no"])
    log = log_text(run)
    assert "SERVICE_PATH=/opt/apps/web" in log and "ENV_FILE=/opt/apps/web/.env" in log
    assert "mkdir -p /opt/apps/web · .env mode=0600" in log
    for bad in ["relative/path", "/", "/srv/../etc", "/srv/a b", "/srv/$(id)"]:
        body = script_job("script · badpath", STEPS) | {"servicePath": bad}
        assert client.post("/api/jobs", json=body).status_code == 400, bad
