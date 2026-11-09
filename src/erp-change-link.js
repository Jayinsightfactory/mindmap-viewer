'use strict';
/**
 * erp-change-link.js — Orbit 업무(nenova.exe 저장 동작) ↔ 실제 전산 변경 대조
 *
 * 승격된 Action 중 nenova 행동순서(data.uia)에 저장·확정·신규·수정·삭제가 있는 것을 골라,
 * 같은 시각(시작-30초 ~ 끝+60초)에 nenova DB 변경 기록(주문 OrderHistory / 출고 ShipmentHistory)이
 * 있었는지 본다. 사람 매칭은 Orbit 사용자 ↔ nenova 계정(ChangeID)을 겹침 횟수로 학습한다.
 *
 * 결과(Action.data.erp):
 *   matched=true  → changeId, rows, kinds, weeks, customers, items, changeTypes, columns
 *   matched=false → reason ('no_change': 저장했는데 전산 변경 없음 / 'not_covered': 대조 대상 아닌 화면)
 * 관계: action_updated_erp (Action → ErpOutcome 'erp:<kind>:<차수>:<거래처>'), person_is_erp_user (Person → ErpUser)
 *
 * 원천: nenovaweb /api/ops/erp-change-log (주문+출고, 시각 범위). 없으면 /api/orders/history(주문만) 페이지 폴백.
 */

const erp = require('./intelligence/adapters/erp-client');

const SAVE_STEP = /^(저장|확정|확정취소|신규|수정|삭제|적용|등록|업로드|분배)$/;
const BEFORE_MS = 30 * 1000, AFTER_MS = 60 * 1000;
const kstMs = (s) => Date.parse(String(s).replace(' ', 'T') + '+09:00');
const kstStr = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');

async function fetchChanges(sinceMs, untilMs) {
  try {
    const r = await erp.get('/api/ops/erp-change-log', { since: kstStr(sinceMs), until: kstStr(untilMs) });
    if (r && r.success && Array.isArray(r.rows)) return r.rows.map(x => ({ ...x, t: kstMs(x.ts) }));
  } catch (e) { if (!/404|not found/i.test(e.message)) throw e; }
  // 폴백: 주문 변경만(최신순 500건 페이지) — 출고 변경은 대조 못 함
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const r = await erp.get('/api/orders/history', { year: String(new Date(untilMs + 9 * 3600e3).getUTCFullYear()), page: String(page) });
    const hs = (r && r.history) || [];
    for (const h of hs) {
      const t = kstMs(h['변경일자']);
      if (t >= sinceMs && t < untilMs) out.push({ kind: 'order', t, ts: h['변경일자'], changeId: h['변경사용자'], week: h['차수'], cust: h['거래처명'], prod: h['품목명'], changeType: h['변경유형'], column: h['변경항목'], before: h['기준값'], after: h['변경값'] });
    }
    const last = hs[hs.length - 1];
    if (!r.hasMore || !last || kstMs(last['변경일자']) < sinceMs) break;
  }
  return out.sort((a, b) => a.t - b.t);
}

// 사람 매칭: 같은 시간창에 여러 계정이 바꿨으면 1/k 로 나눠 센다(동시 작업자 오귀속 방지).
// 점수 2 이상·60% 이상이면 확정, 한 계정은 점수 높은 한 사람에게만.
function learnUserMap(cands, prior = {}) {
  const cnt = {};
  for (const { user, rows } of cands) {
    const ids = [...new Set(rows.map(r => r.changeId).filter(Boolean))];
    for (const id of ids) ((cnt[user] = cnt[user] || {})[id] = (cnt[user][id] || 0) + 1 / ids.length);
  }
  const best = [];
  for (const [u, ids] of Object.entries(cnt)) {
    const tot = Object.values(ids).reduce((s, n) => s + n, 0);
    const [id, n] = Object.entries(ids).sort((a, b) => b[1] - a[1])[0];
    if (n >= 2 && n / tot >= 0.6) best.push([u, id, n]);
  }
  const map = { ...prior }, owner = {};
  for (const [u, id] of Object.entries(prior)) owner[id] = u;
  for (const [u, id, n] of best.sort((a, b) => b[2] - a[2])) {
    if (owner[id] && owner[id] !== u) continue; // 이미 다른 사람 계정
    if (map[u] && map[u] !== id) delete owner[map[u]];
    map[u] = id; owner[id] = u;
  }
  return map;
}

function summarize(rows) {
  const uniq = (k, cap) => [...new Set(rows.map(r => r[k]).filter(v => v != null && v !== ''))].slice(0, cap);
  return { rows: rows.length, kinds: uniq('kind', 2), weeks: uniq('week', 5), customers: uniq('cust', 5), items: uniq('prod', 5), changeTypes: uniq('changeType', 5), columns: uniq('column', 5) };
}

