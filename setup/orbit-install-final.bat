@echo off
setlocal EnableExtensions
title Orbit AI Install v14

REM ---- v14: 창이 절대 바로 닫히지 않게 cmd /k 로 재실행 ----
if /i not "%~1"=="_ORBIT_RUN" (
  cmd /k ""%~f0" _ORBIT_RUN"
  exit /b
)

chcp 65001 >nul 2>&1
set "ORBIT_REMOTE=https://mindmap-viewer-production-adb2.up.railway.app"
set "ORBIT_SKIP_REINSTALL=1"
set "LOG=%PUBLIC%\orbit-install.log"
set "PS1_LOCAL=%TEMP%\orbit-install-final.ps1"
set "PS1_URL=%ORBIT_REMOTE%/api/install-final.ps1"

echo [%date% %time%] v14 start >> "%LOG%"

REM MOTW 해제 (브라우저 다운로드 차단 방지)
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%~f0' -ErrorAction SilentlyContinue } catch {}" >nul 2>&1

REM ---- 관리자 권한 ----
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo.
  echo   [v14] 관리자 권한이 필요합니다. UAC에서 [예]를 누르세요.
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/k','\"\"%~f0\" _ORBIT_RUN\"' -Verb RunAs -Wait"
  echo.
  echo   관리자 설치 창이 종료되었습니다. 이 창에서 로그 확인 후 닫으세요.
  echo   Log: %LOG%
  goto :DONE
)

echo.
echo   ========================================
echo     Orbit AI Install v14
echo   ========================================
echo.
echo   Log: %LOG%
echo.

REM ---- PS1 다운로드 ----
echo   [1/2] 설치 스크립트 다운로드...
echo [%date% %time%] download %PS1_URL% >> "%LOG%"

del "%PS1_LOCAL%" >nul 2>&1
where curl >nul 2>&1
if %errorLevel% equ 0 (
  curl -fsSL --max-time 90 -o "%PS1_LOCAL%" "%PS1_URL%" 2>>"%LOG%"
)
if not exist "%PS1_LOCAL%" (
  echo   curl 없음/실패 - PowerShell로 재시도...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%'); exit 0 } catch { exit 1 }" 2>>"%LOG%"
)

if not exist "%PS1_LOCAL%" (
  echo.
  echo   [ERROR] 설치 스크립트 다운로드 실패
  echo   URL: %PS1_URL%
  echo   Log: %LOG%
  goto :DONE
)

for %%A in ("%PS1_LOCAL%") do set "PS1_SIZE=%%~zA"
if %PS1_SIZE% LSS 500 (
  echo.
  echo   [ERROR] 다운로드 파일이 너무 작음 (%PS1_SIZE% bytes)
  echo   Log: %LOG%
  goto :DONE
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%PS1_LOCAL%' -ErrorAction SilentlyContinue } catch {}" >nul 2>&1

REM ---- PS1 실행 (화면에 출력 유지 — 리다이렉트 금지) ----
echo   [2/2] 설치 실행 중... (이름 입력 + 가이드 검증)
echo [%date% %time%] run %PS1_LOCAL% >> "%LOG%"

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File "%PS1_LOCAL%"
set "RC=%ERRORLEVEL%"
echo [%date% %time%] ps1 exit=%RC% >> "%LOG%"

echo.
if %RC% equ 0 (
  echo   Install finished OK.
) else (
  echo   [ERROR] Install failed (code %RC%)
  echo   Script: %PS1_LOCAL%
)
echo   Log: %LOG%

:DONE
echo.
echo   Enter 키를 누르면 닫습니다...
pause >nul
exit /b 0
