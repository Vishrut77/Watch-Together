"""Local media companion endpoints for Tier 1 transcoding / remuxing (localhost only)."""
from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import participant_from_token
from app.database.database import get_db
from app.services import permission_service as perms, room_service
from app.services.media_service import detect_hw_encoder, inspect_hls_output, media_service, probe_file
from app.services.movie_bot import movie_bot_manager, validate_local_path
from app.services.realtime import hub

router = APIRouter(prefix="/api/media", tags=["media"])

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient", "testserver"}
CHUNK_SIZE = 4 * 1024 * 1024  # 4 MiB chunks


def _is_local_request(request: Request) -> bool:
    if settings.app_env == "test":
        return True
    host_hdr = (request.headers.get("host") or "").split(":", 1)[0].strip("[]").lower()
    client_host = (request.client.host if request.client else "").strip("[]").lower()
    if host_hdr and host_hdr not in _LOCAL_HOSTS:
        return False
    if client_host and client_host not in _LOCAL_HOSTS and not client_host.startswith("::ffff:127.0.0.1"):
        return False
    return True


def _extract_token(request: Request, token_q: str | None) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (token_q or "").strip()


def _require_local_streamer(request: Request, db: Session, room_id: str, token: str):
    if not _is_local_request(request):
        raise HTTPException(
            status_code=403,
            detail="Local media transcoding is only available when running WatchTogether on localhost.",
        )
    if not media_service.is_available():
        raise HTTPException(status_code=503, detail="ffmpeg is not installed on this machine.")
    code = room_service.normalize_code(room_id)
    p = participant_from_token(db, token, code)
    if p.status != "active" or not perms.has_permission(p, "stream_movie"):
        raise HTTPException(status_code=403, detail="You don't have permission to prepare a movie here.")
    return code, p


def _require_job_owner(request: Request, db: Session, job_id: str, token: str):
    if not _is_local_request(request):
        raise HTTPException(status_code=403, detail="Local media transcoding requires localhost.")
    job = media_service.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Media job not found.")
    p = participant_from_token(db, token, job.room_id)
    if p.id != job.owner_id or p.status != "active":
        raise HTTPException(status_code=403, detail="Forbidden.")
    return job


class CreateJobIn(BaseModel):
    room_id: str = Field(..., min_length=1, max_length=20)
    filename: str = Field(..., min_length=1, max_length=200)
    size: int = Field(..., ge=1, le=20 * 1024 * 1024 * 1024)
    token: Optional[str] = None


class StartJobIn(BaseModel):
    token: Optional[str] = None
    audio_index: Optional[int] = None
    subtitle_index: Optional[int] = None


def capabilities_local(request: Request) -> bool:
    return bool(_is_local_request(request) and media_service.is_available())


@router.get("/capabilities")
async def capabilities(request: Request):
    is_local = _is_local_request(request)
    available = media_service.is_available()
    hw = await asyncio.to_thread(detect_hw_encoder) if (is_local and available) else None
    return {
        "local_only": True,
        "is_local_request": is_local,
        "ffmpeg_available": available,
        "available": bool(is_local and available),
        "hw_encoder": hw,
    }


@router.post("/jobs")
async def create_job(body: CreateJobIn, request: Request, db: Session = Depends(get_db)):
    token = _extract_token(request, body.token)
    room_id, p = _require_local_streamer(request, db, body.room_id, token)
    job = media_service.create_job(room_id, p.id, body.filename, body.size)
    return {"job_id": job.job_id, "chunk_size": CHUNK_SIZE}


