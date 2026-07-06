'use strict';
/**
 * flow-handoff.js — Action 관계 보강 (핸드오프 엔진)
 * ─────────────────────────────────────────────────────────────────────────────
 * routes/ops-ontology.js 의 promote() 가 Action(unified_events) 을 만든 뒤 호출.
 * promote = Action 생성 / enrich = Action 위에 흐름 관계를 멱등 보강.
 *
 *   linkCustomers() → action_mentions_customer (Action → Customer 골든)
 *   linkHandoffs()  → action_handoff           (Action → Action, 사람간 인계)
 *   linkErp()       → action_updated_erp        (Action → ErpOutcome, 라이프사이클 끝단)
 *
 * 증거 텍스트는 Action.data 의 activity/screen/room 을 사용(가벼움, 추가 쿼리 없음).
 * 거래처명은 카톡방(room)·화면해독(screen)에 자주 나타나므로 1차로 충분.
 * 관계 id 패턴·멱등 upsert 는 ops-ontology.js 와 동일.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const N = require('./intelligence/entity-resolution/korean-normalizer');
const { bootstrap } = require('./intelligence/entity-resolution/bootstrap-customer');

const ERP_APPS = new Set(['nenova ERP', 'ECOUNT ERP']);
const HANDOFF_WINDOW_MS = 24 * 3600 * 1000;   // 인계로 인정할 두 액션의 최대 시간차
const MIN_LOOKBACK_HOURS = 72;                // 짝(앞사람 액션)이 빠지지 않도록 최소 룩백

function tryObj(x) {
  if (!x) return {};
  if (typeof x === 'object') return x;
  try { return JSON.parse(x); } catch { return {}; }
}

// customer 골든 인덱스 (match-customer-fuzzy._loadCustomerIndex 와 동일 로직)
async function loadCustomerIndex(pool) {
  const { rows } = await pool.query(
    `SELECT id, display_name, attributes FROM orbit_entity_golden WHERE entity_type='customer'`
  );
  const index = [];
  for (const r of rows) {
    const attrs = tryObj(r.attributes);
    const names = new Set([r.display_name, ...((attrs.aliases) || [])]);
    for (const nm of names) {
      const norm = N.normalizeName(nm);
      if (norm && norm.length >= 2) index.push({ id: r.id, displayName: r.display_name, normName: norm });
    }
  }
  return index;
}

async function upsertRel(pool, relType, fromType, fromRef, toType, toRef, confidence, evidence, tsIso, workspaceId) {
  const rid = `rel:${relType}:${fromRef}:${toRef}`.slice(0, 200);
  await pool.query(
    `INSERT INTO ops_relation (id, rel_type, from_type, from_ref, to_type, to_ref, source, confidence, evidence, ts, workspace_id)
     VALUES ($1,$2,$3,$4,$5,$6,'orbit',$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET confidence=$7, ts=$9, evidence=$8`,
    [rid, relType, fromType, fromRef, toType, toRef, confidence, JSON.stringify(evidence || {}), tsIso, workspaceId]
  );
}

// Action.data 에서 매칭용 증거 텍스트
function actionText(d) {
  return [d.activity || '', d.screen || '', d.room || ''].join(' ').trim();
}

/**
 * 메인: promote 직후 관계 보강. hours = promote 윈도우(룩백은 최소 72h로 확장).
 * @returns {{mentions:number, handoffs:number, erp:number, actions:number}}
 */
