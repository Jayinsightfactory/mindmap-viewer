# ═══════════════════════════════════════════════════════════════
# Orbit AI — Windows 설치 (은행앱 없는 PC용)
# 사용법: PowerShell 에서 irm [URL] | iex
# ═══════════════════════════════════════════════════════════════
param([string]$Token = $env:ORBIT_TOKEN)

$ErrorActionPreference = "SilentlyContinue"
$REMOTE   = "https://sparkling-determination-production-c88b.up.railway.app"
$REPO     = "https://github.com/dlaww-wq/mindmap-viewer.git"
$DIR      = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir = "$env:USERPROFILE\.orbit"
$BANK_MODE = $false
$SCRIPT_URL = "$REMOTE/setup/install.ps1"

# ── 오류 시 창 유지 ────────────────────────────────────────────
function Pause-Exit([int]$Code = 0) {
  Write-Host ""
  Write-Host "  Enter 키를 누르면 창을 닫습니다..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { Read-Host }
  exit $Code
}

trap {
  Write-Host ""
  Write-Host "  [오류] $_" -ForegroundColor Red
  Write-Host "  위치: $($_.InvocationInfo.ScriptLineNumber) 줄" -ForegroundColor Yellow
  Pause-Exit 1
}

# ── 관리자 권한 확인 + 자동 승격 ──────────────────────────────
$_isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $_isAdmin) {
  Write-Host ""
  Write-Host "  관리자 권한 필요 — 자동으로 승격합니다..." -ForegroundColor Yellow

  # irm|iex 방식 대비: 서버에서 파일로 직접 다운로드 후 새 관리자 창에서 실행
  $tempScript = "$env:TEMP\orbit-install.ps1"
  try {
    Invoke-WebRequest -Uri $SCRIPT_URL -OutFile $tempScript -TimeoutSec 30 -ErrorAction Stop
  } catch {
    # 네트워크 오류 시 현재 스크립트 블록 사용
    $MyInvocation.MyCommand.ScriptBlock | Out-File $tempScript -Encoding UTF8 -ErrorAction SilentlyContinue
  }

  $argList = "-ExecutionPolicy Bypass -File `"$tempScript`""
  if ($Token) { $argList += " -Token `"$Token`"" }

  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
  } catch {
    Write-Host "  관리자 승격 실패 — 일반 권한으로 계속합니다 (일부 기능 제한)" -ForegroundColor Yellow
  }
  exit 0
}

# ── 헤더 ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════╗"
Write-Host "  ║   Orbit AI 설치 시작                  ║"
Write-Host "  ╚══════════════════════════════════════╝"
Write-Host ""

# ── 1. Node.js 확인 + 자동 설치 ───────────────────────────────
Write-Host "  [1/7] Node.js 확인..." -ForegroundColor Cyan
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
  Write-Host "  Node.js 없음 — 자동 설치 중..." -ForegroundColor Yellow

  $installed = $false

  # 방법 1: winget
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  winget으로 Node.js LTS 설치 중..." -ForegroundColor Gray
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command node -ErrorAction SilentlyContinue) { $installed = $true }
  }

  # 방법 2: 직접 다운로드 (MSI)
  if (-not $installed) {
    Write-Host "  직접 다운로드로 Node.js 설치 중 (잠시 기다려주세요)..." -ForegroundColor Gray
    $nodeMsi = "$env:TEMP\node-install.msi"
    $nodeUrl  = "https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi"
    Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -TimeoutSec 120 -ErrorAction SilentlyContinue
    if (Test-Path $nodeMsi) {
      Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn ADDLOCAL=ALL" -Wait -ErrorAction SilentlyContinue
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      if (Get-Command node -ErrorAction SilentlyContinue) { $installed = $true }
    }
  }

  if (-not $installed) {
    Write-Host "  [오류] Node.js 자동설치 실패." -ForegroundColor Red
    Write-Host "  직접 설치 후 다시 실행하세요: https://nodejs.org/ko/download" -ForegroundColor Yellow
    Pause-Exit 1
  }
  $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
}
Write-Host "  Node.js: $(node --version 2>$null)" -ForegroundColor Green

