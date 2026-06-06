@echo off
chcp 65001 >nul 2>&1
title Voice Assistant

echo.
echo   Voice Assistant v0.7 - Relay Mode
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo   Node.js not found!
    pause
    exit /b 1
)
echo   Node.js:
node --version

if not exist node_modules (
    echo.
    echo   Installing dependencies...
    npm install --omit=dev
)

if not exist audio-capture.exe (
    if exist audio-capture.cs (
        echo.
        echo   Compiling audio capture tool...
        C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /unsafe /optimize /platform:x64 /out:audio-capture.exe audio-capture.cs
        if exist audio-capture.exe (
            echo   Compiled OK
        ) else (
            echo   Compile failed - PC audio capture disabled
        )
    )
)

echo.
echo   Connecting to slwen.cn...
echo.

set RELAY_URL=wss://slwen.cn/voice/ws
set RELAY_PUBLIC_URL=https://slwen.cn/voice/
node server.js

echo.
echo   Session ended.
pause
