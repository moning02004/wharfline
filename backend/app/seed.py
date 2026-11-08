"""Sample data loaded into an empty database on first start."""

from __future__ import annotations

import os
import secrets
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import authn
from . import models as m
from . import sshkeys
from .sample_script_job import add_sample_script_job
from .store import BUILTIN_BOOK, BUILTIN_REPO, BUILTIN_URL, CLIENT_IP

keys: list[dict] = [
    {"id": "k1", "kind": "ssh", "name": "prod-deploy", "type": "ED25519", "fingerprint": "SHA256:9fK2mQx7Lr0aZp4c1VtY8sNw3bHdE6uJ", "createdBy": "정훈", "createdAt": "2026-09-14", "lastUsed": "12분 전", "usedCount": 3},
    {"id": "k2", "kind": "ssh", "name": "staging-deploy", "type": "ED25519", "fingerprint": "SHA256:Tq81ZcVb5nPw2LxR0mKe7YdF4hUs9gAo", "createdBy": "정훈", "createdAt": "2026-09-14", "lastUsed": "2시간 전", "usedCount": 2},
    {"id": "k3", "kind": "ssh", "name": "legacy-rsa", "type": "RSA 4096", "fingerprint": "SHA256:Hx3Pq0Wn6Rk2Bz9Lc5Ty1Vm8Ja4Sd7Fe", "createdBy": "민지", "createdAt": "2025-12-02", "lastUsed": "41일 전", "usedCount": 0},
    {"id": "k4", "kind": "token", "name": "github-readonly", "type": "토큰", "fingerprint": "acme-deploy-bot · ••••7c1e", "createdBy": "정훈", "createdAt": "2026-10-02", "lastUsed": "12분 전", "usedCount": 1},
]


def _host(name, ip, port, group, host_key="ok", status="on", user="deploy"):
    return {"name": name, "ip": ip, "port": port, "user": user, "group": group, "hostKey": host_key, "status": status}


inventories: list[dict] = [
    {"id": "i1", "name": "production", "key": "prod-deploy", "hosts": [
        _host("web-01", "10.0.1.15", 22, "web"),
        _host("web-02", "10.0.1.16", 22, "web"),
        _host("worker-01", "10.0.1.17", 22, "worker"),
        _host("batch-01", "10.0.2.21", 2222, "batch", host_key="changed"),
        _host("db-01", "10.0.3.31", 22, "db", status="off"),
    ]},
    {"id": "i2", "name": "staging", "key": "staging-deploy", "hosts": [
        _host("stg-web-01", "192.168.10.21", 22, "web"),
        _host("stg-worker-01", "192.168.10.22", 22, "worker"),
    ]},
]

repos: list[dict] = [
    {"name": BUILTIN_REPO, "kind": "builtin", "url": BUILTIN_URL, "branch": "-", "auth": "-", "commit": "-"},
    {"name": "infra/ansible-deploy", "kind": "git", "url": "https://github.com/infra/ansible-deploy.git", "branch": "main", "auth": "토큰 · github-readonly", "commit": "c3e18a0"},
    {"name": "local-playbooks", "kind": "local", "url": "/var/lib/wharfline/playbooks/local", "branch": "-", "auth": "-", "commit": "-"},
    {"name": "ops/ansible-playbooks", "kind": "git", "url": "git@git.acme.kr:ops/ansible-playbooks.git", "branch": "main", "auth": "SSH 키 · staging-deploy", "commit": "8f20b6d"},
]

registries: list[dict] = [
    {"id": "r1", "name": "GitHub Container Registry", "host": "ghcr.io", "namespace": "acme", "auth": "토큰 · read:packages", "user": "acme-deploy-bot"},
    {"id": "r2", "name": "Gitea", "host": "git.acme.kr", "namespace": "acme", "auth": "토큰 · read:package", "user": "deploy"},
]


def _tag(name, digest, pushed):
    return {"name": name, "digest": digest, "pushed": pushed}