# ── 2. Git 확인 + 자동 설치 ───────────────────────────────────
Write-Host "  [2/7] Git 확인..." -ForegroundColor Cyan
$GitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $GitPath) {
  Write-Host "  Git 없음 — 자동 설치 중..." -ForegroundColor Yellow

  $installed = $false

  # 방법 1: winget
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install Git.Git --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command git -ErrorAction SilentlyContinue) { $installed = $true }
  }

  # 방법 2: 직접 다운로드
  if (-not $installed) {
    Write-Host "  직접 다운로드로 Git 설치 중 (잠시 기다려주세요)..." -ForegroundColor Gray
    $gitExe = "$env:TEMP\git-install.exe"
    $gitUrl  = "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe"
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitExe -TimeoutSec 120 -ErrorAction SilentlyContinue
    if (Test-Path $gitExe) {
      Start-Process $gitExe -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP- /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS /COMPONENTS=icons,ext\reg\shellhere,assoc,assoc_sh" -Wait -ErrorAction SilentlyContinue
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      if (Get-Command git -ErrorAction SilentlyContinue) { $installed = $true }
    }
  }

  if (-not $installed) {
    Write-Host "  [오류] Git 자동설치 실패." -ForegroundColor Red
    Write-Host "  직접 설치 후 다시 실행하세요: https://git-scm.com/download/win" -ForegroundColor Yellow
    Pause-Exit 1
  }
}
Write-Host "  Git: $(git --version 2>$null)" -ForegroundColor Green

# ── 3. 소스 다운로드 ──────────────────────────────────────────
Write-Host "  [3/7] 소스 다운로드..." -ForegroundColor Cyan
if (Test-Path "$DIR\.git") {
  Set-Location $DIR
  git fetch origin 2>$null
  git reset --hard origin/main 2>$null
  Write-Host "  업데이트 완료" -ForegroundColor Green
} else {
  if (Test-Path $DIR) { Remove-Item $DIR -Recurse -Force -ErrorAction SilentlyContinue }
  git clone $REPO $DIR 2>$null
  if (-not (Test-Path "$DIR\package.json")) {
    Write-Host "  [오류] 소스 다운로드 실패. 네트워크를 확인하세요." -ForegroundColor Red
    Pause-Exit 1
  }
  Write-Host "  다운로드 완료" -ForegroundColor Green
}
Set-Location $DIR

# ── 4. 패키지 설치 ────────────────────────────────────────────
Write-Host "  [4/7] 패키지 설치 (1-2분 소요)..." -ForegroundColor Cyan
if (-not (Test-Path "$DIR\node_modules\uiohook-napi")) {
  cmd /c "npm install --silent 2>nul"
  if (-not (Test-Path "$DIR\node_modules")) {
    cmd /c "npm install 2>nul"
  }
}
if (Test-Path "$DIR\node_modules") {
  Write-Host "  패키지 준비 완료" -ForegroundColor Green
} else {
  Write-Host "  [경고] node_modules 생성 실패 — 계속 진행" -ForegroundColor Yellow
}

# ── 5. 설정 저장 ──────────────────────────────────────────────
Write-Host "  [5/7] 설정 저장..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $OrbitDir | Out-Null
New-Item -ItemType Directory -Force -Path "$DIR\data", "$DIR\snapshots" -ErrorAction SilentlyContinue | Out-Null

$cfgToken = ""; $uid = "local"
if ($Token -and $Token.Length -gt 5) {
  $cfgToken = $Token
  try {
    $me = Invoke-RestMethod -Uri "$REMOTE/api/auth/me" -Headers @{Authorization="Bearer $Token"} -TimeoutSec 5 -ErrorAction Stop
    $uid = if ($me.id) { $me.id } elseif ($me.user.id) { $me.user.id } else { "local" }
  } catch {}
} elseif (Test-Path "$env:USERPROFILE\.orbit-config.json") {
  try {
    $old = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json
    $cfgToken = $old.token; $uid = $old.userId
  } catch {}
}

$cfg = @{
  serverUrl = $REMOTE
  token     = $cfgToken
  userId    = $uid
  bankMode  = $BANK_MODE
}
$cfg | ConvertTo-Json | Set-Content "$env:USERPROFILE\.orbit-config.json" -Encoding UTF8
[System.Environment]::SetEnvironmentVariable("ORBIT_SERVER_URL", $REMOTE, "User") 2>$null
if ($cfgToken) { [System.Environment]::SetEnvironmentVariable("ORBIT_TOKEN", $cfgToken, "User") 2>$null }
Write-Host "  설정 저장 완료 (bankMode: $BANK_MODE)" -ForegroundColor Green

