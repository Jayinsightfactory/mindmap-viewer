#!/usr/bin/env node
// WScript 가드: Windows Script Host로 실행 방지
if (typeof WScript !== 'undefined') { WScript.Echo('오류: 이 파일은 Node.js로 실행해야 합니다.\n\n해결방법:\n1. 시작 메뉴 > orbit-daemon.bat 확인\n2. 또는 PowerShell에서: node daemon\\personal-agent.js\n\n설치코드를 다시 실행하면 자동 해결됩니다.'); WScript.Quit(1); }
'use strict';

/**
 * daemon/personal-agent.js
 * 개인 학습 에이전트 데몬
 *
 * 실행: node daemon/personal-agent.js [--port 4747]
 * 종료: SIGTERM / SIGINT
 *
 * 기능:
 *  - keyboard-watcher (글로벌 키보드 캡처)
 *  - file-learner (파일 저장 내용 학습)
 *  - 30분마다 suggestion-engine 실행
 */

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const http    = require('http');
const https   = require('https');

// ── 프로세스 keep-alive (최상위 레벨, main() 밖) ──────────────────────────
// Node.js가 이벤트 루프 빈 상태로 종료하지 않도록 방어
process.stdin.resume();
const _topKeepAlive = setInterval(() => {}, 30_000);
process.on('exit', (code) => {
  console.log(`[orbit] 프로세스 종료 (exit code: ${code}, ${new Date().toISOString()})`);
});

// ── 원격 서버 설정 (~/.orbit-config.json) ──────────────────────────────────
const _orbitConfig = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8'));
  } catch { return {}; }
})();
const REMOTE_URL   = _orbitConfig.serverUrl || process.env.ORBIT_SERVER_URL || null;
const REMOTE_TOKEN = _orbitConfig.token     || process.env.ORBIT_TOKEN      || '';