images: list[dict] = [
    {"ref": "ghcr.io/acme/api-server", "registry": "r1", "tags": [_tag("v1.8.2", "4f1ca92e", "2시간 전"), _tag("sha-77d1e0b", "0c7e9b12", "2시간 전"), _tag("v1.8.1", "9b03d7c1", "3일 전"), _tag("v1.8.0", "e61a0f55", "8일 전")]},
    {"ref": "ghcr.io/acme/web-front", "registry": "r1", "tags": [_tag("v2.3.0", "a2b4c6d8", "어제"), _tag("v2.2.4", "1f3e5d7c", "6일 전"), _tag("v2.2.3", "6d0e2f19", "12일 전")]},
    {"ref": "git.acme.kr/acme/batch-worker", "registry": "r2", "sourceRepo": "acme/batch-worker", "tags": [_tag("v0.9.4", "77aa01bc", "어제"), _tag("v0.9.3", "5c5c9e20", "5일 전")]},
]

envs: list[dict] = [
    {"id": "e1", "name": "api-server.production", "ver": 7, "updated": "3일 전 · 정훈", "vars": [
        ["NODE_ENV", "production"],
        ["DATABASE_URL", "postgres://api:Xq9!vR2m@10.0.3.31:5432/acme"],
        ["REDIS_URL", "redis://10.0.2.21:6379/0"],
        ["JWT_SECRET", "b6f1c0e9a4d27f58e3c1a9b0d4e7f2a6"],
        ["SENTRY_DSN", "https://f3a1@o4401.ingest.sentry.io/550"],
    ], "history": []},
    {"id": "e2", "name": "web-front.production", "ver": 4, "updated": "9일 전 · 민지", "vars": [
        ["NEXT_PUBLIC_API_URL", "https://api.acme.kr"],
        ["NEXTAUTH_SECRET", "7d2e9a0c41f8b36e5a1d0c9f2b7e4a38"],
    ], "history": []},
    {"id": "e3", "name": "api-server.staging", "ver": 12, "updated": "어제 · 정훈", "vars": [
        ["NODE_ENV", "staging"],
        ["DATABASE_URL", "postgres://api:stg-pw-81@192.168.10.30:5432/acme_stg"],
        ["JWT_SECRET", "stg-1f2e3d4c5b6a"],
    ], "history": []},
]

# Sample version history
envs[0]["history"] = [
    {"ver": 6, "updated": "9일 전 · 민지", "vars": [[k, "a0c3f7e1b2d94c68e5f0a1b7c3d9e2f4" if k == "JWT_SECRET" else v] for k, v in envs[0]["vars"] if k != "SENTRY_DSN"]},
    {"ver": 5, "updated": "21일 전 · 정훈", "vars": [["NODE_ENV", "production"], ["DATABASE_URL", "postgres://api:old-pw-3@10.0.3.31:5432/acme"], ["JWT_SECRET", "a0c3f7e1b2d94c68e5f0a1b7c3d9e2f4"]]},
]
envs[1]["history"] = [
    {"ver": 3, "updated": "15일 전 · 민지", "vars": [["NEXT_PUBLIC_API_URL", "https://api-old.acme.kr"], ["NEXTAUTH_SECRET", "7d2e9a0c41f8b36e5a1d0c9f2b7e4a38"]]},
]
envs[2]["history"] = [
    {"ver": 11, "updated": "3일 전 · 민지", "vars": [[k, "postgres://api:stg-pw-80@192.168.10.30:5432/acme_stg" if k == "DATABASE_URL" else v] for k, v in envs[2]["vars"]]},
]

