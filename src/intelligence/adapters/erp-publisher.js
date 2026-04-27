'use strict';
/**
 * src/intelligence/adapters/erp-publisher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 1: nenova-erp (Order/Shipment/Estimate) → unified_events
 *
 * Phase A 범위: 사람 활동의 결과로 남는 핵심 트랜잭션만.
 *   - 주문 (OrderMaster + OrderDetail) — 주문 생성·변경
 *   - 출고 (ShipmentDetail history) — 출고 분배·확정
 *   - 견적 (estimate)               — 견적 생성·변경
 *
 * ERP 응답 스키마는 자격증명 발급 후 첫 호출로 검증 필요.
 * 본 publisher는 응답을 보존(원형) 한 채 unified_events에 적재 → Layer 2/3가 해석.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const eventBus = require('../../event-bus');
const erp = require('./erp-client');

let _pool = null;
let _timer = null;
let _running = false;

// 폴링 대상 엔드포인트 정의
// idField: 멱등성 ID 생성 키, tsField: cursor 비교용 timestamp 키
const ENDPOINTS = [
  { path: '/api/orders/history',     idField: 'OhKey',   tsField: 'ChgDtm',    type: 'erp-ui.order.history',    idPrefix: 'erp-orderH' },
  { path: '/api/shipment/history',   idField: 'ShKey',   tsField: 'ChgDtm',    type: 'erp-ui.shipment.history', idPrefix: 'erp-shipH'  },
  { path: '/api/estimate',           idField: 'EstKey',  tsField: 'UpdDtm',    type: 'erp-ui.estimate',         idPrefix: 'erp-est'    },
];

async function _getLastCursor(idPrefix) {
  const { rows } = await _pool.query(
    `SELECT MAX(timestamp) AS last FROM unified_events
      WHERE source = 'erp-ui' AND id LIKE $1`,
    [`${idPrefix}:%`]
  );
  return rows[0]?.last || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function _publishEndpoint(ep) {
  let json;
  try {
    json = await erp.get(ep.path, { limit: 500 });
  } catch (e) {
    // 첫 실행에서 해당 엔드포인트 미존재 가능 — 경고만 남기고 계속
    console.warn(`[erp-publisher] ${ep.path} 호출 실패: ${e.message}`);
    return 0;
  }
  // 응답 컨테이너 자동 탐지: 배열인 값을 가진 첫 번째 키 사용
  let list;
  if (Array.isArray(json)) {
    list = json;
  } else if (json && typeof json === 'object') {
    const arrayKey = Object.keys(json).find(k => Array.isArray(json[k]));
    list = arrayKey ? json[arrayKey] : [];
  } else {
    list = [];
  }
  if (list.length === 0) return 0;

  const lastAt = await _getLastCursor(ep.idPrefix);

  let n = 0;
  for (const r of list) {
    const ts = r[ep.tsField] || r.created_at || r.updated_at || null;
    if (ts && ts <= lastAt) continue;
    const sourceId = r[ep.idField];
    if (!sourceId) continue;

    try {
      await eventBus.publish({
        id: `${ep.idPrefix}:${sourceId}`,
        type: ep.type,
        source: 'erp-ui',
        timestamp: ts || new Date().toISOString(),
        user_id: r.UserID || r.RegUser || r.ChgUser || null,
        data: r,                                      // 원형 보존
        metadata: { endpoint: ep.path, id_field: ep.idField, ts_field: ep.tsField },
      });
      n++;
    } catch (e) {
      if (!String(e.message).includes('duplicate key')) {
        console.warn(`[erp-publisher] ${ep.path} publish 실패:`, e.message);
      }
    }
  }
  return n;
}

function init(pool) {
  _pool = pool;
}

async function tick() {
  if (!_pool) throw new Error('[erp-publisher] init(pool) 호출 필요');
  let total = 0;
  for (const ep of ENDPOINTS) {
    total += await _publishEndpoint(ep);
  }
  return total;
}

function start(intervalMs = 60000) {
  if (_running) return;
  _running = true;
  const loop = async () => {
    try {
      const n = await tick();
      if (n > 0) console.log(`[erp-publisher] tick: ${n} events`);
    } catch (e) {
      console.error('[erp-publisher] tick 오류:', e.message);
    } finally {
      if (_running) _timer = setTimeout(loop, intervalMs);
    }
  };
  loop();
  console.log(`[erp-publisher] 시작 (${intervalMs}ms 간격)`);
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { init, tick, start, stop, ENDPOINTS };
