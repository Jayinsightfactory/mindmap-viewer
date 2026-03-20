'use strict';
/**
 * orbit-os.js — 회사 OS 명령 구조 (팔란티어 스타일)
 *
 * 데이터 → 온톨로지 → 분석 → 액션
 * 한 번의 API 호출로 회사 전체 현황 파악
 */
const express = require('express');

function createOrbitOS({ getDb }) {
  const router = express.Router();

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/status — 회사 전체 실시간 현황 (원콜 대시보드)
  // ═══════════════════════════════════════════════════════════════
  router.get('/status', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const [
        membersRes, ordersRes, issuesRes, visionRes,
        masterRes, dbRes, parsedRes, recentRes
      ] = await Promise.all([
        // 1. 멤버 현황
        db.query(`
          SELECT e.user_id, u.name,
            COUNT(*) FILTER (WHERE e.type IN ('keyboard.chunk','screen.capture') AND e.timestamp::timestamptz > NOW() - INTERVAL '10 minutes') as last_10min,
            COUNT(*) FILTER (WHERE e.type IN ('keyboard.chunk','screen.capture') AND e.timestamp::timestamptz > NOW() - INTERVAL '1 hour') as last_hour,
            COUNT(*) FILTER (WHERE e.type IN ('keyboard.chunk','screen.capture') AND e.timestamp::timestamptz > NOW() - INTERVAL '24 hours') as last_24h,
            MAX(e.timestamp) as last_seen
          FROM events e LEFT JOIN orbit_auth_users u ON e.user_id = u.id
          WHERE e.timestamp::timestamptz > NOW() - INTERVAL '24 hours'
            AND e.type IN ('keyboard.chunk','screen.capture','idle')
          GROUP BY e.user_id, u.name ORDER BY last_10min DESC
        `),
        // 2. 주문 현황 (24h)
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '주문') as order_events,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '차감') as deduction_events,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ~* '발주') as purchase_events,
            COUNT(*) FILTER (WHERE COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') LIKE '%Excel%') as excel_events,
            COUNT(*) FILTER (WHERE type = 'clipboard.change' AND data_json->>'orderFormat' IS NOT NULL) as auto_parsed_clips
          FROM events
          WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours'
            AND type IN ('keyboard.chunk','screen.capture','clipboard.change')
        `),
        // 3. 이슈 카운트
        db.query(`
          SELECT
            COUNT(*) FILTER (WHERE type = 'idle') as idle_total,
            COUNT(*) FILTER (WHERE type = 'bank.security.active') as bank_security,
            COUNT(DISTINCT user_id) FILTER (WHERE type = 'idle' AND timestamp::timestamptz > NOW() - INTERVAL '1 hour') as idle_users_now
          FROM events WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        `),
        // 4. Vision 현황
        db.query(`
          SELECT
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE data_json->>'automatable' = 'true') as automatable
          FROM events WHERE type = 'screen.analyzed' AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        `),
        // 5. 마스터 DB 규모
        db.query(`
          SELECT
            (SELECT COUNT(*) FROM master_products) as products,
            (SELECT COUNT(*) FROM master_products WHERE category != 'unknown') as products_classified,
            (SELECT COUNT(*) FROM master_customers) as customers,
            (SELECT COUNT(*) FROM parsed_orders) as parsed_orders,
            (SELECT COUNT(*) FROM parsed_orders WHERE created_at > NOW() - INTERVAL '24 hours') as parsed_today
        `),
        // 6. DB 건강
        db.query(`
          SELECT pg_database_size('railway') as bytes,
            (SELECT COUNT(*) FROM events) as total_events
        `),
        // 7. parsed_orders 최근
        db.query(`
          SELECT source_type, customer, product, quantity, unit, action, created_at
          FROM parsed_orders ORDER BY created_at DESC LIMIT 10
        `),
        // 8. 최근 활동 요약
        db.query(`
          SELECT user_id,
            COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as current_work
          FROM events
          WHERE type IN ('keyboard.chunk','screen.capture')
            AND timestamp::timestamptz > NOW() - INTERVAL '5 minutes'
          ORDER BY timestamp DESC LIMIT 10
        `),
      ]);

      const members = membersRes.rows.map(r => ({
        id: r.user_id,
        name: r.name || r.user_id.substring(0, 8),
        status: parseInt(r.last_10min) > 0 ? 'online' : parseInt(r.last_hour) > 0 ? 'recent' : 'offline',
        last10min: parseInt(r.last_10min),
        lastHour: parseInt(r.last_hour),
        last24h: parseInt(r.last_24h),
        lastSeen: r.last_seen,
      }));

      const orders = ordersRes.rows[0] || {};
      const issues = issuesRes.rows[0] || {};
      const vision = visionRes.rows[0] || {};
      const master = masterRes.rows[0] || {};
      const dbHealth = dbRes.rows[0] || {};
      const dbMB = Math.round(parseInt(dbHealth.bytes || 0) / 1024 / 1024);

      res.json({
        timestamp: new Date().toISOString(),
        company: {
          name: 'nenova',
          onlineMembers: members.filter(m => m.status === 'online').length,
          totalMembers: members.length,
          members,
        },
        operations: {
          orders: parseInt(orders.order_events) || 0,
          deductions: parseInt(orders.deduction_events) || 0,
          purchases: parseInt(orders.purchase_events) || 0,
          excelWork: parseInt(orders.excel_events) || 0,
          autoParsedClips: parseInt(orders.auto_parsed_clips) || 0,
        },
        automation: {
          visionTotal: parseInt(vision.total) || 0,
          visionAutomatable: parseInt(vision.automatable) || 0,
          automationRate: parseInt(vision.total) > 0 ? Math.round(parseInt(vision.automatable) / parseInt(vision.total) * 100) : 0,
          masterProducts: parseInt(master.products) || 0,
          masterCustomers: parseInt(master.customers) || 0,
          parsedOrdersTotal: parseInt(master.parsed_orders) || 0,
          parsedToday: parseInt(master.parsed_today) || 0,
        },
        issues: {
          idleTotal: parseInt(issues.idle_total) || 0,
          bankSecurity: parseInt(issues.bank_security) || 0,
          idleUsersNow: parseInt(issues.idle_users_now) || 0,
        },
        database: {
          sizeMB: dbMB,
          limitMB: 1024,
          usagePct: Math.round(dbMB / 1024 * 100),
          totalEvents: parseInt(dbHealth.total_events) || 0,
        },
        recentParsedOrders: parsedRes.rows,
        currentWork: recentRes.rows.reduce((acc, r) => {
          if (!acc[r.user_id]) acc[r.user_id] = r.current_work;
          return acc;
        }, {}),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/pulse — 지금 이 순간 (실시간 스냅샷)
  // ═══════════════════════════════════════════════════════════════
  router.get('/pulse', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const result = await db.query(`
        SELECT e.user_id, u.name,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as current_window,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as current_app,
          e.type, e.timestamp
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.timestamp::timestamptz > NOW() - INTERVAL '3 minutes'
          AND e.type IN ('keyboard.chunk', 'screen.capture')
        ORDER BY e.timestamp DESC
      `);

      // 유저별 최신 상태
      const pulse = {};
      for (const r of result.rows) {
        if (!pulse[r.user_id]) {
          pulse[r.user_id] = {
            name: r.name || r.user_id.substring(0, 8),
            currentWindow: r.current_window,
            currentApp: r.current_app,
            lastEvent: r.type,
            lastSeen: r.timestamp,
            eventsLast3min: 0,
          };
        }
        pulse[r.user_id].eventsLast3min++;
      }

      res.json({
        timestamp: new Date().toISOString(),
        activeUsers: Object.keys(pulse).length,
        pulse,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/analyze/customer/:name — 거래처 분석
  // ═══════════════════════════════════════════════════════════════
  router.get('/analyze/customer/:name', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const name = req.params.name;

      const [eventsRes, masterRes, parsedRes, clipRes] = await Promise.all([
        db.query(`
          SELECT user_id, type, COUNT(*) as cnt,
            MIN(timestamp) as first_seen, MAX(timestamp) as last_seen
          FROM events
          WHERE (COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') ILIKE $1
            OR data_json->>'text' ILIKE $1)
            AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
          GROUP BY user_id, type ORDER BY cnt DESC
        `, [`%${name}%`]),
        db.query('SELECT * FROM master_customers WHERE name ILIKE $1', [`%${name}%`]),
        db.query('SELECT * FROM parsed_orders WHERE customer ILIKE $1 ORDER BY created_at DESC LIMIT 20', [`%${name}%`]),
        db.query(`
          SELECT data_json->>'text' as text, timestamp
          FROM events WHERE type = 'clipboard.change'
            AND data_json->>'text' ILIKE $1
            AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
          ORDER BY timestamp DESC LIMIT 10
        `, [`%${name}%`]),
      ]);

      res.json({
        customer: name,
        master: masterRes.rows[0] || null,
        activity: eventsRes.rows,
        parsedOrders: parsedRes.rows,
        clipboardMentions: clipRes.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/analyze/product/:name — 품목 분석
  // ═══════════════════════════════════════════════════════════════
  router.get('/analyze/product/:name', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });
      const name = req.params.name;

      const [masterRes, parsedRes, clipRes] = await Promise.all([
        db.query('SELECT * FROM master_products WHERE name ILIKE $1 OR name_en ILIKE $1', [`%${name}%`]),
        db.query('SELECT * FROM parsed_orders WHERE product ILIKE $1 ORDER BY created_at DESC LIMIT 20', [`%${name}%`]),
        db.query(`
          SELECT data_json->>'text' as text, timestamp, user_id
          FROM events WHERE type = 'clipboard.change'
            AND data_json->>'text' ILIKE $1
            AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
          ORDER BY timestamp DESC LIMIT 10
        `, [`%${name}%`]),
      ]);

      res.json({
        product: name,
        master: masterRes.rows,
        parsedOrders: parsedRes.rows,
        clipboardMentions: clipRes.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/timeline — 오늘 타임라인 (전원)
  // ═══════════════════════════════════════════════════════════════
  router.get('/timeline', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const result = await db.query(`
        SELECT e.user_id, u.name,
          EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as kst_hour,
          COUNT(*) as events,
          COUNT(*) FILTER (WHERE e.type = 'keyboard.chunk') as keyboard,
          COUNT(*) FILTER (WHERE e.type = 'screen.capture') as capture
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type IN ('keyboard.chunk', 'screen.capture')
          AND e.timestamp::timestamptz > NOW() - INTERVAL '24 hours'
        GROUP BY e.user_id, u.name, kst_hour
        ORDER BY e.user_id, kst_hour
      `);

      // 유저별 타임라인
      const timeline = {};
      for (const r of result.rows) {
        const uid = r.name || r.user_id.substring(0, 8);
        if (!timeline[uid]) timeline[uid] = {};
        timeline[uid][parseInt(r.kst_hour)] = {
          events: parseInt(r.events),
          keyboard: parseInt(r.keyboard),
          capture: parseInt(r.capture),
        };
      }

      res.json({ date: new Date().toISOString().split('T')[0], timeline });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[orbit-os] 회사 OS 명령 구조 시작 (/api/os/*)');
  return router;
}

module.exports = createOrbitOS;
