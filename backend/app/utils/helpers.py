import re
import secrets
import time
from datetime import datetime, timezone

# No 0/O/1/I/L so codes are easy to read out loud
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CONTROL = re.compile(r"[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def now_ms() -> int:
    return int(time.time() * 1000)


def new_room_code(length: int = 6) -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def new_invite_token() -> str:
    return secrets.token_urlsafe(16)


def new_id() -> str:
    return secrets.token_hex(8)


def clean_text(value: str, max_len: int) -> str:
    """Strip control / bidi-override characters, collapse whitespace, cap length."""
    value = _CONTROL.sub("", value or "")
    value = re.sub(r"\s+", " ", value).strip()
    return value[:max_len]
