import time

from app.core.config import settings
from tests.conftest import drain, join, make_room


def wait_for(predicate, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def test_closed_tab_frees_the_seat_and_stops_the_movie(client, monkeypatch):
    monkeypatch.setattr(settings, "presence_enabled", True)
    monkeypatch.setattr(settings, "join_grace_seconds", 0.2)
    monkeypatch.setattr(settings, "streamer_grace_seconds", 0.1)
    monkeypatch.setattr(settings, "presence_grace_seconds", 0.3)

    code, owner = make_room(client, max_participants=2)
    guest = join(client, code, "Guest")
    count = lambda: client.get(f"/api/rooms/{code}").json()["participants_count"]

    # a guest that never opens the socket is released after the join grace period
    assert count() == 2
    with client.websocket_connect(f"/ws/rooms/{code}?token={owner.token}") as a:
        a.receive_json()
        a.send_json({"type": "movie_start", "title": "Film", "duration": 10})
        drain(a)
        assert wait_for(lambda: count() == 1)
        # a brand new person can now take the free seat
        join(client, code, "NewGuest")

    # the streaming host drops: movie stops, then the seat is freed
    with client.websocket_connect(f"/ws/rooms/{code}?token={owner.token}") as a:
        pass
    assert wait_for(lambda: client.get(f"/api/rooms/{code}").json()["participants_count"] <= 1)
