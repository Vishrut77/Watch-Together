"""Business logic for rooms and joining. No HTTP and no sockets in here."""
from datetime import datetime, timedelta, timezone
import hmac
import re

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import hash_password, verify_password
from app.models import ChatMessage, Participant, Room
from app.schemas.room import JoinRequest, RoomCreate
from app.services import permission_service as perms
from app.utils.helpers import clean_text, new_id, new_invite_token, new_room_code, utcnow


def normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def get_room_or_404(db: Session, room_id: str) -> Room:
    room = db.get(Room, normalize_code(room_id))
    if not room:
        raise HTTPException(404, "We couldn't find a room with that code. Check it and try again.")
    if room.is_closed:
        raise HTTPException(410, "This room has ended.")
    return room


def active_count(db: Session, room_id: str) -> int:
    return db.scalar(
        select(func.count()).select_from(Participant).where(Participant.room_id == room_id, Participant.status == "active")
    ) or 0


def room_state(room: Room) -> dict:
    return {
        "id": room.id,
        "name": room.name,
        "description": room.description,
        "is_public": room.is_public,
        "is_locked": room.is_locked,
        "chat_enabled": room.chat_enabled,
        "camera_enabled": room.camera_enabled,
        "screen_share_mode": room.screen_share_mode,
        "max_participants": room.max_participants,
        "has_password": bool(room.password_hash),
    }


def room_summary(db: Session, room: Room) -> dict:
    return {
        "id": room.id,
        "name": room.name,
        "description": room.description,
        "participants_count": active_count(db, room.id),
        "max_participants": room.max_participants,
        "has_password": bool(room.password_hash),
        "is_locked": room.is_locked,
    }


def participant_public(p: Participant, online: bool = False, hand: bool = False) -> dict:
    return {
        "id": p.id,
        "nickname": p.nickname,
        "role": p.role,
        "permissions": list(p.permissions or []) if p.role == "cohost" else [],
        "online": online,
        "hand_raised": hand,
    }


def active_participants(db: Session, room_id: str) -> list[Participant]:
    return list(
        db.scalars(
            select(Participant).where(Participant.room_id == room_id, Participant.status == "active").order_by(Participant.joined_at)
        ).all()
    )


def roster(db: Session, room_id: str, online: set[str] | None = None, hands: set[str] | None = None) -> list[dict]:
    online, hands = online or set(), hands or set()
    rows = active_participants(db, room_id)
    return [participant_public(p, p.id in online, p.id in hands) for p in rows]


def invite_token_for(room: Room, p: Participant) -> str | None:
    return room.invite_token if perms.has_permission(p, "manage_settings") else None


def recent_chat(db: Session, room_id: str, limit: int = 50) -> list[dict]:
    rows = db.scalars(
        select(ChatMessage).where(ChatMessage.room_id == room_id).order_by(ChatMessage.id.desc()).limit(limit)
    ).all()
    return [chat_out(m) for m in reversed(rows)]


def find_mentions(text: str, participants: list) -> list[str]:
    if not text or not participants:
        return []

    by_name: dict[str, list[str]] = {}
    name_display: dict[str, str] = {}
    for p in participants:
        name = getattr(p, "nickname", None) or (p.get("nickname") if isinstance(p, dict) else None)
        pid = getattr(p, "id", None) or (p.get("id") if isinstance(p, dict) else None)
        if name and pid:
            cleaned = name.strip()
            key = cleaned.lower()
            by_name.setdefault(key, []).append(pid)
            name_display[key] = cleaned

    sorted_keys = sorted(by_name.keys(), key=len, reverse=True)
    mentioned_ids: list[str] = []

    cur_text = text
    for key in sorted_keys:
        esc = re.escape(name_display[key])
        pattern = rf"(?:^|(?<=[^a-zA-Z0-9_.+-]))@{esc}(?=[^a-zA-Z0-9_]|$)"
        if re.search(pattern, cur_text, re.IGNORECASE):
            for pid in by_name[key]:
                if pid not in mentioned_ids:
                    mentioned_ids.append(pid)
            cur_text = re.sub(pattern, " ", cur_text, flags=re.IGNORECASE)

    return mentioned_ids


def chat_out(m: ChatMessage) -> dict:
    created = m.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return {
        "id": m.id,
        "participant_id": m.participant_id,
        "nickname": m.nickname,
        "role": m.role,
        "kind": m.kind,
        "text": m.text,
        "ts": int(created.timestamp() * 1000),
        "mentions": list(m.mentions or []),
    }