jobs: list[dict] = [
    {"id": "j1", "name": "api-server · production", "image": "ghcr.io/acme/api-server", "tagNow": "v1.8.2", "defaultTag": "latest", "repo": "infra/ansible-deploy", "book": "deploy-app.yml", "inventory": "production", "targets": ["web"], "env": "api-server.production", "hook": False, "protected": True, "lock": True, "rollback": True, "last": {"status": "ok", "time": "12분 전", "duration": "1m 42s"}},
    {"id": "j4", "name": "batch-worker · production", "image": "git.acme.kr/acme/batch-worker", "tagNow": "v0.9.4", "defaultTag": "latest", "repo": "ops/ansible-playbooks", "book": "deploy-worker.yml", "inventory": "production", "targets": ["worker"], "env": "api-server.production", "hook": False, "protected": True, "lock": True, "rollback": True, "editors": {"groups": ["g-batch"], "members": []}, "last": {"status": "ok", "time": "어제", "duration": "0m 52s"}},
    {"id": "j2", "name": "web-front · production", "image": "ghcr.io/acme/web-front", "tagNow": "v2.3.0", "defaultTag": "latest", "repo": BUILTIN_REPO, "book": BUILTIN_BOOK, "inventory": "production", "targets": ["web"], "env": "web-front.production", "hook": False, "protected": True, "lock": True, "rollback": True, "last": {"status": "ok", "time": "어제", "duration": "2m 05s"}},
    {"id": "j3", "name": "api-server · staging", "image": "ghcr.io/acme/api-server", "tagNow": "v1.8.1", "defaultTag": "latest", "repo": BUILTIN_REPO, "book": BUILTIN_BOOK, "inventory": "staging", "targets": [], "env": "api-server.staging", "hook": True, "protected": False, "lock": True, "rollback": False, "createdBy": "minji@acme.kr", "last": {"status": "bad", "time": "2시간 전", "duration": "0m 38s"}},
]

runs: list[dict] = [
    {"no": 184, "job": "api-server · production", "jobId": "j1", "target": "web", "tag": "v1.8.2", "status": "ok", "by": "정훈", "trigger": "수동 실행", "time": "12분 전", "duration": "1m 42s"},
    {"no": 183, "job": "api-server · staging", "jobId": "j3", "target": "전체", "tag": "sha-77d1e0b", "status": "bad", "by": "ghcr.io", "trigger": "새 이미지 push", "time": "2시간 전", "duration": "0m 38s"},
    {"no": 182, "job": "api-server · staging", "jobId": "j3", "target": "전체", "tag": "v1.8.1", "status": "ok", "by": "민지", "trigger": "수동 실행", "time": "3시간 전", "duration": "1m 11s"},
    {"no": 181, "job": "web-front · production", "jobId": "j2", "target": "web", "tag": "v2.3.0", "status": "ok", "by": "정훈", "trigger": "수동 실행", "time": "어제", "duration": "2m 05s"},
    {"no": 180, "job": "web-front · production", "jobId": "j2", "target": "web", "tag": "v2.2.4", "status": "cancel", "by": "민지", "trigger": "수동 실행", "time": "어제", "duration": "0m 14s"},
    {"no": 179, "job": "batch-worker · production", "jobId": "j4", "target": "worker", "tag": "v0.9.4", "status": "ok", "by": "정훈", "trigger": "수동 실행", "time": "어제", "duration": "0m 52s"},
]

activity: list[dict] = [
    {"time": "14:02:11", "user": "정훈", "action": "배포 실행", "object": "api-server · production #184", "ip": CLIENT_IP, "result": "ok"},
    {"time": "13:58:40", "user": "정훈", "action": "민감 정보 열람", "object": ".env api-server.production", "ip": CLIENT_IP, "result": "ok"},
    {"time": "13:58:31", "user": "정훈", "action": "비밀번호 재확인", "object": "5분 열람 권한", "ip": CLIENT_IP, "result": "ok"},
    {"time": "13:55:02", "user": "정훈", "action": "로그인", "object": "비밀번호 + TOTP", "ip": CLIENT_IP, "result": "ok"},
    {"time": "12:10:47", "user": "시스템", "action": "호스트 키 불일치 감지", "object": "batch-01 (10.0.2.21)", "ip": "-", "result": "warn"},
    {"time": "11:41:19", "user": "민지", "action": "인벤토리 수정", "object": "staging · 호스트 1개 추가", "ip": "121.165.44.2", "result": "ok"},
    {"time": "11:02:05", "user": "민지", "action": "배포 실행", "object": "api-server · staging #182", "ip": "121.165.44.2", "result": "ok"},
    {"time": "09:31:56", "user": "알 수 없음", "action": "로그인 실패", "object": "admin@acme.kr · 비밀번호 오류", "ip": "45.148.10.77", "result": "bad"},
]

