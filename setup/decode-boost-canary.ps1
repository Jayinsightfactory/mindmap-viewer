# =============================================================================
# decode-boost-canary.ps1 — 해독 병렬 카나리 (owner PC, vision-spool 1대만 병렬 N)
# =============================================================================
# 전제: 선별(prefilter) 보강이 먼저 배포·실측되어 품질 유지가 확인된 뒤 실행.
# 동작: ORBIT_CLI_PARALLEL=N 환경으로 스풀 워커를 "그 PID만" 병렬 기동한다.
#   - cli-gate 가 토큰 만료 임박 구간만 직렬 리프레시(회전 토큰 보존).
#   - claude -p 가 401/invalid_grant 를 뱉으면 전 워커 자동 병렬 1 강등 + decode-boost.log 기록.
# 병렬 env 는 start ps1 이 아니라 이 런처 인자/환경에만 둔다 → 기존 OrbitDecodeBoostRevert
#   (start ps1 복원)와 충돌하지 않는다. 즉시 되돌리려면 decode-boost-revert.ps1.
#
# 사용:  powershell -NoProfile -ExecutionPolicy Bypass -File decode-boost-canary.ps1 -Parallel 2
# =============================================================================
param(
  [int]$Parallel = 2,                 # 동시도(1~3). 2로 시작 권장.
  [string]$RepoDir = "$env:USERPROFILE\mindmap-viewer"
)
$ErrorActionPreference = 'Stop'
if ($Parallel -lt 1) { $Parallel = 1 }
if ($Parallel -gt 3) { $Parallel = 3 }

# 1) 강등 플래그가 남아 있으면 제거(이전 카나리의 자동 강등 흔적) — 의도적 재개
$flag = Join-Path $env:USERPROFILE '.orbit\cli-parallel-demoted'
if (Test-Path $flag) { Remove-Item $flag -Force; Write-Host "[reset] 이전 강등 플래그 제거: $flag" -ForegroundColor Yellow }

# 2) 기존 스풀 워커가 있으면 사용자가 먼저 정상 종료할 것(여기서 taskkill 하지 않음 — 안전)
$spool = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -EA SilentlyContinue |
  Where-Object { $_.CommandLine -like '*vision-worker.js*--spool*' }
if ($spool) {
  Write-Host "[주의] 기존 스풀 워커 실행 중 (PID $($spool.ProcessId -join ','))." -ForegroundColor Yellow
  Write-Host "       카나리는 '새로' 병렬로 띄웁니다. 중복 처리를 피하려면 기존 워커를 먼저 종료하세요." -ForegroundColor Yellow
}

# 3) 무과금 CLI + 병렬 env 로 스풀 기동(이 PID만 병렬). 다른 워커/재시작엔 영향 없음.
$env:ANTHROPIC_API_KEY = ''
$env:ORBIT_CLI_PARALLEL = "$Parallel"
$env:VISION_MODEL_ROUTER = 'on'
# 선별도 켜둠(기본 on). 끄려면 $env:VISION_PREFILTER='off'

Set-Location $RepoDir
$log = Join-Path $env:USERPROFILE '.orbit\decode-boost-canary.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Write-Host "[run] node bin/vision-worker.js --spool  (ORBIT_CLI_PARALLEL=$Parallel)" -ForegroundColor Cyan
Write-Host "      로그: $log"
Write-Host "      되돌리기: setup\decode-boost-revert.ps1  (즉시 병렬 1)" -ForegroundColor Green
& node 'bin/vision-worker.js' '--spool' *>> $log
