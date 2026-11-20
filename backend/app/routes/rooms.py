from datetime import timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_session_token, get_current_participant, rate_limit
from app.database.database import get_db
from app.models import Participant, Room
from app.schemas.room import JoinRequest, JoinResponse, RoomCreate, RoomDetail, RoomSummary
from app.services import livekit_service, permission_service as perms, room_service
from app.services.realtime import hub
from app.utils.helpers import utcnow

router = APIRouter(prefix="/api/rooms", tags=["rooms"])


def _join_response(room: Room, p: Participant) -> dict:
    return {
        "session_token": create_session_token(p.id, room.id),
        "participant": room_service.participant_public(p),
        "room": room_service.room_state(room),
        "invite_token": room_service.invite_token_for(room, p),
    }


@router.post("", response_model=JoinResponse, status_code=201, dependencies=[Depends(rate_limit("create", 6))])
async def create_room(data: RoomCreate, db: Session = Depends(get_db)):
    room, owner = room_service.create_room(db, data)
    hub.watch(room.id, owner.id, join_phase=True)
    return _join_response(room, owner)


@router.get("", response_model=list[RoomSummary])
async def list_public_rooms(db: Session = Depends(get_db)):
    rooms = db.scalars(
        select(Room).where(Room.is_public.is_(True), Room.is_closed.is_(False)).order_by(Room.created_at.desc()).limit(50)
    ).all()
    summaries = []
    for r in rooms:
        if settings.presence_enabled:
            online_count = len(hub.online_ids(r.id))
            if online_count == 0 and len(hub.joining.get(r.id, set())) > 0:
                online_count = len(hub.joining.get(r.id, set()))
            if online_count > 0:
                summary = room_service.room_summary(db, r)
                summary["participants_count"] = len(hub.online_ids(r.id)) or online_count
                summaries.append(summary)
        else:
            summary = room_service.room_summary(db, r)
            if summary["participants_count"] > 0:
                summaries.append(summary)
    return summaries


@router.get("/{room_id}", response_model=RoomDetail)
async def get_room(room_id: str, db: Session = Depends(get_db)):
    room = room_service.get_room_or_404(db, room_id)
    return {**room_service.room_summary(db, room), "is_public": room.is_public}


@router.post("/{room_id}/join", response_model=JoinResponse, dependencies=[Depends(rate_limit("join", 20))])
async def join_room(room_id: str, data: JoinRequest, db: Session = Depends(get_db)):
    room = room_service.get_room_or_404(db, room_id)
    participant = room_service.join_room(db, room, data)
    hub.watch(room.id, participant.id, join_phase=True)
    await hub.broadcast_roster(room.id)
    return _join_response(room, participant)


@router.post("/{room_id}/resume", response_model=JoinResponse)
async def resume(room_id: str, participant: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    """Take your seat back after a long disconnect (session token still valid, not kicked/banned)."""
    room = room_service.get_room_or_404(db, room_id)
    now = utcnow()
    rejoin_window = timedelta(seconds=settings.rejoin_window_seconds)
    seen = participant.last_seen or participant.joined_at
    if seen and seen.tzinfo is None:
        seen = seen.replace(tzinfo=timezone.utc)
    if participant.status == "left" or (seen and (now - seen) > rejoin_window):
        participant.status = "left"
        participant.left_at = now
        db.commit()
        raise HTTPException(401, "Your rejoin window has expired. Please join again.")

    if participant.status != "active":
        if room_service.active_count(db, room.id) >= room.max_participants and not perms.is_owner(participant):
            raise HTTPException(409, "This room is full.")
        participant.status = "active"
    participant.last_seen = now
    db.commit()
    hub.watch(room.id, participant.id, join_phase=True)
    await hub.broadcast_roster(room.id)
    return _join_response(room, participant)


@router.post("/{room_id}/away", status_code=204)
async def away_room(room_id: str, request: Request, db: Session = Depends(get_db)):
    token = None
    try:
        body = await request.json()
        if isinstance(body, dict):
            token = body.get("session_token")
    except Exception:
        try:
            raw = (await request.body()).decode()
            import json
            token = json.loads(raw).get("session_token")
        except Exception:
            pass
    if not token:
        return
    try:
        from app.core.security import participant_from_token
        p = participant_from_token(db, token, room_id)
    except Exception:
        return

    p.last_seen = utcnow()
    db.commit()
    await hub.mark_away(room_id, p.id)


@router.post("/{room_id}/leave", status_code=204)
async def leave_room(room_id: str, participant: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    participant.status = "left"
    participant.left_at = utcnow()
    db.commit()
    await hub.drop(room_id, participant.id, {"type": "left"}, code=1000)
    await hub.mark_left(room_id, participant.id)


@router.delete("/{room_id}", status_code=204)
async def end_room(room_id: str, participant: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    if not perms.is_owner(participant):
        raise HTTPException(403, "Only the room owner can end the room.")
    room = room_service.get_room_or_404(db, room_id)
    room.is_closed = True
    db.commit()
    await hub.close_room(room.id)
    await livekit_service.delete_room(room.id)
