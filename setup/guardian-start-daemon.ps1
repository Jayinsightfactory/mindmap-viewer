# Orbit Guardian start-daemon — generated to %USERPROFILE%\.orbit\start-daemon.ps1
# Placeholder __ORBIT_REMOTE__ and __ORBIT_DIR__ replaced at install time.
# Role: Worker supervisor loop — git sync + spawn personal-agent, auto-restart on exit.
# Worker (personal-agent) has ORBIT_SKIP_REINSTALL=1 — dangerous commands go to watchdog.

$ErrorActionPreference = 'SilentlyContinue'
$env:ORBIT_SKIP_REINSTALL = '1'
Set-Location "$env:USERPROFILE\.orbit"
$env:ORBIT_SERVER_URL = '__ORBIT_REMOTE__'
$repoDir = '__ORBIT_DIR__'
$nodeExePs1 = '__NODE_EXE__'

$nodeExe = $null
$found = Get-Command node -ErrorAction SilentlyContinue
if ($found) { $nodeExe = $found.Source }
if (-not $nodeExe -and (Test-Path $nodeExePs1)) { $nodeExe = $nodeExePs1 }
if (-not $nodeExe -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $nodeExe = 'C:\Program Files\nodejs\node.exe' }
if (-not $nodeExe) { Start-Sleep 60; exit 1 }

try {
  $c = Get-Content "$env:USERPROFILE\.orbit-config.json" -Raw | ConvertFrom-Json
  if ($c.token) { $env:ORBIT_TOKEN = $c.token }
} catch {}

# Duplicate start-daemon guard (schtasks + lnk + Registry may fire together)
$me = $PID
$siblings = Get-WmiObject Win32_Process -Filter "Name='powershell.exe'" | Where-Object {
  $_.ProcessId -ne $me -and $_.CommandLine -like '*start-daemon.ps1*'
}
if ($siblings) { exit 0 }

$dlogPath = "$env:USERPROFILE\.orbit\daemon.log"
while ($true) {
  $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  if ((Get-Item $dlogPath -ErrorAction SilentlyContinue).Length -gt 5MB) {
    try { Move-Item $dlogPath "$dlogPath.bak" -Force -ErrorAction SilentlyContinue } catch {}
  }

  $alive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like '*personal-agent*'
  }
  if ($alive) {
    Start-Sleep -Seconds 10
    continue
  }

  "[$ts] worker start" | Out-File -Append -Encoding utf8 -FilePath $dlogPath
  & $nodeExe "$repoDir\daemon\personal-agent.js" 2>&1 |
    Out-File -Append -Encoding utf8 -FilePath $dlogPath
  "[$ts] worker exit (10s)" | Out-File -Append -Encoding utf8 -FilePath $dlogPath
  Start-Sleep -Seconds 10
}
