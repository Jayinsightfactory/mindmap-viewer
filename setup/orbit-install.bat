@echo off
REM Orbit AI - One-click installer (double-click to run)
REM Downloads install-open.ps1 and runs it under PowerShell 5.1 (avoids PS7 AMSI strictness).

REM 2026-06-08 added: UAC auto-elevation. Node/Git winget install requires admin.
REM If user clicks "No" on UAC prompt, falls through to user-mode install
REM (works only if Node/Git already installed on the PC).
net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo.
  echo  Requesting administrator privileges for Node/Git system install...
  echo  Click YES on the UAC prompt. If you click NO, install continues in user mode
  echo  but will fail if Node/Git are not already installed.
  echo.
  powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs" 2>nul
  if %errorLevel% NEQ 0 (
    echo  UAC denied. Continuing in user mode (limited)...
    echo.
  ) else (
    exit /b 0
  )
)

setlocal
set "SERVER=https://mindmap-viewer-production-adb2.up.railway.app"
set "TEMP_PS=%TEMP%\orbit-installer.ps1"
set "PS51=%windir%\System32\WindowsPowerShell\v1.0\powershell.exe"

echo.
echo  ================================================
echo    Orbit AI - Auto Install (one-click)
echo  ================================================
echo.
echo  Step 1/2: Downloading installer...

if not exist "%PS51%" (
  echo  ERROR: PowerShell 5.1 not found at %PS51%
  echo  Press any key to exit...
  pause >nul
  exit /b 1
)

REM Use PS5.1 to download the installer (avoids PS7 AMSI on the bootstrap step).
"%PS51%" -NoProfile -ExecutionPolicy Bypass -Command "try { (New-Object Net.WebClient).DownloadFile('%SERVER%/setup/install-open.ps1','%TEMP_PS%') } catch { exit 1 }"

if not exist "%TEMP_PS%" (
  echo  Download failed. Check internet connection and try again.
  echo  Press any key to exit...
  pause >nul
  exit /b 1
)

echo  Step 2/2: Running installer (about 3 minutes)...
echo  ----------------------------------------------------------------

REM Run the installer with PS5.1 (Windows built-in). Inherits stdout/stderr.
"%PS51%" -NoProfile -ExecutionPolicy Bypass -File "%TEMP_PS%"
set "EXITCODE=%ERRORLEVEL%"

echo  ----------------------------------------------------------------
del "%TEMP_PS%" >nul 2>&1

if "%EXITCODE%"=="0" (
  echo.
  echo  Install finished. You can close this window.
) else (
  echo.
  echo  Install exited with code %EXITCODE%. See messages above.
)

echo.
echo  Press any key to close...
pause >nul
endlocal
exit /b %EXITCODE%