# ── 6. 자동 시작 등록 ─────────────────────────────────────────
Write-Host "  [6/7] 자동 시작 등록..." -ForegroundColor Cyan
$DaemonScript = "$DIR\daemon\personal-agent.js"
$StartupDir   = [System.Environment]::GetFolderPath('Startup')

$batContent = @"
@echo off
cd /d "%USERPROFILE%\.orbit"
set ORBIT_SERVER_URL=$REMOTE

:: node.exe 경로 탐색
set "NODE_EXE="
where node >nul 2>&1 && for /f "delims=" %%n in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%n"
if not defined NODE_EXE if exist "$NodePath" set "NODE_EXE=$NodePath"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\current\node.exe" set "NODE_EXE=%APPDATA%\nvm\current\node.exe"
if not defined NODE_EXE (
  echo [%date% %time%] ERROR: node.exe not found >> "%USERPROFILE%\.orbit\daemon.log"
  timeout /t 60 /nobreak >nul
  exit /b 1
)

for /f "usebackq tokens=*" %%a in (`"%NODE_EXE%" -e "try{console.log(require('%USERPROFILE%\\.orbit-config.json').token||'')}catch(e){console.log('')}"`) do set ORBIT_TOKEN=%%a
:loop
echo [%date% %time%] daemon start >> "%USERPROFILE%\.orbit\daemon.log"
"%NODE_EXE%" "%USERPROFILE%\mindmap-viewer\daemon\personal-agent.js" >> "%USERPROFILE%\.orbit\daemon.log" 2>&1
echo [%date% %time%] daemon exit (restart in 10s) >> "%USERPROFILE%\.orbit\daemon.log"
timeout /t 10 /nobreak >nul
goto loop
"@

$startBat = "$OrbitDir\start-daemon.bat"
[System.IO.File]::WriteAllText($startBat, $batContent, [System.Text.Encoding]::GetEncoding(437))

# Startup VBS 래퍼 (cmd 창 숨김)
$vbsContent = "CreateObject(""WScript.Shell"").Run ""cmd /c """"$startBat"""""", 0, False"
$StartupVbs = "$StartupDir\orbit-daemon.vbs"
[System.IO.File]::WriteAllText($StartupVbs, $vbsContent, [System.Text.Encoding]::ASCII)
$oldBat = "$StartupDir\orbit-daemon.bat"
if (Test-Path $oldBat) { Remove-Item $oldBat -Force -ErrorAction SilentlyContinue }

Write-Host "  자동 시작 등록 완료" -ForegroundColor Green

# ── 7. 데몬 시작 ──────────────────────────────────────────────
Write-Host "  [7/7] 데몬 시작..." -ForegroundColor Cyan
$pidFile = "$OrbitDir\personal-agent.pid"
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
}
Start-Process -WindowStyle Hidden -FilePath "cmd.exe" -ArgumentList "/c `"$startBat`""
Start-Sleep -Seconds 5
$newPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($newPid -and (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
  Write-Host "  데몬 실행 중 (PID: $newPid)" -ForegroundColor Green
} else {
  Write-Host "  [경고] 데몬 시작 확인 불가 — PC 재시작 후 자동 시작됩니다" -ForegroundColor Yellow
}

# ── 완료 ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════╗"
Write-Host "  ║   ✅  Orbit AI 설치 완료!                 ║"
Write-Host "  ╚══════════════════════════════════════════╝"
Write-Host ""
Write-Host "  웹 주소: $REMOTE" -ForegroundColor Cyan
Write-Host ""
try {
  Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" `
    -Body "{`"events`":[{`"id`":`"install-done-$env:COMPUTERNAME`",`"type`":`"install.progress`",`"source`":`"installer`",`"sessionId`":`"install-$env:COMPUTERNAME`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"step`":`"complete`",`"status`":`"ok`",`"hostname`":`"$env:COMPUTERNAME`",`"bankMode`":false}}]}" `
    -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}

Pause-Exit 0
