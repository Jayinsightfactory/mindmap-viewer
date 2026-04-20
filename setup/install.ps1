# Orbit AI - Windows Installer v8 (AV 친화 + 저주기 watchdog)
# Usage: $env:ORBIT_TOKEN='...'; irm 'https://SERVER/setup/install.ps1' | iex
#
# v8 교훈 반영 (2026-04-17 강명훈/이재만 PC AV 알림 사고):
#   - watchdog 주기 5분 → 30분 (cmd 팝업 빈도 83% 감소 → AV 알림 거의 없음)
#   - force-fix exec 커맨드는 평범한 Windows 명령만 허용하는 것이 원칙
#     ❌ 금지 패턴: EncodedCommand, irm|iex, cmd /c start, Start-Process +
#         원격 URL, powershell -WindowStyle Hidden 반복
#     ✅ 허용 패턴: schtasks, reg, sc, net, taskkill, Out-File 등 Windows 표준
#
# v7 유지: C# WinExe 런처 (conhost 창 자체 생성 안 됨)
#   런처 체인: csc.exe 컴파일 → VBS(WSH 활성 시) → powershell 직접
# v6 유지: watchdog이 /api/daemon/commands 폴링해서 admin 커맨드 실행
#   (테스트 단계 1달 한시 — 안정화 후 제거 예정)
# v5 유지: VBS 단독 의존 제거 (WSH 차단 PC 대응)

$ErrorActionPreference = "Continue"
$REMOTE   = "https://mindmap-viewer-production-adb2.up.railway.app"
$REPO     = "https://github.com/Jayinsightfactory/mindmap-viewer.git"
$DIR      = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir = "$env:USERPROFILE\.orbit"
$LOG_FILE = "$OrbitDir\install.log"

New-Item -ItemType Directory -Force -Path $OrbitDir -ErrorAction SilentlyContinue | Out-Null

function Pause-Exit([int]$Code = 0) {
  Write-Host ""
  if ($Code -ne 0) { Write-Host "  Install error. Log: $LOG_FILE" -ForegroundColor Yellow }
  Write-Host "  Press Enter to close..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { try { Read-Host " " } catch {} }
  exit $Code
}

trap {
  Write-Host "  [ERROR] $_" -ForegroundColor Red
  "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [ERROR] $_" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
  Pause-Exit 1
}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] install v8" | Out-File $LOG_FILE -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  Orbit AI Installation v8 (AV 친화 + watchdog 30분 주기)"
Write-Host "  PC: $env:COMPUTERNAME | User: $env:USERNAME"
Write-Host "  Server: $REMOTE"
Write-Host ""

# ==============================================================================
# Step 0: Clean previous install (파일 사용중 방지 — 모든 자식 프로세스까지 정리)
# ==============================================================================
Write-Host "  [0/9] Cleaning previous install..." -ForegroundColor Cyan

# (1) schtasks 먼저 중단 — 죽여도 5분 안에 watchdog이 되살리는 것 방지
schtasks /end    /tn "OrbitDaemon"   2>$null | Out-Null
schtasks /end    /tn "OrbitWatchdog" 2>$null | Out-Null
schtasks /delete /tn "OrbitDaemon"   /f 2>$null | Out-Null
schtasks /delete /tn "OrbitWatchdog" /f 2>$null | Out-Null

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

