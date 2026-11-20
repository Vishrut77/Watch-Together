from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database.database import Base
from app.utils.helpers import utcnow


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    room_id: Mapped[str] = mapped_column(ForeignKey("rooms.id"), index=True)
    participant_id: Mapped[str] = mapped_column(String(32))
    nickname: Mapped[str] = mapped_column(String(24))
    role: Mapped[str] = mapped_column(String(12), default="participant")
    kind: Mapped[str] = mapped_column(String(14), default="chat")  # chat | announcement
    text: Mapped[str] = mapped_column(String(500))
    mentions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
