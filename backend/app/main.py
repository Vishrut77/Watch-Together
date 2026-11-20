import asyncio
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.database.database import init_db
from app.routes import local, media, moderation, participants, rooms, tokens, ws
from app.services.media_service import media_service
from app.services.movie_bot import movie_bot_manager

log = logging.getLogger("watchtogether")


async def run_lifecycle_cleaner():
    from app.database.database import SessionLocal
    from app.services import room_service

    while True:
        await asyncio.sleep(30)
        try:
            with SessionLocal() as db:
                await room_service.cleanup_abandoned_rooms(db)
        except Exception as exc:
            log.warning("Lifecycle cleaner error: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.is_production and settings.secret_key == "change-this-secret":
        raise RuntimeError("Refusing to start in production with the default SECRET_KEY. Set SECRET_KEY.")
    init_db()
    media_service.cleanup_all()
    await movie_bot_manager.cleanup_all()
    if not settings.livekit_configured:
        log.warning("LiveKit is not configured - rooms work, but media (video/audio) will not until LIVEKIT_* is set.")

    cleaner_task = None
    if settings.app_env != "test":
        cleaner_task = asyncio.create_task(run_lifecycle_cleaner())

    try:
        yield
    finally:
        media_service.cleanup_all()
        await movie_bot_manager.cleanup_all()
        if cleaner_task:
            cleaner_task.cancel()
            try:
                await cleaner_task
            except (asyncio.CancelledError, Exception):
                pass


app = FastAPI(title="WatchTogether API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_list,
    allow_credentials=False,  # bearer tokens, no cookies
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    # Friendly one-line message for the UI instead of a raw pydantic dump
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(x) for x in first.get("loc", [])[1:]) or "request"
    message = str(first.get("msg", "Invalid input")).removeprefix("Value error, ")
    return JSONResponse(status_code=422, content={"detail": f"{field}: {message}"})


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("Unhandled error on %s", request.url.path)  # details stay in the server log
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on our side. Please try again."})


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok", "livekit_configured": settings.livekit_configured, "env": settings.app_env}


@app.get("/api/config", tags=["health"])
async def public_config(request: Request):
    """Non-secret info the frontend can use."""
    return {
        "livekit_configured": settings.livekit_configured,
        "local_transcode": media.capabilities_local(request),
    }


app.include_router(rooms.router)
app.include_router(tokens.router)
app.include_router(participants.router)
app.include_router(moderation.router)
app.include_router(ws.router)
app.include_router(media.router)
app.include_router(local.router)

# ---- Optional: serve the built frontend (local / Cloudflare Tunnel mode) ----
_dist = Path(settings.frontend_dist)
if not _dist.is_absolute():
    _dist = (Path(__file__).resolve().parent.parent / _dist).resolve()

if (_dist / "index.html").exists():
    if (_dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        if full_path.startswith(("api/", "ws/")):
            raise HTTPException(404, "Not found")
        candidate = (_dist / full_path).resolve()
        if full_path and candidate.is_file() and _dist in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
