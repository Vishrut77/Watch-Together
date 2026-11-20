import os
import time
from datetime import datetime, timezone

from app.database.database import SessionLocal
from app.models import Participant
from app.services import room_service
from tests.conftest import make_room


def test_find_mentions():
    parts = [
        Participant(id="p1", nickname="Alice", room_id="TEST", client_id="c1"),
        Participant(id="p2", nickname="Bob Smith", room_id="TEST", client_id="c2"),
        Participant(id="p3", nickname="Bob", room_id="TEST", client_id="c3"),
        Participant(id="p4", nickname="Sam (2)", room_id="TEST", client_id="c4"),
        Participant(id="p5", nickname="Sam (2)", room_id="TEST", client_id="c5"),
        Participant(id="p6", nickname="example", room_id="TEST", client_id="c6"),
        Participant(id="p7", nickname="gmail.com", room_id="TEST", client_id="c7"),
    ]

    # Spaces in names
    assert room_service.find_mentions("Hello @Bob Smith!", parts) == ["p2"]

    # Longest match first: @Bob Smith matches Bob Smith, not Bob
    assert room_service.find_mentions("Hello @Bob and @Bob Smith", parts) == ["p2", "p3"]

    # Case insensitive
    assert room_service.find_mentions("hey @alice and @BOB", parts) == ["p1", "p3"]

    # Duplicate names (both participant IDs returned)
    assert set(room_service.find_mentions("Calling @Sam (2) here", parts)) == {"p4", "p5"}

    # No false matches inside emails
    assert room_service.find_mentions("Contact test@example and user@gmail.com", parts) == []

    # Punctuation at boundary
    assert room_service.find_mentions("(@Alice)", parts) == ["p1"]


def test_chat_timestamp_timezone_roundtrip(client):
    code, owner = make_room(client)
    with SessionLocal() as db:
        p = db.get(Participant, owner.id)
        now_utc_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        msg = room_service.set_chat_message(db, code, p, "Hello timezone test!")
        out = room_service.chat_out(msg)

        diff_ms = abs(out["ts"] - now_utc_ms)
        assert diff_ms < 5000, f"Timestamp diff too large: {diff_ms} ms (ts={out['ts']}, now={now_utc_ms})"

        history = room_service.recent_chat(db, code)
        assert len(history) >= 1
        last = history[-1]
        assert abs(last["ts"] - now_utc_ms) < 5000
