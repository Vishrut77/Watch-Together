"""One authenticated WebSocket per participant: chat, reactions, hands, playback sync, live updates.

Media (camera / mic / movie / screen) goes through LiveKit; this socket only carries small JSON messages.
Every message is authorized against the database here - the client's claimed role is never used.
"""
import math
import re
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.core.security import participant_from_token
from app.database import database as dbm
from app.models import Participant
from app.services import permission_service as perms, room_service
from app.services.movie_bot import movie_bot_manager
from app.services.realtime import default_playback, hub
from app.utils.helpers import now_ms

router = APIRouter()

REACTIONS = {"👍", "❤️", "😂", "😮", "👏", "🔥", "😢", "🎉"}


def _origin_allowed(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin")
    if not origin:
        return True
    if origin.rstrip("/") in settings.cors_list:
        return True
    return urlparse(origin).netloc == ws.headers.get("host")  # same-origin (Cloudflare Tunnel mode)


def _num(value, lo: float, hi: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return max(lo, min(hi, float(value)))


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _clean_fingerprint(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    size = raw.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or size < 0 or size > 10**12:
        return None
    head = raw.get("head_sha256")
    tail = raw.get("tail_sha256")
    if not isinstance(head, str) or not _SHA256_RE.match(head):
        return None
    if not isinstance(tail, str) or not _SHA256_RE.match(tail):
        return None
    name = room_service.clean_text(str(raw.get("name") or ""), 160)
    return {
        "name": name,
        "size": size,
        "head_sha256": head,
        "tail_sha256": tail,
    }


async def _error(room_id: str, pid: str, code: str, message: str) -> None:
    await hub.send(room_id, pid, {"type": "error", "code": code, "message": message})


@router.websocket("/ws/rooms/{room_id}")
async def room_socket(ws: WebSocket, room_id: str, token: str = Query(default="")):
    room_id = room_service.normalize_code(room_id)
    if not _origin_allowed(ws):
        await ws.close(code=4403)
        return
    with dbm.SessionLocal() as db:
        try:
            participant = participant_from_token(db, token, room_id)
        except HTTPException as exc:
            await ws.accept()
            await ws.close(code=4410 if exc.status_code == 410 else 4403 if exc.status_code == 403 else 4401, reason=exc.detail[:100])
            return
        if participant.status != "active":
            await ws.accept()
            await ws.close(code=4401, reason="resume")  # client calls /resume then reconnects
            return
        pid = participant.id
        room = room_service.get_room_or_404(db, room_id)
        snapshot = {
            "type": "state",
            "me": room_service.participant_public(participant, True),
            "invite_token": room_service.invite_token_for(room, participant),
            "room": room_service.room_state(room),
            "chat": room_service.recent_chat(db, room_id),
            "server_time": now_ms(),
        }
        nickname = participant.nickname

    await ws.accept()
    await hub.connect(room_id, pid, ws)
    snapshot["participants"] = _roster(room_id)
    snapshot["playback"] = hub.playback_message(room_id)
    await ws.send_json(snapshot)
    await hub.broadcast(room_id, {"type": "participant_joined", "participant_id": pid, "nickname": nickname}, exclude=pid)
    await hub.broadcast_roster(room_id)

    try:
        while True:
            msg = await ws.receive_json()
            if isinstance(msg, dict):
                try:
                    await _handle(room_id, pid, msg)
                except Exception as exc:
                    log.exception("Error handling ws message %s: %s", msg, exc)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.exception("WS loop error: %s", exc)
    finally:
        await hub.disconnect(room_id, pid, ws)


def _roster(room_id: str) -> list[dict]:
    with dbm.SessionLocal() as db:
        return room_service.roster(db, room_id, hub.online_ids(room_id), hub.hands.get(room_id, set()))


async def _handle(room_id: str, pid: str, msg: dict) -> None:
    kind = msg.get("type")
    if kind == "ping":
        await hub.send(room_id, pid, {"type": "pong", "server_time": now_ms()})
        return

    with dbm.SessionLocal() as db:
        p = db.get(Participant, pid)
        room = room_service.get_room_or_404(db, room_id)
        if not p or p.status != "active":
            return

        if kind == "chat":
            if not perms.can_chat(room, p):
                return await _error(room_id, pid, "chat_disabled", "Chat is turned off by the host.")
            if not hub.allow(room_id, pid, "chat", 5, 5.0):
                return await _error(room_id, pid, "rate_limited", "You're sending messages too fast.")
            try:
                text = room_service.validate_chat_text(msg.get("text"))
            except ValueError as exc:
                return await _error(room_id, pid, "invalid", str(exc))
            saved = room_service.set_chat_message(db, room_id, p, text)
            return await hub.broadcast(room_id, {"type": "chat", **room_service.chat_out(saved)})

        if kind == "reaction":
            emoji = msg.get("emoji")
            if emoji not in REACTIONS or not hub.allow(room_id, pid, "reaction", 10, 5.0):
                return
            return await hub.broadcast(room_id, {"type": "reaction", "participant_id": pid, "nickname": p.nickname, "emoji": emoji})

        if kind == "hand":
            raised = bool(msg.get("raised"))
            hands = hub.hands.setdefault(room_id, set())
            (hands.add if raised else hands.discard)(pid)
            await hub.broadcast(room_id, {"type": "hand", "participant_id": pid, "nickname": p.nickname, "raised": raised})
            return await hub.broadcast_roster(room_id)

        if kind == "announce":
            if not perms.has_permission(p, "manage_settings"):
                return await _error(room_id, pid, "forbidden", "You can't post announcements.")
            try:
                text = room_service.validate_chat_text(msg.get("text"))
            except ValueError as exc:
                return await _error(room_id, pid, "invalid", str(exc))
            saved = room_service.set_chat_message(db, room_id, p, text, kind="announcement")
            return await hub.broadcast(room_id, {"type": "announcement", **room_service.chat_out(saved)})

        pb = hub.get_playback(room_id)

        if kind == "movie_start":
            if not perms.has_permission(p, "stream_movie"):
                return await _error(room_id, pid, "forbidden", "You don't have permission to stream a movie.")
            mode = "local_sync" if msg.get("mode") == "local_sync" else "live"
            fingerprint = None
            if mode == "local_sync":
                fingerprint = _clean_fingerprint(msg.get("fingerprint"))
                if fingerprint is None:
                    return await _error(room_id, pid, "invalid", "Invalid file fingerprint for local sync.")
            current = pb["streamer_id"]
            if current and current != pid and hub.is_online(room_id, current) and not perms.is_owner(p):
                return await _error(room_id, pid, "busy", "Someone else is already streaming a movie.")
            title = room_service.clean_text(str(msg.get("title") or "Movie"), 120) or "Movie"
            duration = _num(msg.get("duration"), 0, 60 * 60 * 24) or 0.0
            if current and current != pid:
                await hub.send(room_id, current, {"type": "movie_stopped", "reason": "Another host started streaming."})
            hub.playback[room_id] = {
                **default_playback(),
                "has_movie": True,
                "mode": mode,
                "title": title,
                "streamer_id": pid,
                "duration": duration,
                "fingerprint": fingerprint,
            }
            return await hub.broadcast(room_id, hub.playback_message(room_id))

        if kind == "movie_stop":
            if not perms.has_permission(p, "stream_movie") or not pb["has_movie"]:
                return
            if movie_bot_manager.is_bot_active(room_id):
                if not movie_bot_manager.is_controller(room_id, pid) and not perms.is_owner(p):
                    return await _error(room_id, pid, "forbidden", "Only the streaming host or the owner can stop the movie.")
                await movie_bot_manager.stop_bot(room_id)
                return await hub.stop_movie(room_id)
            if pb["streamer_id"] != pid and not perms.is_owner(p):
                return await _error(room_id, pid, "forbidden", "Only the streaming host or the owner can stop the movie.")
            streamer = pb["streamer_id"]
            if streamer and streamer != pid:
                await hub.send(room_id, streamer, {"type": "movie_stopped", "reason": f"{p.nickname} stopped the movie."})
            return await hub.stop_movie(room_id)

        if kind == "playback_state":
            # only the person actually streaming is the source of truth for the clock
            if movie_bot_manager.is_bot_active(room_id):
                return
            if not pb["has_movie"] or pb["streamer_id"] != pid:
                return
            position = _num(msg.get("position"), 0, 60 * 60 * 24)
            duration = _num(msg.get("duration"), 0, 60 * 60 * 24)
            if position is None:
                return
            pb.update(
                playing=bool(msg.get("playing")),
                position=position,
                duration=duration if duration is not None else pb["duration"],
                updated_at=now_ms(),
            )
            return await hub.broadcast(room_id, hub.playback_message(room_id), exclude=pid)

        if kind == "playback_command":
            if not perms.has_permission(p, "manage_playback") and not movie_bot_manager.is_controller(room_id, pid) and not perms.is_owner(p):
                return await _error(room_id, pid, "forbidden", "You don't have permission to control playback.")
            if not pb["has_movie"]:
                return await _error(room_id, pid, "no_movie", "Nothing is playing yet.")
            action = msg.get("action")
            if action not in ("play", "pause", "seek", "skip", "audio_track", "subtitle_track"):
                return
            if movie_bot_manager.is_bot_active(room_id):
                position = _num(msg.get("position"), 0, 60 * 60 * 24)
                delta = _num(msg.get("delta"), -600, 600)
                raw_idx = msg.get("track_index") if msg.get("track_index") is not None else msg.get("audio_index")
                track_idx = int(raw_idx) if raw_idx is not None and isinstance(raw_idx, (int, float)) else None
                await movie_bot_manager.handle_command(
                    room_id,
                    action,
                    position=position,
                    delta=delta,
                    track_index=track_idx,
                )
                return
            if pb["streamer_id"] == pid:
                return  # the streamer's own player already handled it locally
            if not hub.is_online(room_id, pb["streamer_id"]):
                return await _error(room_id, pid, "host_offline", "The streaming host is offline.")
            command = {"type": "playback_command", "action": action, "by": p.nickname}
            if action == "seek":
                position = _num(msg.get("position"), 0, 60 * 60 * 24)
                if position is None:
                    return
                command["position"] = position
            if action == "skip":
                delta = _num(msg.get("delta"), -600, 600)
                if delta is None:
                    return
                command["delta"] = delta
            return await hub.send(room_id, pb["streamer_id"], command)
