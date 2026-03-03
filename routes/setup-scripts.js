'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Setup scripts (.ps1 / .sh) generation
// ══════════════════════════════════════════════════════════════════════════════

module.exports = function createSetupScriptsRouter(deps) {
  const express = require('express');
  const router  = express.Router();
  const { PORT } = deps;

router.get('/orbit-setup.ps1', (req, res) => {
  try {
  const port = PORT;
  const REPO = 'https://github.com/dlaww-wq/mindmap-viewer.git';
  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${port}`;
  // URL로 넘어온 토큰 — 개인화 설치 명령어에서 자동 삽입됨
  const userToken = (req.query.token || '').replace(/[^a-zA-Z0-9._\-]/g, '');

  const script = `# ⬡ Orbit AI 원키 설치 스크립트
#
# ★ PowerShell 창(PS >) 에서 실행:
#   irm ${serverUrl}/orbit-setup.ps1 | iex
#
# ★ CMD 창(C:\\>) 에서 실행:
#   powershell -ExecutionPolicy Bypass -Command "irm ${serverUrl}/orbit-setup.ps1 | iex"

# 스크립트 내 npm·node 실행 권한 허용 (PSSecurityException 방지)
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

$ORBIT = "$env:USERPROFILE\\orbit"
$REPO  = "${REPO}"

Write-Host "⬡ Orbit AI 설치 시작..." -ForegroundColor Cyan

# 1. Node.js 확인
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 설치 중..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}
Write-Host "✓ Node.js OK" -ForegroundColor Green

# 2. Git 확인
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git 설치 중..." -ForegroundColor Yellow
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}

# 3. Orbit 저장소 클론
if (-not (Test-Path "$ORBIT\\package.json")) {
    Write-Host "Orbit 다운로드 중..." -ForegroundColor Yellow
    if (Test-Path $ORBIT) { Remove-Item -Recurse -Force $ORBIT }
    git clone $REPO $ORBIT
    Push-Location $ORBIT
    cmd /c npm install --silent 2>&1 | Out-Null
    Pop-Location
} else {
    Write-Host "Orbit 업데이트 중..." -ForegroundColor Yellow
    Push-Location $ORBIT
    git pull --quiet
    cmd /c npm install --silent 2>&1 | Out-Null
    Pop-Location
}
Write-Host "✓ Orbit OK" -ForegroundColor Green

# 4. Ollama 설치
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama 설치 중..." -ForegroundColor Yellow
    $t = "$env:TEMP\\OllamaSetup.exe"
    Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $t -UseBasicParsing
    Start-Process $t -ArgumentList "/S" -Wait
    $env:PATH += ";$env:LOCALAPPDATA\\Programs\\Ollama"
}
Write-Host "✓ Ollama OK" -ForegroundColor Green

# 5. Ollama 영구 실행 설정 (PC 켤 때마다 자동 시작)
# ─ Windows Task Scheduler에 "OrbitOllama" 작업 등록
# ─ 로그인 시 자동 실행, 플랫폼 꺼져도 Ollama는 계속 동작
Write-Host "Ollama 자동 실행 설정 중..." -ForegroundColor Yellow

$ollamaExe = (Get-Command ollama -ErrorAction SilentlyContinue)?.Source
if (-not $ollamaExe) {
    $ollamaExe = "$env:LOCALAPPDATA\\Programs\\Ollama\\ollama.exe"
}
if (Test-Path $ollamaExe) {
    # Task Scheduler에 Ollama 등록 (로그인 시 자동 실행, 종료해도 재시작)
    $action  = New-ScheduledTaskAction  -Execute $ollamaExe -Argument "serve"
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings= New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "OrbitOllama" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force 2>$null | Out-Null
    # 지금 즉시 시작
    Start-ScheduledTask -TaskName "OrbitOllama" -ErrorAction SilentlyContinue
    Write-Host "✓ Ollama 자동 실행 등록됨 (PC 켤 때마다 자동 시작)" -ForegroundColor Green
} else {
    # exe 못 찾으면 기존 방식으로 시작
    Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Host "✓ Ollama 실행됨 (수동 시작 모드)" -ForegroundColor Green
}

# Ollama 준비될 때까지 대기 (최대 30초, 1초 간격 폴링)
Write-Host "Ollama 초기화 대기 중..." -ForegroundColor Yellow
$ollamaReady = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ollamaReady = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
if ($ollamaReady) {
    Write-Host "✓ Ollama 준비 완료" -ForegroundColor Green
    # 기본 모델 자동 설치 (없는 경우만)
    Write-Host "AI 모델 설치 중... (처음 한 번만, 몇 분 소요)" -ForegroundColor Yellow
    $modelsJson = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -UseBasicParsing | Select-Object -ExpandProperty Content | ConvertFrom-Json
    $hasModel = $modelsJson.models | Where-Object { $_.name -like "qwen2.5-coder*" }
    if (-not $hasModel) {
        ollama pull qwen2.5-coder:1.5b
        Write-Host "✓ 모델 설치 완료 (qwen2.5-coder:1.5b)" -ForegroundColor Green
    } else {
        Write-Host "✓ 모델 이미 설치됨" -ForegroundColor Green
    }
} else {
    Write-Host "⚠ Ollama 초기화 대기 타임아웃 — 모델은 백그라운드에서 계속 설치됩니다" -ForegroundColor Yellow
    Start-Job -ScriptBlock { Start-Sleep 10; ollama pull qwen2.5-coder:1.5b } | Out-Null
}

# 6. Claude Code 훅 등록
# node로 훅 등록
node -e "const fs=require('fs'),path=require('path'),os=require('os');const p=path.join(os.homedir(),'.claude','settings.json');const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};if(!s.hooks)s.hooks={};const cmd='node '+process.argv[1];const t=['UserPromptSubmit','Stop','SessionStart','SessionEnd','SubagentStart','SubagentStop','Notification','TaskCompleted'];t.forEach(k=>{if(!s.hooks[k])s.hooks[k]=[];const ok=s.hooks[k].some(h=>(h.hooks||[]).some(x=>x.command===cmd));if(!ok)s.hooks[k].push({hooks:[{type:'command',command:cmd}]});});if(!s.hooks.PostToolUse)s.hooks.PostToolUse=[];const ok2=s.hooks.PostToolUse.some(h=>(h.hooks||[]).some(x=>x.command===cmd));if(!ok2)s.hooks.PostToolUse.push({matcher:'*',hooks:[{type:'command',command:cmd}]});fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2));console.log('훅 등록 완료');" "$ORBIT\\src\\save-turn.js"
Write-Host "✓ Claude 훅 OK" -ForegroundColor Green

# 7. Orbit 서버 시작 (백그라운드) + Task Scheduler 등록
Start-Process "node" -ArgumentList "$ORBIT\\server.js" -WorkingDirectory $ORBIT -WindowStyle Hidden
Start-Sleep -Seconds 2
# Orbit 로컬 서버도 로그인 시 자동 시작 등록
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if ($nodeExe) {
    $action2   = New-ScheduledTaskAction  -Execute $nodeExe -Argument "$ORBIT\\server.js" -WorkingDirectory $ORBIT
    $trigger2  = New-ScheduledTaskTrigger -AtLogOn
    $settings2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "OrbitServer" -Action $action2 -Trigger $trigger2 -Settings $settings2 -RunLevel Highest -Force 2>$null | Out-Null
    Write-Host "✓ Orbit 서버 자동 실행 등록됨" -ForegroundColor Green
}

# 8. 팀 서버 URL 환경변수 + 설정 파일 저장 (팀원 → Railway 업로드용)
# 환경변수: 새 터미널/프로세스에서 사용
[System.Environment]::SetEnvironmentVariable("ORBIT_SERVER_URL", "${serverUrl}", "User")
$env:ORBIT_SERVER_URL = "${serverUrl}"
# 설정 파일: 이미 실행 중인 Claude Code 훅 프로세스에서 읽음 (env 상속 불가 문제 해결)
$orbitConfigPath = "$env:USERPROFILE\\.orbit-config.json"
$orbitToken = "${userToken}"
$orbitConfigContent = @{ serverUrl = "${serverUrl}"; token = $orbitToken } | ConvertTo-Json -Compress
Set-Content -Path $orbitConfigPath -Value $orbitConfigContent -Encoding UTF8
if ($orbitToken) {
    Write-Host "✓ 계정 토큰 포함 설정 완료 → 이벤트가 내 계정으로 저장됩니다" -ForegroundColor Green
} else {
    Write-Host "✓ 팀 서버 URL 설정 완료: ${serverUrl}" -ForegroundColor Green
    Write-Host "  ⚠ 토큰 없음 — Railway에서 로그인 후 설치 명령어 재복사 권장" -ForegroundColor Yellow
}
Write-Host "  (설정 파일: $orbitConfigPath)" -ForegroundColor DarkGray

# 9. 터미널 명령어 수집 훅 (PowerShell PSReadLine)
$psProfile = $PROFILE.CurrentUserAllHosts
if (-not (Test-Path $psProfile)) { New-Item -ItemType File -Path $psProfile -Force | Out-Null }
$hookBlock = @'

# ⬡ Orbit AI 터미널 훅 — 명령어 실행 후 localhost로 전송
$Global:OrbitLastCmd = $null
Set-PSReadLineOption -AddToHistoryHandler {
    param([string]$cmd)
    if ($cmd -and $cmd.Trim() -ne '') {
        $Global:OrbitLastCmd = $cmd
        try {
            $body = @{ command=$cmd; cwd=(Get-Location).Path } | ConvertTo-Json -Compress
            Invoke-RestMethod -Uri "http://localhost:4747/api/terminal-command" -Method POST -Body $body -ContentType "application/json" -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null
        } catch {}
    }
    return $true
}
'@
if (-not (Get-Content $psProfile -Raw -ErrorAction SilentlyContinue | Select-String "Orbit AI 터미널 훅")) {
    Add-Content -Path $psProfile -Value $hookBlock
    Write-Host "✓ PowerShell 터미널 훅 등록됨" -ForegroundColor Green
} else {
    Write-Host "✓ PowerShell 터미널 훅 이미 등록됨" -ForegroundColor Green
}

# 10. VS Code 확장 설치 (직접 복사 방식)
$extDir = "$env:USERPROFILE\\.vscode\\extensions\\orbit-ai-tracker-1.0.0"
if (-not (Test-Path $extDir)) { New-Item -ItemType Directory -Path $extDir -Force | Out-Null }
Copy-Item "$ORBIT\\vscode-extension\\*" -Destination $extDir -Force -ErrorAction SilentlyContinue
Write-Host "✓ VS Code 확장 설치됨 (재시작 후 활성화)" -ForegroundColor Green

# 11. 키로거 의존성 설치 + Task Scheduler 등록 (자동 실행)
Write-Host "키 입력 분석 모듈 설치 중..." -ForegroundColor Yellow
Push-Location $ORBIT
cmd /c npm install uiohook-napi better-sqlite3 --silent 2>&1 | Out-Null
New-Item -ItemType Directory -Path "$ORBIT\\src\\data" -Force | Out-Null 2>$null
Pop-Location

# 키로거를 Task Scheduler에 등록 (로그인 시 자동 실행)
# 플랫폼이 꺼져도 키입력 수집 + Ollama 분석이 계속 동작
if ($nodeExe) {
    $action3   = New-ScheduledTaskAction  -Execute $nodeExe -Argument "$ORBIT\\src\\keylogger.js" -WorkingDirectory "$ORBIT\\src"
    $trigger3  = New-ScheduledTaskTrigger -AtLogOn
    $settings3 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "OrbitKeylogger" -Action $action3 -Trigger $trigger3 -Settings $settings3 -RunLevel Highest -Force 2>$null | Out-Null
    # 지금 즉시 시작
    Start-ScheduledTask -TaskName "OrbitKeylogger" -ErrorAction SilentlyContinue
    Write-Host "✓ 키 입력 분석 자동 실행 등록됨 (플랫폼 종료 후에도 Ollama 학습 지속)" -ForegroundColor Green
} else {
    # node.exe 경로 못 찾으면 기존 방식
    Start-Process "node" -ArgumentList "$ORBIT\\src\\keylogger.js" -WorkingDirectory "$ORBIT\\src" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Host "✓ 키 입력 분석 시작 (수동 시작 모드)" -ForegroundColor Green
}

# 12. 기존 로컬 이벤트 Railway로 동기화 (설치 직후 1회)
Write-Host "기존 작업 데이터 동기화 중..." -ForegroundColor Yellow
if (Test-Path "$ORBIT\\bin\\sync-to-railway.js") {
    node "$ORBIT\\bin\\sync-to-railway.js" --limit=500 2>$null
    Write-Host "✓ 데이터 동기화 완료" -ForegroundColor Green
}

Write-Host ""
Write-Host "✅ Orbit AI 설치 완료!" -ForegroundColor Green
Write-Host "   로컬: http://localhost:${port}" -ForegroundColor Cyan
Write-Host "   팀 대시보드: ${serverUrl}" -ForegroundColor Cyan
Write-Host ""
Write-Host "🔄 자동 실행 서비스 등록 완료:" -ForegroundColor Cyan
Write-Host "   • OrbitOllama   — Ollama AI 서버 (PC 켤 때마다 자동 시작, 종료 시 재시작)" -ForegroundColor White
Write-Host "   • OrbitServer   — Orbit 로컬 서버 (PC 켤 때마다 자동 시작)" -ForegroundColor White
Write-Host "   • OrbitKeylogger — AI 키입력 분석 (플랫폼 종료 후에도 Ollama 학습 지속)" -ForegroundColor White
Write-Host ""
Write-Host "수집 항목: Claude Code · VS Code · 터미널 · AI 대화 · 키 입력 패턴" -ForegroundColor DarkGray
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="orbit-setup.ps1"');
  res.send(script);
  } catch (e) {
    console.error('[setup.ps1] 생성 오류:', e.message);
    res.status(500).send(`# 설치 스크립트 생성 오류: ${e.message}`);
  }
});

