# =============================================================================
# decode-boost-revert.ps1 — 해독 병렬 즉시 원복 (전 워커 병렬 1)
# =============================================================================
# 동작: ~/.orbit/cli-parallel-demoted 플래그를 생성한다. 실행 중인 모든 워커는 다음
#   acquire() 에서 parallelLimit()=1 로 떨어져 직렬로 돌아간다(재시작 불필요).
#   이후 띄우는 워커도 플래그가 있으면 병렬 1. 재개는 decode-boost-canary.ps1(플래그 제거).
# 기존 OrbitDecodeBoostRevert(start ps1 복원)와 독립 — 이 플래그는 런타임 즉시 스위치.
# 안전: 워커 프로세스를 죽이지 않는다(taskkill 미사용). 동시도만 1로 낮춘다.
# =============================================================================
param([string]$Reason = 'manual revert')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:USERPROFILE '.orbit'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$flag = Join-Path $dir 'cli-parallel-demoted'
Set-Content -Path $flag -Value ("{0} {1}" -f (Get-Date -Format o), $Reason) -Encoding UTF8
$logLine = "{0} [revert] 병렬 1 강등 플래그 생성: {1}" -f (Get-Date -Format o), $Reason
Add-Content -Path (Join-Path $dir 'decode-boost.log') -Value $logLine
Write-Host "[OK] 병렬 1 강등 플래그 생성 → 전 워커 다음 호출부터 직렬" -ForegroundColor Green
Write-Host "     $flag"
Write-Host "     재개: setup\decode-boost-canary.ps1 -Parallel 2" -ForegroundColor Cyan
