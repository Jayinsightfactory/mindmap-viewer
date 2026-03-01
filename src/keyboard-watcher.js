'use strict';

/**
 * keyboard-watcher.js
 * 글로벌 키보드 캡처 (uiohook-napi)
 *
 * - 3초 버퍼 또는 Enter키 → flush → POST /api/personal/keyboard
 * - 비밀번호 앱 활성 시 자동 중단
 * - macOS Accessibility 권한 필요
 */

const https = require('https');
const http  = require('http');
const os    = require('os');
const { execSync } = require('child_process');

// ── 비밀번호 앱 제외 목록 ───────────────────────────────────────────────────
const PASSWORD_APPS = [
  '1password', 'keychain', 'bitwarden', 'lastpass', 'dashlane',
  'keeper', 'enpass', 'roboform', 'nordpass',
];

// ── 상태 ────────────────────────────────────────────────────────────────────
let _buffer      = '';
let _flushTimer  = null;
let _running     = false;
let _uiohook     = null;
let _orbitPort   = parseInt(process.env.ORBIT_PORT || '4747', 10);
let _orbitUrl    = `http://localhost:${_orbitPort}/api/personal/keyboard`;

// ── 현재 활성 앱 감지 (macOS) ──────────────────────────────────────────────
function getActiveApp() {
  try {
    if (process.platform === 'darwin') {
      const script = `tell application "System Events" to get name of first process where frontmost is true`;
      return execSync(`osascript -e '${script}'`, { timeout: 1000 }).toString().trim().toLowerCase();
    }
    if (process.platform === 'win32') {
      const out = execSync(
        `powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.Responding} | Sort-Object CPU -Descending | Select-Object -First 1 -ExpandProperty Name"`,
        { timeout: 1000 }
      ).toString().trim().toLowerCase();
      return out;
    }
  } catch {}
  return '';
}

// ── 비밀번호 앱 확인 ────────────────────────────────────────────────────────
function isPasswordApp(appName) {
  return PASSWORD_APPS.some(p => appName.includes(p));
}

// ── 버퍼 flush → Orbit 서버로 POST ──────────────────────────────────────────
function flush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  const text = _buffer.trim();
  _buffer = '';
  if (!text) return;

  const app = getActiveApp();
  if (isPasswordApp(app)) {
    console.log(`[keyboard-watcher] 비밀번호 앱(${app}) 감지 → 전송 취소`);
    return;
  }

  const payload = JSON.stringify({
    type:      'keyboard.chunk',
    text,
    app,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    ts:        new Date().toISOString(),
  });

  postToOrbit(payload);
}

// ── HTTP POST ────────────────────────────────────────────────────────────────
function postToOrbit(body) {
  try {
    const url = new URL(_orbitUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => res.resume());
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch {}
}

// ── 키 이벤트 핸들러 ─────────────────────────────────────────────────────────
function onKeydown(e) {
  const { keycode, shiftKey } = e;

  // Enter → 즉시 flush
  if (keycode === 13) {
    _buffer += '\n';
    flush();
    return;
  }

  // Backspace
  if (keycode === 14) {
    _buffer = _buffer.slice(0, -1);
    return;
  }

  // 특수키 무시 (Ctrl, Alt, Meta, Fn, Arrow 등)
  if (keycode < 2 || keycode > 200) return;

  // 출력 가능한 문자
  const char = keycodeToChar(keycode, shiftKey);
  if (!char) return;

  _buffer += char;

  // 3초 디바운스
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(flush, 3000);
}

// ── 간이 keycode → char 맵 ──────────────────────────────────────────────────
const KEYMAP = {
  2:'1', 3:'2', 4:'3', 5:'4', 6:'5', 7:'6', 8:'7', 9:'8', 10:'9', 11:'0',
  12:'-', 13:'=', 16:'q', 17:'w', 18:'e', 19:'r', 20:'t', 21:'y', 22:'u',
  23:'i', 24:'o', 25:'p', 26:'[', 27:']', 30:'a', 31:'s', 32:'d', 33:'f',
  34:'g', 35:'h', 36:'j', 37:'k', 38:'l', 39:';', 40:"'", 44:'z', 45:'x',
  46:'c', 47:'v', 48:'b', 49:'n', 50:'m', 51:',', 52:'.', 53:'/', 57:' ',
};
const KEYMAP_SHIFT = {
  2:'!', 3:'@', 4:'#', 5:'$', 6:'%', 7:'^', 8:'&', 9:'*', 10:'(', 11:')',
  12:'_', 13:'+', 16:'Q', 17:'W', 18:'E', 19:'R', 20:'T', 21:'Y', 22:'U',
  23:'I', 24:'O', 25:'P', 26:'{', 27:'}', 30:'A', 31:'S', 32:'D', 33:'F',
  34:'G', 35:'H', 36:'J', 37:'K', 38:'L', 39:':', 40:'"', 44:'Z', 45:'X',
  46:'C', 47:'V', 48:'B', 49:'N', 50:'M', 51:'<', 52:'>', 53:'?',
};

function keycodeToChar(code, shift) {
  return (shift ? KEYMAP_SHIFT[code] : KEYMAP[code]) || null;
}

// ── 공개 API ─────────────────────────────────────────────────────────────────
function start(opts = {}) {
  if (_running) return;
  if (opts.port)   _orbitPort = opts.port;
  if (opts.port)   _orbitUrl  = `http://localhost:${opts.port}/api/personal/keyboard`;

  try {
    _uiohook = require('uiohook-napi');
    _uiohook.uIOhook.on('keydown', onKeydown);
    _uiohook.uIOhook.start();
    _running = true;
    console.log('[keyboard-watcher] 시작 — Accessibility 권한이 필요합니다');
  } catch (err) {
    console.error('[keyboard-watcher] 시작 실패:', err.message);
    console.error('  → 시스템 환경설정 → 보안 및 개인 정보 → 손쉬운 사용에서 node를 허용하세요');
  }
}

function stop() {
  if (!_running) return;
  flush();
  try { _uiohook?.uIOhook.stop(); } catch {}
  _running = false;
  console.log('[keyboard-watcher] 종료');
}

function isRunning() { return _running; }

module.exports = { start, stop, isRunning };