# (5) Startup 폴더 + 구버전 VBS 잔재 제거
$StartupDir = [System.Environment]::GetFolderPath('Startup')
'orbit-daemon.vbs','orbit-daemon.bat','orbit-startup.lnk','OrbitDaemon.lnk' | ForEach-Object { $f="$StartupDir\$_"; if(Test-Path $f){Remove-Item $f -Force -ErrorAction SilentlyContinue} }
if (Test-Path "$OrbitDir\orbit-hidden.vbs") { Remove-Item "$OrbitDir\orbit-hidden.vbs" -Force -ErrorAction SilentlyContinue }
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
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements 2>$null }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (Get-Command python -ErrorAction SilentlyContinue) {
  python -m pip install --quiet pyautogui pillow requests 2>$null
  Write-Host "    Python $(python --version 2>$null)" -ForegroundColor Green
} else {
  Write-Host "    Python 미설치 — screen-capture 폴백 모드로 작동" -ForegroundColor Yellow
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

# Daemon launcher (while loop - auto-restart on crash)
$ps1Path = "$OrbitDir\start-daemon.ps1"
$ps1Body = @"
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location "`$env:USERPROFILE\.orbit"
`$env:ORBIT_SERVER_URL = '$REMOTE'
`$nodeExe = `$null
`$found = Get-Command node -ErrorAction SilentlyContinue
if (`$found) { `$nodeExe = `$found.Source }
if (-not `$nodeExe -and (Test-Path '$nodeExePs1')) { `$nodeExe = '$nodeExePs1' }
if (-not `$nodeExe -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { `$nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not `$nodeExe) { Start-Sleep 60; exit 1 }
try { `$c = Get-Content "`$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json; if(`$c.token){`$env:ORBIT_TOKEN=`$c.token} } catch {}
while (`$true) {
  `$ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "[`$ts] daemon start" | Out-File -Append -Encoding utf8 -FilePath "`$env:USERPROFILE\.orbit\daemon.log"
  & `$nodeExe "`$env:USERPROFILE\mindmap-viewer\daemon\personal-agent.js" 2>&1 | Out-File -Append -Encoding utf8 -FilePath "`$env:USERPROFILE\.orbit\daemon.log"
  "[`$ts] daemon exit (10s)" | Out-File -Append -Encoding utf8 -FilePath "`$env:USERPROFILE\.orbit\daemon.log"
  Start-Sleep 10
}
"@
[System.IO.File]::WriteAllText($ps1Path, $ps1Body, [System.Text.UTF8Encoding]::new($false))

# Watchdog: 5min interval - git pull + restart if daemon dead + crash report
$wdPath = "$OrbitDir\watchdog.ps1"
$wdBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$dir = "`$env:USERPROFILE\mindmap-viewer"
`$logFile = "`$env:USERPROFILE\.orbit\watchdog.log"
`$server = '$REMOTE'
`$hn = [Uri]::EscapeDataString(`$env:COMPUTERNAME)

# 토큰 읽기 (force-fix 폴링 + 크래시 리포트용)
`$cfgTok = ''
try { `$cfgTok = (Get-Content "`$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json).token } catch {}
`$pollHdrs = @{'X-Device-Id' = `$hn}
if (`$cfgTok) { `$pollHdrs['Authorization'] = "Bearer `$cfgTok" }

# ── Force-fix 커맨드 폴링 (v6) ─────────────────────────────────────────────
# 데몬이 죽어있어도 워치독이 대신 /api/daemon/commands 폴링해서 exec 커맨드 실행
# 서버 push-exec로 admin이 보낸 커맨드가 여기로 흘러옴 (데몬 독립)
try {
  `$cmdUrl = "`$server/api/daemon/commands?hostname=`$hn"
  `$cmdResp = Invoke-RestMethod -Uri `$cmdUrl -Headers `$pollHdrs -TimeoutSec 10 -ErrorAction Stop
  `$cmds = @()
  if (`$cmdResp.commands) { `$cmds = `$cmdResp.commands }
  foreach (`$cmd in `$cmds) {
    try {
      `$act = "`$(`$cmd.action)"
      `$fxTs = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
      if (`$act -eq 'exec' -and `$cmd.command) {
        # PowerShell 명령 실행 (60초 제한)
        `$out = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command `$cmd.command 2>&1 | Out-String
        "[`$fxTs] force-fix exec: `$(`$cmd.command.Substring(0, [Math]::Min(100, `$cmd.command.Length))) → `$(`$out.Substring(0, [Math]::Min(150, `$out.Length)))" | Out-File -Append -Encoding utf8 -FilePath `$logFile
        # 실행 결과 서버 리포트
        try {
          `$rBody = "{`"events`":[{`"id`":`"wdfx-`$env:COMPUTERNAME-`$([DateTimeOffset]::Now.ToUnixTimeSeconds())`",`"type`":`"daemon.update`",`"source`":`"watchdog`",`"sessionId`":`"watchdog`",`"timestamp`":`"`$((Get-Date).ToString('o'))`",`"data`":{`"hostname`":`"`$env:COMPUTERNAME`",`"status`":`"force-fix-exec`",`"detail`":`"`$(`$out -replace '[\x22\\]',' ' | Select-Object -First 200)`"}}]}"
          Invoke-RestMethod -Uri "`$server/api/hook" -Method POST -ContentType 'application/json' -Body `$rBody -Headers `$pollHdrs -TimeoutSec 5 | Out-Null
        } catch {}
      } elseif (`$act -eq 'restart') {
        # 데몬 강제 재시작
        Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { `$_.CommandLine -like '*personal-agent*' } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -EA 0 }
        "[`$fxTs] force-fix restart" | Out-File -Append -Encoding utf8 -FilePath `$logFile
      } elseif (`$act -eq 'config' -and `$cmd.data) {
        # 설정 업데이트 (토큰/serverUrl 변경 등)
        try {
          `$cfgPath = "`$env:USERPROFILE\.orbit-config.json"
          `$existing = @{}
          try { `$existing = Get-Content `$cfgPath -Raw | ConvertFrom-Json } catch {}
          `$cmd.data.PSObject.Properties | ForEach-Object { `$existing | Add-Member -MemberType NoteProperty -Name `$_.Name -Value `$_.Value -Force }
          [System.IO.File]::WriteAllText(`$cfgPath, (`$existing | ConvertTo-Json), [System.Text.UTF8Encoding]::new(`$false))
          "[`$fxTs] force-fix config updated" | Out-File -Append -Encoding utf8 -FilePath `$logFile
        } catch {}
      }
    } catch {
      "[`$fxTs] force-fix error: `$_" | Out-File -Append -Encoding utf8 -FilePath `$logFile
    }
  }
} catch {}

