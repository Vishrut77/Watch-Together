# WatchTogether frontend

Vanilla JS (ES modules) + Vite. The only runtime dependency is `livekit-client`.

```bash
npm install
npm run dev      # http://localhost:5173, proxies /api, /ws and /health to FastAPI on :8000
npm run build    # -> dist/
```

`VITE_API_BASE_URL` (build time): leave empty when FastAPI serves the frontend or in `npm run dev`;
set to your backend URL when hosting the frontend elsewhere (Netlify).

| File | Job |
|---|---|
| `js/app.js` | router, landing / create / join / invite gate |
| `js/api.js` | REST client, device id, saved sessions |
| `js/room.js` | the room: websocket, layout, participant strip |
| `js/livekit.js` | all WebRTC: camera, mic, screen share, movie publishing, stats |
| `js/player.js` | theatre player: local file, capture, fallback, sync, controls |
| `js/chat.js`, `js/controls.js` | chat, dock, devices, people, room controls |
