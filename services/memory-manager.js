'use strict';
/**
 * services/memory-manager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 힙 메모리 모니터링 + 서킷브레이커
 *
 * 역할:
 *  - 30초마다 힙 사용량 체크
 *  - HEAP_LIMIT_MB 초과 시 _heapPressure = true → 무거운 요청 거부
 *  - 압력 상태에서 글로벌 큐 긴급 비우기
 *  - Express 미들웨어 제공 (POST /api/hook 거부)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { HEAP_LIMIT_MB } = require('../config/environment');
const logger = require('../src/logger');

let _heapPressure = false;
let _monitorInterval = null;

/**
 * 힙 모니터링 시작.
 * server.js 초기화 시 한 번만 호출하세요.
 */
function startMonitoring() {
  if (_monitorInterval) return; // 중복 시작 방지

  _monitorInterval = setInterval(() => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    const rssMB  = Math.round(usage.rss / 1024 / 1024);

    _heapPressure = heapMB > HEAP_LIMIT_MB;

    if (_heapPressure) {
      logger.warn(`힙 압력 경고: ${heapMB}MB (한계: ${HEAP_LIMIT_MB}MB) — 무거운 요청 거부 중`);
      _emergencyRelease();
    }

    // 5분마다 정상 상태 로그
    if (Date.now() % 300000 < 30000) {
      logger.info(`메모리: heap=${heapMB}MB rss=${rssMB}MB pressure=${_heapPressure}`);
    }
  }, 30000);
}

/**
 * 긴급 메모리 해제: 글로벌 큐/캐시 초기화 + GC 요청
 */
function _emergencyRelease() {
  if (global._visionImageQueue) global._visionImageQueue.length = 0;
  if (global._analysisQueue)    global._analysisQueue.length = 0;
  if (global._daemonCommands) {
    for (const k of Object.keys(global._daemonCommands)) {
      global._daemonCommands[k] = [];
    }
  }
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch {}
  }
}

/**
 * 현재 힙 압력 상태를 반환합니다.
 * @returns {boolean}
 */
function isUnderPressure() {
  return _heapPressure;
}

/**
 * Express 미들웨어: 힙 압력 상태에서 POST /api/hook 요청을 503으로 거부합니다.
 * 데몬이 재시도하므로 이벤트 손실 없음.
 */
function middleware(req, res, next) {
  if (_heapPressure && req.method === 'POST' && req.url.includes('/api/hook')) {
    return res.status(503).json({ error: 'Server under memory pressure, retry later' });
  }
  next();
}

/**
 * 모니터링 중지 (테스트용)
 */
function stopMonitoring() {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
  }
}

module.exports = { startMonitoring, stopMonitoring, isUnderPressure, middleware };
