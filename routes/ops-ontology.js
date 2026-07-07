'use strict';
/**
 * ops-ontology.js — 회사 업무 온톨로지 (승격 + 조회)
 * docs/nenova-ontology-spec.md 표준 구현.
 *
 * 원천 증거(events) → 객체(Action=unified_events) + 관계(ops_relation) 로 멱등 승격.
 * audit P0(명세)·P2(evidence publish)·P3(relation store)·P4(ops API)를 충족.
 */

const express = require('express');
const { enrichHandoff } = require('../src/flow-handoff'); // 핸드오프 엔진 (Action 관계 보강)
const { syncKakaoToOntology } = require('../src/kakao-ontology-sync'); // 카톡 구글시트 → 온톨로지 연결
const _fetchKakaoSheetData = require('./process-mining')._fetchKakaoSheetData; // 시트 리더 재사용(재구현 금지)

// ── 관계 저장 테이블 (1급 데이터, audit P3) ──────────────────────────────────
async function ensureOpsTables(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_relation (
      id            TEXT PRIMARY KEY,
      rel_type      TEXT NOT NULL,
      from_type     TEXT NOT NULL,
      from_ref      TEXT NOT NULL,
      to_type       TEXT NOT NULL,
      to_ref        TEXT NOT NULL,
      attrs         JSONB DEFAULT '{}',
      source        TEXT NOT NULL DEFAULT 'orbit',
      confidence    NUMERIC(4,3) DEFAULT 0.34,
      evidence      JSONB DEFAULT '{}',
      ts            TIMESTAMPTZ,
      workspace_id  TEXT DEFAULT 'WS-NENOVA-2026',
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_opsrel_from ON ops_relation(from_ref)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_opsrel_type ON ops_relation(rel_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_opsrel_to   ON ops_relation(to_ref)`);
}

// ── 앱 정규화 (fusion과 동일 규칙) ───────────────────────────────────────────
function normApp(a) {
  a = String(a || '').trim();
  let al = a.toLowerCase();
  al = al.replace(/\s*[-–]\s*(google )?chrome$/, '').replace(/\s*\(카카오톡\)/, '');
  if (al.includes('kakaotalk') || al.includes('카카오톡')) return '카카오톡';
  if (al.includes('kakaowork') || al.includes('카카오워크')) return '카카오워크';
  if (al.includes('ecount')) return 'ECOUNT ERP';
  if (al.includes('nenova erp') || al.includes('구매현황') || al.includes('erp')) return 'nenova ERP';
  if (al === 'nenova') return 'nenova(앱)';
  if (al.includes('excel')) return 'Excel';
  if (al.includes('powerpnt') || al.includes('powerpoint')) return 'PowerPoint';
  if (al.includes('chrome') || al.includes('edge') || al.includes('whale')) return '웹브라우저';
  if (al.includes('explorer')) return '파일탐색기';
  if (al.includes('textinputhost') || al === '' || al === '0' || al === 'unknown' || al === '23') return '기타입력';
  return a.slice(0, 24) || '기타';
}
const SRC_OF = {
  'keyboard.chunk': 'kbd', 'screen.analyzed': 'vision', 'screen.capture': 'screen',
  'mouse.chunk': 'mouse', 'clipboard.change': 'clip', 'file.change': 'file',
  'excel.activity': 'excel', 'purchase.order.detected': 'order', 'order.detected': 'order',
  'phone.call.detected': 'call',
};
const PROMOTE_TYPES = Object.keys(SRC_OF);
const conf = (n) => (n >= 3 ? 1.0 : n === 2 ? 0.67 : 0.34);
// 실제 workspaces.id (T0b — 예전엔 온톨로지 테이블만 별도로 'nenova' 문자열을 썼으나,
// 진짜 로그인/팀 시스템(workspace_members)의 tenant id는 이것. 2번째 회사가 들어오면
// 그 회사도 /api/workspace/create로 자기 workspaces.id를 받고, 아래 wsMap이 자동으로 분리한다.
const DEFAULT_WORKSPACE_ID = 'WS-NENOVA-2026';

// ── 승격: events → Action(unified_events) + ops_relation (멱등) ───────────────
async function promote(pool, hours) {
  const since = new Date(Date.now() - (hours || 24) * 3600 * 1000).toISOString();
  const { rows } = await pool.query(
    `SELECT id, type, user_id, timestamp, data_json FROM events
     WHERE type = ANY($1) AND timestamp >= $2 AND user_id NOT IN ('local','system') AND user_id IS NOT NULL
     ORDER BY user_id, timestamp ASC`,
    [PROMOTE_TYPES, since]
  );
  // 사용자별 실제 워크스페이스(테넌트) — workspace_members 실멤버십에서 도출, 없으면 기본 테넌트
  const { rows: wsRows } = await pool.query(`SELECT user_id, workspace_id FROM workspace_members WHERE status='active'`).catch(() => ({ rows: [] }));
  const wsMap = new Map(wsRows.map(r => [r.user_id, r.workspace_id]));
  // 정규화
  const evs = rows.map(r => {
    let d = {};
    try { d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}); } catch {}
    return {
      eid: r.id, u: r.user_id, t: new Date(r.timestamp).getTime(), src: SRC_OF[r.type] || 'etc',
      // 구버전 데몬은 top-level app 없이 appContext.currentApp에만 앱명을 실음 — 폴백 없으면 전부 '기타입력'으로 뭉개짐
      app: normApp(d.app || (d.appContext && d.appContext.currentApp)), win: (d.windowTitle || '').trim(), inp: (d.inputText || '').trim(),
      clk: d.mouseClicks || 0, va: (d.activity || d.visionActivity || '').trim(),
      vs: (d.screen || d.visionScreen || '').trim(), auto: !!(d.automatable || d.visionAutomatable),
    };
  });
  // 사용자별 시간창 융합 (gap>120s 또는 앱변경 → 새 동작)
  const byU = {};
  for (const e of evs) (byU[e.u] = byU[e.u] || []).push(e);
  const GAP = 120000;
  const actions = [];
  for (const u of Object.keys(byU)) {
    let cur = null;
    for (const e of byU[u]) {
      // vision(screen.analyzed)의 app은 Claude가 화면에서 추론한 표기라 데몬 앱명과 항상 어긋남 —
      // 같은 사람·같은 시간창이면 앱명 불일치여도 같은 동작의 증거로 흡수(아니면 activity가 영원히 별도 액션으로 유실됨)
      const attach = cur && (e.t - cur.end) <= GAP && (cur.app === e.app || e.src === 'vision');
      if (attach) { cur.end = e.t; cur.evs.push(e); }
      else { if (cur) actions.push(cur); cur = { u, app: e.app, start: e.t, end: e.t, evs: [e] }; }
    }
    if (cur) actions.push(cur);
  }

  let nAct = 0, nRel = 0;
  let prevAct = null; // talk_triggered_action: 같은 사용자에서 카톡 동작 직후 업무 동작이면 "대화→작업"
  for (const a of actions) {
    const srcs = [...new Set(a.evs.map(e => e.src))];
    const c = conf(srcs.length);
    const va = (a.evs.find(e => e.va) || {}).va || '';
    const vs = (a.evs.find(e => e.vs) || {}).vs || '';
    const win = (a.evs.find(e => e.win) || {}).win || '';
    const typed = a.evs.reduce((s, e) => s + (e.inp ? e.inp.length : 0), 0);
    const clicks = a.evs.reduce((s, e) => s + (e.clk || 0), 0);
    const auto = a.evs.some(e => e.auto);
    const isKakao = a.app === '카카오톡' || a.app === '카카오워크';
    const room = isKakao && win ? win.slice(0, 60) : '';
    const evIds = a.evs.map(e => e.eid).slice(0, 40);
    const startSec = Math.floor(a.start / 1000);
    const actId = `act:${a.u}:${startSec}`;
    const tsIso = new Date(a.start).toISOString();
    const ws = wsMap.get(a.u) || DEFAULT_WORKSPACE_ID; // 이 사람의 실제 소속 테넌트
    const data = {
      app: a.app, room, activity: va.slice(0, 200), screen: vs.slice(0, 120),
      sources: srcs, verified: c >= 0.67, confidence: c, typedChars: typed, clicks,
      durationSec: Math.round((a.end - a.start) / 1000), n: a.evs.length, auto,
      evidence: { events: evIds },
    };
    // Action 객체 upsert (unified_events, 멱등)
    await pool.query(
      `INSERT INTO unified_events (id, type, source, timestamp, user_id, workspace_id, data, metadata)
       VALUES ($1,'work.action','orbit',$2,$3,$5,$4,'{}')
       ON CONFLICT (id) DO UPDATE SET data=$4, timestamp=$2`,
      [actId, tsIso, a.u, JSON.stringify(data), ws]
    );
    nAct++;

    const rels = [];
    rels.push(['person_performed_action', 'Person', a.u, 'Action', actId, c]);
    rels.push(['action_in_app', 'Action', actId, 'App', a.app, c]);
    if (room) rels.push(['action_in_room', 'Action', actId, 'Room', room, c]);
    if (vs) rels.push(['screen_observed_action', 'Action', actId, 'VisionEvidence', vs.slice(0, 60), c]);
    if (auto) rels.push(['automation_candidate_for_process', 'Action', actId, 'Process', (va || a.app).slice(0, 40), c]);
    // talk_triggered_action: 같은 사용자에서 직전이 카톡 동작이고 현재가 업무앱(카톡 아님)이며 10분 이내면 대화→작업
    if (prevAct && prevAct.u === a.u && prevAct.isKakao && !isKakao && (a.start - prevAct.endMs) < 30 * 60 * 1000) {
      rels.push(['talk_triggered_action', 'Action', prevAct.actId, 'Action', actId, c]);
    }
    for (const [rt, ft, fr, tt, tr, rc] of rels) {
      const rid = `rel:${rt}:${fr}:${tr}`.slice(0, 200);
      await pool.query(
        `INSERT INTO ops_relation (id, rel_type, from_type, from_ref, to_type, to_ref, source, confidence, evidence, ts, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,'orbit',$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET confidence=$7, ts=$9, evidence=$8`,
        [rid, rt, ft, fr, tt, tr, rc, JSON.stringify({ events: evIds }), tsIso, ws]
      );
      nRel++;
    }
    prevAct = { u: a.u, isKakao, actId, endMs: a.end };
  }
  return { actions: nAct, relations: nRel, sourceEvents: rows.length, windowHours: hours || 24 };
}

// ── 자동 cron: 주기적으로 최근 구간을 멱등 승격 (온톨로지 상시 최신) ──────────────
let _cronTimer = null;
function startPromoteCron(getPool, intervalMin = 30, hours = 2) {
  if (_cronTimer) return;
  const run = async () => {
    try {
      const p = getPool && getPool(); if (!p) return;
      await ensureOpsTables(p);
      const r = await promote(p, hours);
      const e = await enrichHandoff(p, hours);
      const k = await syncKakaoToOntology(p, _fetchKakaoSheetData).catch(err => ({ error: err.message, synced: 0 }));
      console.log(`[ops-ontology] promote cron: ${r.actions} actions / ${r.relations} rels (${r.sourceEvents} ev, ${hours}h) + ${e.mentions} mentions / ${e.handoffs} handoffs / ${e.erp} erp + kakao ${k.synced || 0} events/${k.mentions || 0} mentions`);
    } catch (e) { console.warn('[ops-ontology] promote cron 실패:', e.message); }
  };
  _cronTimer = setInterval(run, intervalMin * 60 * 1000);
  setTimeout(run, 60 * 1000); // 부팅 1분 후 첫 실행
}

// ── 라우터 ───────────────────────────────────────────────────────────────────
function createOpsOntologyRouter(deps = {}) {
  const getPool = deps.getPool;
  const resolveAdmin = deps.resolveAdmin || (() => ({ isAdmin: true }));
  // PG 등록 토큰도 인식하는 async 검사(isAdminReqAsync) — resolveAdmin은 SQLite만 봐서 claim-token 토큰을 거부함
  const isAdminReq = deps.isAdminReq || (async (req) => resolveAdmin(req).isAdmin);
  const router = express.Router();
  const pool = () => (getPool ? getPool() : null);
  const tenantOf = (req) => String(req.query.tenant || DEFAULT_WORKSPACE_ID).slice(0, 60); // 테넌트 격리(기본 실제 workspaces.id)

  router.post('/promote', async (req, res) => {
    try {
      if (!(await isAdminReq(req))) return res.status(403).json({ error: 'admin only' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureOpsTables(p);
      const hours = Math.min(parseInt(req.query.hours) || 24, 720);
      const r = await promote(p, hours);
      const e = await enrichHandoff(p, hours); // Action → 거래처/핸드오프/ERP 관계 보강
      const k = await syncKakaoToOntology(p, _fetchKakaoSheetData).catch(err => ({ error: err.message })); // 카톡 시트 연결
      res.json({ ok: true, ...r, ...e, kakao: k });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/stats', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureOpsTables(p);
      const ws = tenantOf(req);
      const [act, rel, gold] = await Promise.all([
        p.query(`SELECT COUNT(*) c, COUNT(*) FILTER (WHERE (data->>'verified')='true') v, COUNT(*) FILTER (WHERE (data->>'auto')='true') a FROM unified_events WHERE type='work.action' AND workspace_id=$1`, [ws]),
        p.query(`SELECT rel_type, COUNT(*) c FROM ops_relation WHERE workspace_id=$1 GROUP BY rel_type ORDER BY c DESC`, [ws]),
        p.query(`SELECT entity_type, COUNT(*) c FROM orbit_entity_golden WHERE workspace_id=$1 GROUP BY entity_type`, [ws]).catch(() => ({ rows: [] })),
      ]);
      res.json({
        ok: true,
        actions: Number(act.rows[0].c), verified: Number(act.rows[0].v), automatable: Number(act.rows[0].a),
        relations: rel.rows.map(r => ({ type: r.rel_type, count: Number(r.c) })),
        goldenEntities: gold.rows.map(r => ({ type: r.entity_type, count: Number(r.c) })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/entities', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const type = req.query.type;
      const params = [tenantOf(req)]; let where = 'workspace_id=$1';
      if (type) { params.push(type); where += ` AND entity_type=$${params.length}`; }
      const { rows } = await p.query(
        `SELECT id, entity_type, display_name, attributes, source_refs, confidence FROM orbit_entity_golden WHERE ${where} ORDER BY confidence DESC LIMIT 500`,
        params
      ).catch(() => ({ rows: [] }));
      res.json({ ok: true, entities: rows, total: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/relations', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureOpsTables(p);
      const params = [tenantOf(req)]; let where = 'workspace_id=$1';
      if (req.query.fromRef) { params.push(req.query.fromRef); where += ` AND from_ref=$${params.length}`; }
      if (req.query.toRef) { params.push(req.query.toRef); where += ` AND to_ref=$${params.length}`; }
      if (req.query.relType) { params.push(req.query.relType); where += ` AND rel_type=$${params.length}`; }
      const limit = Math.min(parseInt(req.query.limit) || 200, 2000);
      params.push(limit);
      const { rows } = await p.query(
        `SELECT id, rel_type, from_type, from_ref, to_type, to_ref, confidence, ts, evidence FROM ops_relation WHERE ${where} ORDER BY ts DESC LIMIT $${params.length}`,
        params
      );
      res.json({ ok: true, relations: rows, total: rows.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // OAG 패킷: 한 Action + 모든 관계 + 증거
  router.get('/actions/:id/context', async (req, res) => {
    try {
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureOpsTables(p);
      const id = req.params.id;
      const ws = tenantOf(req);
      const act = await p.query(`SELECT id, type, user_id, timestamp, data FROM unified_events WHERE id=$1 AND workspace_id=$2`, [id, ws]);
      if (!act.rows.length) return res.status(404).json({ error: 'action not found' });
      const rels = await p.query(`SELECT rel_type, from_type, from_ref, to_type, to_ref, confidence FROM ops_relation WHERE (from_ref=$1 OR to_ref=$1) AND workspace_id=$2`, [id, ws]);
      res.json({ ok: true, action: act.rows[0], relations: rels.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createOpsOntologyRouter;
module.exports.ensureOpsTables = ensureOpsTables;
module.exports.promote = promote;
module.exports.startPromoteCron = startPromoteCron;