// macOS/Linux용
router.get('/orbit-setup.sh', (req, res) => {
  const port = PORT;
  const REPO = 'https://github.com/dlaww-wq/mindmap-viewer.git';
  const serverUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${port}`;
  // URL로 넘어온 토큰 — 개인화 설치 명령어에서 자동 삽입됨
  const userToken = (req.query.token || '').replace(/[^a-zA-Z0-9._\-]/g, '');

  const script = `#!/bin/bash
# ⬡ Orbit AI 원키 설치 스크립트 (macOS/Linux)
# 실행: curl -fsSL ${serverUrl}/orbit-setup.sh | bash

set -e
ORBIT="$HOME/orbit"
echo "⬡ Orbit AI 설치 시작..."

command -v node &>/dev/null || {
  echo "Node.js 설치 중..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null || brew install node 2>/dev/null || true
}

command -v git &>/dev/null || { brew install git 2>/dev/null || sudo apt-get install -y git; }

if [ ! -f "$ORBIT/package.json" ]; then
  echo "Orbit 다운로드 중..."
  git clone ${REPO} $ORBIT
  cd $ORBIT && npm install --silent
else
  echo "Orbit 업데이트 중..."
  cd $ORBIT && git pull --quiet && npm install --silent
fi

command -v ollama &>/dev/null || {
  echo "Ollama 설치 중..."
  curl -fsSL https://ollama.com/install.sh | sh
}
ollama serve &>/dev/null & sleep 3
ollama pull qwen2.5-coder:1.5b 2>/dev/null || true

node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const p=path.join(os.homedir(),'.claude','settings.json');
const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};
if(!s.hooks)s.hooks={};
const cmd='node '+process.argv[1];
const t=['UserPromptSubmit','Stop','SessionStart','SessionEnd','SubagentStart','SubagentStop','Notification','TaskCompleted'];
t.forEach(k=>{if(!s.hooks[k])s.hooks[k]=[];const ok=s.hooks[k].some(h=>(h.hooks||[]).some(x=>x.command===cmd));if(!ok)s.hooks[k].push({hooks:[{type:'command',command:cmd}]});});
if(!s.hooks.PostToolUse)s.hooks.PostToolUse=[];
const ok2=s.hooks.PostToolUse.some(h=>(h.hooks||[]).some(x=>x.command===cmd));
if(!ok2)s.hooks.PostToolUse.push({matcher:'*',hooks:[{type:'command',command:cmd}]});
fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2));
console.log('훅 등록 완료');
" "$ORBIT/src/save-turn.js"

