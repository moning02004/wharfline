"""Renaming and deleting members: renaming is for Owner or Admin (themselves included), deleting for the Owner."""

import uuid

from tests.conftest import DEPLOYER, OWNER, VIEWER

ADMIN = "admin-name@acme.kr"


def _admin():
    from app import models as m
    from app.db import SessionLocal

    with SessionLocal() as db:
        if not db.get(m.Member, ADMIN):
            db.add(m.Member(email=ADMIN, name="관리자", role="Admin", tfa=False, last="방금"))
            db.commit()


def _name(client, email):
    return next(x["name"] for x in client.get("/api/members").json() if x["email"] == email)


def test_owner_and_admin_rename(client, login):
    _admin()
    new = f"브랜드마케팅2팀  이미지 대리 {uuid.uuid4().hex[:4]}"
    r = client.put(f"/api/members/{DEPLOYER}/name", json={"name": f"  {new} "})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == " ".join(new.split())  # trimmed, one space between words

    login(ADMIN)
    assert client.put(f"/api/members/{VIEWER}/name", json={"name": "서준"}).status_code == 200
    assert client.put(f"/api/members/{ADMIN}/name", json={"name": "관리자 2"}).status_code == 200  # their own
    assert _name(client, ADMIN) == "관리자 2"

    login(OWNER)
    assert client.put(f"/api/members/{DEPLOYER}/name", json={"name": "민지"}).status_code == 200


def test_others_cannot_rename(client, login):
    for who in (DEPLOYER, VIEWER):
        login(who)
        assert client.put(f"/api/members/{who}/name", json={"name": "새 이름"}).status_code == 403
        assert client.put(f"/api/members/{OWNER}/name", json={"name": "새 이름"}).status_code == 403


def test_bad_names(client, login):
    assert client.put(f"/api/members/{DEPLOYER}/name", json={"name": "   "}).status_code == 400
    assert client.put(f"/api/members/{DEPLOYER}/name", json={"name": "가" * 65}).status_code == 400
    assert client.put("/api/members/nobody@acme.kr/name", json={"name": "x"}).status_code == 404


def test_owner_deletes_a_member(client, login):
    from tests.conftest import builtin_job

    login(OWNER, sudo=True)
    gone = f"del-{uuid.uuid4().hex[:6]}@acme.kr"
    assert client.post("/api/members/import", json={"text": f"삭제팀, {gone}, 홍길동", "apply": True}).status_code == 200
    job = client.post("/api/jobs", json=builtin_job(f"del · {gone}", "staging", "nginx:1.27",
                                                    editors={"groups": [], "members": [gone, DEPLOYER]})).json()

    login(DEPLOYER, sudo=True)
    assert client.delete(f"/api/members/{gone}").status_code == 403  # Owner only
    login(OWNER)
    assert client.delete(f"/api/members/{gone}").json()["detail"] == "sudo_required"
    login(OWNER, sudo=True)
    assert client.delete(f"/api/members/{OWNER}").status_code == 400  # never yourself
    assert client.delete(f"/api/members/{gone}").status_code == 200
    assert all(x["email"] != gone for x in client.get("/api/members").json())
    assert all(gone not in g["members"] for g in client.get("/api/groups").json()["groups"])
    edited = next(j for j in client.get("/api/jobs").json() if j["id"] == job["id"])
    assert edited["editors"]["members"] == [DEPLOYER]
    assert client.delete(f"/api/members/{gone}").status_code == 404
