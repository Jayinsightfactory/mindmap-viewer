/**
 * mouse-watcher — 마우스 이벤트 수집 → 60초마다 mouse.chunk 원격 전송
 *
 * 설계 원칙:
 * - uiohook-napi singleton을 keyboard-watcher가 이미 start()한 뒤에 listener만 추가
 * - keyboard-watcher와 독립 동작 (실패해도 키보드/스크린 파이프라인 영향 없음)
 * - 별도 이벤트 타입: mouse.chunk (keyboard.chunk와 분리)
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const http = require('http');
const https = require('https');

// ── config (~/.orbit-config.json 매번 동적 읽기) ─────────────────────────────
function _readOrbitConfig() {
  try {
    let raw = fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch { return {}; }
}
function _getRemoteUrl()   { return _readOrbitConfig().serverUrl || process.env.ORBIT_SERVER_URL || null; }
function _getRemoteToken() { return _readOrbitConfig().token     || process.env.ORBIT_TOKEN      || '';   }

// HTTP 헤더는 ASCII만 허용 → 한글/유니코드 hostname 안전 변환
function _asciiHostname() {
  const raw = String(os.hostname() || 'unknown');
  // ASCII printable만 유지, 나머지는 '?'로 치환 + URL encode 폴백
  const safe = raw.replace(/[^\x20-\x7E]/g, '_');
  return safe || 'unknown';
}

// ── 상태 ────────────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS  = 60 * 1000;   // 60초마다 원격 전송
const MOVE_THROTTLE_MS   = 200;         // mousemove 쓰로틀 (초당 5회)
const MAX_CLICK_POSITIONS = 100;        // chunk당 클릭 좌표 최대 저장

let _running       = false;
let _paused        = false;
let _flushTimer    = null;

// heartbeat 진단용 상태 추적
let _lastFlushAt   = 0;  // 마지막 성공 flush timestamp (ms)
let _lastErrorAt   = 0;  // 마지막 에러 timestamp (ms)
let _errorCount    = 0;  // 누적 에러 수 (start 이후)
let _lastErrorMsg  = '';

let _clickCount    = 0;
let _mousedownCount = 0;
let _mouseupCount   = 0;
let _wheelCount    = 0;
let _wheelDelta    = 0;               // 누적 휠 델타 (스크롤 양)
let _moveCount     = 0;               // 쓰로틀 이후 기록된 move 카운트
let _moveDistance  = 0;               // 누적 이동 거리 (px)
let _lastMove      = null;            // 마지막 저장된 move { x, y, t }
let _clickPositions = [];             // [{ x, y, t, button }]
let _quadrants     = { LT: 0, LB: 0, RT: 0, RB: 0 };

let _periodStart   = null;

// 외부 주입 (personal-agent에서 전달)
let _getActiveApp    = () => '';
let _getActiveWindow = () => '';

function _resetBuffer() {
  _clickCount = 0;
  _mousedownCount = 0;
  _mouseupCount = 0;
  _wheelCount = 0;
  _wheelDelta = 0;
  _moveCount = 0;
  _moveDistance = 0;
  _lastMove = null;
  _clickPositions = [];
  _quadrants = { LT: 0, LB: 0, RT: 0, RB: 0 };
  _periodStart = new Date().toISOString();
}

function _onMousedown(e) {
  if (_paused) return;
  _mousedownCount++;
  _clickCount++;
  const app = _getActiveApp();
  const win = _getActiveWindow();
  if (_clickPositions.length < MAX_CLICK_POSITIONS) {
    _clickPositions.push({ x: e.x, y: e.y, t: Date.now(), button: e.button, app, win });
  }
  const q = `${e.x < 960 ? 'L' : 'R'}${e.y < 540 ? 'T' : 'B'}`;
  _quadrants[q] = (_quadrants[q] || 0) + 1;
}

function _onMouseup() {
  if (_paused) return;
  _mouseupCount++;
}

function _onMousemove(e) {
  if (_paused) return;
  const now = Date.now();
  if (_lastMove && (now - _lastMove.t) < MOVE_THROTTLE_MS) return;
  if (_lastMove) {
    const dx = e.x - _lastMove.x;
    const dy = e.y - _lastMove.y;
    _moveDistance += Math.sqrt(dx * dx + dy * dy);
  }
  _lastMove = { x: e.x, y: e.y, t: now };
  _moveCount++;
}

function _onWheel(e) {
  if (_paused) return;
  _wheelCount++;
  _wheelDelta += Math.abs(e.rotation || e.amount || 1);
}

// flush 상태 추적 — 첫 flush는 무조건 / 이후 idle이면 5분(=5사이클)에 1번 heartbeat
let _flushCount = 0;
let _idleSkipCount = 0;
const IDLE_HEARTBEAT_EVERY = 5;  // 5사이클(=5분)에 1번 heartbeat

function _flushRemote() {
  const url = _getRemoteUrl();
  if (!url) return;

  const isIdle = (_clickCount === 0 && _moveCount === 0 && _wheelCount === 0);
  // 첫 flush는 무조건 (start 직후 동작 검증), 이후 idle은 5분에 1번만 heartbeat
  if (isIdle && _flushCount > 0) {
    _idleSkipCount++;
    if (_idleSkipCount < IDLE_HEARTBEAT_EVERY) return;
    _idleSkipCount = 0;
  } else {
    _idleSkipCount = 0;
  }
  _flushCount++;

  const now = new Date().toISOString();
  const payload = {
    clicks: _clickCount,
    mousedowns: _mousedownCount,
    mouseups: _mouseupCount,
    wheels: _wheelCount,
    wheelDelta: Math.round(_wheelDelta),
    moves: _moveCount,
    moveDistance: Math.round(_moveDistance),
    quadrants: { ..._quadrants },
    clickPositions: _clickPositions.slice(-50),
    app: _getActiveApp(),
    windowTitle: _getActiveWindow(),
    period: { start: _periodStart, end: now },
    flushCount: _flushCount,
    idle: isIdle,
  };

  const hookPayload = JSON.stringify({
    events: [{
      id:        'ms-' + Date.now(),
      type:      'mouse.chunk',
      source:    'mouse-watcher',
      sessionId: 'daemon-' + os.hostname(),
      timestamp: now,
      data:      payload,
    }],
    fromRemote: true,
  });

  try {
    const u = new URL('/api/hook', url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(hookPayload),
      'X-Device-Id':    _asciiHostname(),
    };
    const token = _getRemoteToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname,
      method:   'POST',
      headers,
      timeout:  10000,
    }, res => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode >= 300) {
          _errorCount++;
          _lastErrorAt = Date.now();
          _lastErrorMsg = `HTTP ${res.statusCode}`;
          console.warn(`[mouse-watcher] 원격 응답: ${res.statusCode}`);
        } else {
          _lastFlushAt = Date.now();
        }
      });
    });
    req.on('error', (err) => {
      _errorCount++;
      _lastErrorAt = Date.now();
      _lastErrorMsg = err.message;
      console.warn('[mouse-watcher] 전송 실패:', err.message);
    });
    req.on('timeout', () => { req.destroy(); });
    req.write(hookPayload);
    req.end();
  } catch (err) {
    _errorCount++;
    _lastErrorAt = Date.now();
    _lastErrorMsg = err.message;
    console.warn('[mouse-watcher] 전송 오류:', err.message);
  }

  _resetBuffer();
}

/**
 * 시작 — keyboard-watcher가 uiohook.uIOhook.start()를 이미 호출한 뒤에 불릴 것
 * @param {object} opts { getActiveApp, getActiveWindow }
 */
