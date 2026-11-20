from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base
from app.utils.helpers import utcnow


class Room(Base):
    __tablename__ = "rooms"

    id: Mapped[str] = mapped_column(String(12), primary_key=True)  # the room code, e.g. ABC123
    name: Mapped[str] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(String(200), default="")
    is_public: Mapped[bool] = mapped_column(Boolean, default=True)
    password_hash: Mapped[str | None] = mapped_column(String(300), nullable=True)
    invite_token: Mapped[str] = mapped_column(String(64))
    max_participants: Mapped[int] = mapped_column(Integer, default=10)
    is_locked: Mapped[bool] = mapped_column(Boolean, default=False)
    is_closed: Mapped[bool] = mapped_column(Boolean, default=False)
    chat_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    camera_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    screen_share_mode: Mapped[str] = mapped_column(String(16), default="hosts_only")  # everyone | hosts_only
    owner_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
