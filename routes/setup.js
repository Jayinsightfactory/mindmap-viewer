'use strict';

/**
 * routes/setup.js
 * 환경 감지 + 원키 설치 + Claude 연결 상태
 *
 * GET  /api/setup/check          → OS, Ollama, Claude, 훅 상태 감지
 * GET  /api/setup/install-script → OS별 원키 설치 스크립트
 * POST /api/setup/ollama-pull    → Ollama 모델 풀 (SSE 스트리밍)
 * POST /api/setup/hook-register  → Claude Code 훅 등록
 * GET  /api/setup/claude-status  → Claude 실행 여부 + 트래킹 ON/OFF 상태
 * POST /api/setup/claude-toggle  → 트래킹 ON/OFF
 */

const { Router }     = require('express');
const { execSync, spawn } = require('child_process');
const fs             = require('fs');
const path           = require('path');
const os             = require('os');

// ── OS 감지 ───────────────────────────────────────────────────────────────────
function detectOS() {
  const p = process.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'win32')  return 'windows';
  return 'linux';
}

// ── Ollama 상태 ───────────────────────────────────────────────────────────────
function checkOllama() {
  try {
    execSync('ollama --version', { encoding: 'utf8', timeout: 3000, stdio: 'pipe' });
    // 실행 중인지 확인
    const http = require('http');
    return new Promise(resolve => {
      const req = http.get('http://localhost:11434/api/tags', { timeout: 2000 }, res => {
        let d = '';
        res.on('data', c => (d += c));
        res.on('end', () => {
          try {
            const models = JSON.parse(d).models || [];
            resolve({ installed: true, running: true, models: models.map(m => m.name) });
          } catch {
            resolve({ installed: true, running: true, models: [] });
          }
        });
      });
      req.on('error', () => resolve({ installed: true, running: false, models: [] }));
      req.on('timeout', () => { req.destroy(); resolve({ installed: true, running: false, models: [] }); });
    });
  } catch {
    return Promise.resolve({ installed: false, running: false, models: [] });
  }
}

// ── Claude Code 훅 상태 ───────────────────────────────────────────────────────
function checkClaudeHook() {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return { registered: false, settingsPath };
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = settings.hooks || {};
    const hasOrbitHook = Object.values(hooks).flat().some(h => {
      const cmd = (typeof h === 'string' ? h : h?.command) || '';
      return cmd.includes('orbit') || cmd.includes('ai-events') || cmd.includes('4747');
    });
    return { registered: hasOrbitHook, settingsPath };
  } catch {
    return { registered: false, settingsPath: null };
  }
}

// ── Claude 실행 여부 ──────────────────────────────────────────────────────────
function checkClaudeRunning() {
  try {
    const result = execSync(
      process.platform === 'win32'
        ? 'tasklist /FI "IMAGENAME eq claude*" 2>nul'
        : 'pgrep -x "claude" 2>/dev/null || ps aux | grep -i "[c]laude" | head -3',
      { encoding: 'utf8', timeout: 3000, stdio: 'pipe' }
    ).trim();
    return result.length > 0;
  } catch { return false; }
}

// ── Node.js 버전 ──────────────────────────────────────────────────────────────
function getNodeVersion() {
  return process.version;
}

