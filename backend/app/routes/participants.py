from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.security import get_current_participant
from app.database.database import get_db
from app.models import Participant
from app.schemas.participant import ParticipantPublic, PermissionUpdate
from app.services import livekit_service, permission_service as perms, room_service
from app.services.realtime import hub

router = APIRouter(prefix="/api/rooms/{room_id}/participants", tags=["permissions"])


def _target(db: Session, room_id: str, participant_id: str) -> Participant:
    target = db.get(Participant, participant_id)
    if not target or target.room_id != room_id or target.status != "active":
        raise HTTPException(404, "That participant isn't in the room.")
    return target


@router.post("/{participant_id}/permissions", response_model=ParticipantPublic)
async def grant_permissions(
    room_id: str,
    participant_id: str,
    data: PermissionUpdate,
    actor: Participant = Depends(get_current_participant),
    db: Session = Depends(get_db),
):
    """Owner only: make someone a co-host with exactly the permissions listed."""
    if not perms.is_owner(actor):
        raise HTTPException(403, "Only the room owner can change co-host permissions.")
    target = _target(db, room_id, participant_id)
    if target.role == "owner":
        raise HTTPException(400, "The owner already has every permission.")
    target.role = "cohost"
    target.permissions = sorted(set(data.permissions))
    db.commit()
    await _after_change(db, room_id, target)
    return room_service.participant_public(target, hub.is_online(room_id, target.id))


@router.delete("/{participant_id}/permissions", response_model=ParticipantPublic)
async def revoke_permissions(
    room_id: str,
    participant_id: str,
    actor: Participant = Depends(get_current_participant),
    db: Session = Depends(get_db),
):
    if not perms.is_owner(actor):
        raise HTTPException(403, "Only the room owner can change co-host permissions.")
    target = _target(db, room_id, participant_id)
    if target.role == "owner":
        raise HTTPException(400, "The owner's permissions can't be revoked.")
    target.role = "participant"
    target.permissions = []
    db.commit()
    await _after_change(db, room_id, target)
    return room_service.participant_public(target, hub.is_online(room_id, target.id))


async def _after_change(db: Session, room_id: str, target: Participant) -> None:
    room = room_service.get_room_or_404(db, room_id)
    # a co-host who lost stream rights mid-stream must stop streaming too
    if hub.get_playback(room_id)["streamer_id"] == target.id and not perms.has_permission(target, "stream_movie"):
        await hub.stop_movie(room_id, f"{target.nickname} is no longer allowed to stream.")
    await livekit_service.update_permissions(room, target)
    await hub.send_me(room_id, target.id)
    await hub.broadcast_roster(room_id)
