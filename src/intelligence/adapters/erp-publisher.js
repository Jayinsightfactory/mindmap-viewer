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
// idFields: 복합키(배열) 또는 단일키(문자열) — 멱등성 ID 생성
// tsField: cursor 비교용 timestamp 키 (null이면 현재 시각 사용)
// userField: user_id 추출 키
const ENDPOINTS = [
  {
    path: '/api/orders/history',
    idFields: ['차수', '꽃', '변경항목'],  // 차수=배치번호, 꽃=품종, 변경항목=변경필드
    tsField: '변경일자',
    userField: '변경사용자',
    type: 'erp-ui.order.history',
    idPrefix: 'erp-orderH',
  },
  {
    path: '/api/shipment/history',
    idFields: ['week', 'name', 'type'],    // week=배송주차, name=품목명, type=변경유형
    tsField: 'ChangeDtm',
    userField: null,
    type: 'erp-ui.shipment.history',
    idPrefix: 'erp-shipH',
  },
  {
    path: '/api/estimate',
    idFields: ['firstShipmentKey'],        // 고유 출고키
    tsField: null,                         // timestamp 없음 → 현재 시각
    userField: null,
    type: 'erp-ui.estimate',
    idPrefix: 'erp-est',
  },
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

    // 복합키 지원: idFields 배열이면 각 값 join, 문자열이면 단일 필드
    const fields = Array.isArray(ep.idFields) ? ep.idFields : [ep.idField || ep.idFields];
    const sourceId = fields.map(f => r[f] ?? '').join('|');
    if (!sourceId || sourceId === fields.map(() => '').join('|')) continue;

    const userId = ep.userField ? (r[ep.userField] || null)
                 : (r.UserID || r.RegUser || r.ChgUser || r['변경사용자'] || null);

    try {
      await eventBus.publish({
        id: `${ep.idPrefix}:${sourceId}`,
        type: ep.type,
        source: 'erp-ui',
        timestamp: ts || new Date().toISOString(),
        user_id: userId,
        data: r,
        metadata: { endpoint: ep.path, id_fields: fields, ts_field: ep.tsField },
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
