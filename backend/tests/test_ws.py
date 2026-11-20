import pytest
from starlette.websockets import WebSocketDisconnect

from tests.conftest import drain, join, make_room, types


def url(code, person):
    return f"/ws/rooms/{code}?token={person.token}"


def test_socket_rejects_bad_token(client):
    code, owner = make_room(client)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/rooms/{code}?token=nope") as ws:
            ws.receive_json()


def test_socket_sends_state_snapshot(client):
    code, owner = make_room(client)
    with client.websocket_connect(url(code, owner)) as ws:
        state = ws.receive_json()
        assert state["type"] == "state"
        assert state["me"]["role"] == "owner" and state["invite_token"] == owner.invite
        assert state["room"]["id"] == code and state["playback"]["has_movie"] is False
        assert state["participants"][0]["online"] is True


def test_guest_does_not_receive_invite_token(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, guest)) as ws:
        assert ws.receive_json()["invite_token"] is None


def test_chat_is_real_persisted_and_validated(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, owner)) as a, client.websocket_connect(url(code, guest)) as b:
        a.receive_json(); b.receive_json()
        b.send_json({"type": "chat", "text": "  hello   world  "})
        drain(b)
        got = [m for m in drain(a) if m["type"] == "chat"]
        assert got and got[0]["text"] == "hello world" and got[0]["nickname"] == "Guest" and got[0]["role"] == "participant"
        b.send_json({"type": "chat", "text": "   "})
        errs = [m for m in drain(b) if m["type"] == "error"]
        assert errs and errs[0]["code"] == "invalid"
        b.send_json({"type": "chat", "text": "x" * 900})
        long = [m for m in drain(a) if m["type"] == "chat"]
        assert len(long[0]["text"]) == 500
    # a late joiner sees history
    with client.websocket_connect(url(code, owner)) as c:
        history = c.receive_json()["chat"]
        assert [m["text"] for m in history][:1] == ["hello world"]


def test_chat_spam_is_limited(client):
    code, owner = make_room(client)
    with client.websocket_connect(url(code, owner)) as ws:
        ws.receive_json()
        for i in range(8):
            ws.send_json({"type": "chat", "text": f"m{i}"})
        msgs = drain(ws)
        assert sum(m["type"] == "chat" for m in msgs) == 5
        assert any(m["type"] == "error" and m["code"] == "rate_limited" for m in msgs)


def test_host_can_turn_chat_off_for_participants_only(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    client.patch(f"/api/rooms/{code}/settings", headers=owner.headers, json={"chat_enabled": False})
    with client.websocket_connect(url(code, owner)) as a, client.websocket_connect(url(code, guest)) as b:
        a.receive_json(); b.receive_json()
        b.send_json({"type": "chat", "text": "can you hear me"})
        assert any(m.get("code") == "chat_disabled" for m in drain(b))
        a.send_json({"type": "chat", "text": "host can still talk"})
        assert any(m["type"] == "chat" for m in drain(b))


def test_only_authorized_people_can_stream_and_control_playback(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, owner)) as a, client.websocket_connect(url(code, guest)) as b:
        a.receive_json(); b.receive_json()
        # guest tries everything
        b.send_json({"type": "movie_start", "title": "Hax", "duration": 10})
        assert any(m.get("code") == "forbidden" for m in drain(b))
        b.send_json({"type": "playback_command", "action": "pause"})
        assert any(m.get("code") == "forbidden" for m in drain(b))
        assert "playback" not in types(drain(a))

        a.send_json({"type": "movie_start", "title": "Big Buck Bunny", "duration": 600})
        drain(a)
        pb = [m for m in drain(b) if m["type"] == "playback"]
        assert pb and pb[-1]["has_movie"] and pb[-1]["title"] == "Big Buck Bunny" and pb[-1]["streamer_id"] == owner.id

        # guest cannot fake the clock either
        b.send_json({"type": "playback_state", "playing": True, "position": 99, "duration": 600})
        drain(b)
        assert "playback" not in types(drain(a))
        # ...and cannot stop the movie
        b.send_json({"type": "movie_stop"})
        drain(b)
        assert "playback" not in types(drain(a))


