import subprocess
import time
from pathlib import Path

from app.services.media_service import (
    _parse_ffmpeg_i,
    choose_conversion_plan,
    detect_hw_encoder,
    find_ffmpeg,
    media_service,
)
from tests.conftest import join, make_room


def _make_sample(tmp_path: Path, name: str, args: list[str]) -> Path:
    ffmpeg = find_ffmpeg()
    assert ffmpeg, "ffmpeg missing in test env"
    out = tmp_path / name
    subprocess.run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", *args, str(out)], check=True)
    return out


def _upload_and_run(client, code: str, token: str, file_path: Path, audio_index=None, subtitle_index=None):
    data = file_path.read_bytes()
    hdr = {"Authorization": f"Bearer {token}"}
    cr = client.post("/api/media/jobs", json={"room_id": code, "filename": file_path.name, "size": len(data)}, headers=hdr)
    assert cr.status_code == 200, cr.text
    job_id = cr.json()["job_id"]

    up = client.post(f"/api/media/jobs/{job_id}/chunk", content=data, headers=hdr)
    assert up.status_code == 200, up.text
    assert up.json()["received_bytes"] == len(data)

    pr = client.post(f"/api/media/jobs/{job_id}/probe", headers=hdr)
    assert pr.status_code == 200, pr.text
    probe = pr.json()

    st = client.post(
        f"/api/media/jobs/{job_id}/start",
        json={"audio_index": audio_index, "subtitle_index": subtitle_index},
        headers=hdr,
    )
    assert st.status_code == 200, st.text

    for _ in range(80):
        js = client.get(f"/api/media/jobs/{job_id}", headers=hdr).json()
        if js["status"] in ("ready", "error"):
            break
        time.sleep(0.1)
    return job_id, probe, js


def test_media_capabilities(client):
    r = client.get("/api/media/capabilities")
    assert r.status_code == 200
    body = r.json()
    assert body["ffmpeg_available"] is True
    assert body["available"] is True


def test_media_mkv_h264_ac3_copy_video_transcode_audio_and_range(client, tmp_path):
    code, owner = make_room(client)
    viewer = join(client, code, "Viewer")

    # Viewer without stream_movie permission is forbidden
    r_deny = client.post(
        "/api/media/jobs",
        json={"room_id": code, "filename": "a.mkv", "size": 100},
        headers={"Authorization": f"Bearer {viewer.token}"},
    )
    assert r_deny.status_code == 403

    mkv = _make_sample(
        tmp_path,
        "clip_ac3.mkv",
        [
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "ac3", "-ac", "6", "-b:a", "192k",
        ],
    )
    job_id, probe, js = _upload_and_run(client, code, owner.token, mkv)
    assert probe["has_audio"] is True
    assert probe["recommended_plan"] == "audio_transcode"
    assert probe["audio"][0]["codec"] == "ac3"
    assert probe["audio"][0]["channels"] == 6
    assert js["status"] == "ready", js
    assert js["plan"] == "audio_transcode"
    assert js["encoder"] == "copy"
    assert js["video_action"] == "copy"
    assert js["audio_action"] == "transcode"
    assert js["can_play"] is True
    assert js["segment_count"] >= 1
    assert js["converted_sec"] >= 1.5

    pl = client.get(js["stream_url"])
    assert pl.status_code == 200
    assert "#EXTM3U" in pl.text
    assert "init.mp4" in pl.text
    assert "seg_00000.m4s" in pl.text

    # HTTP Range request (206 Partial Content) works on HLS fMP4 segments
    rng = client.get(
        f"/api/media/jobs/{job_id}/hls/seg_00000.m4s",
        headers={"Authorization": f"Bearer {owner.token}", "Range": "bytes=0-511"},
    )
    assert rng.status_code == 206
    assert len(rng.content) == 512
    assert rng.headers["accept-ranges"] == "bytes"

    # Reject arbitrary HLS filenames
    bad = client.get(
        f"/api/media/jobs/{job_id}/hls/input.mkv",
        headers={"Authorization": f"Bearer {owner.token}"},
    )
    assert bad.status_code == 400

    # Cleanup deletes temp directory
    job_dir = media_service.get_job(job_id).dir_path
    assert job_dir.exists()
    dl = client.delete(f"/api/media/jobs/{job_id}", headers={"Authorization": f"Bearer {owner.token}"})
    assert dl.status_code == 200
    assert not job_dir.exists()


