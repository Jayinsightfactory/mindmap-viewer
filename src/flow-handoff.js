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

// 거래처명으로 쓰기엔 너무 일반적인 말(단독 매칭 금지)
const GENERIC_NAMES = new Set(['플라워', '원예', '꽃집', '화원', '유통', '농장', '화훼', '꽃방', '장미', '미정', '수국',
  '추후등록예정', '플라워시스템', '화훼유통', '꽃상사', '꽃도매', '중매', '소재', '꽃소재', '발주', '주문', '거래처',
  'flower', '꽃마을', '꽃동산', '중앙', '본점', '지점', '추가발주',
  '네노바', '주식회사네노바', 'nenova']); // 네노바=자사(모든 화면에 뜸)
// 간판명 앞 시장 위치 접두(북문코벤트 → 코벤트)
const MARKET_PREFIX = /^(남대문|북문|남문|동문|서문|뒷길|2층|1층|3층|대구|엄궁|양주|인천|부산|광주|대전)[-\s]*/;

function cleanSign(s) {
  return String(s || '')
    .replace(/중매\s*\d+/g, ' ')
    .replace(/[☆★♡♥△▲○●◇◆□■※#＋+]/g, ' ')
    .replace(/\([A-Za-z0-9＋+]{1,3}\)|（[A-Za-z0-9＋+]{1,3}）/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .trim();
}
// 한 거래처의 매칭 이름 후보(간판명 전체·위치접두 제거 간판·사업자명·비고 첫 '/' 앞·괄호 속 별칭)
function customerNames(name, aliases) {
  const out = new Set();
  const add = (v) => { const c = cleanSign(v); if (c) out.add(c); };
  for (const raw of [name, ...(aliases || [])]) {
    if (!raw) continue;
    const first = String(raw).split('/')[0]; // 비고 첫 '/' 앞 = 간판명
    add(first);
    const core = cleanSign(first).replace(MARKET_PREFIX, '');
    if (core) add(core);
    for (const m of String(raw).matchAll(/[(（]([^)）]{3,})[)）]/g)) add(m[1]);
  }
  return [...out];
}

// customer 골든 인덱스 (match-customer-fuzzy._loadCustomerIndex 와 동일 로직)
// + master_customers(전산 거래처 전체 — 간판명 name·사업자명 name_alias) 보강.
//   ref: 골든(cust_key=nenova_key) 있으면 골든 id, 없으면 'mc:<nenova_key>' (카톡측도 같은 인덱스라 키 일치).
//   가드: 정규화 2글자 미만·숫자·일반어 제외, 같은 이름이 서로 다른 거래처를 가리키면(모호) 제외.
//   (2글자 이름은 findCandidates 가 0.6점 → 작업 매칭 임계 0.85 미만이라 자동으로 단독 매칭 안 됨)
async function loadCustomerIndex(pool) {
  const { rows } = await pool.query(
    `SELECT id, display_name, attributes FROM orbit_entity_golden WHERE entity_type='customer'`
  );
  const byNorm = new Map(); // norm → entry | null(모호)
  const keyToGolden = new Map();
  const put = (id, displayName, nm) => {
    const norm = N.normalizeName(nm);
    if (!norm || norm.length < 2 || GENERIC_NAMES.has(norm) || /^\d+$/.test(norm)) return;
    if (byNorm.has(norm)) {
      const cur = byNorm.get(norm);
      if (cur && cur.id !== id) byNorm.set(norm, null);
      return;
    }
    byNorm.set(norm, { id, displayName, normName: norm });
  };
  for (const r of rows) {
    const attrs = tryObj(r.attributes);
    if (attrs.cust_key != null) keyToGolden.set(String(attrs.cust_key), r);
    for (const nm of new Set([r.display_name, ...((attrs.aliases) || [])])) put(r.id, r.display_name, nm);
  }
  try {
    const { rows: mc } = await pool.query(`SELECT name, name_alias, nenova_key FROM master_customers WHERE nenova_key IS NOT NULL`);
    mc.sort((a, b) => Number(a.nenova_key) - Number(b.nenova_key));
    const refBySign = new Map(); // 같은 간판명 중복행(재등록) → 한 ref 로 묶음
    for (const m of mc) {
      let aliases = [];
      try { aliases = Array.isArray(m.name_alias) ? m.name_alias : JSON.parse(m.name_alias || '[]'); } catch { aliases = []; }
      const g = keyToGolden.get(String(m.nenova_key));
      const signNorm = N.normalizeName(cleanSign(m.name));
      const id = g ? g.id : (refBySign.get(signNorm) || `mc:${m.nenova_key}`);
      if (signNorm && !refBySign.has(signNorm)) refBySign.set(signNorm, id);
      const disp = g ? g.display_name : String(m.name || '').trim();
      for (const nm of customerNames(m.name, aliases)) put(id, disp, nm);
    }
  } catch (e) { /* master_customers 없으면 골든만 */ }
  return [...byNorm.values()].filter(Boolean);
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
  return [d.activity || '', d.screen || '', d.room || '', d.ctx || ''].join(' ').trim();
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
    const best = hits.sort((x, y) => (y.score - x.score) || ((y.normLen || 0) - (x.normLen || 0)))[0];
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
  // room 키는 같은 톡방에 있으면 성립 — 두 사람이 빠르게 번갈아 대화하면 메시지마다 인접쌍이
  // 생겨 실제론 "협업 신호 1건"인데 수십~수백 건으로 폭증(실측: hoon J↔ᄏᄏ 88/99건).
  // (방,사람쌍)당 쿨다운으로 중복 생성만 억제 — cust/order/doc는 애초에 빈도가 낮아 그대로 둔다.
  const roomPairCooldown = new Map(); // `room:{room}|{정렬된 u쌍}` → 마지막 기록 ts
  const ROOM_PAIR_COOLDOWN_MS = 2 * 3600 * 1000;
  for (const [key, listRaw] of keyIndex) {
    if (listRaw.length < 2) continue;
    const isRoom = key.startsWith('room:');
    const list = listRaw.slice().sort((x, y) => x.ts - y.ts);
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i], b = list[i + 1];
      if (a.u === b.u) continue;                       // 같은 사람 연속은 인계 아님
      if (a.ws !== b.ws) continue;                     // 다른 테넌트끼리는 인계 아님(안전장치)
      if ((b.ts - a.ts) > HANDOFF_WINDOW_MS) continue; // 윈도우 초과 컷
      if (isRoom) {
        const pairKey = `${key}|${[a.u, b.u].sort().join('_')}`;
        const last = roomPairCooldown.get(pairKey);
        if (last && (b.ts - last) < ROOM_PAIR_COOLDOWN_MS) continue;
        roomPairCooldown.set(pairKey, b.ts);
      }
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

module.exports = { enrichHandoff, loadCustomerIndex, actionText, customerNames };
