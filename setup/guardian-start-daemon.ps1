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

# ── Crash-loop circuit breaker (2026-10-05) ─────────────────────────────────
# 문제: personal-agent가 시작 직후 네이티브 종료(AV kill / OOM abort / 중복감시)로
#       죽으면 JS crash-reporter가 못 잡고(스택 없음), 이 루프는 10초 간격으로 영원히
#       재spawn → CPU만 태움. crash-reporter의 .safe-mode는 "JS crash 3회/1h"만 트리거라
#       네이티브 종료엔 안 걸린다. 그래서 수퍼바이저 레벨에서 직접 급사 횟수를 센다.
# 규칙: 시작 후 FAST_EXIT_SEC 미만에 죽는 일이 WINDOW_SEC 안에 MAX_FAST회 연속이면
#       .safe-mode(타임스탬프+사유) 기록 후 BACKOFF_SEC(10분) 대기 → poison 입력/네이티브
#       kill이 CPU를 무한정 태우지 못하게 한다. (COM New-Object 없음, 새 창 없음)
$FAST_EXIT_SEC = 15
$MAX_FAST      = 5
$WINDOW_SEC    = 180
$BACKOFF_SEC   = 600
$safeModePath  = "$env:USERPROFILE\.orbit\.safe-mode"
$cbLogPath     = "$env:USERPROFILE\.orbit\crashloop.log"
$fastCount     = 0
$firstFastAt   = $null

while ($true) {
  $startAt = Get-Date
  $ts = $startAt.ToString('yyyy-MM-dd HH:mm:ss')
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
  $ranSec = [int]((Get-Date) - $startAt).TotalSeconds
  "[$ts] worker exit (ran ${ranSec}s)" | Out-File -Append -Encoding utf8 -FilePath $dlogPath

  if ($ranSec -lt $FAST_EXIT_SEC) {
    if ($fastCount -eq 0) { $firstFastAt = $startAt }
    $fastCount++
    $windowSec = [int]((Get-Date) - $firstFastAt).TotalSeconds
    if ($fastCount -ge $MAX_FAST -and $windowSec -le $WINDOW_SEC) {
      $reason = "native fast-exit x$fastCount in ${windowSec}s (last ran ${ranSec}s) — circuit breaker"
      $expiresAt = (Get-Date).ToUniversalTime().AddMilliseconds($BACKOFF_SEC * 1000).ToString('o')
      $payload = '{"ts":"' + (Get-Date).ToUniversalTime().ToString('o') + '","reason":"' + $reason + '","ttlMs":' + ($BACKOFF_SEC * 1000) + ',"expiresAt":"' + $expiresAt + '","source":"start-daemon-breaker"}'
      try { $payload | Out-File -Encoding utf8 -FilePath $safeModePath -Force } catch {}
      "[$ts] CIRCUIT BREAKER: $reason -> back off ${BACKOFF_SEC}s" | Out-File -Append -Encoding utf8 -FilePath $cbLogPath
      "[$ts] CIRCUIT BREAKER tripped ($reason) — sleeping ${BACKOFF_SEC}s" | Out-File -Append -Encoding utf8 -FilePath $dlogPath
      Start-Sleep -Seconds $BACKOFF_SEC
      $fastCount = 0
      $firstFastAt = $null
      continue
    }
    if ($windowSec -gt $WINDOW_SEC) { $fastCount = 1; $firstFastAt = $startAt }
  } else {
    # 정상 수명으로 돌았으면 연속 카운터 리셋
    $fastCount = 0
    $firstFastAt = $null
  }

  Start-Sleep -Seconds 10
}
