from datetime import datetime, timedelta, timezone
import pytest
from app.core.config import settings
from app.database.database import SessionLocal
from app.models import ChatMessage, Participant, Room
from app.services import room_service
from app.services.realtime import hub
from app.utils.helpers import utcnow
from tests.conftest import drain, join, make_room


def test_closing_socket_marks_offline_quickly(client, monkeypatch):
    monkeypatch.setattr(settings, "presence_enabled", True)
    code, owner = make_room(client)

    with client.websocket_connect(f"/ws/rooms/{code}?token={owner.token}") as ws:
        msg = ws.receive_json()
        assert msg["type"] in ("state", "roster")
        assert owner.id in hub.online_ids(code)

    # Socket closed. Sockets map in hub immediately drops the participant
    assert owner.id not in hub.online_ids(code)


def test_away_beacon_marks_offline_and_broadcasts(client, monkeypatch):
    monkeypatch.setattr(settings, "presence_enabled", True)
    code, owner = make_room(client)
    guest = join(client, code, "Guest")

    with client.websocket_connect(f"/ws/rooms/{code}?token={owner.token}") as ws_owner:
        ws_owner.receive_json()  # initial message
        with client.websocket_connect(f"/ws/rooms/{code}?token={guest.token}") as ws_guest:
            # drain roster update
            drain(ws_owner)
            assert guest.id in hub.online_ids(code)

            # Send beacon /away for guest
            res = client.post(f"/api/rooms/{code}/away", json={"session_token": guest.token})
            assert res.status_code == 204

            # guest should now be marked offline in hub immediately
            assert guest.id not in hub.online_ids(code)
            # owner should receive roster update showing guest online=False
            roster_update = ws_owner.receive_json()
            assert roster_update["type"] == "roster"
            assert any(p["id"] == guest.id and p["online"] is False for p in roster_update["participants"])


def test_now_showing_hides_rooms_with_zero_online(client, monkeypatch):
    monkeypatch.setattr(settings, "presence_enabled", True)
    code, owner = make_room(client, name="Live Room", is_public=True)

    # Before websocket connects, it was joining grace, but once joining grace ends without socket:
    hub.joining.get(code, set()).clear()
    res = client.get("/api/rooms").json()
    assert not any(r["id"] == code for r in res)

    # Once owner connects websocket, it appears in /api/rooms with count 1
    with client.websocket_connect(f"/ws/rooms/{code}?token={owner.token}"):
        res = client.get("/api/rooms").json()
        room_entry = next((r for r in res if r["id"] == code), None)
        assert room_entry is not None
        assert room_entry["participants_count"] == 1

    # Disconnected again:
    res = client.get("/api/rooms").json()
    assert not any(r["id"] == code for r in res)


def test_rejoin_within_14m_works_and_after_16m_gives_fresh_identity(client):
    code, owner = make_room(client)
    guest = join(client, code, "Alex", client_id="alex-client-123")
    alex_orig_id = guest.id

    # Simulate 14 minutes passing
    with SessionLocal() as db:
        p = db.get(Participant, alex_orig_id)
        p.last_seen = utcnow() - timedelta(minutes=14)
        db.commit()

    # Resume works within 14 minutes
    res_resume = client.post(f"/api/rooms/{code}/resume", headers={"Authorization": f"Bearer {guest.token}"})
    assert res_resume.status_code == 200
    assert res_resume.json()["participant"]["id"] == alex_orig_id

    # Join with same client_id also restores existing participant within window
    rejoin_guest = join(client, code, "Alex", client_id="alex-client-123")
    assert rejoin_guest.id == alex_orig_id

    # Now simulate 16 minutes passing (> 15m rejoin window)
    with SessionLocal() as db:
        p = db.get(Participant, alex_orig_id)
        p.last_seen = utcnow() - timedelta(minutes=16)
        db.commit()

    # Resume now fails with 401
    res_resume_expired = client.post(f"/api/rooms/{code}/resume", headers={"Authorization": f"Bearer {guest.token}"})
    assert res_resume_expired.status_code == 401

    # Joining again creates a fresh participant identity
    fresh_guest = join(client, code, "Alex", client_id="alex-client-123")
    assert fresh_guest.id != alex_orig_id


@pytest.mark.anyio
async def test_host_transfer_promotes_cohost_with_most_perms_then_oldest(client):
    code, owner = make_room(client)
    viewer = join(client, code, "Viewer", client_id="viewer-1")
    cohost1 = join(client, code, "CoHost1", client_id="cohost-1")
    cohost2 = join(client, code, "CoHost2", client_id="cohost-2")

    # Grant permissions: cohost2 gets 2 permissions, cohost1 gets 1 permission
    r1 = client.post(
        f"/api/rooms/{code}/participants/{cohost1.id}/permissions",
        headers={"Authorization": f"Bearer {owner.token}"},
        json={"permissions": ["mute_participants"]},
    )
    assert r1.status_code == 200
    r2 = client.post(
        f"/api/rooms/{code}/participants/{cohost2.id}/permissions",
        headers={"Authorization": f"Bearer {owner.token}"},
        json={"permissions": ["mute_participants", "stream_movie"]},
    )
    assert r2.status_code == 200

    # Owner drops and has been offline for 16 minutes
    with SessionLocal() as db:
        p_owner = db.get(Participant, owner.id)
        p_owner.last_seen = utcnow() - timedelta(minutes=16)
        db.commit()

    # Simulate cohost1, cohost2, and viewer online in hub
    hub.sockets[code] = {cohost1.id: None, cohost2.id: None, viewer.id: None}

    with SessionLocal() as db:
        transferred = await room_service.transfer_owner_if_needed(db, code)
        assert transferred is True
        room = db.get(Room, code)
        # cohost2 had 2 permissions, so cohost2 should be promoted over cohost1
        assert room.owner_id == cohost2.id
        new_owner = db.get(Participant, cohost2.id)
        assert new_owner.role == "owner"
        old_owner = db.get(Participant, owner.id)
        assert old_owner.role == "participant"


@pytest.mark.anyio
async def test_abandoned_room_deleted_after_15_minutes(client):
    code, owner = make_room(client)
    # Add a chat message
    with SessionLocal() as db:
        room_service.set_chat_message(db, code, db.get(Participant, owner.id), "Hello all")
        # Set last_seen 16 minutes ago
        p = db.get(Participant, owner.id)
        p.last_seen = utcnow() - timedelta(minutes=16)
        db.commit()

    # Make sure nobody is in hub.online_ids
    hub.sockets.pop(code, None)
    hub.joining.pop(code, None)

    with SessionLocal() as db:
        deleted = await room_service.cleanup_abandoned_rooms(db)
        assert code in deleted
        assert db.get(Room, code) is None
        assert db.query(Participant).filter(Participant.room_id == code).count() == 0
        assert db.query(ChatMessage).filter(ChatMessage.room_id == code).count() == 0
