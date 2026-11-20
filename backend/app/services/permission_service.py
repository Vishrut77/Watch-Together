"""Every authorization decision in one place. The frontend never decides anything."""
from app.models import Participant, Room

PERMISSIONS = (
    "manage_playback",
    "stream_movie",
    "manage_screen_share",
    "mute_participants",
    "remove_participants",
    "manage_settings",
)


def is_owner(p: Participant) -> bool:
    return p.role == "owner"


def is_host_side(p: Participant) -> bool:
    return p.role in ("owner", "cohost")


def has_permission(p: Participant, perm: str) -> bool:
    if p.role == "owner":
        return True
    return p.role == "cohost" and perm in (p.permissions or [])


def can_moderate(actor: Participant, target: Participant) -> bool:
    """Owner can act on anyone else; a co-host only on plain participants."""
    if actor.id == target.id or target.role == "owner":
        return False
    if actor.role == "owner":
        return True
    return target.role == "participant"


def can_chat(room: Room, p: Participant) -> bool:
    return room.chat_enabled or is_host_side(p)


def can_use_camera(room: Room, p: Participant) -> bool:
    return room.camera_enabled or is_host_side(p)


def can_share_screen(room: Room, p: Participant) -> bool:
    if room.screen_share_mode == "everyone":
        return True
    return is_host_side(p)


def livekit_sources(room: Room, p: Participant) -> list[str]:
    sources = ["microphone"]
    if can_use_camera(room, p):
        sources.append("camera")
    if can_share_screen(room, p) or has_permission(p, "stream_movie"):
        sources += ["screen_share", "screen_share_audio"]
    return sources
