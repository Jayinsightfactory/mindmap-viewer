# Orbit AI - Windows Installer v3
# Usage: irm 'https://서버/setup/install.ps1' | iex
# Token optional: $env:ORBIT_TOKEN='xxx'; irm '...' | iex

$ErrorActionPreference = "Continue"
$REMOTE   = "https://mindmap-viewer-production-adb2.up.railway.app"
$REPO     = "https://github.com/Jayinsightfactory/mindmap-viewer.git"
$DIR      = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir = "$env:USERPROFILE\.orbit"
$LOG_FILE = "$OrbitDir\install.log"

New-Item -ItemType Directory -Force -Path $OrbitDir -ErrorAction SilentlyContinue | Out-Null

function Pause-Exit([int]$Code = 0) {
  Write-Host ""
  if ($Code -ne 0) {
    Write-Host "  Install error. Log: $LOG_FILE" -ForegroundColor Yellow
  }
  Write-Host "  Press Enter to close..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { try { Read-Host " " } catch {} }
  exit $Code
}

trap {
  Write-Host "  [ERROR] $_" -ForegroundColor Red
  "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [ERROR] $_ at line $($_.InvocationInfo.ScriptLineNumber)" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
  Pause-Exit 1
}

# ── Admin auto-elevate ──
$_isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $_isAdmin) {
  Write-Host "  Elevating to admin..." -ForegroundColor Yellow
  $tempScript = "$env:TEMP\orbit-install.ps1"
  try {
    Invoke-WebRequest -Uri "$REMOTE/setup/install.ps1" -OutFile $tempScript -TimeoutSec 30 -ErrorAction Stop
  } catch {
    $MyInvocation.MyCommand.ScriptBlock | Out-File $tempScript -Encoding UTF8 -ErrorAction SilentlyContinue
  }
  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$tempScript`"" -Wait
  } catch {
    powershell.exe -ExecutionPolicy Bypass -File $tempScript
  }
  exit 0
}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] install.ps1 v3 Admin=$_isAdmin" | Out-File $LOG_FILE -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  +--------------------------------------+"
Write-Host "  |   Orbit AI Installation v3            |"
Write-Host "  +--------------------------------------+"
Write-Host ""
Write-Host "  PC       : $env:COMPUTERNAME" -ForegroundColor Cyan
Write-Host "  User     : $env:USERNAME" -ForegroundColor Cyan
Write-Host "  Server   : $REMOTE" -ForegroundColor Cyan
Write-Host ""

# ══════════════════════════════════════════════════════════════════════════════
# Step 0: Clean up previous installation
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [0/8] Cleaning previous installation..." -ForegroundColor Cyan

# Kill existing daemon processes
Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*personal-agent*"
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Get-Process -Name "wscript" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Remove old Task Scheduler entry
schtasks /delete /tn "OrbitDaemon" /f 2>$null | Out-Null

# Remove old Startup files
$StartupDir = [System.Environment]::GetFolderPath('Startup')
'orbit-daemon.vbs', 'orbit-daemon.bat' | ForEach-Object {
  $f = "$StartupDir\$_"
  if (Test-Path $f) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

# Backup old config (preserve token if exists)
$oldToken = ""; $oldUserId = ""
if (Test-Path "$env:USERPROFILE\.orbit-config.json") {
  try {
    $old = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json
    $oldToken = $old.token; $oldUserId = $old.userId
  } catch {}
}
Write-Host "  Previous installation cleaned" -ForegroundColor Green

# ══════════════════════════════════════════════════════════════════════════════
# Step 1-2.5: Install dependencies (Node, Git, Python, Java, Defender)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [1/8] Checking Node.js..." -ForegroundColor Cyan
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command node -ErrorAction SilentlyContinue) { $installed = $true }
  }
  if (-not $installed) {
    $nodeMsi = "$env:TEMP\node-install.msi"
    Invoke-WebRequest -Uri "https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi" -OutFile $nodeMsi -TimeoutSec 120 -ErrorAction SilentlyContinue
    if (Test-Path $nodeMsi) {
      Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /qn ADDLOCAL=ALL" -Wait -ErrorAction SilentlyContinue
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      if (Get-Command node -ErrorAction SilentlyContinue) { $installed = $true }
    }
  }
  if (-not $installed) { Write-Host "  [ERROR] Node.js install failed." -ForegroundColor Red; Pause-Exit 1 }
  $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
}
Write-Host "  Node.js: $(node --version 2>$null)" -ForegroundColor Green

Write-Host "  [2/8] Checking Git..." -ForegroundColor Cyan
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install Git.Git --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    $gitExe = "$env:TEMP\git-install.exe"
    Invoke-WebRequest -Uri "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe" -OutFile $gitExe -TimeoutSec 120 -ErrorAction SilentlyContinue
    if (Test-Path $gitExe) {
      Start-Process $gitExe -ArgumentList "/VERYSILENT /NORESTART" -Wait -ErrorAction SilentlyContinue
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    }
  }
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "  [ERROR] Git install failed." -ForegroundColor Red; Pause-Exit 1 }
}
Write-Host "  Git: $(git --version 2>$null)" -ForegroundColor Green

Write-Host "  [2.5/8] Checking Python + Java..." -ForegroundColor Cyan
# Python
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements 2>$null }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (Get-Command python -ErrorAction SilentlyContinue) {
  python -m pip install --quiet pyautogui pillow requests 2>$null
  Write-Host "  Python: $(python --version 2>$null)" -ForegroundColor Green
}
# Java
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) { winget install Microsoft.OpenJDK.21 --silent --accept-source-agreements --accept-package-agreements 2>$null }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (Get-Command java -ErrorAction SilentlyContinue) {
  Write-Host "  Java: $(java -version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
}
# Defender
try {
  Add-MpPreference -ExclusionPath $DIR -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionPath $OrbitDir -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionProcess "node.exe" -ErrorAction SilentlyContinue
} catch {}

# ══════════════════════════════════════════════════════════════════════════════
# Step 3: Download source
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [3/8] Downloading source..." -ForegroundColor Cyan
if (Test-Path "$DIR\.git") {
  Set-Location $DIR
  $currentRemote = git remote get-url origin 2>$null
  if ($currentRemote -ne $REPO) {
    Write-Host "  Fixing remote: $currentRemote -> $REPO" -ForegroundColor Yellow
    git remote set-url origin $REPO 2>$null
  }
  git fetch origin 2>$null
  git reset --hard origin/main 2>$null
  Write-Host "  Updated" -ForegroundColor Green
} else {
  if (Test-Path $DIR) { Remove-Item $DIR -Recurse -Force -ErrorAction SilentlyContinue }
  git clone $REPO $DIR 2>$null
  if (-not (Test-Path "$DIR\package.json")) { Write-Host "  [ERROR] Clone failed." -ForegroundColor Red; Pause-Exit 1 }
  Write-Host "  Downloaded" -ForegroundColor Green
}
Set-Location $DIR

# ══════════════════════════════════════════════════════════════════════════════
# Step 4: npm install
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [4/8] Installing packages..." -ForegroundColor Cyan
if (-not (Test-Path "$DIR\node_modules\uiohook-napi")) {
  npm install --silent 2>&1 | Out-Null
}
if (Test-Path "$DIR\node_modules") { Write-Host "  Packages ready" -ForegroundColor Green }
else { Write-Host "  [WARN] node_modules missing" -ForegroundColor Yellow }

# ══════════════════════════════════════════════════════════════════════════════
# Step 5: Save config — NO TOKEN REQUIRED
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [5/8] Saving config..." -ForegroundColor Cyan

# Token: env var > old config > empty (all optional)
$cfgToken = if ($env:ORBIT_TOKEN -and $env:ORBIT_TOKEN.Length -gt 5) { $env:ORBIT_TOKEN } elseif ($oldToken) { $oldToken } else { "" }
$cfgUserId = if ($oldUserId -and $oldUserId -ne "local") { $oldUserId } else { "" }

$cfg = @{
  serverUrl = $REMOTE
  hostname  = $env:COMPUTERNAME
  token     = $cfgToken
  userId    = $cfgUserId
}
[System.IO.File]::WriteAllText("$env:USERPROFILE\.orbit-config.json", ($cfg | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
[System.Environment]::SetEnvironmentVariable("ORBIT_SERVER_URL", $REMOTE, "User") 2>$null
Write-Host "  Config saved (hostname: $env:COMPUTERNAME)" -ForegroundColor Green

# ══════════════════════════════════════════════════════════════════════════════
# Step 6: Register startup (Task Scheduler with auto-restart)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [6/8] Registering startup..." -ForegroundColor Cyan

$nodeExePs1 = if ($NodePath) { $NodePath -replace '\\', '\\\\' } else { '' }
$ps1Path = "$OrbitDir\start-daemon.ps1"
$ps1Content = @"
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location "`$env:USERPROFILE\.orbit"
`$env:ORBIT_SERVER_URL = '$REMOTE'

`$nodeExe = `$null
`$found = Get-Command node -ErrorAction SilentlyContinue
if (`$found) { `$nodeExe = `$found.Source }
if (-not `$nodeExe -and (Test-Path '$nodeExePs1')) { `$nodeExe = '$nodeExePs1' }
if (-not `$nodeExe -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { `$nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not `$nodeExe) {
  "[`$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))] ERROR: node.exe not found" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  Start-Sleep -Seconds 60; exit 1
}

try {
  `$cfg = Get-Content "`$env:USERPROFILE\.orbit-config.json" -Raw -ErrorAction Stop | ConvertFrom-Json
  if (`$cfg.token) { `$env:ORBIT_TOKEN = `$cfg.token }
} catch {}

while (`$true) {
  `$ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  "[`$ts] daemon start" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  & `$nodeExe "`$env:USERPROFILE\mindmap-viewer\daemon\personal-agent.js" 2>&1 | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  "[`$ts] daemon exit (restart in 10s)" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  Start-Sleep -Seconds 10
}
"@
[System.IO.File]::WriteAllText($ps1Path, $ps1Content, [System.Text.Encoding]::UTF8)

# Task Scheduler with RestartCount 999 (auto-restart on crash)
$taskRegistered = $false
try {
  $psArg = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$ps1Path`""
  $result = schtasks /create /tn "OrbitDaemon" /tr "powershell.exe $psArg" /sc onlogon /rl limited /f 2>&1
  if ($LASTEXITCODE -eq 0) {
    $taskRegistered = $true
    Write-Host "  Task Scheduler registered" -ForegroundColor Green
  }
} catch {}

if (-not $taskRegistered) {
  $vbsContent = "CreateObject(""WScript.Shell"").Run ""powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File """"$ps1Path"""""", 0, False"
  [System.IO.File]::WriteAllText("$StartupDir\orbit-daemon.vbs", $vbsContent, [System.Text.Encoding]::ASCII)
  Write-Host "  Startup folder registered (fallback)" -ForegroundColor Yellow
}

# ══════════════════════════════════════════════════════════════════════════════
# Step 7: Start daemon
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [7/8] Starting daemon..." -ForegroundColor Cyan
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NonInteractive -ExecutionPolicy Bypass -File `"$ps1Path`""
Start-Sleep -Seconds 5

$pidFile = "$OrbitDir\personal-agent.pid"
$newPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($newPid -and (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
  Write-Host "  Daemon running (PID: $newPid)" -ForegroundColor Green
} else {
  Write-Host "  Daemon starting... (will auto-start on login)" -ForegroundColor Yellow
}

# ══════════════════════════════════════════════════════════════════════════════
# Step 8: Verify data reception
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "  [8/8] Verifying server connection..." -ForegroundColor Cyan

$verified = $false
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 5
  try {
    $regResult = Invoke-RestMethod -Uri "$REMOTE/api/daemon/register" -Method POST `
      -ContentType "application/json" `
      -Body "{`"hostname`":`"$env:COMPUTERNAME`",`"platform`":`"win32`",`"nodeVersion`":`"$(node --version 2>$null)`"}" `
      -TimeoutSec 10 -ErrorAction Stop

    if ($regResult.ok) {
      $verified = $true
      if ($regResult.matched -and $regResult.token) {
        # Server auto-matched this hostname to a user + issued token
        $cfg.token = $regResult.token
        $cfg.userId = $regResult.userId
        [System.IO.File]::WriteAllText("$env:USERPROFILE\.orbit-config.json", ($cfg | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
        Write-Host "  Server connected + auto-matched: $($regResult.userId)" -ForegroundColor Green
      } else {
        Write-Host "  Server connected (hostname: $env:COMPUTERNAME)" -ForegroundColor Green
        Write-Host "  Login at $REMOTE to link this PC to your account" -ForegroundColor Yellow
      }
      break
    }
  } catch {
    if ($i -eq 6) { Write-Host "  [WARN] Server unreachable - daemon will retry automatically" -ForegroundColor Yellow }
  }
}

# ══════════════════════════════════════════════════════════════════════════════
# Done
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "  +------------------------------------------+"
Write-Host "  |   Orbit AI Installation Complete!         |"
Write-Host "  +------------------------------------------+"
Write-Host ""
Write-Host "  URL: $REMOTE" -ForegroundColor Cyan
if (-not $regResult.matched) {
  Write-Host "  Next: Login at the URL above and click 'Link PC'" -ForegroundColor Yellow
}
Write-Host ""

# Report to server
try {
  Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" `
    -Body "{`"events`":[{`"id`":`"install-done-$env:COMPUTERNAME-$(Get-Date -Format o)`",`"type`":`"install.complete`",`"source`":`"installer-v3`",`"sessionId`":`"install-$env:COMPUTERNAME`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"step`":`"complete`",`"hostname`":`"$env:COMPUTERNAME`",`"verified`":$($verified.ToString().ToLower()),`"matched`":$($regResult.matched.ToString().ToLower())}}]}" `
    -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [DONE] install v3 complete verified=$verified matched=$($regResult.matched)" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue

Pause-Exit 0
