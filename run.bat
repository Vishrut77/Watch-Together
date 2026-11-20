@echo off
title WatchTogether Launcher
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ======================================================================
echo                         WatchTogether
echo ======================================================================
echo.

:: 1. Ensure Python Virtual Environment exists
if not exist "backend\.venv\Scripts\uvicorn.exe" (
    echo [*] Setting up Python virtual environment in backend\.venv...
    python -m venv backend\.venv
    call backend\.venv\Scripts\pip install -r backend\requirements.txt
)

:: 2. Ensure backend .env exists
if not exist "backend\.env" (
    echo [!] backend\.env not found! Creating from .env.example...
    copy backend\.env.example backend\.env >nul
    echo [!] Generated default .env. Please make sure LIVEKIT_* keys are filled in.
)

:: 3. Ensure frontend production build exists
if not exist "frontend\dist\index.html" (
    echo [*] Building frontend assets...
    cd frontend
    call npm.cmd install
    call npm.cmd run build
    cd /d "%~dp0"
)

:: 4. Locate cloudflared
set "CF_CMD=cloudflared"
where cloudflared >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%~dp0.tools\cloudflared.exe" (
        set "CF_CMD=%~dp0.tools\cloudflared.exe"
    )
)

echo Please choose how to run WatchTogether:
echo.
echo   [1] Mode B: Run with Cloudflare Tunnel (Recommended - for you and friends)
echo   [2] Localhost Only (FastAPI serving built frontend on port 8000)
echo   [3] Development Mode (FastAPI :8000 + Vite :5173 hot reloading)
echo.
set /p CHOICE="Enter option [1-3] (Default is 1): "
if "%CHOICE%"=="" set CHOICE=1

if "%CHOICE%"=="1" goto opt_tunnel
if "%CHOICE%"=="2" goto opt_local
if "%CHOICE%"=="3" goto opt_dev
goto opt_tunnel

:opt_tunnel
echo.
echo [*] Starting FastAPI Backend on http://0.0.0.0:8000 ...
start "WatchTogether - Backend Server" cmd /k "cd /d "%~dp0backend" && ".\.venv\Scripts\uvicorn.exe" app.main:app --host 0.0.0.0 --port 8000"
timeout /t 2 /nobreak >nul

echo [*] Starting Cloudflare Tunnel...
start "WatchTogether - Cloudflare Tunnel" cmd /k "echo ======================================================== && echo Copy the https://...trycloudflare.com link below for friends: && echo ======================================================== && "%CF_CMD%" tunnel --url http://localhost:8000"
timeout /t 3 /nobreak >nul

echo [*] Opening local browser...
start http://localhost:8000
echo.
echo ======================================================================
echo WatchTogether and Cloudflare Tunnel are now running!
echo Copy the https://...trycloudflare.com link from the tunnel window.
echo To stop everything, close both windows or double-click stop.bat.
echo ======================================================================
pause
exit /b

:opt_local
echo.
echo [*] Starting FastAPI Backend on http://localhost:8000 ...
start "WatchTogether - Backend Server" cmd /k "cd /d "%~dp0backend" && ".\.venv\Scripts\uvicorn.exe" app.main:app --host 0.0.0.0 --port 8000"
timeout /t 2 /nobreak >nul

echo [*] Opening browser...
start http://localhost:8000
echo.
echo ======================================================================
echo WatchTogether is running at http://localhost:8000
echo To stop, close the backend window or double-click stop.bat.
echo ======================================================================
pause
exit /b

:opt_dev
echo.
echo [*] Starting Backend (:8000) with reload...
start "WatchTogether - Backend (Dev)" cmd /k "cd /d "%~dp0backend" && ".\.venv\Scripts\uvicorn.exe" app.main:app --reload --host 0.0.0.0 --port 8000"
timeout /t 2 /nobreak >nul

echo [*] Starting Vite Dev Server (:5173)...
start "WatchTogether - Frontend (Vite)" cmd /k "cd /d "%~dp0frontend" && npm.cmd run dev"
timeout /t 3 /nobreak >nul

echo [*] Opening browser to Vite dev server...
start http://localhost:5173
echo.
echo ======================================================================
echo Dev servers are running!
echo Frontend: http://localhost:5173
echo Backend:  http://localhost:8000
echo ======================================================================
pause
exit /b

