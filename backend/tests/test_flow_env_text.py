"""A .env set keeps the text as it was pasted: comments, blank lines and order come back from /values and go to the server."""

from app import executor, store

from .conftest import OWNER

TEXT = """# 운영 DB
DATABASE_URL=postgres://api:pw@10.0.3.31:5432/app

# 캐시 (지우지 마세요)
REDIS_URL=redis://10.0.3.40:6379
export MODE="prod"
"""


def test_parse_env_text_matches_the_web_app():
    assert store.parse_env_text(TEXT) == [
        ["DATABASE_URL", "postgres://api:pw@10.0.3.31:5432/app"], ["REDIS_URL", "redis://10.0.3.40:6379"], ["MODE", "prod"],
    ]


def test_env_file_keeps_comments_and_quotes_values_by_its_own_rules():
    vars_ = store.parse_env_text(TEXT)
    assert executor.env_file_text(vars_, layout=TEXT) == (
        "# 운영 DB\nDATABASE_URL=postgres://api:pw@10.0.3.31:5432/app\n\n# 캐시 (지우지 마세요)\n"
        "REDIS_URL=redis://10.0.3.40:6379\nMODE=prod\n"
    )
    # A variable the text doesn't have still goes in, at the end; one the text has but vars don't is left out.
    assert executor.env_file_text([["MODE", "a b"], ["NEW", "1"]], layout=TEXT) == (
        "# 운영 DB\n\n# 캐시 (지우지 마세요)\nMODE='a b'\nNEW=1\n"
    )
    # docker --env-file: a comment only counts at the start of a line.
    assert executor.env_file_text([["A", "1"]], "docker", layout="   # note\nA=1\n") == "# note\nA=1\n"


def test_env_text_round_trip_and_comment_only_edit(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/envs", json={"name": "text-keeps-comments", "text": TEXT})
    assert r.status_code == 200, r.text
    env = r.json()
    assert [v["key"] for v in env["vars"]] == ["DATABASE_URL", "REDIS_URL", "MODE"]

    got = client.get(f"/api/envs/{env['id']}/values").json()
    assert got["text"] == TEXT and got["vars"][2] == ["MODE", "prod"]

    # Only a comment changes: still a new version, and the text comes back as written.
    edited = TEXT.replace("# 캐시 (지우지 마세요)", "# 캐시")
    r = client.put(f"/api/envs/{env['id']}", json={"text": edited})
    assert r.status_code == 200, r.text
    assert r.json()["ver"] == 2
    assert client.get(f"/api/envs/{env['id']}/values").json()["text"] == edited
    assert client.put(f"/api/envs/{env['id']}", json={"text": edited}).status_code == 400  # nothing changed

    # Restoring v1 brings its comments back too.
    assert client.post(f"/api/envs/{env['id']}/restore", json={"ver": 1}).status_code == 200
    assert client.get(f"/api/envs/{env['id']}/values").json()["text"] == TEXT


def test_sets_saved_as_a_list_still_read_as_text(client, login):
    login(OWNER, sudo=True)
    r = client.post("/api/envs", json={"name": "text-old-style", "vars": [["A", "1"], ["B", "two"]]})
    assert r.status_code == 200, r.text
    got = client.get(f"/api/envs/{r.json()['id']}/values").json()
    assert got == {"vars": [["A", "1"], ["B", "two"]], "text": "A=1\nB=two\n"}


def test_an_older_version_can_be_read_to_compare(client, login):
    login(OWNER, sudo=True)
    env = client.post("/api/envs", json={"name": "text-versions", "text": "# v1\nA=1\n"}).json()
    client.put(f"/api/envs/{env['id']}", json={"text": "# v2\nA=2\n"})
    assert client.get(f"/api/envs/{env['id']}/values?ver=1&purpose=edit").json()["text"] == "# v1\nA=1\n"
    assert client.get(f"/api/envs/{env['id']}/values?ver=2&purpose=edit").json()["text"] == "# v2\nA=2\n"
    assert client.get(f"/api/envs/{env['id']}/values?ver=9").status_code == 404
    acts = [a["object"] for a in client.get("/api/activity").json()["items"] if a["action"] == "민감 정보 열람"]
    assert ".env text-versions v1" in acts  # an older version's values are logged even while editing
