@echo off

setlocal EnableExtensions

title Orbit AI Install v16

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

echo [%date% %time%] v16 start >> "%LOG%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%~f0' -ErrorAction SilentlyContinue } catch {}" >nul 2>&1

net session >nul 2>&1

if %errorLevel% neq 0 (

  echo.

  echo   [v16] Admin required. Click Yes on UAC.

  echo.

  set "ORBIT_BAT=%~f0"

  powershell -NoProfile -Command "$b=$env:ORBIT_BAT; Start-Process cmd -ArgumentList @('/k','\"'+$b+'\" _ORBIT_RUN') -Verb RunAs -Wait"

  echo.

  echo   Elevated install finished. Log: %LOG%

  goto :DONE

)

echo.

echo   ========================================

echo     Orbit AI Install v16

echo   ========================================

echo.

echo   Log: %LOG%

echo.

echo   [1/2] Download installer...

echo [%date% %time%] download %PS1_URL% >> "%LOG%"

del "%PS1_LOCAL%" >nul 2>&1

where curl >nul 2>&1

if %errorLevel% equ 0 curl -fsSL --max-time 90 -o "%PS1_LOCAL%" "%PS1_URL%" 2>>"%LOG%"

if not exist "%PS1_LOCAL%" (

  echo   curl failed - PowerShell retry...

  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%'); exit 0 } catch { exit 1 }" 2>>"%LOG%"

)

if not exist "%PS1_LOCAL%" (

  echo.

  echo   [ERROR] Download failed: %PS1_URL%

  echo   Log: %LOG%

  goto :DONE

)

for %%A in ("%PS1_LOCAL%") do set "PS1_SIZE=%%~zA"

if %PS1_SIZE% LSS 500 (

  echo.

  echo   [ERROR] File too small (%PS1_SIZE% bytes)

  echo   Log: %LOG%

  goto :DONE

)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Unblock-File -LiteralPath '%PS1_LOCAL%' -ErrorAction SilentlyContinue } catch {}" >nul 2>&1

echo   [2/2] Running installer (UTF-8)...

echo [%date% %time%] run %PS1_LOCAL% >> "%LOG%"

powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -Command "$s=Get-Content -LiteralPath '%PS1_LOCAL%' -Raw -Encoding UTF8; Invoke-Expression $s"

set "RC=%ERRORLEVEL%"

echo [%date% %time%] ps1 exit=%RC% >> "%LOG%"

echo.

if %RC% equ 0 (echo   Install finished OK.) else (echo   [ERROR] Install failed (code %RC%))

echo   Script: %PS1_LOCAL%

echo   Log: %LOG%

:DONE

echo.

echo   Press Enter to close...

pause >nul

exit /b 0

