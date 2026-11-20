# End-to-end test (real browsers + real LiveKit)

`run.mjs` drives three isolated headless Chromium sessions (host, Alice, Bob) through the whole flow:
create room, join, stream a local movie, sync, co-host, chat, camera/mic, screen share, moderation, lock,
reconnect, end room. It uses a real `livekit-server --dev` (free, open source) and the built frontend served by FastAPI.

```bash
# 1. LiveKit dev server (download the binary from github.com/livekit/livekit/releases)
livekit-server --dev --bind 127.0.0.1
# 2. Backend serving the built frontend
cd frontend && npm run build && cd ../backend
LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  DATABASE_URL=sqlite:////tmp/e2e.db SECRET_KEY=$(python -c "import secrets;print(secrets.token_urlsafe(48))") \
  uvicorn app.main:app --port 8000
# 3. A test movie (VP8 + Opus WebM) at /tmp/e2e/movie.webm, e.g. with ffmpeg:
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=40 -f lavfi -i sine=frequency=440:duration=40 \
  -c:v libvpx -b:v 3M -c:a libopus -shortest /tmp/e2e/movie.webm
# 4. Run
cd e2e && npm install && node run.mjs
```
Paths inside `run.mjs` (`/tmp/e2e/...`, `http://127.0.0.1:8000`) are easy to change at the top.
