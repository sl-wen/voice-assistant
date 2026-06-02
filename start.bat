@echo off
title Voice Assistant
echo.
echo Voice Assistant - Starting...
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found. Install from https://nodejs.org/
    pause
    exit /b 1
)

echo Node.js:
node --version

if not exist node_modules (
    echo.
    echo Installing dependencies...
    npm install --omit=dev
)

echo.
echo Starting server...
echo.
node server.js

pause
