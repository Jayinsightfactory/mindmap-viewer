@echo off

setlocal EnableDelayedExpansion

chcp 65001 >nul 2>&1

title Orbit AI Install v13



set "ORBIT_REMOTE=https://mindmap-viewer-production-adb2.up.railway.app"

set "ORBIT_SKIP_REINSTALL=1"

set "LOG=%TEMP%\orbit-install.log"

set "PS1_LOCAL=%TEMP%\orbit-install-final.ps1"

set "PS1_URL=%ORBIT_REMOTE%/api/install-final.ps1"



echo [%date% %time%] bat start >> "%LOG%"



REM ── 관리자 권한 (UAC 후 대기 — 창이 바로 닫히지 않음) ──

net session >nul 2>&1

if %errorLevel% neq 0 (

    echo.

    echo   관리자 권한이 필요합니다. UAC에서 [예]를 누르세요.

    echo.

    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs -Wait"

    set "RC=!errorlevel!"

    echo [%date% %time%] elevated exit=!RC! >> "%LOG%"

    if !RC! neq 0 (

        echo   설치 실패 또는 취소됨. 로그: %LOG%

        pause

    )

    exit /b !RC!

)



echo.

echo   ========================================

echo     Orbit AI Install v13

echo   ========================================

echo.

echo   Log: %LOG%

echo.



REM ── PS1 다운로드 ──

echo   Downloading installer...

echo [%date% %time%] download %PS1_URL% >> "%LOG%"



del "%PS1_LOCAL%" >nul 2>&1

curl -fsSL --max-time 90 -o "%PS1_LOCAL%" "%PS1_URL%" 2>>"%LOG%"

if not exist "%PS1_LOCAL%" (

    echo   curl failed, trying PowerShell...

    powershell -NoProfile -ExecutionPolicy Bypass -Command ^

      "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%') } catch { exit 1 }" 2>>"%LOG%"

)



if not exist "%PS1_LOCAL%" (

    if exist "%~dp0orbit-install-final.ps1" (

        set "PS1_LOCAL=%~dp0orbit-install-final.ps1"

        echo   Using local ps1 next to bat.

        goto RUN

    )

    echo.

    echo   [ERROR] Installer download failed.

    echo   Log: %LOG%

    echo   URL: %PS1_URL%

    echo.

    pause

    exit /b 1

)



for %%A in ("%PS1_LOCAL%") do set "PS1_SIZE=%%~zA"

if !PS1_SIZE! LSS 500 (

    echo.

    echo   [ERROR] Downloaded file too small (!PS1_SIZE! bytes) - not a valid script.

    echo   Log: %LOG%

    pause

    exit /b 1

)



:RUN

echo   Running installer...

echo [%date% %time%] run %PS1_LOCAL% >> "%LOG%"



powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File "%PS1_LOCAL%" >> "%LOG%" 2>&1

set "RC=!errorlevel!"

echo [%date% %time%] ps1 exit=!RC! >> "%LOG%"



if !RC! neq 0 (

    echo.

    echo   [ERROR] Install failed (code !RC!)

    echo   Log: %LOG%

    echo   Script kept at: %PS1_LOCAL%

    echo.

    pause

    exit /b !RC!

)



echo.

echo   Install finished OK.

exit /b 0


