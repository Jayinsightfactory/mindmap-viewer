# Orbit AI - Windows Installer v4
# Usage: iwr 'https://SERVER/setup/install.ps1' -OutFile "$env:TEMP\oi.ps1"; & "$env:TEMP\oi.ps1"

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

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] install v4" | Out-File $LOG_FILE -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  Orbit AI Installation v4"
Write-Host "  PC: $env:COMPUTERNAME | User: $env:USERNAME"
Write-Host "  Server: $REMOTE"
Write-Host ""

# ==============================================================================
# Step 0: Kill all existing orbit processes + clean old tasks
# ==============================================================================
Write-Host "  [0/9] Cleaning previous install..." -ForegroundColor Cyan
Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*personal-agent*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process -Name "wscript" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
schtasks /delete /tn "OrbitDaemon" /f 2>$null | Out-Null
schtasks /delete /tn "OrbitWatchdog" /f 2>$null | Out-Null
$StartupDir = [System.Environment]::GetFolderPath('Startup')
'orbit-daemon.vbs','orbit-daemon.bat' | ForEach-Object { $f="$StartupDir\$_"; if(Test-Path $f){Remove-Item $f -Force -ErrorAction SilentlyContinue} }
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
# Step 3: Python + Java
# ==============================================================================
Write-Host "  [3/9] Python + Java..." -ForegroundColor Cyan
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements 2>$null }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (Get-Command python -ErrorAction SilentlyContinue) {
  python -m pip install --quiet pyautogui pillow requests 2>$null
  Write-Host "    Python $(python --version 2>$null)" -ForegroundColor Green
}
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install Microsoft.OpenJDK.21 --silent --accept-source-agreements --accept-package-agreements 2>$null }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (Get-Command java -ErrorAction SilentlyContinue) {
  Write-Host "    Java OK" -ForegroundColor Green
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
if (-not (Test-Path "$DIR\node_modules\uiohook-napi")) { npm install --silent 2>&1 | Out-Null }
if (Test-Path "$DIR\node_modules") { Write-Host "    Ready" -ForegroundColor Green }
else { npm install 2>&1 | Out-Null; Write-Host "    Installed" -ForegroundColor Green }

# ==============================================================================
# Step 6: Config (NO TOKEN REQUIRED - hostname based)
# ==============================================================================
Write-Host "  [6/9] Config..." -ForegroundColor Cyan
$cfgToken = if ($env:ORBIT_TOKEN -and $env:ORBIT_TOKEN.Length -gt 5) { $env:ORBIT_TOKEN } elseif ($oldToken) { $oldToken } else { "" }
$cfgUserId = if ($oldUserId -and $oldUserId -ne "local") { $oldUserId } else { "" }
$cfgObj = @{ serverUrl=$REMOTE; hostname=$env:COMPUTERNAME; token=$cfgToken; userId=$cfgUserId }
$cfgJson = $cfgObj | ConvertTo-Json
[System.IO.File]::WriteAllText("$env:USERPROFILE\.orbit-config.json", $cfgJson, [System.Text.UTF8Encoding]::new($false))
Write-Host "    Saved (hostname: $env:COMPUTERNAME)" -ForegroundColor Green

# ==============================================================================
# Step 7: Startup + Watchdog
# ==============================================================================
Write-Host "  [7/9] Startup..." -ForegroundColor Cyan
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
  "[`$ts] daemon start" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  & `$nodeExe "`$env:USERPROFILE\mindmap-viewer\daemon\personal-agent.js" 2>&1 | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  "[`$ts] daemon exit (10s)" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  Start-Sleep 10
}
"@
[System.IO.File]::WriteAllText($ps1Path, $ps1Body, [System.Text.UTF8Encoding]::new($false))

# Watchdog: 5min interval - git pull + restart if daemon dead + crash report
$wdPath = "$OrbitDir\watchdog.ps1"
$wdBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$dir = "`$env:USERPROFILE\mindmap-viewer"
`$pidFile = "`$env:USERPROFILE\.orbit\personal-agent.pid"
`$logFile = "`$env:USERPROFILE\.orbit\watchdog.log"
`$server = '$REMOTE'
`$hn = [Uri]::EscapeDataString(`$env:COMPUTERNAME)

# Check alive: PID file + process check + also check any node personal-agent
`$alive = `$false
if (Test-Path `$pidFile) {
  `$p = Get-Content `$pidFile
  if (`$p -and (Get-Process -Id `$p -ErrorAction SilentlyContinue)) { `$alive = `$true }
}
if (-not `$alive) {
  # Double check: any node.exe running personal-agent?
  `$nodeProcs = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object { `$_.CommandLine -like '*personal-agent*' }
  if (`$nodeProcs) { `$alive = `$true }
}

if (-not `$alive) {
  `$ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "[`$ts] daemon dead - restarting" | Add-Content `$logFile

  # Read last 5 lines of daemon.log for crash reason
  `$crashInfo = ''
  try {
    `$dlog = "`$env:USERPROFILE\.orbit\daemon.log"
    if (Test-Path `$dlog) {
      `$crashInfo = (Get-Content `$dlog -Tail 5 -ErrorAction SilentlyContinue) -join ' | '
      if (-not `$crashInfo) {
        `$fs = [IO.FileStream]::new(`$dlog,'Open','Read','ReadWrite')
        `$sr = [IO.StreamReader]::new(`$fs)
        `$lines = `$sr.ReadToEnd() -split "`n"
        `$sr.Close(); `$fs.Close()
        `$crashInfo = (`$lines[-5..-1] | Where-Object {`$_}) -join ' | '
      }
    }
  } catch {}

  # Report crash to server
  try {
    `$body = "{`"events`":[{`"id`":`"crash-`$env:COMPUTERNAME-`$([DateTimeOffset]::Now.ToUnixTimeSeconds())`",`"type`":`"daemon.crash`",`"source`":`"watchdog`",`"sessionId`":`"watchdog`",`"timestamp`":`"`$((Get-Date).ToString('o'))`",`"data`":{`"hostname`":`"`$env:COMPUTERNAME`",`"crashLog`":`"`$(`$crashInfo -replace '[\x22\\]',' ')`"}}]}"
    Invoke-RestMethod -Uri "`$server/api/hook" -Method POST -ContentType 'application/json' -Body `$body -Headers @{'X-Device-Id'=`$hn} -TimeoutSec 5 | Out-Null
  } catch {}

  # git pull latest code
  Set-Location `$dir
  git remote set-url origin 'https://github.com/Jayinsightfactory/mindmap-viewer.git' 2>`$null
  git fetch origin 2>`$null
  git reset --hard origin/main 2>`$null

  # Start daemon directly via node (not ps1 - avoids execution policy issues)
  `$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (`$nodeExe) {
    `$daemonJs = "`$dir\daemon\personal-agent.js"
    if (Test-Path `$daemonJs) {
      Start-Process `$nodeExe -ArgumentList "`$daemonJs" -WindowStyle Hidden -WorkingDirectory `$dir
      "[`$ts] started via node directly" | Add-Content `$logFile
    }
  } else {
    # Fallback: ps1 loop
    `$ps1 = "`$env:USERPROFILE\.orbit\start-daemon.ps1"
    if (Test-Path `$ps1) { Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NonInteractive -ExecutionPolicy Bypass -Command `"& '`$ps1'`"" }
    "[`$ts] started via ps1 loop" | Add-Content `$logFile
  }
}
"@
[System.IO.File]::WriteAllText($wdPath, $wdBody, [System.Text.UTF8Encoding]::new($false))

# Register tasks
$psArg = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command `"& '$ps1Path'`""
schtasks /create /tn "OrbitDaemon" /tr "powershell.exe $psArg" /sc onlogon /rl limited /f 2>&1 | Out-Null
$wdArg = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -Command `"& '$wdPath'`""
schtasks /create /tn "OrbitWatchdog" /tr "powershell.exe $wdArg" /sc minute /mo 5 /rl limited /f 2>&1 | Out-Null
Write-Host "    Daemon + Watchdog registered" -ForegroundColor Green

# ==============================================================================
# Step 8: Start daemon + verify alive for 15 seconds
# ==============================================================================
Write-Host "  [8/9] Starting daemon..." -ForegroundColor Cyan
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NonInteractive -ExecutionPolicy Bypass -Command `"& '$ps1Path'`""
Start-Sleep 8

$pidFile = "$OrbitDir\personal-agent.pid"
$daemonOk = $false
for ($retry = 1; $retry -le 3; $retry++) {
  $dp = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($dp -and (Get-Process -Id $dp -ErrorAction SilentlyContinue)) {
    # Wait 10 more seconds, check still alive
    Start-Sleep 10
    $dp2 = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($dp2 -and (Get-Process -Id $dp2 -ErrorAction SilentlyContinue)) {
      $daemonOk = $true
      Write-Host "    Running (PID: $dp2, stable 10s)" -ForegroundColor Green
      break
    } else {
      Write-Host "    PID $dp died after start (retry $retry/3)" -ForegroundColor Yellow
      Start-Sleep 5
    }
  } else {
    Write-Host "    Waiting for daemon... ($retry/3)" -ForegroundColor Yellow
    Start-Sleep 5
  }
}
if (-not $daemonOk) {
  # Direct start fallback
  Write-Host "    Trying direct start..." -ForegroundColor Yellow
  $nodeCmd = (Get-Command node -ErrorAction SilentlyContinue).Source
  if ($nodeCmd) {
    Start-Process $nodeCmd -ArgumentList "`"$DIR\daemon\personal-agent.js`"" -WindowStyle Hidden -WorkingDirectory $DIR
    Start-Sleep 8
    $dp = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($dp -and (Get-Process -Id $dp -ErrorAction SilentlyContinue)) {
      $daemonOk = $true
      Write-Host "    Running via direct start (PID: $dp)" -ForegroundColor Green
    }
  }
  if (-not $daemonOk) { Write-Host "    FAIL - watchdog will retry in 5min" -ForegroundColor Red }
}

# ==============================================================================
# Step 9: Self-test (7 checks)
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

# 7. Keyboard
if (Test-Path "$DIR\node_modules\uiohook-napi") {
  try { $r = & node -e "try{require('uiohook-napi');console.log('ok')}catch(e){console.log('fail')}" 2>&1
    if($r -match 'ok') { Write-Host "    7. Keyboard        OK" -ForegroundColor Green; $pass++ }
    else { Write-Host "    7. Keyboard        WARN (safe polling)" -ForegroundColor Yellow; $pass++ }
  } catch { Write-Host "    7. Keyboard        WARN" -ForegroundColor Yellow; $pass++ }
} else { Write-Host "    7. Keyboard        FAIL (npm install)" -ForegroundColor Red; $fail++ }

# Summary
Write-Host ""
if ($fail -eq 0) {
  Write-Host "  ALL TESTS PASSED ($pass/7)" -ForegroundColor Green
  Write-Host "  Orbit AI Installation Complete!" -ForegroundColor Green
} else {
  Write-Host "  $pass PASSED, $fail FAILED (of 7)" -ForegroundColor Yellow
  Write-Host "  Orbit AI Installed (watchdog will auto-fix)" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  URL: $REMOTE" -ForegroundColor Cyan
Write-Host ""

# Report
try {
  $hn = [Uri]::EscapeDataString($env:COMPUTERNAME)
  Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" -Headers @{"X-Device-Id"=$hn} `
    -Body "{`"events`":[{`"id`":`"install-$env:COMPUTERNAME-$(Get-Date -Format o)`",`"type`":`"install.complete`",`"source`":`"installer-v4`",`"sessionId`":`"install`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"hostname`":`"$env:COMPUTERNAME`",`"pass`":$pass,`"fail`":$fail,`"daemon`":$($daemonOk.ToString().ToLower())}}]}" `
    -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [DONE] v4 pass=$pass fail=$fail daemon=$daemonOk" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
Pause-Exit 0