function _sendStartSignal() {
  const url = _getRemoteUrl();
  if (!url) return;
  try {
    const hookPayload = JSON.stringify({
      events: [{
        id:        'ms-start-' + Date.now(),
        type:      'mouse.watcher.started',
        source:    'mouse-watcher',
        sessionId: 'daemon-' + os.hostname(),
        timestamp: new Date().toISOString(),
        data:      { hostname: os.hostname(), platform: os.platform(), pid: process.pid },
      }],
      fromRemote: true,
    });
    const u = new URL('/api/hook', url);
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(hookPayload),
      'X-Device-Id':    _asciiHostname(),
    };
    const token = _getRemoteToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = mod.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname,
      method:   'POST',
      headers,
      timeout:  10000,
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    req.on('error', () => {});
    req.on('timeout', () => { req.destroy(); });
    req.write(hookPayload);
    req.end();
  } catch {}
}

function start(opts = {}) {
  if (_running) return;
  if (typeof opts.getActiveApp === 'function') _getActiveApp = opts.getActiveApp;
  if (typeof opts.getActiveWindow === 'function') _getActiveWindow = opts.getActiveWindow;

  try {
    const { uIOhook } = require('uiohook-napi');
    // keyboard-watcher가 이미 start() 했으므로 listener만 추가
    uIOhook.on('mousedown', _onMousedown);
    uIOhook.on('mouseup',   _onMouseup);
    uIOhook.on('mousemove', _onMousemove);
    uIOhook.on('wheel',     _onWheel);
    _running = true;
    _resetBuffer();
    // 시작 신호 즉시 전송 (서버에서 데몬이 살아있음 + mouse-watcher 동작 확인용)
    _sendStartSignal();
    // 5초 후 첫 flush (검증 빠르게), 이후 60초 주기
    setTimeout(_flushRemote, 5000);
    _flushTimer = setInterval(_flushRemote, FLUSH_INTERVAL_MS);
    console.log('[mouse-watcher] started — first flush in 5s, interval 60s');
  } catch (err) {
    console.warn('[mouse-watcher] uiohook load 실패:', err.message);
    // mouse-watcher가 실패해도 keyboard-watcher 등 다른 워처는 영향 없음
  }
}

function stop() {
  if (!_running) return;
  try {
    const { uIOhook } = require('uiohook-napi');
    uIOhook.off('mousedown', _onMousedown);
    uIOhook.off('mouseup',   _onMouseup);
    uIOhook.off('mousemove', _onMousemove);
    uIOhook.off('wheel',     _onWheel);
  } catch {}
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  _flushRemote();
  _running = false;
}

function pause()  { _paused = true;  }
function resume() { _paused = false; }

// heartbeat 진단용 — 모듈 상태 보고
function getStatus() {
  const now = Date.now();
  const sinceFlush = _lastFlushAt ? Math.round((now - _lastFlushAt) / 1000) : null;
  let state = 'ok';
  if (!_running)                              state = 'dead';
  else if (_paused)                           state = 'paused';
  else if (_errorCount >= 5 && sinceFlush === null)  state = 'degraded';
  // recency 기반 degrade 제거 — 활동 기반 flush라 idle 유저에게 오판정
  // state는 running + errorCount만 반영. lastFlushAt은 info로만 표시
  return {
    running:      _running,
    paused:       _paused,
    state,
    flushCount:   _flushCount,
    lastFlushAt:  _lastFlushAt ? new Date(_lastFlushAt).toISOString() : null,
    secondsSinceFlush: sinceFlush,
    errorCount:   _errorCount,
    lastErrorAt:  _lastErrorAt ? new Date(_lastErrorAt).toISOString() : null,
    lastErrorMsg: _lastErrorMsg || null,
    hostname:     _asciiHostname(),
  };
}

module.exports = { start, stop, pause, resume, getStatus };
