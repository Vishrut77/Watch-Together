from pydantic import BaseModel


class ChatOut(BaseModel):
    id: int
    participant_id: str
    nickname: str
    role: str
    kind: str
    text: str
    ts: int  # unix ms
