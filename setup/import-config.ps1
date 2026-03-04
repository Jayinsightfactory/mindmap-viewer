# ================================================================
# Claude Code 환경 설정 가져오기 (Import) + 전체 셋업
#
# 사용법:
#   1. git clone https://github.com/dlaww-wq/mindmap-viewer.git
#   2. cd mindmap-viewer
#   3. powershell -ExecutionPolicy Bypass -File setup\import-config.ps1
#
# 이 스크립트가 하는 일:
#   - Node.js 확인
#   - npm install
#   - Claude Code hooks 설정 (경로 자동 감지)
#   - 프로젝트 메모리 복원
#   - 서버 실행 테스트
# ================================================================

param(
    [string]$PortableDir = ""
)

$ErrorActionPreference = "Stop"
$claudeHome = Join-Path $env:USERPROFILE ".claude"
$projectRoot = Split-Path $PSScriptRoot -Parent
$portableDir = if ($PortableDir) { $PortableDir } else { Join-Path $PSScriptRoot "claude-portable" }

Write-Host ""
Write-Host "╔═══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║   Claude Code MindMap Viewer 셋업         ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  프로젝트: $projectRoot" -ForegroundColor White
Write-Host "  설정 소스: $portableDir" -ForegroundColor White
Write-Host ""

# ═══ 1단계: 필수 도구 확인 ═══
Write-Host "── 1단계: 환경 확인 ──" -ForegroundColor Yellow

# Node.js 확인
$nodeVer = & node --version 2>$null
if (-not $nodeVer) {
    Write-Host "  ❌ Node.js가 설치되어 있지 않습니다!" -ForegroundColor Red
    Write-Host "  → https://nodejs.org 에서 설치 후 다시 실행하세요" -ForegroundColor White
    exit 1
}
Write-Host "  ✅ Node.js $nodeVer" -ForegroundColor Green

# Git 확인
$gitVer = & git --version 2>$null
if ($gitVer) { Write-Host "  ✅ $gitVer" -ForegroundColor Green }

# Claude Code 확인
$claudeVer = & claude --version 2>$null
if ($claudeVer) {
    Write-Host "  ✅ Claude Code $claudeVer" -ForegroundColor Green
} else {
    Write-Host "  ⚠️ Claude Code CLI가 없습니다 (수동 설치 필요)" -ForegroundColor Yellow
    Write-Host "  → npm install -g @anthropic-ai/claude-code" -ForegroundColor White
}

# ═══ 2단계: npm install ═══
Write-Host ""
Write-Host "── 2단계: 의존성 설치 ──" -ForegroundColor Yellow

if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "  📦 npm install 실행 중..."
    Push-Location $projectRoot
    & npm install 2>&1 | Out-Null
    Pop-Location
    Write-Host "  ✅ 의존성 설치 완료" -ForegroundColor Green
} else {
    Write-Host "  ✅ node_modules 이미 존재" -ForegroundColor Green
}

# ═══ 3단계: Claude Code hooks 설정 ═══
Write-Host ""
Write-Host "── 3단계: Hooks 설정 ──" -ForegroundColor Yellow

# .claude 폴더 생성
if (-not (Test-Path $claudeHome)) {
    New-Item -ItemType Directory -Path $claudeHome -Force | Out-Null
}

# save-turn.js 경로 (이 PC에 맞게 자동 설정)
$saveTurnPath = (Join-Path $projectRoot "save-turn.js") -replace "\\", "/"
Write-Host "  Hook 스크립트: $saveTurnPath"

# settings.json 생성 (hooks)
$hookCmd = "node $saveTurnPath"
$settingsPath = Join-Path $claudeHome "settings.json"

# 기존 설정이 있으면 백업
if (Test-Path $settingsPath) {
    $backupName = "settings.json.backup." + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item $settingsPath (Join-Path $claudeHome $backupName)
    Write-Host "  📋 기존 설정 백업: $backupName" -ForegroundColor White

    # 기존 설정에 hooks만 병합
    $existing = Get-Content $settingsPath -Raw | ConvertFrom-Json
    $needsUpdate = $false

    if (-not $existing.hooks) {
        $needsUpdate = $true
    } else {
        # 현재 hook 명령어 경로 확인
        $currentCmd = $existing.hooks.Stop[0].hooks[0].command
        if ($currentCmd -ne $hookCmd) {
            $needsUpdate = $true
            Write-Host "  🔄 Hook 경로 업데이트: $currentCmd → $hookCmd" -ForegroundColor White
        }
    }

    if (-not $needsUpdate) {
        Write-Host "  ✅ Hooks 이미 올바르게 설정됨" -ForegroundColor Green
    }
}

# 항상 최신 설정으로 덮어쓰기 (경로가 PC마다 다르므로)
$hookEntry = @{ type = "command"; command = $hookCmd }
$hookArray = @(@{ hooks = @($hookEntry) })
$hookArrayWithMatcher = @(@{ matcher = "*"; hooks = @($hookEntry) })

