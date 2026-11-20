"""Headless FFmpeg bot service (fallback tier after native playback fails).

Runs locally on the host machine. Joins LiveKit as 'movie-bot-<roomId>',
decodes video and downmixes audio with FFmpeg, paces frames to real time
using the audio clock, and publishes WebRTC tracks named 'movie' and 'movie-audio'.
Fast input seeking (-ss <pos> -accurate_seek -i <file>), frame holding during
restarts, dynamic audio track switching, and optional subtitle burn-in.
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from livekit import api, rtc
from livekit.protocol import models as lk_models

from app.core.config import settings
from app.services import room_service
from app.services.livekit_service import lk_room_name
from app.services.media_service import find_ffmpeg, probe_file
from app.utils.helpers import now_ms

log = logging.getLogger("watchtogether.movie_bot")

# Allowed video extensions for pasted local paths
ALLOWED_VIDEO_EXTS = {
    ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv",
    ".m4v", ".ts", ".mts", ".m2ts", ".vob", ".ogv", ".3gp",
}

# Quality presets matching frontend/src/js/livekit.js
QUALITY_PRESETS = {
    "auto": {"max_height": 720, "max_fps": 24, "bitrate": 2_200_000, "low_upload": True},
    "high": {"max_height": 1080, "max_fps": 30, "bitrate": 6_000_000, "low_upload": False},
    "balanced": {"max_height": 720, "max_fps": 30, "bitrate": 3_000_000, "low_upload": False},
    "saver": {"max_height": 480, "max_fps": 24, "bitrate": 1_200_000, "low_upload": True},
}


def validate_local_path(raw_path: str) -> Path:
    """Validate a host-provided local file path for safety."""
    p = Path(raw_path).expanduser().resolve()
    if not p.exists():
        raise ValueError(f"File not found: {raw_path}")
    if not p.is_file():
        raise ValueError(f"Path is not a regular file: {raw_path}")
    if p.suffix.lower() not in ALLOWED_VIDEO_EXTS:
        raise ValueError(f"Unsupported video extension: {p.suffix}")
    return p


def create_bot_access_token(room_id: str) -> str:
    """Create a LiveKit access token for the headless bot restricted to screen share publish."""
    grants = api.VideoGrants(
        room_join=True,
        room=lk_room_name(room_id),
        can_subscribe=False,
        can_publish=True,
        can_publish_data=False,
        can_publish_sources=["screen_share", "screen_share_audio"],
    )
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(f"movie-bot-{room_id}")
        .with_name("Movie Bot")
        .with_grants(grants)
        .to_jwt()
    )
    return token


class MovieBot:
    def __init__(
        self,
        room_id: str,
        controller_id: str,
        file_path: Path,
        quality: str = "auto",
        start_position: float = 0.0,
        temp_file_to_clean: Optional[Path] = None,
        audio_index: Optional[int] = None,
        subtitle_index: Optional[int] = None,
        subtitle_path: Optional[Path] = None,
    ) -> None:
        self.room_id = room_id
        self.controller_id = controller_id
        self.file_path = file_path
        self.quality_name = quality if quality in QUALITY_PRESETS else "auto"
        self.position = max(0.0, float(start_position))
        self.temp_file_to_clean = temp_file_to_clean
        self.audio_index = audio_index
        self.subtitle_index = subtitle_index
        self.subtitle_path = subtitle_path

        self.room: Optional[rtc.Room] = None
        self.video_source: Optional[rtc.VideoSource] = None
        self.audio_source: Optional[rtc.AudioSource] = None
        self.video_track: Optional[rtc.LocalVideoTrack] = None
        self.audio_track: Optional[rtc.LocalAudioTrack] = None

        self.video_proc: Optional[asyncio.subprocess.Process] = None
        self.audio_proc: Optional[asyncio.subprocess.Process] = None
        self.feeder_task: Optional[asyncio.Task] = None
        self._frame_holder_task: Optional[asyncio.Task] = None
        self._feeder_stopping = False

        self.playing: bool = False
        self.stopped: bool = False
        self.last_frame_bytes: Optional[bytes] = None

        # Probed metadata
        self.probe_info: dict[str, Any] = {}
        self.duration: float = 0.0
        self.src_width: int = 1280
        self.src_height: int = 720
        self.src_fps: int = 30
        self.has_audio: bool = True
        self.title: str = file_path.name

        # Target dimensions after downscaling
        self.target_width: int = 1280
        self.target_height: int = 720
        self.target_fps: int = 24
        self.target_bitrate: int = 2_200_000
        self.is_low_upload: bool = True

        # Diagnostics & pacing
        self.audio_clock: float = self.position
        self.video_frames_sent: int = 0
        self.dropped_frames: int = 0
        self.lag_warnings: int = 0
        self.last_status_broadcast: float = 0.0
        self.lock = asyncio.Lock()

    def _calc_dimensions(self) -> None:
        cfg = QUALITY_PRESETS[self.quality_name]
        self.target_fps = min(cfg["max_fps"], self.src_fps)
        self.target_bitrate = cfg["bitrate"]
        self.is_low_upload = cfg["low_upload"]

        scale = min(1.0, cfg["max_height"] / max(1, self.src_height))
        w = int(round(self.src_width * scale / 2.0)) * 2
        h = int(round(self.src_height * scale / 2.0)) * 2
        self.target_width = max(320, w)
        self.target_height = max(180, h)

    async def start(self) -> None:
        """Probe media, connect bot to LiveKit room, publish tracks, and start feeder."""
        ffmpeg_bin = find_ffmpeg()
        if not ffmpeg_bin:
            raise RuntimeError("ffmpeg is not installed or available on PATH / imageio-ffmpeg.")

        # Probe file info once and cache
        self.probe_info = await asyncio.to_thread(probe_file, self.file_path)
        self.duration = float(self.probe_info.get("duration") or 0.0)
        self.has_audio = bool(self.probe_info.get("has_audio", True))
        self.title = str(self.probe_info.get("title") or self.file_path.name)

        # Default audio track selection if not specified
        audios = self.probe_info.get("audio") or []
        if self.audio_index is None and audios:
            default_a = next((a for a in audios if a.get("default")), audios[0])
            self.audio_index = default_a.get("ordinal", 0)

        v_stream = self.probe_info.get("video", [{}])[0] if self.probe_info.get("video") else {}
        self.src_width = int(v_stream.get("width") or 1280)
        self.src_height = int(v_stream.get("height") or 720)
        raw_fps = v_stream.get("fps") or 30.0
        self.src_fps = max(1, int(round(raw_fps)))

        self._calc_dimensions()

        # Connect to LiveKit room
        token = create_bot_access_token(self.room_id)
        self.room = rtc.Room()
        livekit_url = settings.livekit_url or "ws://127.0.0.1:7880"
        await self.room.connect(livekit_url, token)
        log.info(
            "Bot joined LiveKit room %s as movie-bot-%s (%dx%d@%dfps, %s)",
            self.room_id, self.room_id, self.target_width, self.target_height, self.target_fps, self.quality_name
        )

        # Create video source & track
        self.video_source = rtc.VideoSource(self.target_width, self.target_height)
        self.video_track = rtc.LocalVideoTrack.create_video_track("movie", self.video_source)
        v_opt = rtc.TrackPublishOptions()
        v_opt.source = rtc.TrackSource.SOURCE_SCREENSHARE
        v_opt.video_encoding.max_bitrate = self.target_bitrate
        v_opt.video_encoding.max_framerate = self.target_fps
        if self.is_low_upload:
            v_opt.simulcast = False
        await self.room.local_participant.publish_track(self.video_track, v_opt)

        # Create audio source & track if audio present
        if self.has_audio:
            self.audio_source = rtc.AudioSource(sample_rate=48000, num_channels=2)
            self.audio_track = rtc.LocalAudioTrack.create_audio_track("movie-audio", self.audio_source)
            a_opt = rtc.TrackPublishOptions()
            a_opt.source = rtc.TrackSource.SOURCE_SCREENSHARE_AUDIO
            await self.room.local_participant.publish_track(self.audio_track, a_opt)

        self.playing = True
        self.stopped = False
        self._start_feeder(self.position)
        await self._sync_playback_state()

    def _start_feeder(self, start_pos: float) -> None:
        self._stop_feeder()
        self.position = max(0.0, min(self.duration if self.duration > 0 else 86400, start_pos))
        self.audio_clock = self.position
        self._start_frame_holder()
        self._feeder_stopping = False
        self.feeder_task = asyncio.create_task(self._feeder_loop(self.position))

    def _stop_feeder(self) -> None:
        self._feeder_stopping = True
        if self.feeder_task and not self.feeder_task.done():
            self.feeder_task.cancel()
        self.feeder_task = None
        self._kill_subprocesses()

    def _start_frame_holder(self) -> None:
        self._stop_frame_holder()
        if self.last_frame_bytes and self.video_source:
            self._frame_holder_task = asyncio.create_task(self._frame_holder_loop())

    def _stop_frame_holder(self) -> None:
        if self._frame_holder_task and not self._frame_holder_task.done():
            self._frame_holder_task.cancel()
        self._frame_holder_task = None

    async def _frame_holder_loop(self) -> None:
        """Hold the last video frame during the 1-3 second restart to avoid WebRTC freezes."""
        try:
            while not self.stopped and self.video_source and self.last_frame_bytes:
                vf = rtc.VideoFrame(
                    self.target_width, self.target_height, rtc.VideoBufferType.I420, self.last_frame_bytes
                )
                self.video_source.capture_frame(vf)
                await asyncio.sleep(0.1)  # 10 fps keepalive
        except asyncio.CancelledError:
            pass

    def _kill_subprocesses(self) -> None:
        for proc in (self.video_proc, self.audio_proc):
            if proc is not None:
                try:
                    if proc.returncode is None:
                        proc.kill()
                except Exception:
                    pass
                if proc.stdout and hasattr(proc.stdout, "_transport") and proc.stdout._transport:
                    try:
                        proc.stdout._transport.close()
                    except Exception:
                        pass
        self.video_proc = None
        self.audio_proc = None

    async def _feeder_loop(self, start_pos: float) -> None:
        is_cancelled = False
        ffmpeg_bin = find_ffmpeg()
        if not ffmpeg_bin:
            return

        base_scale = (
            f"scale={self.target_width}:{self.target_height}:force_original_aspect_ratio=decrease,"
            f"pad={self.target_width}:{self.target_height}:(ow-iw)/2:(oh-ih)/2,"
            f"fps={self.target_fps}"
        )

        # Build video filter including optional subtitle burn-in
        vf_parts = []
        if self.subtitle_path and self.subtitle_path.exists():
            esc = str(self.subtitle_path.resolve()).replace("\\", "/").replace(":", r"\:")
            vf_parts.append(f"subtitles=filename='{esc}'")
        elif self.subtitle_index is not None and self.subtitle_index >= 0:
            esc = str(self.file_path.resolve()).replace("\\", "/").replace(":", r"\:")
            subs = self.probe_info.get("subtitles") or []
            s_obj = next((s for s in subs if s.get("index") == self.subtitle_index), None)
            s_ordinal = s_obj.get("ordinal", 0) if s_obj else self.subtitle_index
            vf_parts.append(f"subtitles=filename='{esc}':si={s_ordinal}")

        vf_parts.append(base_scale)
        vf_filter = ",".join(vf_parts)

        # Fast input seeking before -i (-ss <pos> -accurate_seek -hwaccel auto -i <file>)
        v_cmd = [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel", "error",
            "-ss", f"{start_pos:.3f}",
            "-accurate_seek",
            "-hwaccel", "auto",
            "-i", str(self.file_path),
            "-map", "0:v:0",
            "-an",
            "-vf", vf_filter,
            "-f", "rawvideo",
            "-pix_fmt", "yuv420p",
            "pipe:1",
        ]
        try:
            self.video_proc = await asyncio.create_subprocess_exec(
                *v_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
            )
            movie_bot_manager.track_pid(self.video_proc.pid)
        except Exception as exc:
            log.error("Failed to spawn video FFmpeg process: %s", exc)
            self._stop_frame_holder()
            return

        # Spawn audio subprocess with input seek and selected audio track
        if self.has_audio:
            audios = self.probe_info.get("audio") or []
            target_ordinal = 0
            if self.audio_index is not None:
                a_obj = next((a for a in audios if a.get("index") == self.audio_index), None)
                target_ordinal = a_obj.get("ordinal", 0) if a_obj else self.audio_index
            elif audios:
                default_a = next((a for a in audios if a.get("default")), audios[0])
                target_ordinal = default_a.get("ordinal", 0)

            a_cmd = [
                ffmpeg_bin,
                "-hide_banner",
                "-loglevel", "error",
                "-ss", f"{start_pos:.3f}",
                "-accurate_seek",
                "-i", str(self.file_path),
                "-map", f"0:a:{target_ordinal}",
                "-vn",
                "-ac", "2",
                "-ar", "48000",
                "-f", "s16le",
                "pipe:1",
            ]
            try:
                self.audio_proc = await asyncio.create_subprocess_exec(
                    *a_cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
                )
                movie_bot_manager.track_pid(self.audio_proc.pid)
            except Exception as exc:
                log.error("Failed to spawn audio FFmpeg process: %s", exc)
                self._stop_frame_holder()
                return

        v_frame_size = self.target_width * self.target_height * 3 // 2
        a_chunk_size = 960 * 2 * 2  # 20ms of 48kHz 16-bit stereo
        samples_per_channel = 960

        audio_samples_sent = int(start_pos * 48000)
        video_frames_sent = int(start_pos * self.target_fps)
        audio_done = not self.has_audio
        video_done = False

        audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=100)
        playback_started = asyncio.Event()

        async def audio_reader():
            nonlocal audio_done
            if not self.has_audio or not self.audio_proc or not self.audio_proc.stdout:
                audio_done = True
                await audio_queue.put(None)
                return
            try:
                while not self.stopped and self.playing:
                    chunk = await self.audio_proc.stdout.readexactly(a_chunk_size)
                    await audio_queue.put(chunk)
            except (asyncio.IncompleteReadError, asyncio.CancelledError):
                pass
            finally:
                audio_done = True
                await audio_queue.put(None)

        async def audio_pacer():
            nonlocal audio_samples_sent
            if not self.has_audio or not self.audio_source:
                playback_started.set()
                return

            first = True
            start_wall = 0.0
            while not self.stopped and self.playing:
                chunk = await audio_queue.get()
                if chunk is None:
                    break

                if first:
                    first = False
                    start_wall = time.monotonic()
                    playback_started.set()

                audio_elapsed = (audio_samples_sent - int(start_pos * 48000)) / 48000.0
                wall_elapsed = time.monotonic() - start_wall
                delay = audio_elapsed - wall_elapsed
                if delay > 0:
                    await asyncio.sleep(delay)

                af = rtc.AudioFrame(chunk, 48000, 2, samples_per_channel)
                try:
                    await self.audio_source.capture_frame(af)
                except Exception:
                    break
                audio_samples_sent += samples_per_channel
                self.audio_clock = audio_samples_sent / 48000.0

        async def video_pacer():
            nonlocal video_frames_sent, video_done
            if not self.video_proc or not self.video_proc.stdout or not self.video_source:
                video_done = True
                self._stop_frame_holder()
                return

            frame_duration = 1.0 / self.target_fps
            first = True
            start_wall = 0.0

            try:
                while not self.stopped and self.playing:
                    frame_bytes = await self.video_proc.stdout.readexactly(v_frame_size)
                    if first:
                        first = False
                        self._stop_frame_holder()
                        start_wall = time.monotonic()
                        if self.has_audio:
                            try:
                                await asyncio.wait_for(playback_started.wait(), timeout=1.0)
                            except asyncio.TimeoutError:
                                pass

                    self.last_frame_bytes = frame_bytes
                    video_time = start_pos + (video_frames_sent - int(start_pos * self.target_fps)) * frame_duration
                    self.position = video_time

                    if self.has_audio:
                        clock_time = self.audio_clock
                        diff = video_time - clock_time
                        if diff > 0.040:
                            await asyncio.sleep(min(diff, 0.2))
                        elif diff < -0.300:
                            self.dropped_frames += 1
                            video_frames_sent += 1
                            continue
                    else:
                        wall_elapsed = time.monotonic() - start_wall
                        video_elapsed = (video_frames_sent - int(start_pos * self.target_fps)) * frame_duration
                        delay = video_elapsed - wall_elapsed
                        if delay > 0:
                            await asyncio.sleep(delay)
                        elif delay < -0.5:
                            self.dropped_frames += 1
                            video_frames_sent += 1
                            continue

                    vf = rtc.VideoFrame(
                        self.target_width, self.target_height, rtc.VideoBufferType.I420, frame_bytes
                    )
                    self.video_source.capture_frame(vf)
                    self.video_frames_sent += 1
                    video_frames_sent += 1

            except (asyncio.IncompleteReadError, asyncio.CancelledError):
                pass
            finally:
                video_done = True
                self._stop_frame_holder()

        a_read_task = asyncio.create_task(audio_reader())
        a_pace_task = asyncio.create_task(audio_pacer())
        v_pace_task = asyncio.create_task(video_pacer())

        last_progress_sync = time.monotonic()
        try:
            while not self.stopped and self.playing and not (video_done and audio_done):
                await asyncio.sleep(0.5)
                now = time.monotonic()
                if now - last_progress_sync >= 1.0:
                    last_progress_sync = now
                    if self.has_audio:
                        lag = abs(self.audio_clock - self.position)
                        if lag > 0.5:
                            self.lag_warnings += 1
                            log.warning("Bot pacing lag: %.2fs behind audio clock", lag)
                    await self._sync_playback_state()
        except asyncio.CancelledError:
            is_cancelled = True
        finally:
            self._stop_frame_holder()
            a_read_task.cancel()
            a_pace_task.cancel()
            v_pace_task.cancel()
            try:
                await asyncio.wait_for(
                    asyncio.gather(a_read_task, a_pace_task, v_pace_task, return_exceptions=True),
                    timeout=1.0,
                )
            except Exception:
                pass
            self._kill_subprocesses()

            if not self._feeder_stopping and not is_cancelled and (video_done and audio_done) and self.playing and not self.stopped:
                self.playing = False
                self.position = self.duration
                await self._sync_playback_state()

    async def pause(self) -> None:
        """Pause playback: stop pushing frames, retain last picture and published tracks."""
        async with self.lock:
            if not self.playing:
                return
            self.playing = False
            self._stop_feeder()
            self._stop_frame_holder()
            await self._sync_playback_state()

    async def resume(self) -> None:
        """Resume playback from current position."""
        async with self.lock:
            if self.playing or self.stopped:
                return
            self.playing = True
            self._start_feeder(self.position)
            await self._sync_playback_state()

    async def seek(self, target_pos: float) -> None:
        """Fast input seek to target position with frame hold and audio clock alignment."""
        async with self.lock:
            target = max(0.0, min(self.duration if self.duration > 0 else 86400, float(target_pos)))
            self.position = target
            self.audio_clock = target

            if not self.playing and target < self.duration - 0.2:
                self.playing = True

            if self.playing:
                self._start_feeder(target)
            else:
                self._stop_feeder()
                await self._render_still_frame(target)
            await self._sync_playback_state()

    async def skip(self, delta: float) -> None:
        """Skip relative delta seconds."""
        await self.seek(self.position + float(delta))

    async def switch_audio_track(self, track_index: int) -> None:
        """Switch audio stream mid-playback and restart FFmpeg at current position."""
        async with self.lock:
            self.audio_index = track_index
            audios = self.probe_info.get("audio") or []
            target_track = next((a for a in audios if a.get("index") == track_index or a.get("ordinal") == track_index), None)
            lang = "Audio"
            if target_track:
                raw_lang = (target_track.get("language") or "").strip().lower()
                lang_map = {"eng": "English", "hin": "Hindi", "jpn": "Japanese", "spa": "Spanish", "fre": "French", "ger": "German"}
                lang = target_track.get("title") or lang_map.get(raw_lang, raw_lang.capitalize() or f"Track {track_index}")
            notice = f"Audio: {lang}"

            if self.playing:
                self._start_feeder(self.position)
            elif not self.stopped and self.position < self.duration - 0.2:
                self.playing = True
                self._start_feeder(self.position)
            await self._sync_playback_state(notice=notice)

    async def switch_subtitle_track(self, sub_index: Optional[int], subtitle_path: Optional[Path] = None) -> None:
        """Switch subtitle stream or external subtitle file and restart FFmpeg at current position."""
        async with self.lock:
            self.subtitle_index = sub_index
            self.subtitle_path = subtitle_path
            subs = self.probe_info.get("subtitles") or []
            if subtitle_path:
                notice = f"Subtitles: {subtitle_path.name}"
            elif sub_index is None or sub_index < 0:
                notice = "Subtitles: Off"
            else:
                target_sub = next((s for s in subs if s.get("index") == sub_index or s.get("ordinal") == sub_index), None)
                lang = "Subtitles"
                if target_sub:
                    raw_lang = (target_sub.get("language") or "").strip().lower()
                    lang_map = {"eng": "English", "hin": "Hindi", "jpn": "Japanese", "spa": "Spanish"}
                    lang = target_sub.get("title") or lang_map.get(raw_lang, raw_lang.capitalize() or f"Track {sub_index}")
                notice = f"Subtitles: {lang}"

            if self.playing:
                self._start_feeder(self.position)
            elif not self.stopped and self.position < self.duration - 0.2:
                self.playing = True
                self._start_feeder(self.position)
            elif not self.stopped:
                await self._render_still_frame(self.position)
            await self._sync_playback_state(notice=notice)

    async def _render_still_frame(self, pos: float) -> None:
        """Decode a single still frame at position using fast input seeking and push to video source."""
        ffmpeg_bin = find_ffmpeg()
        if not ffmpeg_bin or not self.video_source:
            return

        base_scale = (
            f"scale={self.target_width}:{self.target_height}:force_original_aspect_ratio=decrease,"
            f"pad={self.target_width}:{self.target_height}:(ow-iw)/2:(oh-ih)/2,"
            f"fps={self.target_fps}"
        )
        vf_parts = []
        if self.subtitle_path and self.subtitle_path.exists():
            esc = str(self.subtitle_path.resolve()).replace("\\", "/").replace(":", r"\:")
            vf_parts.append(f"subtitles=filename='{esc}'")
        elif self.subtitle_index is not None and self.subtitle_index >= 0:
            esc = str(self.file_path.resolve()).replace("\\", "/").replace(":", r"\:")
            subs = self.probe_info.get("subtitles") or []
            s_obj = next((s for s in subs if s.get("index") == self.subtitle_index), None)
            s_ordinal = s_obj.get("ordinal", 0) if s_obj else self.subtitle_index
            vf_parts.append(f"subtitles=filename='{esc}':si={s_ordinal}")

        vf_parts.append(base_scale)
        vf_filter = ",".join(vf_parts)

        cmd = [
            ffmpeg_bin,
            "-hide_banner",
            "-loglevel", "error",
            "-ss", f"{pos:.3f}",
            "-accurate_seek",
            "-hwaccel", "auto",
            "-i", str(self.file_path),
            "-map", "0:v:0",
            "-an",
            "-vf", vf_filter,
            "-vframes", "1",
            "-f", "rawvideo",
            "-pix_fmt", "yuv420p",
            "pipe:1",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
            )
            v_frame_size = self.target_width * self.target_height * 3 // 2
            data, _ = await proc.communicate()
            if len(data) >= v_frame_size:
                frame_data = data[:v_frame_size]
                self.last_frame_bytes = frame_data
                vf = rtc.VideoFrame(
                    self.target_width, self.target_height, rtc.VideoBufferType.I420, frame_data
                )
                self.video_source.capture_frame(vf)
        except Exception as exc:
            log.warning("Failed to render still frame: %s", exc)

    async def stop(self) -> None:
        """Stop bot, kill FFmpeg subprocesses, disconnect from LiveKit, and clean temp file."""
        async with self.lock:
            if self.stopped:
                return
            self.stopped = True
            self.playing = False
            self._stop_feeder()
            self._stop_frame_holder()

            if self.room:
                try:
                    await self.room.disconnect()
                except Exception:
                    pass
                self.room = None

            if self.temp_file_to_clean and self.temp_file_to_clean.exists():
                try:
                    self.temp_file_to_clean.unlink(missing_ok=True)
                except Exception as exc:
                    log.warning("Failed to clean up bot temp file %s: %s", self.temp_file_to_clean, exc)

    async def _sync_playback_state(self, notice: Optional[str] = None) -> None:
        """Report live playback state to the realtime hub with track metadata."""
        from app.services.realtime import hub

        pb = hub.get_playback(self.room_id)
        bot_identity = f"movie-bot-{self.room_id}"
        if not notice and self.lag_warnings > 0 and self.lag_warnings % 5 == 1:
            notice = "Bot CPU warning: video decode is dropping frames to maintain real-time sync."

        pb.update(
            has_movie=True,
            mode="live",
            title=self.title,
            streamer_id=bot_identity,
            duration=self.duration,
            playing=self.playing,
            position=self.position,
            updated_at=now_ms(),
            audio_index=self.audio_index,
            subtitle_index=self.subtitle_index,
            audio_tracks=self.probe_info.get("audio", []),
            subtitle_tracks=self.probe_info.get("subtitles", []),
        )
        msg = hub.playback_message(self.room_id, notice=notice)
        msg["audio_index"] = self.audio_index
        msg["subtitle_index"] = self.subtitle_index
        msg["audio_tracks"] = self.probe_info.get("audio", [])
        msg["subtitle_tracks"] = self.probe_info.get("subtitles", [])
        await hub.broadcast(self.room_id, msg)

    def get_status(self) -> dict[str, Any]:
        return {
            "room_id": self.room_id,
            "controller_id": self.controller_id,
            "playing": self.playing,
            "stopped": self.stopped,
            "position": round(self.position, 2),
            "duration": round(self.duration, 2),
            "quality": self.quality_name,
            "width": self.target_width,
            "height": self.target_height,
            "fps": self.target_fps,
            "audio_index": self.audio_index,
            "subtitle_index": self.subtitle_index,
            "delivered_frames": self.video_frames_sent,
            "dropped_frames": self.dropped_frames,
            "has_audio": self.has_audio,
        }


class MovieBotManager:
    def __init__(self) -> None:
        self.bots: dict[str, MovieBot] = {}
        self.tracked_pids: set[int] = set()

    def track_pid(self, pid: int) -> None:
        self.tracked_pids.add(pid)

    def is_bot_active(self, room_id: str) -> bool:
        bot = self.bots.get(room_id)
        return bot is not None and not bot.stopped

    def is_controller(self, room_id: str, participant_id: str) -> bool:
        bot = self.bots.get(room_id)
        return bot is not None and bot.controller_id == participant_id

    def get_bot(self, room_id: str) -> Optional[MovieBot]:
        return self.bots.get(room_id)

    async def start_bot(
        self,
        room_id: str,
        controller_id: str,
        file_path: Path,
        quality: str = "auto",
        start_position: float = 0.0,
        temp_file_to_clean: Optional[Path] = None,
        audio_index: Optional[int] = None,
        subtitle_index: Optional[int] = None,
        subtitle_path: Optional[Path] = None,
    ) -> MovieBot:
        await self.stop_bot(room_id)
        bot = MovieBot(
            room_id=room_id,
            controller_id=controller_id,
            file_path=file_path,
            quality=quality,
            start_position=start_position,
            temp_file_to_clean=temp_file_to_clean,
            audio_index=audio_index,
            subtitle_index=subtitle_index,
            subtitle_path=subtitle_path,
        )
        self.bots[room_id] = bot
        await bot.start()
        return bot

    async def stop_bot(self, room_id: str) -> None:
        bot = self.bots.pop(room_id, None)
        if bot:
            await bot.stop()

    async def handle_command(
        self,
        room_id: str,
        action: str,
        position: Optional[float] = None,
        delta: Optional[float] = None,
        track_index: Optional[int] = None,
        subtitle_path: Optional[Path] = None,
    ) -> None:
        bot = self.bots.get(room_id)
        if not bot or bot.stopped:
            return
        if action == "play":
            await bot.resume()
        elif action == "pause":
            await bot.pause()
        elif action == "seek" and position is not None:
            await bot.seek(position)
        elif action == "skip" and delta is not None:
            await bot.skip(delta)
        elif action == "audio_track" and track_index is not None:
            await bot.switch_audio_track(track_index)
        elif action == "subtitle_track":
            await bot.switch_subtitle_track(track_index, subtitle_path=subtitle_path)

    async def cleanup_all(self) -> None:
        """Stop all running bots and terminate any tracked orphan FFmpeg processes."""
        for room_id in list(self.bots.keys()):
            try:
                await self.stop_bot(room_id)
            except Exception:
                pass
        self.bots.clear()

        # Clean tracked subprocess PIDs
        for pid in list(self.tracked_pids):
            try:
                if sys.platform == "win32":
                    import subprocess
                    subprocess.run(
                        ["taskkill", "/F", "/T", "/PID", str(pid)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                else:
                    os.kill(pid, signal.SIGKILL)
            except Exception:
                pass
        self.tracked_pids.clear()


movie_bot_manager = MovieBotManager()
