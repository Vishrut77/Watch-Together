"""Local media companion service (Tier 1 ffmpeg probe, remux, and smart transcode).

Used ONLY when running locally (or explicitly allowed) for files whose container/codecs
cannot be decoded directly by the host's browser (e.g., MKV/HEVC/AC3/EAC3/DTS/AVI).
Temporary files live under system temp and are cleaned up on cancel, room close, stop, or restart.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("watchtogether.media")

MEDIA_ROOT = Path(tempfile.gettempdir()) / "watchtogether_media"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024  # 20 GiB safety ceiling

_BROWSER_VIDEO_COPY = {"h264", "vp9", "av1"}
_BROWSER_AUDIO_COPY = {"aac", "opus"}
_TEXT_SUB_CODECS = {"subrip", "srt", "ass", "ssa", "mov_text", "webvtt", "text"}

_ffmpeg_cache: str | None = None
_ffprobe_cache: str | None = None
_hw_encoder_cache: str | None = None
_hw_probed = False


def find_ffmpeg() -> str | None:
    global _ffmpeg_cache
    if _ffmpeg_cache and Path(_ffmpeg_cache).exists():
        return _ffmpeg_cache
    exe = shutil.which("ffmpeg")
    if not exe:
        try:
            import imageio_ffmpeg  # type: ignore

            exe = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:
            exe = None
    _ffmpeg_cache = exe
    return exe


def find_ffprobe() -> str | None:
    global _ffprobe_cache
    if _ffprobe_cache and Path(_ffprobe_cache).exists():
        return _ffprobe_cache
    _ffprobe_cache = shutil.which("ffprobe")
    return _ffprobe_cache


def detect_hw_encoder(force_refresh: bool = False) -> str | None:
    """Return the fastest working H.264 encoder ('h264_nvenc', etc.) or None (libx264 fallback)."""
    global _hw_encoder_cache, _hw_probed
    if _hw_probed and not force_refresh:
        return _hw_encoder_cache
    _hw_probed = True
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        _hw_encoder_cache = None
        return None
    for enc in ("h264_nvenc", "h264_qsv", "h264_amf", "h264_videotoolbox"):
        try:
            res = subprocess.run(
                [
                    ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=256x144:rate=24:d=1",
                    "-t", "1", "-c:v", enc, "-f", "null", "-",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
            )
            if res.returncode == 0:
                _hw_encoder_cache = enc
                log.info("Detected hardware H.264 encoder: %s", enc)
                return enc
        except Exception:
            continue
    _hw_encoder_cache = None
    return None


def _parse_channels(details: str) -> int:
    low = details.lower()
    if "7.1" in low:
        return 8
    if "5.1" in low or "5.0" in low:
        return 6
    if "quad" in low or "4.0" in low:
        return 4
    if "stereo" in low:
        return 2
    if "mono" in low:
        return 1
    m = re.search(r"(\d+)\s+channels?", low)
    return int(m.group(1)) if m else 2


def _parse_ffmpeg_i(stderr: str) -> dict[str, Any]:
    """Fallback parser when standalone ffprobe is unavailable (e.g., imageio-ffmpeg bundles)."""
    duration = 0.0
    dm = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", stderr)
    if dm:
        duration = int(dm.group(1)) * 3600 + int(dm.group(2)) * 60 + float(dm.group(3))

    video: list[dict[str, Any]] = []
    audio: list[dict[str, Any]] = []
    subtitles: list[dict[str, Any]] = []
    last_stream: dict[str, Any] | None = None

    for raw_line in stderr.splitlines():
        line = raw_line.rstrip()
        sm = re.match(
            r"^\s*Stream #0:(\d+)(?:\[[^\]]+\]|\(([^)]+)\))*"
            r":\s*(Video|Audio|Subtitle):\s*(.+)$",
            line,
        )
        if sm:
            idx = int(sm.group(1))
            prefix = line.split(": Video:", 1)[0].split(": Audio:", 1)[0].split(": Subtitle:", 1)[0]
            lm = re.search(r"\(([^)]+)\)", prefix)
            lang = lm.group(1).strip() if lm else "und"
            kind = sm.group(3)
            rest = sm.group(4)
            parts = [p.strip() for p in rest.split(",")]
            codec = parts[0].split(" ")[0].lower() if parts else "unknown"
            # Strip trailing wrapper descriptions like h264 (High) -> h264
            codec = re.sub(r"[^a-z0-9_]+$", "", codec)

            if kind == "Video":
                pix_fmt = parts[1].split(" ")[0].lower() if len(parts) > 1 else ""
                wh = re.search(r"\b(\d{2,5})x(\d{2,5})\b", rest)
                fpsm = re.search(r"([\d.]+)\s*(?:fps|tbr)", rest)
                item = {
                    "index": idx,
                    "ordinal": len(video),
                    "codec": codec,
                    "pix_fmt": pix_fmt,
                    "width": int(wh.group(1)) if wh else 0,
                    "height": int(wh.group(2)) if wh else 0,
                    "fps": float(fpsm.group(1)) if fpsm else 0.0,
                }
                video.append(item)
                last_stream = item
            elif kind == "Audio":
                is_def = "(default)" in line.lower()
                item = {
                    "index": idx,
                    "ordinal": len(audio),
                    "codec": codec,
                    "channels": _parse_channels(rest),
                    "language": lang,
                    "title": "",
                    "default": is_def,
                }
                audio.append(item)
                last_stream = item
            elif kind == "Subtitle":
                is_def = "(default)" in line.lower()
                item = {
                    "index": idx,
                    "ordinal": len(subtitles),
                    "codec": codec,
                    "language": lang,
                    "title": "",
                    "default": is_def,
                    "text_burnable": codec in _TEXT_SUB_CODECS,
                }
                subtitles.append(item)
                last_stream = item
            continue

        if last_stream is not None:
            if re.match(r"^\s*Metadata:\s*$", line):
                continue
            tm = re.match(r"^\s{6,}title\s*:\s*(.+)$", line, re.IGNORECASE)
            if tm and "title" in last_stream and not last_stream["title"]:
                last_stream["title"] = tm.group(1).strip()
            elif not line.startswith("      "):
                last_stream = None

    return _finalize_probe(duration, video, audio, subtitles)


def _is_copyable_video(v: dict[str, Any]) -> bool:
    if (v.get("codec") or "") not in _BROWSER_VIDEO_COPY:
        return False
    pix = (v.get("pix_fmt") or "").lower()
    if any(bad in pix for bad in ("10", "12", "16", "p010", "422", "444")):
        return False
    return True


def _is_copyable_audio(a: dict[str, Any]) -> bool:
    return (a.get("codec") or "") in _BROWSER_AUDIO_COPY and int(a.get("channels") or 2) <= 2


def choose_conversion_plan(
    probe: dict[str, Any],
    audio_index: int | None = None,
    subtitle_index: int | None = None,
) -> dict[str, Any]:
    """Select the fastest compatible plan: remux -> audio_transcode -> full_transcode."""
    videos = probe.get("video") or []
    audios = probe.get("audio") or []
    subs = probe.get("subtitles") or []
    v0 = videos[0] if videos else {}

    sel_audio = None
    if audios and audio_index != -1:
        if audio_index is not None:
            sel_audio = next((a for a in audios if a["index"] == audio_index), None)
            if sel_audio is None and 0 <= audio_index < len(audios):
                sel_audio = audios[audio_index]
        if sel_audio is None:
            sel_audio = audios[0]

    has_sub_burn = False
    if subtitle_index is not None and subtitle_index >= 0 and subs:
        sel_sub = next((s for s in subs if s["index"] == subtitle_index), None)
        if sel_sub is None and 0 <= subtitle_index < len(subs):
            sel_sub = subs[subtitle_index]
        has_sub_burn = bool(sel_sub and sel_sub.get("text_burnable"))

    copy_video = bool(videos) and _is_copyable_video(v0) and not has_sub_burn
    if not sel_audio:
        audio_action = "none"
    elif _is_copyable_audio(sel_audio):
        audio_action = "copy"
    else:
        audio_action = "transcode"

    if copy_video and audio_action in ("copy", "none"):
        plan = "remux"
    elif copy_video:
        plan = "audio_transcode"
    else:
        plan = "full_transcode"

    return {
        "plan": plan,
        "copy_video": copy_video,
        "video_action": "copy" if copy_video else "encode",
        "audio_action": audio_action,
        "selected_audio_index": sel_audio["index"] if sel_audio else None,
        "has_sub_burn": has_sub_burn,
    }


def _finalize_probe(duration: float, video: list[dict], audio: list[dict], subtitles: list[dict]) -> dict[str, Any]:
    warnings: list[str] = []
    if not video:
        warnings.append("No video track was found in this file.")
    if not audio:
        warnings.append("This file has no audio track — viewers will see video only.")
    info = {
        "duration": round(duration, 3),
        "video": video,
        "audio": audio,
        "subtitles": subtitles,
        "has_audio": len(audio) > 0,
        "warnings": warnings,
    }
    if video:
        info["recommended_plan"] = choose_conversion_plan(info)["plan"]
    else:
        info["recommended_plan"] = None
    return info


def probe_file(input_path: Path) -> dict[str, Any]:
    """Probe container duration and streams via ffprobe or ffmpeg -i fallback."""
    ffprobe = find_ffprobe()
    if ffprobe:
        try:
            res = subprocess.run(
                [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(input_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
            if res.returncode == 0 and res.stdout.strip():
                data = json.loads(res.stdout)
                duration = float((data.get("format") or {}).get("duration") or 0.0)
                video, audio, subtitles = [], [], []
                for s in data.get("streams") or []:
                    stype = s.get("codec_type")
                    codec = (s.get("codec_name") or "unknown").lower()
                    tags = s.get("tags") or {}
                    lang = str(tags.get("language") or "und")
                    title = str(tags.get("title") or "")
                    idx = int(s.get("index", 0))
                    if stype == "video" and (s.get("disposition") or {}).get("attached_pic", 0) == 0:
                        r_fps = str(s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1")
                        fps = 0.0
                        if "/" in r_fps:
                            num, den = r_fps.split("/", 1)
                            if float(den) > 0:
                                fps = round(float(num) / float(den), 3)
                        video.append({
                            "index": idx,
                            "ordinal": len(video),
                            "codec": codec,
                            "pix_fmt": str(s.get("pix_fmt") or ""),
                            "width": int(s.get("width") or 0),
                            "height": int(s.get("height") or 0),
                            "fps": fps,
                        })
                    elif stype == "audio":
                        is_def = bool((s.get("disposition") or {}).get("default", 0))
                        audio.append({
                            "index": idx,
                            "ordinal": len(audio),
                            "codec": codec,
                            "channels": int(s.get("channels") or 2),
                            "language": lang,
                            "title": title,
                            "default": is_def,
                        })
                    elif stype == "subtitle":
                        is_def = bool((s.get("disposition") or {}).get("default", 0))
                        subtitles.append({
                            "index": idx,
                            "ordinal": len(subtitles),
                            "codec": codec,
                            "language": lang,
                            "title": title,
                            "default": is_def,
                            "text_burnable": codec in _TEXT_SUB_CODECS,
                        })
                return _finalize_probe(duration, video, audio, subtitles)
        except Exception as exc:
            log.debug("ffprobe failed, falling back to ffmpeg -i: %s", exc)

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed on this machine.")
    res = subprocess.run(
        [ffmpeg, "-hide_banner", "-i", str(input_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
    )
    return _parse_ffmpeg_i(res.stderr or "")


def inspect_hls_output(job: "MediaJob") -> tuple[float, int, bool]:
    """Return (converted_sec, segment_count, can_play) from completed HLS segments on disk."""
    playlist = job.playlist_path
    if not playlist.exists():
        return (0.0, 0, False)
    try:
        text = playlist.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return (0.0, 0, False)

    has_init = (job.hls_dir / "init.mp4").exists()
    total_sec = 0.0
    seg_count = 0
    pending_dur: float | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#EXTINF:"):
            try:
                pending_dur = float(line[8:].split(",", 1)[0])
            except ValueError:
                pending_dur = 0.0
        elif line and not line.startswith("#"):
            if (job.hls_dir / line).exists():
                seg_count += 1
                total_sec += pending_dur or 0.0
            pending_dur = None

    if job.status == "ready" and job.probe:
        total_sec = max(total_sec, float(job.probe.get("duration") or 0.0))
    can_play = has_init and seg_count > 0 and (job.status == "ready" or seg_count >= 2)
    return (total_sec, seg_count, can_play)


@dataclass
class MediaJob:
    job_id: str
    room_id: str
    owner_id: str
    filename: str
    expected_size: int
    dir_path: Path
    input_path: Path
    hls_dir: Path
    playlist_path: Path
    status: str = "uploading"  # uploading | probed | processing | ready | error | cancelled
    received_bytes: int = 0
    progress: float = 0.0
    plan: str | None = None  # remux | audio_transcode | full_transcode
    encoder: str | None = None
    video_action: str | None = None
    audio_action: str | None = None
    speed_x: float | None = None
    eta_sec: float | None = None
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    process: subprocess.Popen | None = field(default=None, repr=False)
    task: asyncio.Task | None = field(default=None, repr=False)
    cancelled: bool = False


class MediaService:
    def __init__(self) -> None:
        self.jobs: dict[str, MediaJob] = {}
        self._lock = asyncio.Lock()

    def is_available(self) -> bool:
        return bool(find_ffmpeg())

    def ensure_root(self) -> None:
        MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

    def create_job(self, room_id: str, owner_id: str, filename: str, expected_size: int) -> MediaJob:
        if expected_size < 0 or expected_size > MAX_UPLOAD_BYTES:
            raise ValueError("File size is out of supported range.")
        self.ensure_root()
        job_id = secrets.token_urlsafe(12)
        safe_ext = Path(filename or "movie.bin").suffix[:12]
        if not re.match(r"^\.[a-zA-Z0-9]+$", safe_ext):
            safe_ext = ".bin"
        job_dir = MEDIA_ROOT / f"{room_id}_{job_id}"
        hls_dir = job_dir / "hls"
        hls_dir.mkdir(parents=True, exist_ok=True)
        job = MediaJob(
            job_id=job_id,
            room_id=room_id,
            owner_id=owner_id,
            filename=Path(filename or "movie").name[:160],
            expected_size=expected_size,
            dir_path=job_dir,
            input_path=job_dir / f"input{safe_ext}",
            hls_dir=hls_dir,
            playlist_path=hls_dir / "playlist.m3u8",
        )
        self.jobs[job_id] = job
        return job

    def get_job(self, job_id: str) -> MediaJob | None:
        return self.jobs.get(job_id)

    def cleanup_job(self, job_id: str) -> None:
        job = self.jobs.pop(job_id, None)
        if not job:
            return
        job.cancelled = True
        proc = job.process
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        if job.task and not job.task.done():
            job.task.cancel()
        shutil.rmtree(job.dir_path, ignore_errors=True)

    def cleanup_room(self, room_id: str) -> None:
        ids = [jid for jid, j in self.jobs.items() if j.room_id == room_id]
        for jid in ids:
            self.cleanup_job(jid)

    def cleanup_all(self) -> None:
        for jid in list(self.jobs.keys()):
            self.cleanup_job(jid)
        if MEDIA_ROOT.exists():
            for child in MEDIA_ROOT.iterdir():
                shutil.rmtree(child, ignore_errors=True)

    def _run_ffmpeg_sync(
        self,
        job: MediaJob,
        audio_index: int | None,
        subtitle_index: int | None,
    ) -> None:
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("ffmpeg is not available on this server.")
        probe = job.probe or probe_file(job.input_path)
        job.probe = probe
        videos = probe.get("video") or []
        if not videos:
            raise RuntimeError("This file contains no video stream.")
        v0 = videos[0]
        audios = probe.get("audio") or []
        subs = probe.get("subtitles") or []

        plan_info = choose_conversion_plan(probe, audio_index=audio_index, subtitle_index=subtitle_index)
        sel_idx = plan_info["selected_audio_index"]
        sel_audio = next((a for a in audios if a["index"] == sel_idx), None) if sel_idx is not None else None

        # Only extract subtitle stream when host explicitly chose text subtitle burn-in
        has_sub_burn = False
        if subtitle_index is not None and subtitle_index >= 0 and subs and plan_info["has_sub_burn"]:
            sel_sub = next((s for s in subs if s["index"] == subtitle_index), None)
            if sel_sub is None and 0 <= subtitle_index < len(subs):
                sel_sub = subs[subtitle_index]
            if sel_sub:
                sub_file = job.hls_dir / "subs.srt"
                extract = subprocess.run(
                    [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(job.input_path), "-map", f"0:{sel_sub['index']}", str(sub_file)],
                    capture_output=True,
                    timeout=30,
                )
                if extract.returncode == 0 and sub_file.exists():
                    has_sub_burn = True

        copy_video = plan_info["copy_video"] and not has_sub_burn
        job.plan = plan_info["plan"]
        job.video_action = "copy" if copy_video else "encode"

        if not sel_audio:
            job.audio_action = "none"
            audio_args = ["-an"]
        elif plan_info["audio_action"] == "copy":
            job.audio_action = "copy"
            audio_args = ["-map", f"0:{sel_audio['index']}", "-c:a", "copy"]
        else:
            job.audio_action = "transcode"
            audio_args = ["-map", f"0:{sel_audio['index']}", "-c:a", "aac", "-ac", "2", "-b:a", "192k"]

        hw_enc = detect_hw_encoder()
        if copy_video:
            encoders_to_try = ["copy"] + ([hw_enc] if hw_enc else []) + ["libx264"]
        else:
            encoders_to_try = ([hw_enc, "libx264"] if hw_enc else ["libx264"])

        duration = float(probe.get("duration") or 0.0)
        last_err = ""
        for enc in encoders_to_try:
            if job.cancelled:
                return
            for child in job.hls_dir.iterdir():
                if child.name != "subs.srt":
                    child.unlink(missing_ok=True)

            is_copy = enc == "copy"
            job.encoder = enc
            job.video_action = "copy" if is_copy else "encode"
            if not is_copy and job.plan in ("remux", "audio_transcode"):
                job.plan = "full_transcode"

            cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(job.input_path), "-map", f"0:{v0['index']}"]
            if has_sub_burn:
                cmd += ["-vf", "subtitles=subs.srt"]
            if is_copy:
                cmd += ["-c:v", "copy"]
            elif enc == "libx264":
                cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-threads", "0", "-pix_fmt", "yuv420p", "-g", "48"]
            else:
                cmd += ["-c:v", enc, "-pix_fmt", "yuv420p", "-g", "48"]
            cmd += audio_args
            # Rule 5: skip subtitles and extra streams unless explicitly chosen
            cmd += ["-sn", "-dn"]
            # Rule 4: HLS fragmented MP4 segments ready incrementally for playback while converting
            cmd += [
                "-f", "hls",
                "-hls_time", "2",
                "-hls_list_size", "0",
                "-hls_playlist_type", "event",
                "-hls_segment_type", "fmp4",
                "-hls_fmp4_init_filename", "init.mp4",
                "-hls_flags", "independent_segments+temp_file",
                "-hls_segment_filename", "seg_%05d.m4s",
                "-progress", "pipe:1", "-nostats",
                "playlist.m3u8",
            ]

            job.started_at = time.monotonic()
            job.finished_at = None
            job.speed_x = None
            job.eta_sec = None
            out_time_s = 0.0

            proc = subprocess.Popen(
                cmd,
                cwd=str(job.hls_dir),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            job.process = proc
            if proc.stdout:
                for line in proc.stdout:
                    if job.cancelled:
                        break
                    line = line.strip()
                    if line.startswith("out_time_us="):
                        try:
                            out_time_s = max(0.0, int(line.split("=", 1)[1]) / 1_000_000.0)
                            if duration > 0:
                                job.progress = max(job.progress, min(99.0, out_time_s / duration * 100.0))
                            elapsed = max(0.02, time.monotonic() - (job.started_at or time.monotonic()))
                            if not job.speed_x and out_time_s > 0.05:
                                job.speed_x = out_time_s / elapsed
                            if duration > 0 and job.speed_x and job.speed_x > 0:
                                job.eta_sec = max(0.0, (duration - out_time_s) / job.speed_x)
                        except ValueError:
                            pass
                    elif line.startswith("speed="):
                        sp = line.split("=", 1)[1].rstrip("x").strip()
                        try:
                            val = float(sp)
                            if val > 0:
                                job.speed_x = val
                                if duration > 0:
                                    job.eta_sec = max(0.0, (duration - out_time_s) / val)
                        except ValueError:
                            pass
            rc = proc.wait()
            stderr_txt = proc.stderr.read() if proc.stderr else ""
            job.process = None
            if job.cancelled:
                return
            has_segs = (job.hls_dir / "init.mp4").exists() and job.playlist_path.exists()
            if rc == 0 and has_segs:
                job.finished_at = time.monotonic()
                elapsed = max(0.01, job.finished_at - (job.started_at or job.finished_at))
                if duration > 0 and not job.speed_x:
                    job.speed_x = duration / elapsed
                job.eta_sec = 0.0
                job.progress = 100.0
                return
            last_err = (stderr_txt or f"ffmpeg exited with code {rc}").strip()
            log.warning("ffmpeg (%s) failed for job %s: %s", enc, job.job_id, last_err[:300])

        raise RuntimeError(last_err or "Media conversion failed.")

    async def start_transcode(
        self,
        job: MediaJob,
        audio_index: int | None = None,
        subtitle_index: int | None = None,
    ) -> None:
        if job.status == "processing":
            return
        job.status = "processing"
        job.progress = 0.0
        job.error = None

        async def _runner() -> None:
            try:
                await asyncio.to_thread(self._run_ffmpeg_sync, job, audio_index, subtitle_index)
                if not job.cancelled:
                    job.status = "ready"
                    job.progress = 100.0
            except asyncio.CancelledError:
                job.status = "cancelled"
            except Exception as exc:
                if not job.cancelled:
                    job.status = "error"
                    job.error = str(exc)

        job.task = asyncio.create_task(_runner())


media_service = MediaService()
