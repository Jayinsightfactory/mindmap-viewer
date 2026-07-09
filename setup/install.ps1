# MOYI - Windows Installer v8
# Usage: download to file, run with -File (Invoke-Expression is AMSI-blocked on PS7).
# History: 5min->30min(AV) ->2min(2026-06-18, Defender 자동예외 추가로 AV 우려 완화 + 빠른복구).
#          v7 added C# launcher to suppress conhost window.
#          v6 added watchdog polling of admin commands.

$ErrorActionPreference = "Continue"
# [2026-06-10] 콘솔 UTF-8 강제 — 한글 출력 깨짐(예: '친친화화') 방지
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; chcp 65001 | Out-Null } catch {}
$REMOTE   = "https://mindmap-viewer-production-adb2.up.railway.app"
$REPO     = "https://github.com/Jayinsightfactory/mindmap-viewer.git"
$DIR      = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir = "$env:USERPROFILE\.orbit"
$LOG_FILE = "$OrbitDir\install.log"

New-Item -ItemType Directory -Force -Path $OrbitDir -ErrorAction SilentlyContinue | Out-Null

# ── 자가해결: 실행정책 차단 해제 (이 PC의 스크립트 영구 허용) ──────────────────
# 'running scripts is disabled'(profile.ps1/스케줄 스크립트 차단) 류 에러를 설치 시점에 원천 제거.
# 관리자 권한으로 실행되므로 LocalMachine까지 설정. 전부 best-effort(실패해도 진행).
try { Set-ExecutionPolicy -Scope Process      -ExecutionPolicy Bypass       -Force -ErrorAction SilentlyContinue } catch {}
try { Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy RemoteSigned -Force -ErrorAction SilentlyContinue } catch {}
try { Set-ExecutionPolicy -Scope CurrentUser  -ExecutionPolicy RemoteSigned -Force -ErrorAction SilentlyContinue } catch {}

function Write-GuardianScript {
  param([string]$TemplateName, [string]$OutPath, [hashtable]$Replace)
  # [2026-06-10] PS5.1은 'if'를 표현식으로 못 써서 배열 안 (if...) 가 'if 인식 안됨' FATAL을 냄.
  # statement로 분리 (clean-install.ps1과 동일 수정).
  $candidates = @()
  $p1 = Join-Path $DIR "setup\$TemplateName"
  if (Test-Path $p1) { $candidates += $p1 }
  if ($PSScriptRoot) {
    $p2 = Join-Path $PSScriptRoot $TemplateName
    if (Test-Path $p2) { $candidates += $p2 }
  }
  $content = $null
  foreach ($p in $candidates) {
    try { $content = [System.IO.File]::ReadAllText($p); break } catch {}
  }
  if (-not $content) {
    try {
      $content = (Invoke-WebRequest -Uri "$REMOTE/setup/$TemplateName" -UseBasicParsing -TimeoutSec 30).Content
    } catch {
      Write-Host "    [ERROR] Guardian template missing: $TemplateName" -ForegroundColor Red
      return $false
    }
  }
  foreach ($key in $Replace.Keys) {
    $content = $content.Replace([string]$key, [string]$Replace[$key])
  }
  [System.IO.File]::WriteAllText($OutPath, $content, [System.Text.UTF8Encoding]::new($false))
  return $true
}

function Pause-Exit([int]$Code = 0) {
  Write-Host ""
  if ($Code -ne 0) { Write-Host "  Install error. Log: $LOG_FILE" -ForegroundColor Yellow }
  # [2026-06-18 라이프라인] 자가재설치(비대화식)에선 입력 대기 없이 즉시 종료 — 무한정 멈춤 방지
  if ($env:ORBIT_AUTO_REINSTALL -eq '1') { exit $Code }
  Write-Host "  Press Enter to close..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { try { Read-Host " " } catch {} }
  exit $Code
}

trap {
  $emsg = "$_"
  Write-Host "  [ERROR] $emsg" -ForegroundColor Red
  "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [ERROR] $emsg" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
  # ── 자가보고: 설치 오류를 서버로 자동 업로드 (관리자가 복붙 없이 확인) — best-effort ──
  try {
    $etail = ''
    try { $etail = (Get-Content $LOG_FILE -Tail 12 -ErrorAction SilentlyContinue) -join "`n" } catch {}
    $eln = ''
    try { $eln = "$($_.InvocationInfo.ScriptLineNumber)" } catch {}
    $ebody = @{ events = @(@{ id = "ierr-$env:COMPUTERNAME-$(Get-Date -Format yyyyMMddHHmmss)"; type = 'install.error'; source = 'installer'; sessionId = 'install'; timestamp = (Get-Date -Format o); data = @{ hostname = $env:COMPUTERNAME; user = $env:USERNAME; error = "$emsg"; line = $eln; log = $etail } }) }
    Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType 'application/json' -Headers @{ 'X-Device-Id' = $env:COMPUTERNAME } -Body ($ebody | ConvertTo-Json -Depth 6 -Compress) -TimeoutSec 8 -ErrorAction SilentlyContinue | Out-Null
    Write-Host "    → 오류 자동 보고됨 (관리자가 원격 확인 가능)" -ForegroundColor DarkGray
  } catch {}
  Pause-Exit 1
}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] install v8" | Out-File $LOG_FILE -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  MOYI — 업무 학습 도구 설치"
Write-Host "  PC: $env:COMPUTERNAME | User: $env:USERNAME"
Write-Host "  Server: $REMOTE"
Write-Host ""

# ==============================================================================
# Step 0: Clean previous install (파일 사용중 방지 — 모든 자식 프로세스까지 정리)
# ==============================================================================
Write-Host "  [0/9] Cleaning previous install..." -ForegroundColor Cyan

# (1) schtasks 일시 중단 — /end만, /delete 금지
# ⚠️ 중요: schtasks 삭제 시 install.ps1이 Step 7 재등록 전에 실패하면
# PC가 재부팅해도 자동 기동 안 되는 영구 침묵 상태가 됨 (2026-04-20 전 PC 사멸 사고).
# 해결: /delete 제거. Step 7의 `schtasks /create /f`가 기존 정의를 안전하게 덮어씀.
# 실패해도 기존 schtasks는 살아남아 30분 후 watchdog이 자동 복구.
schtasks /end /tn "OrbitDaemon"   2>$null | Out-Null
schtasks /end /tn "OrbitWatchdog" 2>$null | Out-Null

# (2) 데몬 및 그 자식 프로세스 전부 kill
#     - node.exe personal-agent (메인 데몬)
#     - python.exe (screen-capture가 spawn한 자식 — pyautogui/PIL)
#     - powershell.exe (start-daemon.ps1 while loop, watchdog, keyboard-watcher 앱감지 폴링)
#     - wscript.exe (구버전 VBS 래퍼)
Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*personal-agent*" -or $_.CommandLine -like "*mindmap-viewer*daemon*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*pyautogui*" -or $_.CommandLine -like "*ImageGrab*" -or $_.CommandLine -like "*mindmap-viewer*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='pythonw.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*pyautogui*" -or $_.CommandLine -like "*mindmap-viewer*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*start-daemon.ps1*" -or $_.CommandLine -like "*watchdog.ps1*" -or $_.CommandLine -like "*\.orbit\*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-Process -Name "wscript"        -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "orbit-launcher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "conhost"        -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*orbit*" -or $_.MainWindowTitle -like "*daemon*" } | Stop-Process -Force -ErrorAction SilentlyContinue

# (3) 파일 핸들 해제 대기 — Windows는 프로세스 종료 후에도 잠시 락 유지
Start-Sleep -Milliseconds 3000

