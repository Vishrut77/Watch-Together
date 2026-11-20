"""Tests for the Headless FFmpeg Bot service and fallback endpoints."""
import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.movie_bot import (
    MovieBot,
    create_bot_access_token,
    movie_bot_manager,
    validate_local_path,
)
from tests.conftest import make_room

FIXTURE_PATH = Path(__file__).resolve().parent.parent.parent / "e2e" / "fixtures" / "formats" / "03_mkv_h264_ac3_51.mkv"


def test_validate_local_path(tmp_path: Path):
    # Valid file
    valid_file = tmp_path / "movie.mkv"
    valid_file.write_bytes(b"dummy")
    resolved = validate_local_path(str(valid_file))
    assert resolved == valid_file.resolve()

    # Non-existent file
    with pytest.raises(ValueError, match="File not found"):
        validate_local_path(str(tmp_path / "non_existent.mp4"))

    # Directory
    with pytest.raises(ValueError, match="not a regular file"):
        validate_local_path(str(tmp_path))

    # Invalid extension
    bad_ext = tmp_path / "script.sh"
    bad_ext.write_bytes(b"echo 1")
    with pytest.raises(ValueError, match="Unsupported video extension"):
        validate_local_path(str(bad_ext))


def test_bot_access_token():
    tok = create_bot_access_token("test-room")
    assert isinstance(tok, str)
    assert len(tok) > 20


@pytest.mark.anyio
async def test_movie_bot_lifecycle_mocked_livekit():
    if not FIXTURE_PATH.exists():
        pytest.skip(f"Fixture {FIXTURE_PATH} not found.")

    mock_room = MagicMock()
    mock_room.name = "wt-testroom"
    mock_room.connect = AsyncMock()
    mock_room.disconnect = AsyncMock()
    mock_pub = MagicMock()
    mock_pub.sid = "TR_MOCK"
    mock_room.local_participant = MagicMock()
    mock_room.local_participant.publish_track = AsyncMock(return_value=mock_pub)

    mock_vs = MagicMock()
    mock_vs.capture_frame = MagicMock()

    mock_as = MagicMock()
    mock_as.capture_frame = AsyncMock()

    with patch("livekit.rtc.Room", return_value=mock_room), \
         patch("livekit.rtc.VideoSource", return_value=mock_vs), \
         patch("livekit.rtc.AudioSource", return_value=mock_as), \
         patch("livekit.rtc.LocalVideoTrack.create_video_track", return_value=MagicMock()), \
         patch("livekit.rtc.LocalAudioTrack.create_audio_track", return_value=MagicMock()):

        bot = MovieBot(
            room_id="testroom",
            controller_id="user1",
            file_path=FIXTURE_PATH,
            quality="saver",
            start_position=0.0,
        )

        await bot.start()
        assert bot.playing is True
        assert bot.stopped is False
        assert bot.target_height <= 480
        assert bot.target_fps <= 24
        assert mock_room.connect.called
        assert mock_room.local_participant.publish_track.call_count >= 1

        # Let feeder run briefly
        await asyncio.sleep(0.3)

        # Test pause
        await bot.pause()
        assert bot.playing is False

        # Test resume
        await bot.resume()
        assert bot.playing is True

        # Test seek
        await bot.seek(1.5)
        assert bot.position == 1.5

        # Test skip
        await bot.skip(0.5)
        assert bot.position == 2.0

        # Test stop
        await bot.stop()
        assert bot.stopped is True
        assert bot.playing is False
        assert mock_room.disconnect.called


def test_bot_api_endpoints(client):
    if not FIXTURE_PATH.exists():
        pytest.skip(f"Fixture {FIXTURE_PATH} not found.")

    mock_room = MagicMock()
    mock_room.connect = AsyncMock()
    mock_room.disconnect = AsyncMock()
    mock_room.local_participant = MagicMock()
    mock_room.local_participant.publish_track = AsyncMock()

    mock_vs = MagicMock()
    mock_as = MagicMock()
    mock_as.capture_frame = AsyncMock()

    code, owner = make_room(client)

    with patch("livekit.rtc.Room", return_value=mock_room), \
         patch("livekit.rtc.VideoSource", return_value=mock_vs), \
         patch("livekit.rtc.AudioSource", return_value=mock_as), \
         patch("livekit.rtc.LocalVideoTrack.create_video_track", return_value=MagicMock()), \
         patch("livekit.rtc.LocalAudioTrack.create_audio_track", return_value=MagicMock()):

        # Start bot
        res = client.post(
            "/api/media/bot/start",
            headers={"Authorization": f"Bearer {owner.token}"},
            json={
                "room_id": code,
                "file_path": str(FIXTURE_PATH),
                "quality": "auto",
                "position": 0.0,
            },
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["status"] == "started"
        assert data["room_id"] == code
        assert data["bot_id"] == f"movie-bot-{code}"
        assert data["controller_id"] == owner.id

        # Status
        st_res = client.get(
            f"/api/media/bot/status?room_id={code}",
            headers={"Authorization": f"Bearer {owner.token}"},
        )
        assert st_res.status_code == 200
        st = st_res.json()
        assert st["active"] is True
        assert st["room_id"] == code

        # Command: pause
        cmd_res = client.post(
            "/api/media/bot/command",
            headers={"Authorization": f"Bearer {owner.token}"},
            json={"room_id": code, "action": "pause"},
        )
        assert cmd_res.status_code == 200

        # Command: seek
        seek_res = client.post(
            "/api/media/bot/command",
            headers={"Authorization": f"Bearer {owner.token}"},
            json={"room_id": code, "action": "seek", "position": 2.0},
        )
        assert seek_res.status_code == 200

        # Stop bot
        stop_res = client.post(
            f"/api/media/bot/stop?room_id={code}",
            headers={"Authorization": f"Bearer {owner.token}"},
        )
        assert stop_res.status_code == 200
        assert stop_res.json()["status"] == "stopped"

        # Check status after stop
        st_after = client.get(
            f"/api/media/bot/status?room_id={code}",
            headers={"Authorization": f"Bearer {owner.token}"},
        ).json()
        assert st_after["active"] is False