nohup node $ORBIT/server.js > $ORBIT/server.log 2>&1 &

# 8. 팀 서버 URL 환경변수 + 설정 파일 저장
echo "export ORBIT_SERVER_URL=${serverUrl}" >> ~/.zshrc 2>/dev/null || true
echo "export ORBIT_SERVER_URL=${serverUrl}" >> ~/.bashrc 2>/dev/null || true
export ORBIT_SERVER_URL=${serverUrl}
# 설정 파일: 이미 실행 중인 Claude Code 훅 프로세스에서 읽음 (env 상속 불가 문제 해결)
ORBIT_TOKEN="${userToken}"
echo '{"serverUrl":"'"${serverUrl}"'","token":"'"$ORBIT_TOKEN"'"}' > ~/.orbit-config.json
if [ -n "$ORBIT_TOKEN" ]; then
  echo "✓ 계정 토큰 포함 설정 완료 → 이벤트가 내 계정으로 저장됩니다"
else
  echo "✓ 팀 서버 URL 설정: ${serverUrl} (설정 파일: ~/.orbit-config.json)"
  echo "  ⚠ 토큰 없음 — Railway에서 로그인 후 설치 명령어 재복사 권장"
fi

# 9. 터미널 명령어 수집 훅 (zsh preexec / bash PROMPT_COMMAND)
ORBIT_HOOK_CODE='
# ⬡ Orbit AI 터미널 훅
_orbit_send_cmd() {
  local cmd="$1"
  [ -z "$cmd" ] && return
  curl -sf -X POST http://localhost:4747/api/terminal-command \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"$(echo $cmd | sed s/\"/\\\\\"/g)\",\"cwd\":\"$PWD\"}" \
    --max-time 1 &>/dev/null &
}
# zsh
if [ -n "$ZSH_VERSION" ]; then
  preexec_functions+=(_orbit_send_cmd)
