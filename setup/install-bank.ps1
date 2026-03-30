# ═══════════════════════════════════════════════════════════════
# Orbit AI — Windows 설치 (은행앱 사용 PC용)
# 은행 보안 프로그램과 충돌 없이 동작하는 버전
# 사용법: PowerShell 관리자로 실행 후 irm [URL] | iex
# ═══════════════════════════════════════════════════════════════
param([string]$Token = $env:ORBIT_TOKEN)

$ErrorActionPreference = "SilentlyContinue"
$REMOTE    = "https://sparkling-determination-production-c88b.up.railway.app"
$REPO      = "https://github.com/dlaww-wq/mindmap-viewer.git"
$DIR       = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir  = "$env:USERPROFILE\.orbit"
$BANK_MODE = $true

function Pause-Exit([int]$Code = 0) {
  Write-Host ""
  Write-Host "  Enter 키를 누르면 창을 닫습니다..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { Read-Host }
  exit $Code
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════════╗"
Write-Host "  ║   Orbit AI 설치 시작 [은행앱 모드]    ║"
Write-Host "  ╚══════════════════════════════════════╝"
Write-Host ""

# ── 1. Node.js 확인 ───────────────────────────────────────────
Write-Host "  [1/7] Node.js 확인..." -ForegroundColor Cyan
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
  Write-Host "  [오류] Node.js 가 없습니다." -ForegroundColor Red
  Write-Host "  설치 후 다시 실행하세요: https://nodejs.org/ko/download" -ForegroundColor Yellow
  Pause-Exit 1
}
Write-Host "  Node.js: $(node --version 2>$null)" -ForegroundColor Green

# ── 2. Git 확인 ───────────────────────────────────────────────
Write-Host "  [2/7] Git 확인..." -ForegroundColor Cyan
$GitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $GitPath) {
  Write-Host "  [오류] Git 이 없습니다." -ForegroundColor Red
  Write-Host "  설치 후 다시 실행하세요: https://git-scm.com/download/win" -ForegroundColor Yellow
  Pause-Exit 1
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
# 구버전 bat 정리
$oldBat = "$StartupDir\orbit-daemon.bat"
if (Test-Path $oldBat) { Remove-Item $oldBat -Force -ErrorAction SilentlyContinue }

Write-Host "  자동 시작 등록 완료" -ForegroundColor Green

# ── 7. 데몬 시작 ──────────────────────────────────────────────
Write-Host "  [7/7] 데몬 시작..." -ForegroundColor Cyan
# 기존 데몬 종료
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
Write-Host "  ║   ✅  Orbit AI 설치 완료! [은행앱 모드]  ║"
Write-Host "  ╚══════════════════════════════════════════╝"
Write-Host ""
Write-Host "  웹 주소: $REMOTE" -ForegroundColor Cyan
Write-Host "  은행 앱 실행 중에는 캡처/수집이 자동 일시정지됩니다." -ForegroundColor Yellow
Write-Host ""
try {
  Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" `
    -Body "{`"events`":[{`"id`":`"install-done-$env:COMPUTERNAME`",`"type`":`"install.progress`",`"source`":`"installer`",`"sessionId`":`"install-$env:COMPUTERNAME`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"step`":`"complete`",`"status`":`"ok`",`"hostname`":`"$env:COMPUTERNAME`",`"bankMode`":true}}]}" `
    -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}

Pause-Exit 0
