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

      const toName = (hostname, userId) => hostMap[hostname] || userId || hostname || '?';

      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

      // 타입별 개별 쿼리 (daemon.update 제외 — 창제목 없는 status 이벤트라 오염만 됨)
      const SEL = `SELECT type, user_id, data_json->>'hostname' AS hostname, data_json, timestamp FROM events WHERE timestamp > $1`;
      const [
        { rows: excelRows },
        { rows: fileRows },
        { rows: clipRows },
        { rows: orderRows },
        { rows: aiRows },
        { rows: snapRows },
        { rows: screenRows },
        { rows: kbRows },
        { rows: mouseRows },
      ] = await Promise.all([
        pool.query(`${SEL} AND type = 'excel.activity' ORDER BY timestamp DESC LIMIT 3000`, [since]),
        pool.query(`${SEL} AND type IN ('file.write','file.read','file.change') ORDER BY timestamp DESC LIMIT 2000`, [since]),
        pool.query(`${SEL} AND type = 'clipboard.change' ORDER BY timestamp DESC LIMIT 1000`, [since]),
        pool.query(`${SEL} AND type = 'order.detected' ORDER BY timestamp DESC LIMIT 500`, [since]),
        pool.query(`${SEL} AND type IN ('user.message','assistant.message') ORDER BY timestamp DESC LIMIT 300`, [since]),
        pool.query(`${SEL} AND type = 'daemon.log.snapshot' ORDER BY timestamp DESC LIMIT 1000`, [since]),
        pool.query(`${SEL} AND type IN ('screen.capture','screen.analyzed') ORDER BY timestamp DESC LIMIT 500`, [since]),
        pool.query(`${SEL} AND type = 'keyboard.chunk' ORDER BY timestamp DESC LIMIT 500`, [since]),
        pool.query(`${SEL} AND type = 'mouse.chunk' ORDER BY timestamp DESC LIMIT 500`, [since]),
      ]);

      const parse = r => ({
        ts: r.timestamp,
        user: toName(r.hostname, r.user_id),
        data: typeof r.data_json === 'string' ? JSON.parse(r.data_json) : (r.data_json || {}),
      });

      // ── 엑셀 상세: 파일>시트별 셀값 스트림 ─────────────────────────────
      const excelByFile = {};
      for (const r of excelRows) {
        const ev = parse(r);
        const wb = ev.data.workbook || ev.data.file || '?';
        const sh = ev.data.sheet || ev.data.sheetName || '';
        const key = sh ? `${wb} > ${sh}` : wb;
        if (!excelByFile[key]) excelByFile[key] = { users: new Set(), cells: [] };
        excelByFile[key].users.add(ev.user);
        excelByFile[key].cells.push({
          ts: ev.ts, cell: ev.data.cell, value: ev.data.value,
          formula: ev.data.formula || '', row: ev.data.rowCount,
        });
      }
      const excelFiles = Object.entries(excelByFile)
        .sort((a, b) => b[1].cells.length - a[1].cells.length)
        .slice(0, 20)
        .map(([file, v]) => {
          const uniqueVals = [...new Set(
            v.cells.map(c => c.value).filter(x => x != null && String(x).trim() && String(x) !== '0')
          )].slice(0, 60);
          return {
            file,
            users: [...v.users],
            activity_count: v.cells.length,
            unique_values: uniqueVals,
            recent_cells: v.cells.slice(0, 50),
          };
        });

      // ── 파일 요약 ────────────────────────────────────────────────────────
      const fileSummary = {};
      for (const r of fileRows) {
        const ev = parse(r);
        const path = ev.data.path || ev.data.filePath || ev.data.file || '?';
        if (!fileSummary[path]) fileSummary[path] = { ops: {}, users: new Set(), last: ev.ts };
        fileSummary[path].ops[r.type] = (fileSummary[path].ops[r.type] || 0) + 1;
        fileSummary[path].users.add(ev.user);
      }
      const fileList = Object.entries(fileSummary)
        .sort((a, b) => Object.values(b[1].ops).reduce((s,v)=>s+v,0) - Object.values(a[1].ops).reduce((s,v)=>s+v,0))
        .slice(0, 40)
        .map(([path, v]) => ({ path, ops: v.ops, users: [...v.users], last: v.last }));

      // ── 주문 감지 ────────────────────────────────────────────────────────
      const orders = orderRows.slice(0, 50).map(r => {
        const ev = parse(r);
        return { ts: ev.ts, user: ev.user, ...ev.data };
      });

      // ── AI 대화 ──────────────────────────────────────────────────────────
      const aiMessages = aiRows.slice(0, 80).map(r => {
        const ev = parse(r);
        return {
          ts: ev.ts, user: ev.user, type: r.type,
          message: (ev.data.content || ev.data.text || ev.data.message || '').slice(0, 600),
        };
      });

      // ── 클립보드 (사용자별, 연속 중복 제거) ─────────────────────────────
      const clipByUser = {};
      for (const r of clipRows) {
        const ev = parse(r);
        if (!clipByUser[ev.user]) clipByUser[ev.user] = [];
        const text = (ev.data.text || ev.data.content || '').trim();
        const prev = clipByUser[ev.user].slice(-1)[0]?.text;
        if (text && text !== prev && clipByUser[ev.user].length < 100) {
          clipByUser[ev.user].push({ ts: ev.ts, text: text.slice(0, 400) });
        }
      }

      // ── 창/앱 타임라인 (daemon.log.snapshot 우선, screen.capture 보완) ──
      const windowByUser = {};
      const _addWindow = (ev) => {
        const title = ev.data.activeWindow || ev.data.windowTitle || ev.data.title
                   || ev.data.active_window || ev.data.app || ev.data.process || '';
        const app   = ev.data.app || ev.data.process || ev.data.processName || '';
        if (!windowByUser[ev.user]) windowByUser[ev.user] = [];
        const prev = windowByUser[ev.user].slice(-1)[0];
        if (title && title !== prev?.title && windowByUser[ev.user].length < 300) {
          windowByUser[ev.user].push({ ts: ev.ts, title, app });
        }
      };
      for (const r of [...snapRows].reverse()) _addWindow(parse(r));

      // ── 스크린 캡처 (base64 제외, 메타만) ──────────────────────────────
      const screenByUser = {};
      for (const r of screenRows) {
        const ev = parse(r);
        // base64 이미지 제거 (응답 크기 절감)
        const { imageBase64, ...meta } = ev.data;
        if (!screenByUser[ev.user]) screenByUser[ev.user] = [];
        if (screenByUser[ev.user].length < 100) {
          screenByUser[ev.user].push({ ts: ev.ts, type: r.type, ...meta });
        }
        // 창 타임라인 보완 (snapshot 없는 사용자용)
        if (meta.windowTitle || meta.app) _addWindow(ev);
      }

      // ── 키보드 활동 요약 (사용자별 타임라인) ────────────────────────────
      const kbByUser = {};
      for (const r of kbRows) {
        const ev = parse(r);
        if (!kbByUser[ev.user]) kbByUser[ev.user] = [];
        if (kbByUser[ev.user].length < 100) {
          kbByUser[ev.user].push({
            ts: ev.ts,
            app: ev.data.app || ev.data.appContext?.currentApp || '',
            window: ev.data.windowTitle || ev.data.appContext?.currentWindow || '',
            activityType: ev.data.activityType || '',
            patterns: ev.data.patterns || [],
            metrics: {
              totalChars: ev.data.rawStats?.totalChars || ev.data.metrics?.totalChars || 0,
              wordCount:  ev.data.rawStats?.wordCount  || ev.data.metrics?.wordCount  || 0,
              lineCount:  ev.data.rawStats?.lineCount  || ev.data.metrics?.lineCount  || 0,
            },
            typing: ev.data.typingPatterns || {},
            summary: ev.data.summary || '',
          });
        }
        // 창 타임라인에도 반영
        _addWindow({ ts: ev.ts, user: ev.user, data: {
          windowTitle: ev.data.windowTitle || ev.data.appContext?.currentWindow,
          app: ev.data.app || ev.data.appContext?.currentApp,
        }});
      }

      // ── 마우스 활동 요약 (사용자별) ─────────────────────────────────────
      const mouseByUser = {};
      for (const r of mouseRows) {
        const ev = parse(r);
        if (!mouseByUser[ev.user]) mouseByUser[ev.user] = [];
        if (mouseByUser[ev.user].length < 100) {
          mouseByUser[ev.user].push({
            ts: ev.ts,
            app: ev.data.app || '',
            window: ev.data.windowTitle || '',
            clicks: ev.data.clicks || 0,
            moveDistance: ev.data.moveDistance || 0,
            quadrants: ev.data.quadrants || {},
            clickPositions: (ev.data.clickPositions || []).slice(-20),
            idle: ev.data.idle || false,
          });
        }
      }

      res.json({
        hours,
        event_counts: {
          excel: excelRows.length,
          file: fileRows.length,
          clipboard: clipRows.length,
          order: orderRows.length,
          ai: aiRows.length,
          snapshot: snapRows.length,
          screen_capture: screenRows.length,
          keyboard: kbRows.length,
          mouse: mouseRows.length,
        },
        excel_files: excelFiles,
        files: fileList,
        orders,
        ai_messages: aiMessages,
        clipboard_by_user: clipByUser,
        window_timeline_by_user: windowByUser,
        screen_captures_by_user: screenByUser,
        keyboard_by_user: kbByUser,
        mouse_by_user: mouseByUser,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

module.exports = createGoldenRouter;
