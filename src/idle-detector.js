'use strict';
/**
 * idle-detector.js — 사용자 활동 감지
 *
 * 목적: 주기적 PowerShell 호출·캡처 등이 **사용자 작업 중** 실행되면
 *       창 깜빡임으로 방해. idle 상태일 때만 실행.
 *
 * 사용:
 *   const idle = require('./idle-detector');
 *   idle.touch();                  // 키/마우스 이벤트 발생 시 호출
 *   if (idle.isUserBusy()) return; // 무거운 작업 전 체크
 *   idle.waitIdle().then(() => { ... }); // idle 될 때까지 대기
 */

let _lastActivityAt = Date.now();
const DEFAULT_BUSY_THRESHOLD_MS = 3000; // 3초 내 입력 = busy

/** 키/마우스 이벤트 발생 시 호출 (keyboard-watcher, mouse-watcher에서) */
function touch() {
  _lastActivityAt = Date.now();
}

/** 마지막 활동 이후 경과 시간 (ms) */
function idleMs() {
  return Date.now() - _lastActivityAt;
}

/** 사용자가 작업 중인지 (기본 3초 이내 입력) */
function isUserBusy(thresholdMs = DEFAULT_BUSY_THRESHOLD_MS) {
  return idleMs() < thresholdMs;
}

/**
 * idle 상태 될 때까지 대기. 최대 maxWaitMs까지.
 * @param {number} thresholdMs 이만큼 idle 되면 resolve
 * @param {number} maxWaitMs 이만큼 기다려도 안 되면 어쨌든 resolve (busy:true)
 * @returns {Promise<{busy: boolean, idleMs: number}>}
 */
function waitIdle(thresholdMs = DEFAULT_BUSY_THRESHOLD_MS, maxWaitMs = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!isUserBusy(thresholdMs)) return resolve({ busy: false, idleMs: idleMs() });
      if (Date.now() - start >= maxWaitMs) return resolve({ busy: true, idleMs: idleMs() });
      setTimeout(check, 500);
    };
    check();
  });
}

module.exports = { touch, idleMs, isUserBusy, waitIdle };
