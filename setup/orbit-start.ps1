# ═══════════════════════════════════════════════════════════════
# Orbit AI — 원클릭 시작 (Windows PowerShell)
# ───────────────────────────────────────────────────────────────
# 어떤 PC에서든 PowerShell에 한 줄만 붙여넣기:
#
#   irm https://raw.githubusercontent.com/dlaww-wq/mindmap-viewer/main/setup/orbit-start.ps1 | iex
#
# 하는 일:
#   1. Claude Code 퍼미션 자동 설정 (묻지 않음)
#   2. 프로젝트 클론/업데이트
#   3. 훅 등록 (작업 자동 트래킹)
#   4. 서버 시작 + 브라우저 열기
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Orbit AI -- 원클릭 시작" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ── Node.js 확인 ──
$NodeBin = $null
try { $NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source } catch {}

if (-not $NodeBin) {
  $NvmPath = "$env:APPDATA\nvm"
  if (Test-Path $NvmPath) {
    $latest = Get-ChildItem $NvmPath -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) { $NodeBin = "$($latest.FullName)\node.exe" }
  }
}

if (-not $NodeBin -or -not (Test-Path $NodeBin -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js가 없습니다. 설치: https://nodejs.org" -ForegroundColor Red
  return
}
Write-Host "Node.js: $(& $NodeBin --version)" -ForegroundColor Green

# ── 1단계: Claude Code 퍼미션 설정 ──
Write-Host ""
Write-Host "[1/4] 퍼미션 설정..." -ForegroundColor Cyan

$claudeDir = "$env:USERPROFILE\.claude"
if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir -Force | Out-Null }

$permsJson = @'
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Task",
      "NotebookEdit",
      "mcp__Claude_in_Chrome__*",
      "mcp__Claude_Preview__*",
      "mcp__mcp-registry__*"
    ]
  }
}
'@
$permsJson | Set-Content "$claudeDir\settings.local.json" -Encoding UTF8
Write-Host "  퍼미션 설정 완료 (묻지 않음 모드)" -ForegroundColor Green

# ── 2단계: 프로젝트 클론/업데이트 ──
Write-Host ""
Write-Host "[2/4] 프로젝트 준비..." -ForegroundColor Cyan

$RepoUrl = "https://github.com/dlaww-wq/mindmap-viewer.git"
$ProjectDir = "$env:USERPROFILE\mindmap-viewer"

# 현재 디렉토리가 프로젝트인지 확인
if ((Test-Path ".\server.js") -and (Test-Path ".\save-turn.js")) {
  $ProjectDir = (Get-Location).Path
  Write-Host "  현재 디렉토리 사용: $ProjectDir" -ForegroundColor Green
} elseif ((Test-Path "$ProjectDir\server.js")) {
  Write-Host "  기존 프로젝트 발견: $ProjectDir" -ForegroundColor Green
  Set-Location $ProjectDir
  try { & git pull --quiet 2>$null } catch {}
} else {
  Write-Host "  프로젝트 다운로드 중..."
  & git clone $RepoUrl $ProjectDir
  Set-Location $ProjectDir
}

Set-Location $ProjectDir

# npm install
if (-not (Test-Path "node_modules")) {
  Write-Host "  의존성 설치 중..."
  & npm install --silent
}
New-Item -ItemType Directory -Force -Path "data","snapshots" | Out-Null
Write-Host "  프로젝트 준비 완료" -ForegroundColor Green

# ── 3단계: 훅 등록 ──
Write-Host ""
Write-Host "[3/4] 작업 트래킹 훅 등록..." -ForegroundColor Cyan

$saveTurnPath = (Join-Path $ProjectDir "save-turn.js") -replace "\\", "/"
$hookCmd = "node `"$saveTurnPath`""

$hookEntry = @{ type = "command"; command = $hookCmd }
$hookArray = @(@{ hooks = @($hookEntry) })
$hookArrayMatcher = @(@{ matcher = "*"; hooks = @($hookEntry) })

$settings = @{
  autoUpdatesChannel = "latest"
  hooks = @{
    UserPromptSubmit = $hookArray
    PreToolUse       = $hookArrayMatcher
    PostToolUse      = $hookArrayMatcher
    Stop             = $hookArray
    SessionStart     = $hookArray
    SessionEnd       = $hookArray
    SubagentStart    = $hookArray
    SubagentStop     = $hookArray
    Notification     = $hookArray
    TaskCompleted    = $hookArray
  }
}

$settingsPath = "$claudeDir\settings.json"
# 기존 설정 백업
if (Test-Path $settingsPath) {
  $bak = "settings.json.bak." + (Get-Date -Format "yyyyMMdd-HHmmss")
  Copy-Item $settingsPath (Join-Path $claudeDir $bak) -ErrorAction SilentlyContinue
}

$settings | ConvertTo-Json -Depth 5 | Set-Content $settingsPath -Encoding UTF8
Write-Host "  10개 훅 이벤트 등록 완료" -ForegroundColor Green

# ── 4단계: 서버 시작 ──
Write-Host ""
Write-Host "[4/4] 서버 시작..." -ForegroundColor Cyan

$portInUse = $false
try {
  $resp = Invoke-WebRequest -Uri "http://localhost:4747/health" -UseBasicParsing -TimeoutSec 2
  $portInUse = $true
} catch {}

if ($portInUse) {
  Write-Host "  서버 이미 실행 중 (http://localhost:4747)" -ForegroundColor Green
} else {
  Start-Process -FilePath $NodeBin -ArgumentList "server.js" -WorkingDirectory $ProjectDir -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "  서버 시작됨" -ForegroundColor Green
}

# 브라우저 열기
Start-Process "http://localhost:4747"

# ── 완료 ──
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Orbit AI 준비 완료!" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  웹 UI:  http://localhost:4747" -ForegroundColor Green
Write-Host "  배포:   https://orbit3d-production.up.railway.app" -ForegroundColor Green
Write-Host "" -ForegroundColor Green
Write-Host "  이제 Claude Code를 실행하면" -ForegroundColor Green
Write-Host "  퍼미션 없이 자동 트래킹됩니다!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  프로젝트: $ProjectDir" -ForegroundColor Cyan
Write-Host ""
