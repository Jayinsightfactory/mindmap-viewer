# setup/install-guided-verify.ps1
# 설치 직후 가이드 검증 — "90초 작업" 대신 단계별 클릭/입력 → 서버 실시간 확인
# Usage: . .\install-guided-verify.ps1; Invoke-OrbitGuidedInstallVerify -Remote $REMOTE

function Invoke-OrbitGuidedInstallVerify {
  param(
    [Parameter(Mandatory = $true)][string]$Remote,
    [int]$StepTimeoutSec = 45,
    [int]$PollSec = 3
  )

  $hn = $env:COMPUTERNAME
  $hnEnc = [Uri]::EscapeDataString($hn)
  $token = "ORBIT-VERIFY-$hn-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $since = (Get-Date).ToUniversalTime().ToString('o')
  $results = @{ pass = 0; fail = 0; steps = @() }

  function Wait-VerifyStep {
    param([string]$Step, [string]$Label, [int]$Timeout = 45)
    $deadline = (Get-Date).AddSeconds($Timeout)
    $sinceEnc = [Uri]::EscapeDataString($since)
    while ((Get-Date) -lt $deadline) {
      try {
        $url = "$Remote/api/install/verify-step?hostname=$hnEnc&step=$Step&since=$sinceEnc"
        if ($Step -eq 'keyboard' -or $Step -eq 'clipboard') {
          $url += "&token=$([Uri]::EscapeDataString($token))"
        }
        $r = Invoke-RestMethod -Uri $url -TimeoutSec 12 -ErrorAction Stop
        if ($r.ok -and $r.verified) {
          Write-Host "      ✓ $Label" -ForegroundColor Green
          return $true
        }
      } catch {}
      Start-Sleep -Seconds $PollSec
      Write-Host "." -NoNewline -ForegroundColor DarkGray
    }
    Write-Host ""
    Write-Host "      ✗ $Label (시간 초과)" -ForegroundColor Red
    return $false
  }

  Write-Host ""
  Write-Host "  ┌─────────────────────────────────────────────┐" -ForegroundColor Cyan
  Write-Host "  │  Orbit 설치 검증 — 2단계 (각 최대 ${StepTimeoutSec}초)   │" -ForegroundColor Cyan
  Write-Host "  └─────────────────────────────────────────────┘" -ForegroundColor Cyan
  Write-Host ""

  # [2026-06-10] 마우스 단계 제거 — mouse.chunk는 30~60초 배치 전송이라 검증 타임아웃을
  # 못 넘겨 구조적으로 실패. 마우스는 데몬이 평소 수집하므로 검증에서만 제외. 키보드+화면만 확인.
  # ── 1단계: 키보드 입력 (메모장 + 붙여넣기) ───────────────────────
  Write-Host "  [1/2] 키보드" -ForegroundColor Yellow
  Write-Host "        → 메모장이 열립니다. 아래 문자열을 붙여넣기(Ctrl+V) 하세요" -ForegroundColor White
  Write-Host ""
  Write-Host "        $token" -ForegroundColor Cyan
  Write-Host ""
  try {
    Set-Clipboard -Value $token
    Write-Host "        (클립보드에 복사됨 — 메모장에서 Ctrl+V)" -ForegroundColor DarkGray
  } catch {
    Write-Host "        (클립보드 복사 실패 — 위 문자열을 직접 입력)" -ForegroundColor Yellow
  }
  Start-Process notepad.exe -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Write-Host -NoNewline "        서버 확인 중"
  $kbOk = Wait-VerifyStep -Step 'clipboard' -Label 'clipboard/keyboard 수신' -Timeout $StepTimeoutSec
  if ($kbOk) {
    $results.pass++; $results.steps += @{ step = 2; name = 'keyboard'; ok = $true }
  } else {
    $results.fail++; $results.steps += @{ step = 2; name = 'keyboard'; ok = $false }
  }

  # ── 2단계: Enter → 화면 캡처 ─────────────────────────────────────
  Write-Host ""
  Write-Host "  [2/2] 화면 캡처" -ForegroundColor Yellow
  Write-Host "        → 메모장에서 Enter 키 1번 누르세요 (화면 캡처 트리거)" -ForegroundColor White
  Write-Host -NoNewline "        서버 확인 중"
  if (Wait-VerifyStep -Step 'screen' -Label 'screen.capture 수신' -Timeout $StepTimeoutSec) {
    $results.pass++; $results.steps += @{ step = 3; name = 'screen'; ok = $true }
  } else {
    $results.fail++; $results.steps += @{ step = 3; name = 'screen'; ok = $false }
  }

  # ── 최종: user_id + 통합 검증 ─────────────────────────────────────
  Write-Host ""
  Write-Host -NoNewline "  최종 user_id 검증 중"
  $finalOk = $false
  $final = $null
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    try {
      $final = Invoke-RestMethod -Uri "$Remote/api/install/verify?hostname=$hnEnc" -TimeoutSec 12 -ErrorAction Stop
      if ($final.ok -and $final.verified) { $finalOk = $true; break }
    } catch {}
    Start-Sleep -Seconds 2
    Write-Host "." -NoNewline -ForegroundColor DarkGray
  }
  Write-Host ""
  if ($finalOk) {
    Write-Host "  ✓ 설치 검증 통과 — 실제 chunk + user_id OK ($($final.criteria.observedUserIds -join ', '))" -ForegroundColor Green
    $results.pass++
  } else {
    $msg = if ($final.message) { $final.message } else { 'chunk/user_id 미확인' }
    Write-Host "  ✗ 최종 검증 실패: $msg" -ForegroundColor Red
    $results.fail++
  }

  $results.verified = ($results.fail -eq 0 -and $finalOk)
  $results.token = $token
  $results.final = $final
  return $results
}
