"""Database tables.

`to_dict()` returns the same camelCase shape the API has always returned,
so the frontend does not need to know about the storage layer.
JSONB columns must be reassigned (not mutated in place) to be saved.
"""

from __future__ import annotations

import time
from typing import Any

from sqlalchemy import BigInteger, Boolean, CheckConstraint, Column, Float, ForeignKey, Identity, Integer, LargeBinary, Sequence, String, Table, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from . import crypto
from .db import Base


class Setting(Base):
    """Key/value settings: workspace policy and the demo user's session state."""

    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)


ENVELOPE_COMPLETE = (
    "(kek_id IS NULL AND wrapped_dek IS NULL AND nonce IS NULL AND ciphertext IS NULL) OR "
    "(kek_id IS NOT NULL AND wrapped_dek IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL)"
)


class EncryptedSecret:
    """An optional single secret string, sealed with envelope encryption (see app/crypto.py)."""

    __table_args__ = (CheckConstraint(ENVELOPE_COMPLETE, name="envelope_complete"),)

    kek_id: Mapped[str | None] = mapped_column(String(32))
    wrapped_dek: Mapped[bytes | None] = mapped_column(LargeBinary)
    nonce: Mapped[bytes | None] = mapped_column(LargeBinary)
    ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary)

    def crypto_context(self) -> str:  # binds the ciphertext to this exact row
        raise NotImplementedError

    @property
    def has_secret(self) -> bool:
        return self.ciphertext is not None

    @property
    def envelope(self) -> crypto.Envelope:
        return crypto.Envelope(self.kek_id, self.wrapped_dek, self.nonce, self.ciphertext)  # type: ignore[arg-type]

    @envelope.setter
    def envelope(self, env: crypto.Envelope) -> None:
        self.kek_id, self.wrapped_dek, self.nonce, self.ciphertext = env.kek_id, env.wrapped_dek, env.nonce, env.ciphertext

    def set_secret(self, value: str) -> None:
        self.envelope = crypto.encrypt(value.encode(), self.crypto_context())

    def get_secret(self) -> str | None:
        return crypto.decrypt(self.envelope, self.crypto_context()).decode() if self.has_secret else None

    def check_secret(self) -> None:
        self.get_secret()


class Key(EncryptedSecret, Base):
    """SSH private key or access token. The secret is envelope-encrypted and never returned by the API."""

    __tablename__ = "keys"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    kind: Mapped[str] = mapped_column(String(16))  # ssh | token
    name: Mapped[str] = mapped_column(String(128), unique=True)
    type: Mapped[str] = mapped_column(String(32))
    fingerprint: Mapped[str] = mapped_column(String(256))
    public_key: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[str] = mapped_column(String(32))
    last_used: Mapped[str] = mapped_column(String(64))
    used_count: Mapped[int] = mapped_column(Integer, default=0)

    def crypto_context(self) -> str:
        return f"key:{self.id}"

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "name": self.name, "type": self.type, "fingerprint": self.fingerprint,
                "createdBy": self.created_by, "createdAt": self.created_at, "lastUsed": self.last_used, "usedCount": self.used_count,
                "hasSecret": self.has_secret}


class Inventory(Base):
    __tablename__ = "inventories"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    name: Mapped[str] = mapped_column(String(128), unique=True)
    key: Mapped[str] = mapped_column(String(128))
    hosts: Mapped[list[Host]] = relationship(back_populates="inventory", order_by="Host.id", cascade="all, delete-orphan")

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "key": self.key, "hosts": [h.to_dict() for h in self.hosts]}


class Host(Base):
    __tablename__ = "hosts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    inventory_id: Mapped[str] = mapped_column(ForeignKey("inventories.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    ip: Mapped[str] = mapped_column(String(255))
    port: Mapped[int] = mapped_column(Integer, default=22)
    ssh_user: Mapped[str] = mapped_column(String(64))
    grp: Mapped[str] = mapped_column(String(64))
    host_key: Mapped[str] = mapped_column(String(16), default="ok")  # ok | changed
    status: Mapped[str] = mapped_column(String(16), default="on")  # on | off
    inventory: Mapped[Inventory] = relationship(back_populates="hosts")

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "ip": self.ip, "port": self.port, "user": self.ssh_user, "group": self.grp,
                "hostKey": self.host_key, "status": self.status}