// ── 에러 리포트 서버 전송 ──────────────────────────────────────────────────
function _reportError(component, error, detail) {
  if (!REMOTE_URL) return;
  try {
    const payload = JSON.stringify({
      events: [{
        id: 'daemon-err-' + Date.now(),
        type: 'daemon.error',
        source: 'personal-agent',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: {
          component,
          error: String(error),
          detail: detail || '',
          hostname: os.hostname(),
          platform: os.platform(),
          nodeVersion: process.version,
        },
      }],
    });
    const url = new URL('/api/hook', REMOTE_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (REMOTE_TOKEN) headers['Authorization'] = 'Bearer ' + REMOTE_TOKEN;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, res => res.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// ── 범용 이벤트 리포트 헬퍼 ──────────────────────────────────────────────────
function _reportEvent(type, data) {
  if (!REMOTE_URL) return;
  try {
    const payload = JSON.stringify({
      events: [{
        id: type.replace('.', '-') + '-' + Date.now(),
        type,
        source: 'personal-agent',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: { ...data, hostname: os.hostname() },
      }],
    });
    const url = new URL('/api/hook', REMOTE_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (REMOTE_TOKEN) headers['Authorization'] = 'Bearer ' + REMOTE_TOKEN;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, res => res.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// ── 은행 보안프로그램 감지 (Windows 전용) ────────────────────────────────────
const { execSync } = require('child_process');

// 은행 보안프로그램 프로세스명 패턴 (Windows)
// 업데이트 기준: 실제 은행 설치 페이지 확인 (2026-03-29)
const BANK_SECURITY_PATTERNS = [
  // ── 키보드 보안 ──────────────────────────────────────────────
  /^TouchEn(Nx)?Key(Hook)?.*\.exe$/i,   // TouchEnNxKey.exe / TouchEnKey.exe / TouchEnNxKeyHook.exe
  /^nProtect(KeyCrypt|Browser)?.*\.exe$/i, // nProtect.exe / nProtectKeyCrypt.exe / npkcrypt.exe
  /^npkcrypt.*\.exe$/i,
  /^ASTx.*\.exe$/i,                     // ASTx.exe / astx64.exe (AhnLab 키보드보안)
  /^astx.*\.exe$/i,
  /^KeySharp.*\.exe$/i,
  /^KDefense.*\.exe$/i,

  // ── AhnLab Safe Transaction (필수 설치 — 해킹방지) ──────────
  /^ASDSvc.*\.exe$/i,                   // ASDSvc.exe ← 주 서비스 프로세스 (핵심)
  /^ast\.exe$/i,                        // ast.exe
  /^V3LTray.*\.exe$/i,                  // V3LTray.exe (AhnLab 트레이)
  /^V3Lite.*\.exe$/i,

  // ── INISAFE CrossWeb EX (공동인증서 보안) ────────────────────
  /^INISAFE(CrossWeb|Web).*\.exe$/i,    // INISAFECrossWebEX.exe / INISAFEWeb.exe
  /^CrossWeb.*\.exe$/i,
  /^crosswebex.*\.exe$/i,

  // ── 인증/전자서명 ────────────────────────────────────────────
  /^Delfino.*\.exe$/i,
  /^MagicLine.*\.exe$/i,
  /^VeraPort.*\.exe$/i,
  /^veraport.*\.exe$/i,
  /^UniSign.*\.exe$/i,
  /^XecureWeb.*\.exe$/i,
  /^XecureCK.*\.exe$/i,
  /^xecure.*\.exe$/i,

  // ── 기타 ────────────────────────────────────────────────────
  /^IBK.*\.exe$/i,
  /^ClientKeeper.*\.exe$/i,
  /^IPInsideAgent.*\.exe$/i,
  /^IPInsideLWS.*\.exe$/i,
  /^nProtect Netizen.*\.exe$/i,
  /^npupdate.*\.exe$/i,
  /^NPAgent.*\.exe$/i,
];

let _bankMode = false;
let _bankCheckTimer = null;

/**
 * 은행 보안프로그램 실행 여부 체크 (Windows만)
 * @returns {boolean}
 */
function checkBankSecurity() {
  if (process.platform !== 'win32') return false;
  try {
    const output = execSync(
      'powershell -NoProfile -WindowStyle Hidden -NonInteractive -Command "Get-Process | Select-Object -ExpandProperty Name"',
      { timeout: 5000, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }
    );
    const processes = output.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
    for (const proc of processes) {
      const procExe = proc.endsWith('.exe') ? proc : proc + '.exe';
      if (BANK_SECURITY_PATTERNS.some(pattern => pattern.test(procExe))) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 은행 보안 이벤트를 서버로 전송
 * @param {string} eventType - 'bank.security.active' 또는 'bank.security.inactive'
 */
function _sendBankSecurityEvent(eventType) {
  if (!REMOTE_URL) return;
  try {
    const payload = JSON.stringify({
      events: [{
        id: 'bank-' + Date.now(),
        type: eventType,
        source: 'personal-agent',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data: { hostname: os.hostname() },
      }],
    });
    const url = new URL('/api/hook', REMOTE_URL);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (REMOTE_TOKEN) headers['Authorization'] = 'Bearer ' + REMOTE_TOKEN;
    const req = mod.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST', headers, timeout: 10000 }, res => res.resume());
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

/**
 * 은행 보안 감지 — 하루 2회 시간 기반 (09:00 KST, 13:00 KST)
 * interval 폴링 제거 → PC 부하 0 (지정 시간에만 1회 실행)
 */
// 은행 보안 체크 시간: 09:00 KST, 13:00 KST (UTC 기준 00:00, 04:00)
const BANK_CHECK_HOURS_UTC = [{ h: 0, m: 0 }, { h: 4, m: 0 }];
let _lastBankCheckKey = ''; // 'YYYY-MM-DD-HH:mm' 중복 방지

function _isBankCheckTime() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const key = `${now.toISOString().slice(0, 10)}-${h}:${String(m).padStart(2, '0')}`;
  if (_lastBankCheckKey === key) return false;
  const isTime = BANK_CHECK_HOURS_UTC.some(t => t.h === h && Math.abs(t.m - m) <= 1);
  if (isTime) { _lastBankCheckKey = key; return true; }
  return false;
}

function startBankSecurityMonitor(keyboardWatcher, screenCapture, clipboardWatcher, mouseWatcher) {
  if (process.platform !== 'win32') {
    console.log('[personal-agent] 은행 보안 감지: Windows 전용 — 건너뜀');
    return;
  }
  console.log('[personal-agent] 은행 보안 감지: 09:00/13:00 KST 시간 기반 (하루 2회)');

  const secureCollector = (() => {
    try { return require('../src/secure-collector'); } catch { return null; }
  })();

  // 1분마다 시간만 체크 (가벼운 로컬 비교, PowerShell 실행 안 함)
  _bankCheckTimer = setInterval(() => {
    if (!_isBankCheckTime()) return; // 지정 시간 아니면 즉시 종료

    const detected = checkBankSecurity(); // 하루 2회만 실제 Get-Process 실행
    if (detected && !_bankMode) {
      _bankMode = true;
      console.log('[orbit] 은행 보안 감지 — 후킹 일시정지');
      if (keyboardWatcher?.pause) keyboardWatcher.pause();
      if (screenCapture?.pause)   screenCapture.pause();
      if (clipboardWatcher?.pause) clipboardWatcher.pause();
      if (mouseWatcher?.pause)    mouseWatcher.pause();
      _sendBankSecurityEvent('bank.security.active');
      if (secureCollector) secureCollector.start();
    } else if (!detected && _bankMode) {
      _bankMode = false;
      console.log('[orbit] 은행 보안 없음 — 전체 수집 재개');
      if (keyboardWatcher?.resume) keyboardWatcher.resume();
      if (screenCapture?.resume)   screenCapture.resume();
      if (clipboardWatcher?.resume) clipboardWatcher.resume();
      if (mouseWatcher?.resume)    mouseWatcher.resume();
      if (secureCollector) secureCollector.stop();
      _sendBankSecurityEvent('bank.security.inactive');
    }
  }, 60 * 1000); // 1분마다 시간 확인 (로컬 비교만, 부하 없음)
}

function stopBankSecurityMonitor() {
  if (_bankCheckTimer) { clearInterval(_bankCheckTimer); _bankCheckTimer = null; }
}

// ── 프로세스 우선순위 낮춤 (PC 성능 보호) ────────────────────────────────────
// Windows: BELOW_NORMAL(6) 으로 설정 → Excel/업무앱이 항상 우선
if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync(`wmic process where ProcessId=${process.pid} CALL setpriority "below normal"`,
      { timeout: 3000, windowsHide: true, stdio: 'pipe' });
  } catch {}
}

// ── 설정 ─────────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const PORT     = parseInt(args[args.indexOf('--port') + 1] || process.env.ORBIT_PORT || '4747', 10);
const PID_DIR  = path.join(os.homedir(), '.orbit');
const PID_FILE = path.join(PID_DIR, 'personal-agent.pid');
const ROOT     = path.resolve(__dirname, '..');

// ── PID 파일 관리 ─────────────────────────────────────────────────────────────
function writePid() {
  try {
    fs.mkdirSync(PID_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
  } catch {}
}
function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

// ── 서버 헬스 체크 ────────────────────────────────────────────────────────────
function waitForServer(retries = 10) {
  return new Promise((resolve) => {
    let attempts = 0;
    const check = () => {
      const req = http.get(`http://localhost:${PORT}/api/personal/status`, res => {
        res.resume();
        if (res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });

      function retry() {
        attempts++;
        if (attempts >= retries) resolve(false);
        else setTimeout(check, 2000);
      }
    };
    check();
  });
}

// ── 원격 서버 헬스 체크 (비차단) ──────────────────────────────────────────────
function checkRemoteServer() {
  if (!REMOTE_URL) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/personal/status', REMOTE_URL);
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.get(url.href, { timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

// ── content-analyzer: 로컬 Ollama로 키보드 내용 태깅 ────────────────────────
async function runContentAnalysis() {
  try {
    const contentAnalyzer = require(path.join(ROOT, 'src/content-analyzer'));
    const dbModule        = require(path.join(ROOT, 'src/db'));
    const db              = dbModule.getDb ? dbModule.getDb() : null;
    if (!db) return;

    // 최근 4시간 미분석 이벤트
    const since  = new Date(Date.now() - 4 * 3600_000).toISOString();
    const events = db.prepare(
      `SELECT * FROM events WHERE type='keyboard.chunk' AND timestamp > ? ORDER BY timestamp ASC`
    ).all(since);

    await contentAnalyzer.analyzeAndStore(events, db);
  } catch (err) {
    console.error('[personal-agent] content-analyzer 오류:', err.message);
  }
}

// ── trigger-engine: 이슈 역추적 + 트리거 패턴 학습 ──────────────────────────
async function runTriggerLearning() {
  try {
    const triggerEngine = require(path.join(ROOT, 'src/trigger-engine'));
    const dbModule      = require(path.join(ROOT, 'src/db'));
    const db            = dbModule.getDb ? dbModule.getDb() : null;
    if (!db) return;

    const learned = triggerEngine.processUnanalyzedIssues(db);
    if (learned.length) {
      console.log(`[personal-agent] 트리거 패턴 학습 완료: ${learned.length}개`);
    }
  } catch (err) {
    console.error('[personal-agent] trigger-engine 오류:', err.message);
  }
}

// ── suggestion-engine 실행 ────────────────────────────────────────────────────
async function runSuggestions() {
  try {
    const { run }    = require(path.join(ROOT, 'src/suggestion-engine'));
    const dbModule   = require(path.join(ROOT, 'src/db'));
    const db         = dbModule.getDb ? dbModule.getDb() : null;
    if (!db) return;

    // 최근 7일 이벤트
    const since  = new Date(Date.now() - 7 * 86400_000).toISOString();
    const events = db.prepare(`SELECT * FROM events WHERE timestamp > ? ORDER BY timestamp ASC`).all(since);
    await run(events, db);
  } catch (err) {
    console.error('[personal-agent] suggestion-engine 오류:', err.message);
  }
}

// ── 데몬 자체 로그 파일 (lock 충돌 없음 — 자기 프로세스가 append/read 모두 제어) ──
// daemon.log는 PowerShell Add-Content로 잡혀있어 외부에서 read 불가 (EBUSY)
// → 데몬이 직접 daemon-self.log에 기록 + 그걸 읽어서 admin에 전송
const _selfLogPath = path.join(os.homedir(), '.orbit', 'daemon-self.log');

function _selfLog(msg) {
  try {
    fs.appendFileSync(_selfLogPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// console.log/warn/error를 daemon-self.log에도 병행 기록 (진단 자동 캡처)
(function _installConsoleProxy() {
  try {
    const orbitDir = path.join(os.homedir(), '.orbit');
    if (!fs.existsSync(orbitDir)) fs.mkdirSync(orbitDir, { recursive: true });
    const _origLog = console.log.bind(console);
    const _origWarn = console.warn.bind(console);
    const _origErr = console.error.bind(console);
    console.log = (...args) => { _origLog(...args); try { fs.appendFileSync(_selfLogPath, `${new Date().toISOString()} [LOG] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); } catch {} };
    console.warn = (...args) => { _origWarn(...args); try { fs.appendFileSync(_selfLogPath, `${new Date().toISOString()} [WARN] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); } catch {} };
    console.error = (...args) => { _origErr(...args); try { fs.appendFileSync(_selfLogPath, `${new Date().toISOString()} [ERR] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`); } catch {} };
  } catch {}
})();

// ── 데몬 시작 시 로그 스냅샷 전송 (admin 디버깅용) ─────────────────────────
function _sendLogSnapshot() {
  if (!REMOTE_URL) return;
  const orbitDir = path.join(os.homedir(), '.orbit');
  // daemon-self.log (lock 없음) 우선 + install.log fallback
  const candidates = [
    { type: 'daemon', path: _selfLogPath },
    { type: 'install', path: path.join(orbitDir, 'install.log') },
  ];
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f.path)) {
        _reportEvent('daemon.log.snapshot', { logType: f.type, error: 'file not found' });
        continue;
      }
      const raw = fs.readFileSync(f.path, 'utf8');
      const tail = raw.split('\n').slice(-200).join('\n');
      _reportEvent('daemon.log.snapshot', {
        logType: f.type,
        lines: tail,
        sizeBytes: raw.length,
        capturedAt: new Date().toISOString(),
      });
    } catch (e) {
      _reportEvent('daemon.log.snapshot', {
        logType: f.type,
        error: String(e.message),
      });
    }
  }
}

// ── 데몬 heartbeat: 60초마다 모듈별 상태 보고 (admin watchdog용) ────────────
// 기존 daemon.update는 "살아있다"만 알려줌. heartbeat는 mouse/kb/screen 개별 상태 포함.
const _daemonStartedAt = Date.now();
function _emitHeartbeat() {
  try {
    const now = Date.now();
    const uptime = Math.round((now - _daemonStartedAt) / 1000);
    const modules = {};
    // 안전 호출 — 모듈 로드 실패했으면 unknown
    try { modules.mouse    = mouseWatcher?.getStatus?.()    || { state: 'unloaded' }; } catch (e) { modules.mouse    = { state: 'error', err: e.message }; }
    try { modules.keyboard = keyboardWatcher?.getStatus?.() || { state: 'unloaded' }; } catch (e) { modules.keyboard = { state: 'error', err: e.message }; }
    try { modules.screen   = screenCapture?.getStatus?.()   || { state: 'unloaded' }; } catch (e) { modules.screen   = { state: 'error', err: e.message }; }

    // overall 판정: 하나라도 dead/degraded면 전체 degraded
    const states = Object.values(modules).map(m => m?.state || 'unknown');
    let overall = 'ok';
    if (states.some(s => s === 'dead'))       overall = 'dead';
    else if (states.some(s => s === 'degraded')) overall = 'degraded';
    else if (states.every(s => s === 'paused')) overall = 'paused';
    else if (states.some(s => s !== 'ok' && s !== 'paused')) overall = 'degraded';

    _reportEvent('daemon.heartbeat', {
      hostname: os.hostname(),
      platform: os.platform(),
      pid: process.pid,
      uptime,
      state: overall,
      modules,
      memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  } catch (e) {
    console.warn('[heartbeat] 전송 실패:', e.message);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  // 시작 로그 최소화 — 내부 상태 노출 방지
  console.log(`[orbit] 시작 (${new Date().toISOString()})`);
  writePid();
  // 로그 스냅샷: 모든 워처 시작 직후(3초) + 이후 5분 주기
  // 3초 지연으로 mouse-watcher 등 모든 워처의 시작/실패 로그가 캡처됨
  setTimeout(_sendLogSnapshot, 3000);
  setInterval(_sendLogSnapshot, 5 * 60 * 1000);

  // heartbeat: 모든 워처 시작 완료 후 첫 30초 + 이후 60초 주기
  // 워처 초기화 실패도 즉시 보고됨 (getStatus는 모듈 로드 실패 자동 처리)
  setTimeout(_emitHeartbeat, 30 * 1000);
  setInterval(_emitHeartbeat, 60 * 1000);

  // Orbit 서버 대기 (localhost)
  const serverUp = await waitForServer();
  if (!serverUp) {
    console.warn('[personal-agent] 로컬 Orbit 서버에 연결할 수 없습니다. 계속 진행합니다.');
  }

  // 원격 서버 헬스 체크 (비차단 — 실패해도 계속)
  checkRemoteServer().then(up => {
    if (up) console.log('[personal-agent] 원격 서버 연결 확인됨');
    else if (REMOTE_URL) console.warn('[personal-agent] 원격 서버에 연결할 수 없습니다. 로컬만 사용합니다.');
  });

  // ① keyboard-watcher 시작
  let keyboardWatcher = null;
  try {
    keyboardWatcher = require(path.join(ROOT, 'src/keyboard-watcher'));
    keyboardWatcher.start({ port: PORT });
  } catch (err) {
    console.error('[personal-agent] 키보드 와처 시작 실패:', err.message);
    _reportError('keyboard-watcher', err.message, err.stack);
  }

  // ①-a mouse-watcher 시작 (uiohook singleton에 listener 추가, 60초마다 mouse.chunk 전송)
  let mouseWatcher = null;
  try {
    mouseWatcher = require(path.join(ROOT, 'src/mouse-watcher'));
    mouseWatcher.start({
      getActiveApp:    keyboardWatcher?.getActiveApp?.bind(keyboardWatcher),
      getActiveWindow: keyboardWatcher?.getActiveWindowTitle?.bind(keyboardWatcher),
    });
  } catch (err) {
    console.error('[personal-agent] 마우스 와처 시작 실패:', err.message);
    _reportError('mouse-watcher', err.message, err.stack);
  }

  // ①-b daemon-updater 시작 (자동 업데이트 + 원격 명령)
  let daemonUpdater = null;
  try {
    daemonUpdater = require(path.join(ROOT, 'src/daemon-updater'));
    daemonUpdater.start();
  } catch (err) {
    console.error('[personal-agent] 자동 업데이트 모듈 시작 실패:', err.message);
  }

  // ② file-learner 시작
  let fileLearner = null;
  try {
    fileLearner = require(path.join(ROOT, 'src/file-learner'));
    fileLearner.start({ port: PORT });
  } catch (err) {
    console.error('[personal-agent] 파일 와처 시작 실패:', err.message);
    _reportError('file-learner', err.message, err.stack);
  }

  // ②-b screen-capture 시작 + keyboard-watcher 연결
  let screenCapture = null;
  try {
    screenCapture = require(path.join(ROOT, 'src/screen-capture'));
    screenCapture.start();
    // 키보드 와처 → 스크린 캡처 이벤트 연결 (앱 전환/idle 시 캡처)
    if (keyboardWatcher?.setScreenCapture) keyboardWatcher.setScreenCapture(screenCapture);
  } catch (err) {
    console.error('[personal-agent] 스크린 캡처 시작 실패:', err.message);
  }

  // ②-d Google Drive 캡처 업로드 초기화
  let driveUploader = null;
  try {
    driveUploader = require(path.join(ROOT, 'src/drive-uploader'));
    // 서버에서 Drive 설정 가져오기
    if (REMOTE_URL) {
      const driveConfig = await new Promise((resolve) => {
        const url = new URL('/api/daemon/drive-config', REMOTE_URL);
        const mod = url.protocol === 'https:' ? https : http;
        const headers = {};
        if (REMOTE_TOKEN) headers['Authorization'] = 'Bearer ' + REMOTE_TOKEN;
        const req = mod.get({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (driveConfig?.enabled) {
        driveUploader.init(driveConfig);
        // 5분마다 미업로드 캡처 일괄 업로드
        setInterval(() => driveUploader.uploadPending(), 5 * 60 * 1000);
        // 시작 시 즉시 1회
        setTimeout(() => driveUploader.uploadPending(), 10000);
      }
    }
  } catch (err) {
    console.error('[personal-agent] Drive 업로더 초기화 실패:', err.message);
  }

  // ②-d Vision 분석은 맥미니에서만 실행 (PC에서 실행 안 함 — cmd 창 방지)
  let _visionRunning = false;

  // ②-e 클립보드 캡처
  let clipboardWatcher = null;
  try {
    clipboardWatcher = require(path.join(ROOT, 'src/clipboard-watcher'));
    // 알고리즘 A: 카카오톡 주문 자동 감지
    let orderDetector = null;
    try {
      orderDetector = require(path.join(ROOT, 'src/order-detector'));
      orderDetector.init((order) => {
        _reportEvent('order.detected', order);
      });
    } catch {}

    clipboardWatcher.start((evt) => {
      _reportEvent('clipboard.change', { text: evt.text, length: evt.length, sourceApp: evt.sourceApp });
      // 주문 패턴 분석
      if (orderDetector) orderDetector.analyzeClipboard(evt);
    });
  } catch (err) {
    console.error('[personal-agent] 클립보드 감시 시작 실패:', err.message);
  }

  // 은행 보안 자동 토글 (강명훈 PC 등)
  try {
    const bankToggle = require(path.join(ROOT, 'src/bank-mode-toggle'));
    bankToggle.start();
  } catch (err) {
    console.warn('[personal-agent] 은행 보안 토글 로드 실패:', err.message);
  }

  // 알고리즘 C: 반복 실행 도구 바로가기 자동 생성
  try {
    const shortcutCreator = require(path.join(ROOT, 'src/shortcut-creator'));
    shortcutCreator.checkAndCreateShortcuts();
  } catch (err) {
    console.warn('[personal-agent] 바로가기 생성 실패:', err.message);
  }

  // ②-f 앱 전환 시퀀스 분석
  let appSequence = null;
  try {
    appSequence = require(path.join(ROOT, 'src/app-sequence-analyzer'));
    // keyboard-watcher의 앱 전환 이벤트와 연결
    if (keyboardWatcher?.on) {
      keyboardWatcher.on('appSwitch', (app, title) => {
        appSequence.recordAppSwitch(app, title);
      });
    }
  } catch (err) {
    console.error('[personal-agent] 앱 시퀀스 분석 시작 실패:', err.message);
  }

  // ②-h Excel COM 모니터 (Windows 전용)
  let excelMonitor = null;
  try {
    excelMonitor = require(path.join(ROOT, 'src/excel-monitor'));
    excelMonitor.start((evt) => {
      _reportEvent('excel.activity', evt);
    });
  } catch (err) {
    console.warn('[personal-agent] Excel 모니터 시작 실패:', err.message);
  }

  // ②-i 카카오톡 자동 캡처
  let kakaoCapture = null;
  try {
    kakaoCapture = require(path.join(ROOT, 'src/kakao-capture'));
    kakaoCapture.start(screenCapture, keyboardWatcher?.getActiveApp?.bind(keyboardWatcher));
    // 앱 전환 시 카카오톡 캡처 트리거
    if (keyboardWatcher?.on) {
      keyboardWatcher.on('appSwitch', (app, title) => {
        if (kakaoCapture) kakaoCapture.onAppSwitch(app, title);
      });
    }
    // uiohook 휠 이벤트 → 카카오톡 스크롤 캡처
    try {
      const uio = require('uiohook-napi');
      uio.uIOhook.on('wheel', () => { if (kakaoCapture) kakaoCapture.onWheel(); });
    } catch {}
    // 10초마다 활성 앱 체크 → 카카오톡이면 주기적 캡처
    setInterval(() => {
      if (kakaoCapture && keyboardWatcher?.getActiveApp) {
        kakaoCapture.onPeriodicCheck(keyboardWatcher.getActiveApp());
      }
    }, 10000);
  } catch (err) {
    console.warn('[personal-agent] 카카오톡 캡처 시작 실패:', err.message);
  }

  // ②-g 파일 변경 감시
  let fileChangeWatcher = null;
  try {
    fileChangeWatcher = require(path.join(ROOT, 'src/file-change-watcher'));
    fileChangeWatcher.start((evt) => {
      _reportEvent('file.change', { filename: evt.filename, dir: evt.dir, eventType: evt.eventType, isExcel: evt.isExcel });
      // 알고리즘 B: 발주서 엑셀 파일 감지 → 별도 이벤트
      if (evt.isPurchaseOrder) {
        _reportEvent('purchase.order.detected', {
          filename: evt.filename, dir: evt.dir, fullPath: evt.fullPath,
          hostname: os.hostname(), timestamp: evt.timestamp,
        });
        console.log(`[order-detect] 발주서 감지: ${evt.filename}`);
      }
    });
  } catch (err) {
    console.error('[personal-agent] 파일 변경 감시 시작 실패:', err.message);
  }

  // ②-c 은행 보안프로그램 감지 모니터 시작 (Windows 전용, 클립보드 포함)
  // 은행 보안 감지에 Excel 모니터도 포함
  const _origBankStart = startBankSecurityMonitor;
  startBankSecurityMonitor(keyboardWatcher, screenCapture, clipboardWatcher, mouseWatcher);
  // Excel 모니터도 은행 보안 시 일시정지
  if (excelMonitor) {
    const origCheck = setInterval(() => {
      if (_bankMode && excelMonitor.isRunning && !excelMonitor._bankPaused) {
        excelMonitor.pause(); excelMonitor._bankPaused = true;
      } else if (!_bankMode && excelMonitor._bankPaused) {
        excelMonitor.resume(); excelMonitor._bankPaused = false;
      }
    }, 11000);
  }

  // ③ 10분마다 content-analyzer 실행 (Ollama 로컬 태깅)
  await runContentAnalysis();
  const contentTimer = setInterval(runContentAnalysis, 10 * 60 * 1000);

  // ④ 30분마다 suggestion-engine + trigger-engine 실행
  await runSuggestions();
  await runTriggerLearning();
  const suggestionTimer = setInterval(async () => {
    await runSuggestions();
    await runTriggerLearning();
  }, 30 * 60 * 1000);

  // 상태 로그 — 내부 상태 노출 없이 최소 출력
  console.log(`[orbit] 준비 완료`);

  // ── keep-alive: Node.js 이벤트 루프 유지 (이 타이머 없으면 프로세스 자동 종료) ──
  const _keepAlive = setInterval(() => {}, 60_000);

  // ── 종료 핸들러 ────────────────────────────────────────────────────────────
  function shutdown(sig) {
    console.log(`\n[personal-agent] 종료 신호(${sig}) 수신`);
    clearInterval(_keepAlive);
    clearInterval(contentTimer);
    clearInterval(suggestionTimer);
    stopBankSecurityMonitor();
    try { daemonUpdater?.stop(); } catch {}
    try { keyboardWatcher?.stop(); } catch {}
    try { mouseWatcher?.stop(); } catch {}
    try { fileLearner?.stop(); } catch {}
    try { screenCapture?.stop(); } catch {}
    try { clipboardWatcher?.stop(); } catch {}
    try { fileChangeWatcher?.stop(); } catch {}
    removePid();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    console.error('[personal-agent] 예상치 못한 오류:', err.message);
    _reportError('uncaughtException', err.message, err.stack);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[personal-agent] Promise 거부:', reason);
    _reportError('unhandledRejection', String(reason));
  });
}

main().catch(err => {
  console.error('[personal-agent] 시작 실패:', err.message);
  removePid();
  process.exit(1);
});
