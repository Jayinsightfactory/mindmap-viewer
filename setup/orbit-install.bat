@echo off
REM Orbit AI - One-click installer
REM 2026-06-08 v3: removed UAC auto-elevation (cmd window closed immediately).
REM User should right-click bat and "Run as administrator" for Node/Git install.
REM User mode also works if Node/Git already installed.

setlocal
set "SERVER=https://mindmap-viewer-production-adb2.up.railway.app"
set "TEMP_PS=%TEMP%\orbit-installer.ps1"
set "PS51=%windir%\System32\WindowsPowerShell\v1.0\powershell.exe"

echo.
echo  ================================================
echo    Orbit AI - Auto Install
echo  ================================================
echo.

REM Check admin status (informational)
fltmc >nul 2>&1
if %errorLevel% NEQ 0 (
  echo  [INFO] Running in USER mode (not admin)
  echo         Node/Git install requires admin. If they are not yet installed,
  echo         close this and right-click the bat -^> "Run as administrator".
  echo         If Node/Git already installed, you can continue.
  echo.
  echo  Press any key to continue, or Ctrl+C to exit...
  pause >nul
) else (
  echo  [INFO] Running as ADMINISTRATOR - all install steps will succeed.
  echo.
)

echo  Step 1/2: Downloading installer...
if not exist "%PS51%" (
  echo  ERROR: PowerShell 5.1 not found at %PS51%
  echo  Press any key to exit...
  pause >nul
  exit /b 1
)

"%PS51%" -NoProfile -ExecutionPolicy Bypass -Command "(New-Object Net.WebClient).DownloadFile('%SERVER%/setup/install-open.ps1','%TEMP_PS%')" 2>nul

if not exist "%TEMP_PS%" (
  echo  Download failed. Check internet connection.
  echo  Press any key to exit...
  pause >nul
  exit /b 1
)

echo  Step 2/2: Running installer (about 3 minutes)...
echo  ----------------------------------------------------------------
echo.

"%PS51%" -NoProfile -ExecutionPolicy Bypass -File "%TEMP_PS%"
set "EXITCODE=%ERRORLEVEL%"

echo.
echo  ----------------------------------------------------------------
del "%TEMP_PS%" >nul 2>&1

echo.
if "%EXITCODE%"=="0" (
  echo  [SUCCESS] Install finished.
) else (
  echo  [WARN] Install exited with code %EXITCODE%. See messages above.
)
echo.
echo  Press any key to close this window...
pause >nul
endlocal
exit /b %EXITCODE%
