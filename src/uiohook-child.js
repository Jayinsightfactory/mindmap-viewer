'use strict';
/**
 * uiohook-child.js — uiohook-napi 격리 child process
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-06-09 추가: uiohook-napi SIGSEGV / native crash가 메인 데몬을 죽이는 문제 해결
 *
 * 구조:
 *   메인 데몬 (personal-agent.js)
 *     └── keyboard-watcher.js
 *           └── fork() → uiohook-child.js (이 파일)
 *                 └── uiohook-napi (native crash 가능 영역 격리)
 *                       └── IPC: keydown/mousedown/wheel → 부모로 전달
 *
 * 효과:
 *   - uiohook native crash 시 이 child만 죽음 (SIGSEGV는 catch 불가)
 *   - 부모 데몬은 child 죽음 감지 → 30초 후 재 fork
 *   - 데이터 수집 일시 중단되지만 데몬 자체는 영구 작동
 * ─────────────────────────────────────────────────────────────────────────────
 */

function send(msg) {
  try { if (process.send) process.send(msg); } catch {}
}

let _uIOhook = null;
try {
  _uIOhook = require('uiohook-napi').uIOhook;
} catch (e) {
  send({ type: 'load_error', error: e.message });
  process.exit(1);
}

// 이벤트 → 부모로 IPC 전달 (직렬화 가능한 필드만)
// mousemove는 고빈도라 100ms 쓰로틀 후 전송 (IPC 폭주 방지)
let _lastMoveSent = 0;
try {
  _uIOhook.on('keydown', (e) => {
    send({ type: 'keydown', e: { keycode: e.keycode, time: e.time, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey } });
  });
  _uIOhook.on('mousedown', (e) => {
    send({ type: 'mousedown', e: { x: e.x, y: e.y, button: e.button, time: e.time } });
  });
  _uIOhook.on('mouseup', (e) => {
    send({ type: 'mouseup', e: { x: e.x, y: e.y, button: e.button, time: e.time } });
  });
  _uIOhook.on('mousemove', (e) => {
    const now = Date.now();
    if (now - _lastMoveSent < 100) return;
    _lastMoveSent = now;
    send({ type: 'mousemove', e: { x: e.x, y: e.y, time: e.time } });
  });
  _uIOhook.on('wheel', (e) => {
    send({ type: 'wheel', e: e ? { rotation: e.rotation, direction: e.direction, time: e.time } : {} });
  });
} catch (e) {
  send({ type: 'handler_error', error: e.message });
  process.exit(2);
}

// uIOhook 시작
try {
  _uIOhook.start();
  send({ type: 'started', pid: process.pid });
} catch (e) {
  send({ type: 'start_error', error: e.message });
  process.exit(3);
}

// stability check — 5초 후 살아있으면 안정
setTimeout(() => {
  send({ type: 'stable', uptimeMs: 5000 });
}, 5000);

// 부모 종료 신호 / 부모 사망 시 cleanup
function _cleanup() {
  try { _uIOhook.stop(); } catch {}
  try { send({ type: 'shutdown' }); } catch {}
  process.exit(0);
}
process.on('disconnect', _cleanup);
process.on('SIGTERM', _cleanup);
process.on('SIGINT', _cleanup);

// uncaughtException은 child 안에서 catch — 부모에게 알림 후 종료
process.on('uncaughtException', (err) => {
  send({ type: 'uncaught', error: err?.message || String(err), stack: err?.stack });
  // 종료 — 부모가 재spawn
  process.exit(10);
});
process.on('unhandledRejection', (reason) => {
  send({ type: 'unhandled', reason: String(reason) });
});

// keep-alive (이벤트 루프 유지)
setInterval(() => {
  send({ type: 'heartbeat', pid: process.pid });
}, 60 * 1000);