logins: list[dict] = [
    {"time": "오늘 13:55", "user": "정훈", "method": "비밀번호 + TOTP", "ip": CLIENT_IP, "location": "서울, KR", "agent": "Chrome 141 · macOS", "result": "ok"},
    {"time": "오늘 10:58", "user": "민지", "method": "비밀번호 + TOTP", "ip": "121.165.44.2", "location": "성남, KR", "agent": "Firefox 144 · Windows", "result": "ok"},
    {"time": "오늘 09:31", "user": "admin@acme.kr", "method": "비밀번호", "ip": "45.148.10.77", "location": "암스테르담, NL", "agent": "python-requests", "result": "bad"},
    {"time": "오늘 09:31", "user": "admin@acme.kr", "method": "비밀번호", "ip": "45.148.10.77", "location": "암스테르담, NL", "agent": "python-requests", "result": "bad"},
    {"time": "어제 18:20", "user": "정훈", "method": "복구 코드", "ip": CLIENT_IP, "location": "서울, KR", "agent": "Safari 19 · iOS", "result": "warn"},
]

members: list[dict] = [
    {"name": "정훈", "email": "jeonghoon@acme.kr", "role": "Owner", "tfa": False, "last": "방금"},
    {"name": "민지", "email": "minji@acme.kr", "role": "Deployer", "tfa": False, "last": "3시간 전"},
    {"name": "서준", "email": "seojun@acme.kr", "role": "Viewer", "tfa": False, "last": "6일 전"},
]

# Groups decide which menus and builds their members see. Owners always see everything; the dashboard is always visible.
_COMMON = ["jobs", "runs", "security", "notes"]
groups: list[dict] = [
    {"id": "g-admin", "name": "Admin 기본", "menus": _COMMON + ["registries", "repos", "inventory", "keys", "envs", "activity"],
     "all_builds": True, "repos": [], "members": []},
    {"id": "g-deployer", "name": "Deployer 기본", "menus": _COMMON + ["registries", "repos", "inventory"],
     "all_builds": True, "repos": [], "members": ["minji@acme.kr"]},
    {"id": "g-viewer", "name": "Viewer 기본", "menus": list(_COMMON), "all_builds": True, "repos": [], "members": []},
    # Sees only the batch worker's builds.
    {"id": "g-batch", "name": "배치팀", "menus": _COMMON + ["registries"], "all_builds": False, "repos": ["acme/batch-worker"],
     "members": ["seojun@acme.kr"]},
]

policy: dict[str, Any] = {
    "enforce2fa": False,  # 2FA is optional; members turn it on under 보안
    "sudoMinutes": 5,
    "session": "8시간 (활동 없으면 30분)",
    "lockout": "5회 실패 시 15분 잠금",
    "allowIps": "211.234.10.0/24\n121.165.44.2",
}



