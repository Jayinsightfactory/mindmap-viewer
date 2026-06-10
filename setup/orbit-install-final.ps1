# Orbit AI — Final Install v13 (이름 등록 + Guardian v12 + 가이드 검증)
# Usage: orbit-install-final.bat (관리자 권한)

$ErrorActionPreference = 'Continue'
$REMOTE = if ($env:ORBIT_REMOTE) { $env:ORBIT_REMOTE } else { 'https://mindmap-viewer-production-adb2.up.railway.app' }
$env:ORBIT_SKIP_REINSTALL = '1'
$LOG = Join-Path $env:TEMP 'orbit-install-final.log'

function Write-Log($msg) {
  $line = "$(Get-Date -f 'yyyy-MM-dd HH:mm:ss') $msg"
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch {}
}

function Pause-Exit([int]$Code = 0) {
  Write-Host ''
  if ($Code -ne 0) {
    Write-Host "  설치 실패 (code $Code). 로그: $LOG" -ForegroundColor Red
  }
  Write-Host '  Enter를 누르면 닫습니다...' -ForegroundColor Gray
  try { Read-Host } catch {}
  exit $Code
}

trap {
  Write-Log "FATAL: $_"
  Write-Host "  [FATAL] $_" -ForegroundColor Red
  Pause-Exit 1
}

Write-Log 'START orbit-install-final.ps1'
Write-Host ''
Write-Host '  ================================================' -ForegroundColor Cyan
Write-Host '    Orbit AI 설치 v13 (Guardian + 가이드 검증)' -ForegroundColor Cyan
Write-Host '  ================================================' -ForegroundColor Cyan
Write-Host ''

# [0] orphan cleanup
Write-Host '  [0/4] 기존 설치 프로세스 정리...' -ForegroundColor Cyan
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'orbit-reinstall|install-open|orbit-installer|setup\\install' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# [1] 이름 입력 + PC 등록 (토큰/userId 발급)
Write-Host '  [1/4] PC 등록...' -ForegroundColor Cyan
$hostname = $env:COMPUTERNAME
$windowsUser = $env:USERNAME

Write-Host ''
Write-Host '  본인 이름을 입력하세요 (예: 강현우)' -ForegroundColor Yellow
Write-Host '  (Enter만 누르면 PC이름으로 자동 매칭)' -ForegroundColor Gray
$inputName = (Read-Host '  Name').Trim()
Write-Host ''

try {
  $regBodyObj = @{ hostname = $hostname; windowsUser = $windowsUser }
  if ($inputName) { $regBodyObj.name = $inputName }
  $regBody = $regBodyObj | ConvertTo-Json -Compress
  $reg = Invoke-RestMethod -Uri "$REMOTE/api/setup/auto-register" -Method Post `
    -Headers @{ 'Content-Type' = 'application/json; charset=utf-8' } `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($regBody)) -TimeoutSec 15 -ErrorAction Stop

  $env:ORBIT_TOKEN   = $reg.token
  $env:ORBIT_USER_ID = $reg.userId
  $matchType = if ($reg.matchedByName) { '이름 매칭' } elseif ($reg.reused) { 'PC 재사용' } else { '신규' }
  Write-Host "    등록: $($reg.name) ($matchType)" -ForegroundColor Green
  Write-Host "    User ID: $($reg.userId)" -ForegroundColor Gray
} catch {
  Write-Host "  [ERROR] 등록 실패: $($_.Exception.Message)" -ForegroundColor Red
  Pause-Exit 1
}

# [2] clean-install.ps1 다운로드 (Guardian v12)
Write-Host '  [2/4] 설치 스크립트 다운로드...' -ForegroundColor Cyan
$tempClean = Join-Path $env:TEMP ('orbit-clean-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
try {
  Invoke-WebRequest -Uri "$REMOTE/setup/clean-install.ps1" -OutFile $tempClean -UseBasicParsing -TimeoutSec 60
} catch {
  Write-Host "  [ERROR] 다운로드 실패: $($_.Exception.Message)" -ForegroundColor Red
  Pause-Exit 1
}

# [3] Guardian 설치 + 가이드 검증 (통과 시에만 종료)
Write-Host '  [3/4] 설치 실행 (가이드 검증 포함)...' -ForegroundColor Cyan
Write-Host ''
Write-Host '  ┌─ 가이드 검증 (설치 마지막) ─────────────────┐' -ForegroundColor Yellow
Write-Host '  │ 1) 화면 아무 곳 클릭 1번                  │' -ForegroundColor White
Write-Host '  │ 2) 메모장 열림 → Ctrl+V 붙여넣기          │' -ForegroundColor White
Write-Host '  │ 3) Enter 1번 → 서버 데이터 확인 후 종료   │' -ForegroundColor White
Write-Host '  └───────────────────────────────────────────┘' -ForegroundColor Yellow
Write-Host ''

$ps51 = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
$psExe = if (Test-Path $ps51) { $ps51 } else { 'powershell.exe' }
& $psExe -NoProfile -ExecutionPolicy Bypass -File $tempClean
$rc = $LASTEXITCODE
Remove-Item $tempClean -ErrorAction SilentlyContinue

# [4] 결과
Write-Host ''
Write-Host '  [4/4] 결과' -ForegroundColor Cyan
$hnEnc = [Uri]::EscapeDataString($hostname)
try {
  $v = Invoke-RestMethod -Uri "$REMOTE/api/install/verify?hostname=$hnEnc" -TimeoutSec 15 -ErrorAction Stop
  if ($v.verified) {
    Write-Host "  ✅ 설치 검증 통과 — chunk $($v.criteria.chunkCount)건, user_id OK" -ForegroundColor Green
  } else {
    Write-Host "  ⚠ 검증 미통과: $($v.message)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "  검증 API 호출 실패 (설치는 계속 진행됨)" -ForegroundColor Gray
}

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*personal-agent*' }
if ($running) {
  Write-Host "  데몬 실행 중 PID $($running.ProcessId)" -ForegroundColor Green
} else {
  Write-Host '  데몬 미실행 — OrbitDaemon이 재시작합니다' -ForegroundColor Yellow
}

Write-Host ''
Write-Host "  PC: $hostname"
Write-Host "  검증: $REMOTE/api/install/verify?hostname=$hnEnc"
Write-Host ''

if ($rc -eq 0) {
  Write-Host '  설치 완료. 5초 후 닫힙니다...' -ForegroundColor Green
  Start-Sleep -Seconds 5
  exit 0
}

Pause-Exit $rc
