# ═══════════════════════════════════════════════════════════════
# MindMap Viewer — 자동 설치 스크립트 (Windows PowerShell)
# ───────────────────────────────────────────────────────────────
# 사용법:
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1
#   powershell -ExecutionPolicy Bypass -File setup\install.ps1 -Channel team-alpha -Member 다린
# ═══════════════════════════════════════════════════════════════
param(
  [string]$Channel = "default",
  [string]$Member = "",
  [switch]$NoHook
)

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent $PSScriptRoot

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
Write-Host "║   서버 시작:  start.bat                     ║" -ForegroundColor Green
Write-Host "║   팀 공유:    start.bat --tunnel             ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
