@echo off
chcp 65001 >nul
title Watchlivo Edge Daemon Launcher
set "PYW=C:\Users\pc\AppData\Local\Programs\Python\Python312\pythonw.exe"
if not exist "%PYW%" set "PYW=pythonw.exe"
start "" "%PYW%" "c:\Users\pc\Documents\projelerim\rave_web_platform\scripts\watchlivo_edge_daemon.py"
echo [OK] Watchlivo arka plan sunucu ve Cloudflare tunel koruyucusu baslatildi!
timeout /t 3 >nul