$settings = @{
    autoUpdatesChannel = "latest"
    hooks = @{
        UserPromptSubmit = $hookArray
        PostToolUse = $hookArrayWithMatcher
        Stop = $hookArray
        SessionStart = $hookArray
        SessionEnd = $hookArray
        SubagentStart = $hookArray
        SubagentStop = $hookArray
        Notification = $hookArray
        TaskCompleted = $hookArray
    }
}

$settings | ConvertTo-Json -Depth 5 | Set-Content $settingsPath -Encoding UTF8
Write-Host "  ✅ 9개 Hook 이벤트 설정 완료" -ForegroundColor Green

# ═══ 4단계: 포터블 설정 복원 ═══
Write-Host ""
Write-Host "── 4단계: 설정 복원 ──" -ForegroundColor Yellow

if (Test-Path $portableDir) {
    # settings.local.json 복원
    $localSettings = Join-Path $portableDir "settings.local.json"
    if (Test-Path $localSettings) {
        Copy-Item $localSettings (Join-Path $claudeHome "settings.local.json") -Force
        Write-Host "  ✅ 글로벌 권한 설정 복원" -ForegroundColor Green
    }

    # MEMORY.md 복원
    $memDir = Join-Path $portableDir "memories"
    if (Test-Path $memDir) {
        $memFiles = Get-ChildItem $memDir -Filter "*.md"
        foreach ($mem in $memFiles) {
            $projName = $mem.BaseName
            $destDir = Join-Path $claudeHome "projects\$projName\memory"
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
            Copy-Item $mem.FullName (Join-Path $destDir "MEMORY.md") -Force
            Write-Host "  ✅ 메모리 복원: $projName" -ForegroundColor Green
        }
    }

    # 플랜 파일 복원
    $planSrc = Join-Path $portableDir "plans"
    if (Test-Path $planSrc) {
        $planDest = Join-Path $claudeHome "plans"
        New-Item -ItemType Directory -Path $planDest -Force | Out-Null
        Copy-Item "$planSrc\*" $planDest -Force
        $planCount = (Get-ChildItem $planSrc -Filter "*.md").Count
        Write-Host "  ✅ 플랜 파일 ${planCount}개 복원" -ForegroundColor Green
    }

    # meta.json 읽기
    $metaPath = Join-Path $portableDir "meta.json"
    if (Test-Path $metaPath) {
        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
        Write-Host "  📋 원본: $($meta.sourcePC) ($($meta.exportedAt))" -ForegroundColor White
    }
} else {
    Write-Host "  ⚠️ claude-portable 폴더 없음 — 기본 설정만 적용" -ForegroundColor Yellow
}

# ═══ 5단계: 데이터 폴더 생성 ═══
Write-Host ""
Write-Host "── 5단계: 데이터 폴더 초기화 ──" -ForegroundColor Yellow

$dataDir = Join-Path $projectRoot "data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}
$snapDir = Join-Path $projectRoot "snapshots"
if (-not (Test-Path $snapDir)) {
    New-Item -ItemType Directory -Path $snapDir -Force | Out-Null
}
Write-Host "  ✅ data/ 및 snapshots/ 폴더 준비" -ForegroundColor Green

# ═══ 6단계: 서버 테스트 ═══
Write-Host ""
Write-Host "── 6단계: 서버 테스트 ──" -ForegroundColor Yellow

# 포트 확인
$portInUse = Get-NetTCPConnection -LocalPort 4747 -ErrorAction SilentlyContinue
if ($portInUse) {
    Write-Host "  ⚠️ 포트 4747 이미 사용 중 (PID: $($portInUse[0].OwningProcess))" -ForegroundColor Yellow
} else {
    # 서버 시작 테스트
    $proc = Start-Process -FilePath "node" -ArgumentList "$projectRoot\server.js" -WorkingDirectory $projectRoot -NoNewWindow -PassThru
    Start-Sleep -Seconds 2

    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:4747/api/stats" -UseBasicParsing -TimeoutSec 5
        Write-Host "  ✅ 서버 정상 작동! (http://localhost:4747)" -ForegroundColor Green
    } catch {
        Write-Host "  ⚠️ 서버 시작 실패 — 로그를 확인하세요" -ForegroundColor Yellow
    }
}

# ═══ 완료 ═══
Write-Host ""
Write-Host "╔═══════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         ✅ 셋업 완료!                     ║" -ForegroundColor Green
Write-Host "╚═══════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  🌐 MindMap UI:  http://localhost:4747" -ForegroundColor Cyan
Write-Host "  📡 서버 시작:   cd $projectRoot && node server.js" -ForegroundColor White
Write-Host "  🔄 코드 동기화: git pull (작업 전) / git push (작업 후)" -ForegroundColor White
Write-Host ""
