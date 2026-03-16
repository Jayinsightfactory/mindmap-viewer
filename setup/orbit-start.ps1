# ═══════════════════════════════════════════════════════════════
# Orbit AI — 원클릭 시작 (Windows PowerShell)
# ───────────────────────────────────────────────────────────────
# PowerShell에 아래 전체를 복붙하세요. 외부 URL 불필요.
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Orbit AI -- 원클릭 시작" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# ── Node.js 확인 ──
$n = $null
try { $n = (Get-Command node -EA SilentlyContinue).Source } catch {}
if (-not $n) {
  $nvm = "$env:APPDATA\nvm"
  if (Test-Path $nvm) {
    $v = Get-ChildItem $nvm -Dir -EA SilentlyContinue | Sort Name -Desc | Select -First 1
    if ($v) { $n = "$($v.FullName)\node.exe" }
  }
}
if (-not $n) { Write-Host "Node.js 없음. https://nodejs.org 설치 필요" -ForegroundColor Red; return }
Write-Host "Node.js: $(& $n --version)" -ForegroundColor Green

# ── [1/7] 퍼미션 ──
Write-Host "`n[1/7] 퍼미션 설정..." -ForegroundColor Cyan
$cd = "$env:USERPROFILE\.claude"
if (!(Test-Path $cd)) { New-Item -ItemType Directory $cd -Force | Out-Null }
@'
{
  "permissions": {
    "allow": [
      "Bash(*)", "Read", "Write", "Edit", "Glob", "Grep",
      "WebSearch", "WebFetch", "Task", "NotebookEdit",
      "mcp__Claude_in_Chrome__*", "mcp__Claude_Preview__*", "mcp__mcp-registry__*"
    ]
  }
}
'@ | Set-Content "$cd\settings.local.json" -Encoding UTF8
Write-Host "  퍼미션 완료" -ForegroundColor Green

# ── [2/7] 프로젝트 ──
Write-Host "`n[2/7] 프로젝트 준비..." -ForegroundColor Cyan
$pd = "$env:USERPROFILE\mindmap-viewer"
if ((Test-Path ".\server.js") -and (Test-Path ".\save-turn.js")) {
  $pd = (Get-Location).Path
} elseif (Test-Path "$pd\server.js") {
  Set-Location $pd; try { & git pull --quiet 2>$null } catch {}
} else {
  & git clone "https://github.com/dlaww-wq/mindmap-viewer.git" $pd; Set-Location $pd
}
Set-Location $pd
if (!(Test-Path "node_modules")) { Write-Host "  npm install..."; & npm install --silent }
"data","snapshots" | % { New-Item -ItemType Directory -Force $_ | Out-Null }
Write-Host "  프로젝트 준비 완료: $pd" -ForegroundColor Green

# ── [3/7] 훅 등록 ──
Write-Host "`n[3/7] 훅 등록..." -ForegroundColor Cyan
$st = (Join-Path $pd "save-turn.js") -replace "\\","/"
$hc = "node `"$st`""
$he = @{ type = "command"; command = $hc }
$ha = @(@{ hooks = @($he) })
$hm = @(@{ matcher = "*"; hooks = @($he) })
$s = @{
  autoUpdatesChannel = "latest"
  hooks = @{
    UserPromptSubmit = $ha; PreToolUse = $hm; PostToolUse = $hm
    Stop = $ha; SessionStart = $ha; SessionEnd = $ha
    SubagentStart = $ha; SubagentStop = $ha
    Notification = $ha; TaskCompleted = $ha
  }
}
if (Test-Path "$cd\settings.json") {
  $bk = "settings.json.bak." + (Get-Date -Format "yyyyMMdd-HHmmss")
  Copy-Item "$cd\settings.json" "$cd\$bk" -EA SilentlyContinue
}
$s | ConvertTo-Json -Depth 5 | Set-Content "$cd\settings.json" -Encoding UTF8
Write-Host "  10개 훅 등록 완료" -ForegroundColor Green

# ── [4/7] 서버 시작 ──
Write-Host "`n[4/7] 서버 시작..." -ForegroundColor Cyan
$up = $false
try { Invoke-WebRequest "http://localhost:4747/health" -UseBasicParsing -TimeoutSec 2 | Out-Null; $up = $true } catch {}
if ($up) { Write-Host "  이미 실행 중" -ForegroundColor Green }
else { Start-Process $n "server.js" -WorkingDirectory $pd -WindowStyle Hidden; Start-Sleep 2; Write-Host "  서버 시작됨" -ForegroundColor Green }