// ── 원키 설치 스크립트 생성 ───────────────────────────────────────────────────
function buildInstallScript(osType, port = 4747, opts = {}) {
  const { token = '', serverUrl = '', memberName = '' } = opts;
  const REPO_URL = 'https://github.com/dlaww-wq/mindmap-viewer.git';
  const ORBIT_DIR = '~/orbit';

  // 환경변수 블록 (Railway 연결 시)
  const envBlock = serverUrl ? `
# ── Orbit 서버 연결 설정 ──
SHELL_RC=~/.zshrc
[ -f ~/.bashrc ] && SHELL_RC=~/.bashrc
add_env() {
  grep -qF "$1" "$SHELL_RC" || echo "export $1" >> "$SHELL_RC"
}
add_env 'ORBIT_SERVER_URL=${serverUrl}'
${token ? `add_env 'ORBIT_TOKEN=${token}'` : ''}
${memberName ? `add_env 'MINDMAP_MEMBER=${memberName}'` : ''}
source "$SHELL_RC" 2>/dev/null || true
echo "✅ 환경변수 등록 완료"
` : '';

  if (osType === 'mac') {
    return {
      title: 'macOS 터미널',
      shell: 'bash',
      script: `#!/bin/bash
echo "🚀 Orbit AI 설치 시작..."

# Orbit 저장소 클론 (없으면)
if [ ! -d "${ORBIT_DIR}" ]; then
  echo "📂 Orbit 다운로드 중..."
  git clone ${REPO_URL} ${ORBIT_DIR}
  cd ${ORBIT_DIR} && npm install --silent
else
  echo "✅ Orbit 이미 설치됨"
  cd ${ORBIT_DIR} && git pull --quiet
fi
${envBlock}
# Ollama 설치 확인
if ! command -v ollama &>/dev/null; then
  echo "📦 Ollama 설치 중..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "✅ Ollama 이미 설치됨"
fi

# Ollama 서버 시작
if ! curl -s http://localhost:11434 &>/dev/null; then
  echo "🔄 Ollama 서버 시작..."
  ollama serve &>/dev/null &
  sleep 2
fi

# Claude Code 훅 등록
echo "🔗 Claude Code 훅 등록 중..."
node ${ORBIT_DIR}/bin/orbit.js hook

echo ""
echo "✅ Orbit AI 설정 완료!"
${serverUrl ? `echo "   팀 서버: ${serverUrl}"` : `echo "   브라우저에서 http://localhost:${port} 를 새로고침하세요."`}`,
    };
  }

  if (osType === 'windows') {
    // Windows PowerShell 원키 설치 스크립트
    // 사용자 PC에서 실행: 클론 → Ollama → 모델 → 훅 등록 → 로컬 서버 시작
    return {
      title: 'PowerShell',
      shell: 'powershell',
      script: `# ⬡ Orbit AI 원키 설치 (PowerShell)
$ORBIT = "$env:USERPROFILE\\orbit"
$REPO  = "${REPO_URL}"
Write-Host "⬡ Orbit AI 설치 시작..." -ForegroundColor Cyan

# 1. Node.js 확인 (없으면 winget으로 설치)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 설치 중..." -ForegroundColor Yellow
  winget install OpenJS.NodeJS --accept-package-agreements --accept-source-agreements
  $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
}

# 2. Orbit 저장소 클론 (없으면 클론, 있으면 업데이트)
if (-not (Test-Path "$ORBIT\package.json")) {
  Write-Host "Orbit 다운로드 중..." -ForegroundColor Yellow
  if (Test-Path $ORBIT) { Remove-Item -Recurse -Force $ORBIT }
  git clone $REPO $ORBIT
  cd $ORBIT; npm install --silent
} else {
  Write-Host "Orbit 업데이트 중..." -ForegroundColor Yellow
  cd $ORBIT; git pull --quiet; npm install --silent
}

# 3. Ollama 설치 (없으면 설치)
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "Ollama 설치 중..." -ForegroundColor Yellow
  $t = "$env:TEMP\\OllamaSetup.exe"
  Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $t -UseBasicParsing
  Start-Process $t -ArgumentList "/S" -Wait
  $env:PATH += ";$env:LOCALAPPDATA\\Programs\\Ollama"
} else {
  Write-Host "Ollama 이미 설치됨" -ForegroundColor Green
}

# 4. Ollama 서버 시작 + 기본 모델 다운로드
Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 3
Write-Host "AI 모델 준비 중 (qwen2.5-coder:1.5b)..." -ForegroundColor Yellow
ollama pull qwen2.5-coder:1.5b 2>$null

# 5. Claude Code 훅 등록 (save-turn.js → 9가지 이벤트 전체)
Write-Host "Claude Code 훅 등록 중..." -ForegroundColor Yellow
$ST = "$ORBIT\\src\\save-turn.js" -replace "\\\\","/"
node --input-type=module << 'HOOKEOF'
import fs from 'fs'; import path from 'path'; import os from 'os';
const p = path.join(os.homedir(), '.claude', 'settings.json');
const s = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
if (!s.hooks) s.hooks = {};
const cmd = \`node \${process.env.ST}\`;
const defs = [
  ['UserPromptSubmit', {hooks:[{type:'command',command:cmd}]}],
  ['PostToolUse',      {matcher:'*',hooks:[{type:'command',command:cmd}]}],
  ['Stop',             {hooks:[{type:'command',command:cmd}]}],
  ['SessionStart',     {hooks:[{type:'command',command:cmd}]}],
  ['SessionEnd',       {hooks:[{type:'command',command:cmd}]}],
  ['SubagentStart',    {hooks:[{type:'command',command:cmd}]}],
  ['SubagentStop',     {hooks:[{type:'command',command:cmd}]}],
  ['Notification',     {hooks:[{type:'command',command:cmd}]}],
  ['TaskCompleted',    {hooks:[{type:'command',command:cmd}]}],
];
for (const [type, entry] of defs) {
  if (!s.hooks[type]) s.hooks[type] = [];
  const exists = s.hooks[type].some(h=>(h.hooks||[]).some(hk=>hk.command===cmd));
  if (!exists) s.hooks[type].push(entry);
}
fs.mkdirSync(path.dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('훅 등록 완료');
HOOKEOF

# 6. Orbit 로컬 서버 시작 (백그라운드, 포트 ${port})
Write-Host "Orbit 서버 시작 중..." -ForegroundColor Yellow
Start-Process "node" -ArgumentList "$ORBIT\\server.js" -WorkingDirectory $ORBIT -WindowStyle Hidden

Write-Host ""
Write-Host "✅ Orbit AI 설치 완료!" -ForegroundColor Green
Write-Host "   로컬 대시보드: http://localhost:${port}" -ForegroundColor Cyan
${serverUrl ? `Write-Host "   팀 서버: ${serverUrl}" -ForegroundColor Cyan` : ''}
Write-Host "이제 Claude Code를 사용하면 자동으로 데이터가 수집됩니다." -ForegroundColor White`,
    };
  }

  // Linux
  return {
    title: 'Linux/WSL 터미널',
    shell: 'bash',
    script: `#!/bin/bash
echo "⬡ Orbit AI 설치 시작..."
ORBIT=~/orbit
REPO="${REPO_URL}"

# Node.js 확인
command -v node &>/dev/null || { curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -; sudo apt-get install -y nodejs; }

# Orbit 저장소
if [ ! -f "$ORBIT/package.json" ]; then
  echo "Orbit 다운로드 중..."
  git clone $REPO $ORBIT && cd $ORBIT && npm install --silent
else
  cd $ORBIT && git pull --quiet && npm install --silent
fi

# Ollama 설치
command -v ollama &>/dev/null || curl -fsSL https://ollama.com/install.sh | sh
ollama serve &>/dev/null & sleep 3
ollama pull qwen2.5-coder:1.5b 2>/dev/null || true

# Claude Code 훅 등록
node $ORBIT/src/save-turn.js --register-hooks 2>/dev/null || node -e "
const fs=require('fs'),path=require('path'),os=require('os');
const p=path.join(os.homedir(),'.claude','settings.json');
const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};
if(!s.hooks)s.hooks={};
const cmd='node $ORBIT/src/save-turn.js';
['UserPromptSubmit','Stop','SessionStart','SessionEnd','SubagentStart','SubagentStop','Notification','TaskCompleted'].forEach(t=>{if(!s.hooks[t])s.hooks[t]=[];if(!s.hooks[t].some(h=>(h.hooks||[]).some(hk=>hk.command===cmd)))s.hooks[t].push({hooks:[{type:'command',command:cmd}]});});
if(!s.hooks.PostToolUse)s.hooks.PostToolUse=[];
if(!s.hooks.PostToolUse.some(h=>(h.hooks||[]).some(hk=>hk.command===cmd)))s.hooks.PostToolUse.push({matcher:'*',hooks:[{type:'command',command:cmd}]});
fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(s,null,2));
console.log('훅 등록 완료');
"

# Orbit 로컬 서버 시작
nohup node $ORBIT/server.js > $ORBIT/server.log 2>&1 &

echo ""
echo "✅ Orbit AI 설치 완료!"
echo "   로컬 대시보드: http://localhost:${port}"
${serverUrl ? `echo "   팀 서버: ${serverUrl}"` : ''}
echo "이제 Claude Code를 사용하면 데이터가 자동 수집됩니다."`,
  };
}

