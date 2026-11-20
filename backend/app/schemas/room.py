from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.schemas.participant import ParticipantPublic
from app.utils.helpers import clean_text


def _non_empty(value: str, max_len: int, label: str) -> str:
    cleaned = clean_text(value, max_len)
    if not cleaned:
        raise ValueError(f"{label} can't be empty")
    return cleaned


class RoomCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default="", max_length=200)
    is_public: bool = True
    password: str | None = Field(default=None, min_length=4, max_length=64)
    max_participants: int = Field(default=10, ge=2, le=50)
    nickname: str = Field(min_length=1, max_length=24)
    client_id: str = Field(min_length=8, max_length=64)

    @field_validator("name")
    @classmethod
    def _name(cls, v):
        return _non_empty(v, 60, "Room name")

    @field_validator("nickname")
    @classmethod
    def _nick(cls, v):
        return _non_empty(v, 24, "Nickname")

    @field_validator("description")
    @classmethod
    def _desc(cls, v):
        return clean_text(v, 200)


class JoinRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=24)
    client_id: str = Field(min_length=8, max_length=64)
    password: str | None = Field(default=None, max_length=64)
    invite_token: str | None = Field(default=None, max_length=64)

    @field_validator("nickname")
    @classmethod
    def _nick(cls, v):
        return _non_empty(v, 24, "Nickname")


class SettingsUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    description: str | None = Field(default=None, max_length=200)
    is_public: bool | None = None
    chat_enabled: bool | None = None
    camera_enabled: bool | None = None
    screen_share_mode: Literal["everyone", "hosts_only"] | None = None
    max_participants: int | None = Field(default=None, ge=2, le=50)
    password: str | None = Field(default=None, min_length=4, max_length=64)
    clear_password: bool = False


class RoomSummary(BaseModel):
    id: str
    name: str
    description: str
    participants_count: int
    max_participants: int
    has_password: bool
    is_locked: bool


class RoomDetail(RoomSummary):
    is_public: bool


class RoomState(BaseModel):
    id: str
    name: str
    description: str
    is_public: bool
    is_locked: bool
    chat_enabled: bool
    camera_enabled: bool
    screen_share_mode: str
    max_participants: int
    has_password: bool


class JoinResponse(BaseModel):
    session_token: str
    participant: ParticipantPublic
    room: RoomState
    invite_token: str | None = None  # only owner / co-hosts with settings access get this


class TokenResponse(BaseModel):
    token: str
    url: str
    identity: str
    expires_in: int