# ── [5/7] 키로거 데몬 ──
Write-Host "`n[5/7] 키로거 데몬 설치..." -ForegroundColor Cyan
$daemon = Join-Path $pd "daemon\personal-agent.js"
if (Test-Path $daemon) {
  $TaskName = "OrbitDaemon"
  $TaskExists = $false
  try { $TaskExists = (Get-ScheduledTask -TaskName $TaskName -EA SilentlyContinue) -ne $null } catch {}

  if (-not $TaskExists) {
    try {
      $Action  = New-ScheduledTaskAction -Execute $n -Argument "`"$daemon`" --port 4747" -WorkingDirectory $pd
      $Trigger = New-ScheduledTaskTrigger -AtLogOn
      $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Orbit AI Daemon" -Force | Out-Null
      Write-Host "  데몬 등록 완료 (Task Scheduler)" -ForegroundColor Green
    } catch {
      # 폴백: 시작프로그램 바로가기
      $StartupDir = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
      $bat = Join-Path $StartupDir "OrbitDaemon.bat"
      "@echo off`nstart /B `"$n`" `"$daemon`" --port 4747" | Set-Content $bat -Encoding ASCII
      Write-Host "  시작프로그램 바로가기 생성: $bat" -ForegroundColor Green
    }
  } else {
    Write-Host "  데몬 이미 등록됨" -ForegroundColor Green
  }

  # 즉시 시작
  $pidFile = "$env:USERPROFILE\.orbit\personal-agent.pid"
  $dRunning = $false
  if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -EA SilentlyContinue
    try { $dRunning = (Get-Process -Id $oldPid -EA SilentlyContinue) -ne $null } catch {}
  }
  if (-not $dRunning) {
    Start-Process $n -ArgumentList "`"$daemon`" --port 4747" -WorkingDirectory $pd -WindowStyle Hidden
    Write-Host "  데몬 시작됨" -ForegroundColor Green
  }
} else {
  Write-Host "  daemon/personal-agent.js 없음 - 건너뜀" -ForegroundColor Yellow
}

# ── [6/7] 스크린 캡처 확인 ──
Write-Host "`n[6/7] 스크린 캡처..." -ForegroundColor Cyan
Write-Host "  Windows 기본 스크린 캡처 지원됨" -ForegroundColor Green

# ── [7/7] Chrome 확장 안내 ──
Write-Host "`n[7/7] Chrome 확장 안내..." -ForegroundColor Cyan
Write-Host "  브라우저 AI 대화 + 웹 활동 추적:" -ForegroundColor Gray
Write-Host "  -> http://localhost:4747/chrome-extension/" -ForegroundColor Yellow
Write-Host "  Chrome > 확장 프로그램 > 개발자 모드 > 압축해제된 확장 로드" -ForegroundColor Gray

Start-Process "http://localhost:4747"

Write-Host "`n========================================" -ForegroundColor Green
Write-Host "  완료! http://localhost:4747" -ForegroundColor Green
Write-Host "  이제 claude 실행하면 퍼미션 없이 진행됩니다" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  설치된 구성요소:" -ForegroundColor Green
Write-Host "    1. Claude Code 퍼미션 + 훅 등록" -ForegroundColor Green
Write-Host "    2. Orbit 서버 (localhost:4747)" -ForegroundColor Green
Write-Host "    3. 키로거 데몬 (백그라운드)" -ForegroundColor Green
Write-Host "    4. Chrome 확장 (수동 설치)" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  작업 끝나면 백업:" -ForegroundColor Green
Write-Host "  irm https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/orbit-backup.ps1 | iex" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Green