/**
 * @param {import('pg').Pool} pool
 * @param {number} hours 최근 몇 시간의 Action 을 대조할지
 * @param {{dryRun?:boolean, changes?:Array}} opts changes 를 주면 원천 호출 생략(테스트용)
 */
async function linkErpChanges(pool, hours = 2, opts = {}) {
  const until = Date.now(), since = until - hours * 3600e3;
  const { rows: acts } = await pool.query(
    `SELECT id, user_id, workspace_id, timestamp, data FROM unified_events
      WHERE type='work.action' AND data ? 'uia' AND timestamp >= $1 ORDER BY timestamp`, [new Date(since).toISOString()]);
  const targets = acts.map(a => {
    const d = typeof a.data === 'string' ? JSON.parse(a.data) : a.data;
    const start = new Date(a.timestamp).getTime();
    return { a, d, user: a.user_id, start, end: start + (d.durationSec || 0) * 1000, saveLike: (d.uia.saved || 0) > 0 || (d.uia.steps || []).some(s => SAVE_STEP.test(s)) };
  }).filter(x => x.saveLike);
  if (!targets.length) return { targets: 0, matched: 0, users: {} };

  const changes = opts.changes || await fetchChanges(since - BEFORE_MS, until + AFTER_MS);
  const windowRows = (x) => changes.filter(r => r.t >= x.start - BEFORE_MS && r.t <= x.end + AFTER_MS);

  const { rows: priorRows } = await pool.query(`SELECT from_ref, to_ref FROM ops_relation WHERE rel_type='person_is_erp_user'`).catch(() => ({ rows: [] }));
  const prior = Object.fromEntries(priorRows.map(r => [r.from_ref, r.to_ref]));
  const cands = targets.map(x => ({ user: x.user, rows: windowRows(x) }));
  const userMap = learnUserMap(cands, prior);

  const takenIds = new Set(Object.values(userMap));
  let matched = 0; const sample = [];
  for (const x of targets) {
    let rows = windowRows(x);
    const mapped = userMap[x.user];
    if (mapped) rows = rows.filter(r => r.changeId === mapped);
    else {
      // 계정 미확정: 창 안 변경이 한 계정뿐이고 그 계정이 다른 사람 것으로 확정되지 않았을 때만
      const ids = new Set(rows.map(r => r.changeId));
      if (ids.size !== 1 || takenIds.has([...ids][0])) rows = [];
    }
    const erpData = rows.length
      ? { matched: true, changeId: rows[0].changeId, ...summarize(rows) }
      : { matched: false, reason: changes.some(r => r.kind === 'shipment') || /주문/.test(x.d.uia.screen || '') ? 'no_change' : 'not_covered' };
    if (rows.length) matched++;
    if (opts.dryRun) { sample.push({ id: x.a.id, user: x.user, screen: x.d.uia.screen, steps: x.d.uia.steps.slice(0, 8), saved: x.d.uia.saved, erp: erpData }); continue; }
    await pool.query(`UPDATE unified_events SET data = jsonb_set(data::jsonb, '{erp}', $2::jsonb) WHERE id=$1`, [x.a.id, JSON.stringify(erpData)]);
    if (rows.length) {
      const outs = [...new Set(rows.map(r => `erp:${r.kind}:${r.week || ''}:${r.cust || ''}`))].slice(0, 5);
      for (const o of outs) {
        await pool.query(
          `INSERT INTO ops_relation (id, rel_type, from_type, from_ref, to_type, to_ref, source, confidence, evidence, ts, workspace_id)
           VALUES ($1,'action_updated_erp','Action',$2,'ErpOutcome',$3,'erp',1.0,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET evidence=$4, ts=$5`,
          [`rel:action_updated_erp:${x.a.id}:${o}`.slice(0, 200), x.a.id, o.slice(0, 120), JSON.stringify({ rows: rows.length, changeId: rows[0].changeId }), x.a.timestamp, x.a.workspace_id]);
      }
    }
  }
  if (!opts.dryRun) {
    for (const [u, id] of Object.entries(userMap)) {
      if (prior[u] === id) continue;
      await pool.query(
        `INSERT INTO ops_relation (id, rel_type, from_type, from_ref, to_type, to_ref, source, confidence, evidence, ts)
         VALUES ($1,'person_is_erp_user','Person',$2,'ErpUser',$3,'erp',0.9,'{}',NOW())
         ON CONFLICT (id) DO UPDATE SET to_ref=$3, ts=NOW()`, [`rel:person_is_erp_user:${u}`, u, id]);
    }
  }
  return { targets: targets.length, matched, changes: changes.length, users: userMap, ...(opts.dryRun ? { sample } : {}) };
}

module.exports = { linkErpChanges, learnUserMap, summarize, fetchChanges };
