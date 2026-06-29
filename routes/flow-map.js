'use strict';
/**
 * flow-map.js — 업무 흐름 청사진 API (옵시디언 그래프 뷰 백엔드)
 * ─────────────────────────────────────────────────────────────────────────────
 * unified_events(work.action) + ops_relation + orbit_entity_golden 을 읽어
 * 줌 3단 그래프({nodes,edges})를 반환. 새 수집/저장 없음(읽기 전용 조립).
 *
 *   GET /api/flow/company                  — 회사 별자리(사람·거래처 + 핸드오프/거래처 흐름)
 *   GET /api/flow/employee?userId=&hours=   — 한 직원의 시간순 액션 흐름
 *   GET /api/flow/workunit?customer=&order= — 업무단위 라이프사이클(사람 가로지르는 체인)
 *
 * 인증: intelligence-golden 패턴(헤더 Bearer 또는 ?token= === MASTER_TOKEN).
 * node={id,kind,label,confidence,auto,actionId?,userId?,count?,meta}
 * edge={from,to,kind,confidence,label?,count?}
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

const MASTER_TOKEN = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';

function tryObj(x) { if (!x) return {}; if (typeof x === 'object') return x; try { return JSON.parse(x); } catch { return {}; } }
function userOfAct(actId) { const p = String(actId || '').split(':'); return p[1] || ''; } // act:{userId}:{sec}

function createFlowMapRouter(deps = {}) {
  const getPool = deps.getPool;
  const isAdminToken = deps.isAdminToken || (() => false);
  const router = express.Router();
  const pool = () => (getPool ? getPool() : null);

  function auth(req) {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || req.query.token || '';
    return raw === MASTER_TOKEN || isAdminToken(raw);
  }

  // 골든 person userId→{label,conf} 맵
  async function personMap(p) {
    const { rows } = await p.query(`SELECT display_name, attributes, confidence FROM orbit_entity_golden WHERE entity_type='person'`);
    const m = new Map();
    for (const r of rows) {
      const a = tryObj(r.attributes);
      const uid = a.user_id || a.orbitUserId || a.userId;
      if (uid) m.set(uid, { label: r.display_name || uid, confidence: Number(r.confidence) || 0.34 });
    }
    return m;
  }
  async function customerMap(p) {
    const { rows } = await p.query(`SELECT id, display_name, confidence FROM orbit_entity_golden WHERE entity_type='customer'`);
    const m = new Map();
    for (const r of rows) m.set(r.id, { label: r.display_name || r.id, confidence: Number(r.confidence) || 0.34 });
    return m;
  }

  // ── 회사 별자리 ─────────────────────────────────────────────────────────────
  router.get('/company', async (req, res) => {
    try {
      if (!auth(req)) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const [persons, customers, actCount, mentions, handoffs] = await Promise.all([
        personMap(p),
        customerMap(p),
        p.query(`SELECT user_id, COUNT(*) c FROM unified_events WHERE type='work.action' GROUP BY user_id`),
        p.query(`SELECT from_ref, to_ref FROM ops_relation WHERE rel_type='action_mentions_customer'`),
        p.query(`SELECT from_ref, to_ref, confidence FROM ops_relation WHERE rel_type='action_handoff'`),
      ]);
      const cnt = new Map(actCount.rows.map(r => [r.user_id, Number(r.c)]));
      const nodes = [], edges = [];
      const seen = new Set();
      const addPerson = (uid) => {
        if (!uid || seen.has('p:' + uid)) return; seen.add('p:' + uid);
        const pm = persons.get(uid);
        nodes.push({ id: 'person:' + uid, kind: 'employee', label: pm ? pm.label : uid, userId: uid,
          confidence: pm ? pm.confidence : 0.34, count: cnt.get(uid) || 0 });
      };
      // 활동이 있는 사람만 노드화
      for (const uid of cnt.keys()) if (uid && uid !== 'local' && uid !== 'system') addPerson(uid);

      // 사람 → 거래처 (mentions 롤업)
      const pc = new Map(); // `${uid}|${cid}` → count
      for (const r of mentions.rows) {
        const uid = userOfAct(r.from_ref), cid = r.to_ref;
        if (!uid || !cid) continue;
        pc.set(`${uid}|${cid}`, (pc.get(`${uid}|${cid}`) || 0) + 1);
      }
      const usedCust = new Set();
      for (const [k, c] of pc) {
        const [uid, cid] = k.split('|');
        usedCust.add(cid); addPerson(uid);
        edges.push({ from: 'person:' + uid, to: 'customer:' + cid, kind: 'mentions', count: c, confidence: 0.85 });
      }
      for (const cid of usedCust) {
        if (seen.has('c:' + cid)) continue; seen.add('c:' + cid);
        const cm = customers.get(cid);
        nodes.push({ id: 'customer:' + cid, kind: 'customer', label: cm ? cm.label : cid, confidence: cm ? cm.confidence : 0.34 });
      }

      // 사람 → 사람 (핸드오프 롤업)
      const pp = new Map();
      for (const r of handoffs.rows) {
        const a = userOfAct(r.from_ref), b = userOfAct(r.to_ref);
        if (!a || !b || a === b) continue;
        const k = `${a}|${b}`; const e = pp.get(k) || { count: 0, conf: 0 };
        e.count++; e.conf = Math.max(e.conf, Number(r.confidence) || 0.67); pp.set(k, e);
      }
      for (const [k, e] of pp) {
        const [a, b] = k.split('|'); addPerson(a); addPerson(b);
        edges.push({ from: 'person:' + a, to: 'person:' + b, kind: 'handoff', count: e.count, confidence: e.conf });
      }

      res.json({ ok: true, level: 'company', nodes, edges, stats: { people: nodes.filter(n => n.kind === 'employee').length, customers: usedCust.size, handoffs: pp.size } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 직원 일일 흐름 ──────────────────────────────────────────────────────────
  router.get('/employee', async (req, res) => {
    try {
      if (!auth(req)) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const userId = req.query.userId; if (!userId) return res.status(400).json({ error: 'userId required' });
      const hours = Math.min(parseInt(req.query.hours) || 168, 720);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { rows } = await p.query(
        `SELECT id, timestamp, data FROM unified_events WHERE type='work.action' AND user_id=$1 AND timestamp>=$2 ORDER BY timestamp ASC LIMIT 400`,
        [userId, since]
      );
      const nodes = [], edges = [];
      const actIds = new Set(rows.map(r => r.id));
      let prev = null;
      for (const r of rows) {
        const d = tryObj(r.data);
        nodes.push({ id: r.id, kind: 'action', actionId: r.id, label: (d.activity || d.app || '작업').slice(0, 40),
          confidence: Number(d.confidence) || 0.34, auto: !!d.auto, userId, meta: { app: d.app, room: d.room, ts: r.timestamp } });
        if (prev) edges.push({ from: prev, to: r.id, kind: 'next', confidence: 0.5 });
        prev = r.id;
      }
      // talk_triggered + mentions 보강 (이 직원 액션에 한해)
      const cust = await customerMap(p);
      const rel = await p.query(
        `SELECT rel_type, from_ref, to_ref, confidence FROM ops_relation WHERE rel_type IN ('talk_triggered_action','action_mentions_customer') AND (from_ref = ANY($1) OR to_ref = ANY($1))`,
        [[...actIds]]
      );
      const usedCust = new Set();
      for (const r of rel.rows) {
        if (r.rel_type === 'talk_triggered_action' && actIds.has(r.from_ref) && actIds.has(r.to_ref)) {
          edges.push({ from: r.from_ref, to: r.to_ref, kind: 'triggered', confidence: Number(r.confidence) || 0.67, label: '대화→작업' });
        } else if (r.rel_type === 'action_mentions_customer' && actIds.has(r.from_ref)) {
          usedCust.add(r.to_ref);
          edges.push({ from: r.from_ref, to: 'customer:' + r.to_ref, kind: 'mentions', confidence: Number(r.confidence) || 0.85 });
        }
      }
      for (const cid of usedCust) { const cm = cust.get(cid); nodes.push({ id: 'customer:' + cid, kind: 'customer', label: cm ? cm.label : cid, confidence: cm ? cm.confidence : 0.34 }); }
      res.json({ ok: true, level: 'employee', userId, hours, nodes, edges });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 업무단위 라이프사이클 ────────────────────────────────────────────────────
  router.get('/workunit', async (req, res) => {
    try {
      if (!auth(req)) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      let customer = req.query.customer, order = req.query.order;
      if (!customer && !order) return res.status(400).json({ error: 'customer or order required' });

      // 거래처: 골든 id 또는 이름 → id 해석
      let custId = null;
      if (customer) {
        const c = await p.query(`SELECT id FROM orbit_entity_golden WHERE entity_type='customer' AND (id=$1 OR display_name=$1) LIMIT 1`, [customer]);
        custId = c.rows[0]?.id || customer;
      }
      // 시드 액션 수집
      let seedActs = [];
      if (custId) {
        const r = await p.query(`SELECT from_ref FROM ops_relation WHERE rel_type='action_mentions_customer' AND to_ref=$1`, [custId]);
        seedActs = r.rows.map(x => x.from_ref);
      }
      if (order) {
        const r = await p.query(`SELECT id FROM unified_events WHERE type='work.action' AND (data->>'activity' LIKE $1 OR data->>'screen' LIKE $1) LIMIT 200`, ['%' + order + '%']);
        seedActs = seedActs.concat(r.rows.map(x => x.id));
      }
      seedActs = [...new Set(seedActs)];
      if (!seedActs.length) return res.json({ ok: true, level: 'workunit', key: customer || order, nodes: [], edges: [], note: '시드 액션 없음' });

      // 핸드오프로 체인 확장 (BFS 1~2 hop)
      const chain = new Set(seedActs);
      for (let hop = 0; hop < 2; hop++) {
        const cur = [...chain];
        const r = await p.query(
          `SELECT from_ref, to_ref, confidence FROM ops_relation WHERE rel_type='action_handoff' AND (from_ref = ANY($1) OR to_ref = ANY($1))`,
          [cur]
        );
        for (const x of r.rows) { chain.add(x.from_ref); chain.add(x.to_ref); }
      }
      const ids = [...chain];
      const acts = await p.query(`SELECT id, user_id, timestamp, data FROM unified_events WHERE id = ANY($1) ORDER BY timestamp ASC`, [ids]);
      const persons = await personMap(p);
      const nodes = [], edges = [];
      for (const r of acts.rows) {
        const d = tryObj(r.data); const pm = persons.get(r.user_id);
        nodes.push({ id: r.id, kind: 'action', actionId: r.id, label: (d.activity || d.app || '작업').slice(0, 40),
          confidence: Number(d.confidence) || 0.34, auto: !!d.auto, userId: r.user_id,
          meta: { person: pm ? pm.label : r.user_id, app: d.app, ts: r.timestamp } });
      }
      const rel = await p.query(
        `SELECT rel_type, from_ref, to_ref, confidence FROM ops_relation WHERE rel_type IN ('action_handoff','talk_triggered_action','action_updated_erp') AND from_ref = ANY($1)`,
        [ids]
      );
      const idset = new Set(ids);
      for (const r of rel.rows) {
        if (r.rel_type === 'action_handoff' && idset.has(r.to_ref)) edges.push({ from: r.from_ref, to: r.to_ref, kind: 'handoff', confidence: Number(r.confidence) || 0.67, label: '인계' });
        else if (r.rel_type === 'talk_triggered_action' && idset.has(r.to_ref)) edges.push({ from: r.from_ref, to: r.to_ref, kind: 'triggered', confidence: Number(r.confidence) || 0.67, label: '대화→작업' });
        else if (r.rel_type === 'action_updated_erp') { const eid = 'erp:' + r.to_ref; if (!nodes.find(n => n.id === eid)) nodes.push({ id: eid, kind: 'erp', label: 'ERP 반영', confidence: Number(r.confidence) || 0.67 }); edges.push({ from: r.from_ref, to: eid, kind: 'updated_erp', confidence: Number(r.confidence) || 0.67 }); }
      }
      res.json({ ok: true, level: 'workunit', key: customer || order, nodes, edges });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 직원 드롭다운용: 활동 있는 사람 목록(라벨+userId+건수)
  router.get('/people', async (req, res) => {
    try {
      if (!auth(req)) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const [pm, cnt] = await Promise.all([
        personMap(p),
        p.query(`SELECT user_id, COUNT(*) c, MAX(timestamp) last FROM unified_events WHERE type='work.action' GROUP BY user_id ORDER BY c DESC`),
      ]);
      const people = cnt.rows.filter(r => r.user_id && r.user_id !== 'local' && r.user_id !== 'system')
        .map(r => ({ userId: r.user_id, label: pm.get(r.user_id)?.label || r.user_id, count: Number(r.c), last: r.last }));
      res.json({ ok: true, people });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createFlowMapRouter;