class Repo(Base):
    __tablename__ = "repos"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), unique=True)
    kind: Mapped[str] = mapped_column(String(16))  # git | local | builtin
    url: Mapped[str] = mapped_column(Text)
    branch: Mapped[str] = mapped_column(String(128))
    auth: Mapped[str] = mapped_column(String(255))
    commit: Mapped[str] = mapped_column(String(64))

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "kind": self.kind, "url": self.url, "branch": self.branch, "auth": self.auth,
                "commit": self.commit}


class Registry(EncryptedSecret, Base):
    """Pull token is envelope-encrypted; public registries have none."""

    __tablename__ = "registries"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    name: Mapped[str] = mapped_column(String(128))
    host: Mapped[str] = mapped_column(String(255))
    namespace: Mapped[str] = mapped_column(String(128))
    auth: Mapped[str] = mapped_column(String(128))
    user: Mapped[str] = mapped_column("username", String(128))

    def crypto_context(self) -> str:
        return f"registry:{self.id}"

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "host": self.host, "namespace": self.namespace, "auth": self.auth, "user": self.user,
                "hasSecret": self.has_secret}


class Image(Base):
    __tablename__ = "images"
    ref: Mapped[str] = mapped_column(String(512), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    registry_id: Mapped[str | None] = mapped_column(ForeignKey("registries.id", ondelete="SET NULL"))
    # Repository whose CI builds this image ("owner/name", or "group/sub/name" on GitLab), used to match Git build events.
    source_repo: Mapped[str | None] = mapped_column(String(255), index=True)
    tags: Mapped[list[ImageTag]] = relationship(order_by="ImageTag.pushed_at.desc()", cascade="all, delete-orphan")

    def to_dict(self) -> dict[str, Any]:
        return {"ref": self.ref, "registry": self.registry_id, "sourceRepo": self.source_repo, "tags": [t.to_dict() for t in self.tags]}


class ImageTag(Base):
    """Listed newest first by pushed_at (epoch seconds when the tag was seen)."""

    __tablename__ = "image_tags"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    image_ref: Mapped[str] = mapped_column(ForeignKey("images.ref", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    digest: Mapped[str] = mapped_column(String(128))
    pushed: Mapped[str] = mapped_column(String(64))
    pushed_at: Mapped[float] = mapped_column(Float, default=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "digest": self.digest, "pushed": self.pushed}


class EncryptedVars:
    """Variables sealed with envelope encryption (see app/crypto.py).

    Only the variable names are stored readable, for listings and log masking.
    Values are decrypted on demand and never cached on the row.
    """

    var_names: Mapped[list[str]] = mapped_column(JSONB, default=list)
    kek_id: Mapped[str] = mapped_column(String(32))
    wrapped_dek: Mapped[bytes] = mapped_column(LargeBinary)
    nonce: Mapped[bytes] = mapped_column(LargeBinary)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary)

    def crypto_context(self) -> str:  # binds the ciphertext to this exact row
        raise NotImplementedError

    @property
    def envelope(self) -> crypto.Envelope:
        return crypto.Envelope(self.kek_id, self.wrapped_dek, self.nonce, self.ciphertext)

    @envelope.setter
    def envelope(self, env: crypto.Envelope) -> None:
        self.kek_id, self.wrapped_dek, self.nonce, self.ciphertext = env.kek_id, env.wrapped_dek, env.nonce, env.ciphertext

    def set_vars(self, vars_: list[list[str]]) -> None:
        self.var_names = [k for k, _ in vars_]
        self.envelope = crypto.seal_json(vars_, self.crypto_context())

    def get_vars(self) -> list[list[str]]:
        return crypto.open_json(self.envelope, self.crypto_context())

    def check_secret(self) -> None:
        self.get_vars()


class EnvSet(EncryptedVars, Base):
    __tablename__ = "env_sets"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    name: Mapped[str] = mapped_column(String(255), unique=True)
    ver: Mapped[int] = mapped_column(Integer, default=1)
    updated: Mapped[str] = mapped_column(String(128))
    versions: Mapped[list[EnvVersion]] = relationship(order_by="EnvVersion.ver.desc()", cascade="all, delete-orphan")

    def crypto_context(self) -> str:
        return f"env_set:{self.id}"


class EnvVersion(EncryptedVars, Base):
    __tablename__ = "env_versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    env_id: Mapped[str] = mapped_column(ForeignKey("env_sets.id", ondelete="CASCADE"), index=True)
    ver: Mapped[int] = mapped_column(Integer)
    updated: Mapped[str] = mapped_column(String(128))

    def crypto_context(self) -> str:
        return f"env_version:{self.env_id}:{self.ver}"


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    name: Mapped[str] = mapped_column(String(255), unique=True)
    image: Mapped[str | None] = mapped_column(String(512))  # ref without tag; None when the playbook needs no image
    tag_now: Mapped[str] = mapped_column(String(128), default="-")
    default_tag: Mapped[str] = mapped_column(String(128), default="latest")
    repo: Mapped[str] = mapped_column(String(255))  # Repo.name
    book: Mapped[str] = mapped_column(String(255))  # playbook path inside the repo
    inventory: Mapped[str] = mapped_column(String(128))
    targets: Mapped[list[str]] = mapped_column(JSONB, default=list)
    env: Mapped[str] = mapped_column(String(255))
    hook: Mapped[bool] = mapped_column(Boolean, default=False)
    protected: Mapped[bool] = mapped_column(Boolean, default=True)
    lock: Mapped[bool] = mapped_column(Boolean, default=True)
    rollback: Mapped[bool] = mapped_column(Boolean, default=True)
    last_status: Mapped[str] = mapped_column(String(16), default="warn")
    last_time: Mapped[str] = mapped_column(String(64), default="아직 실행 안 함")
    last_duration: Mapped[str] = mapped_column(String(32), default="-")
    # Who may edit besides Owner/Admin and the creator: group ids and member emails.
    editors: Mapped[dict[str, list[str]]] = mapped_column(
        JSONB, default=lambda: {"groups": [], "members": []}, server_default=text("""'{"groups": [], "members": []}'::jsonb"""))
    created_by: Mapped[str | None] = mapped_column(String(255))  # member email
    playbook_repo: Mapped[Repo | None] = relationship(primaryjoin="foreign(Job.repo) == Repo.name", viewonly=True)

    def to_dict(self) -> dict[str, Any]:
        r = self.playbook_repo
        return {"id": self.id, "name": self.name, "image": self.image, "tagNow": self.tag_now, "defaultTag": self.default_tag,
                "playbook": {"repo": self.repo, "kind": r.kind if r else "git", "url": r.url if r else "",
                             "branch": r.branch if r else "-", "path": self.book},
                "inventory": self.inventory, "targets": self.targets, "env": self.env,
                "hook": self.hook, "protected": self.protected, "lock": self.lock, "rollback": self.rollback,
                "last": {"status": self.last_status, "time": self.last_time, "duration": self.last_duration},
                "editors": {"groups": list((self.editors or {}).get("groups", [])),
                            "members": list((self.editors or {}).get("members", []))},
                "createdBy": self.created_by}


# Run numbers continue after the sample history (#179–#184).
run_no_seq = Sequence("run_no_seq", start=185, metadata=Base.metadata)


class Run(Base):
    __tablename__ = "runs"
    no: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    job: Mapped[str] = mapped_column(String(255))
    job_id: Mapped[str] = mapped_column(String(32), index=True)
    target: Mapped[str] = mapped_column(String(255))
    tag: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16))
    by: Mapped[str] = mapped_column(String(64))
    trigger: Mapped[str] = mapped_column(String(64))
    time: Mapped[str] = mapped_column(String(64))
    duration: Mapped[str] = mapped_column(String(32))
    steps: Mapped[list[str] | None] = mapped_column(JSONB)
    log: Mapped[list[dict] | None] = mapped_column(JSONB)  # masked events, saved when the run ends
    started_at: Mapped[float | None] = mapped_column(Float)

    def to_dict(self) -> dict[str, Any]:
        d = {"no": self.no, "job": self.job, "jobId": self.job_id, "target": self.target, "tag": self.tag,
             "status": self.status, "by": self.by, "trigger": self.trigger, "time": self.time, "duration": self.duration}
        if self.steps:
            d["steps"] = self.steps
        return d


