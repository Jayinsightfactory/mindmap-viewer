@echo off
chcp 65001 >nul 2>&1
title Orbit AI - 직원 설치

REM --- 관리자 권한 체크 + 자동 승격 ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   관리자 권한이 필요합니다.
    echo   잠시 후 UAC 창이 뜨면 "예"를 눌러주세요.
    echo.
    timeout /t 2 >nul
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo ===========================================
echo   Orbit AI 설치 (직원용)
echo ===========================================
echo.
echo   설치 중 본인 이름을 입력하게 됩니다 (예: 강현우)
echo   이름을 정확히 입력하면 본인 계정으로 연결됩니다.
echo.

set "PS1_URL=https://mindmap-viewer-production-adb2.up.railway.app/setup/install-open.ps1"
set "PS1_LOCAL=%TEMP%\orbit-install-open.ps1"

REM --- 다운로드 1/2: curl (Windows 10/11 내장) ---
echo   다운로드 시도 1/2: curl...
if exist "%PS1_LOCAL%" del "%PS1_LOCAL%" >nul 2>&1
curl -fsSL --max-time 60 -o "%PS1_LOCAL%" "%PS1_URL%" 2>nul
if exist "%PS1_LOCAL%" goto RUN

REM --- 다운로드 2/2: PowerShell fallback ---
echo   다운로드 시도 2/2: PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%') } catch { exit 1 }"
if exist "%PS1_LOCAL%" goto RUN

echo.
echo   [실패] 다운로드 실패 - 인터넷 연결 확인 후 다시 실행해주세요.
pause
exit /b 1

:RUN
echo   다운로드 완료. 설치를 시작합니다...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_LOCAL%"
del "%PS1_LOCAL%" >nul 2>&1
echo.
echo   설치 창을 닫아도 됩니다.
pause >nul
exit /b 0
