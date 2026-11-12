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
 *   matched=false → reason ('no_change': 저장했는데 전산 변경 없음 / 'no_save': 신규·조회만 하고 저장은 안 함 / 'not_covered': 대조 대상 아닌 화면)
 * 관계: action_updated_erp (Action → ErpOutcome 'erp:<kind>:<차수>:<거래처>'), person_is_erp_user (Person → ErpUser)
 *
 * 원천: nenovaweb /api/ops/erp-change-log (주문+출고, 시각 범위). 없으면 /api/orders/history(주문만) 페이지 폴백.
 */

const erp = require('./intelligence/adapters/erp-client');
const { smartQwertyToHangul } = require('./hangul');

// 키보드 입력(영문 자판 그대로 기록됨)을 한글로 바꿔, 같은 시각 전산 변경의 거래처·품목 이름이 실제로 쳐졌는지 본다.
// 입력 원문은 저장하지 않는다 — 전산에 있는 이름 중 쳐진 것만 남긴다.
const squash = (v) => String(v || '').toLowerCase().replace(/\s+/g, '');
function nameTokens(name) {
  // 괄호 속 메모(중매 번호·박스 표기)와 법인 표기는 빼고, 한글 2자↑·영문 4자↑ 단어만
  const base = String(name || '').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/주식회사|㈜/g, ' ');
  const ko = (base.match(/[가-힣]{2,}/g) || []).filter(t => t.length >= 2);
  const en = (base.match(/[a-zA-Z]{4,}/g) || []).map(t => t.toLowerCase());
  return [...new Set([...ko, ...en])];
}
// typed: 한글변환한 입력 문자열(공백 유지). 이름 전체가 쳐졌거나, 2자↑ 입력 단어가 이름 앞부분(검색어)이면 쳐진 것으로 본다.
function typedHits(rows, typed) {
  if (!typed) return { customers: [], items: [] };
  const flat = squash(typed);
  const words = [...new Set(String(typed).toLowerCase().split(/[\s\t]+/).filter(w => w.length >= 2 && !/^[\d#.,-]+$/.test(w)))];
  const hit = (n) => nameTokens(n).some(t => { const k = squash(t); return flat.includes(k) || words.some(w => k.startsWith(w)); });
  const uniq = (k) => [...new Set(rows.map(r => r[k]).filter(Boolean))];
  return { customers: uniq('cust').filter(hit).slice(0, 5), items: uniq('prod').filter(hit).slice(0, 5) };
}

// nenova 계정 공식 명단(사장님 제공 11/09). Orbit 표시명 기준 — Orbit '아드리아나'=김지니(nenovaIC3), '사장님(owner)'=임재용.
// 계정 대소문자가 DB 마다 달라(nenovaSS4/nenovass4) 비교는 소문자로.
const OFFICIAL_ERP_USER = {
  '김원영': 'nenova1', '강현우': 'nenovass1', '김도준': 'nenovass4', '설연주': 'nenovass2', '임재용': 'nenovass3', '사장님(owner)': 'nenovass3',
  '강명훈': 'nenovams2', '김선희': 'nenovams1', '김원빈': 'nenovaic4', '김지니': 'nenovaic3', '아드리아나': 'nenovaic3', '손하윤': 'nenovaic1',
  '박성수': 'nenovasd7', '송준호': 'nenovasd2', '정재훈': 'nenovasd1', '조현욱': 'nenovasd3',
};
const lc = (v) => String(v || '').toLowerCase();

const SAVE_STEP = /^(저장|확정|확정취소|신규|수정|삭제|적용|등록|업로드|분배)$/;
// 전산 대조 원천(주문·출고·입고 이력)에 흔적이 남지 않는 화면: 품목 기준정보(Product 에 작성자·시각 컬럼 없음)·엑셀 내보내기(파일 저장).
// 저장처럼 보여도 대조 불가 → 'no_change'(헛수고 오인)가 아니라 'not_covered' 로 분류한다.
// 불량/검역 등록: exe 가 Estimate 음수행만 INSERT — Estimate 에는 작성자 컬럼이 없고 EstimateDtm 은 업무일자라 대조 불가(웹 원장 이력 WebSalesDefectDeductionHistory 는 웹 경유분만).
const NO_LOG_SCREEN = /^(엑셀 저장|품목관리|신규 제품 등록|불량\/검역 등록)$/;
const isNoLogScreen = (screen) => NO_LOG_SCREEN.test(String(screen || '').trim());
// 인쇄·견적서 출력 화면: 출력은 데이터를 바꾸지 않는다(앞 단계 저장이 원천에 잡히면 그대로 matched). 못 찾았을 때만 헛수고(no_change)가 아니라 not_covered 로 분류.
const isPrintScreen = (screen) => /^(인쇄|견적서 출력)$/.test(String(screen || '').trim());
// '신규'는 빈 입력창을 여는 버튼일 뿐 저장이 아니다 — 저장 확인 단계(저장·확정·수정·삭제·적용·등록·업로드·분배)나 saved>0 이 있어야 '저장했다'로 본다.
const REAL_SAVE_STEP = /^(저장|확정|확정취소|수정|삭제|적용|등록|업로드|분배)$/;
const hasRealSave = (uia) => ((uia && uia.saved) || 0) > 0 || ((uia && uia.steps) || []).some(s => REAL_SAVE_STEP.test(s));
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
    if (prior[u]) continue; // 공식 명단·기존 확정은 학습으로 덮지 않음
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

  const changes = (opts.changes || await fetchChanges(since - BEFORE_MS, until + AFTER_MS)).map(r => ({ ...r, changeId: lc(r.changeId) }));
  const windowRows = (x) => changes.filter(r => r.t >= x.start - BEFORE_MS && r.t <= x.end + AFTER_MS);

  const { rows: priorRows } = await pool.query(`SELECT from_ref, to_ref FROM ops_relation WHERE rel_type='person_is_erp_user'`).catch(() => ({ rows: [] }));
  const prior = Object.fromEntries(priorRows.map(r => [r.from_ref, lc(r.to_ref)]));
  // 공식 명단이 학습값보다 우선
  const { rows: people } = await pool.query(`SELECT id, name FROM orbit_auth_users WHERE id = ANY($1)`, [[...new Set(targets.map(x => x.user))]]).catch(() => ({ rows: [] }));
  for (const p of people) if (OFFICIAL_ERP_USER[p.name]) prior[p.id] = OFFICIAL_ERP_USER[p.name];
  const cands = targets.map(x => ({ user: x.user, rows: windowRows(x) }));
  const userMap = learnUserMap(cands, prior);

  // 대상자들의 키보드 입력(시각별) — 한 번에 읽어 메모리에서 창별로 자른다
  const kb = {};
  try {
    const { rows: ks } = await pool.query(
      `SELECT user_id, timestamp, data_json->>'inputText' txt FROM events
        WHERE type='keyboard.chunk' AND user_id = ANY($1) AND timestamp >= $2 AND timestamp <= $3 AND coalesce(data_json->>'inputText','') <> ''`,
      [[...new Set(targets.map(x => x.user))], new Date(since - BEFORE_MS).toISOString(), new Date(until + AFTER_MS).toISOString()]);
    for (const k of ks) (kb[k.user_id] = kb[k.user_id] || []).push({ t: Date.parse(k.timestamp), txt: k.txt });
  } catch (e) { /* 키보드 없으면 시각·계정 대조만 */ }
  const typedOf = (x) => {
    const parts = (kb[x.user] || []).filter(k => k.t >= x.start - BEFORE_MS && k.t <= x.end + AFTER_MS).map(k => k.txt);
    if (!parts.length) return '';
    const raw = parts.join(' ');
    let ko = ''; try { ko = smartQwertyToHangul(raw); } catch {}
    return raw + ' ' + ko;
  };
  const takenIds = new Set(Object.values(userMap));
  let matched = 0; const sample = [];
  for (const x of targets) {
    let rows = windowRows(x);
    if (isNoLogScreen(x.d.uia.screen)) rows = []; // 이 화면의 저장은 대조 원천에 없으므로 우연한 시각 일치(타 화면 변경) 오매칭도 막는다
    const mapped = userMap[x.user];
    if (mapped) rows = rows.filter(r => r.changeId === mapped);
    const typed = typedOf(x);
    if (!mapped) {
      // 계정 미확정: 쳐 넣은 거래처·품목과 맞는 계정이 하나면 그 계정, 아니면 창 안 변경이 한 계정뿐일 때만
      const ids = [...new Set(rows.map(r => r.changeId))].filter(id => !takenIds.has(id));
      const byTyped = ids.filter(id => { const h = typedHits(rows.filter(r => r.changeId === id), typed); return h.customers.length || h.items.length; });
      const pick = byTyped.length === 1 ? byTyped[0] : (ids.length === 1 && new Set(rows.map(r => r.changeId)).size === 1 ? ids[0] : null);
      rows = pick ? rows.filter(r => r.changeId === pick) : [];
    }
    const th = typedHits(rows, typed);
    const erpData = rows.length
      ? { matched: true, changeId: rows[0].changeId, ...summarize(rows), typed: { checked: !!typed, customers: th.customers, items: th.items, confirmed: !!(th.customers.length || th.items.length) } }
      : { matched: false, reason: (isNoLogScreen(x.d.uia.screen) || isPrintScreen(x.d.uia.screen)) ? 'not_covered' : !hasRealSave(x.d.uia) ? 'no_save' : changes.some(r => r.kind === 'shipment') || /주문/.test(x.d.uia.screen || '') ? 'no_change' : 'not_covered' };
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

module.exports = { isNoLogScreen, isPrintScreen, hasRealSave, linkErpChanges, learnUserMap, summarize, fetchChanges, OFFICIAL_ERP_USER, typedHits, nameTokens };