def test_media_remux_only_vp9_opus_and_plan_selection(client, tmp_path):
    assert choose_conversion_plan({
        "video": [{"index": 0, "codec": "vp9", "pix_fmt": "yuv420p"}],
        "audio": [{"index": 1, "codec": "opus", "channels": 2}],
        "subtitles": [],
    })["plan"] == "remux"
    assert choose_conversion_plan({
        "video": [{"index": 0, "codec": "av1", "pix_fmt": "yuv420p"}],
        "audio": [{"index": 1, "codec": "eac3", "channels": 6}],
        "subtitles": [],
    })["plan"] == "audio_transcode"
    assert choose_conversion_plan({
        "video": [{"index": 0, "codec": "hevc", "pix_fmt": "yuv420p"}],
        "audio": [{"index": 1, "codec": "aac", "channels": 2}],
        "subtitles": [],
    })["plan"] == "full_transcode"
    assert choose_conversion_plan({
        "video": [{"index": 0, "codec": "h264", "pix_fmt": "yuv420p"}],
        "audio": [{"index": 1, "codec": "aac", "channels": 2}],
        "subtitles": [{"index": 2, "codec": "subrip", "text_burnable": True}],
    }, subtitle_index=2)["plan"] == "full_transcode"

    code, owner = make_room(client)
    mkv = _make_sample(
        tmp_path,
        "remux_only.mkv",
        [
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ac", "2", "-b:a", "96k",
        ],
    )
    job_id, probe, js = _upload_and_run(client, code, owner.token, mkv)
    assert probe["recommended_plan"] == "remux"
    assert js["status"] == "ready"
    assert js["plan"] == "remux"
    assert js["encoder"] == "copy"
    assert js["video_action"] == "copy"
    assert js["audio_action"] == "copy"
    hw = detect_hw_encoder(force_refresh=True)
    assert hw in (None, "h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox")
    media_service.cleanup_job(job_id)


def test_media_no_audio_warning(client, tmp_path):
    code, owner = make_room(client)
    silent = _make_sample(
        tmp_path,
        "silent.mkv",
        [
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=1",
            "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        ],
    )
    job_id, probe, js = _upload_and_run(client, code, owner.token, silent)
    assert probe["has_audio"] is False
    assert any("no audio" in w.lower() for w in probe["warnings"])
    assert js["status"] == "ready"
    assert js["audio_action"] == "none"
    media_service.cleanup_job(job_id)


def test_parse_ffmpeg_i_bracket_ids_and_metadata():
    sample = """
Input #0, matroska,webm, from 'movie.mkv':
  Duration: 00:01:30.50, start: 0.000000, bitrate: 1500 kb/s
  Stream #0:0[0x1](und): Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 23.98 fps, 24 tbr
  Stream #0:1[0x2](eng): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s (default)
    Metadata:
      title           : Surround 5.1
  Stream #0:2[0x3](jpn): Audio: aac (LC), 48000 Hz, stereo, fltp
  Stream #0:3(eng): Subtitle: subrip (default)
"""
    parsed = _parse_ffmpeg_i(sample)
    assert abs(parsed["duration"] - 90.5) < 0.01
    assert len(parsed["video"]) == 1
    assert parsed["video"][0]["codec"] == "h264"
    assert parsed["video"][0]["width"] == 1920
    assert parsed["video"][0]["height"] == 1080
    assert abs(parsed["video"][0]["fps"] - 23.98) < 0.01
    assert len(parsed["audio"]) == 2
    assert parsed["audio"][0]["index"] == 1
    assert parsed["audio"][0]["language"] == "eng"
    assert parsed["audio"][0]["codec"] == "ac3"
    assert parsed["audio"][0]["channels"] == 6
    assert parsed["audio"][0]["title"] == "Surround 5.1"
    assert parsed["audio"][1]["index"] == 2
    assert parsed["audio"][1]["language"] == "jpn"
    assert parsed["audio"][1]["codec"] == "aac"
    assert parsed["audio"][1]["channels"] == 2
    assert len(parsed["subtitles"]) == 1
    assert parsed["subtitles"][0]["text_burnable"] is True
