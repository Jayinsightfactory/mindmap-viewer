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
 * 인증: 마스터/관리자 토큰(?tenant= 로 대상 회사 지정) 또는 일반 로그인 사용자(Google OAuth) —
 * 로그인 사용자는 workspace_members 소속 회사로 자동 스코프(T1, 2026-07-06).
 * ★멀티테넌트: 모든 조회는 workspace_id(=tenant, 기본 'WS-NENOVA-2026')로 격리.
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

  // T1: 마스터/관리자 토큰은 여전히 전체(?tenant=)로 열람 가능. 일반 로그인 사용자는
  // 실제 workspace_members 소속 회사(=자기 회사)로 강제 스코프(다른 회사 데이터 노출 금지).
  async function auth(req) {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() || req.query.token || '';
    if (!raw) return null;
    if (raw === MASTER_TOKEN || isAdminToken(raw)) {
      return String(req.query.tenant || 'WS-NENOVA-2026').slice(0, 60);
    }
    const { verifyTokenAsync } = require('../src/auth');
    const user = await verifyTokenAsync(raw);
    if (!user) return null;
    const p = pool(); if (!p) return null;
    const { rows } = await p.query(
      `SELECT workspace_id FROM workspace_members WHERE user_id=$1 AND status='active' ORDER BY joined_at ASC LIMIT 1`,
      [user.id]
    );
    if (!rows.length) return 'NO_WORKSPACE'; // 로그인은 됐지만 아직 회사 배정 전 — 401과 구분해 안내
    return rows[0].workspace_id;
  }

  // 골든 person userId→{label,conf} 맵 (테넌트 스코프)
  // 골든에 없는 계정은 orbit_auth_users 이름으로 폴백 — 원시ID(MN...)가 라벨로 새는 것 방지
  async function personMap(p, ws) {
    const [{ rows }, users] = await Promise.all([
      p.query(`SELECT display_name, attributes, confidence FROM orbit_entity_golden WHERE entity_type='person' AND workspace_id=$1`, [ws]),
      p.query(`SELECT id, name, email FROM orbit_auth_users`).catch(() => ({ rows: [] })),
    ]);
    const m = new Map();
    for (const u of users.rows) {
      const nm = u.name || (u.email || '').split('@')[0];
      if (nm) m.set(u.id, { label: nm, confidence: 0.34 });
    }
    for (const r of rows) {
      const a = tryObj(r.attributes);
      const uid = a.user_id || a.orbitUserId || a.userId;
      // 시드 당시 auth에 이름이 없으면 골든 display_name이 원시ID로 굳음(김빛나 사례) — 그 경우 auth 이름 폴백 유지
      const goldenName = (r.display_name && r.display_name !== uid) ? r.display_name : null;
      if (uid) m.set(uid, { label: goldenName || m.get(uid)?.label || uid, confidence: Number(r.confidence) || 0.34 });
    }
    return m;
  }
  async function customerMap(p, ws) {
    const { rows } = await p.query(`SELECT id, display_name, confidence FROM orbit_entity_golden WHERE entity_type='customer' AND workspace_id=$1`, [ws]);
    const m = new Map();
    for (const r of rows) m.set(r.id, { label: r.display_name || r.id, confidence: Number(r.confidence) || 0.34 });
    return m;
  }

  // ── 회사 별자리 ─────────────────────────────────────────────────────────────
  router.get('/company', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const [persons, customers, actCount, mentions, handoffs, kakaoRoomCust] = await Promise.all([
        personMap(p, ws),
        customerMap(p, ws),
        p.query(`SELECT user_id, COUNT(*) c FROM unified_events WHERE type='work.action' AND workspace_id=$1 GROUP BY user_id`, [ws]),
        p.query(`SELECT from_ref, to_ref FROM ops_relation WHERE rel_type='action_mentions_customer' AND workspace_id=$1`, [ws]),
        p.query(`SELECT from_ref, to_ref, confidence FROM ops_relation WHERE rel_type='action_handoff' AND workspace_id=$1`, [ws]),
        // 카톡 이벤트가 같은 KakaoEvent(from_ref)로 방+거래처를 동시에 가리키면 방↔거래처 연결로 집계
        p.query(
          `SELECT room.to_ref AS room, cust.to_ref AS cust_ref, cust.to_type AS cust_type, cust.confidence AS conf
             FROM ops_relation room
             JOIN ops_relation cust ON cust.from_ref = room.from_ref AND cust.rel_type = 'kakao_event_mentions_customer' AND cust.workspace_id = $1
            WHERE room.rel_type = 'kakao_event_in_room' AND room.workspace_id = $1`,
          [ws]
        ),
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
      for (const uid of cnt.keys()) if (uid && uid !== 'local' && uid !== 'system') addPerson(uid);

      const pc = new Map();
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

      // 카톡 방↔거래처 롤업 (담당자 필드가 시트에 없어 사람 노드와는 직접 연결 안 함 — 방/거래처만)
      const rc = new Map(); // `${room}|${custKey}` → {count, conf, label}
      for (const r of kakaoRoomCust.rows) {
        if (!r.room || !r.cust_ref) continue;
        const golden = r.cust_type === 'Customer';
        const custKey = golden ? 'customer:' + r.cust_ref : 'customerName:' + r.cust_ref;
        const k = `${r.room}|${custKey}`;
        const e = rc.get(k) || { count: 0, conf: 0, golden, custRef: r.cust_ref };
        e.count++; e.conf = Math.max(e.conf, Number(r.conf) || 0.5); rc.set(k, e);
      }
      const usedRooms = new Set();
      for (const [k, e] of rc) {
        const [room, custKey] = k.split('|');
        if (!usedRooms.has(room)) { usedRooms.add(room); nodes.push({ id: 'room:' + room, kind: 'room', label: room, confidence: 0.67 }); }
        // dedup 키는 기존 관례(seen='c:'+goldenId)와 동일하게 — action_mentions_customer가 이미 추가한
        // 골든 거래처 노드와 겹치면 중복 노드를 만들지 않고 재사용한다.
        if (!seen.has('c:' + e.custRef)) {
          seen.add('c:' + e.custRef);
          const label = e.golden ? (customers.get(e.custRef)?.label || e.custRef) : e.custRef;
          nodes.push({ id: custKey, kind: 'customer', label, confidence: e.golden ? (customers.get(e.custRef)?.confidence || 0.85) : 0.5 });
        }
        edges.push({ from: 'room:' + room, to: custKey, kind: 'mentions', count: e.count, confidence: e.conf });
      }

      res.json({ ok: true, level: 'company', tenant: ws, nodes, edges, stats: { people: nodes.filter(n => n.kind === 'employee').length, customers: usedCust.size, handoffs: pp.size, kakaoRooms: usedRooms.size } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 직원 일일 흐름 ──────────────────────────────────────────────────────────
  router.get('/employee', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const userId = req.query.userId; if (!userId) return res.status(400).json({ error: 'userId required' });
      const hours = Math.min(parseInt(req.query.hours) || 168, 720);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { rows } = await p.query(
        `SELECT id, timestamp, data FROM unified_events WHERE type='work.action' AND user_id=$1 AND timestamp>=$2 AND workspace_id=$3 ORDER BY timestamp ASC LIMIT 400`,
        [userId, since, ws]
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
      const cust = await customerMap(p, ws);
      const rel = await p.query(
        `SELECT rel_type, from_ref, to_ref, confidence FROM ops_relation WHERE rel_type IN ('talk_triggered_action','action_mentions_customer') AND workspace_id=$2 AND (from_ref = ANY($1) OR to_ref = ANY($1))`,
        [[...actIds], ws]
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
      res.json({ ok: true, level: 'employee', tenant: ws, userId, hours, nodes, edges });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 업무단위 라이프사이클 ────────────────────────────────────────────────────
  router.get('/workunit', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      let customer = req.query.customer, order = req.query.order;
      if (!customer && !order) return res.status(400).json({ error: 'customer or order required' });

      let custId = null;
      if (customer) {
        const c = await p.query(`SELECT id FROM orbit_entity_golden WHERE entity_type='customer' AND (id=$1 OR display_name=$1) AND workspace_id=$2 LIMIT 1`, [customer, ws]);
        custId = c.rows[0]?.id || customer;
      }
      let seedActs = [];
      if (custId) {
        const r = await p.query(`SELECT from_ref FROM ops_relation WHERE rel_type='action_mentions_customer' AND to_ref=$1 AND workspace_id=$2`, [custId, ws]);
        seedActs = r.rows.map(x => x.from_ref);
      }
      if (order) {
        const r = await p.query(`SELECT id FROM unified_events WHERE type='work.action' AND (data->>'activity' LIKE $1 OR data->>'screen' LIKE $1) AND workspace_id=$2 LIMIT 200`, ['%' + order + '%', ws]);
        seedActs = seedActs.concat(r.rows.map(x => x.id));
      }
      seedActs = [...new Set(seedActs)];
      if (!seedActs.length) return res.json({ ok: true, level: 'workunit', tenant: ws, key: customer || order, nodes: [], edges: [], note: '시드 액션 없음' });

      const chain = new Set(seedActs);
      for (let hop = 0; hop < 2; hop++) {
        const cur = [...chain];
        const r = await p.query(
          `SELECT from_ref, to_ref, confidence FROM ops_relation WHERE rel_type='action_handoff' AND workspace_id=$2 AND (from_ref = ANY($1) OR to_ref = ANY($1))`,
          [cur, ws]
        );
        for (const x of r.rows) { chain.add(x.from_ref); chain.add(x.to_ref); }
      }
      const ids = [...chain];
      const acts = await p.query(`SELECT id, user_id, timestamp, data FROM unified_events WHERE id = ANY($1) AND workspace_id=$2 ORDER BY timestamp ASC`, [ids, ws]);
      const persons = await personMap(p, ws);
      const nodes = [], edges = [];
      for (const r of acts.rows) {
        const d = tryObj(r.data); const pm = persons.get(r.user_id);
        nodes.push({ id: r.id, kind: 'action', actionId: r.id, label: (d.activity || d.app || '작업').slice(0, 40),
          confidence: Number(d.confidence) || 0.34, auto: !!d.auto, userId: r.user_id,
          meta: { person: pm ? pm.label : r.user_id, app: d.app, ts: r.timestamp } });
      }
      const rel = await p.query(
        `SELECT rel_type, from_ref, to_ref, confidence FROM ops_relation WHERE rel_type IN ('action_handoff','talk_triggered_action','action_updated_erp') AND workspace_id=$2 AND from_ref = ANY($1)`,
        [ids, ws]
      );
      const idset = new Set(ids);
      for (const r of rel.rows) {
        if (r.rel_type === 'action_handoff' && idset.has(r.to_ref)) edges.push({ from: r.from_ref, to: r.to_ref, kind: 'handoff', confidence: Number(r.confidence) || 0.67, label: '인계' });
        else if (r.rel_type === 'talk_triggered_action' && idset.has(r.to_ref)) edges.push({ from: r.from_ref, to: r.to_ref, kind: 'triggered', confidence: Number(r.confidence) || 0.67, label: '대화→작업' });
        else if (r.rel_type === 'action_updated_erp') { const eid = 'erp:' + r.to_ref; if (!nodes.find(n => n.id === eid)) nodes.push({ id: eid, kind: 'erp', label: 'ERP 반영', confidence: Number(r.confidence) || 0.67 }); edges.push({ from: r.from_ref, to: eid, kind: 'updated_erp', confidence: Number(r.confidence) || 0.67 }); }
      }
      res.json({ ok: true, level: 'workunit', tenant: ws, key: customer || order, nodes, edges });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 직원 드롭다운용: 활동 있는 사람 목록(라벨+userId+건수)
  router.get('/people', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const [pm, cnt] = await Promise.all([
        personMap(p, ws),
        p.query(`SELECT user_id, COUNT(*) c, MAX(timestamp) last FROM unified_events WHERE type='work.action' AND workspace_id=$1 GROUP BY user_id ORDER BY c DESC`, [ws]),
      ]);
      const people = cnt.rows.filter(r => r.user_id && r.user_id !== 'local' && r.user_id !== 'system')
        .map(r => ({ userId: r.user_id, label: pm.get(r.user_id)?.label || r.user_id, count: Number(r.c), last: r.last }));
      res.json({ ok: true, tenant: ws, people });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 직무 프로파일 입력 번들: 한 사람의 "실제 업무"를 매뉴얼 수준으로 재구성할 재료 ──
  // 클릭/입력 통계가 아니라: vision 화면해독 원문(무슨 업무를 봤는지) + 흐름상 위치(누구에게 받아
  // 누구에게 넘기는지) + 담당 거래처/방/ERP 역할. worker --duty가 소비.
  router.get('/duty-input', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const userId = String(req.query.userId || '').slice(0, 60);
      if (!userId) return res.status(400).json({ error: 'userId required' });
      const days = Math.min(parseInt(req.query.days) || 14, 60);
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const persons = await personMap(p, ws);
      const label = persons.get(userId)?.label || userId;
      const actPrefix = `act:${userId}:%`;
      const [visionR, appsR, roomsR, custR, hoOutR, hoInR, kakaoRespR, erpMgrR] = await Promise.all([
        // 1차 근거: 화면해독 원문 — "이 사람이 실제 어떤 업무 화면에서 무엇을 했는지"
        p.query(`SELECT timestamp, data_json FROM events WHERE type='screen.analyzed' AND user_id=$1 AND timestamp>=$2 ORDER BY timestamp DESC LIMIT 200`, [userId, since]),
        p.query(`SELECT data->>'app' app, COUNT(*) c,
                        COALESCE(SUM(NULLIF(data->>'typedChars','')::int),0) typed,
                        COALESCE(SUM(NULLIF(data->>'clicks','')::int),0) clicks,
                        COALESCE(SUM(NULLIF(data->>'durationSec','')::int),0) sec
                   FROM unified_events WHERE type='work.action' AND user_id=$1 AND timestamp>=$2 AND workspace_id=$3
                  GROUP BY 1 ORDER BY c DESC LIMIT 12`, [userId, since, ws]),
        p.query(`SELECT data->>'room' room, COUNT(*) c FROM unified_events
                  WHERE type='work.action' AND user_id=$1 AND timestamp>=$2 AND workspace_id=$3 AND COALESCE(data->>'room','')<>''
                  GROUP BY 1 ORDER BY c DESC LIMIT 10`, [userId, since, ws]),
        p.query(`SELECT to_ref, COUNT(*) c FROM ops_relation
                  WHERE rel_type='action_mentions_customer' AND from_ref LIKE $1 AND ts>=$2 AND workspace_id=$3
                  GROUP BY 1 ORDER BY c DESC LIMIT 15`, [actPrefix, since, ws]),
        p.query(`SELECT to_ref, evidence FROM ops_relation
                  WHERE rel_type='action_handoff' AND from_ref LIKE $1 AND ts>=$2 AND workspace_id=$3 LIMIT 400`, [actPrefix, since, ws]),
        p.query(`SELECT from_ref, evidence FROM ops_relation
                  WHERE rel_type='action_handoff' AND to_ref LIKE $1 AND ts>=$2 AND workspace_id=$3 LIMIT 400`, [actPrefix, since, ws]),
        // 카톡 의사결정 대응자로 등장한 건 (실명 매칭)
        p.query(`SELECT data->>'room_name' room, data->>'issue' issue, data->>'result' result, COUNT(*) c
                   FROM unified_events WHERE type='kakao.decision' AND workspace_id=$2 AND data->>'responder' LIKE $1
                  GROUP BY 1,2,3 ORDER BY MAX(timestamp) DESC LIMIT 20`, ['%' + label.slice(0, 10) + '%', ws]),
        p.query(`SELECT COUNT(*) c FROM unified_events WHERE source='erp-ui' AND data->>'Manager'=$1 AND timestamp>=$2`, [label, since]),
      ]);
      const customers = await customerMap(p, ws);
      // vision 압축: 연속 중복 제거, 상위 80건
      const vision = [];
      let prevA = '';
      for (const r of visionR.rows) {
        let d = {}; try { d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}); } catch {}
        const act = (d.activity || '').slice(0, 160);
        if (!act || act.slice(0, 50) === prevA) continue; prevA = act.slice(0, 50);
        vision.push({ ts: r.timestamp, app: (d.app || '').slice(0, 30), activity: act, automatable: !!d.automatable });
        if (vision.length >= 80) break;
      }
      const hoCount = (rows, refCol) => {
        const m = new Map();
        for (const r of rows) {
          const other = persons.get(userOfAct(r[refCol]))?.label || userOfAct(r[refCol]);
          if (!other || other === label) continue;
          const ev = tryObj(r.evidence);
          const e = m.get(other) || { person: other, count: 0, keys: new Set() };
          e.count++; (ev.keys || []).forEach(k => e.keys.add(k)); m.set(other, e);
        }
        return [...m.values()].map(e => ({ person: e.person, count: e.count, keys: [...e.keys] })).sort((a, b) => b.count - a.count).slice(0, 8);
      };
      res.json({ ok: true, tenant: ws, userId, label, days,
        vision,
        apps: appsR.rows.map(r => ({ app: r.app, units: Number(r.c), typed: Number(r.typed), clicks: Number(r.clicks), min: Math.round(Number(r.sec) / 60) })),
        rooms: roomsR.rows.map(r => ({ room: r.room, units: Number(r.c) })),
        customers: custR.rows.map(r => ({ customer: customers.get(r.to_ref)?.label || r.to_ref, count: Number(r.c) })),
        handsTo: hoCount(hoOutR.rows, 'to_ref'),
        receivesFrom: hoCount(hoInR.rows, 'from_ref'),
        kakaoResponder: kakaoRespR.rows.map(r => ({ room: r.room, issue: r.issue, result: r.result, count: Number(r.c) })),
        erpManagerEvents: Number(erpMgrR.rows[0]?.c || 0),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 에이전트 파이프라인 입력 번들 (worker가 Claude CLI에 먹일 압축 데이터) ──
  router.get('/ops-input', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      const hours = Math.min(parseInt(req.query.hours) || 24, 336);
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      // 이 테넌트 소속 user_id 목록 — events(글로벌 테이블)의 vision을 테넌트 격리해 읽기 위함.
      // 기본 테넌트는 promote()와 동일하게 미배정 계정도 흡수(필터 없음).
      const memberR = await p.query(`SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND status='active'`, [ws]).catch(() => ({ rows: [] }));
      const memberIds = memberR.rows.map(r => r.user_id);
      const isDefaultWs = ws === 'WS-NENOVA-2026';
      const [persons, customers, actsR, handoffsR, talkR, autoR, kakaoR, visionR, erpR] = await Promise.all([
        personMap(p, ws), customerMap(p, ws),
        // ★층화 샘플: 최신순 전체를 잘라먹지 않고 사람별 최근 20건씩 — 한 사람 폭주가 나머지를 밀어내지 않음
        p.query(`SELECT id, user_id, timestamp, data FROM (
                   SELECT id, user_id, timestamp, data,
                          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY timestamp DESC) rn
                     FROM unified_events WHERE type='work.action' AND timestamp>=$1 AND workspace_id=$2
                 ) t WHERE rn <= 20 ORDER BY timestamp DESC`, [since, ws]),
        p.query(`SELECT from_ref, to_ref, confidence, evidence FROM ops_relation WHERE rel_type='action_handoff' AND ts>=$1 AND workspace_id=$2`, [since, ws]),
        p.query(`SELECT COUNT(*) c FROM ops_relation WHERE rel_type='talk_triggered_action' AND ts>=$1 AND workspace_id=$2`, [since, ws]),
        p.query(`SELECT to_ref, COUNT(*) c FROM ops_relation WHERE rel_type='automation_candidate_for_process' AND ts>=$1 AND workspace_id=$2 GROUP BY to_ref ORDER BY c DESC LIMIT 15`, [since, ws]),
        // ★카톡 비즈니스 신호(시트 경유): 거래처·품목·미해결 의사결정 — 숫자가 아니라 내용을 전달
        p.query(`SELECT type, timestamp, data FROM unified_events
                  WHERE type IN ('kakao.business_event','kakao.decision') AND timestamp>=$1 AND workspace_id=$2
                  ORDER BY (CASE WHEN data->>'unresolved'='true' THEN 0 ELSE 1 END), timestamp DESC LIMIT 60`, [since, ws]),
        // ★비전 화면해독: "무엇을 하는 중인지" 원문 — 융합 액션에 실리기 전이라도 직접 전달
        isDefaultWs || memberIds.length
          ? p.query(`SELECT user_id, timestamp, data_json FROM events
                      WHERE type='screen.analyzed' AND timestamp>=$1 ${isDefaultWs ? '' : 'AND user_id = ANY($2)'}
                      ORDER BY timestamp DESC LIMIT 40`, isDefaultWs ? [since] : [since, memberIds])
          : Promise.resolve({ rows: [] }),
        // ★ERP 스냅샷(erp-publisher: erp-ui.order.history 등) — 있으면 교차검증 근거로
        p.query(`SELECT type, timestamp, data FROM unified_events
                  WHERE type LIKE 'erp-ui.%' AND timestamp>=$1 AND workspace_id=$2
                  ORDER BY timestamp DESC LIMIT 20`, [since, ws]),
      ]);
      const actIds = actsR.rows.map(r => r.id);
      const mentions = actIds.length ? await p.query(`SELECT from_ref, to_ref FROM ops_relation WHERE rel_type='action_mentions_customer' AND from_ref = ANY($1) AND workspace_id=$2`, [actIds, ws]) : { rows: [] };
      const actCust = new Map(mentions.rows.map(r => [r.from_ref, customers.get(r.to_ref)?.label || r.to_ref]));
      const units = actsR.rows.map(r => {
        const d = tryObj(r.data);
        return { ts: r.timestamp, person: persons.get(r.user_id)?.label || r.user_id, userId: r.user_id,
          app: d.app, activity: (d.activity || '').slice(0, 120), room: d.room || '', customer: actCust.get(r.id) || '',
          min: Math.round((d.durationSec || 0) / 60), clicks: d.clicks || 0, typed: d.typedChars || 0,
          sources: d.sources || [], confidence: d.confidence, auto: !!d.auto };
      });
      // ★시간대별 타임라인(창 전체): 샘플이 못 담는 하루 흐름을 사람×시간 집계로 보장
      const tlR = await p.query(`SELECT user_id, date_trunc('hour', timestamp::timestamptz) h, COUNT(*) c,
                 COALESCE(SUM(NULLIF(data->>'typedChars','')::int),0) typed,
                 COALESCE(SUM(NULLIF(data->>'clicks','')::int),0) clicks,
                 COUNT(*) FILTER (WHERE (data->>'confidence')::numeric >= 0.67) multi
            FROM unified_events WHERE type='work.action' AND timestamp>=$1 AND workspace_id=$2
           GROUP BY 1, 2 ORDER BY 2 ASC`, [since, ws]);
      const timeline = tlR.rows.map(r => ({ person: persons.get(r.user_id)?.label || r.user_id,
        hourKst: new Date(r.h).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 13),
        units: Number(r.c), typed: Number(r.typed), clicks: Number(r.clicks), multiSource: Number(r.multi) }));
      const loadAll = await p.query(`SELECT user_id, COUNT(*) c, MAX(timestamp) last FROM unified_events WHERE type='work.action' AND timestamp>=$1 AND workspace_id=$2 GROUP BY user_id ORDER BY c DESC`, [since, ws]);
      const loads = loadAll.rows.filter(r => r.user_id !== 'local' && r.user_id !== 'system')
        .map(r => ({ person: persons.get(r.user_id)?.label || r.user_id, userId: r.user_id, units: Number(r.c), last: r.last }));
      // 핸드오프: 라벨쌍으로 집계 + 매칭 근거(keys) 동봉 — "왕복 노이즈" 판단 재료
      const hoAgg = new Map();
      for (const r of handoffsR.rows) {
        const from = persons.get(userOfAct(r.from_ref))?.label || userOfAct(r.from_ref);
        const to = persons.get(userOfAct(r.to_ref))?.label || userOfAct(r.to_ref);
        if (from === to) continue;
        const ev = tryObj(r.evidence);
        const k = `${from}→${to}`;
        const e = hoAgg.get(k) || { from, to, count: 0, keys: new Set() };
        e.count++; (ev.keys || []).forEach(x => e.keys.add(x)); hoAgg.set(k, e);
      }
      const handoffs = [...hoAgg.values()].map(e => ({ from: e.from, to: e.to, count: e.count, keys: [...e.keys] }));
      // 카톡 신호 압축
      const kakao = kakaoR.rows.map(r => {
        const d = tryObj(r.data);
        return { ts: r.timestamp, kind: r.type === 'kakao.decision' ? '의사결정' : d.event_type || '이벤트',
          room: d.room_name || '', customer: d.customer || '', product: d.product || '',
          result: d.result || '', unresolved: !!d.unresolved };
      });
      // 비전 해독 압축 (같은 사람 연속 중복 제거)
      const vision = [];
      let prevKey = '';
      for (const r of visionR.rows) {
        let d = {}; try { d = typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}); } catch {}
        const act = (d.activity || '').slice(0, 140);
        if (!act) continue;
        const key = r.user_id + '|' + act.slice(0, 40);
        if (key === prevKey) continue; prevKey = key;
        vision.push({ ts: r.timestamp, person: persons.get(r.user_id)?.label || r.user_id,
          app: (d.app || '').slice(0, 30), activity: act, automatable: !!d.automatable });
        if (vision.length >= 30) break;
      }
      // ERP 스냅샷 압축 (원형 payload가 커서 앞부분만)
      const erp = erpR.rows.map(r => ({ ts: r.timestamp, type: r.type,
        data: JSON.stringify(tryObj(r.data)).slice(0, 800) }));
      res.json({ ok: true, tenant: ws, windowHours: hours, generatedAtIso: new Date().toISOString(),
        loads, timeline, units, handoffs, kakao, vision, erp,
        talkTriggered: Number(talkR.rows[0].c),
        automationCandidates: autoR.rows.map(r => ({ process: r.to_ref, count: Number(r.c) })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  async function ensureReportTable(p) {
    await p.query(`CREATE TABLE IF NOT EXISTS orbit_ops_report (
      id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      kind TEXT NOT NULL DEFAULT 'ops', source TEXT DEFAULT 'cli-agent', report JSONB NOT NULL )`);
    await p.query(`ALTER TABLE orbit_ops_report ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'WS-NENOVA-2026'`).catch(() => {});
  }
  // worker가 에이전트 산출물(예측·병목·검증·자동화·disagreement)을 저장
  router.post('/ops-report', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureReportTable(p);
      const { kind, report, source } = req.body || {};
      if (!report) return res.status(400).json({ error: 'report required' });
      await p.query(`INSERT INTO orbit_ops_report (workspace_id, kind, source, report) VALUES ($1,$2,$3,$4)`,
        [ws, kind || 'ops', source || 'cli-agent', JSON.stringify(report)]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // 흐름 뷰가 최신 운영 리포트 표시
  router.get('/ops-report', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded', message: '아직 회사에 배정되지 않았습니다. 관리자에게 문의하세요.' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureReportTable(p);
      // ?kind= 지정 시 그 종류의 최신본 (예: kind=duty:MNIAFICB... → 그 사람 직무 프로파일). 기본 'ops'.
      const kind = String(req.query.kind || 'ops').slice(0, 80);
      const { rows } = await p.query(`SELECT ts, kind, source, report FROM orbit_ops_report WHERE workspace_id=$1 AND kind=$2 ORDER BY ts DESC LIMIT 1`, [ws, kind]);
      res.json({ ok: true, latest: rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // 직무 프로파일 목록 (kind='duty:*' 최신본 일람 — 사람별 매뉴얼 인덱스)
  router.get('/duty-profiles', async (req, res) => {
    try {
      const ws = await auth(req);
      if (ws === 'NO_WORKSPACE') return res.status(403).json({ error: 'not_onboarded' });
      if (!ws) return res.status(401).json({ error: 'unauthorized' });
      const p = pool(); if (!p) return res.status(500).json({ error: 'db not available' });
      await ensureReportTable(p);
      const { rows } = await p.query(
        `SELECT DISTINCT ON (kind) kind, ts, report FROM orbit_ops_report
          WHERE workspace_id=$1 AND kind LIKE 'duty:%' ORDER BY kind, ts DESC`, [ws]);
      res.json({ ok: true, profiles: rows.map(r => ({ kind: r.kind, ts: r.ts,
        person: r.report?.person, roleSummary: r.report?.roleSummary, duties: (r.report?.duties || []).length })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createFlowMapRouter;
