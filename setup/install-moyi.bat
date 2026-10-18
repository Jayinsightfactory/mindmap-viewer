@echo off
title MOYI Install
REM MOYI customer installer launcher (ASCII only). Usage: install-moyi.bat [INSTALL_CODE]
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   Administrator approval is required. Click YES on the next prompt.
    timeout /t 2 >nul
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process '%~f0' -ArgumentList '%~1' -Verb RunAs"
    exit /b
)
set "PS1_URL=https://nowlink-api-production.up.railway.app/api/moyi/install.ps1"
set "PS1_LOCAL=%TEMP%\moyi-install.ps1"
echo.
echo   MOYI - downloading installer...
if exist "%PS1_LOCAL%" del "%PS1_LOCAL%" >nul 2>&1
curl -fsSL --max-time 60 -o "%PS1_LOCAL%" "%PS1_URL%" 2>nul
if exist "%PS1_LOCAL%" goto RUN
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { (New-Object Net.WebClient).DownloadFile('%PS1_URL%','%PS1_LOCAL%') } catch { exit 1 }"
if exist "%PS1_LOCAL%" goto RUN
echo   [FAILED] Download failed. Check the internet connection and retry.
pause
exit /b 1
:RUN
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_LOCAL%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1_LOCAL%" -Token "%~1"
)
del "%PS1_LOCAL%" >nul 2>&1
exit /b 0
