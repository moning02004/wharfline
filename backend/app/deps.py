from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from . import store as s
from .db import get_db


def require_login(db: Session = Depends(get_db)) -> None:
    if not s.session_state(db).get("logged_in"):
        raise HTTPException(status_code=401, detail="login_required")


def require_sudo(db: Session = Depends(get_db)) -> None:
    """Sensitive actions need a recent password re-check."""
    require_login(db)
    if not s.sudo_active(db):
        raise HTTPException(status_code=403, detail="sudo_required")
