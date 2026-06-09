# Orbit AI — Final Install (name input + fix daemon built-in)
# Usage: orbit-install-final.bat (admin)

$ErrorActionPreference = 'Continue'
$REMOTE = if ($env:ORBIT_REMOTE) { $env:ORBIT_REMOTE } else { 'https://mindmap-viewer-production-adb2.up.railway.app' }
$env:ORBIT_SKIP_REINSTALL = '1'
$env:ORBIT_SKIP_COMMANDS = '1'

Write-Host ''
Write-Host '  ================================================' -ForegroundColor Cyan
Write-Host '    Orbit AI Final Install (fix daemon included)' -ForegroundColor Cyan
Write-Host '  ================================================' -ForegroundColor Cyan
Write-Host ''

# [0] orphan cleanup
Write-Host '  [0/3] Cleaning orphan install processes...' -ForegroundColor Cyan
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'orbit-reinstall|install-open|orbit-installer|setup\\install' } |
  ForEach-Object {
    Write-Host "    kill PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# [1] download install-open.ps1
Write-Host '  [1/3] Download installer...' -ForegroundColor Cyan
$tempPs = Join-Path $env:TEMP ('orbit-install-final-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
  Invoke-WebRequest -Uri "$REMOTE/setup/install-open.ps1" -OutFile $tempPs -UseBasicParsing -TimeoutSec 60
} catch {
  Write-Host "  [ERROR] Download failed: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host '  Press Enter'
  exit 1
}

# [2] run install-open (name input + install.ps1 — fix block at end)
Write-Host '  [2/3] Running install (enter your name when asked)...' -ForegroundColor Cyan
Write-Host ''
$ps51 = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
$psExe = if (Test-Path $ps51) { $ps51 } else { 'powershell.exe' }
& $psExe -NoProfile -ExecutionPolicy Bypass -File $tempPs
$rc = $LASTEXITCODE
Remove-Item $tempPs -ErrorAction SilentlyContinue

# [3] verify daemon
Write-Host ''
Write-Host '  [3/3] Verify daemon...' -ForegroundColor Cyan
Start-Sleep -Seconds 5
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*personal-agent*' }
if ($running) {
  Write-Host "  [OK] Daemon running PID $($running.ProcessId)" -ForegroundColor Green
} else {
  $sd = Join-Path $env:USERPROFILE '.orbit\start-daemon.ps1'
  if (Test-Path $sd) {
    Start-Process $psExe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$sd) -WindowStyle Hidden
    Start-Sleep -Seconds 8
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*personal-agent*' }
  }
  if ($running) { Write-Host "  [OK] Daemon started PID $($running.ProcessId)" -ForegroundColor Green }
  else { Write-Host '  [WARN] Daemon not running — run orbit-fix-daemon.bat' -ForegroundColor Yellow }
}

Write-Host ''
Write-Host "  PC: $env:COMPUTERNAME"
Write-Host "  Verify: $REMOTE/api/daemon/verify-install?hostname=$env:COMPUTERNAME"
Write-Host ''
Read-Host '  Press Enter to close'
exit $rc