def _unique_nickname(db: Session, room_id: str, nickname: str, exclude_id: str | None) -> str:
    taken = {
        n.lower()
        for n in db.scalars(
            select(Participant.nickname).where(
                Participant.room_id == room_id, Participant.status == "active", Participant.id != (exclude_id or "")
            )
        )
    }
    candidate, n = nickname, 2
    while candidate.lower() in taken:
        candidate = f"{nickname[:20]} ({n})"
        n += 1
    return candidate


def create_room(db: Session, data: RoomCreate) -> tuple[Room, Participant]:
    for _ in range(10):
        code = new_room_code()
        if not db.get(Room, code):
            break
    else:  # pragma: no cover - astronomically unlikely
        raise HTTPException(500, "Could not allocate a room code. Please try again.")

    room = Room(
        id=code,
        name=data.name,
        description=data.description,
        is_public=data.is_public,
        password_hash=hash_password(data.password) if data.password else None,
        invite_token=new_invite_token(),
        max_participants=data.max_participants,
    )
    now = utcnow()
    owner = Participant(
        id=new_id(), room_id=code, nickname=data.nickname, client_id=data.client_id, role="owner", status="active", last_seen=now
    )
    room.owner_id = owner.id
    db.add(room)
    db.flush()
    db.add(owner)
    db.commit()
    return room, owner


def join_room(db: Session, room: Room, data: JoinRequest) -> Participant:
    existing = db.scalar(
        select(Participant).where(Participant.room_id == room.id, Participant.client_id == data.client_id)
    )
    if existing and existing.status == "banned":
        raise HTTPException(403, "You have been banned from this room.")

    now = utcnow()
    rejoin_window = timedelta(seconds=settings.rejoin_window_seconds)

    # Check if existing participant has expired (away > 15m or left)
    is_expired = False
    if existing:
        if existing.status == "left":
            is_expired = True
        else:
            seen = existing.last_seen or existing.joined_at
            if seen:
                if seen.tzinfo is None:
                    seen = seen.replace(tzinfo=timezone.utc)
                if (now - seen) > rejoin_window:
                    is_expired = True

    if is_expired and existing:
        existing.status = "left"
        existing.left_at = now
        existing.client_id = f"expired:{existing.id}"
        db.commit()
        existing = None

    # The owner always gets back in (same device), even if the room is locked or full (if not expired / transferred).
    if existing and existing.role == "owner" and room.owner_id == existing.id:
        existing.status = "active"
        existing.last_seen = now
        existing.nickname = _unique_nickname(db, room.id, data.nickname, existing.id)
        db.commit()
        return existing

    if room.is_locked:
        raise HTTPException(403, "This room is locked by the host. Ask them to unlock it.")

    invited = bool(data.invite_token) and hmac.compare_digest(data.invite_token, room.invite_token)
    if not invited:
        if room.password_hash:
            if not data.password:
                raise HTTPException(401, "This room needs a password.")
            if not verify_password(data.password, room.password_hash):
                raise HTTPException(401, "That password isn't right.")
        elif not room.is_public:
            raise HTTPException(403, "This room is private. Ask the host for an invite link.")

    already_in = existing is not None and existing.status == "active"
    if not already_in and active_count(db, room.id) >= room.max_participants:
        raise HTTPException(409, "This room is full.")

    nickname = _unique_nickname(db, room.id, data.nickname, existing.id if existing else None)
    if existing:
        existing.nickname = nickname
        existing.status = "active"
        existing.last_seen = now
        participant = existing
    else:
        participant = Participant(
            id=new_id(), room_id=room.id, nickname=nickname, client_id=data.client_id, role="participant", status="active", last_seen=now
        )
        db.add(participant)
    db.commit()
    return participant


