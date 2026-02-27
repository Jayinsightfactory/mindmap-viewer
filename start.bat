@echo off
chcp 65001 >nul 2>&1
title Claude MindMap Viewer
echo.
echo  ========================================
echo   Claude MindMap Viewer + Tunnel
echo  ========================================
echo.

cd /d "%~dp0"

:: 서버 시작 (백그라운드)
echo  [1/2] 서버 시작 중...
start /b node server.js

:: 잠시 대기
timeout /t 2 /nobreak >nul

:: 터널 시작 (포그라운드 — 주소 표시됨)
echo  [2/2] 터널 시작 중...
echo.
echo  로컬:  http://localhost:4747
echo  터널 주소는 아래에 표시됩니다:
echo  ========================================
echo.

"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe" tunnel --url http://localhost:4747
