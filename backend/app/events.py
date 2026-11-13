"""Change notices for open pages (GET /api/events, Server-Sent Events).

Any commit that touches a job, run, build or image bumps a counter with the topic that changed; the stream tells
each open page "jobs changed" and the page refetches through the normal API, so permissions stay where they are.
Notices carry no data. One process holds the counter: with several API workers this would need Postgres
LISTEN/NOTIFY instead.
"""

import threading

from sqlalchemy import event
from sqlalchemy.orm import Session

# Model name → topic sent to pages.
TOPICS = {"Job": "jobs", "Run": "runs", "Build": "builds", "Image": "images", "ImageTag": "images"}
KEEP = 200  # recent notices remembered, enough for a page that missed a few seconds

_lock = threading.Lock()
_seq = 0
_recent: list[tuple[int, str]] = []


def publish(*topics: str) -> None:
    global _seq
    if not topics:
        return
    with _lock:
        for t in sorted(set(topics)):
            _seq += 1
            _recent.append((_seq, t))
        del _recent[:-KEEP]


def current() -> int:
    return _seq


def since(seq: int) -> tuple[int, set[str]]:
    """The newest number and the topics changed after `seq`. A page further behind than KEEP, or holding a number
    from before the server restarted, gets every topic."""
    with _lock:
        if seq > _seq or (_recent and seq < _recent[0][0] - 1):
            return _seq, set(TOPICS.values())
        return _seq, {t for n, t in _recent if n > seq}


def _pending(db: Session) -> set[str]:
    return db.info.setdefault("wl_changed", set())


@event.listens_for(Session, "after_flush")
def _collect(db: Session, _ctx) -> None:
    for obj in (*db.new, *db.dirty, *db.deleted):
        t = TOPICS.get(type(obj).__name__)
        if t:
            _pending(db).add(t)


@event.listens_for(Session, "do_orm_execute")
def _collect_bulk(state) -> None:
    # update(m.Run)… / delete(m.Build)… skip the flush lists.
    if (state.is_update or state.is_delete) and state.bind_mapper is not None:
        t = TOPICS.get(state.bind_mapper.class_.__name__)
        if t:
            _pending(state.session).add(t)


@event.listens_for(Session, "after_commit")
def _send(db: Session) -> None:
    changed = db.info.pop("wl_changed", None)
    if changed:
        publish(*changed)


@event.listens_for(Session, "after_rollback")
def _drop(db: Session) -> None:
    db.info.pop("wl_changed", None)
