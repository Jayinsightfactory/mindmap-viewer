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

# ── 급사 진단 파일 (boot-diag와 쌍) ─────────────────────────────────────────
# worker-stderr.log : 워커 stdout+stderr 원문(네이티브 abort 메시지가 여기 남는다)
# crash-moment.log  : 워커 종료코드/수명/마지막 boot-stage → 다음 기동 때 boot-diag가 서버로 업로드
# boot-stage.log    : 워커가 각 init 단계를 동기 flush. 마지막 줄 = 죽은 모듈.
$stderrLog        = "$env:USERPROFILE\.orbit\worker-stderr.log"
$crashMoment      = "$env:USERPROFILE\.orbit\crash-moment.log"
$bootStageLog     = "$env:USERPROFILE\.orbit\boot-stage.log"
$STDERR_KEEP      = 2000
$CRASHMOMENT_KEEP = 500

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
  # worker-stderr.log 가 한 번의 긴 런에서 비대해지면(워커가 안 죽어 아래 트림이 안 돌 때) 선제 트림
  if ((Get-Item $stderrLog -ErrorAction SilentlyContinue).Length -gt 5MB) {
    try { Move-Item $stderrLog "$stderrLog.bak" -Force -ErrorAction SilentlyContinue } catch {}
  }

  $alive = Get-WmiObject Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like '*personal-agent*'
  }
  if ($alive) {
    Start-Sleep -Seconds 10
    continue
  }

  "[$ts] worker start" | Out-File -Append -Encoding utf8 -FilePath $dlogPath
  # 워커 stdout+stderr → worker-stderr.log (daemon.log 는 start/exit/breaker 북마크만 유지)
  & $nodeExe "$repoDir\daemon\personal-agent.js" 2>&1 |
    Out-File -Append -Encoding utf8 -FilePath $stderrLog
  $exitCode = $LASTEXITCODE
  $ranSec = [int]((Get-Date) - $startAt).TotalSeconds
  "[$ts] worker exit (ran ${ranSec}s, code=$exitCode)" | Out-File -Append -Encoding utf8 -FilePath $dlogPath

  # ── 급사 순간 보존: 종료코드/수명/마지막 단계 → crash-moment.log ───────────────
  # JS crash-reporter 가 못 잡는 네이티브 종료(프로세스 소멸)도 종료코드로 식별된다:
  #   3221225477(=0xC0000005) access violation, -1073740791(=0xC0000409) stack buffer overrun,
  #   -1073741819 등 음수 = 네이티브 abort / 0 = 정상 graceful exit / 1 = main() throw.
  # lastStage = boot-stage.log 마지막 줄 = 워커가 마지막으로 진입한 init 단계(죽은 모듈).
  $lastStage = ''
  try { $lastStage = (Get-Content $bootStageLog -Tail 1 -ErrorAction SilentlyContinue) } catch {}
  if (-not $lastStage) { $lastStage = '(none)' }
  $exitTs = (Get-Date).ToUniversalTime().ToString('o')
  try { "[exit] code=$exitCode ts=$exitTs ranMs=$($ranSec*1000) lastStage=$lastStage" | Out-File -Append -Encoding utf8 -FilePath $crashMoment } catch {}

  # 로그 꼬리만 유지 (무한 성장 방지) — worker-stderr 최근 $STDERR_KEEP 줄, crash-moment 최근 $CRASHMOMENT_KEEP 줄
  try {
    if (Test-Path $stderrLog) {
      $sl = @(Get-Content $stderrLog -ErrorAction SilentlyContinue)
      if ($sl.Count -gt $STDERR_KEEP) { $sl[($sl.Count - $STDERR_KEEP)..($sl.Count - 1)] | Set-Content $stderrLog -Encoding utf8 }
    }
  } catch {}
  try {
    if (Test-Path $crashMoment) {
      $cm = @(Get-Content $crashMoment -ErrorAction SilentlyContinue)
      if ($cm.Count -gt $CRASHMOMENT_KEEP) { $cm[($cm.Count - $CRASHMOMENT_KEEP)..($cm.Count - 1)] | Set-Content $crashMoment -Encoding utf8 }
    }
  } catch {}

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
