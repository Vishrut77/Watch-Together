"""Local filesystem picker and directory browser for host PC streaming.

Strictly protects against unauthorized access, traversal attacks, and Cloudflare tunnel
bypass by validating session tokens, permissions, host origin, and tunnel headers.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field as PydanticField
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import participant_from_token
from app.database.database import get_db
from app.services import permission_service as perms, room_service
from app.services.media_service import find_ffmpeg, probe_file

log = logging.getLogger("watchtogether.local")

router = APIRouter(prefix="/api/local", tags=["local"])

# Allowed extensions
ALLOWED_VIDEO_EXTS = {
    ".mp4", ".mkv", ".webm", ".avi", ".mov", ".wmv", ".flv",
    ".m4v", ".ts", ".mts", ".m2ts", ".vob", ".ogv", ".3gp",
}

ALLOWED_SUBTITLE_EXTS = {
    ".srt", ".ass", ".vtt", ".sub",
}

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient", "testserver"}


@dataclass
class RegisteredFile:
    file_id: str
    path: Path
    filename: str
    size: int
    duration: float
    probe: dict[str, Any]
    created_at: float = field(default_factory=lambda: asyncio.get_event_loop().time() if asyncio.get_event_loop().is_running() else 0.0)


class FileRegistry:
    def __init__(self) -> None:
        self._files: dict[str, RegisteredFile] = {}
        self._last_folder: Optional[Path] = None
        self._recent_files: list[dict[str, Any]] = []

    def get(self, file_id: str) -> Optional[RegisteredFile]:
        return self._files.get(file_id)

    def register(self, p: Path, probe: dict[str, Any]) -> RegisteredFile:
        fid = str(uuid.uuid4())
        size = p.stat().st_size if p.exists() else 0
        dur = float(probe.get("duration") or 0.0)
        reg = RegisteredFile(
            file_id=fid,
            path=p,
            filename=p.name,
            size=size,
            duration=dur,
            probe=probe,
        )
        self._files[fid] = reg
        self._last_folder = p.parent

        # Update recent files (unique by path, keep top 10)
        p_str = str(p.resolve())
        self._recent_files = [r for r in self._recent_files if r.get("real_path") != p_str]
        self._recent_files.insert(0, {
            "file_id": fid,
            "filename": p.name,
            "size": size,
            "duration": dur,
            "real_path": p_str,
            "parent_folder": str(p.parent),
        })
        if len(self._recent_files) > 10:
            self._recent_files.pop()

        return reg

    def get_last_folder(self) -> Optional[Path]:
        return self._last_folder

    def get_recent(self) -> list[dict[str, Any]]:
        return list(self._recent_files)


file_registry = FileRegistry()


def _extract_token(request: Request, token_q: str | None) -> str:
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (token_q or "").strip()


def verify_direct_host_request(request: Request) -> None:
    """Ensure the request is coming directly from the host's own local browser session.
    
    Cloudflare Tunnel and reverse proxies pass traffic to 127.0.0.1, so checking
    request.client.host alone is NOT safe. We inspect proxy and tunnel headers:
    if CF-Connecting-IP or X-Forwarded-For indicates an external client, reject immediately.
    """
    # 1. Check Cloudflare header
    cf_ip = (request.headers.get("cf-connecting-ip") or "").strip()
    if cf_ip and cf_ip not in _LOCAL_HOSTS:
        raise HTTPException(
            status_code=403,
            detail="Local file access is forbidden through external Cloudflare tunnels.",
        )

    # 2. Check X-Forwarded-For header
    xff = request.headers.get("x-forwarded-for") or ""
    if xff:
        for ip in xff.split(","):
            clean_ip = ip.strip().strip("[]").lower()
            if clean_ip and clean_ip not in _LOCAL_HOSTS and not clean_ip.startswith("::ffff:127.0.0.1"):
                raise HTTPException(
                    status_code=403,
                    detail="Local file access is forbidden through external proxies.",
                )

    # 3. Check client host
    if settings.app_env != "test":
        client_host = (request.client.host if request.client else "").strip("[]").lower()
        if client_host and client_host not in _LOCAL_HOSTS and not client_host.startswith("::ffff:127.0.0.1"):
            raise HTTPException(
                status_code=403,
                detail="Local file access is only available directly on localhost.",
            )


def require_local_streamer(
    request: Request,
    db: Session,
    room_id: str,
    token: str,
):
    """Authenticate session token, verify caller is owner or holds stream_movie permission."""
    verify_direct_host_request(request)

    code = room_service.normalize_code(room_id)
    if not token:
        raise HTTPException(status_code=401, detail="Authentication token required.")
    p = participant_from_token(db, token, code)
    if p.status != "active":
        raise HTTPException(status_code=403, detail="Participant is not active.")
    if not (perms.is_owner(p) or perms.has_permission(p, "stream_movie")):
        raise HTTPException(status_code=403, detail="Permission 'stream_movie' or room owner required.")
    return code, p


def validate_file_path(raw_path: str, allow_subtitles: bool = False) -> Path:
    """Validate that path exists, is a regular file, has allowed extension, and is not a UNC path."""
    if not raw_path or not raw_path.strip():
        raise HTTPException(status_code=400, detail="File path cannot be empty.")

    clean_path = raw_path.strip()
    # Reject UNC paths (\\server\share or //server/share)
    if clean_path.startswith(r"\\") or clean_path.startswith("//"):
        raise HTTPException(status_code=400, detail="UNC and network share paths are not allowed.")

    try:
        resolved = Path(os.path.realpath(os.path.expanduser(clean_path)))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid path syntax: {exc}")

    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {clean_path}")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a regular file.")

    ext = resolved.suffix.lower()
    allowed = ALLOWED_VIDEO_EXTS.union(ALLOWED_SUBTITLE_EXTS) if allow_subtitles else ALLOWED_VIDEO_EXTS
    if ext not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file extension '{ext}'. Allowed: {', '.join(sorted(allowed))}",
        )

    return resolved


class PickFileIn(BaseModel):
    room_id: str = PydanticField(..., min_length=1, max_length=20)
    token: Optional[str] = None
    file_type: Optional[str] = "video"  # "video" or "subtitle"


class SelectFileIn(BaseModel):
    room_id: str = PydanticField(..., min_length=1, max_length=20)
    path: str = PydanticField(..., min_length=1)
    token: Optional[str] = None
    file_type: Optional[str] = "video"


@router.post("/pick-file")
async def pick_file_native(
    body: PickFileIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Open native OS file picker dialog on host PC via short-lived subprocess.
    
    Uses tkinter.filedialog.askopenfilename with topmost window and 5-minute timeout.
    Does NOT run in the FastAPI event loop or worker thread.
    """
    token = _extract_token(request, body.token)
    code, p = require_local_streamer(request, db, body.room_id, token)

    last_folder = file_registry.get_last_folder()
    initial_dir = str(last_folder) if last_folder and last_folder.exists() else ""

    allow_sub = body.file_type == "subtitle"

    # Subprocess script to invoke tkinter safely
    tk_script = """
import sys, json
try:
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes('-topmost', True)
    root.lift()
    root.focus_force()
    initialdir = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
    ftype = sys.argv[2] if len(sys.argv) > 2 else "video"
    if ftype == "subtitle":
        filetypes = [('Subtitle files', '*.srt *.ass *.vtt *.sub'), ('All files', '*.*')]
        title = 'Select Subtitle File'
    else:
        filetypes = [
            ('Video files', '*.mp4 *.mkv *.avi *.mov *.webm *.m4v *.ts *.flv *.wmv *.mpg *.m2ts'),
            ('All files', '*.*'),
        ]
        title = 'Select Video File (WatchTogether)'
    path = filedialog.askopenfilename(parent=root, title=title, initialdir=initialdir, filetypes=filetypes)
    root.destroy()
    print(json.dumps({'status': 'ok', 'path': path}))
except Exception as e:
    print(json.dumps({'status': 'error', 'error': str(e)}))
"""

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-c",
            tk_script,
            initial_dir,
            "subtitle" if allow_sub else "video",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=300.0)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return {"status": "timeout", "fallback_required": True, "detail": "File dialog timed out."}
    except Exception as exc:
        log.warning("Tkinter subprocess execution failed: %s", exc)
        return {"status": "error", "fallback_required": True, "detail": str(exc)}

    out_text = stdout.decode("utf-8", errors="replace").strip()
    try:
        res_data = json.loads(out_text) if out_text else {}
    except Exception:
        res_data = {"status": "error", "error": out_text or stderr.decode("utf-8", errors="replace")}

    if res_data.get("status") != "ok":
        log.info("Native file picker unavailable (%s), triggering server-side browser fallback.", res_data.get("error"))
        return {
            "status": "fallback",
            "fallback_required": True,
            "error": res_data.get("error", "Native picker unavailable"),
        }

    chosen_path = res_data.get("path")
    if not chosen_path:
        return {"status": "cancelled"}

    resolved = validate_file_path(chosen_path, allow_subtitles=allow_sub)
    try:
        probe = await asyncio.to_thread(probe_file, resolved)
    except Exception as exc:
        probe = {"error": str(exc), "duration": 0.0}

    reg = file_registry.register(resolved, probe)
    return {
        "status": "selected",
        "file_id": reg.file_id,
        "filename": reg.filename,
        "duration": reg.duration,
        "probe": reg.probe,
    }


