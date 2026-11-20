import hashlib
import hmac
import os
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.config import settings
from app.database.database import get_db
from app.models import Participant, Room

# ---------- passwords (scrypt from the standard library, salted) ----------


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except Exception:
        return False


# ---------- session tokens (who the caller is inside a room) ----------


def create_session_token(participant_id: str, room_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=settings.session_ttl_hours)
    return jwt.encode({"sub": participant_id, "room": room_id, "exp": exp}, settings.secret_key, algorithm="HS256")


def decode_session_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def participant_from_token(db: Session, token: str, room_id: str) -> Participant:
    """Resolve a session token to a participant. Raises HTTPException with a friendly message."""
    claims = decode_session_token(token)
    if not claims or claims.get("room") != room_id:
        raise HTTPException(401, "Your session has expired. Please join the room again.")
    participant = db.get(Participant, claims["sub"])
    if not participant or participant.room_id != room_id:
        raise HTTPException(401, "Your session is no longer valid. Please join the room again.")
    if participant.status == "banned":
        raise HTTPException(403, "You have been banned from this room.")
    if participant.status == "kicked":
        raise HTTPException(403, "You were removed from this room. Join again to come back.")
    room = db.get(Room, room_id)
    if not room or room.is_closed:
        raise HTTPException(410, "This room has been closed.")
    return participant


def get_current_participant(
    room_id: str,
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> Participant:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing session token.")
    return participant_from_token(db, authorization[7:].strip(), room_id)


# ---------- rate limiting (in-memory sliding window) ----------

_hits: dict[str, deque] = defaultdict(deque)


def client_ip(request: Request) -> str:
    if settings.trust_proxy_headers:
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def check_rate(key: str, limit: int, window: float) -> bool:
    """True if allowed. Records the hit."""
    now = time.monotonic()
    q = _hits[key]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True


def reset_rate_limits() -> None:
    _hits.clear()


def rate_limit(name: str, limit: int, window: float = 60.0):
    """FastAPI dependency factory: at most `limit` calls per `window` seconds per client IP."""

    def dependency(request: Request) -> None:
        if not settings.rate_limit_enabled:
            return
        if not check_rate(f"{name}:{client_ip(request)}", limit, window):
            raise HTTPException(429, "Too many requests. Please wait a moment and try again.")

    return dependency
