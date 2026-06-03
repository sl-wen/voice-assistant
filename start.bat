@echo off
chcp 65001 >nul 2>&1
title Voice Assistant

echo.
echo  ╔═══════════════════════════════════╗
echo  ║     🎤 Voice Assistant v0.7      ║
echo  ║   Phone as PC Mic ^& Speaker      ║
echo  ╚═══════════════════════════════════╝
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ❌ Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)
echo  ✅ Node.js:
node --version

:: Install deps if needed
if not exist node_modules (
    echo.
    echo  📦 Installing dependencies...
    npm install --omit=dev
    if %errorlevel% neq 0 (
        echo  ❌ npm install failed
        pause
        exit /b 1
    )
)

:: Compile C# capture tool if needed (first run)
if not exist audio-capture.exe (
    if exist audio-capture.cs (
        echo.
        echo  🔨 First run: compiling audio capture tool...
        C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /unsafe /optimize /out:audio-capture.exe audio-capture.cs
        if exist audio-capture.exe (
            echo  ✅ Compiled OK
        ) else (
            echo  ⚠️  Compile failed - PC audio capture disabled
            echo      (Mic still works, speaker won't)
        )
    )
)

:: Choose mode
echo.
echo  Select mode:
echo    [1] LAN   - Same WiFi only
echo    [2] Relay - Anywhere via internet
echo.
set /p MODE="  Enter (1/2, default=2): "

if "%MODE%"=="" set MODE=2
if "%MODE%"=="1" (
    echo.
    echo  📡 LAN mode - starting local server...
    echo.
    node server.js
) else (
    echo.
    echo  🌐 Relay mode - connecting to slwen.cn...
    echo.
    set RELAY_URL=wss://slwen.cn/voice/ws
    set RELAY_PUBLIC_URL=https://slwen.cn/voice/
    node server.js
)

echo.
echo.
echo  Session ended.
pause