@router.get("/browse")
async def browse_folder(
    room_id: str = Query(..., min_length=1, max_length=20),
    path: Optional[str] = Query(default=None),
    file_type: Optional[str] = Query(default="video"),
    token: Optional[str] = Query(default=None),
    request: Request = None,
    db: Session = Depends(get_db),
):
    """Built-in server-side folder browser fallback.
    
    Lists drives/folders and video/subtitle files only. Never exposes non-media files.
    Includes breadcrumbs and recent files list.
    """
    tok = _extract_token(request, token)
    code, p = require_local_streamer(request, db, room_id, tok)

    allow_sub = file_type == "subtitle"
    allowed_exts = ALLOWED_VIDEO_EXTS.union(ALLOWED_SUBTITLE_EXTS) if allow_sub else ALLOWED_VIDEO_EXTS

    # Determine current target directory
    target_dir: Path
    if path and path.strip():
        clean = path.strip()
        if clean.startswith(r"\\") or clean.startswith("//"):
            raise HTTPException(status_code=400, detail="UNC paths are not allowed.")
        target_dir = Path(os.path.realpath(os.path.expanduser(clean)))
    else:
        last = file_registry.get_last_folder()
        if last and last.exists() and last.is_dir():
            target_dir = last
        else:
            target_dir = Path.home()

    if not target_dir.exists() or not target_dir.is_dir():
        target_dir = Path.home()

    # Discover drives on Windows
    drives: list[str] = []
    if sys.platform == "win32":
        import string
        for letter in string.ascii_uppercase:
            drv = f"{letter}:\\"
            if os.path.exists(drv):
                drives.append(drv)

    # Breadcrumbs
    breadcrumbs: list[dict[str, str]] = []
    curr = target_dir
    parts = []
    while curr != curr.parent:
        parts.append({"name": curr.name or str(curr), "path": str(curr)})
        curr = curr.parent
    if curr:
        parts.append({"name": str(curr), "path": str(curr)})
    breadcrumbs = list(reversed(parts))

    # Read directory contents: directories and allowed media files only
    folders: list[dict[str, str]] = []
    files: list[dict[str, Any]] = []

    try:
        with os.scandir(target_dir) as entries:
            for entry in entries:
                try:
                    if entry.is_dir(follow_symlinks=False):
                        if not entry.name.startswith((".", "$")):
                            folders.append({
                                "name": entry.name,
                                "path": str(Path(entry.path).resolve()),
                            })
                    elif entry.is_file(follow_symlinks=False):
                        ext = Path(entry.name).suffix.lower()
                        if ext in allowed_exts:
                            st = entry.stat()
                            files.append({
                                "name": entry.name,
                                "path": str(Path(entry.path).resolve()),
                                "size": st.st_size,
                                "ext": ext,
                            })
                except (PermissionError, OSError):
                    continue
    except (PermissionError, OSError) as exc:
        raise HTTPException(status_code=403, detail=f"Permission denied accessing folder: {exc}")

    folders.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: x["name"].lower())

    parent_path = str(target_dir.parent) if target_dir.parent != target_dir else None

    return {
        "current_path": str(target_dir),
        "parent_path": parent_path,
        "drives": drives,
        "breadcrumbs": breadcrumbs,
        "folders": folders,
        "files": files,
        "recent": file_registry.get_recent(),
    }


@router.post("/select-file")
async def select_file(
    body: SelectFileIn,
    request: Request,
    db: Session = Depends(get_db),
):
    """Register a chosen path (from folder browser or typed/pasted input) and return opaque file_id."""
    token = _extract_token(request, body.token)
    code, p = require_local_streamer(request, db, body.room_id, token)

    allow_sub = body.file_type == "subtitle"
    resolved = validate_file_path(body.path, allow_subtitles=allow_sub)

    try:
        probe = await asyncio.to_thread(probe_file, resolved)
    except Exception as exc:
        probe = {"error": str(exc), "duration": 0.0}

    reg = file_registry.register(resolved, probe)
    return {
        "status": "selected",
        "file_id": reg.file_id,
        "filename": reg.filename,
        "duration": reg.duration,
        "probe": reg.probe,
    }

