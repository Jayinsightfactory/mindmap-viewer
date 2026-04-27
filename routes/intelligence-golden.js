'use strict';
/**
 * routes/intelligence-golden.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase E — orbit_entity_golden 기반 Workshop 드릴다운 API.
 *
 * 기존 routes/intelligence.js (events.purposeId 기반 분석)와 분리.
 * Layer 2 골든 레코드를 1급 시민으로 두고 사람×거래처×활동 교차조회.
 *
 * 엔드포인트 (모두 read-only):
 *   GET /stats                       골든 통계
 *   GET /people                      Person 리스트 (confidence DESC)
 *   GET /people/:id                  Person 상세 (활동 + 거래처 + provenance)
 *   GET /customers                   Customer 리스트
 *   GET /customers/:id               Customer 상세 (관여 사람 + 카톡방)
 *   GET /timeline?person_id&customer_id&days=14
 *                                    사람×거래처 시간순 인과 체인 (Layer 4 미리보기)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

function createGoldenRouter(deps) {
  const { getPool, verifyAdmin } = deps;
  const router = express.Router();

  // ── 인증: 외부에서 verifyAdmin 주입 안 되면 MASTER_TOKEN 폴백 ──
  const adminOnly = (req, res, next) => {
    if (typeof verifyAdmin === 'function') return verifyAdmin(req, res, next);
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/, '') || req.query.token;
    if (!t || t !== process.env.MASTER_TOKEN) return res.status(401).json({ error: 'admin only' });
    next();
  };

  // ── 통계 ─────────────────────────────────────────────────────────────────
  router.get('/stats', adminOnly, async (req, res) => {
    try {
      const pool = getPool();
      const [byType, bySrcCount, matchSrc, recent] = await Promise.all([
        pool.query(`
          SELECT entity_type, COUNT(*)::int AS count, AVG(confidence)::numeric(4,3) AS avg_confidence
            FROM orbit_entity_golden GROUP BY entity_type
        `),
        pool.query(`
          SELECT source_count, COUNT(*)::int AS count
            FROM orbit_entity_golden GROUP BY source_count ORDER BY source_count
        `),
        pool.query(`
          SELECT source, COUNT(*)::int AS count FROM orbit_entity_match_log GROUP BY source
        `),
        pool.query(`
          SELECT source, COUNT(*)::int AS count FROM unified_events
           WHERE timestamp > NOW() - INTERVAL '24 hours' GROUP BY source
        `),
      ]);
      res.json({
        by_type: byType.rows,
        by_source_count: bySrcCount.rows,
        match_log_by_source: matchSrc.rows,
        unified_events_24h: recent.rows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── ERP 연결 진단 ─────────────────────────────────────────────────────────
  router.get('/erp-diag', adminOnly, async (req, res) => {
    try {
      const erp = require('../src/intelligence/adapters/erp-client');
      const st = erp.status();
      // 실제 API 응답 구조 확인
      let loginResult = null;
      let sampleData = null;
      try {
        loginResult = 'ok';
        // 3개 엔드포인트 응답 키 모두 확인
        const endpoints = [
          '/api/orders/history',
          '/api/shipment/history',
          '/api/estimate',
        ];
        sampleData = {};
        for (const ep of endpoints) {
          try {
            const raw = await erp.get(ep, { limit: 2 });
            const keys = Object.keys(raw || {});
            const listKey = keys.find(k => Array.isArray(raw[k]));
            const list = listKey ? raw[listKey] : (Array.isArray(raw) ? raw : null);
            sampleData[ep] = {
              topLevelKeys: keys,
              listKey,
              listLength: list ? list.length : null,
              firstRecord: list && list[0] ? list[0] : null,
            };
          } catch (e) {
            sampleData[ep] = { error: e.message };
          }
        }
      } catch (e) {
        loginResult = e.message;
      }
      // unified_events ERP 건수
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS total, MAX(timestamp) AS latest FROM unified_events WHERE source='erp-ui'`
      );
      // ERP distinct user_ids
      const { rows: erpUsers } = await pool.query(
        `SELECT user_id, COUNT(*)::int AS cnt FROM unified_events
          WHERE source='erp-ui' AND user_id IS NOT NULL GROUP BY user_id ORDER BY cnt DESC LIMIT 30`
      );
      res.json({ erp_client: st, login_test: loginResult, sample: sampleData, erp_events: rows[0], erp_user_ids: erpUsers });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Person 리스트 ────────────────────────────────────────────────────────
  router.get('/people', adminOnly, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const { rows } = await getPool().query(`
        SELECT id, display_name, attributes, source_refs, confidence, source_count, updated_at
          FROM orbit_entity_golden
         WHERE entity_type = 'person'
         ORDER BY confidence DESC, display_name ASC
         LIMIT $1
      `, [limit]);
      res.json({ count: rows.length, people: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Person 상세 ──────────────────────────────────────────────────────────
  router.get('/people/:id', adminOnly, async (req, res) => {
    try {
      const pool = getPool();
      const { id } = req.params;
      const days = Math.min(parseInt(req.query.days) || 14, 90);

      const { rows: gRows } = await pool.query(
        `SELECT * FROM orbit_entity_golden WHERE id = $1 AND entity_type = 'person'`, [id]
      );
      if (gRows.length === 0) return res.status(404).json({ error: 'not found' });
      const g = gRows[0];

      const userIdCandidates = [
        g.attributes?.user_id,
        ...(g.source_refs?.['erp-ui'] || []),
      ].filter(Boolean);

      // orbit_pc_links로 추가 hostname 매핑 — orbit 텔레메트리는 user_id 컬럼이
      // 비어있을 수 있어 channel_id/hostname으로 보완 필요
      const orbitHosts = g.source_refs?.orbit || [];

      const { rows: recent } = await pool.query(`
        SELECT id, type, source, timestamp, data, metadata
          FROM unified_events
         WHERE timestamp > NOW() - INTERVAL '1 day' * $1
           AND (
             user_id = ANY($2)
             OR (source = 'orbit' AND metadata->>'channel_id' = ANY($3))
             OR (source = 'orbit' AND metadata->>'hostname' = ANY($3))
           )
         ORDER BY timestamp DESC
         LIMIT 200
      `, [days, userIdCandidates, orbitHosts]);

      const sourceCounts = {}, typeCounts = {};
      for (const r of recent) {
        sourceCounts[r.source] = (sourceCounts[r.source] || 0) + 1;
        typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
      }

      const { rows: cust } = await pool.query(`
        SELECT
          COALESCE(data->>'CustKey', data->>'custKey', data->>'cust_key') AS cust_key,
          COALESCE(data->>'CustName', data->>'custName', data->>'cust_name') AS cust_name,
          COUNT(*)::int AS event_count,
          MAX(timestamp) AS last_seen
        FROM unified_events
        WHERE source = 'erp-ui'
          AND user_id = ANY($1)
          AND (data ? 'CustKey' OR data ? 'custKey' OR data ? 'cust_key')
        GROUP BY 1, 2
        ORDER BY event_count DESC
        LIMIT 30
      `, [userIdCandidates]);

      const { rows: matchLog } = await pool.query(`
        SELECT source, source_ref, match_type, match_score, evidence, matcher_version, created_at
          FROM orbit_entity_match_log
         WHERE golden_id = $1
         ORDER BY created_at DESC
         LIMIT 50
      `, [id]);

      res.json({
        person: g,
        candidates: { user_ids: userIdCandidates, hostnames: orbitHosts },
        activity: {
          recent_count: recent.length,
          source_counts: sourceCounts,
          type_counts: typeCounts,
          recent: recent.slice(0, 50),
        },
        customers: cust,
        match_log: matchLog,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Customer 리스트 ─────────────────────────────────────────────────────
  router.get('/customers', adminOnly, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
      const { rows } = await getPool().query(`
        SELECT id, display_name, attributes, source_refs, confidence, source_count, updated_at
          FROM orbit_entity_golden
         WHERE entity_type = 'customer'
         ORDER BY confidence DESC, display_name ASC
         LIMIT $1
      `, [limit]);
      res.json({ count: rows.length, customers: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Customer 상세 ───────────────────────────────────────────────────────
  router.get('/customers/:id', adminOnly, async (req, res) => {
    try {
      const pool = getPool();
      const { id } = req.params;
      const { rows: gRows } = await pool.query(
        `SELECT * FROM orbit_entity_golden WHERE id = $1 AND entity_type = 'customer'`, [id]
      );
      if (gRows.length === 0) return res.status(404).json({ error: 'not found' });
      const g = gRows[0];
      const custKey = String(g.attributes?.cust_key || '');

      const { rows: people } = await pool.query(`
        SELECT user_id, COUNT(*)::int AS event_count,
               MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen
          FROM unified_events
         WHERE source = 'erp-ui'
           AND (data->>'CustKey' = $1 OR data->>'custKey' = $1 OR data->>'cust_key' = $1)
           AND user_id IS NOT NULL
         GROUP BY user_id ORDER BY event_count DESC LIMIT 20
      `, [custKey]);

      const rooms = (g.source_refs?.['nenova-agent'] || []).map(r => r.replace(/^room:/, ''));

      const { rows: matchLog } = await pool.query(`
        SELECT source, source_ref, match_type, match_score, evidence, matcher_version, created_at
          FROM orbit_entity_match_log
         WHERE golden_id = $1 ORDER BY created_at DESC LIMIT 50
      `, [id]);

      res.json({ customer: g, people_involved: people, kakao_rooms: rooms, match_log: matchLog });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 타임라인 (Phase D 미리보기) ──────────────────────────────────────────
  router.get('/timeline', adminOnly, async (req, res) => {
    try {
      const { person_id, customer_id } = req.query;
      const days = Math.min(parseInt(req.query.days) || 14, 90);
      if (!person_id || !customer_id) return res.status(400).json({ error: 'person_id, customer_id 필수' });

      const pool = getPool();
      const [{ rows: pRows }, { rows: cRows }] = await Promise.all([
        pool.query(`SELECT * FROM orbit_entity_golden WHERE id = $1 AND entity_type = 'person'`, [person_id]),
        pool.query(`SELECT * FROM orbit_entity_golden WHERE id = $1 AND entity_type = 'customer'`, [customer_id]),
      ]);
      if (pRows.length === 0 || cRows.length === 0) return res.status(404).json({ error: 'not found' });
      const person = pRows[0], cust = cRows[0];

      const userIds = [person.attributes?.user_id, ...(person.source_refs?.['erp-ui'] || [])].filter(Boolean);
      const orbitHosts = person.source_refs?.orbit || [];
      const custKey = String(cust.attributes?.cust_key || '');
      const rooms = (cust.source_refs?.['nenova-agent'] || []).map(r => r.replace(/^room:/, ''));

      const { rows: events } = await pool.query(`
        SELECT id, type, source, timestamp, data, metadata
          FROM unified_events
         WHERE timestamp > NOW() - INTERVAL '1 day' * $1
           AND (
             (source = 'erp-ui' AND user_id = ANY($2)
              AND (data->>'CustKey' = $3 OR data->>'custKey' = $3 OR data->>'cust_key' = $3))
             OR (source = 'nenova-agent' AND data->>'room_name' = ANY($4))
             OR (source = 'orbit' AND (
                  user_id = ANY($2)
                  OR metadata->>'channel_id' = ANY($5)
                  OR metadata->>'hostname' = ANY($5)
             ))
           )
         ORDER BY timestamp ASC
         LIMIT 500
      `, [days, userIds, custKey, rooms, orbitHosts]);

      res.json({ person, customer: cust, events_count: events.length, events });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 실업무 데이터: 오늘 파일/엑셀/주문/클립보드 실내용 ─────────────────────
  router.get('/worklog', adminOnly, async (req, res) => {
    try {
      const hours = Math.min(parseInt(req.query.hours) || 24, 72);
      const pool = getPool();

      // PC 링크 (hostname → 이름)
      const { rows: pcLinks } = await pool.query(
        `SELECT l.hostname, u.name, u.email, l.user_id
           FROM orbit_pc_links l
           LEFT JOIN orbit_auth_users u ON u.id = l.user_id`
      );
      const hostMap = {};
      for (const r of pcLinks) hostMap[r.hostname] = r.name || r.email || r.user_id;

      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

      // 실업무 이벤트 (파일/엑셀/주문/클립보드/AI)
      const { rows: events } = await pool.query(`
        SELECT type, user_id,
               data_json->>'hostname' AS hostname,
               data_json,
               timestamp
          FROM events
         WHERE timestamp > $1
           AND type IN (
             'excel.activity','file.write','file.read','file.change',
             'order.detected','clipboard.change',
             'user.message','assistant.message','tool.start','tool.end'
           )
         ORDER BY timestamp DESC
         LIMIT 2000
      `, [since]);

      // 타입별 + 사용자별 그룹핑
      const byType = {};
      for (const e of events) {
        const name = hostMap[e.hostname] || e.user_id || e.hostname || '?';
        const d = typeof e.data_json === 'string' ? JSON.parse(e.data_json) : (e.data_json || {});
        if (!byType[e.type]) byType[e.type] = [];
        byType[e.type].push({ ts: e.timestamp, user: name, data: d });
      }

      // 엑셀 요약: 파일명 + 시트 집계
      const excelSummary = {};
      for (const ev of (byType['excel.activity'] || [])) {
        const key = [ev.data.file || ev.data.fileName || ev.data.workbook || '?',
                     ev.data.sheet || ev.data.sheetName || ''].filter(Boolean).join(' > ');
        if (!excelSummary[key]) excelSummary[key] = { count: 0, users: new Set() };
        excelSummary[key].count++;
        excelSummary[key].users.add(ev.user);
      }
      const excelFiles = Object.entries(excelSummary)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20)
        .map(([file, v]) => ({ file, count: v.count, users: [...v.users] }));

      // 파일 요약
      const fileSummary = {};
      for (const t of ['file.write','file.read','file.change']) {
        for (const ev of (byType[t] || [])) {
          const path = ev.data.path || ev.data.filePath || ev.data.file || '?';
          if (!fileSummary[path]) fileSummary[path] = { ops: {}, users: new Set() };
          fileSummary[path].ops[t] = (fileSummary[path].ops[t] || 0) + 1;
          fileSummary[path].users.add(ev.user);
        }
      }
      const fileList = Object.entries(fileSummary)
        .sort((a, b) => Object.values(b[1].ops).reduce((s,v)=>s+v,0) - Object.values(a[1].ops).reduce((s,v)=>s+v,0))
        .slice(0, 30)
        .map(([path, v]) => ({ path, ops: v.ops, users: [...v.users] }));

      // 주문 감지 요약
      const orders = (byType['order.detected'] || []).slice(0, 50).map(ev => ({
        ts: ev.ts, user: ev.user, ...ev.data,
      }));

      // AI 대화 요약 (user.message만)
      const aiMessages = (byType['user.message'] || []).slice(0, 30).map(ev => ({
        ts: ev.ts, user: ev.user,
        message: (ev.data.content || ev.data.text || ev.data.message || '').slice(0, 200),
      }));

      // 클립보드 샘플 (최근 20건)
      const clips = (byType['clipboard.change'] || []).slice(0, 20).map(ev => ({
        ts: ev.ts, user: ev.user,
        text: (ev.data.text || ev.data.content || ev.data.value || '').slice(0, 150),
      }));

      res.json({
        hours,
        total_events: events.length,
        excel_files: excelFiles,
        files: fileList,
        orders: orders,
        ai_messages: aiMessages,
        clipboard_samples: clips,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createGoldenRouter;
