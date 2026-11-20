from typing import Literal

from pydantic import BaseModel, Field

Permission = Literal[
    "manage_playback",
    "stream_movie",
    "manage_screen_share",
    "mute_participants",
    "remove_participants",
    "manage_settings",
]


class ParticipantPublic(BaseModel):
    id: str
    nickname: str
    role: str
    permissions: list[str] = []
    online: bool = False
    hand_raised: bool = False


class PermissionUpdate(BaseModel):
    permissions: list[Permission] = Field(min_length=1)
