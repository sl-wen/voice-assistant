@echo off
chcp 65001 >nul 2>&1
title Voice Assistant - Relay Mode

echo.
echo === Voice Assistant v0.7 (Relay Mode) ===
echo.

set RELAY_URL=wss://slwen.cn/voice/ws
set RELAY_PUBLIC_URL=https://slwen.cn/voice/

echo [INFO] Connecting to relay server...
echo [INFO] Phone URL will be shown below after connected
echo.

node server.js

pause
