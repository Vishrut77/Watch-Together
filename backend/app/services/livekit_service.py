"""Everything that talks to LiveKit. Failures are logged and reported, never fatal."""
import logging
from datetime import timedelta

from fastapi import HTTPException
from livekit import api
from livekit.protocol import models as lk_models

from app.core.config import settings
from app.models import Participant, Room
from app.services import permission_service as perms

log = logging.getLogger("watchtogether.livekit")

_SOURCE_ENUM = {
    "camera": lk_models.TrackSource.CAMERA,
    "microphone": lk_models.TrackSource.MICROPHONE,
    "screen_share": lk_models.TrackSource.SCREEN_SHARE,
    "screen_share_audio": lk_models.TrackSource.SCREEN_SHARE_AUDIO,
}


def lk_room_name(room: Room | str) -> str:
    return f"wt-{room if isinstance(room, str) else room.id}"


def create_access_token(room: Room, participant: Participant) -> tuple[str, int]:
    if not settings.livekit_configured:
        raise HTTPException(
            503,
            "Media server is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the backend.",
        )
    ttl = timedelta(minutes=settings.livekit_token_ttl_minutes)
    grants = api.VideoGrants(
        room_join=True,
        room=lk_room_name(room),
        can_subscribe=True,
        can_publish=True,
        can_publish_data=False,  # chat / sync run through the authenticated FastAPI socket
        can_publish_sources=perms.livekit_sources(room, participant),
    )
    token = (
        api.AccessToken(settings.livekit_api_key, settings.livekit_api_secret)
        .with_identity(participant.id)
        .with_name(participant.nickname)
        .with_grants(grants)
        .with_ttl(ttl)
        .to_jwt()
    )
    return token, int(ttl.total_seconds())


async def _call(fn) -> bool:
    if not settings.livekit_configured:
        return False
    try:
        async with api.LiveKitAPI(settings.livekit_http_url, settings.livekit_api_key, settings.livekit_api_secret) as lk:
            await fn(lk)
        return True
    except Exception as exc:  # participant may simply not be connected to media yet
        log.warning("LiveKit call failed: %s", exc)
        return False


async def update_permissions(room: Room, participant: Participant) -> bool:
    """Push the participant's current publish rights to the live LiveKit session."""
    permission = lk_models.ParticipantPermission(
        can_subscribe=True,
        can_publish=True,
        can_publish_data=False,
        can_publish_sources=[_SOURCE_ENUM[s] for s in perms.livekit_sources(room, participant)],
    )
    return await _call(
        lambda lk: lk.room.update_participant(
            api.UpdateParticipantRequest(room=lk_room_name(room), identity=participant.id, permission=permission)
        )
    )


async def mute_microphone(room_id: str, identity: str) -> bool:
    async def run(lk):
        info = await lk.room.get_participant(api.RoomParticipantIdentity(room=lk_room_name(room_id), identity=identity))
        for track in info.tracks:
            if track.source == lk_models.TrackSource.MICROPHONE and not track.muted:
                await lk.room.mute_published_track(
                    api.MuteRoomTrackRequest(room=lk_room_name(room_id), identity=identity, track_sid=track.sid, muted=True)
                )

    return await _call(run)


async def remove_participant(room_id: str, identity: str) -> bool:
    return await _call(
        lambda lk: lk.room.remove_participant(api.RoomParticipantIdentity(room=lk_room_name(room_id), identity=identity))
    )


async def delete_room(room_id: str) -> bool:
    return await _call(lambda lk: lk.room.delete_room(api.DeleteRoomRequest(room=lk_room_name(room_id))))