def seed_if_empty(db: Session) -> bool:
    if db.scalar(select(m.Setting).where(m.Setting.key == "policy")):
        return False

    db.add(m.Setting(key="policy", value=policy))
    for k in keys:
        key = m.Key(id=k["id"], kind=k["kind"], name=k["name"], type=k["type"], fingerprint=k["fingerprint"],
                    created_by=k["createdBy"], created_at=k["createdAt"], last_used=k["lastUsed"], used_count=k["usedCount"])
        if k["kind"] == "ssh":
            # Real key pairs, so fingerprints and public keys are genuine.
            pk = (rsa.generate_private_key(public_exponent=65537, key_size=4096) if k["type"].startswith("RSA")
                  else ed25519.Ed25519PrivateKey.generate())
            ssh = sshkeys.load_private(pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH,
                                                        serialization.NoEncryption()).decode(), None, f"{k['name']}@wharfline")
            key.type, key.fingerprint, key.public_key = ssh.type, ssh.fingerprint, ssh.public_line
            key.set_secret(ssh.private_openssh)
        else:
            key.set_secret("github_pat_example_" + secrets.token_hex(16) + "7c1e")
        db.add(key)
    for inv in inventories:
        db.add(m.Inventory(id=inv["id"], name=inv["name"], key=inv["key"], hosts=[
            m.Host(name=h["name"], ip=h["ip"], port=h["port"], ssh_user=h["user"], grp=h["group"], host_key=h["hostKey"], status=h["status"])
            for h in inv["hosts"]]))
    existing = set(db.scalars(select(m.Repo.name)))  # the migration already adds the built-in repo
    db.add_all(m.Repo(**r) for r in repos if r["name"] not in existing)
    for r in registries:
        reg = m.Registry(id=r["id"], name=r["name"], host=r["host"], namespace=r["namespace"], auth=r["auth"], user=r["user"])
        reg.set_secret("example_pull_token_" + secrets.token_hex(16))
        db.add(reg)
    db.flush()
    for img in images:
        db.add(m.Image(ref=img["ref"], registry_id=img["registry"], source_repo=img.get("sourceRepo"), tags=[m.ImageTag(**t, pushed_at=1e9 - i) for i, t in enumerate(img["tags"])]))  # listed newest first
    for e in envs:
        env = m.EnvSet(id=e["id"], name=e["name"], ver=e["ver"], updated=e["updated"])
        env.set_vars(e["vars"])
        for h in e["history"]:
            v = m.EnvVersion(env_id=e["id"], ver=h["ver"], updated=h["updated"])
            v.set_vars(h["vars"])
            env.versions.append(v)
        db.add(env)
    for j in jobs:
        db.add(m.Job(id=j["id"], name=j["name"], image=j["image"], tag_now=j["tagNow"], default_tag=j["defaultTag"],
                     repo=j["repo"], book=j["book"], inventory=j["inventory"],
                     targets=j["targets"], env=j["env"], hook=j["hook"], protected=j["protected"], lock=j["lock"], rollback=j["rollback"],
                     last_status=j["last"]["status"], last_time=j["last"]["time"], last_duration=j["last"]["duration"],
                     created_by=j.get("createdBy", "jeonghoon@acme.kr"),
                     editors=j.get("editors", {"groups": [], "members": []})))
    db.add_all(m.Run(no=r["no"], job=r["job"], job_id=r["jobId"], target=r["target"], tag=r["tag"], status=r["status"], by=r["by"],
                     trigger=r["trigger"], time=r["time"], duration=r["duration"]) for r in runs)
    # Lists below are newest first; insert oldest first so a higher id means newer.
    db.add_all(m.Activity(**a) for a in reversed(activity))
    db.add_all(m.Login(**x) for x in reversed(logins))
    # Every sample member signs in with WHARFLINE_SEED_PASSWORD (default "wharfline"). Nobody has 2FA yet.
    seed_hash = authn.hash_password(authn.seed_password())
    by_email = {x["email"]: m.Member(**x, password_hash=seed_hash) for x in members}
    db.add_all(by_email.values())
    for g in groups:
        db.add(m.Group(id=g["id"], name=g["name"], menus=g["menus"], all_builds=g["all_builds"], repos=g["repos"],
                       members=[by_email[e] for e in g["members"]]))
    db.flush()
    add_sample_script_job(db, "jeonghoon@acme.kr")  # an SSH script job with a compose file
    db.commit()
    return True


def bootstrap_owner(db: Session) -> bool:
    """Production start: no sample data, just the policy and one Owner from the environment.

    WHARFLINE_OWNER_EMAIL, WHARFLINE_OWNER_PASSWORD (10+ characters) and optionally
    WHARFLINE_OWNER_NAME. The Owner must change the password at the first login.
    """
    if db.scalar(select(m.Setting).where(m.Setting.key == "policy")):
        return False
    email = os.getenv("WHARFLINE_OWNER_EMAIL", "").strip().lower()
    password = os.getenv("WHARFLINE_OWNER_PASSWORD", "")
    if "@" not in email:
        raise RuntimeError("WHARFLINE_OWNER_EMAIL is required when WHARFLINE_SAMPLE_DATA=0")
    if len(password) < 10:
        raise RuntimeError("WHARFLINE_OWNER_PASSWORD must be at least 10 characters")
    db.add(m.Setting(key="policy", value={**policy, "allowIps": ""}))
    db.add(m.Member(email=email, name=os.getenv("WHARFLINE_OWNER_NAME", "관리자").strip() or "관리자", role="Owner", tfa=False,
                    last="-", password_hash=authn.hash_password(password), must_change_password=True))
    db.commit()
    return True
