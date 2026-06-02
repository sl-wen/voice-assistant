@echo off
chcp 65001 >nul
title Voice Assistant - 语音助手
echo.
echo 🎙️  Voice Assistant - 语音助手
echo.
echo 正在检查环境...

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未找到 Node.js，请先安装: https://nodejs.org/
    pause
    exit /b 1
)

echo ✅ Node.js:
node --version

if not exist node_modules (
    echo.
    echo 📦 安装依赖...
    npm install --production
)

echo.
echo 🚀 启动服务...
echo.
node server.js

pause
