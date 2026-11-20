import pytest
import subprocess
from pathlib import Path
from fastapi.testclient import TestClient
from app.main import app
from app.routes.local import validate_file_path, file_registry
from app.database.database import SessionLocal
from app.models.room import Room
from app.models.participant import Participant
from app.core.security import create_session_token
from app.services.media_service import find_ffmpeg

client = TestClient(app)


@pytest.fixture(scope="module")
def sample_video(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("test_picker")
    out = tmp / "test_sample.mkv"
    ffmpeg = find_ffmpeg()
    if ffmpeg:
        subprocess.run(
            [
                ffmpeg,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                str(out),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        out.write_bytes(b"dummy video content")
    return out


@pytest.fixture
def test_room_and_tokens():
    with SessionLocal() as db:
        room = Room(id="PKR123", name="Picker Room", invite_token="inv123")
        db.add(room)
        db.commit()

        # Host (owner)
        host = Participant(
            id="p_host",
            room_id="PKR123",
            client_id="c_host",
            nickname="HostUser",
            role="owner",
            status="active",
        )
        # Viewer (no stream_movie)
        viewer = Participant(
            id="p_viewer",
            room_id="PKR123",
            client_id="c_viewer",
            nickname="ViewerUser",
            role="participant",
            status="active",
        )
        db.add_all([host, viewer])
        db.commit()
        db.refresh(host)
        db.refresh(viewer)

        host_token = create_session_token(host.id, "PKR123")
        viewer_token = create_session_token(viewer.id, "PKR123")

        yield {
            "room_code": "PKR123",
            "host_token": host_token,
            "viewer_token": viewer_token,
            "host_id": host.id,
            "viewer_id": viewer.id,
        }

        # Cleanup
        db.query(Participant).filter(Participant.room_id == "PKR123").delete()
        db.query(Room).filter(Room.id == "PKR123").delete()
        db.commit()


def test_path_validation(sample_video):
    # Valid existing file
    p = sample_video.resolve()
    assert p.exists()
    resolved = validate_file_path(str(p))
    assert resolved == p

    # Non-existent path
    with pytest.raises(Exception) as exc:
        validate_file_path("C:/NonExistent/movie.mkv")
    assert "404" in str(exc.value) or "not found" in str(exc.value).lower()

    # UNC path
    with pytest.raises(Exception) as exc:
        validate_file_path(r"\\server\share\movie.mkv")
    assert "UNC" in str(exc.value)

    # Unsupported extension
    with pytest.raises(Exception) as exc:
        validate_file_path(__file__)
    assert "Unsupported file extension" in str(exc.value)


def test_permission_checks(test_room_and_tokens, sample_video):
    tok_host = test_room_and_tokens["host_token"]
    tok_viewer = test_room_and_tokens["viewer_token"]
    code = test_room_and_tokens["room_code"]

    # Viewer without stream_movie permission cannot browse
    res_viewer = client.get(
        f"/api/local/browse?room_id={code}",
        headers={"Authorization": f"Bearer {tok_viewer}"},
    )
    assert res_viewer.status_code == 403

    # Viewer cannot select a file
    res_select = client.post(
        "/api/local/select-file",
        json={"room_id": code, "path": str(sample_video)},
        headers={"Authorization": f"Bearer {tok_viewer}"},
    )
    assert res_select.status_code == 403

    # Host can browse
    res_host = client.get(
        f"/api/local/browse?room_id={code}&path={sample_video.parent}",
        headers={"Authorization": f"Bearer {tok_host}"},
    )
    assert res_host.status_code == 200
    data = res_host.json()
    assert "files" in data
    assert any(f["name"] == sample_video.name for f in data["files"])
    # Ensure no raw non-media files are exposed
    for f in data["files"]:
        assert any(f["name"].endswith(ext) for ext in [".mp4", ".mkv", ".webm", ".avi", ".mov"])


def test_tunnel_security_rejection(test_room_and_tokens):
    tok_host = test_room_and_tokens["host_token"]
    code = test_room_and_tokens["room_code"]

    # Request carrying external Cloudflare Connecting IP must be rejected
    res_cf = client.get(
        f"/api/local/browse?room_id={code}",
        headers={
            "Authorization": f"Bearer {tok_host}",
            "CF-Connecting-IP": "198.51.100.24",
        },
    )
    assert res_cf.status_code == 403
    assert "tunnel" in res_cf.json()["detail"].lower()

    # Request carrying external X-Forwarded-For must be rejected
    res_xff = client.get(
        f"/api/local/browse?room_id={code}",
        headers={
            "Authorization": f"Bearer {tok_host}",
            "X-Forwarded-For": "203.0.113.195",
        },
    )
    assert res_xff.status_code == 403
    assert "proxies" in res_xff.json()["detail"].lower()


def test_select_file_and_opaque_id(test_room_and_tokens, sample_video):
    tok_host = test_room_and_tokens["host_token"]
    code = test_room_and_tokens["room_code"]
    p = str(sample_video.resolve())

    res = client.post(
        "/api/local/select-file",
        json={"room_id": code, "path": p},
        headers={"Authorization": f"Bearer {tok_host}"},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "selected"
    assert "file_id" in data
    assert data["filename"] == sample_video.name
    assert data["duration"] > 0
    assert "probe" in data

    file_id = data["file_id"]
    reg = file_registry.get(file_id)
    assert reg is not None
    assert str(reg.path) == p
