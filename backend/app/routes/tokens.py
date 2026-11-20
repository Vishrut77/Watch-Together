from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import get_current_participant, rate_limit
from app.database.database import get_db
from app.models import Participant
from app.schemas.participant import ParticipantPublic
from app.schemas.room import TokenResponse
from app.services import livekit_service, room_service
from app.services.realtime import hub

router = APIRouter(prefix="/api/rooms", tags=["livekit"])


@router.post("/{room_id}/token", response_model=TokenResponse, dependencies=[Depends(rate_limit("token", 40))])
async def livekit_token(room_id: str, participant: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    """Short-lived LiveKit token. Publish rights come from the backend's view of the participant's role."""
    room = room_service.get_room_or_404(db, room_id)
    if participant.status != "active":
        raise HTTPException(403, "You are not in this room right now. Rejoin first.")
    token, ttl = livekit_service.create_access_token(room, participant)
    return {"token": token, "url": settings.livekit_url, "identity": participant.id, "expires_in": ttl}


@router.get("/{room_id}/participants", response_model=list[ParticipantPublic])
async def list_participants(room_id: str, participant: Participant = Depends(get_current_participant), db: Session = Depends(get_db)):
    return room_service.roster(db, room_id, hub.online_ids(room_id), hub.hands.get(room_id, set()))
