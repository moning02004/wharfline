"""Drafting a deploy job from a Git repo: rules over the repo's files, no AI."""

from app import executor, repodetect
from tests.conftest import OWNER, VIEWER

URL = "https://github.com/Acme/Shop.git"


def f(path: str, content: str) -> dict:
    return {"path": path, "content": content}


COMPOSE = """name: shop
services:
  web:
    image: ghcr.io/acme/shop:1.4.0
    env_file: [.env]
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
      - ./data:/data
      - ../secrets:/s
      - pgdata:/var/lib/x
  db:
    image: postgres:16-alpine
    volumes: [pgdata:/var/lib/postgresql/data]
configs:
  app:
    file: ./config/app.toml
volumes:
  pgdata: {}
"""


def repo() -> list[dict]:
    return [
        f("README.md", "# shop"),
        f("src/main.py", "print(1)"),
        f("examples/docker-compose.yml", "services: {x: {image: x}}"),
        f("deploy/compose.yaml", COMPOSE),
        f("deploy/nginx/default.conf", "server {}"),
        f("deploy/config/app.toml", "a = 1"),
        f("deploy/.env", "DB_PASSWORD=real\n"),
        f("deploy/.env.example", "DB_PASSWORD=change-me\nAPI_URL=https://example.com\n"),
        f("docker-compose.override.yml", "services: {}"),
    ]


def test_the_deploy_folders_compose_file_and_what_it_reads():
    d = repodetect.detect(repo(), URL)
    assert repodetect.detect([f("apps/cart/compose.yml", "services: {a: {image: x}}")], URL)["name"] == "cart"
    assert d["kind"] == "compose"  # the root only has an override file, which is not a compose name
    assert d["composeFiles"] == ["deploy/compose.yaml"]
    assert d["composePath"] == "deploy/compose.yaml" and d["name"] == "shop"
    assert [x["path"] for x in d["files"]] == ["compose.yaml", "config/app.toml", "nginx/default.conf"]
    assert d["env"] == [["DB_PASSWORD", "real"], ["API_URL", "https://example.com"]]  # .env first, then the example's new names
    assert d["guide"] == "rollout" and d["rollout"] == ["web"]
    assert d["own"] == ["ghcr.io/acme/shop"]
    notes = " ".join(d["notes"])
    assert "../secrets" in notes and "./data" in notes and ".env.example" in notes


def test_a_root_compose_file_wins_and_another_can_be_picked():
    files = repo() + [f("compose.yml", "services:\n  app:\n    image: nginx:1\n    ports: ['80:80']\n")]
    d = repodetect.detect(files, URL)
    assert d["composeFiles"][0] == "compose.yml" and d["composePath"] == "compose.yml"
    assert [x["path"] for x in d["files"]] == ["compose.yml", "docker-compose.override.yml"]
    assert d["guide"] == "compose" and d["name"] == "Shop"  # the repo's name, as written
    assert repodetect.detect(files, URL, "deploy/compose.yaml")["composePath"] == "deploy/compose.yaml"
    assert repodetect.detect(files, URL, "../etc/x")["composePath"] == "compose.yml"


def test_build_services_are_pointed_out():
    d = repodetect.detect([f("compose.yaml", "services:\n  api:\n    build: .\n")], URL)
    assert any("build:" in n for n in d["notes"])


def test_kubernetes_manifests_get_kubectl_steps():
    dep = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: shop\n  namespace: prod\nspec:\n  template:\n    spec:\n      containers:\n        - image: ghcr.io/acme/shop:${APP_TAG}\n"
    svc = "apiVersion: v1\nkind: Service\nmetadata:\n  name: shop\n"
    d = repodetect.detect([f("k8s/deploy.yaml", dep), f("k8s/svc.yaml", svc), f("README.md", "x")], URL)
    assert d["kind"] == "kubernetes" and [x["path"] for x in d["files"]] == ["k8s/deploy.yaml", "k8s/svc.yaml"]
    assert d["steps"][0]["run"] == 'cd "$SERVICE_PATH"\nenvsubst < k8s/deploy.yaml | kubectl apply -f -\nenvsubst < k8s/svc.yaml | kubectl apply -f -'
    assert d["steps"][1]["run"] == "kubectl rollout status deployment/shop -n prod --timeout=180s"
    assert d["own"] == ["ghcr.io/acme/shop"]


