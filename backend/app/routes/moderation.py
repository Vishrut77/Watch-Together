from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_current_participant, hash_password, rate_limit
from app.database.database import get_db
from app.models import Participant
from app.schemas.room import RoomState, SettingsUpdate
from app.services import livekit_service, permission_service as perms, room_service
from app.services.realtime import hub

router = APIRouter(prefix="/api/rooms/{room_id}", tags=["moderation"], dependencies=[Depends(rate_limit("moderation", 60))])


def _require(actor: Participant, perm: str, message: str) -> None:
    if not perms.has_permission(actor, perm):
        raise HTTPException(403, message)


def _target(db: Session, room_id: str, actor: Participant, participant_id: str) -> Participant:
    target = db.get(Participant, participant_id)
    if not target or target.room_id != room_id or target.status != "active":
        raise HTTPException(404, "That participant isn't in the room.")
    if not perms.can_moderate(actor, target):
        raise HTTPException(403, "You can't do that to this person.")
    return target


async def _after_removal(room_id: str, target: Participant, message_type: str, notice: str) -> None:
    await hub.drop(room_id, target.id, {"type": message_type})
    await livekit_service.remove_participant(room_id, target.id)
    if hub.get_playback(room_id)["streamer_id"] == target.id:
        await hub.stop_movie(room_id, f"{target.nickname} was removed, so the movie stopped.")
    await hub.broadcast(room_id, {"type": "notice", "text": notice})
    await hub.broadcast_roster(room_id)


@router.post("/participants/{participant_id}/mute", status_code=204)
async def mute(room_id: str, participant_id: str, actor: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    _require(actor, "mute_participants", "You don't have permission to mute people.")
    target = _target(db, room_id, actor, participant_id)
    await livekit_service.mute_microphone(room_id, target.id)  # server-side mute at the SFU
    await hub.send(room_id, target.id, {"type": "muted", "by": actor.nickname})


@router.post("/participants/{participant_id}/kick", status_code=204)
async def kick(room_id: str, participant_id: str, actor: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    _require(actor, "remove_participants", "You don't have permission to remove people.")
    target = _target(db, room_id, actor, participant_id)
    target.status = "kicked"
    db.commit()
    await _after_removal(room_id, target, "kicked", f"{target.nickname} was removed from the room.")


@router.post("/participants/{participant_id}/ban", status_code=204)
async def ban(room_id: str, participant_id: str, actor: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    _require(actor, "remove_participants", "You don't have permission to ban people.")
    target = _target(db, room_id, actor, participant_id)
    target.status = "banned"
    db.commit()
    await _after_removal(room_id, target, "banned", f"{target.nickname} was banned from the room.")


async def _set_locked(room_id: str, actor: Participant, db: Session, locked: bool) -> RoomState:
    _require(actor, "manage_settings", "You don't have permission to lock the room.")
    room = room_service.get_room_or_404(db, room_id)
    room.is_locked = locked
    db.commit()
    await hub.broadcast(room_id, {"type": "room_update", "room": room_service.room_state(room)})
    return room_service.room_state(room)


@router.post("/lock", response_model=RoomState)
async def lock(room_id: str, actor: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    return await _set_locked(room_id, actor, db, True)


@router.post("/unlock", response_model=RoomState)
async def unlock(room_id: str, actor: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    return await _set_locked(room_id, actor, db, False)


@router.patch("/settings", response_model=RoomState)
async def update_settings(
    room_id: str,
    data: SettingsUpdate,
    actor: Participant = Depends(get_current_participant),
    db: Session = Depends(get_db),
):
    room = room_service.get_room_or_404(db, room_id)
    changes = data.model_dump(exclude_unset=True)
    screen_only = set(changes) <= {"screen_share_mode"}
    if screen_only:
        if not (perms.has_permission(actor, "manage_screen_share") or perms.has_permission(actor, "manage_settings")):
            raise HTTPException(403, "You don't have permission to change screen sharing.")
    else:
        _require(actor, "manage_settings", "You don't have permission to change room settings.")
    if ("password" in changes or changes.get("clear_password")) and not perms.is_owner(actor):
        raise HTTPException(403, "Only the room owner can change the password.")

    for field in ("name", "is_public", "chat_enabled", "camera_enabled", "screen_share_mode", "max_participants"):
        if changes.get(field) is not None:
            setattr(room, field, changes[field] if field != "name" else room_service.clean_text(changes[field], 60) or room.name)
    if changes.get("description") is not None:
        room.description = room_service.clean_text(changes["description"], 200)
    if changes.get("clear_password"):
        room.password_hash = None
    elif changes.get("password"):
        room.password_hash = hash_password(changes["password"])
    db.commit()

    await hub.broadcast(room_id, {"type": "room_update", "room": room_service.room_state(room)})
    if {"camera_enabled", "screen_share_mode"} & set(changes):
        # push the new publish rights to everyone already in the media room
        for p in room_service.roster(db, room_id):
            member = db.get(Participant, p["id"])
            if member and member.role != "owner":
                await livekit_service.update_permissions(room, member)
    return room_service.room_state(room)
