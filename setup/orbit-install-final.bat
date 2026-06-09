@echo off
chcp 65001 >nul 2>&1
title Orbit AI Final Install

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo   Admin required. Click YES on UAC.
    echo.
    powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    timeout /t 3 >nul
    exit /b
)

set "ORBIT_REMOTE=https://mindmap-viewer-production-adb2.up.railway.app"
set "ORBIT_SKIP_REINSTALL=1"
set "ORBIT_SKIP_COMMANDS=1"
set "PS1_LOCAL=%TEMP%\orbit-install-final.ps1"
set "PS1_URL=%ORBIT_REMOTE%/setup/orbit-install-final.ps1"

echo.
echo   Downloading final installer...
curl -fsSL --max-time 60 -o "%PS1_LOCAL%" "%PS1_URL%" 2>nul
if not exist "%PS1_LOCAL%" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%')"
)

if not exist "%PS1_LOCAL%" (
    echo   [ERROR] Download failed. Use local copy next to this bat file.
    if exist "%~dp0orbit-install-final.ps1" (
        set "PS1_LOCAL=%~dp0orbit-install-final.ps1"
        goto RUN
    )
    pause
    exit /b 1
)

:RUN
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_LOCAL%"
set RC=%errorlevel%
del "%PS1_LOCAL%" >nul 2>&1
exit /b %RC%
