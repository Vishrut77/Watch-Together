from tests.conftest import drain, join, make_room


def _url(code, person):
    return f"/ws/rooms/{code}?token={person.token}"


def test_local_sync_movie_start_and_broadcast(client):
    code, owner = make_room(client)
    viewer = join(client, code, "Viewer")
    fp = {
        "name": "big_buck_bunny.mp4",
        "size": 12345678,
        "head_sha256": "a" * 64,
        "tail_sha256": "b" * 64,
    }
    with client.websocket_connect(_url(code, owner)) as host_ws, client.websocket_connect(_url(code, viewer)) as v_ws:
        s0 = host_ws.receive_json()
        assert s0["playback"]["mode"] == "live"
        assert s0["playback"]["fingerprint"] is None
        v_ws.receive_json()

        host_ws.send_json({
            "type": "movie_start",
            "mode": "local_sync",
            "title": "big_buck_bunny.mp4",
            "duration": 596.5,
            "fingerprint": fp,
        })
        host_msgs = [m for m in drain(host_ws) if m["type"] == "playback"]
        viewer_msgs = [m for m in drain(v_ws) if m["type"] == "playback"]
        assert host_msgs and viewer_msgs
        pb = viewer_msgs[-1]
        assert pb["has_movie"] is True
        assert pb["mode"] == "local_sync"
        assert pb["title"] == "big_buck_bunny.mp4"
        assert pb["duration"] == 596.5
        assert pb["fingerprint"] == fp

        # Playback state updates sync without clearing mode/fingerprint
        host_ws.send_json({"type": "playback_state", "playing": True, "position": 42.25, "duration": 596.5})
        drain(host_ws)
        upd = [m for m in drain(v_ws) if m["type"] == "playback"][-1]
        assert upd["mode"] == "local_sync"
        assert upd["fingerprint"] == fp
        assert upd["playing"] is True
        assert upd["position"] == 42.25

        # Late joiner sees local_sync state immediately on connect
        late = join(client, code, "Latecomer")
        with client.websocket_connect(_url(code, late)) as late_ws:
            st = late_ws.receive_json()
            assert st["playback"]["mode"] == "local_sync"
            assert st["playback"]["fingerprint"] == fp

        # Stop resets mode and fingerprint back to defaults
        host_ws.send_json({"type": "movie_stop"})
        drain(host_ws)
        stopped = [m for m in drain(v_ws) if m["type"] == "playback"][-1]
        assert stopped["has_movie"] is False
        assert stopped["mode"] == "live"
        assert stopped["fingerprint"] is None


def test_local_sync_rejects_bad_fingerprint_and_unauthorized_users(client):
    code, owner = make_room(client)
    viewer = join(client, code, "Guest")
    with client.websocket_connect(_url(code, owner)) as host_ws, client.websocket_connect(_url(code, viewer)) as v_ws:
        host_ws.receive_json()
        v_ws.receive_json()

        # Unauthorized viewer cannot start local_sync
        v_ws.send_json({
            "type": "movie_start",
            "mode": "local_sync",
            "title": "hack.mp4",
            "duration": 100,
            "fingerprint": {"name": "hack.mp4", "size": 10, "head_sha256": "0" * 64, "tail_sha256": "1" * 64},
        })
        err_v = [m for m in drain(v_ws) if m["type"] == "error"]
        assert err_v and err_v[-1]["code"] == "forbidden"

        # Invalid fingerprint rejected even for owner
        host_ws.send_json({
            "type": "movie_start",
            "mode": "local_sync",
            "title": "bad.mp4",
            "duration": 100,
            "fingerprint": {"name": "bad.mp4", "size": -5, "head_sha256": "nothex", "tail_sha256": "1" * 64},
        })
        err_h = [m for m in drain(host_ws) if m["type"] == "error"]
        assert err_h and err_h[-1]["code"] == "invalid"

