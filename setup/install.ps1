# ═══════════════════════════════════════════════════════════════
# MindMap Viewer — 자동 설치 스크립트 (Windows PowerShell)
# ───────────────────────────────────────────────────────────────
# 사용법 (cmd 또는 PowerShell에 붙여넣기):
#   irm https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/install.ps1 | iex
#
# 또는 로컬에서:
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1 -Channel team-alpha -Member 다린
# ═══════════════════════════════════════════════════════════════
param(
  [string]$Channel = "default",
  [string]$Member = "",
  [switch]$NoHook
)

$ErrorActionPreference = "Stop"

# irm | iex 로 실행 시 자동 클론
if (-not $PSScriptRoot -or -not (Test-Path "$PSScriptRoot\..\server.js" -ErrorAction SilentlyContinue)) {
  $InstallDir = "$env:USERPROFILE\mindmap-viewer"
  if (-not (Test-Path $InstallDir)) {
    Write-Host "📥 프로젝트 다운로드 중..." -ForegroundColor Cyan
    git clone https://github.com/dlaww-wq/mindmap-viewer.git $InstallDir
  }
  Set-Location $InstallDir
  $RepoDir = $InstallDir
} else {
  $RepoDir = Split-Path -Parent $PSScriptRoot
}

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   🧠 MindMap Viewer 자동 설치               ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Node.js 확인 ─────────────────────────────────────────────
$NodeBin = $null
try {
  $NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
} catch {}

if (-not $NodeBin) {
  # nvm for Windows
  $NvmPath = "$env:APPDATA\nvm"
  if (Test-Path $NvmPath) {
    $latest = Get-ChildItem $NvmPath -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) { $NodeBin = "$($latest.FullName)\node.exe" }
  }
}

if (-not $NodeBin -or -not (Test-Path $NodeBin)) {
  Write-Host "❌ Node.js를 찾을 수 없습니다." -ForegroundColor Red
  Write-Host "   설치: https://nodejs.org" -ForegroundColor Yellow
  exit 1
}

$NodeVer = & $NodeBin --version 2>$null
Write-Host "✅ Node.js: $NodeVer" -ForegroundColor Green

$NodeMajor = [int]($NodeVer -replace 'v(\d+).*', '$1')
if ($NodeMajor -lt 18) {
  Write-Host "⚠️  Node.js 18 이상 필요. 현재: $NodeVer" -ForegroundColor Yellow
  exit 1
}

# ── 의존성 설치 ──────────────────────────────────────────────
Set-Location $RepoDir
if (-not (Test-Path "node_modules")) {
  Write-Host ""
  Write-Host "📦 npm install 실행 중..." -ForegroundColor Cyan
  & npm install --silent
  Write-Host "✅ 의존성 설치 완료" -ForegroundColor Green
} else {
  Write-Host "✅ node_modules 이미 있음 (건너뜀)" -ForegroundColor Green
}

# ── 데이터 디렉토리 ──────────────────────────────────────────
New-Item -ItemType Directory -Force -Path "$RepoDir\data" | Out-Null
New-Item -ItemType Directory -Force -Path "$RepoDir\snapshots" | Out-Null
Write-Host "✅ 데이터 디렉토리 준비" -ForegroundColor Green