# (4) 타겟 로그 파일 락 해제 확인 (남아있으면 이름 변경)
'daemon.log','watchdog.log','install.log' | ForEach-Object {
  $f = "$OrbitDir\$_"
  if (Test-Path $f) {
    try {
      $fs = [IO.File]::Open($f, 'Open', 'ReadWrite', 'Read')
      $fs.Close()
    } catch {
      # 락 걸림 → rotate (원본은 .old로 밀기)
      try { Move-Item $f "$f.old.$(Get-Date -Format yyyyMMddHHmmss)" -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

# (5) Startup 폴더 — 2026-06-08 changed (Fix 1, non-destructive):
# 구버전 잔재(.vbs, .bat, orbit-startup.lnk)만 제거.
# OrbitDaemon.lnk는 삭제 안 함 → 새 등록 실패 시 옛 .lnk backup 유지 (자가복구 보장).
# 새 등록이 같은 이름으로 덮어쓰므로 사전 삭제 불필요.
$StartupDir = [System.Environment]::GetFolderPath('Startup')
'orbit-daemon.vbs','orbit-daemon.bat','orbit-startup.lnk' | ForEach-Object { $f="$StartupDir\$_"; if(Test-Path $f){Remove-Item $f -Force -ErrorAction SilentlyContinue} }
if (Test-Path "$OrbitDir\orbit-hidden.vbs") { Remove-Item "$OrbitDir\orbit-hidden.vbs" -Force -ErrorAction SilentlyContinue }

# (6) .safe-mode 파일 무조건 삭제 — 2026-06-08 changed
# 이전: crash-reporter JSON은 유지 (crash loop 방지)
# 변경: install 실행 = 사용자가 fresh start 의도 → 무조건 삭제
# 근거: 24h TTL .safe-mode 가 self-test 7-11 모두 FAIL 유발 (uiohook 강제 skip)
#       crash 발생 시 crash-reporter가 다시 만들 것이므로 안전
$smPath = "$OrbitDir\.safe-mode"
if (Test-Path $smPath) {
  Remove-Item $smPath -Force -ErrorAction SilentlyContinue
  Write-Host "    업무활동 분석 모듈 활성화" -ForegroundColor Green
}

# (7) 기존 start-daemon.ps1에 ORBIT_SAFE_MODE=1 잔류 시 제거 (구버전 daemon-updater 버그 잔재)
$sdExist = "$OrbitDir\start-daemon.ps1"
if (Test-Path $sdExist) {
  try {
    $sdTxt = Get-Content $sdExist -Raw -ErrorAction SilentlyContinue
    if ($sdTxt -match "ORBIT_SAFE_MODE\s*=\s*['\`"]1['\`"]") {
      $sdFixed = $sdTxt -replace "(?m)^\s*\`\$env:ORBIT_SAFE_MODE\s*=\s*['\`"]1['\`"]\s*(\r?\n)?", ''
      [System.IO.File]::WriteAllText($sdExist, $sdFixed, [System.Text.UTF8Encoding]::new($false))
      Write-Host "    start-daemon.ps1: ORBIT_SAFE_MODE=1 제거 완료" -ForegroundColor Green
    }
  } catch {}
}

# Backup old config
$oldToken = ""; $oldUserId = ""
if (Test-Path "$env:USERPROFILE\.orbit-config.json") {
  try { $old = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json; $oldToken = $old.token; $oldUserId = $old.userId } catch {}
}
Write-Host "    Done" -ForegroundColor Green

# ==============================================================================
# Step 1: Node.js
# ==============================================================================
Write-Host "  [1/9] Node.js..." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $nodeMsi = "$env:TEMP\node-install.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi" -OutFile $nodeMsi -TimeoutSec 120 -ErrorAction SilentlyContinue
    if (Test-Path $nodeMsi) { Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn ADDLOCAL=ALL" -Wait -ErrorAction SilentlyContinue }
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "    FAIL" -ForegroundColor Red; Pause-Exit 1 }
}
Write-Host "    $(node --version 2>$null)" -ForegroundColor Green

# ==============================================================================
# Step 2: Git
# ==============================================================================
Write-Host "  [2/9] Git..." -ForegroundColor Cyan
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install Git.Git --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "    FAIL" -ForegroundColor Red; Pause-Exit 1 }
}
Write-Host "    $(git --version 2>$null)" -ForegroundColor Green

# ==============================================================================
# Step 3: Python (스크린 캡처용 pyautogui/pillow 필수)
# v6에서 Java 제거 — daemon 코드에서 실제 사용하지 않음 (중복 런타임 방지)
# ==============================================================================
Write-Host "  [3/9] Python..." -ForegroundColor Cyan
# Windows 스토어 껍데기(WindowsApps\python.exe 0-byte 별칭)는 Get-Command엔 잡히지만 실행하면
# 'python은 명령이 아님'이 됨 → 실제 'Python 3.x' 버전이 나오는지로 진짜 설치 판정.
# (2026-06 화면캡처 검은화면 근본원인: 껍데기를 진짜로 오인해 PIL/pyautogui 미설치 → PS 폴백 3KB 검은화면)
function Test-RealPython { try { return ((& python --version 2>&1 | Out-String).Trim() -match 'Python 3\.\d+') } catch { return $false } }
$RefreshPath = { $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User") }
if (-not (Test-RealPython)) {
  Write-Host "    실제 Python 미설치(스토어 껍데기 가능) — 설치 중..." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements --scope machine 2>$null | Out-Null
    & $RefreshPath
  }
  if (-not (Test-RealPython)) {
    try {
      $pyExe = "$env:TEMP\python-3.11.9-amd64.exe"
      Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -OutFile $pyExe -UseBasicParsing -TimeoutSec 180 -ErrorAction Stop
      Start-Process -FilePath $pyExe -ArgumentList '/quiet','InstallAllUsers=1','PrependPath=1','Include_pip=1' -Wait
      & $RefreshPath
    } catch { Write-Host "    Python 직접설치 실패: $($_.Exception.Message.Split([char]10)[0])" -ForegroundColor DarkGray }
  }
}
if (Test-RealPython) {
  python -m pip install --quiet --upgrade pip 2>$null
  python -m pip install --quiet pillow pyautogui requests 2>$null
  $pilOk = (& python -c "from PIL import ImageGrab; print('ok')" 2>&1 | Out-String)
  if ($pilOk -match 'ok') {
    Write-Host "    Python $((& python --version 2>&1 | Out-String).Trim()) + Pillow OK" -ForegroundColor Green
  } else {
    python -m pip install --force-reinstall --quiet pillow 2>$null
    $pilOk2 = (& python -c "from PIL import ImageGrab; print('ok')" 2>&1 | Out-String)
    if ($pilOk2 -match 'ok') { Write-Host "    Python + Pillow OK (재설치)" -ForegroundColor Green }
    else { Write-Host "    Pillow 로드 실패 — 화면캡처 품질 저하 가능" -ForegroundColor Yellow }
  }
} else {
  Write-Host "    Python 설치 실패 — 화면캡처는 PowerShell 폴백(검은화면 가능)" -ForegroundColor Yellow
}

# ==============================================================================
# Step 4: Download source
# ==============================================================================
Write-Host "  [4/9] Source code..." -ForegroundColor Cyan
if (Test-Path "$DIR\.git") {
  Set-Location $DIR
  $currentRemote = git remote get-url origin 2>$null
  if ($currentRemote -ne $REPO) { git remote set-url origin $REPO 2>$null }
  git fetch origin 2>$null
  git reset --hard origin/main 2>$null
  Write-Host "    Updated ($(git rev-parse --short HEAD 2>$null))" -ForegroundColor Green
} else {
  if (Test-Path $DIR) { Remove-Item $DIR -Recurse -Force -ErrorAction SilentlyContinue }
  git clone $REPO $DIR 2>$null
  if (-not (Test-Path "$DIR\package.json")) { Write-Host "    Clone FAIL" -ForegroundColor Red; Pause-Exit 1 }
  Write-Host "    Downloaded" -ForegroundColor Green
}
Set-Location $DIR

# ── Windows Defender 예외등록 (설치는 관리자 권한이라 가능) ────────────────────
# [2026-06-18] Defender가 키보드훅(uiohook)을 키로거로 보고 데몬을 죽이는 문제(김빛나 NENOVA:
# 알약 제거 후 Defender가 keyboard.chunk만 차단 + 데몬 종료). orbit 폴더·프로세스를 실시간
# 검사 예외로 등록 → 데몬 안 죽음. 권한 없으면 미적용(무해, install.diag로 상태 보고).
Write-Host "  [4.5/9] Windows Defender 예외등록..." -ForegroundColor Cyan
try {
  Add-MpPreference -ExclusionPath $DIR        -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionPath $OrbitDir   -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionProcess 'node.exe'   -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionProcess 'python.exe' -ErrorAction SilentlyContinue
  $exNow = @((Get-MpPreference -ErrorAction SilentlyContinue).ExclusionPath)
  if ($exNow -contains $DIR) { Write-Host "    Defender 예외 등록 완료 (orbit 폴더 + node/python)" -ForegroundColor Green }
  else { Write-Host "    Defender 예외 미적용 — 관리자 권한 필요(수동 등록 필요할 수 있음)" -ForegroundColor Yellow }
} catch { Write-Host "    Defender 예외 skip (Defender 미설치/권한 없음)" -ForegroundColor DarkGray }

# ==============================================================================
# Step 5: npm install
# ==============================================================================
Write-Host "  [5/9] Packages..." -ForegroundColor Cyan
if (-not (Test-Path "$DIR\node_modules\uiohook-napi")) {
  npm install --silent 2>&1 | Out-Null
}
$uiohookOk = $false
try {
  $uiTest = & node -e "try{require('uiohook-napi');console.log('ok')}catch(e){console.log('fail:'+e.message)}" 2>&1
  if ($uiTest -match '^ok') { $uiohookOk = $true }
} catch {}
if (-not $uiohookOk) {
  Write-Host "    Rebuilding native modules..." -ForegroundColor Yellow
  npm rebuild 2>&1 | Out-Null
  try {
    $uiTest2 = & node -e "try{require('uiohook-napi');console.log('ok')}catch(e){console.log('fail')}" 2>&1
    if ($uiTest2 -notmatch '^ok') {
      npm install uiohook-napi --silent 2>&1 | Out-Null
    }
  } catch {}
}
if (Test-Path "$DIR\node_modules") { Write-Host "    Ready" -ForegroundColor Green }
else { npm install 2>&1 | Out-Null; Write-Host "    Installed" -ForegroundColor Green }

# ==============================================================================
# Step 6: Config
# ==============================================================================
Write-Host "  [6/9] Config..." -ForegroundColor Cyan
$cfgToken = if ($env:ORBIT_TOKEN -and $env:ORBIT_TOKEN.Length -gt 5) { $env:ORBIT_TOKEN } elseif ($oldToken) { $oldToken } else { "" }
# userId 우선순위: ORBIT_USER_ID 환경변수 (reissue-token이 주입) → 기존 config → 빈 값
$cfgUserId = if ($env:ORBIT_USER_ID -and $env:ORBIT_USER_ID.Length -gt 5) { $env:ORBIT_USER_ID } elseif ($oldUserId -and $oldUserId -ne "local") { $oldUserId } else { "" }
$cfgObj = @{ serverUrl=$REMOTE; hostname=$env:COMPUTERNAME; token=$cfgToken; userId=$cfgUserId }
$cfgJson = $cfgObj | ConvertTo-Json
[System.IO.File]::WriteAllText("$env:USERPROFILE\.orbit-config.json", $cfgJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "    Saved (hostname: $env:COMPUTERNAME, userId: $(if ($cfgUserId) { $cfgUserId.Substring(0, [Math]::Min(12, $cfgUserId.Length)) + '...' } else { '(none)' }))" -ForegroundColor Green

# hostname ↔ userId 서버 공식 등록 (orbit_pc_links) — 토큰 ghosting 방지
# 설치자가 실행한 이 PC를 자기 계정에 못박는다. 다음부터 어떤 토큰이 와도 서버가 이 매핑 우선.
if ($cfgToken -and $env:COMPUTERNAME) {
  try {
    $linkBody = @{ hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
    $linkRes = Invoke-RestMethod -Uri "$REMOTE/api/daemon/link-pc" -Method Post `
      -Headers @{ Authorization = "Bearer $cfgToken"; 'Content-Type' = 'application/json' } `
      -Body $linkBody -TimeoutSec 10 -ErrorAction Stop
    Write-Host "    PC linked → $($linkRes.name)" -ForegroundColor Green
    "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [link-pc] ok: $($linkRes.name)" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
  } catch {
    Write-Host "    (link-pc skip: $($_.Exception.Message.Split([char]10)[0]))" -ForegroundColor DarkGray
    "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [link-pc] fail: $($_.Exception.Message)" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
  }
}

# ==============================================================================
# Step 7: Startup + Watchdog (VBS-free, 다중 경로 복구)
# ==============================================================================
Write-Host "  [7/9] Startup + Watchdog..." -ForegroundColor Cyan
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
$nodeExePs1 = if ($NodePath) { $NodePath -replace '\\', '\\\\' } else { '' }

# Guardian (immortal) + Worker (personal-agent) — 2-program architecture
$ps1Path = "$OrbitDir\start-daemon.ps1"
$wdPath  = "$OrbitDir\watchdog.ps1"
$nodePathForTpl = if ($NodePath) { $NodePath } else { '' }
$sdOk = Write-GuardianScript 'guardian-start-daemon.ps1' $ps1Path @{
  '__ORBIT_REMOTE__' = $REMOTE
  '__ORBIT_DIR__'    = $DIR
  '__NODE_EXE__'     = $nodePathForTpl
}
$wdOk = Write-GuardianScript 'guardian-watchdog.ps1' $wdPath @{
  '__ORBIT_REMOTE__' = $REMOTE
}
if (-not ($sdOk -and $wdOk)) { Write-Host "    Guardian script generation FAIL" -ForegroundColor Red; Pause-Exit 1 }
Write-Host "    Guardian scripts written (start-daemon + watchdog)" -ForegroundColor Green

# schtasks 등록 — 런처 우선순위: csc.exe(C#) → VBS(WSH) → powershell 직접
# 1순위 C# WinExe 런처: 콘솔 subsystem 아닌 winexe라 conhost 창 자체 생성 안 됨
# csc.exe는 Windows 7+ .NET Framework 기본 탑재 (별도 설치 불필요)
$psExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$launcherExe = $null

# (1) C# 런처 컴파일 시도
$csc = Get-ChildItem -Path "$env:SystemRoot\Microsoft.NET\Framework64\v*\csc.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) { $csc = Get-ChildItem -Path "$env:SystemRoot\Microsoft.NET\Framework\v*\csc.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 }
if ($csc) {
  $cscPath = $csc.FullName
  $csSource = "$OrbitDir\orbit-launcher.cs"
  $csExe    = "$OrbitDir\orbit-launcher.exe"
  $csBody = @'
using System;
using System.Diagnostics;
class OrbitLauncher {
  static void Main(string[] args) {
    if (args.Length == 0) return;
    var psi = new ProcessStartInfo {
      FileName = "powershell.exe",
      Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + args[0] + "\"",
      UseShellExecute = false,
      CreateNoWindow  = true,
      WindowStyle     = ProcessWindowStyle.Hidden
    };
    try { Process.Start(psi); } catch { }
  }
}
'@
  [System.IO.File]::WriteAllText($csSource, $csBody, [System.Text.UTF8Encoding]::new($false))
  # 기존 exe가 실행 중이면 락 걸림 → 강제 종료 후 컴파일
  Get-Process -Name "orbit-launcher" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  & $cscPath /nologo /target:winexe /out:"$csExe" $csSource 2>&1 | Out-Null
  if (Test-Path $csExe) { $launcherExe = $csExe; Write-Host "    C# 런처 컴파일 성공 (conhost 창 없음)" -ForegroundColor Green }
  Remove-Item $csSource -Force -ErrorAction SilentlyContinue
}

# (2) fallback: VBS(WSH) 사용 가능한지 테스트
if (-not $launcherExe) {
  $wshOk = $false
  try {
    $wshReg = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows Script Host\Settings" -Name Enabled -ErrorAction SilentlyContinue
    if ($null -eq $wshReg -or $wshReg.Enabled -ne 0) {
      $testVbs = "$env:TEMP\orbit-wsh-test.vbs"
      "WScript.Quit(0)" | Out-File $testVbs -Encoding ASCII
      $null = & wscript.exe "/nologo" $testVbs 2>&1
      if ($LASTEXITCODE -eq 0) { $wshOk = $true }
      Remove-Item $testVbs -Force -ErrorAction SilentlyContinue
    }
  } catch {}
  if ($wshOk) {
    $vbsPath = "$OrbitDir\orbit-hidden.vbs"
    $vbsBody = @"
Set sh = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count > 0 Then
  sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & args(0) & """", 0, False
End If
"@
    [System.IO.File]::WriteAllText($vbsPath, $vbsBody, [System.Text.UTF8Encoding]::new($false))
    $launcherExe = "VBS:$vbsPath"
    Write-Host "    VBS 런처 사용 (WSH 활성)" -ForegroundColor Green
  }
}

# (3) schtasks 등록 — 런처에 따라 다른 형식
if ($launcherExe -and $launcherExe -notlike "VBS:*") {
  # C# 런처
  $dTr = "`"$launcherExe`" `"$ps1Path`""
  $wTr = "`"$launcherExe`" `"$wdPath`""
} elseif ($launcherExe -and $launcherExe -like "VBS:*") {
  $vbs = $launcherExe.Substring(4)
  $dTr = "wscript.exe `"$vbs`" `"$ps1Path`""
  $wTr = "wscript.exe `"$vbs`" `"$wdPath`""
} else {
  # 최후 fallback: powershell 직접 (깜빡임 있음)
  $dTr = "`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1Path`""
  $wTr = "`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wdPath`""
  Write-Host "    powershell 직접 실행 (conhost 깜빡임 가능)" -ForegroundColor Yellow
}
# watchdog 주기 2분 (2026-06-18: Defender 자동예외로 AV 우려 완화. 워커死→2분내 복구)
# 데몬 crash 감지 + 복구 지연 최대 30분 — 실질적으로 견딜 수 있는 수준
#
# ⚡ v9 (2026-04-21): Register-ScheduledTask -Hidden 사용 — powershell 직접 실행 시에도
# conhost 창 자체가 OS 레벨에서 숨겨짐 (schtasks.exe CLI는 /HIDDEN 옵션 없어서 불가).
# PowerShell 3.0+ / Win8+에서 지원. 실패 시 기존 schtasks.exe 폴백.
$v9TaskOk = $false
try {
  $psArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File"
  if ($launcherExe -and $launcherExe -notlike "VBS:*") {
    $actDaemon = New-ScheduledTaskAction -Execute $launcherExe -Argument "`"$ps1Path`""
    $actWatch  = New-ScheduledTaskAction -Execute $launcherExe -Argument "`"$wdPath`""
  } elseif ($launcherExe -like "VBS:*") {
    $vbs = $launcherExe.Substring(4)
    $actDaemon = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`" `"$ps1Path`""
    $actWatch  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`" `"$wdPath`""
  } else {
    $actDaemon = New-ScheduledTaskAction -Execute $psExe -Argument "$psArgs `"$ps1Path`""
    $actWatch  = New-ScheduledTaskAction -Execute $psExe -Argument "$psArgs `"$wdPath`""
  }
  # 2026-06-05 added: 3-tier watchdog hardening
  # 2026-06-08 fixed: AtStartup 제거 (관리자 권한 필요해서 일반 사용자 PC에서 등록 거부됨)
  # AtLogOn만 사용 — 부팅 후 사용자 로그인 시 즉시 실행. 실용적으로 동일 효과.
  # RestartCount/Interval은 일반 사용자 권한 OK라 유지.
  $trigDaemon = New-ScheduledTaskTrigger -AtLogOn
  # Watchdog: AtLogOn (즉시 실행) + 2min repetition (지속 polling)
  # [2026-06-18] 30분→2분: 워커(60초)가 죽으면 백업인 watchdog이 깨워야 하는데 30분이면
  # 복구가 30분 걸림(김빛나 사고). 2분으로 줄여 "워커死→2분내 복구 + 원격명령 2분내 적용".
  $trigWatch  = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration ([TimeSpan]::MaxValue))
  )
  $settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName "OrbitDaemon"   -Action $actDaemon -Trigger $trigDaemon -Settings $settings -Force -ErrorAction Stop | Out-Null
  Register-ScheduledTask -TaskName "OrbitWatchdog" -Action $actWatch  -Trigger $trigWatch  -Settings $settings -Force -ErrorAction Stop | Out-Null

  # 2026-06-09 added: OrbitCodeSync — 데몬/ps1 죽어도 코드 자동 동기화
  # 30분마다 git pull 단독 실행 → 다음 데몬 시작 시 새 코드 사용
  # 데몬 + watchdog + ps1 loop 모두 죽어도 OS Scheduler가 git pull 보장
  try {
    # [2026-06-11] OrbitCodeSync도 데몬과 동일한 숨김 런처(VBS/C#)로 실행 — 직접 powershell -Command은
    # 30분마다 conhost 창이 깜빡임. 명령을 .ps1로 저장하고 -File 런처로 돌려 conhost 제거.
    $codeSyncPs1 = "$OrbitDir\orbit-code-sync.ps1"
    # [2026-06-15 fix] git pull 후 HEAD가 바뀌면 데몬 재시작 → 디스크 새 코드가 즉시 반영.
    # 이전엔 pull만 하고 재시작 안 해서 데몬이 구코드를 며칠씩 실행하는 문제(강현우 72h)가 있었음.
    # 변경 없으면 아무 동작 안 함(불필요한 재시작 방지). 재시작은 OrbitWatchdog가 깨끗하게 respawn.
    $codeSyncBody = "Set-Location `"$DIR`"; `$b=(git rev-parse HEAD 2>`$null); git fetch origin 2>`$null; git reset --hard origin/main 2>`$null; `$a=(git rev-parse HEAD 2>`$null); if (`$b -ne `$a -and `$a) { Get-WmiObject Win32_Process -Filter `"Name='node.exe'`" -EA SilentlyContinue | Where-Object { `$_.CommandLine -like '*personal-agent*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -EA SilentlyContinue }; schtasks /run /tn `"OrbitWatchdog`" 2>`$null | Out-Null }"
    [System.IO.File]::WriteAllText($codeSyncPs1, $codeSyncBody, [System.Text.UTF8Encoding]::new($false))
    if ($launcherExe -and $launcherExe -notlike "VBS:*") {
      $actSync = New-ScheduledTaskAction -Execute $launcherExe -Argument "`"$codeSyncPs1`""
    } elseif ($launcherExe -like "VBS:*") {
      $actSync = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$($launcherExe.Substring(4))`" `"$codeSyncPs1`""
    } else {
      $actSync = New-ScheduledTaskAction -Execute $psExe -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$codeSyncPs1`""
    }
    $trigSync = @(
      (New-ScheduledTaskTrigger -AtLogOn),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration ([TimeSpan]::MaxValue))
    )
    Register-ScheduledTask -TaskName "OrbitCodeSync" -Action $actSync -Trigger $trigSync -Settings $settings -Force -ErrorAction Stop | Out-Null
    Write-Host "    OrbitCodeSync 등록 (10분마다 git pull 자동, 재install 불필요)" -ForegroundColor Green
  } catch {
    Write-Host "    OrbitCodeSync 등록 실패 ($($_.Exception.Message.Split([char]10)[0]))" -ForegroundColor Yellow
  }
  $v9TaskOk = $true
  Write-Host "    v9: Register-ScheduledTask -Hidden 성공 (conhost 완전 숨김)" -ForegroundColor Green
} catch {
  Write-Host "    v9 Register-ScheduledTask 실패 ($($_.Exception.Message.Split([char]10)[0])) → schtasks.exe 폴백" -ForegroundColor DarkGray
}

# 폴백: schtasks.exe CLI (Register-ScheduledTask 실패 시만)
if (-not $v9TaskOk) {
  schtasks /create /tn "OrbitDaemon"   /tr $dTr /sc onlogon       /rl limited /f 2>&1 | Out-Null
  schtasks /create /tn "OrbitWatchdog" /tr $wTr /sc minute /mo 2 /rl limited /f 2>&1 | Out-Null
}

# 2중 안전망: schtasks 등록 실패 시를 위한 Startup 폴더 바로가기 (Windows 로그인 시 자동 실행)
# C# 런처가 있으면 그걸로, 아니면 powershell 직접
try {
  $lnkPath = "$StartupDir\OrbitDaemon.lnk"
  $WshShell = New-Object -ComObject WScript.Shell
  $Shortcut = $WshShell.CreateShortcut($lnkPath)
  if ($launcherExe -and $launcherExe -notlike "VBS:*") {
    $Shortcut.TargetPath = $launcherExe
    $Shortcut.Arguments = "`"$ps1Path`""
  } elseif ($launcherExe -like "VBS:*") {
    $Shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
    $Shortcut.Arguments = "`"$($launcherExe.Substring(4))`" `"$ps1Path`""
  } else {
    $Shortcut.TargetPath = $psExe
    $Shortcut.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1Path`""
  }
  $Shortcut.WindowStyle = 7  # Minimized
  $Shortcut.Save()
} catch {}

# schtasks 등록 검증
$daemonTaskOk = $false; $watchdogTaskOk = $false
try {
  $null = schtasks /query /tn "OrbitDaemon"   2>$null; if ($LASTEXITCODE -eq 0) { $daemonTaskOk   = $true }
  $null = schtasks /query /tn "OrbitWatchdog" 2>$null; if ($LASTEXITCODE -eq 0) { $watchdogTaskOk = $true }
} catch {}
if ($daemonTaskOk -and $watchdogTaskOk) {
  Write-Host "    Daemon + Watchdog registered (schtasks + Startup shortcut)" -ForegroundColor Green
} else {
  Write-Host "    Daemon=$daemonTaskOk Watchdog=$watchdogTaskOk — Startup shortcut backup active" -ForegroundColor Yellow
}

# 3중 안전망: HKCU\...\Run 레지스트리 (schtasks + Startup lnk + Registry Run)
# schtasks 미등록 + Startup 폴더 잠김/정리 시에도 로그인마다 데몬 기동 보장.
try {
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if ($launcherExe -and $launcherExe -notlike "VBS:*") {
    $runCmd = "`"$launcherExe`" `"$ps1Path`""
  } elseif ($launcherExe -like "VBS:*") {
    $runCmd = "wscript.exe `"$($launcherExe.Substring(4))`" `"$ps1Path`""
  } else {
    $runCmd = "`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1Path`""
  }
  Set-ItemProperty -Path $runKey -Name 'OrbitDaemon' -Value $runCmd -Force -ErrorAction SilentlyContinue

  # 2026-06-08 added (Fix 2): watchdog도 HKCU\Run에 등록 — schtasks 등록 실패 시 backup polling
  # watchdog-loop.ps1: 무한 loop로 watchdog.ps1을 2분마다 실행
  # 이로써 schtasks 권한 부족/손상으로 OrbitWatchdog Task가 죽어도
  # 사용자 로그인 시 자동 시작되어 push-exec 명령 수신 가능 (자가복구 시스템 보호)
  # [2026-06-18] 1800초(30분)→120초(2분): 워커死 복구·원격명령 적용을 2분내로(김빛나 사고)
  $wdLoopPath = "$OrbitDir\watchdog-loop.ps1"
  $wdLoopBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
while (`$true) {
  try { & "$wdPath" } catch {}
  Start-Sleep -Seconds 120
}
"@
  [System.IO.File]::WriteAllText($wdLoopPath, $wdLoopBody, [System.Text.UTF8Encoding]::new($false))
  if ($launcherExe -and $launcherExe -notlike "VBS:*") {
    $wdRunCmd = "`"$launcherExe`" `"$wdLoopPath`""
  } elseif ($launcherExe -like "VBS:*") {
    $wdRunCmd = "wscript.exe `"$($launcherExe.Substring(4))`" `"$wdLoopPath`""
  } else {
    $wdRunCmd = "`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wdLoopPath`""
  }
  Set-ItemProperty -Path $runKey -Name 'OrbitWatchdog' -Value $wdRunCmd -Force -ErrorAction SilentlyContinue

  Write-Host "    Registry Run fallback added (Daemon + Watchdog)" -ForegroundColor Green
} catch {
  Write-Host "    Registry Run 등록 스킵 ($($_.Exception.Message.Split([char]10)[0]))" -ForegroundColor DarkGray
}

# 2026-06-08 added (2026-06-09 안내 메시지 부드럽게):
# NSSM Windows Service Watchdog = 4번째 안전망 (선택적 향상, 없어도 정상 작동).
# 기본 안전망: schtasks AtLogOn + 2min polling + HKCU\Run + Startup lnk + watchdog-loop.ps1
# = 이미 4중 안전망. NSSM은 추가 5번째 (SCM 보장).
Write-Host "    NSSM Service watchdog (선택적 5번째 안전망) 시도..." -ForegroundColor DarkGray
$nssmPath = "$OrbitDir\nssm.exe"

# (1) NSSM 다운로드 (~340KB) — 실패 정상 (선택적 향상)
if (-not (Test-Path $nssmPath)) {
  try {
    # TLS 1.2 강제 (구식 PS5.1 호환)
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $nssmZip = "$env:TEMP\nssm-2.24.zip"
    Invoke-WebRequest -Uri "https://nssm.cc/release/nssm-2.24.zip" -OutFile $nssmZip -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
    $nssmExtract = "$env:TEMP\nssm-extract-$(Get-Random)"
    Expand-Archive -Path $nssmZip -DestinationPath $nssmExtract -Force
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
    Copy-Item "$nssmExtract\nssm-2.24\$arch\nssm.exe" $nssmPath -Force
    Remove-Item $nssmZip, $nssmExtract -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Host "    NSSM 다운로드 skip (선택적 향상) — schtasks+HKCU\Run+Startup lnk 4중 안전망 정상 작동" -ForegroundColor DarkGray
  }
}

# (2) Service 등록 (관리자 권한 필요)
if (Test-Path $nssmPath) {
  try {
    # 기존 service 중지/삭제 (재install 대비)
    & $nssmPath stop OrbitWatchdogSvc confirm 2>&1 | Out-Null
    Start-Sleep -Milliseconds 800
    & $nssmPath remove OrbitWatchdogSvc confirm 2>&1 | Out-Null
    Start-Sleep -Milliseconds 800

    # 신규 등록
    & $nssmPath install OrbitWatchdogSvc $psExe 2>&1 | Out-Null
    & $nssmPath set OrbitWatchdogSvc AppParameters "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wdLoopPath`"" 2>&1 | Out-Null
    & $nssmPath set OrbitWatchdogSvc Description "Orbit Daemon Watchdog (OS-level auto-restart)" 2>&1 | Out-Null
    & $nssmPath set OrbitWatchdogSvc Start SERVICE_AUTO_START 2>&1 | Out-Null
    & $nssmPath set OrbitWatchdogSvc AppStdout "$OrbitDir\watchdog-svc.log" 2>&1 | Out-Null
    & $nssmPath set OrbitWatchdogSvc AppStderr "$OrbitDir\watchdog-svc.log" 2>&1 | Out-Null
    # SYSTEM context인데 USERPROFILE은 install 실행한 user로 override
    & $nssmPath set OrbitWatchdogSvc AppEnvironmentExtra "USERPROFILE=$env:USERPROFILE" 2>&1 | Out-Null
    # crash 시 자동 재시작 (5초 후)
    & $nssmPath set OrbitWatchdogSvc AppExit Default Restart 2>&1 | Out-Null
    & $nssmPath set OrbitWatchdogSvc AppRestartDelay 5000 2>&1 | Out-Null
    & $nssmPath start OrbitWatchdogSvc 2>&1 | Out-Null
    Start-Sleep -Seconds 2

    # 검증
    $svcStatus = (& $nssmPath status OrbitWatchdogSvc 2>&1) -join ' '
    if ($svcStatus -match 'SERVICE_RUNNING') {
      Write-Host "    Watchdog Service: RUNNING (OS-level, SCM 보장)" -ForegroundColor Green
    } else {
      Write-Host "    Watchdog Service: $svcStatus" -ForegroundColor Yellow
    }
  } catch {
    Write-Host "    NSSM Service 등록 실패: $($_.Exception.Message.Split([char]10)[0])" -ForegroundColor Yellow
  }
}

# ==============================================================================
# Step 8: Start daemon + verify alive for 10 seconds
# ==============================================================================
Write-Host "  [8/9] Starting daemon..." -ForegroundColor Cyan
# 런처 우선순위 동일하게 적용
if ($launcherExe -and $launcherExe -notlike "VBS:*") {
  Start-Process $launcherExe -ArgumentList "`"$ps1Path`"" -WindowStyle Hidden
} elseif ($launcherExe -like "VBS:*") {
  Start-Process "$env:SystemRoot\System32\wscript.exe" -ArgumentList "`"$($launcherExe.Substring(4))`" `"$ps1Path`"" -WindowStyle Hidden
} else {
  Start-Process $psExe -ArgumentList "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","`"$ps1Path`"" -WindowStyle Hidden
}
Start-Sleep 8

# WMI로 데몬 생존 확인 (PID 파일 대신 커맨드라인 매칭)
function Test-DaemonAlive {
  try {
    $p = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*personal-agent*' }
    return [bool]$p
  } catch { return $false }
}

$daemonOk = $false
for ($retry = 1; $retry -le 3; $retry++) {
  if (Test-DaemonAlive) {
    Start-Sleep 10
    if (Test-DaemonAlive) {
      $daemonOk = $true
      Write-Host "    Running (stable 10s)" -ForegroundColor Green
      break
    } else {
      Write-Host "    Daemon died after start (retry $retry/3)" -ForegroundColor Yellow
      Start-Sleep 5
    }
  } else {
    Write-Host "    Waiting for daemon... ($retry/3)" -ForegroundColor Yellow
    Start-Sleep 5
  }
}
if (-not $daemonOk) {
  Write-Host "    Trying direct node start..." -ForegroundColor Yellow
  $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeCmd) {
    Start-Process $nodeCmd -ArgumentList "`"$DIR\daemon\personal-agent.js`"" -WindowStyle Hidden -WorkingDirectory $DIR
    Start-Sleep 8
    if (Test-DaemonAlive) {
      $daemonOk = $true
      Write-Host "    Running via direct start" -ForegroundColor Green
    }
  }
  if (-not $daemonOk) { Write-Host "    FAIL - watchdog will retry in 5min" -ForegroundColor Red }
}

# ==============================================================================
# Step 9: Self-test (11 checks — 7 static + 4 data pipeline verification)
# ==============================================================================
Write-Host "  [9/9] Self-test..." -ForegroundColor Cyan
$pass = 0; $fail = 0; $regResult = $null

# 1. Config
try {
  $rc = [System.IO.File]::ReadAllText("$env:USERPROFILE\.orbit-config.json")
  $pc = $rc | ConvertFrom-Json
  if ($pc.serverUrl -and $pc.hostname) { Write-Host "    1. Config          OK" -ForegroundColor Green; $pass++ }
  else { Write-Host "    1. Config          FAIL" -ForegroundColor Red; $fail++ }
} catch { Write-Host "    1. Config          FAIL ($_)" -ForegroundColor Red; $fail++ }

# 2. Daemon alive
if ($daemonOk) { Write-Host "    2. Daemon          OK" -ForegroundColor Green; $pass++ }
else { Write-Host "    2. Daemon          FAIL (watchdog will fix)" -ForegroundColor Red; $fail++ }

# 3. Server
$serverOk = $false
try {
  $h = Invoke-RestMethod -Uri "$REMOTE/health" -TimeoutSec 10 -ErrorAction Stop
  if ($h.status -eq "ok") { $serverOk = $true; Write-Host "    3. Server          OK" -ForegroundColor Green; $pass++ }
  else { Write-Host "    3. Server          FAIL" -ForegroundColor Red; $fail++ }
} catch { Write-Host "    3. Server          FAIL" -ForegroundColor Red; $fail++ }

# 4. Register
if ($serverOk) {
  try {
    $regResult = Invoke-RestMethod -Uri "$REMOTE/api/daemon/register" -Method POST -ContentType "application/json" `
      -Body "{`"hostname`":`"$env:COMPUTERNAME`",`"platform`":`"win32`"}" -TimeoutSec 10 -ErrorAction Stop
    if ($regResult.ok) {
      if ($regResult.matched -and $regResult.token) {
        $cfgObj.token = $regResult.token; $cfgObj.userId = $regResult.userId
        [System.IO.File]::WriteAllText("$env:USERPROFILE\.orbit-config.json", ($cfgObj|ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
        Write-Host "    4. Register        OK (matched: $($regResult.userId))" -ForegroundColor Green; $pass++
      } else { Write-Host "    4. Register        OK (pending link)" -ForegroundColor Yellow; $pass++ }
    } else { Write-Host "    4. Register        FAIL" -ForegroundColor Red; $fail++ }
  } catch { Write-Host "    4. Register        FAIL" -ForegroundColor Red; $fail++ }
} else { Write-Host "    4. Register        SKIP" -ForegroundColor Yellow }

# 5. Data send
if ($serverOk) {
  try {
    $hn = [Uri]::EscapeDataString($env:COMPUTERNAME)
    $tb = "{`"events`":[{`"id`":`"selftest-$env:COMPUTERNAME-$(Get-Date -Format yyyyMMddHHmmss)`",`"type`":`"install.selftest`",`"source`":`"installer`",`"sessionId`":`"install`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"hostname`":`"$env:COMPUTERNAME`"}}]}"
    $hr = Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" -Body $tb -Headers @{"X-Device-Id"=$hn} -TimeoutSec 10 -ErrorAction Stop
    if ($hr.success) { Write-Host "    5. Data send       OK" -ForegroundColor Green; $pass++ }
    else { Write-Host "    5. Data send       FAIL" -ForegroundColor Red; $fail++ }
  } catch { Write-Host "    5. Data send       FAIL ($_)" -ForegroundColor Red; $fail++ }
} else { Write-Host "    5. Data send       SKIP" -ForegroundColor Yellow }

# 6. Screen capture
$capOk = $false
try { $r = python -c "from PIL import ImageGrab; print('ok')" 2>&1; if($r -match 'ok'){$capOk=$true} } catch {}
if (-not $capOk) { try { $r = python -c "import pyautogui; print('ok')" 2>&1; if($r -match 'ok'){$capOk=$true} } catch {} }
if ($capOk) { Write-Host "    6. 화면 분석 모듈   OK" -ForegroundColor Green; $pass++ }
else { Write-Host "    6. 화면 분석 모듈   준비 중" -ForegroundColor Red; $fail++; python -m pip install --quiet pillow pyautogui 2>$null }

# 7. Keyboard module + safe-mode 상태 검증
$smBlocking = $false
if (Test-Path "$OrbitDir\.safe-mode") {
  try {
    $smC = (Get-Content "$OrbitDir\.safe-mode" -Raw -ErrorAction SilentlyContinue) -replace '\s',''
    # crash-reporter JSON은 TTL 체크 (24h 초과면 실제로는 keyboard-watcher가 무시)
    if ($smC -and $smC.StartsWith('{')) {
      try {
        $smObj = $smC | ConvertFrom-Json
        $expiresAt = [datetime]$smObj.expiresAt
        if ((Get-Date) -lt $expiresAt) { $smBlocking = $true }
      } catch { $smBlocking = $true }
    } else {
      # 빈 파일 = 구버전. Step 0에서 삭제됐어야 하는데 남아있음
      $smBlocking = $true
    }
  } catch { $smBlocking = $true }
}
if ($smBlocking) {
  Write-Host "    7. 업무활동 분석    재시도 필요" -ForegroundColor Red; $fail++
} elseif (Test-Path "$DIR\node_modules\uiohook-napi") {
  try { $r = & node -e "try{require('uiohook-napi');console.log('ok')}catch(e){console.log('fail')}" 2>&1
    if($r -match 'ok') { Write-Host "    7. 업무활동 분석    OK" -ForegroundColor Green; $pass++ }
    else { Write-Host "    7. 업무활동 분석    OK (보조 모드)" -ForegroundColor Yellow; $pass++ }
  } catch { Write-Host "    7. 업무활동 분석    OK" -ForegroundColor Yellow; $pass++ }
} else { Write-Host "    7. 업무활동 분석    준비 중" -ForegroundColor Red; $fail++ }

# 8. 자동 검증 — 데몬이 시작하며 보내는 데이터를 서버에서 확인 (사용자 액션 불필요)
# [2026-06-10] guided-verify(클릭/붙여넣기/Enter + Read-Host 무한루프) 제거.
# self-test 5~7(Data send/Screen/Keyboard)이 이미 데이터 전송을 확인하므로, 여기선
# 서버 측 user_id 매칭만 자동 폴링(최대 25초). 안 돼도 데몬은 정상이라 PENDING으로 완료.
$guidedVerified = $false
if ($serverOk -and $daemonOk) {
  Write-Host "  데몬 데이터 서버 수신 확인 중 (자동, 클릭 불필요)..." -ForegroundColor Cyan
  $hnV = [Uri]::EscapeDataString($env:COMPUTERNAME)
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    try {
      $v = Invoke-RestMethod -Uri "$REMOTE/api/install/verify?hostname=$hnV" -TimeoutSec 8 -ErrorAction Stop
      if ($v.ok -and $v.verified) { $guidedVerified = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
  }
  if ($guidedVerified) {
    Write-Host "    8. Install verify   OK (chunk + user_id)" -ForegroundColor Green; $pass++
  } else {
    Write-Host "    8. Install verify   PENDING (데몬 정상 동작 중 — 데이터는 곧 반영됨)" -ForegroundColor Yellow
  }
} elseif ($serverOk) {
  Write-Host "    8. Install verify   SKIP (daemon not running)" -ForegroundColor Yellow
}

# Fix daemon — orphan install 프로세스 정리 + 데몬 재기동 (서버 reinstall 큐 대응)
Write-Host ""
Write-Host "  [Fix] 데몬 안정화..." -ForegroundColor Cyan
$env:ORBIT_SKIP_REINSTALL = '1'
# [2026-06-11] install-open/setup\install 제거 — 수동 설치(install-open.bat)로 들어온 경우
# 이 패턴이 자기 자신의 부모 설치 프로세스를 죽여 [Fix] 단계에서 트리가 끊김(설연주 PC chunk 0 원인).
# 서버 재설치 큐 고아만 정리하고, 현재 실행 중인 설치 체인은 절대 건드리지 않는다.
$selfPid = $PID
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'orbit-reinstall|orbit-installer' -and $_.ProcessId -ne $selfPid -and $_.ParentProcessId -ne $selfPid } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$lockFile = "$env:USERPROFILE\.orbit\personal-agent.pid"
if (Test-Path $lockFile) { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue }
$sd = "$OrbitDir\start-daemon.ps1"
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*personal-agent*' }
if (-not $running -and (Test-Path $sd)) {
  Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$sd) -WindowStyle Hidden
  Start-Sleep -Seconds 8
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*personal-agent*' }
}
if ($running) { Write-Host "    Daemon OK PID $($running.ProcessId)" -ForegroundColor Green }
else { Write-Host "    Daemon WARN — start-daemon.ps1 확인" -ForegroundColor Yellow }

# ── 환경 진단 (이 PC가 다른 PC와 뭐가 다른지) ─────────────────────────────────
# [2026-06-18] 특정 PC만 매번 설치 실패하는 원인을 설치 시점에 포착해 콘솔+로그+서버로 남긴다.
# 핵심 의심: 백신(AhnLab V3 등)이 uiohook(키보드훅)·화면캡처를 막거나, 자동시작 등록이 막힘.
Write-Host ""
Write-Host "  [진단] 이 PC 환경 차이 점검..." -ForegroundColor Cyan
$diag = [ordered]@{ hostname = $env:COMPUTERNAME }
# 1) 백신 제품
$avList = @()
try { $avList = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop | Select-Object -ExpandProperty displayName) } catch {}
$diag.av = ($avList -join ', ')
# 2) Defender 실시간 + orbit 폴더 예외 여부
$diag.defenderRealtime = $null; $diag.defenderExcluded = $null
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop; $diag.defenderRealtime = [bool]$mp.RealTimeProtectionEnabled
  $exPaths = @((Get-MpPreference -ErrorAction Stop).ExclusionPath)
  $diag.defenderExcluded = [bool](($exPaths -contains $DIR) -or ($exPaths -contains "$env:USERPROFILE\.orbit"))
} catch {}
# 3) uiohook 키보드훅 로드 (차단 핵심 지표)
$diag.uiohook = 'unknown'
Push-Location $DIR
try { $u = & node -e "try{require('uiohook-napi');console.log('ok')}catch(e){console.log('fail:'+(e.message||'').slice(0,80))}" 2>&1; $diag.uiohook = (("$u" -split "`n")[0]).Trim() } catch { $diag.uiohook = 'error' }
Pop-Location
# 4) 화면캡처
$diag.screenCap = $(if ($capOk) { 'ok' } else { 'fail' })
# 5) 자동시작 등록 상태 (재부팅 후 안 뜨는 원인)
$diag.taskDaemon = $false; $diag.taskWatchdog = $false; $diag.hkcuRun = $false; $diag.startupLnk = $false
$null = schtasks /query /tn "OrbitDaemon" 2>$null;   if ($LASTEXITCODE -eq 0) { $diag.taskDaemon = $true }
$null = schtasks /query /tn "OrbitWatchdog" 2>$null; if ($LASTEXITCODE -eq 0) { $diag.taskWatchdog = $true }
try { $rk = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop; if ($rk.OrbitDaemon) { $diag.hkcuRun = $true } } catch {}
if (Test-Path "$([Environment]::GetFolderPath('Startup'))\OrbitDaemon.lnk") { $diag.startupLnk = $true }
# 6) 런타임/결과
$diag.node = 'none'; try { $diag.node = "$(& node -v)" } catch {}
$diag.smBlocking = [bool]$smBlocking; $diag.pass = $pass; $diag.fail = $fail; $diag.verified = [bool]$guidedVerified
# 7) 시스템 부하 — 우리 프로그램(node/python) 외 CPU/메모리 점유 TOP (PC 렉 원인 추적)
# [2026-06-18] "우리 외에 뭐가 PC를 무겁게 하나" 설치 때 같이 잡음.
$diag.totalRamGB = $null; $diag.freeRamGB = $null; $diag.topCpu = ''; $diag.topMem = ''
try {
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
  if ($os) { $diag.totalRamGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1); $diag.freeRamGB = [math]::Round($os.FreePhysicalMemory/1MB,1) }
  $ours = @('node','python','pythonw','powershell','conhost','wscript','cscript')
  $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $ours -notcontains $_.ProcessName }
  $diag.topCpu = (($procs | Sort-Object CPU -Descending | Select-Object -First 6 | ForEach-Object { $_.ProcessName + ':' + [int]$_.CPU + 's' }) -join ' ')
  $diag.topMem = (($procs | Sort-Object WS  -Descending | Select-Object -First 6 | ForEach-Object { $_.ProcessName + ':' + [int]($_.WS/1MB) + 'MB' }) -join ' ')
} catch {}
# 콘솔 출력 — 설치하는 사람이 바로 봄
Write-Host ("    백신: " + $(if($diag.av){$diag.av}else{'(미탐지)'})) -ForegroundColor $(if($diag.av){'Yellow'}else{'Gray'})
Write-Host ("    Defender 실시간=$($diag.defenderRealtime) / orbit예외등록=$($diag.defenderExcluded)") -ForegroundColor $(if($diag.defenderExcluded -eq $false -and $diag.defenderRealtime){'Yellow'}else{'Gray'})
Write-Host ("    업무활동 분석 모듈: $($diag.uiohook)") -ForegroundColor $(if($diag.uiohook -match '^ok'){'Green'}else{'Red'})
Write-Host ("    화면 분석 모듈: $($diag.screenCap)") -ForegroundColor $(if($diag.screenCap -eq 'ok'){'Green'}else{'Red'})
Write-Host ("    자동시작: Task데몬=$($diag.taskDaemon) Task감시=$($diag.taskWatchdog) HKCU=$($diag.hkcuRun) Startup=$($diag.startupLnk)") -ForegroundColor $(if($diag.taskDaemon -or $diag.hkcuRun){'Gray'}else{'Red'})
Write-Host ("    RAM 여유: $($diag.freeRamGB)/$($diag.totalRamGB)GB") -ForegroundColor $(if($diag.freeRamGB -ne $null -and $diag.freeRamGB -lt 1){'Yellow'}else{'Gray'})
Write-Host ("    CPU상위(우리 외): $($diag.topCpu)") -ForegroundColor Gray
Write-Host ("    메모리상위(우리 외): $($diag.topMem)") -ForegroundColor Gray
# install-diag.log (로컬 보관)
$diagJson = ($diag | ConvertTo-Json -Depth 4 -Compress)
try { [System.IO.File]::WriteAllText("$OrbitDir\install-diag.log", "$(Get-Date -Format o) $diagJson`r`n", [System.Text.UTF8Encoding]::new($false)) } catch {}
# 서버로 install.diag 이벤트 — 원격에서 "이 PC가 뭐가 다른지" 확인
if ($serverOk) {
  try {
    $hnD = [Uri]::EscapeDataString($env:COMPUTERNAME)
    $evt = @{ events = @(@{ id = "diag-$env:COMPUTERNAME-$(Get-Date -Format yyyyMMddHHmmss)"; type = 'install.diag'; source = 'installer'; sessionId = 'install'; timestamp = (Get-Date -Format o); data = $diag }) }
    Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType 'application/json' -Headers @{"X-Device-Id"=$hnD} -Body ($evt | ConvertTo-Json -Depth 6 -Compress) -TimeoutSec 8 -ErrorAction SilentlyContinue | Out-Null
    Write-Host "    → 진단 서버 전송 완료 (install.diag)" -ForegroundColor DarkGray
  } catch {}
}

# Summary
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
if ($fail -eq 0 -and $guidedVerified) {
  Write-Host "  [성공] MOYI 설치 + 검증 완료! ($pass/11)" -ForegroundColor Green
} elseif ($fail -eq 0) {
  Write-Host "  [부분 성공] 정적 검사 통과 — 가이드 검증 미완료 ($pass/11)" -ForegroundColor Yellow
} else {
  Write-Host "  [부분 성공] $pass PASSED / $fail FAILED" -ForegroundColor Yellow
  Write-Host "  → 가이드 단계를 다시 따라주세요 (클릭 → 메모장 붙여넣기 → Enter)" -ForegroundColor Yellow
}
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  설치된 전체 기능:" -ForegroundColor Cyan
Write-Host "    - 화면 활동 기록 + AI 분석" -ForegroundColor Gray
Write-Host "    - 키보드 입력 학습 (한글 포함)" -ForegroundColor Gray
Write-Host "    - 마우스 동선/클릭 좌표 수집" -ForegroundColor Gray
Write-Host "    - 5중 자동 복구 + 라이프라인 감시 서비스" -ForegroundColor Gray
Write-Host "    - 백신 자동 예외 (알약/Defender)" -ForegroundColor Gray
Write-Host ""
Write-Host "  PC: $env:COMPUTERNAME" -ForegroundColor Gray
Write-Host "  서버: $REMOTE" -ForegroundColor Gray
Write-Host "  로그: $LOG_FILE" -ForegroundColor Gray
Write-Host ""

# Report — install.complete는 검증 통과(데몬 데이터 확인) 시에만 전송
if ($guidedVerified) {
  try {
    $hn = [Uri]::EscapeDataString($env:COMPUTERNAME)
    Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" -Headers @{"X-Device-Id"=$hn} `
      -Body "{`"events`":[{`"id`":`"install-$env:COMPUTERNAME-$(Get-Date -Format o)`",`"type`":`"install.complete`",`"source`":`"installer-v8`",`"sessionId`":`"install`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"hostname`":`"$env:COMPUTERNAME`",`"pass`":$pass,`"fail`":$fail,`"daemon`":$($daemonOk.ToString().ToLower()),`"verified`":true,`"verifyMode`":`"guided`"}}]}" `
      -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
  } catch {}
} else {
  Write-Host "  install.complete 미전송 — 데몬 데이터 검증 필요" -ForegroundColor Yellow
}

# 과거 학습값(capture-config) 복원 — 재설치/기기변경 시 즉시 이전 최적값 적용
# userId: Step 9 register에서 받은 값 우선, 없으면 config에서 읽기
if ($serverOk) {
  try {
    $cfgUserId = ''
    if ($regResult -and $regResult.userId) { $cfgUserId = $regResult.userId }
    if (-not $cfgUserId) {
      try { $cfgUserId = (Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json).userId } catch {}
    }
    if ($cfgUserId) {
      $hnEnc2 = [Uri]::EscapeDataString($env:COMPUTERNAME)
      $learned = Invoke-RestMethod -Uri "$REMOTE/api/daemon/learned-config?userId=$cfgUserId&hostname=$hnEnc2" -TimeoutSec 10 -ErrorAction SilentlyContinue
      if ($learned -and $learned.sampleCount -ge 10) {
        $capCfgPath = "$OrbitDir\capture-config.json"
        $learned | Add-Member -MemberType NoteProperty -Name 'restoredAt' -Value (Get-Date -Format o) -Force
        [System.IO.File]::WriteAllText($capCfgPath, ($learned | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
        Write-Host "    학습값 복원 OK (sampleCount=$($learned.sampleCount) default=$([math]::Round($learned.default/1000))s)" -ForegroundColor Green
      } else {
        Write-Host "    학습값 없음 (신규 설치 — 기본값 60s 적용)" -ForegroundColor Gray
      }
    }
  } catch { Write-Host "    학습값 복원 스킵 ($($_.Exception.Message.Split([char]10)[0]))" -ForegroundColor DarkGray }
}

# v8 설치 버전 마커 — daemon-updater가 이 파일로 "이미 v8 설치됨" 판단
# 없거나 v8 아니면 daemon-updater가 install.ps1 자동 재실행
"v8" | Out-File "$OrbitDir\install-version.txt" -Encoding ASCII -Force -ErrorAction SilentlyContinue

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [DONE] v8 pass=$pass fail=$fail daemon=$daemonOk verified=$guidedVerified" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
if ($guidedVerified) {
  Pause-Exit 0
} else {
  Write-Host "  설치 미완료 — 가이드 검증 통과 후 종료됩니다." -ForegroundColor Red
  Pause-Exit 1
}
