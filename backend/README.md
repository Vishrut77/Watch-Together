# WatchTogether backend (FastAPI)

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # then fill it in (see comments inside)
uvicorn app.main:app --reload --port 8000
pytest                                                 # 48 tests: auth, roles, moderation, sockets, presence
```

Interactive API docs: http://localhost:8000/docs

**Design notes**
- Identity: no accounts. Joining returns a signed session token; every REST call and the WebSocket check it against the DB.
  Roles/permissions live only in the database. The browser can't claim a role.
- Realtime: one authenticated WebSocket per participant (`/ws/rooms/{id}?token=...`) carries chat, reactions, hands,
  announcements, playback sync and live updates. Media goes through LiveKit.
- LiveKit tokens: short-lived, with `canPublishSources` computed from the role and room settings; changes
  (camera off, screen-share mode, co-host grants) are pushed to live sessions through the LiveKit server API.
- Run **one** worker process: connection state is in memory (fine for friend-sized rooms).
- Tables are created on startup (`create_all`); there is no migration tool.
