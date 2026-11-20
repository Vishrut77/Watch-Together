"""In-memory hub for the authenticated room WebSocket.

It holds who is connected, raised hands and the live playback state of each room.
Run a single worker process (the default) - state lives in this process.
"""
import asyncio
import logging
import time
from collections import deque

from fastapi import WebSocket

from app.core.config import settings
from app.database import database as dbm
from app.models import Participant
from app.services import room_service
from app.utils.helpers import now_ms, utcnow

log = logging.getLogger("watchtogether.realtime")


def default_playback() -> dict:
    return {
        "has_movie": False,
        "mode": "live",
        "title": None,
        "streamer_id": None,
        "duration": 0.0,
        "playing": False,
        "position": 0.0,
        "fingerprint": None,
        "updated_at": now_ms(),
    }


class Hub:
    def __init__(self) -> None:
        self.sockets: dict[str, dict[str, WebSocket]] = {}
        self.joining: dict[str, set[str]] = {}
        self.hands: dict[str, set[str]] = {}
        self.playback: dict[str, dict] = {}
        self.watchers: dict[tuple[str, str], asyncio.Task] = {}
        self._windows: dict[tuple[str, str, str], deque] = {}

    # ----- state helpers -----
    def reset(self) -> None:
        for task in list(self.watchers.values()):
            task.cancel()
        self.sockets.clear()
        self.joining.clear()
        self.hands.clear()
        self.playback.clear()
        self.watchers.clear()
        self._windows.clear()

    def online_ids(self, room_id: str) -> set[str]:
        return set(self.sockets.get(room_id, {}).keys())

    def is_online(self, room_id: str, pid: str) -> bool:
        return pid in self.sockets.get(room_id, {})

    def get_playback(self, room_id: str) -> dict:
        return self.playback.setdefault(room_id, default_playback())

    def playback_message(self, room_id: str, notice: str | None = None) -> dict:
        msg = {"type": "playback", **self.get_playback(room_id), "server_time": now_ms()}
        if notice:
            msg["notice"] = notice
        return msg

    def allow(self, room_id: str, pid: str, kind: str, limit: int, window: float) -> bool:
        q = self._windows.setdefault((room_id, pid, kind), deque())
        now = time.monotonic()
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    # ----- connections -----
    async def connect(self, room_id: str, pid: str, ws: WebSocket) -> None:
        room = self.sockets.setdefault(room_id, {})
        old = room.get(pid)
        room[pid] = ws
        self._cancel_watch(room_id, pid)
        self.joining.get(room_id, set()).discard(pid)
        with dbm.SessionLocal() as db:
            p = db.get(Participant, pid)
            if p:
                p.last_seen = utcnow()
                p.status = "active"
                db.commit()
        if old is not None and old is not ws:  # same person opened a second tab: newest wins
            try:
                await old.send_json({"type": "replaced"})
                await old.close(code=4409)
            except Exception:
                pass

    async def disconnect(self, room_id: str, pid: str, ws: WebSocket) -> None:
        room = self.sockets.get(room_id, {})
        if room.get(pid) is not ws:
            return  # already replaced by a newer connection
        room.pop(pid, None)
        with dbm.SessionLocal() as db:
            p = db.get(Participant, pid)
            if p:
                p.last_seen = utcnow()
                db.commit()
        await self.broadcast_roster(room_id)
        self.watch(room_id, pid)

    async def mark_away(self, room_id: str, pid: str) -> None:
        ws = self.sockets.get(room_id, {}).pop(pid, None)
        if ws is not None:
            try:
                await ws.close(code=1000)
            except Exception:
                pass
        self._cancel_watch(room_id, pid)
        with dbm.SessionLocal() as db:
            p = db.get(Participant, pid)
            if p:
                p.last_seen = utcnow()
                db.commit()
        await self.broadcast_roster(room_id)
        if self.get_playback(room_id).get("streamer_id") == pid:
            self.watch(room_id, pid)

    async def send(self, room_id: str, pid: str, msg: dict) -> None:
        ws = self.sockets.get(room_id, {}).get(pid)
        if ws is not None:
            try:
                await ws.send_json(msg)
            except Exception:
                pass

    async def broadcast(self, room_id: str, msg: dict, exclude: str | None = None) -> None:
        for pid, ws in list(self.sockets.get(room_id, {}).items()):
            if pid == exclude:
                continue
            try:
                await ws.send_json(msg)
            except Exception:
                pass

    async def broadcast_roster(self, room_id: str) -> None:
        with dbm.SessionLocal() as db:
            data = room_service.roster(db, room_id, self.online_ids(room_id), self.hands.get(room_id, set()))
        await self.broadcast(room_id, {"type": "roster", "participants": data})

    async def send_me(self, room_id: str, pid: str) -> None:
        with dbm.SessionLocal() as db:
            p = db.get(Participant, pid)
            room = room_service.get_room_or_404(db, room_id)
            if not p:
                return
            msg = {
                "type": "me",
                "participant": room_service.participant_public(p, True, pid in self.hands.get(room_id, set())),
                "invite_token": room_service.invite_token_for(room, p),
            }
        await self.send(room_id, pid, msg)

    async def drop(self, room_id: str, pid: str, msg: dict, code: int = 4403) -> None:
        ws = self.sockets.get(room_id, {}).pop(pid, None)
        self.hands.get(room_id, set()).discard(pid)
        self._cancel_watch(room_id, pid)
        if ws is not None:
            try:
                await ws.send_json(msg)
                await ws.close(code=code)
            except Exception:
                pass

    async def close_room(self, room_id: str) -> None:
        from app.services.media_service import media_service
        from app.services.movie_bot import movie_bot_manager

        await movie_bot_manager.stop_bot(room_id)
        media_service.cleanup_room(room_id)
        await self.broadcast(room_id, {"type": "room_closed"})
        for ws in list(self.sockets.get(room_id, {}).values()):
            try:
                await ws.close(code=4410)
            except Exception:
                pass
        for key in [k for k in self.watchers if k[0] == room_id]:
            self.watchers.pop(key).cancel()
        self.sockets.pop(room_id, None)
        self.hands.pop(room_id, None)
        self.playback.pop(room_id, None)

    async def delete_room_state(self, room_id: str) -> None:
        from app.services.media_service import media_service
        from app.services.movie_bot import movie_bot_manager

        await movie_bot_manager.stop_bot(room_id)
        media_service.cleanup_room(room_id)
        self.sockets.pop(room_id, None)
        self.joining.pop(room_id, None)
        self.hands.pop(room_id, None)
        self.playback.pop(room_id, None)
        for key in [k for k in list(self.watchers) if k[0] == room_id]:
            self.watchers.pop(key).cancel()
        for key in [k for k in list(self._windows) if k[0] == room_id]:
            self._windows.pop(key, None)

    # ----- movie state -----
    async def stop_movie(self, room_id: str, notice: str | None = None) -> None:
        from app.services.media_service import media_service
        from app.services.movie_bot import movie_bot_manager

        await movie_bot_manager.stop_bot(room_id)
        media_service.cleanup_room(room_id)
        self.playback[room_id] = default_playback()
        await self.broadcast(room_id, self.playback_message(room_id, notice))

    # ----- presence -----
    def watch(self, room_id: str, pid: str, join_phase: bool = False) -> None:
        """After a drop (or a fresh join that never connects) free the seat once the grace period passes."""
        if not settings.presence_enabled:
            return
        self._cancel_watch(room_id, pid)
        if join_phase:
            self.joining.setdefault(room_id, set()).add(pid)
        self.watchers[(room_id, pid)] = asyncio.create_task(self._watch(room_id, pid, join_phase))

    def _cancel_watch(self, room_id: str, pid: str) -> None:
        self.joining.get(room_id, set()).discard(pid)
        task = self.watchers.pop((room_id, pid), None)
        if task:
            task.cancel()

    async def _watch(self, room_id: str, pid: str, join_phase: bool) -> None:
        key = (room_id, pid)
        try:
            if join_phase:
                await asyncio.sleep(settings.join_grace_seconds)
                self.joining.get(room_id, set()).discard(pid)
            else:
                await asyncio.sleep(settings.streamer_grace_seconds)
                from app.services.movie_bot import movie_bot_manager
                if not self.is_online(room_id, pid):
                    is_streamer = self.get_playback(room_id)["streamer_id"] == pid
                    is_controller = movie_bot_manager.is_controller(room_id, pid)
                    if is_streamer or is_controller:
                        await self.stop_movie(room_id, "The host lost connection, so the movie stopped.")
                grace = min(settings.rejoin_window_seconds, settings.presence_grace_seconds)
                await asyncio.sleep(max(0, grace - settings.streamer_grace_seconds))
            if not self.is_online(room_id, pid):
                await self.mark_left(room_id, pid)
        except asyncio.CancelledError:
            pass
        except Exception:  # pragma: no cover
            log.exception("presence watcher failed")
        finally:
            self.joining.get(room_id, set()).discard(pid)
            if self.watchers.get(key) is asyncio.current_task():
                self.watchers.pop(key, None)

    async def mark_left(self, room_id: str, pid: str) -> None:
        with dbm.SessionLocal() as db:
            p = db.get(Participant, pid)
            if not p or p.status != "active":
                return
            p.status = "left"
            nickname = p.nickname
            db.commit()
        self.hands.get(room_id, set()).discard(pid)
        if self.get_playback(room_id)["streamer_id"] == pid:
            await self.stop_movie(room_id, "The host left, so the movie stopped.")
        await self.broadcast(room_id, {"type": "participant_left", "participant_id": pid, "nickname": nickname})
        await self.broadcast_roster(room_id)


hub = Hub()