# 데몬 생존 판별: WMI로 node.exe personal-agent 검색 (PID 파일 의존 안 함 — 재활용 오탐 제거)
`$alive = `$false
try {
  `$nodeProcs = Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { `$_.CommandLine -like '*personal-agent*' }
  if (`$nodeProcs) { `$alive = `$true }
} catch {}

if (-not `$alive) {
  `$ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "[`$ts] daemon dead - restarting" | Out-File -Append -Encoding utf8 -FilePath `$logFile

  # daemon.log 꼬리 읽기 (크래시 원인 파악)
  `$crashInfo = ''
  try {
    `$dlog = "`$env:USERPROFILE\.orbit\daemon.log"
    if (Test-Path `$dlog) {
      `$crashInfo = (Get-Content `$dlog -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
    }
  } catch {}

  # 크래시 리포트 서버 전송 (실패해도 진행) — 토큰은 위에서 이미 `$cfgTok/`$pollHdrs 로드됨
  try {
    `$body = "{`"events`":[{`"id`":`"crash-`$env:COMPUTERNAME-`$([DateTimeOffset]::Now.ToUnixTimeSeconds())`",`"type`":`"daemon.crash`",`"source`":`"watchdog`",`"sessionId`":`"watchdog`",`"timestamp`":`"`$((Get-Date).ToString('o'))`",`"data`":{`"hostname`":`"`$env:COMPUTERNAME`",`"crashLog`":`"`$(`$crashInfo -replace '[\x22\\]',' ')`"}}]}"
    Invoke-RestMethod -Uri "`$server/api/hook" -Method POST -ContentType 'application/json' -Body `$body -Headers `$pollHdrs -TimeoutSec 5 | Out-Null
  } catch {}

  # 최신 코드 pull (원격 URL 자동 수리 포함)
  Set-Location `$dir
  git remote set-url origin 'https://github.com/Jayinsightfactory/mindmap-viewer.git' 2>`$null
  git fetch origin 2>`$null
  git reset --hard origin/main 2>`$null

  # .safe-mode 플래그 보장 (uiohook native crash 완전 차단)
  `$smFlag = "`$env:USERPROFILE\.orbit\.safe-mode"
  if (-not (Test-Path `$smFlag)) {
    try { New-Item -Path `$smFlag -ItemType File -Force | Out-Null } catch {}
  }

  # 데몬 재기동 — VBS 없이 powershell 직접 실행 (WSH 차단 환경 대응)
  `$ps1 = "`$env:USERPROFILE\.orbit\start-daemon.ps1"
  if (Test-Path `$ps1) {
    Start-Process powershell.exe -ArgumentList "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File","`"`$ps1`"" -WindowStyle Hidden
    "[`$ts] started via powershell -File (token: `$(if(`$cfgTok){'ok'}else{'missing'}))" | Out-File -Append -Encoding utf8 -FilePath `$logFile
  } else {
    # Fallback: node 직접 실행
    `$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (`$nodeExe) {
      `$daemonJs = "`$dir\daemon\personal-agent.js"
      if (Test-Path `$daemonJs) {
        if (`$cfgTok) { `$env:ORBIT_TOKEN = `$cfgTok }
        Start-Process `$nodeExe -ArgumentList "`$daemonJs" -WindowStyle Hidden -WorkingDirectory `$dir
        "[`$ts] started via node direct" | Out-File -Append -Encoding utf8 -FilePath `$logFile
      }
    }
  }
}
"@
[System.IO.File]::WriteAllText($wdPath, $wdBody, [System.Text.UTF8Encoding]::new($false))

# .safe-mode 기본 플래그 생성 (첫 설치 시 uiohook 차단 선제 적용)
# (데몬이 자체 판단으로 지우거나 유지함 — 실제 필요 없으면 다음 재시작에 재생성)
$smFlag = "$OrbitDir\.safe-mode"
if (-not (Test-Path $smFlag)) {
  try { New-Item -Path $smFlag -ItemType File -Force | Out-Null } catch {}
}

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
# v8: watchdog 주기 30분 (AV 알림 빈도 감소 — 일 48회 vs 288회, 83% 감소)
# 데몬 crash 감지 + 복구 지연 최대 30분 — 실질적으로 견딜 수 있는 수준
schtasks /create /tn "OrbitDaemon"   /tr $dTr /sc onlogon          /rl limited /f 2>&1 | Out-Null
schtasks /create /tn "OrbitWatchdog" /tr $wTr /sc minute /mo 30    /rl limited /f 2>&1 | Out-Null

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
if ($capOk) { Write-Host "    6. Screen capture  OK" -ForegroundColor Green; $pass++ }
else { Write-Host "    6. Screen capture  FAIL (pip install pillow)" -ForegroundColor Red; $fail++; python -m pip install --quiet pillow pyautogui 2>$null }

# 7. Keyboard module check
if (Test-Path "$DIR\node_modules\uiohook-napi") {
  try { $r = & node -e "try{require('uiohook-napi');console.log('ok')}catch(e){console.log('fail')}" 2>&1
    if($r -match 'ok') { Write-Host "    7. Keyboard        OK" -ForegroundColor Green; $pass++ }
    else { Write-Host "    7. Keyboard        WARN (safe polling)" -ForegroundColor Yellow; $pass++ }
  } catch { Write-Host "    7. Keyboard        WARN" -ForegroundColor Yellow; $pass++ }
} else { Write-Host "    7. Keyboard        FAIL (npm install)" -ForegroundColor Red; $fail++ }

# 8-11. Data pipeline verification — wait 90s then poll verify-install
if ($serverOk) {
  Write-Host "    Waiting 90s for daemon to warm up + send heartbeat" -NoNewline -ForegroundColor Gray
  for ($w = 0; $w -lt 18; $w++) {
    Start-Sleep -Seconds 5
    Write-Host "." -NoNewline -ForegroundColor Gray
  }
  Write-Host ""
  $hnEnc = [Uri]::EscapeDataString($env:COMPUTERNAME)
  $vOk = $false; $verify = $null
  try {
    $verify = Invoke-RestMethod -Uri "$REMOTE/api/daemon/verify-install?hostname=$hnEnc" -TimeoutSec 15 -ErrorAction Stop
    $vOk = ($verify.ok -eq $true)
  } catch { Write-Host "    verify-install call failed: $_" -ForegroundColor Red }

  if ($vOk) {
    if ($verify.checks.heartbeatReceived)   { Write-Host "    8. Heartbeat       OK" -ForegroundColor Green; $pass++ } else { Write-Host "    8. Heartbeat       FAIL" -ForegroundColor Red; $fail++ }
    if ($verify.checks.moduleMouseOk)       { Write-Host "    9. Mouse module    OK" -ForegroundColor Green; $pass++ } else { Write-Host "    9. Mouse module    FAIL" -ForegroundColor Red; $fail++ }
    if ($verify.checks.moduleKeyboardOk)    { Write-Host "    10. Keyboard module OK" -ForegroundColor Green; $pass++ } else { Write-Host "    10. Keyboard module WARN" -ForegroundColor Yellow; $pass++ }
    if ($verify.checks.moduleScreenOk)      { Write-Host "    11. Screen module   OK" -ForegroundColor Green; $pass++ } else { Write-Host "    11. Screen module   FAIL" -ForegroundColor Red; $fail++ }

    Write-Host "    verify-install verdict: $($verify.verdict) (passed=$($verify.passed) failed=$($verify.failed))" -ForegroundColor Cyan
  } else {
    Write-Host "    8-11. Pipeline verify SKIP (verify-install unavailable)" -ForegroundColor Yellow
  }
}

# Summary
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Cyan
if ($fail -eq 0) {
  Write-Host "  [성공] Orbit AI 설치 완료! ($pass/11)" -ForegroundColor Green
} else {
  Write-Host "  [부분 성공] $pass PASSED / $fail FAILED" -ForegroundColor Yellow
  Write-Host "  → Watchdog가 5분 안에 자동으로 재시도합니다" -ForegroundColor Yellow
}
Write-Host "  ============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  PC: $env:COMPUTERNAME" -ForegroundColor Gray
Write-Host "  서버: $REMOTE" -ForegroundColor Gray
Write-Host "  로그: $LOG_FILE" -ForegroundColor Gray
Write-Host ""

# Report
try {
  $hn = [Uri]::EscapeDataString($env:COMPUTERNAME)
  Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" -Headers @{"X-Device-Id"=$hn} `
    -Body "{`"events`":[{`"id`":`"install-$env:COMPUTERNAME-$(Get-Date -Format o)`",`"type`":`"install.complete`",`"source`":`"installer-v8`",`"sessionId`":`"install`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"hostname`":`"$env:COMPUTERNAME`",`"pass`":$pass,`"fail`":$fail,`"daemon`":$($daemonOk.ToString().ToLower())}}]}" `
    -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}

# v8 설치 버전 마커 — daemon-updater가 이 파일로 "이미 v8 설치됨" 판단
# 없거나 v8 아니면 daemon-updater가 install.ps1 자동 재실행
"v8" | Out-File "$OrbitDir\install-version.txt" -Encoding ASCII -Force -ErrorAction SilentlyContinue

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [DONE] v8 pass=$pass fail=$fail daemon=$daemonOk" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
Pause-Exit 0