def test_cohost_commands_reach_streamer_and_state_syncs_back(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    third = join(client, code, "Third")
    client.post(f"/api/rooms/{code}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["manage_playback"]})
    with client.websocket_connect(url(code, owner)) as a, client.websocket_connect(url(code, guest)) as b, client.websocket_connect(url(code, third)) as c:
        for ws in (a, b, c):
            ws.receive_json()
        a.send_json({"type": "movie_start", "title": "Film", "duration": 100})
        drain(a)
        b.send_json({"type": "playback_command", "action": "seek", "position": 42})
        drain(b)
        cmds = [m for m in drain(a) if m["type"] == "playback_command"]
        assert cmds and cmds[0]["action"] == "seek" and cmds[0]["position"] == 42
        # streamer applies it and reports the real state; everyone else gets it
        a.send_json({"type": "playback_state", "playing": True, "position": 42, "duration": 100})
        drain(a)
        seen = [m for m in drain(c) if m["type"] == "playback"]
        assert seen[-1]["playing"] is True and seen[-1]["position"] == 42
    # reconnecting viewer gets the current state
    with client.websocket_connect(url(code, third)) as c2:
        snap = c2.receive_json()
        assert snap["playback"]["has_movie"] and snap["playback"]["position"] == 42


def test_nonsense_numbers_are_rejected(client):
    code, owner = make_room(client)
    with client.websocket_connect(url(code, owner)) as ws:
        ws.receive_json()
        ws.send_json({"type": "movie_start", "title": "F", "duration": 100})
        drain(ws)
        ws.send_json({"type": "playback_state", "playing": True, "position": "abc", "duration": 100})
        ws.send_json({"type": "playback_state", "playing": True, "position": None, "duration": 100})
        ws.send_json({"type": "playback_state", "playing": True, "position": True, "duration": 100})
        drain(ws)
    with client.websocket_connect(url(code, owner)) as ws:
        assert ws.receive_json()["playback"]["position"] == 0.0  # none of that changed the clock


def test_second_streamer_is_blocked_while_first_is_online(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    client.post(f"/api/rooms/{code}/participants/{guest.id}/permissions", headers=owner.headers, json={"permissions": ["stream_movie"]})
    with client.websocket_connect(url(code, owner)) as a, client.websocket_connect(url(code, guest)) as b:
        a.receive_json(); b.receive_json()
        a.send_json({"type": "movie_start", "title": "A", "duration": 5})
        drain(a)
        b.send_json({"type": "movie_start", "title": "B", "duration": 5})
        assert any(m.get("code") == "busy" for m in drain(b))
        # owner can take over from a co-host
        b_stop = {"type": "movie_stop"}
        a.send_json(b_stop)
        drain(a)
        b.send_json({"type": "movie_start", "title": "B", "duration": 5})
        drain(b)
        a.send_json({"type": "movie_start", "title": "A2", "duration": 5})
        assert not any(m.get("code") == "busy" for m in drain(a))
        assert any(m["type"] == "movie_stopped" for m in drain(b))


def test_kick_closes_the_socket_with_notice(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, guest)) as b:
        b.receive_json()
        client.post(f"/api/rooms/{code}/participants/{guest.id}/kick", headers=owner.headers)
        seen = []
        with pytest.raises(WebSocketDisconnect):
            while True:
                seen.append(b.receive_json()["type"])
        assert "kicked" in seen


def test_announcements_need_permission(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, owner)) as a, client.websocket_connect(url(code, guest)) as b:
        a.receive_json(); b.receive_json()
        b.send_json({"type": "announce", "text": "fake"})
        assert any(m.get("code") == "forbidden" for m in drain(b))
        a.send_json({"type": "announce", "text": "Starting in 5!"})
        got = [m for m in drain(b) if m["type"] == "announcement"]
        assert got and got[0]["text"] == "Starting in 5!"


def test_reactions_hands_and_presence(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, owner)) as a:
        a.receive_json()
        with client.websocket_connect(url(code, guest)) as b:
            b.receive_json()
            msgs = drain(a)
            assert "participant_joined" in types(msgs)
            b.send_json({"type": "reaction", "emoji": "🔥"})
            b.send_json({"type": "reaction", "emoji": "<script>"})
            b.send_json({"type": "hand", "raised": True})
            drain(b)
            msgs = drain(a)
            assert [m["emoji"] for m in msgs if m["type"] == "reaction"] == ["🔥"]
            rosters = [m for m in msgs if m["type"] == "roster"]
            assert any(p["hand_raised"] for p in rosters[-1]["participants"] if p["id"] == guest.id)
        roster = [m for m in drain(a) if m["type"] == "roster"][-1]["participants"]
        assert [p["online"] for p in roster if p["id"] == guest.id] == [False]


def test_closing_room_notifies_sockets(client):
    code, owner = make_room(client)
    guest = join(client, code, "Guest")
    with client.websocket_connect(url(code, guest)) as b:
        b.receive_json()
        client.delete(f"/api/rooms/{code}", headers=owner.headers)
        seen = []
        with pytest.raises(WebSocketDisconnect):
            while True:
                seen.append(b.receive_json()["type"])
        assert "room_closed" in seen
