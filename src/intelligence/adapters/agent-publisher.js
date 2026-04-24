'use strict';
/**
 * src/intelligence/adapters/agent-publisher.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 1: nenova-agent (KakaoTalk 분석) → unified_events
 *
 * nenova-erp-ui Railway API:
 *   GET /api/agent/intelligence  → _agent_intelligence (방별 분석)
 *   GET /api/agent/issues        → _agent_issues (이슈/알림)
 *
 * ERP 측 created_at 보다 최신만 publish. 멱등성: id = 'agent-int:<id>' / 'agent-iss:<id>'
 * ─────────────────────────────────────────────────────────────────────────────
 */

const eventBus = require('../../event-bus');
const erp = require('./erp-client');

let _pool = null;
let _timer = null;
let _running = false;

function init(pool) { _pool = pool; }

async function _getLastCreatedAt(prefix) {
  const { rows } = await _pool.query(
    `SELECT MAX(timestamp) AS last FROM unified_events
      WHERE source = 'nenova-agent' AND id LIKE $1`,
    [`${prefix}:%`]
  );
  return rows[0]?.last || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function _publishIntelligence() {
  const lastAt = await _getLastCreatedAt('agent-int');
  // ERP는 created_at DESC + limit만 지원 → 충분히 큰 limit으로 가져와 클라이언트 필터
  const json = await erp.get('/api/agent/intelligence', { limit: 200 });
  if (!json?.success || !Array.isArray(json.data)) return 0;

  let n = 0;
  for (const r of json.data) {
    const ts = r.created_at;
    if (ts && ts <= lastAt) continue;
    try {
      // extracted_fields, focus_counts 등은 NVARCHAR(MAX)에 JSON 문자열로 저장돼 있음
      const safe = (s) => { try { return s ? JSON.parse(s) : null; } catch { return s; } };
      await eventBus.publish({
        id: `agent-int:${r.id}`,
        type: 'nenova-agent.intelligence',
        source: 'nenova-agent',
        timestamp: ts,
        user_id: null,                                  // 사람 매핑은 entity-resolution 단계
        data: {
          room_name: r.room_name,
          message_count: r.message_count,
          chatbot_role: r.chatbot_role,
          focus_counts: safe(r.focus_counts),
          extracted_fields: safe(r.extracted_fields),
          alerts: safe(r.alerts),
          intelligence_weights: safe(r.intelligence_weights),
          summary: safe(r.summary),
        },
        metadata: { pipeline_run_id: r.pipeline_run_id },
      });
      n++;
    } catch (e) {
      if (!String(e.message).includes('duplicate key')) {
        console.warn('[agent-publisher] intel publish 실패:', e.message);
      }
    }
  }
  return n;
}

async function _publishIssues() {
  const lastAt = await _getLastCreatedAt('agent-iss');
  // status='open' + 'resolved' 둘 다 흡수
  const out = [];
  for (const status of ['open', 'resolved']) {
    const json = await erp.get('/api/agent/issues', { status, limit: 200 });
    if (json?.success && Array.isArray(json.data)) out.push(...json.data);
  }

  let n = 0;
  for (const r of out) {
    const ts = r.created_at;
    if (ts && ts <= lastAt) continue;
    try {
      const detail = (() => { try { return r.detail ? JSON.parse(r.detail) : null; } catch { return r.detail; } })();
      await eventBus.publish({
        id: `agent-iss:${r.id}`,
        type: `nenova-agent.issue.${r.issue_type || 'alert'}`,
        source: 'nenova-agent',
        timestamp: ts,
        data: {
          room_name: r.room_name,
          severity: r.severity,
          title: r.title,
          detail,
          status: r.status,
          resolved_at: r.resolved_at,
          resolved_by: r.resolved_by,
        },
        metadata: { pipeline_run_id: r.pipeline_run_id },
      });
      n++;
    } catch (e) {
      if (!String(e.message).includes('duplicate key')) {
        console.warn('[agent-publisher] issue publish 실패:', e.message);
      }
    }
  }
  return n;
}

async function tick() {
  if (!_pool) throw new Error('[agent-publisher] init(pool) 호출 필요');
  const [a, b] = await Promise.all([_publishIntelligence(), _publishIssues()]);
  return a + b;
}

function start(intervalMs = 60000) {
  if (_running) return;
  _running = true;
  const loop = async () => {
    try {
      const n = await tick();
      if (n > 0) console.log(`[agent-publisher] tick: ${n} events`);
    } catch (e) {
      console.error('[agent-publisher] tick 오류:', e.message);
    } finally {
      if (_running) _timer = setTimeout(loop, intervalMs);
    }
  };
  loop();
  console.log(`[agent-publisher] 시작 (${intervalMs}ms 간격)`);
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

module.exports = { init, tick, start, stop };
