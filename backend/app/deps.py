from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from . import models as m
from . import store as s
from .db import get_db


def require_login(db: Session = Depends(get_db)) -> None:
    if not s.current_member(db):
        raise HTTPException(status_code=401, detail="login_required")


def require_sudo(db: Session = Depends(get_db)) -> None:
    """Sensitive actions need a recent password re-check."""
    require_login(db)
    if not s.sudo_active(db):
        raise HTTPException(status_code=403, detail="sudo_required")


def require_owner(db: Session = Depends(get_db)) -> None:
    """Changing roles, groups and menu access is for Owners only."""
    me = s.current_member(db)
    if not me:
        raise HTTPException(status_code=401, detail="login_required")
    if me.role != "Owner":
        raise HTTPException(status_code=403, detail="Owner만 바꿀 수 있어요.")


def require(action: str):
    """Dependency: the signed-in member must be allowed `action` (see store.PERMS). X-View-As is ignored."""
    if action not in s.PERMS:
        raise ValueError(f"unknown action {action}")

    def check(db: Session = Depends(get_db)) -> None:
        me = s.current_member(db)
        if not me:
            raise HTTPException(status_code=401, detail="login_required")
        if not s.can(me, action):
            raise HTTPException(status_code=403, detail=s.NO_PERM)

    return check


def viewer(db: Session = Depends(get_db), x_view_as: str | None = Header(default=None)) -> m.Member | None:
    """Whose view to show: the signed-in member, or, for an Owner previewing, the member named in X-View-As.

    Only what is shown changes. Permission checks for changes always use the signed-in member.
    """
    me = s.current_member(db)
    if me and me.role == "Owner" and x_view_as and x_view_as != me.email:
        return db.get(m.Member, x_view_as) or me
    return me


def build_scope(who: m.Member | None = Depends(viewer)) -> set[str] | None:
    """Build repos the viewer may see; None means all."""
    return s.build_scope(who)
