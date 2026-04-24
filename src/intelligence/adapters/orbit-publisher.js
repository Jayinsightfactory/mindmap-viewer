'use strict';
/**
 * src/intelligence/adapters/orbit-publisher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 1: orbit (PC 텔레메트리) → unified_events
 *
 * 같은 PG의 `events` 테이블에서 **의미 경계 이벤트**만 추출해
 * `unified_events` 로 source='orbit' publish.
 *
 * 의미 경계 (feedback_capture_timing_philosophy 준수):
 *   - 앱 포커스 변경 (focus_change)
 *   - 클립보드 페이스트 (clipboard_paste, > 10자)
 *   - 파일 저장 (file_save)
 *   - 세션 시작/종료 (session_*)
 *
 * 키스트로크 1:1 복사 금지 — 폭발 방지.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const eventBus = require('../../event-bus');

// 의미 이벤트 type 화이트리스트 (events.type 기준)
const MEANINGFUL_TYPES = new Set([
  'focus_change',
  'app_focus',
  'clipboard_paste',
  'clipboard_change',
  'file_save',
  'file_open',
  'session_start',
  'session_end',
  'tool_use',
]);

let _pool = null;
let _timer = null;
let _running = false;

/**
 * 초기화
 * @param {import('pg').Pool} pool
 */
function init(pool) {
  _pool = pool;
}

/**
 * 마지막으로 publish 된 orbit 이벤트의 timestamp 조회.
 * 별도 state 테이블 없이 unified_events의 max(timestamp)로 추적.
 */
async function _getLastPublishedAt() {
  const { rows } = await _pool.query(
    `SELECT MAX(timestamp) AS last FROM unified_events WHERE source = 'orbit'`
  );
  // 최초 실행 시 24h 전부터 시작 (백필 방지)
  return rows[0]?.last || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

/**
 * events → unified_events 한 사이클.
 * @param {object} opts { batchSize: 500 }
 * @returns {Promise<number>} publish 된 이벤트 개수
 */
async function tick(opts = {}) {
  if (!_pool) throw new Error('[orbit-publisher] init(pool) 호출 필요');

  const batchSize = opts.batchSize || 500;
  const lastAt = await _getLastPublishedAt();
  const types = [...MEANINGFUL_TYPES];

  const { rows } = await _pool.query(
    `SELECT id, type, source, session_id, user_id, channel_id,
            timestamp, data_json, metadata_json
       FROM events
      WHERE timestamp > $1
        AND type = ANY($2)
      ORDER BY timestamp ASC
      LIMIT $3`,
    [lastAt, types, batchSize]
  );

  let published = 0;
  for (const row of rows) {
    try {
      // 클립보드 노이즈 필터: 10자 미만 제외
      if (row.type.startsWith('clipboard') && (row.data_json?.text || '').length < 10) {
        continue;
      }

      await eventBus.publish({
        id: `orbit:${row.id}`,                      // 멱등성: orbit:<events.id>
        type: `orbit.${row.type}`,                  // namespace: orbit.focus_change 등
        source: 'orbit',
        timestamp: row.timestamp,
        user_id: row.user_id,                        // 9 PC 매핑은 별도 entity-resolution이 처리
        session_id: row.session_id,
        data: row.data_json || {},
        metadata: {
          ...(row.metadata_json || {}),
          channel_id: row.channel_id,
          original_source: row.source,
        },
      });
      published++;
    } catch (e) {
      // 멱등성 위반(같은 id 재 publish) = 정상 — 다음 row 진행
      if (!String(e.message).includes('duplicate key')) {
        console.warn(`[orbit-publisher] publish 실패 ${row.id}:`, e.message);
      }
    }
  }
  return published;
}

/**
 * 주기 폴링 시작.
 * @param {number} intervalMs 기본 60초
 */
function start(intervalMs = 60000) {
  if (_running) return;
  _running = true;
  const loop = async () => {
    try {
      const n = await tick();
      if (n > 0) console.log(`[orbit-publisher] tick: ${n} events`);
    } catch (e) {
      console.error('[orbit-publisher] tick 오류:', e.message);
    } finally {
      if (_running) _timer = setTimeout(loop, intervalMs);
    }
  };
  loop();
  console.log(`[orbit-publisher] 시작 (${intervalMs}ms 간격)`);
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { init, tick, start, stop };
