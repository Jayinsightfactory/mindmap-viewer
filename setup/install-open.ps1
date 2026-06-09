# Orbit AI - Open Installer (No token required)
# Usage: irm 'https://mindmap-viewer-production-adb2.up.railway.app/setup/install-open.ps1' | iex
#
# Automatically registers this PC and installs the daemon.
# Identity is resolved from activity data (KakaoTalk, window titles, etc.)

$ErrorActionPreference = "Continue"
$REMOTE = "https://mindmap-viewer-production-adb2.up.railway.app"

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "    Orbit AI - Auto Install" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Auto-register this PC
Write-Host "  [1/2] Registering PC..." -ForegroundColor Cyan
$hostname = $env:COMPUTERNAME
$windowsUser = $env:USERNAME

# 2026-06-09 added: 사용자 이름 입력 받기 (이름 우선 매칭, hostname 보조)
# 같은 직원이 PC 바꿔도 같은 user_id로 매칭됨
Write-Host ""
Write-Host "  본인 이름을 입력하세요 (한글 가능, 예: 강현우)" -ForegroundColor Yellow
Write-Host "  (입력 안 하고 Enter 누르면 hostname 기반 자동 매칭)" -ForegroundColor Gray
$inputName = Read-Host "  Name"
$inputName = $inputName.Trim()
Write-Host ""

try {
  $regBodyObj = @{ hostname = $hostname; windowsUser = $windowsUser }
  if ($inputName) { $regBodyObj.name = $inputName }
  $regBody = $regBodyObj | ConvertTo-Json -Compress
  $reg = Invoke-RestMethod -Uri "$REMOTE/api/setup/auto-register" -Method Post `
    -Headers @{ 'Content-Type' = 'application/json; charset=utf-8' } `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($regBody)) -TimeoutSec 15 -ErrorAction Stop

  $orbitToken = $reg.token
  $orbitUserId = $reg.userId
  $matchType = if ($reg.matchedByName) { "by NAME" } elseif ($reg.reused) { "by HOSTNAME (reused)" } else { "NEW user" }
  Write-Host "    Registered: $($reg.name) ($matchType)" -ForegroundColor Green
  Write-Host "    User ID: $($orbitUserId.Substring(0, [Math]::Min(12,$orbitUserId.Length)))..." -ForegroundColor Gray
} catch {
  Write-Host "    Registration failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "    Press Enter to exit..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { Read-Host " " }
  exit 1
}

# Step 2: Run main installer with the issued token
Write-Host "  [2/2] Starting installation..." -ForegroundColor Cyan
Write-Host ""

$env:ORBIT_TOKEN   = $orbitToken
$env:ORBIT_USER_ID = $orbitUserId

# 2026-06-08 changed: Invoke-Expression removed (AMSI blocks IEX on long scripts under PS7).
# Download to temp file and execute with -File. Force PowerShell 5.1 (Windows built-in) to
# avoid stricter AMSI in PS7. Falls back to current shell if PS5.1 missing.
try {
  $tempPs = Join-Path $env:TEMP ("orbit-installer-" + [Guid]::NewGuid().ToString('N') + ".ps1")
  Invoke-WebRequest -Uri "$REMOTE/setup/install.ps1" -OutFile $tempPs -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
  $ps51 = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
  $psExe = if (Test-Path $ps51) { $ps51 } else { 'powershell.exe' }
  & $psExe -NoProfile -ExecutionPolicy Bypass -File $tempPs
  Remove-Item $tempPs -ErrorAction SilentlyContinue
} catch {
  Write-Host "  Install script download failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Press Enter to exit..." -ForegroundColor Gray
  try { [Console]::ReadKey($true) | Out-Null } catch { Read-Host " " }
  exit 1
}