fi
# bash
if [ -n "$BASH_VERSION" ]; then
  _orbit_bash_hook() { _orbit_send_cmd "$BASH_COMMAND"; }
  trap _orbit_bash_hook DEBUG
fi'
for RC in ~/.zshrc ~/.bashrc; do
  if [ -f "$RC" ] && ! grep -q "Orbit AI 터미널 훅" "$RC" 2>/dev/null; then
    echo "$ORBIT_HOOK_CODE" >> "$RC"
  fi
done
echo "✓ 터미널 훅 등록 (zsh/bash)"

# 10. VS Code 확장 설치
EXT_DIR="$HOME/.vscode/extensions/orbit-ai-tracker-1.0.0"
mkdir -p "$EXT_DIR"
cp -r "$ORBIT/vscode-extension/"* "$EXT_DIR/" 2>/dev/null || true
echo "✓ VS Code 확장 설치됨 (재시작 후 활성화)"

# 11. 키로거 의존성 설치 + 백그라운드 시작
echo "키 입력 분석 모듈 설치 중..."
cd $ORBIT && npm install uiohook-napi better-sqlite3 --silent 2>/dev/null || true
mkdir -p "$ORBIT/src/data"
pgrep -f "keylogger.js" &>/dev/null || {
  nohup node $ORBIT/src/keylogger.js > $ORBIT/src/keylog.log 2>&1 &
  echo "✓ 키 입력 로컬 분석 시작 (원문 로컬 저장, 결과만 Ollama 분석)"
}

# 12. 기존 로컬 이벤트 Railway로 동기화 (설치 직후 1회)
echo "기존 작업 데이터 동기화 중..."
[ -f "$ORBIT/bin/sync-to-railway.js" ] && node "$ORBIT/bin/sync-to-railway.js" --limit=500 2>/dev/null && echo "✓ 데이터 동기화 완료"

echo ""
echo "✅ Orbit AI 설치 완료!"
echo "   로컬: http://localhost:${port}"
echo "   팀 대시보드: ${serverUrl}"
echo "수집 항목: Claude Code · VS Code · 터미널 · 브라우저 · AI 대화 · 키 입력 패턴"
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(script);
});

  return router;
};
