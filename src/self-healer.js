'use strict';
/**
 * src/self-healer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 데이터 수집 셀프힐링 — 컴포넌트 이상 감지 + 자동 복구
 *
 * 감지 항목:
 *   1. 업무시간 중 30분 이상 이벤트 없음 → keyboard-watcher 재시작
 *   2. 서버 전송 연속 에러 5회 → 토큰 캐시 초기화
 *   3. 컴포넌트 isRunning() === false → 해당 컴포넌트 재시작
 *   4. screen-capture 연속 실패 5회 → screen-capture 재시작
 * ─────────────────────────────────────────────────────────────────────────────
 */

const os = require('os');

const HEAL_INTERVAL_MS  = 5 * 60 * 1000;   // 5분마다 헬스체크
const MAX_SILENCE_MS    = 30 * 60 * 1000;  // 업무시간 중 30분 무이벤트 = 이상
const MAX_SEND_ERRS     = 5;               // 연속 전송 에러 임계값
const MAX_CAPTURE_ERRS  = 5;              // 연속 캡처 에러 임계값
const WORK_START_HOUR   = 8;
const WORK_END_HOUR     = 21;

// ── 내부 상태 ─────────────────────────────────────────────────────────────────
let _components   = {};       // { name: { ref, startArgs } }
let _lastEventAt  = Date.now();
let _sendErrCount = 0;
let _captureErrCount = 0;
let _healTimer    = null;
let _reportEvent  = null;
let _clearTokenCache = null;
let _healCount    = 0;
let _initialized  = false;

// ── 초기화 ────────────────────────────────────────────────────────────────────
function init({ components = {}, reportEvent, clearTokenCache } = {}) {
  _components      = components;
  _reportEvent     = reportEvent     || (() => {});
  _clearTokenCache = clearTokenCache || (() => {});
  _initialized     = true;
}

// ── 외부에서 호출하는 상태 기록 ───────────────────────────────────────────────
function recordEvent() {
  _lastEventAt  = Date.now();
  _sendErrCount = 0;
}

function recordSendError() {
  _sendErrCount++;
}

function recordCaptureError() {
  _captureErrCount++;
}

function recordCaptureSuccess() {
  _captureErrCount = 0;
}

// ── 업무시간 체크 ─────────────────────────────────────────────────────────────
function _isWorkHour() {
  const h = new Date().getHours();
  return h >= WORK_START_HOUR && h < WORK_END_HOUR;
}

// ── 컴포넌트 재시작 ───────────────────────────────────────────────────────────
async function _restartComponent(name) {
  const comp = _components[name];
  if (!comp?.ref) return false;
  try {
    if (typeof comp.ref.stop === 'function') comp.ref.stop();
  } catch {}
  // 재시작 전 2초 대기
  await new Promise(r => setTimeout(r, 2000));
  try {
    if (typeof comp.ref.start === 'function') {
      comp.ref.start(comp.startArgs || {});
      console.log(`[self-healer] ${name} 재시작 완료`);
      return true;
    }
  } catch (e) {
    console.error(`[self-healer] ${name} 재시작 실패:`, e.message);
  }
  return false;
}

// ── 메인 힐링 루프 ────────────────────────────────────────────────────────────
async function _runHeal() {
  if (!_initialized) return;
  const now    = Date.now();
  const issues = [];

  // 1. 업무시간 중 이벤트 흐름 체크
  if (_isWorkHour()) {
    const silenceMs = now - _lastEventAt;
    if (silenceMs > MAX_SILENCE_MS) {
      issues.push(`event_silence_${Math.round(silenceMs / 60000)}min`);
      const ok = await _restartComponent('keyboard-watcher');
      if (ok) _lastEventAt = now;
    }
  }

  // 2. 서버 연속 전송 에러
  if (_sendErrCount >= MAX_SEND_ERRS) {
    issues.push(`send_errors_${_sendErrCount}`);
    if (_clearTokenCache) _clearTokenCache();
    _sendErrCount = 0;
  }

  // 3. 스크린 캡처 연속 실패
  if (_captureErrCount >= MAX_CAPTURE_ERRS) {
    issues.push(`capture_errors_${_captureErrCount}`);
    await _restartComponent('screen-capture');
    _captureErrCount = 0;
  }

  // 4. 컴포넌트별 isRunning 체크
  for (const [name, comp] of Object.entries(_components)) {
    if (!comp?.ref) continue;
    let running = null;
    if (typeof comp.ref.isRunning === 'function')  running = comp.ref.isRunning();
    else if (typeof comp.ref.isAlive === 'function') running = comp.ref.isAlive();
    if (running === false) {
      issues.push(`${name}_stopped`);
      await _restartComponent(name);
    }
  }

  // 5. 이슈 발생 시 서버 리포트
  if (issues.length > 0) {
    _healCount++;
    console.log(`[self-healer] 치유 #${_healCount}: ${issues.join(', ')}`);
    try {
      _reportEvent('daemon.healed', {
        healCount: _healCount,
        issues,
        hostname:  os.hostname(),
        platform:  os.platform(),
        ts:        new Date().toISOString(),
      });
    } catch {}
  }
}

// ── 시작 / 정지 ───────────────────────────────────────────────────────────────
function start() {
  if (_healTimer) return;
  // 시작 1분 후 첫 체크 (기동 직후 노이즈 방지)
  setTimeout(() => {
    _runHeal().catch(() => {});
    _healTimer = setInterval(() => {
      _runHeal().catch(e => console.warn('[self-healer] 오류:', e.message));
    }, HEAL_INTERVAL_MS);
  }, 60 * 1000);
  console.log('[self-healer] 시작 (5분마다 헬스체크)');
}

function stop() {
  if (_healTimer) { clearInterval(_healTimer); _healTimer = null; }
}

module.exports = {
  init,
  start,
  stop,
  recordEvent,
  recordSendError,
  recordCaptureError,
  recordCaptureSuccess,
};