// ── 라우터 ────────────────────────────────────────────────────────────────────
module.exports = function createSetupRouter({ getAllEvents, getDb, port = 4747 }) {
  const router = Router();

  // 트래킹 ON/OFF 상태 (메모리, 재시작 시 초기화)
  let trackingEnabled = true;

  // ── 환경 체크 ──────────────────────────────────────────────────────────────
  router.get('/setup/check', async (req, res) => {
    try {
      const [ollamaStatus] = await Promise.all([checkOllama()]);
      const hookStatus     = checkClaudeHook();
      const claudeRunning  = checkClaudeRunning();

      // 마지막 이벤트로 Claude 연결 판단
      let claudeConnected = false;
      try {
        const events = getAllEvents(1);
        if (events.length) {
          const ts = events[0].ts || events[0].timestamp || 0;
          claudeConnected = (Date.now() - new Date(ts).getTime()) < 120_000;
        }
      } catch {}

      res.json({
        os:       detectOS(),
        nodeVersion: getNodeVersion(),
        ollama:   ollamaStatus,
        hook:     hookStatus,
        claude: {
          running:   claudeRunning,
          connected: claudeConnected,
          tracking:  trackingEnabled,
        },
        ready: ollamaStatus.running && hookStatus.registered,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 원키 설치 스크립트 ────────────────────────────────────────────────────
  router.get('/setup/install-script', (req, res) => {
    const osType = req.query.os || detectOS();
    const opts   = {
      token:      req.query.token      || '',
      serverUrl:  req.query.serverUrl  || '',
      memberName: req.query.memberName || '',
    };
    const script = buildInstallScript(osType, port, opts);
    res.json({ ...script, os: osType });
  });

  // ── Ollama 자동 설치 (SSE 스트리밍) ─────────────────────────────────────
  // GET /api/setup/install-ollama — EventSource로 연결, 실시간 설치 로그 스트림
  router.get('/setup/install-ollama', (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
    const osType = detectOS();

    send({ type: 'info', text: `OS 감지: ${osType}` });
    send({ type: 'progress', pct: 5 });

    let proc;
    try {
      if (osType === 'windows') {
        // Windows: winget 으로 설치 (조용한 모드)
        send({ type: 'info', text: 'winget으로 Ollama 설치 중…' });
        proc = spawn('cmd', ['/c',
          'winget install Ollama.Ollama --accept-package-agreements --accept-source-agreements'
        ], { shell: false });
      } else if (osType === 'mac') {
        send({ type: 'info', text: 'Homebrew로 Ollama 설치 중…' });
        proc = spawn('bash', ['-c',
          'command -v brew >/dev/null && brew install ollama || curl -fsSL https://ollama.com/install.sh | sh'
        ]);
      } else {
        send({ type: 'info', text: 'curl로 Ollama 설치 중…' });
        proc = spawn('bash', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh']);
      }

      send({ type: 'progress', pct: 10 });

      proc.stdout.on('data', d => {
        send({ type: 'stdout', text: d.toString() });
        send({ type: 'progress', pct: 5 });
      });
      proc.stderr.on('data', d => {
        send({ type: 'stderr', text: d.toString() });
        send({ type: 'progress', pct: 3 });
      });
      proc.on('close', code => {
        send({ type: 'done', exitCode: code, ok: code === 0 });
        res.end();
      });
      proc.on('error', err => {
        // winget 없는 경우 → 다운로드 방식으로 폴백 안내
        send({ type: 'error', msg: `winget 실패: ${err.message}. 수동 설치가 필요합니다.` });
        res.end();
      });

      // 클라이언트 연결 끊기면 프로세스 종료
      req.on('close', () => { try { proc.kill(); } catch {} });

    } catch (e) {
      send({ type: 'error', msg: e.message });
      res.end();
    }
  });

  // ── Ollama 서버 시작 (설치됐지만 미실행 상태) ────────────────────────────
  router.post('/setup/start-ollama', (req, res) => {
    try {
      const { spawn } = require('child_process');
      // 백그라운드로 ollama serve 실행
      const proc = spawn('ollama', ['serve'], {
        detached: true,      // 부모 프로세스와 분리
        stdio:    'ignore',  // 출력 무시
      });
      proc.unref(); // 부모 종료 시에도 계속 실행
      // 2초 후 실제로 떴는지 확인
      setTimeout(async () => {
        try {
          const status = await checkOllama();
          res.json({ ok: status.running, installed: status.installed });
        } catch {
          res.json({ ok: false });
        }
      }, 2000);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Ollama 모델 풀 (SSE) ──────────────────────────────────────────────────
  router.post('/setup/ollama-pull', (req, res) => {
    const { model = 'llama3.2:latest' } = req.body;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const send = d => res.write(`data: ${JSON.stringify(d)}\n\n`);
    send({ type: 'start', model });

    try {
      const proc = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.on('data', d => send({ type: 'stdout', text: d.toString() }));
      proc.stderr.on('data', d => send({ type: 'stderr', text: d.toString() }));
      proc.on('close', code => {
        send({ type: 'done', exitCode: code });
        res.end();
      });
      proc.on('error', err => { send({ type: 'error', msg: err.message }); res.end(); });
    } catch (e) {
      send({ type: 'error', msg: e.message });
      res.end();
    }
  });

  // ── Claude 훅 등록 ────────────────────────────────────────────────────────
  // save-turn.js 경로 기반으로 9가지 훅 타입 전체 등록
  router.post('/setup/hook-register', (req, res) => {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const settings     = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

      if (!settings.hooks) settings.hooks = {};

      // save-turn.js 절대 경로 (서버 루트 기준)
      const saveTurnPath = path.join(__dirname, '..', 'src', 'save-turn.js')
        .replace(/\\/g, '/');  // Windows 백슬래시 → 슬래시
      const hookCommand = `node ${saveTurnPath}`;

      // 등록할 훅 타입과 각 항목 형식
      const hookDefs = [
        { type: 'UserPromptSubmit', entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'PostToolUse',      entry: () => ({ matcher: '*', hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'Stop',             entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'SessionStart',     entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'SessionEnd',       entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'SubagentStart',    entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'SubagentStop',     entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'Notification',     entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
        { type: 'TaskCompleted',    entry: () => ({ hooks: [{ type: 'command', command: hookCommand }] }) },
      ];

      let added = 0;
      for (const { type, entry } of hookDefs) {
        if (!settings.hooks[type]) settings.hooks[type] = [];
        // 이미 동일 명령이 등록된 경우 스킵
        const exists = settings.hooks[type].some(h =>
          (h.hooks || []).some(hk => hk.command === hookCommand)
        );
        if (!exists) {
          settings.hooks[type].push(entry());
          added++;
        }
      }

      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      res.json({ ok: true, settingsPath, hookCommand, added });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Claude 트래킹 ON/OFF ──────────────────────────────────────────────────
  router.get('/setup/claude-status', (req, res) => {
    const claudeRunning  = checkClaudeRunning();
    const hookStatus     = checkClaudeHook();
    let   claudeConnected = false;
    try {
      const events = getAllEvents(1);
      if (events.length) {
        const ts = events[0].ts || events[0].timestamp || 0;
        claudeConnected = (Date.now() - new Date(ts).getTime()) < 120_000;
      }
    } catch {}
    res.json({ running: claudeRunning, connected: claudeConnected,
               hookRegistered: hookStatus.registered, tracking: trackingEnabled });
  });

  router.post('/setup/claude-toggle', (req, res) => {
    trackingEnabled = req.body.enabled !== undefined ? Boolean(req.body.enabled) : !trackingEnabled;
    res.json({ ok: true, tracking: trackingEnabled });
  });

  // ── 커스텀 LLM 모델 추가 ─────────────────────────────────────────────────
  router.post('/setup/custom-model', (req, res) => {
    const { provider, modelId, modelLabel, tier = 'smart' } = req.body;
    if (!provider || !modelId) return res.status(400).json({ error: 'provider, modelId 필수' });
    try {
      const db = getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS custom_models (
        id TEXT PRIMARY KEY, provider TEXT, modelId TEXT, modelLabel TEXT,
        tier TEXT, createdAt TEXT DEFAULT (datetime('now'))
      )`);
      db.prepare(`INSERT OR REPLACE INTO custom_models(id,provider,modelId,modelLabel,tier)
                  VALUES(?,?,?,?,?)`).run(`${provider}-${modelId}`, provider, modelId, modelLabel || modelId, tier);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/setup/custom-models', (req, res) => {
    try {
      const db = getDb();
      db.exec(`CREATE TABLE IF NOT EXISTS custom_models (
        id TEXT PRIMARY KEY, provider TEXT, modelId TEXT, modelLabel TEXT,
        tier TEXT, createdAt TEXT DEFAULT (datetime('now'))
      )`);
      const rows = db.prepare(`SELECT * FROM custom_models ORDER BY createdAt DESC`).all();
      res.json({ models: rows });
    } catch { res.json({ models: [] }); }
  });

  router.delete('/setup/custom-model/:id', (req, res) => {
    try {
      const db = getDb();
      db.prepare(`DELETE FROM custom_models WHERE id=?`).run(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
};
