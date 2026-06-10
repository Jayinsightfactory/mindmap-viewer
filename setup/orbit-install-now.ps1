# Orbit AI direct install for PowerShell 7+
# Usage: irm https://.../api/install-now.ps1 | iex

$ErrorActionPreference = 'Stop'
$REMOTE = 'https://mindmap-viewer-production-adb2.up.railway.app'
$LOG = Join-Path $env:USERPROFILE 'Desktop\orbit-install.log'

function Log($msg) {
  $line = "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') $msg"
  Write-Host $line
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch {}
}

function Ensure-OrbitPs1Bom([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { return }
  $text = [Text.Encoding]::UTF8.GetString($bytes)
  [IO.File]::WriteAllText($Path, $text, (New-Object Text.UTF8Encoding $true))
}

try {
  Log 'START orbit-install-now.ps1'

  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
  )

  if (-not $isAdmin -and $env:ORBIT_INSTALL_ELEVATED -ne '1') {
    Log 'Not admin - opening UAC window. Click Yes.'
    $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { (Get-Command pwsh).Source } else { 'powershell.exe' }
    $inner = "`$env:ORBIT_INSTALL_ELEVATED='1'; irm '$REMOTE/api/install-now.ps1' | iex"
    Start-Process -FilePath $shell -Verb RunAs -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $inner) -Wait
    Log 'Elevated window closed.'
    Read-Host 'Enter to close this window'
    exit 0
  }

  $ps1Url = "$REMOTE/api/install-final.ps1"
  $ps1Local = Join-Path $env:TEMP 'orbit-install-final.ps1'
  Log "Download $ps1Url"
  Invoke-WebRequest -Uri $ps1Url -OutFile $ps1Local -UseBasicParsing
  Ensure-OrbitPs1Bom $ps1Local

  $winPs = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path $winPs)) { $winPs = 'powershell.exe' }
  Log "Run installer via Windows PowerShell"
  & $winPs -NoProfile -ExecutionPolicy Bypass -WindowStyle Normal -File $ps1Local | Out-Host
  $rc = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 1 }
  Log "EXIT=$rc"
  if ($rc -ne 0) {
    Read-Host 'Install failed. Enter to close'
    exit $rc
  }
  Read-Host 'Install done. Enter to close'
} catch {
  Log "FATAL: $($_.Exception.Message)"
  Read-Host 'Enter to close'
  exit 1
}
