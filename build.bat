@echo off
chcp 65001 >nul
title SoundBridge Build & Package

echo ============================================
echo   SoundBridge Build & Package Tool
echo ============================================
echo.

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe

if not exist "%CSC%" (
    echo [ERROR] csc.exe not found at %CSC%
    echo Trying dotnet...
    where dotnet >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Neither csc nor dotnet found. Please install .NET Framework or .NET SDK.
        pause
        exit /b 1
    )
)

echo [1/3] Compiling SoundBridge.cs ...
"%CSC%" /platform:x64 /out:SoundBridge.exe SoundBridge.cs /r:System.Windows.Forms.dll /r:System.Drawing.dll
if errorlevel 1 (
    echo [ERROR] Compilation failed!
    pause
    exit /b 1
)
echo       OK - SoundBridge.exe

echo.
echo [2/3] Creating ZIP package ...
del SoundBridge.zip 2>nul
powershell -NoProfile -Command "Compress-Archive -Path server.js,package.json,node_modules,public,audio-capture.cs -DestinationPath SoundBridge.zip -Force"
if errorlevel 1 (
    echo [ERROR] ZIP creation failed!
    pause
    exit /b 1
)
echo       OK - SoundBridge.zip

echo.
echo [3/3] Merging EXE + ZIP ...
copy /b SoundBridge.exe + SoundBridge.zip SoundBridge-Setup.exe >nul
if errorlevel 1 (
    echo [ERROR] Merge failed!
    pause
    exit /b 1
)

for %%A in ("SoundBridge-Setup.exe") do echo       OK - %%~zA bytes

echo.
echo ============================================
echo   Done! Run SoundBridge-Setup.exe
echo ============================================
pause
