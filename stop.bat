@echo off
title Stop WatchTogether
cd /d "%~dp0"

echo Stopping WatchTogether processes...
taskkill /F /IM uvicorn.exe /T 2>nul
taskkill /F /IM cloudflared.exe /T 2>nul

:: Also close any cmd windows titled WatchTogether
taskkill /F /FI "WINDOWTITLE eq WatchTogether*" /T 2>nul

echo.
echo All WatchTogether processes have been stopped.
timeout /t 2 >nul

