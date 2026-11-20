# WatchTogether

A virtual movie theatre in the browser. One person creates a room and plays a movie **from their own computer**;
friends join by link or code and watch it live, with chat, cameras, microphones, screen sharing, reactions and
host moderation. Nothing is uploaded. No accounts.

- Frontend: HTML/CSS/vanilla JS (Vite), LiveKit JS SDK
- Backend: FastAPI, Pydantic, SQLAlchemy (SQLite, PostgreSQL supported)
- Media: WebRTC via a LiveKit SFU

## Everything here is free: what that really means

| Piece | Free option | Catch |
|---|---|---|
| Backend code, DB | SQLite, or a free hosted Postgres | Free hosts sleep / reset disks |
| Media server | **LiveKit Cloud "Build" plan** (no card) **or** self-hosted open-source `livekit-server` | Cloud plan has monthly caps (see below) |
| Frontend hosting | Netlify free tier | |
| Public URL for your own PC | Cloudflare Tunnel quick tunnel (no account) | URL changes on each start |

**Watch the LiveKit Cloud cap.** At the time of writing the free Build plan is documented as roughly
5,000 participant-minutes and 50 GB of egress per month, with a hard limit (no surprise bill). Check
https://livekit.com/pricing for the current numbers. Every viewer downloads the movie, so egress is what you hit first:
1080p at the "Best" preset is up to ~6 Mbps ≈ 2.7 GB per viewer-hour; "Balanced" (3 Mbps) is ≈ 1.3 GB and
"Data saver" (1.2 Mbps) ≈ 0.5 GB. Pick the preset with the slider icon on the player. Viewers on weak networks
are also automatically given smaller layers. If you outgrow the cap, self-host `livekit-server` (below).

## Quick start (Windows 1-Click)

On Windows, double-click **`run.bat`** (or execute `.\run.bat` in PowerShell / Command Prompt).
The launcher automatically:
1. Sets up the Python virtual environment (`backend\.venv`) and installs `backend\requirements.txt`.
2. Generates your local `backend\.env` from `.env.example` if not already present.
3. Builds the production frontend assets into `frontend\dist`.
4. Prompts you to launch:
   - **[1] Mode B (Recommended)**: Runs FastAPI serving the frontend + Cloudflare Tunnel so friends can join with one link.
   - **[2] Localhost Only**: Runs FastAPI on port 8000 for local testing.
   - **[3] Dev Mode**: Runs FastAPI (:8000) with hot reload + Vite (:5173).

To stop all background processes at any time, double-click **`stop.bat`**.

---

## Manual setup from scratch

### 1. LiveKit credentials
Sign up free at https://cloud.livekit.io, create a project, and copy your WebSocket URL, API Key, and API Secret. (Or run a local open-source `livekit-server --dev`).

### 2. Backend
```bash
cd backend
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env     # fill in your LIVEKIT_* keys and a random SECRET_KEY
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend
```bash
cd frontend
npm install
npm run dev              # opens http://localhost:5173 (proxies API calls to :8000)
```
*Note: Camera, mic, and screen capture require `localhost` or HTTPS. Plain `http://192.168.x.x` will not work.*

---

## Mode B: Host on your PC, friends join via Cloudflare Tunnel (free, zero account)

```bash
cd frontend && npm install && npm run build                 # creates frontend/dist
cd ../backend && uvicorn app.main:app --host 0.0.0.0 --port 8000     # serves API + frontend on one origin
cloudflared tunnel --url http://localhost:8000              # prints https://<random>.trycloudflare.com
```
Send friends that URL. Install `cloudflared` from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.
No code or config change is needed: same-origin means no CORS setup and the frontend uses relative URLs.
The tunnel carries HTTP and WebSocket traffic. WebRTC media flows directly through LiveKit Cloud.

---

## Mode A: Public Deployment

1. **LiveKit**: LiveKit Cloud free plan.
2. **Backend**: Any ASGI host (Render, Fly.io, Railway, etc.):
   - Build: `pip install -r backend/requirements.txt`
   - Start: `cd backend && uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - Env vars: `APP_ENV=production`, `SECRET_KEY`, `LIVEKIT_*`, `CORS_ORIGINS=https://your-site.netlify.app`, `DATABASE_URL` (free Postgres like Neon or Supabase).
3. **Frontend**: Netlify (`netlify.toml` included). Set `VITE_API_BASE_URL=https://your-backend.onrender.com`.

---

## Self-hosting LiveKit (optional, free, more work)

`livekit-server` is open source. `livekit-server --dev` (key `devkey`, secret `secret`, `LIVEKIT_URL=ws://localhost:7880`)
is perfect for testing on one machine. For friends on the internet:
- Serve signaling over **wss://** (put Caddy/nginx with a TLS certificate in front of port 7880),
- Open **TCP 7881** and the **UDP port range** (or UDP mux port) on your firewall, set `rtc.use_external_ip: true`,
- Enable built-in **TURN** for restrictive networks.
See https://docs.livekit.io/home/self-hosting/deployment/.

---

## Playback Tiers & Video Formats

WatchTogether uses a tiered playback architecture to play virtually any video file:
- **Tier 0 (Instant Native Browser)**: Direct HTML5 playback for standard MP4 (H.264 + AAC) and WebM (VP8/VP9 + Opus).
- **Tier 1 (Smart Local Companion)**: Automatically detects incompatible containers (`.mkv`, `.avi`, `.mov`) or surround audio (AC3/E-AC3/DTS/TrueHD 5.1 downmix). Chooses the cheapest plan (`-c copy` remux → `-c:v copy -c:a aac` audio-only transcode → hardware accelerated `h264_nvenc`/`qsv`/`amf` transcode) and streams HLS fMP4 segments so playback begins immediately with seek clamping.
- **Tier 2 (Headless FFmpeg Movie Bot)**: Local fallback bot that streams files directly into LiveKit as synthetic WebRTC tracks (`movie` and `movie-audio`) using FFmpeg with fast input seeking (`-ss` before `-i`), WebRTC frame holding during seeks, dynamic audio track switching, subtitle burn-in (`libass`), and an integrated OS file picker with Cloudflare Tunnel security protection.
- **Local Sync Mode**: Zero video upload mode where friends with identical local copies of a file watch in perfect lockstep via SHA-256 fingerprint matching and timestamp sync.

---

## Security

- Hashed room passwords (scrypt) and unguessable invite tokens.
- Signed session tokens validated on every REST route and WebSocket message.
- Short-lived LiveKit access tokens with scoped per-participant publish permissions.
- Rate limiting and chat / reaction burst throttling.
- Cloudflare Tunnel protection on local picker endpoints (`CF-Connecting-IP` and `X-Forwarded-For` inspection).
- No secrets committed to source control (templates provided in `.env.example`).

---