@router.post("/jobs/{job_id}/chunk")
async def append_chunk(
    job_id: str,
    request: Request,
    token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    tok = _extract_token(request, token)
    job = _require_job_owner(request, db, job_id, tok)
    if job.cancelled:
        raise HTTPException(status_code=409, detail="Job cancelled.")
    written = 0
    with open(job.input_path, "ab") as fh:
        async for chunk in request.stream():
            if not chunk:
                continue
            fh.write(chunk)
            written += len(chunk)
            job.received_bytes += len(chunk)
    return {"received_bytes": job.received_bytes, "written": written}


@router.post("/jobs/{job_id}/probe")
async def probe_job(
    job_id: str,
    request: Request,
    token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    tok = _extract_token(request, token)
    job = _require_job_owner(request, db, job_id, tok)
    if not job.input_path.exists():
        raise HTTPException(status_code=400, detail="File has not been uploaded yet.")
    try:
        info = await asyncio.to_thread(probe_file, job.input_path)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Could not inspect file: {exc}")
    job.probe = info
    job.status = "probed"
    return info


@router.post("/jobs/{job_id}/start")
async def start_job(
    job_id: str,
    body: StartJobIn,
    request: Request,
    db: Session = Depends(get_db),
):
    tok = _extract_token(request, body.token)
    job = _require_job_owner(request, db, job_id, tok)
    if not job.input_path.exists():
        raise HTTPException(status_code=400, detail="Input file missing.")
    await media_service.start_transcode(job, audio_index=body.audio_index, subtitle_index=body.subtitle_index)
    return {"job_id": job.job_id, "status": job.status}


@router.get("/jobs/{job_id}")
async def job_status(
    job_id: str,
    request: Request,
    token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    tok = _extract_token(request, token)
    job = _require_job_owner(request, db, job_id, tok)
    converted_sec, seg_count, can_play = inspect_hls_output(job)
    dur_sec = float(job.probe.get("duration") or 0.0) if job.probe else 0.0
    elapsed = None
    if job.started_at is not None:
        end_t = job.finished_at if job.finished_at is not None else time.monotonic()
        elapsed = max(0.0, end_t - job.started_at)
    return {
        "job_id": job.job_id,
        "status": job.status,
        "progress": round(job.progress, 1),
        "plan": job.plan,
        "encoder": job.encoder,
        "video_action": job.video_action,
        "audio_action": job.audio_action,
        "speed_x": round(job.speed_x, 2) if job.speed_x else None,
        "eta_sec": round(job.eta_sec, 1) if job.eta_sec is not None else None,
        "elapsed_sec": round(elapsed, 2) if elapsed is not None else None,
        "converted_sec": round(converted_sec, 2),
        "duration_sec": round(dur_sec, 2),
        "segment_count": seg_count,
        "can_play": can_play,
        "has_audio": job.probe.get("has_audio") if job.probe else None,
        "warnings": job.probe.get("warnings") if job.probe else [],
        "error": job.error,
        "stream_url": (
            f"/api/media/jobs/{job.job_id}/hls/playlist.m3u8?token={tok}"
            if (can_play and tok)
            else (f"/api/media/jobs/{job.job_id}/hls/playlist.m3u8" if can_play else None)
        ),
    }


_HLS_FILE_RE = re.compile(r"^(playlist\.m3u8|init\.mp4|seg_\d{5}\.m4s)$")


@router.get("/jobs/{job_id}/hls/{filename}")
async def hls_asset(
    job_id: str,
    filename: str,
    request: Request,
    token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    tok = _extract_token(request, token)
    job = _require_job_owner(request, db, job_id, tok)
    if not _HLS_FILE_RE.match(filename):
        raise HTTPException(status_code=400, detail="Invalid HLS asset filename.")
    target = job.hls_dir / filename
    if not target.exists():
        raise HTTPException(status_code=404, detail="Segment not ready yet.")
    if filename == "playlist.m3u8":
        text = target.read_text(encoding="utf-8", errors="replace")
        if token:
            lines = []
            for raw in text.splitlines():
                if raw.startswith('#EXT-X-MAP:URI="init.mp4"'):
                    lines.append(f'#EXT-X-MAP:URI="init.mp4?token={tok}"')
                elif raw and not raw.startswith("#"):
                    lines.append(f"{raw}?token={tok}")
                else:
                    lines.append(raw)
            text = "\n".join(lines) + "\n"
        return Response(
            content=text,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )
    return _range_mp4_response(target, request, media_type="video/iso.segment" if filename.endswith(".m4s") else "video/mp4")


def _range_mp4_response(file_path: Path, request: Request, media_type: str = "video/mp4") -> Response:
    size = file_path.stat().st_size
    range_hdr = request.headers.get("range")
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}

    if not range_hdr or not range_hdr.startswith("bytes="):
        def _iter_all():
            with open(file_path, "rb") as f:
                while data := f.read(256 * 1024):
                    yield data

        return StreamingResponse(
            _iter_all(),
            status_code=200,
            media_type=media_type,
            headers={**headers, "Content-Length": str(size)},
        )

    spec = range_hdr[6:].split(",", 1)[0].strip()
    start_s, _, end_s = spec.partition("-")
    try:
        if start_s == "":
            suffix = int(end_s)
            start = max(0, size - suffix)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        raise HTTPException(status_code=416, detail="Invalid Range header.")

    if start < 0 or start >= size or end < start:
        raise HTTPException(status_code=416, detail="Requested range not satisfiable.")
    end = min(end, size - 1)
    length = end - start + 1

    def _iter_slice():
        with open(file_path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        _iter_slice(),
        status_code=206,
        media_type=media_type,
        headers={
            **headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(length),
        },
    )


@router.delete("/jobs/{job_id}")
async def cancel_or_delete_job(
    job_id: str,
    request: Request,
    token: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
):
    tok = _extract_token(request, token)
    job = _require_job_owner(request, db, job_id, tok)
    media_service.cleanup_job(job.job_id)
    return {"deleted": True}


class StartBotIn(BaseModel):
    room_id: str = Field(..., min_length=1, max_length=20)
    file_id: Optional[str] = None
    file_path: Optional[str] = None
    job_id: Optional[str] = None
    token: Optional[str] = None
    quality: Optional[str] = "auto"
    position: Optional[float] = 0.0
    audio_index: Optional[int] = None
    subtitle_index: Optional[int] = None
    subtitle_file_id: Optional[str] = None


class BotCommandIn(BaseModel):
    room_id: str = Field(..., min_length=1, max_length=20)
    action: str = Field(..., pattern="^(play|pause|seek|skip|audio_track|subtitle_track)$")
    position: Optional[float] = None
    delta: Optional[float] = None
    track_index: Optional[int] = None
    audio_index: Optional[int] = None
    subtitle_file_id: Optional[str] = None
    token: Optional[str] = None


@router.post("/bot/start")
async def start_movie_bot(
    body: StartBotIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Start headless FFmpeg bot for local fallback streaming (localhost only)."""
    tok = _extract_token(request, body.token)
    room_id, p = _require_local_streamer(request, db, body.room_id, tok)

    target_file: Optional[Path] = None
    temp_to_clean: Optional[Path] = None
    target_sub_path: Optional[Path] = None

    if body.file_id:
        from app.routes.local import file_registry
        reg = file_registry.get(body.file_id)
        if not reg or not reg.path.exists():
            raise HTTPException(status_code=404, detail="Selected file not found or expired.")
        target_file = reg.path
    elif body.file_path:
        try:
            target_file = validate_local_path(body.file_path)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    elif body.job_id:
        job = media_service.get_job(body.job_id)
        if not job or not job.input_path.exists():
            raise HTTPException(status_code=404, detail="Uploaded file not found.")
        if job.owner_id != p.id:
            raise HTTPException(status_code=403, detail="Forbidden.")
        target_file = job.input_path
        temp_to_clean = job.input_path
    else:
        raise HTTPException(status_code=400, detail="Either file_id, file_path, or job_id must be provided.")

    if body.subtitle_file_id:
        from app.routes.local import file_registry
        s_reg = file_registry.get(body.subtitle_file_id)
        if s_reg and s_reg.path.exists():
            target_sub_path = s_reg.path

    try:
        bot = await movie_bot_manager.start_bot(
            room_id=room_id,
            controller_id=p.id,
            file_path=target_file,
            quality=body.quality or "auto",
            start_position=body.position or 0.0,
            temp_file_to_clean=temp_to_clean,
            audio_index=body.audio_index,
            subtitle_index=body.subtitle_index,
            subtitle_path=target_sub_path,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to start movie bot: {exc}")

    return {
        "status": "started",
        "room_id": room_id,
        "bot_id": f"movie-bot-{room_id}",
        "controller_id": p.id,
        "title": bot.title,
        "duration": bot.duration,
        "quality": bot.quality_name,
        "width": bot.target_width,
        "height": bot.target_height,
        "fps": bot.target_fps,
        "audio_tracks": bot.probe_info.get("audio", []),
        "subtitle_tracks": bot.probe_info.get("subtitles", []),
    }


@router.post("/bot/stop")
async def stop_movie_bot(
    room_id: str = Query(..., min_length=1, max_length=20),
    token: Optional[str] = Query(default=None),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """Stop headless bot. Caller must be controller or room owner."""
    tok = _extract_token(request, token)
    code = room_service.normalize_code(room_id)
    p = participant_from_token(db, tok, code)
    if not (movie_bot_manager.is_controller(code, p.id) or perms.is_owner(p)):
        raise HTTPException(status_code=403, detail="Only the host or owner can stop the bot.")

    await movie_bot_manager.stop_bot(code)
    await hub.stop_movie(code, notice="The movie was stopped.")
    return {"status": "stopped", "room_id": code}


@router.post("/bot/command")
async def bot_command(
    body: BotCommandIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Control headless bot (play, pause, seek, skip)."""
    tok = _extract_token(request, body.token)
    code = room_service.normalize_code(body.room_id)
    p = participant_from_token(db, tok, code)
    if not perms.has_permission(p, "manage_playback") and not movie_bot_manager.is_controller(code, p.id) and not perms.is_owner(p):
        raise HTTPException(status_code=403, detail="Permission denied.")

    sub_path = None
    if body.subtitle_file_id:
        from app.routes.local import file_registry
        s_reg = file_registry.get(body.subtitle_file_id)
        if s_reg and s_reg.path.exists():
            sub_path = s_reg.path

    t_idx = body.track_index if body.track_index is not None else body.audio_index
    await movie_bot_manager.handle_command(
        room_id=code,
        action=body.action,
        position=body.position,
        delta=body.delta,
        track_index=t_idx,
        subtitle_path=sub_path,
    )
    return {"status": "ok", "action": body.action}


@router.get("/bot/status")
async def bot_status(
    room_id: str = Query(..., min_length=1, max_length=20),
    token: Optional[str] = Query(default=None),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """Get status and stats from running bot."""
    tok = _extract_token(request, token)
    code = room_service.normalize_code(room_id)
    p = participant_from_token(db, tok, code)
    bot = movie_bot_manager.get_bot(code)
    if not bot:
        return {"active": False, "room_id": code}
    st = bot.get_status()
    st["active"] = True
    return st