async def transfer_owner_if_needed(db: Session, room_id: str) -> bool:
    from app.services import livekit_service
    from app.services.realtime import hub

    room = db.get(Room, room_id)
    if not room or room.is_closed:
        return False

    online_pids = hub.online_ids(room_id)
    if not online_pids:
        return False

    owner = db.get(Participant, room.owner_id) if room.owner_id else None
    if owner and owner.id in online_pids:
        return False

    now = utcnow()
    rejoin_window = timedelta(seconds=settings.rejoin_window_seconds)
    owner_seen = owner.last_seen if owner and owner.last_seen else (owner.joined_at if owner else None)
    if owner_seen and owner_seen.tzinfo is None:
        owner_seen = owner_seen.replace(tzinfo=timezone.utc)

    if owner and owner_seen and (now - owner_seen) < rejoin_window:
        return False

    candidates = db.scalars(
        select(Participant).where(
            Participant.room_id == room_id,
            Participant.id.in_(online_pids),
            Participant.status == "active",
        )
    ).all()
    candidates = [p for p in candidates if not owner or p.id != owner.id]
    if not candidates:
        return False

    cohosts = [p for p in candidates if p.role == "cohost"]
    if cohosts:
        cohosts.sort(key=lambda p: (-len(p.permissions or []), p.joined_at))
        new_owner = cohosts[0]
    else:
        candidates.sort(key=lambda p: p.joined_at)
        new_owner = candidates[0]

    old_owner = owner
    room.owner_id = new_owner.id
    new_owner.role = "owner"
    new_owner.permissions = []
    if old_owner:
        old_owner.role = "participant"
        old_owner.permissions = []

    db.commit()
    db.refresh(room)
    db.refresh(new_owner)
    if old_owner:
        db.refresh(old_owner)

    await livekit_service.update_permissions(room, new_owner)
    if old_owner:
        await livekit_service.update_permissions(room, old_owner)

    playback = hub.get_playback(room_id)
    if old_owner and playback.get("has_movie") and playback.get("streamer_id") == old_owner.id:
        await hub.stop_movie(room_id, "The host was offline for 15 minutes, so the movie stopped.")

    await hub.broadcast(room_id, {"type": "notice", "text": f"{new_owner.nickname} is now the host."})
    await hub.broadcast_roster(room_id)
    await hub.send_me(room_id, new_owner.id)
    return True


async def cleanup_abandoned_rooms(db: Session) -> list[str]:
    from app.services import livekit_service
    from app.services.realtime import hub

    now = utcnow()
    rejoin_window = timedelta(seconds=settings.rejoin_window_seconds)

    rooms = db.scalars(select(Room)).all()
    deleted_ids = []

    for room in rooms:
        online_pids = hub.online_ids(room.id)
        if not online_pids:
            max_seen = db.scalar(
                select(func.max(Participant.last_seen)).where(Participant.room_id == room.id)
            )
            if not max_seen:
                max_seen = db.scalar(
                    select(func.max(Participant.joined_at)).where(Participant.room_id == room.id)
                )
            if not max_seen:
                max_seen = room.created_at

            if max_seen.tzinfo is None:
                max_seen = max_seen.replace(tzinfo=timezone.utc)

            if (now - max_seen) >= rejoin_window:
                deleted_ids.append(room.id)
                continue
        else:
            await transfer_owner_if_needed(db, room.id)

        expired_participants = db.scalars(
            select(Participant).where(
                Participant.room_id == room.id,
                Participant.status == "active",
                ~Participant.id.in_(online_pids),
            )
        ).all()
        for p in expired_participants:
            p_seen = p.last_seen or p.joined_at
            if p_seen.tzinfo is None:
                p_seen = p_seen.replace(tzinfo=timezone.utc)
            if (now - p_seen) >= rejoin_window:
                p.status = "left"
                p.left_at = now
        db.commit()

    for rid in deleted_ids:
        db.execute(delete(ChatMessage).where(ChatMessage.room_id == rid))
        db.execute(delete(Participant).where(Participant.room_id == rid))
        db.execute(delete(Room).where(Room.id == rid))
        db.commit()
        await hub.delete_room_state(rid)
        await livekit_service.delete_room(rid)

    return deleted_ids


def set_chat_message(db: Session, room_id: str, p: Participant, text: str, kind: str = "chat") -> ChatMessage:
    active = active_participants(db, room_id)
    mentions = find_mentions(text, active)
    msg = ChatMessage(
        room_id=room_id,
        participant_id=p.id,
        nickname=p.nickname,
        role=p.role,
        kind=kind,
        text=text,
        mentions=mentions,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    return msg


def validate_chat_text(text) -> str:
    if not isinstance(text, str):
        raise ValueError("Message must be text.")
    cleaned = clean_text(text, 500)
    if not cleaned:
        raise ValueError("Message can't be empty.")
    return cleaned
