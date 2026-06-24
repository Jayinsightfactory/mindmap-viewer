@echo off
chcp 65001 >nul 2>&1
title Orbit AI Install

REM --- Admin check + auto elevate ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Administrator privileges required.
    echo   Click YES on the UAC prompt.
    echo.
    timeout /t 2 >nul
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

set "PS1_URL=https://mindmap-viewer-production-adb2.up.railway.app/setup/install-open.ps1"
set "PS1_LOCAL=%TEMP%\orbit-install-open.ps1"

echo.
echo   Orbit AI - downloading installer...
echo.

REM --- Download 1/2: curl (built-in on Win10/11) ---
if exist "%PS1_LOCAL%" del "%PS1_LOCAL%" >nul 2>&1
curl -fsSL --max-time 60 -o "%PS1_LOCAL%" "%PS1_URL%" 2>nul
if exist "%PS1_LOCAL%" goto RUN

REM --- Download 2/2: PowerShell fallback ---
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%') } catch { exit 1 }"
if exist "%PS1_LOCAL%" goto RUN

echo   [FAILED] Download failed. Check internet connection and retry.
pause
exit /b 1

:RUN
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_LOCAL%"
del "%PS1_LOCAL%" >nul 2>&1
echo.
pause >nul
exit /b 0