def test_playbooks_or_a_dockerfile_alone_give_a_note_not_a_draft():
    book = "- hosts: all\n  tasks:\n    - ping:\n"
    d = repodetect.detect([f("site.yml", book)], URL)
    assert d["kind"] == "playbook" and d["files"] == [] and d["playbooks"] == ["site.yml"]
    d = repodetect.detect([f("Dockerfile", "FROM x")], URL)
    assert d["kind"] == "dockerfile" and d["dockerfiles"] == ["Dockerfile"]
    assert repodetect.detect([f("README.md", "x")], URL)["kind"] == "none"


def test_own_images_follow_the_repo_path():
    refs = ["ghcr.io/acme/shop", "ghcr.io/acme/shop/worker", "ghcr.io/acme/shopping", "postgres", "registry.gitlab.com/acme/shop"]
    assert repodetect.own_images(refs, URL) == ["ghcr.io/acme/shop", "ghcr.io/acme/shop/worker", "registry.gitlab.com/acme/shop"]
    assert repodetect.repo_path("git@git.acme.kr:Ops/Sub/App.git") == "ops/sub/app"
    assert repodetect.repo_path("ssh://git@git.acme.kr:2222/ops/app.git") == "ops/app"


def test_the_endpoint_reads_the_repo_with_the_forms_access(client, login, monkeypatch):
    seen = {}

    async def fake(repo, ref):
        seen.update(repo=repo, ref=ref)
        return repo_files, "abc1234"

    repo_files = repo()
    monkeypatch.setattr(executor, "read_repo_files", fake)
    login(OWNER)
    r = client.post("/api/repos/detect", json={"url": URL, "branch": "dev"})
    assert r.status_code == 200, r.text
    assert r.json()["commit"] == "abc1234" and r.json()["composePath"] == "deploy/compose.yaml" and seen["ref"] == "dev"
    assert client.post("/api/repos/detect", json={"url": "file:///etc"}).status_code == 400
    login(VIEWER)
    assert client.post("/api/repos/detect", json={"url": URL}).status_code == 403


DEV_OVERRIDE = "services:\n  web:\n    volumes: ['./src:/app']\n"


def test_a_production_file_wins_and_is_saved_under_a_name_compose_reads():
    files = [
        f("compose.yaml", "services:\n  web:\n    build: .\n    ports: ['3000:3000']\n"),
        f("compose.override.yaml", DEV_OVERRIDE),
        f("deploy/docker-compose.prod.yml", "services:\n  web:\n    image: ghcr.io/acme/shop:2.0\n"),
    ]
    d = repodetect.detect(files, URL)
    assert d["composeFiles"] == ["deploy/docker-compose.prod.yml", "compose.yaml"]
    assert d["composePath"] == "deploy/docker-compose.prod.yml"
    assert [x["path"] for x in d["files"]] == ["docker-compose.yml"]  # standalone: no base, no dev override
    assert d["guide"] == "rollout" and d["own"] == ["ghcr.io/acme/shop"]
    assert any("docker-compose.yml" in n for n in d["notes"])
    # The plain one can still be picked, with its override as before.
    plain = repodetect.detect(files, URL, "compose.yaml")
    assert [x["path"] for x in plain["files"]] == ["compose.override.yaml", "compose.yaml"]


def test_a_production_overlay_goes_on_top_of_the_plain_file():
    files = [
        f("compose.yml", "services:\n  web:\n    image: ghcr.io/acme/shop:${SHOP_TAG}\n    container_name: web\n  db:\n    image: postgres:16\n"),
        f("compose.override.yml", DEV_OVERRIDE),
        f("compose.prod.yml", "services:\n  web:\n    restart: always\n    env_file: [prod.env]\n"),
        f("prod.env", "LOG=info\n"),
    ]
    d = repodetect.detect(files, URL)
    assert d["composePath"] == "compose.prod.yml"
    assert [x["path"] for x in d["files"]] == ["compose.override.yml", "compose.yml", "prod.env"]
    saved = {x["path"]: x["content"] for x in d["files"]}
    assert "restart: always" in saved["compose.override.yml"]  # the production file, under the override name
    assert any("개발용" in n for n in d["notes"]) and any("덧씌우는" in n for n in d["notes"])
    assert d["rollout"] == []  # container_name from the plain file still counts


def test_prod_names():
    yes = ["compose.prod.yaml", "docker-compose.prod.yml", "compose.production.yml", "docker-compose-live.yaml", "deploy/compose.prd.yml"]
    no = ["compose.dev.yaml", "docker-compose.test.yml", "compose.yaml", "prod.yml", "compose.staging.yml"]
    assert all(repodetect.is_prod_name(p) for p in yes) and not any(repodetect.is_prod_name(p) for p in no)
