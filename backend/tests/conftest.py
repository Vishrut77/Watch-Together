import os

# Must be set before the app is imported
os.environ.update(
    APP_ENV="test",
    DATABASE_URL="sqlite://",
    SECRET_KEY="test-secret-key-test-secret-key-0123456789",
    LIVEKIT_URL="wss://test.livekit.cloud",
    LIVEKIT_API_KEY="testkey",
    LIVEKIT_API_SECRET="testsecret-testsecret-testsecret-0123",
    RATE_LIMIT_ENABLED="false",
    PRESENCE_ENABLED="false",
    FRONTEND_DIST="/nonexistent",
)

import pytest
from fastapi.testclient import TestClient

from app.core import security
from app.database.database import Base, engine
from app.main import app
from app.services import livekit_service
from app.services.realtime import hub


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    hub.reset()
    security.reset_rate_limits()
    calls = []

    async def fake_call(fn):  # never hit the network; record that a LiveKit action was requested
        calls.append(fn)
        return True

    async def fake_mute(room_id, identity):
        calls.append(("mute", room_id, identity))
        return True

    async def fake_remove(room_id, identity):
        calls.append(("remove", room_id, identity))
        return True

    async def fake_update(room, participant):
        calls.append(("update", room.id, participant.id))
        return True

    async def fake_delete(room_id):
        calls.append(("delete", room_id))
        return True

    monkeypatch.setattr(livekit_service, "mute_microphone", fake_mute)
    monkeypatch.setattr(livekit_service, "remove_participant", fake_remove)
    monkeypatch.setattr(livekit_service, "update_permissions", fake_update)
    monkeypatch.setattr(livekit_service, "delete_room", fake_delete)
    from app.routes import moderation, participants, rooms  # same module objects, patched attributes above

    yield calls


@pytest.fixture
def lk_calls(fresh_state):
    return fresh_state


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ---------- helpers ----------
class Person:
    def __init__(self, data: dict, client_id: str):
        self.token = data["session_token"]
        self.id = data["participant"]["id"]
        self.role = data["participant"]["role"]
        self.invite = data.get("invite_token")
        self.client_id = client_id
        self.headers = {"Authorization": f"Bearer {self.token}"}


def make_room(client, **over):
    body = {"name": "Movie Night", "is_public": True, "max_participants": 10, "nickname": "Owner", "client_id": "owner-client-id"}
    body.update(over)
    r = client.post("/api/rooms", json=body)
    assert r.status_code == 201, r.text
    data = r.json()
    return data["room"]["id"], Person(data, body["client_id"])


def join(client, code, nickname="Friend", client_id=None, expect=200, **extra):
    client_id = client_id or f"client-{nickname.lower()}-0001"
    r = client.post(f"/api/rooms/{code}/join", json={"nickname": nickname, "client_id": client_id, **extra})
    assert r.status_code == expect, r.text
    return Person(r.json(), client_id) if expect == 200 else r


def drain(ws):
    """Send a ping and return every message received before the pong (a safe way to read without blocking)."""
    ws.send_json({"type": "ping"})
    out = []
    while True:
        msg = ws.receive_json()
        if msg["type"] == "pong":
            return out
        out.append(msg)


def types(msgs):
    return [m["type"] for m in msgs]