async function enrichHandoff(pool, hours) {
  const lookbackH = Math.max(hours || 24, MIN_LOOKBACK_HOURS);
  const since = new Date(Date.now() - lookbackH * 3600 * 1000).toISOString();

  const { rows } = await pool.query(
    `SELECT id, user_id, timestamp, data, workspace_id FROM unified_events
      WHERE type='work.action' AND timestamp >= $1
      ORDER BY timestamp ASC`,
    [since]
  );
  const acts = rows.map(r => {
    const d = tryObj(r.data);
    return {
      id: r.id, u: r.user_id, ts: new Date(r.timestamp).getTime(), tsIso: new Date(r.timestamp).toISOString(),
      app: d.app || '', room: d.room || '', text: actionText(d), data: d, ws: r.workspace_id,
    };
  });

  // ── 거래처 인덱스 (비면 erp 부트스트랩 후 재로드) ──
  let custIndex = await loadCustomerIndex(pool);
  if (custIndex.length === 0) {
    try { await bootstrap(pool); custIndex = await loadCustomerIndex(pool); } catch (e) { /* erp 데이터 없으면 skip */ }
  }

  // ── A. action_mentions_customer + 액션별 거래처 키 수집 ──
  let mentions = 0;
  const actCust = new Map(); // actId → goldenId (핸드오프 키용)
  for (const a of acts) {
    if (!a.text || custIndex.length === 0) continue;
    const hits = N.findCandidates(a.text, custIndex).filter(h => h.score >= 0.85);
    if (!hits.length) continue;
    const best = hits.sort((x, y) => y.score - x.score)[0];
    actCust.set(a.id, best.id);
    await upsertRel(pool, 'action_mentions_customer', 'Action', a.id, 'Customer', best.id,
      best.score, { matchedName: best.displayName, snippet: a.text.slice(0, 80) }, a.tsIso, a.ws);
    mentions++;
  }

  // ── 액션별 매칭 키 추출 (cust / order / doc) ──
  const keyIndex = new Map(); // key → [{id,u,ts,tsIso}]
  const addKey = (key, a) => { if (!keyIndex.has(key)) keyIndex.set(key, []); keyIndex.get(key).push(a); };
  const docRe = /([\w가-힣\-]+\.(?:xlsx|xls|hwp|hwpx|pdf|docx|pptx))/i;
  for (const a of acts) {
    if (actCust.has(a.id)) addKey(`cust:${actCust.get(a.id)}`, a);
    const orders = (a.text.match(/\d{5,}/g) || []);
    for (const o of new Set(orders)) addKey(`order:${o}`, a);
    const doc = a.text.match(docRe);
    if (doc) addKey(`doc:${doc[1].toLowerCase()}`, a);
    // 카톡방 = 여러 직원이 공유하는 협업 맥락(같은 거래처/안건) → 사람간 인계 신호
    const room = N.normalizeName(a.room);
    if (room && room.length >= 2) addKey(`room:${room}`, a);
  }

  // ── B. action_handoff: 같은 key, 다른 사람, 시간차 ≤ 윈도우인 인접쌍 ──
  const pairs = new Map(); // `${from}|${to}` → {from,to,fromU,toU,ts,tsIso,keys:Set,gapSec}
  for (const [key, listRaw] of keyIndex) {
    if (listRaw.length < 2) continue;
    const list = listRaw.slice().sort((x, y) => x.ts - y.ts);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a.u === b.u) continue;                       // 같은 사람 연속은 인계 아님
      if (a.ws !== b.ws) continue;                     // 다른 테넌트끼리는 인계 아님(안전장치)
      if ((b.ts - a.ts) > HANDOFF_WINDOW_MS) continue; // 윈도우 초과 컷
      const pid = `${a.id}|${b.id}`;
      if (!pairs.has(pid)) pairs.set(pid, { from: a.id, to: b.id, fromU: a.u, toU: b.u, tsIso: b.tsIso, ws: b.ws, keys: new Set(), gapSec: Math.round((b.ts - a.ts) / 1000) });
      pairs.get(pid).keys.add(key.split(':')[0]); // cust/order/doc
    }
  }
  let handoffs = 0;
  for (const p of pairs.values()) {
    const c = p.keys.size >= 2 ? 1.0 : 0.67;
    await upsertRel(pool, 'action_handoff', 'Action', p.from, 'Action', p.to,
      c, { fromUser: p.fromU, toUser: p.toU, keys: [...p.keys], gapSec: p.gapSec }, p.tsIso, p.ws);
    handoffs++;
  }

  // ── 보너스 C. action_updated_erp: ERP 앱 액션 + 공유 key → ErpOutcome ──
  let erp = 0;
  for (const a of acts) {
    if (!ERP_APPS.has(a.app)) continue;
    let key = null;
    if (actCust.has(a.id)) key = `cust:${actCust.get(a.id)}`;
    else { const o = (a.text.match(/\d{5,}/) || [])[0]; if (o) key = `order:${o}`; }
    if (!key) continue;
    await upsertRel(pool, 'action_updated_erp', 'Action', a.id, 'ErpOutcome', `erp:${a.app}:${key}`,
      a.data.confidence || 0.67, { app: a.app, key }, a.tsIso, a.ws);
    erp++;
  }

  return { mentions, handoffs, erp, actions: acts.length };
}

module.exports = { enrichHandoff, loadCustomerIndex };