# ── Claude Code 훅 등록 ──────────────────────────────────────
$SaveTurnPath = "$RepoDir\save-turn.js"
$SaveTurnCmd  = "node `"$SaveTurnPath`""

# Claude 설정 경로
$ClaudeSettings = "$env:APPDATA\Claude\settings.json"
if (-not (Test-Path (Split-Path $ClaudeSettings))) {
  $ClaudeSettings = "$env:USERPROFILE\.claude\settings.json"
}

if (-not $NoHook) {
  Write-Host ""
  Write-Host "🔗 Claude Code 훅 등록 중..." -ForegroundColor Cyan
  Write-Host "   설정 파일: $ClaudeSettings" -ForegroundColor Gray

  # 설정 디렉토리 생성
  $settingsDir = Split-Path $ClaudeSettings
  if (-not (Test-Path $settingsDir)) {
    New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
  }

  # 기존 설정 읽기
  $cfg = @{}
  if (Test-Path $ClaudeSettings) {
    try {
      $cfg = Get-Content $ClaudeSettings -Raw | ConvertFrom-Json -AsHashtable
    } catch { $cfg = @{} }
  }

  if (-not $cfg.ContainsKey('hooks')) { $cfg['hooks'] = @{} }

  $hookEvents = @(
    'UserPromptSubmit', 'PostToolUse', 'Stop',
    'SessionStart', 'SessionEnd',
    'SubagentStart', 'SubagentStop',
    'Notification', 'TaskCompleted', 'PreToolUse'
  )

  $hookEntry = @{ type = "command"; command = $SaveTurnCmd }

  foreach ($event in $hookEvents) {
    if (-not $cfg['hooks'].ContainsKey($event)) {
      $cfg['hooks'][$event] = @()
    }
    $hasEntry = $false
    foreach ($h in $cfg['hooks'][$event]) {
      if ($h -is [hashtable] -and $h.ContainsKey('hooks')) {
        foreach ($inner in $h['hooks']) {
          if ($inner.command -eq $SaveTurnCmd) { $hasEntry = $true; break }
        }
      }
    }
    if (-not $hasEntry) {
      if ($event -eq 'PostToolUse' -or $event -eq 'PreToolUse') {
        $cfg['hooks'][$event] += @{ matcher = "*"; hooks = @($hookEntry) }
      } else {
        $cfg['hooks'][$event] += @{ hooks = @($hookEntry) }
      }
    }
  }

  $cfg | ConvertTo-Json -Depth 10 | Set-Content $ClaudeSettings -Encoding UTF8
  Write-Host "✅ 훅 등록 완료" -ForegroundColor Green
} else {
  Write-Host "⏭  훅 등록 건너뜀 (-NoHook)" -ForegroundColor Gray
}

# ── 원격 서버 연결 설정 ────────────────────────────────────────
Write-Host ""
Write-Host "🌐 원격 서버 연결 설정..." -ForegroundColor Cyan
$RemoteUrl = "https://sparkling-determination-production-c88b.up.railway.app"
$OrbitConfigPath = "$env:USERPROFILE\.orbit-config.json"

if (Test-Path $OrbitConfigPath) {
  Write-Host "  이미 설정됨" -ForegroundColor Green
} else {
  Write-Host "  Orbit AI 웹에서 로그인 후 토큰을 입력하세요" -ForegroundColor Yellow
  Write-Host "  (웹 → 설정 → API 토큰 복사, 또는 Enter로 건너뛰기)" -ForegroundColor Yellow
  $UserToken = Read-Host "  토큰 입력"

  if ([string]::IsNullOrWhiteSpace($UserToken)) {
    Write-Host "  토큰 미입력 — 로컬 모드만 사용" -ForegroundColor Yellow
    @{ serverUrl = $RemoteUrl; token = ""; userId = "local" } | ConvertTo-Json | Set-Content $OrbitConfigPath -Encoding UTF8
  } else {
    try {
      $me = Invoke-RestMethod -Uri "$RemoteUrl/api/auth/me" -Headers @{ Authorization = "Bearer $UserToken" } -ErrorAction Stop
      $uid = $me.id
    } catch { $uid = "local" }
    @{ serverUrl = $RemoteUrl; token = $UserToken; userId = $uid } | ConvertTo-Json | Set-Content $OrbitConfigPath -Encoding UTF8
    Write-Host "  원격 서버 연결 완료 (userId: $uid)" -ForegroundColor Green
  }
}

$env:ORBIT_SERVER_URL = $RemoteUrl

# ── 키로거 데몬 등록 (Task Scheduler) ────────────────────────
Write-Host ""
Write-Host "🔑 키로거 데몬 설치 중..." -ForegroundColor Cyan

$DaemonScript = Join-Path $RepoDir "daemon\personal-agent.js"
if (Test-Path $DaemonScript) {
  # Task Scheduler로 로그온 시 자동 실행 등록
  $TaskName = "OrbitDaemon"
  $TaskExists = $false
  try { $TaskExists = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) -ne $null } catch {}

  if (-not $TaskExists) {
    try {
      $Action  = New-ScheduledTaskAction -Execute $NodeBin -Argument "`"$DaemonScript`" --port 4747" -WorkingDirectory $RepoDir
      $Trigger = New-ScheduledTaskTrigger -AtLogOn
      $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Orbit AI Personal Agent Daemon" -Force | Out-Null
      Write-Host "✅ 키로거 데몬 등록 완료 (Task Scheduler: $TaskName)" -ForegroundColor Green
    } catch {
      Write-Host "⚠️  Task Scheduler 등록 실패: $($_.Exception.Message)" -ForegroundColor Yellow
      # 폴백: 시작프로그램 바로가기 생성
      $StartupDir = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
      $ShortcutPath = Join-Path $StartupDir "OrbitDaemon.bat"
      "@echo off`nstart /B `"$NodeBin`" `"$DaemonScript`" --port 4747" | Set-Content $ShortcutPath -Encoding ASCII
      Write-Host "✅ 시작프로그램 바로가기 생성: $ShortcutPath" -ForegroundColor Green
    }
  } else {
    Write-Host "✅ 키로거 데몬 이미 등록됨 (Task Scheduler)" -ForegroundColor Green
  }

  # 즉시 시작 (아직 미실행 시)
  $OrbitPidFile = Join-Path $env:USERPROFILE ".orbit\personal-agent.pid"
  $DaemonRunning = $false
  if (Test-Path $OrbitPidFile) {
    $OldPid = Get-Content $OrbitPidFile -ErrorAction SilentlyContinue
    try { $DaemonRunning = (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) -ne $null } catch {}
  }
  if (-not $DaemonRunning) {
    Start-Process $NodeBin -ArgumentList "`"$DaemonScript`" --port 4747" -WorkingDirectory $RepoDir -WindowStyle Hidden
    Write-Host "✅ 키로거 데몬 시작됨" -ForegroundColor Green
  } else {
    Write-Host "✅ 키로거 데몬 이미 실행 중" -ForegroundColor Green
  }
} else {
  Write-Host "⚠️  daemon/personal-agent.js 없음 — 건너뜀" -ForegroundColor Yellow
}

# ── Chrome 확장 설치 안내 ──────────────────────────────────
Write-Host ""
Write-Host "🌐 Chrome 확장 설치 (선택):" -ForegroundColor Cyan
Write-Host "   브라우저 AI 대화 + 웹 활동 추적" -ForegroundColor Gray
Write-Host "   → Chrome에서 열기: http://localhost:4747/chrome-extension/" -ForegroundColor Yellow
Write-Host "   → Chrome > 확장 프로그램 > 개발자 모드 > 압축해제된 확장 로드" -ForegroundColor Gray

# ── 스크린 캡처 안내 ────────────────────────────────────────
Write-Host ""
Write-Host "🖥️  스크린 캡처:" -ForegroundColor Cyan
Write-Host "   Windows는 기본 스크린 캡처를 지원합니다 (nircmd/ffmpeg)" -ForegroundColor Gray

# ── 환경변수 안내 ────────────────────────────────────────────
Write-Host ""
Write-Host "── 팀 채널 설정 (선택) ──────────────────────────────────" -ForegroundColor Cyan
Write-Host "   아래를 시스템 환경변수에 추가하세요:" -ForegroundColor Gray
Write-Host '   [System.Environment]::SetEnvironmentVariable("MINDMAP_CHANNEL", "팀채널명", "User")' -ForegroundColor Yellow
Write-Host '   [System.Environment]::SetEnvironmentVariable("MINDMAP_MEMBER", "내이름", "User")' -ForegroundColor Yellow

if ($Channel -ne "default") {
  [System.Environment]::SetEnvironmentVariable("MINDMAP_CHANNEL", $Channel, "User")
  Write-Host "✅ MINDMAP_CHANNEL=$Channel 설정됨" -ForegroundColor Green
}
if ($Member) {
  [System.Environment]::SetEnvironmentVariable("MINDMAP_MEMBER", $Member, "User")
  Write-Host "✅ MINDMAP_MEMBER=$Member 설정됨" -ForegroundColor Green
}

# ── 완료 ─────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   ✅ 설치 완료!                              ║" -ForegroundColor Green
Write-Host "║                                              ║" -ForegroundColor Green
Write-Host "║   설치된 구성요소:                            ║" -ForegroundColor Green
Write-Host "║     1. Claude Code 훅 등록                  ║" -ForegroundColor Green
Write-Host "║     2. 키로거 데몬 (백그라운드)               ║" -ForegroundColor Green
Write-Host "║     3. Chrome 확장 (수동 설치)                ║" -ForegroundColor Green
Write-Host "║                                              ║" -ForegroundColor Green
Write-Host "║   서버 시작:  start.bat                     ║" -ForegroundColor Green
Write-Host "║   팀 공유:    start.bat --tunnel             ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
