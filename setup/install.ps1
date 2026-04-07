# Orbit AI - Windows Installer
# Usage: $env:ORBIT_TOKEN='YOUR_TOKEN'; irm 'URL/setup/install.ps1' | iex
param([string]$Token = $env:ORBIT_TOKEN)

$ErrorActionPreference = "Continue"
$REMOTE   = "https://sparkling-determination-production-c88b.up.railway.app"
$REPO     = "https://github.com/dlaww-wq/mindmap-viewer.git"
$DIR      = "$env:USERPROFILE\mindmap-viewer"
$OrbitDir = "$env:USERPROFILE\.orbit"
$BANK_MODE = $false
$SCRIPT_URL = "$REMOTE/setup/install.ps1"
$LOG_FILE = "$env:USERPROFILE\.orbit\install.log"

New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.orbit" -ErrorAction SilentlyContinue | Out-Null

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
  Write-Host ""
  Write-Host "  [ERROR] $_" -ForegroundColor Red
  Write-Host "  Line: $($_.InvocationInfo.ScriptLineNumber)" -ForegroundColor Yellow
  "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [ERROR] $_ at line $($_.InvocationInfo.ScriptLineNumber)" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue
  Pause-Exit 1
}

# Check admin and auto-elevate
$_isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $_isAdmin) {
  Write-Host ""
  Write-Host "  Elevating to admin..." -ForegroundColor Yellow

  $tempScript = "$env:TEMP\orbit-install.ps1"
  $tempToken  = "$env:TEMP\orbit-install-token.txt"
  if ($Token) { $Token | Out-File $tempToken -Encoding UTF8 -Force -ErrorAction SilentlyContinue }

  try {
    Invoke-WebRequest -Uri $SCRIPT_URL -OutFile $tempScript -TimeoutSec 30 -ErrorAction Stop
  } catch {
    Write-Host "  Download failed - using local copy" -ForegroundColor Yellow
    $MyInvocation.MyCommand.ScriptBlock | Out-File $tempScript -Encoding UTF8 -ErrorAction SilentlyContinue
  }

  $argList = "-NoExit -ExecutionPolicy Bypass -File `"$tempScript`""

  try {
    Start-Process powershell.exe -Verb RunAs -ArgumentList $argList -Wait
  } catch {
    Write-Host "  Elevation failed - continuing without admin" -ForegroundColor Yellow
    powershell.exe -ExecutionPolicy Bypass -File $tempScript
  }

  Remove-Item $tempToken -Force -ErrorAction SilentlyContinue
  exit 0
}

# Restore token from temp file (env vars not passed to elevated process)
if (-not $Token -or $Token.Length -le 5) {
  $tempToken = "$env:TEMP\orbit-install-token.txt"
  if (Test-Path $tempToken) {
    $Token = (Get-Content $tempToken -Raw -ErrorAction SilentlyContinue).Trim()
    Remove-Item $tempToken -Force -ErrorAction SilentlyContinue
  }
}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [START] install.ps1 Admin=$_isAdmin Token=$($Token.Length)chars" | Out-File $LOG_FILE -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "  +--------------------------------------+"
Write-Host "  |   Orbit AI Installation               |"
Write-Host "  +--------------------------------------+"
Write-Host ""

# PC / Token matching display
$tokenPreview = if ($Token.Length -gt 8) { $Token.Substring(0,12) + "..." + $Token.Substring($Token.Length-4) } else { "(none)" }
Write-Host "  PC       : $env:COMPUTERNAME" -ForegroundColor Cyan
Write-Host "  User     : $env:USERNAME" -ForegroundColor Cyan
Write-Host "  Token    : $tokenPreview" -ForegroundColor Cyan
Write-Host "  Server   : $REMOTE" -ForegroundColor Cyan
Write-Host ""
if (-not $Token -or $Token.Length -le 5) {
  Write-Host "  [WARN] No token provided. Data will be stored as local user." -ForegroundColor Yellow
  Write-Host "  To link your account: login at $REMOTE and copy your install command." -ForegroundColor Yellow
  Write-Host ""
}

# Step 1: Node.js
Write-Host "  [1/7] Checking Node.js..." -ForegroundColor Cyan
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
  Write-Host "  Node.js not found - installing..." -ForegroundColor Yellow
  $installed = $false

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "  Installing via winget..." -ForegroundColor Gray
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command node -ErrorAction SilentlyContinue) { $installed = $true }
  }

  if (-not $installed) {
    Write-Host "  Downloading Node.js MSI..." -ForegroundColor Gray
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
    Write-Host "  [ERROR] Node.js install failed." -ForegroundColor Red
    Write-Host "  Please install manually: https://nodejs.org/en/download" -ForegroundColor Yellow
    Pause-Exit 1
  }
  $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
}
Write-Host "  Node.js: $(node --version 2>$null)" -ForegroundColor Green

# Step 2: Git
Write-Host "  [2/7] Checking Git..." -ForegroundColor Cyan
$GitPath = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $GitPath) {
  Write-Host "  Git not found - installing..." -ForegroundColor Yellow
  $installed = $false

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install Git.Git --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command git -ErrorAction SilentlyContinue) { $installed = $true }
  }

  if (-not $installed) {
    Write-Host "  Downloading Git installer..." -ForegroundColor Gray
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
    Write-Host "  [ERROR] Git install failed." -ForegroundColor Red
    Write-Host "  Please install manually: https://git-scm.com/download/win" -ForegroundColor Yellow
    Pause-Exit 1
  }
}
Write-Host "  Git: $(git --version 2>$null)" -ForegroundColor Green

# Step 2.5a: Python
Write-Host "  [2.5a/7] Checking Python..." -ForegroundColor Cyan
$PythonPath = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $PythonPath) { $PythonPath = (Get-Command python3 -ErrorAction SilentlyContinue).Source }
if (-not $PythonPath) {
  Write-Host "  Python not found - installing..." -ForegroundColor Yellow
  $pyInstalled = $false

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install Python.Python.3.11 --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command python -ErrorAction SilentlyContinue) { $pyInstalled = $true }
  }

  if (-not $pyInstalled) {
    Write-Host "  Downloading Python installer..." -ForegroundColor Gray
    $pyExe = "$env:TEMP\python-install.exe"
    Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe" -OutFile $pyExe -TimeoutSec 120 -ErrorAction SilentlyContinue
    if (Test-Path $pyExe) {
      Start-Process $pyExe -ArgumentList "/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1" -Wait -ErrorAction SilentlyContinue
      $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
      if (Get-Command python -ErrorAction SilentlyContinue) { $pyInstalled = $true }
    }
  }

  if ($pyInstalled) {
    Write-Host "  Python installed" -ForegroundColor Green
    # Install useful packages for automation
    python -m pip install --quiet pyautogui pillow requests 2>$null
    Write-Host "  Python packages: pyautogui, pillow, requests" -ForegroundColor Green
  } else {
    Write-Host "  [WARN] Python install failed - skipping" -ForegroundColor Yellow
  }
} else {
  Write-Host "  Python: $(python --version 2>$null)" -ForegroundColor Green
  python -m pip install --quiet pyautogui pillow requests 2>$null
}

# Step 2.5b: Java
Write-Host "  [2.5b/7] Checking Java..." -ForegroundColor Cyan
$JavaPath = (Get-Command java -ErrorAction SilentlyContinue).Source
if (-not $JavaPath) {
  Write-Host "  Java not found - installing..." -ForegroundColor Yellow
  $javaInstalled = $false

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install Microsoft.OpenJDK.21 --silent --accept-source-agreements --accept-package-agreements 2>$null
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    if (Get-Command java -ErrorAction SilentlyContinue) { $javaInstalled = $true }
  }

  if (-not $javaInstalled) {
    Write-Host "  Downloading OpenJDK 21..." -ForegroundColor Gray
    $jdkZip = "$env:TEMP\openjdk21.zip"
    Invoke-WebRequest -Uri "https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip" -OutFile $jdkZip -TimeoutSec 180 -ErrorAction SilentlyContinue
    if (Test-Path $jdkZip) {
      $jdkDir = "$env:USERPROFILE\openjdk21"
      Expand-Archive -Path $jdkZip -DestinationPath $jdkDir -Force -ErrorAction SilentlyContinue
      $jdkBin = Get-ChildItem $jdkDir -Recurse -Filter "java.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($jdkBin) {
        [System.Environment]::SetEnvironmentVariable("Path", $env:Path + ";" + $jdkBin.DirectoryName, "User")
        $env:Path = $env:Path + ";" + $jdkBin.DirectoryName
        if (Get-Command java -ErrorAction SilentlyContinue) { $javaInstalled = $true }
      }
    }
  }

  if ($javaInstalled) {
    Write-Host "  Java: $(java -version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
  } else {
    Write-Host "  [WARN] Java install failed - skipping" -ForegroundColor Yellow
  }
} else {
  Write-Host "  Java: $(java -version 2>&1 | Select-Object -First 1)" -ForegroundColor Green
}

# Step 2.5c: Defender exclusions
Write-Host "  [2.5c/7] Adding security exclusions..." -ForegroundColor Cyan
try {
  Add-MpPreference -ExclusionPath $DIR -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionPath $OrbitDir -ErrorAction SilentlyContinue
  Add-MpPreference -ExclusionProcess "node.exe" -ErrorAction SilentlyContinue
  Write-Host "  Defender exclusions added" -ForegroundColor Green
} catch {
  Write-Host "  [INFO] Defender exclusion skipped" -ForegroundColor Yellow
}
"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [DEFENDER] exclusion added: $DIR, $OrbitDir" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue

# Step 3: Source
Write-Host "  [3/7] Downloading source..." -ForegroundColor Cyan
if (Test-Path "$DIR\.git") {
  Set-Location $DIR
  git fetch origin 2>$null
  git reset --hard origin/main 2>$null
  Write-Host "  Updated" -ForegroundColor Green
} else {
  if (Test-Path $DIR) { Remove-Item $DIR -Recurse -Force -ErrorAction SilentlyContinue }
  git clone $REPO $DIR 2>$null
  if (-not (Test-Path "$DIR\package.json")) {
    Write-Host "  [ERROR] Clone failed. Check network." -ForegroundColor Red
    Pause-Exit 1
  }
  Write-Host "  Downloaded" -ForegroundColor Green
}
Set-Location $DIR

# Step 4: npm install
Write-Host "  [4/7] Installing packages (1-2 min)..." -ForegroundColor Cyan
if (-not (Test-Path "$DIR\node_modules\uiohook-napi")) {
  npm install --silent 2>&1 | Out-Null
  if (-not (Test-Path "$DIR\node_modules")) {
    npm install 2>&1 | Out-Null
  }
}
if (Test-Path "$DIR\node_modules") {
  Write-Host "  Packages ready" -ForegroundColor Green
} else {
  Write-Host "  [WARN] node_modules missing - continuing" -ForegroundColor Yellow
}

# Step 5: Config
Write-Host "  [5/7] Saving config..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $OrbitDir | Out-Null
New-Item -ItemType Directory -Force -Path "$DIR\data", "$DIR\snapshots" -ErrorAction SilentlyContinue | Out-Null

$cfgToken = ""; $uid = "local"; $userName = ""; $userEmail = ""
if ($Token -and $Token.Length -gt 5) {
  $cfgToken = $Token
  $verified = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $me = Invoke-RestMethod -Uri "$REMOTE/api/auth/verify" -Headers @{Authorization="Bearer $Token"} -TimeoutSec 15 -ErrorAction Stop
      $uid       = if ($me.userId) { $me.userId } else { "local" }
      $userName  = if ($me.name)   { $me.name }   else { "" }
      $userEmail = if ($me.email)  { $me.email }  else { "" }
      $verified  = $true

      # PC conflict check: 이미 다른 유저 config가 존재하면 중단
      if (Test-Path "$env:USERPROFILE\.orbit-config.json") {
        try {
          $existingCfg = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw -ErrorAction Stop | ConvertFrom-Json
          $existingUid = $existingCfg.userId
          if ($existingUid -and $existingUid -ne "local" -and $existingUid -ne $uid) {
            Write-Host ""
            Write-Host "  +---------------------------------------------------+" -ForegroundColor Red
            Write-Host "  | ERROR: This PC is already registered to another user|" -ForegroundColor Red
            Write-Host "  |  Registered : $existingUid" -ForegroundColor Red
            Write-Host "  |  Your token : $uid ($userName)" -ForegroundColor Red
            Write-Host "  |  -> Ask admin to reassign or use the correct token |" -ForegroundColor Red
            Write-Host "  +---------------------------------------------------+" -ForegroundColor Red
            Write-Host ""
            exit 1
          }
        } catch {}
      }

      # Server-side hostname conflict check (2nd defense)
      try {
        $pcCheck = Invoke-RestMethod -Uri "$REMOTE/api/daemon/check-hostname?hostname=$env:COMPUTERNAME&userId=$uid" -TimeoutSec 8 -ErrorAction Stop
        if ($pcCheck.conflict) {
          Write-Host ""
          Write-Host "  +---------------------------------------------------+" -ForegroundColor Red
          Write-Host "  | ERROR: This PC is already registered on the server |" -ForegroundColor Red
          Write-Host "  |  Registered : $($pcCheck.existingName) ($($pcCheck.existingEmail))" -ForegroundColor Red
          Write-Host "  |  Your token : $userName ($userEmail)" -ForegroundColor Red
          Write-Host "  |  -> Ask admin to reassign this PC                  |" -ForegroundColor Red
          Write-Host "  +---------------------------------------------------+" -ForegroundColor Red
          Write-Host ""
          exit 1
        }
      } catch {}

      Write-Host ""
      Write-Host "  +--------------------------------------+" -ForegroundColor Green
      Write-Host "  | Token matched successfully!           |" -ForegroundColor Green
      Write-Host "  |  PC    : $env:COMPUTERNAME" -ForegroundColor Green
      Write-Host "  |  User  : $userName ($userEmail)" -ForegroundColor Green
      Write-Host "  |  Token : $tokenPreview" -ForegroundColor Green
      Write-Host "  +--------------------------------------+" -ForegroundColor Green
      Write-Host ""
      break
    } catch {
      if ($attempt -lt 3) {
        Start-Sleep -Seconds 3
      } else {
        Write-Host "  [WARN] Token verify failed (attempt 3/3): $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  [INFO] Token saved - open browser, refresh page and re-run install code" -ForegroundColor Yellow
      }
    }
  }
} elseif (Test-Path "$env:USERPROFILE\.orbit-config.json") {
  try {
    $old = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json
    $cfgToken = $old.token; $uid = $old.userId
    if ($uid -and $uid -ne "local") {
      Write-Host "  Existing config: userId=$uid" -ForegroundColor Gray
    }
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
Write-Host "  Config saved" -ForegroundColor Green

# Step 6: Startup
Write-Host "  [6/7] Registering startup..." -ForegroundColor Cyan
$DaemonScript = "$DIR\daemon\personal-agent.js"
$StartupDir   = [System.Environment]::GetFolderPath('Startup')

$batContent = @"
@echo off
cd /d "%USERPROFILE%\.orbit"
set ORBIT_SERVER_URL=$REMOTE

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

$ps1Path = $startBat -replace '\.bat$', '.ps1'
$nodeExePs1 = if ($NodePath) { $NodePath -replace '\\', '\\\\' } else { '' }
$ps1Content = @"
`$ErrorActionPreference = 'SilentlyContinue'
Set-Location "`$env:USERPROFILE\.orbit"
`$env:ORBIT_SERVER_URL = '$REMOTE'
`$env:ORBIT_TOKEN = '$cfgToken'

`$nodeExe = `$null
`$found = Get-Command node -ErrorAction SilentlyContinue
if (`$found) { `$nodeExe = `$found.Source }
if (-not `$nodeExe -and (Test-Path '$nodeExePs1')) { `$nodeExe = '$nodeExePs1' }
if (-not `$nodeExe -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { `$nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not `$nodeExe -and (Test-Path "`$env:APPDATA\nvm\current\node.exe")) { `$nodeExe = "`$env:APPDATA\nvm\current\node.exe" }
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
  `$tp = if (`$env:ORBIT_TOKEN.Length -gt 12) { `$env:ORBIT_TOKEN.Substring(0,12) + '...' } else { `$env:ORBIT_TOKEN }
  "[`$ts] daemon start (token=`$tp)" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  & `$nodeExe "`$env:USERPROFILE\mindmap-viewer\daemon\personal-agent.js" 2>&1 | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  "[`$ts] daemon exit (restart in 10s)" | Add-Content "`$env:USERPROFILE\.orbit\daemon.log"
  Start-Sleep -Seconds 10
}
"@
[System.IO.File]::WriteAllText($ps1Path, $ps1Content, [System.Text.Encoding]::UTF8)

$ps1Path = $startBat -replace '\.bat$', '.ps1'

# Task Scheduler (primary — more reliable than Startup folder VBS)
$taskRegistered = $false
try {
  $taskName = "OrbitDaemon"
  $action   = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$ps1Path`""
  $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([System.TimeSpan]::Zero) `
    -StartWhenAvailable $true
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Force -RunLevel Limited -ErrorAction Stop 2>$null | Out-Null
  $taskRegistered = $true
  Write-Host "  Task Scheduler registered (primary)" -ForegroundColor Green
} catch {
  Write-Host "  Task Scheduler failed ($($_.Exception.Message)), using Startup folder..." -ForegroundColor Yellow
}

# Startup folder VBS (fallback — used only if Task Scheduler fails)
if (-not $taskRegistered) {
  $vbsContent = "CreateObject(""WScript.Shell"").Run ""powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File """"$ps1Path"""""", 0, False"
  $StartupVbs = "$StartupDir\orbit-daemon.vbs"
  [System.IO.File]::WriteAllText($StartupVbs, $vbsContent, [System.Text.Encoding]::ASCII)
  Write-Host "  Startup folder registered (fallback)" -ForegroundColor Yellow
} else {
  # Task Scheduler 성공 시 기존 VBS/BAT 정리 (충돌 방지)
  $StartupVbs = "$StartupDir\orbit-daemon.vbs"
  if (Test-Path $StartupVbs) { Remove-Item $StartupVbs -Force -ErrorAction SilentlyContinue }
}
$oldBat = "$StartupDir\orbit-daemon.bat"
if (Test-Path $oldBat) { Remove-Item $oldBat -Force -ErrorAction SilentlyContinue }

# Step 7: Kill old daemon + Start new one
Write-Host "  [7/7] Starting daemon..." -ForegroundColor Cyan

# Kill ALL existing orbit daemon processes
Write-Host "  Stopping old daemon instances..." -ForegroundColor Gray
$pidFile = "$OrbitDir\personal-agent.pid"
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
  if ($oldPid) { Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
# Kill any node process running personal-agent.js
Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -like "*personal-agent*"
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
# Kill old VBS/bat launcher if running
Get-Process -Name "wscript" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NonInteractive -ExecutionPolicy Bypass -File `"$ps1Path`""
Start-Sleep -Seconds 5
$newPid = Get-Content $pidFile -ErrorAction SilentlyContinue
if ($newPid -and (Get-Process -Id $newPid -ErrorAction SilentlyContinue)) {
  Write-Host "  Daemon running (PID: $newPid)" -ForegroundColor Green
} else {
  Write-Host "  [WARN] Daemon start unconfirmed - will auto-start on reboot" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  +------------------------------------------+"
Write-Host "  |   Orbit AI Installation Complete!         |"
Write-Host "  +------------------------------------------+"
Write-Host ""
Write-Host "  URL: $REMOTE" -ForegroundColor Cyan
Write-Host ""

try {
  Invoke-RestMethod -Uri "$REMOTE/api/hook" -Method POST -ContentType "application/json" `
    -Body "{`"events`":[{`"id`":`"install-done-$env:COMPUTERNAME`",`"type`":`"install.progress`",`"source`":`"installer`",`"sessionId`":`"install-$env:COMPUTERNAME`",`"timestamp`":`"$(Get-Date -Format o)`",`"data`":{`"step`":`"complete`",`"status`":`"ok`",`"hostname`":`"$env:COMPUTERNAME`",`"bankMode`":false}}]}" `
    -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
} catch {}

"$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') [DONE] install complete" | Out-File $LOG_FILE -Append -ErrorAction SilentlyContinue

Pause-Exit 0
