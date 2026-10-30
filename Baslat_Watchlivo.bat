@echo off
chcp 65001 >nul
title Watchlivo Sunucu ve Masaüstü Başlatıcı
cd /d "%~dp0"

if exist "static\Watchlivo.exe" (
    if "%1"=="--desktop" (
        start "" "static\Watchlivo.exe"
        exit /b 0
    )
)

set "PY_EXE=python"
if exist "C:\Users\pc\AppData\Local\Programs\Python\Python312\python.exe" (
    set "PY_EXE=C:\Users\pc\AppData\Local\Programs\Python\Python312\python.exe"
)

echo [*] Watchlivo yerel sunucusu baslatiliyor (http://127.0.0.1:8000)...
"%PY_EXE%" server.py
