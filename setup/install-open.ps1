# MOYI - Open Installer (No token required)
# Usage: irm 'https://mindmap-viewer-production-adb2.up.railway.app/setup/install-open.ps1' | iex
#
# Automatically registers this PC and installs the daemon.
# Identity is resolved from activity data (KakaoTalk, window titles, etc.)

$ErrorActionPreference = "Continue"
$REMOTE = "https://mindmap-viewer-production-adb2.up.railway.app"

Write-Host ""
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host "    MOYI — 업무 학습 도구" -ForegroundColor Cyan
Write-Host "  ================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  업무 활동·패턴을 학습해 반복업무 자동화와 효율 개선을 돕는" -ForegroundColor Gray
Write-Host "  회사 업무 지원 도구입니다." -ForegroundColor Gray
Write-Host "    - 자주 쓰는 업무 흐름 분석 → 자동화 후보 발굴" -ForegroundColor DarkGray
Write-Host "    - 앱·작업 시간 패턴 → 업무 효율 리포트" -ForegroundColor DarkGray
Write-Host ""

# Step 1: 업무 환경 등록
Write-Host "  [1/2] 업무 환경 등록 중..." -ForegroundColor Cyan
$hostname = $env:COMPUTERNAME
$windowsUser = $env:USERNAME

# 2026-06-09 added: 자동 식별 정보 수집 (카톡/nenova 프로세스 + 폴더)
# audit + 이름 자동 추정 위한 보조 정보
$kakaoTitle = ''
$nenovaTitle = ''
$kakaoUserFolders = @()
try {
  $kp = Get-Process -Name 'kakaotalk' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if ($kp) { $kakaoTitle = $kp.MainWindowTitle }
} catch {}
try {
  $np = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -and ($_.ProcessName -match 'nenova' -or $_.MainWindowTitle -match 'nenova') } | Select-Object -First 1
  if ($np) { $nenovaTitle = $np.MainWindowTitle }
} catch {}
try {
  $kakaoDir = "$env:APPDATA\KakaoTalk\users"
  if (Test-Path $kakaoDir) {
    $kakaoUserFolders = @(Get-ChildItem $kakaoDir -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  }
} catch {}

# [2026-06-18] 자동 감지정보(카톡/nenova 창제목·폴더)는 이름 매칭에만 쓰고 콘솔엔 표시 안 함
# — 직원이 "내 카톡을 본다"고 오해할 수 있어 노출 제거. 서버 매칭용으로만 조용히 전송.

# 사용자 이름 입력 받기 (이름 우선 매칭, hostname 보조)
Write-Host ""
Write-Host "  본인 이름을 입력하세요 (한글 가능, 예: 강현우)" -ForegroundColor Yellow
Write-Host "  (입력 안 하고 Enter 누르면 hostname 기반 자동 매칭)" -ForegroundColor Gray
$inputName = Read-Host "  Name"
$inputName = $inputName.Trim()
Write-Host ""

try {
  $regBodyObj = @{ hostname = $hostname; windowsUser = $windowsUser }
  if ($inputName)                { $regBodyObj.name           = $inputName }
  if ($kakaoTitle)               { $regBodyObj.kakaoTitle     = $kakaoTitle }
  if ($nenovaTitle)              { $regBodyObj.nenovaTitle    = $nenovaTitle }
  if ($kakaoUserFolders.Count)   { $regBodyObj.kakaoFolders   = $kakaoUserFolders }
  $regBody = $regBodyObj | ConvertTo-Json -Compress
  $reg = Invoke-RestMethod -Uri "$REMOTE/api/setup/auto-register" -Method Post `
    -Headers @{ 'Content-Type' = 'application/json; charset=utf-8' } `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($regBody)) -TimeoutSec 15 -ErrorAction Stop

  $orbitToken = $reg.token
  $orbitUserId = $reg.userId
  $matchType = if ($reg.matchedByName) { "by NAME" } elseif ($reg.reused) { "by HOSTNAME (reused)" } else { "NEW user" }
  Write-Host "    Registered: $($reg.name) ($matchType)" -ForegroundColor Green
  Write-Host "    User ID:  $($orbitUserId.Substring(0, [Math]::Min(12,$orbitUserId.Length)))..." -ForegroundColor Gray
  Write-Host "    Hostname: $hostname" -ForegroundColor Gray
  Write-Host "    Windows:  $windowsUser" -ForegroundColor Gray
  if ($reg.clientIp) { Write-Host "    Your IP:  $($reg.clientIp)" -ForegroundColor Gray }
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

# ── Step 3: 설치 자가검증 (2026-06-15 added — 실패를 조용히 넘기지 않음) ──
# 과거 문제: 설치는 됐는데 토큰 자기파괴/구코드/임시ID로 데이터가 안 와도 알 수 없었음.
# 이제 설치 직후 (1) 토큰이 실유저로 유효한지 (2) 실제 이벤트가 서버에 도착하는지 확인해 알려준다.
Write-Host ""
Write-Host "  [검증] 설치 확인 중 (최대 2분, 데몬 첫 전송까지 대기)..." -ForegroundColor Cyan

$tokenOk = $false
try {
  $v = Invoke-RestMethod -Uri "$REMOTE/api/auth/verify" -Headers @{ Authorization = "Bearer $orbitToken" } -TimeoutSec 15 -ErrorAction Stop
  if ($v.ok) { $tokenOk = $true; Write-Host "    [OK] 토큰 유효 — $($v.name)" -ForegroundColor Green }
} catch {}
if (-not $tokenOk) { Write-Host "    [실패] 토큰 무효 — 관리자에게 문의" -ForegroundColor Red }

$dataOk = $false
$hnEnc = [Uri]::EscapeDataString($hostname)
$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  try {
    $st = Invoke-RestMethod -Uri "$REMOTE/api/install/verify?hostname=$hnEnc" -TimeoutSec 10 -ErrorAction Stop
    if ($st.verified -or ($st.criteria -and $st.criteria.chunkCount -gt 0)) { $dataOk = $true; break }
  } catch {}
  Start-Sleep -Seconds 8
}
if ($dataOk) { Write-Host "    [OK] 데이터 수신 확인 — 서버에 이벤트 도착" -ForegroundColor Green }
else { Write-Host "    [대기] 아직 미도착 — PC를 1~2분 더 쓰면 자동 전송됩니다 (실패 아님)" -ForegroundColor Yellow }

Write-Host ""
if ($tokenOk -and $dataOk) {
  Write-Host "  ================================================" -ForegroundColor Green
  Write-Host "    설치 완료 + 검증 통과 — 정상 작동 중" -ForegroundColor Green
  Write-Host "  ================================================" -ForegroundColor Green
} elseif ($tokenOk) {
  Write-Host "  설치 완료. 데이터 전송은 곧 시작됩니다 (PC 사용 시 자동)." -ForegroundColor Yellow
} else {
  Write-Host "  설치는 됐으나 토큰 검증 실패 — 관리자 확인 필요." -ForegroundColor Red
}
Write-Host "  Press Enter to close..." -ForegroundColor Gray
try { [Console]::ReadKey($true) | Out-Null } catch { Read-Host " " }
