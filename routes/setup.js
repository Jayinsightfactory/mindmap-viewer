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
    return {
      title: 'PowerShell (관리자 권한)',
      shell: 'powershell',
      script: `# Orbit AI 설치 스크립트 (PowerShell)
Write-Host "🚀 Orbit AI 설치 시작..." -ForegroundColor Cyan

# Ollama 설치 확인
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "📦 Ollama 설치 중..." -ForegroundColor Yellow
    $installer = "$env:TEMP\\ollama-installer.exe"
    Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installer
    Start-Process $installer -Wait
    $env:PATH += ";$env:LOCALAPPDATA\\Programs\\Ollama"
} else {
    Write-Host "✅ Ollama 이미 설치됨" -ForegroundColor Green
}

# Ollama 서버 시작
Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden

Start-Sleep -Seconds 2

# 기본 모델
Write-Host "🤖 모델 준비 중..." -ForegroundColor Yellow
ollama pull llama3.2:latest 2>$null

# Claude Code 훅 등록
Write-Host "🔗 Claude Code 훅 등록 중..." -ForegroundColor Yellow
node -e @'
const fs=require('fs'),path=require('path'),os=require('os');
const p=path.join(os.homedir(),'.claude','settings.json');
const s=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};
if(!s.hooks) s.hooks={};
if(!s.hooks.PostToolUse) s.hooks.PostToolUse=[];
const h='curl -s -X POST http://localhost:${port}/api/hook -H "Content-Type:application/json" -d @-';
if(!s.hooks.PostToolUse.includes(h)) s.hooks.PostToolUse.push(h);
fs.mkdirSync(path.dirname(p),{recursive:true});
fs.writeFileSync(p,JSON.stringify(s,null,2));
console.log('훅 등록 완료');
'@

Write-Host ""
Write-Host "✅ Orbit AI 설정 완료!" -ForegroundColor Green`,
    };
  }

  // Linux
  return {
    title: 'Linux 터미널',
    shell: 'bash',
    script: `#!/bin/bash
echo "🚀 Orbit AI 설치 시작..."
if ! command -v ollama &>/dev/null; then
  curl -fsSL https://ollama.com/install.sh | sh
fi
ollama serve &>/dev/null & sleep 2
ollama pull llama3.2:latest 2>/dev/null || true
${hookCmd}
echo "✅ 완료! http://localhost:${port} 새로고침"`,
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
  router.post('/setup/hook-register', (req, res) => {
    try {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      const settings     = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};

      if (!settings.hooks)          settings.hooks = {};
      if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

      const hookCmd = `curl -s -X POST http://localhost:${port}/api/hook -H 'Content-Type:application/json' -d @-`;
      if (!settings.hooks.PostToolUse.includes(hookCmd)) {
        settings.hooks.PostToolUse.push(hookCmd);
      }

      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

      res.json({ ok: true, settingsPath });
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