class Activity(Base):
    """Newest first by id. A real build chains a hash of the previous row into each row."""

    __tablename__ = "activity"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    time: Mapped[str] = mapped_column(String(32))
    user: Mapped[str] = mapped_column("username", String(128))
    action: Mapped[str] = mapped_column(String(128))
    object: Mapped[str] = mapped_column(Text)
    ip: Mapped[str] = mapped_column(String(64))
    result: Mapped[str] = mapped_column(String(16))

    def to_dict(self) -> dict[str, Any]:
        return {"time": self.time, "user": self.user, "action": self.action, "object": self.object, "ip": self.ip, "result": self.result}


class Login(Base):
    __tablename__ = "logins"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    time: Mapped[str] = mapped_column(String(32))
    user: Mapped[str] = mapped_column("username", String(255))
    method: Mapped[str] = mapped_column(String(64))
    ip: Mapped[str] = mapped_column(String(64))
    location: Mapped[str] = mapped_column(String(128))
    agent: Mapped[str] = mapped_column(String(255))
    result: Mapped[str] = mapped_column(String(16))

    def to_dict(self) -> dict[str, Any]:
        return {"time": self.time, "user": self.user, "method": self.method, "ip": self.ip, "location": self.location,
                "agent": self.agent, "result": self.result}


