@echo off
chcp 65001 >nul
title Watchlivo v196 Production Edge Daemon
cd /d "%~dp0"

if exist "static\Watchlivo.exe" (
    if "%1"=="--desktop" (
        start "" "static\Watchlivo.exe"
        exit /b 0
    )
)

set "PY_EXE=python.exe"
if exist "%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe" (
    set "PY_EXE=%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
) else if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" (
    set "PY_EXE=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
)

echo [Watchlivo] Starting Production ASGI + Cloudflare HA Gateway Daemon...
"%PY_EXE%" "%~dp0scripts\watchlivo_edge_daemon.py"
pause
