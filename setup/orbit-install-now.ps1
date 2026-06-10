# Orbit AI — PowerShell direct install (bat 없이)
# 관리자 PowerShell에서: irm URL | iex  또는  powershell -File orbit-install-now.ps1

$ErrorActionPreference = 'Stop'
$REMOTE = 'https://mindmap-viewer-production-adb2.up.railway.app'
$LOG = Join-Path $env:USERPROFILE 'Desktop\orbit-install.log'

function Log($msg) {
  $line = "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  Add-Content -Path $LOG -Value $line -Encoding UTF8
}

try {
  Log 'START orbit-install-now.ps1'
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    Log 'ERROR: Admin required. Re-run PowerShell as Administrator.'
    Read-Host 'Enter to close'
    exit 1
  }

  $ps1Url = "$REMOTE/api/install-final.ps1"
  $ps1Local = Join-Path $env:TEMP 'orbit-install-final.ps1'
  Log "Download $ps1Url"
  Invoke-WebRequest -Uri $ps1Url -OutFile $ps1Local -UseBasicParsing

  $bytes = [IO.File]::ReadAllBytes($ps1Local)
  if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    [IO.File]::WriteAllText($ps1Local, $text, (New-Object Text.UTF8Encoding $true))
  }

  $winPs = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path $winPs)) { $winPs = 'powershell.exe' }
  Log "Run installer via $winPs"
  & $winPs -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File $ps1Local
  $rc = $LASTEXITCODE
  Log "EXIT=$rc"
  if ($rc -ne 0) { Read-Host 'Install failed. Enter to close'; exit $rc }
} catch {
  Log "FATAL: $($_.Exception.Message)"
  Read-Host 'Enter to close'
  exit 1
}