member_groups = Table(
    "member_groups",
    Base.metadata,
    Column("member_email", ForeignKey("members.email", ondelete="CASCADE", onupdate="CASCADE"), primary_key=True),
    Column("group_id", ForeignKey("groups.id", ondelete="CASCADE"), primary_key=True),
)


class Member(Base):
    """`role` decides what a member can do; their groups decide which menus and builds they see."""

    __tablename__ = "members"
    email: Mapped[str] = mapped_column(String(255), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    name: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(16))
    tfa: Mapped[bool] = mapped_column(Boolean, default=False)
    last: Mapped[str] = mapped_column(String(64))
    groups: Mapped[list[Group]] = relationship(secondary=member_groups, back_populates="members", order_by="Group.ord")

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "email": self.email, "role": self.role, "tfa": self.tfa, "last": self.last,
                "groups": [g.id for g in self.groups]}


class Group(Base):
    """A set of members who see the same menus and the builds of the same repos.

    `all_builds` grants every build repo, including ones added later; otherwise only `repos` (owner/name, lower case).
    """

    __tablename__ = "groups"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    ord: Mapped[int] = mapped_column(Integer, Identity())
    name: Mapped[str] = mapped_column(String(64), unique=True)
    menus: Mapped[list[str]] = mapped_column(JSONB, default=list)
    all_builds: Mapped[bool] = mapped_column(Boolean, default=False)
    repos: Mapped[list[str]] = mapped_column(JSONB, default=list)
    members: Mapped[list[Member]] = relationship(secondary=member_groups, back_populates="groups", order_by="Member.ord")

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "menus": self.menus, "allBuilds": self.all_builds, "repos": self.repos,
                "members": [x.email for x in self.members]}


class DeviceSession(Base):
    __tablename__ = "device_sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    agent: Mapped[str] = mapped_column(String(255))
    ip: Mapped[str] = mapped_column(String(64))
    location: Mapped[str] = mapped_column(String(128))
    time: Mapped[str] = mapped_column(String(64))
    current: Mapped[bool] = mapped_column(Boolean, default=False)

    def to_dict(self) -> dict[str, Any]:
        return {"agent": self.agent, "ip": self.ip, "location": self.location, "time": self.time, "current": self.current}


class Build(Base):
    """A CI run reported by a Git host: Gitea/GitHub Actions workflow runs or GitLab pipelines."""

    __tablename__ = "builds"
    __table_args__ = (UniqueConstraint("repo", "run_id"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider: Mapped[str] = mapped_column(String(16), default="gitea", server_default="gitea")  # gitea | github | gitlab
    repo: Mapped[str] = mapped_column(String(255), index=True)  # owner/name, lower case
    run_id: Mapped[int] = mapped_column(BigInteger)
    run_number: Mapped[int | None] = mapped_column(Integer)
    workflow: Mapped[str] = mapped_column(String(255), default="")
    title: Mapped[str] = mapped_column(String(512), default="")
    status: Mapped[str] = mapped_column(String(16))  # queued | in_progress | success | failure | cancelled | skipped
    branch: Mapped[str | None] = mapped_column(String(255))
    sha: Mapped[str | None] = mapped_column(String(64))
    url: Mapped[str | None] = mapped_column(Text)
    step: Mapped[str | None] = mapped_column(String(255))  # current job name while running
    tag: Mapped[str | None] = mapped_column(String(128))  # image tag pushed by this run
    started_at: Mapped[float] = mapped_column(Float)
    updated_at: Mapped[float] = mapped_column(Float)

    @property
    def active(self) -> bool:
        return self.status in ("queued", "in_progress")

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "provider": self.provider, "repo": self.repo, "runId": self.run_id, "runNumber": self.run_number, "workflow": self.workflow,
                "title": self.title, "status": self.status, "active": self.active, "branch": self.branch, "sha": self.sha,
                "url": self.url, "step": self.step, "tag": self.tag, "startedAt": self.started_at, "updatedAt": self.updated_at}
