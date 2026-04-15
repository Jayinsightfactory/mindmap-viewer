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

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/projects — 고정작업 제외, 프로젝트/진행 업무만 표시
  //
  // 알고리즘:
  //   고정작업 = 전체 기간 70%+ 날짜에 매일 등장하는 윈도우 (루틴)
  //   프로젝트 = 2일+ 등장하지만 매일은 아닌 것 (진행 중 업무)
  //   신규/일시 = 최근 1일만 등장 (새로 시작했거나 일시)
  // ═══════════════════════════════════════════════════════════════
  router.get('/projects', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = parseInt(req.query.days || '7');

      // 유저별 + 일별 + 윈도우별 카운트
      const result = await db.query(`
        SELECT e.user_id, u.name,
          date_trunc('day', e.timestamp::timestamptz) as day,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as win,
          COUNT(*) as cnt
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type IN ('keyboard.chunk', 'screen.capture')
          AND e.timestamp::timestamptz > NOW() - INTERVAL '${days} days'
          AND COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') IS NOT NULL
          AND LENGTH(COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow')) > 3
          AND e.user_id NOT IN ('MMOLABXL2066516519')
        GROUP BY e.user_id, u.name, day, win
      `);

      // 전체 날짜 수
      const totalDays = new Set(result.rows.map(r => r.day?.toString())).size || 1;

      // 유저별 분류
      const byUser = {};
      for (const r of result.rows) {
        const uid = r.user_id;
        if (!byUser[uid]) byUser[uid] = { name: r.name, windows: {} };
        if (!byUser[uid].windows[r.win]) byUser[uid].windows[r.win] = { days: new Set(), total: 0 };
        byUser[uid].windows[r.win].days.add(r.day?.toString());
        byUser[uid].windows[r.win].total += parseInt(r.cnt);
      }

      // 고정작업 패턴 (필터 대상)
      const routinePatterns = /^(카카오톡|신규 주문 등록|화훼 관리 프로그램|네노바 영업\/현장|네노바 수입\(불량|스티커 메모|알림 센터|User Login)$/;

      const members = [];
      for (const [uid, data] of Object.entries(byUser)) {
        const routine = [];
        const projects = [];
        const newItems = [];

        for (const [win, info] of Object.entries(data.windows)) {
          const daysAppeared = info.days.size;
          const dayRatio = daysAppeared / totalDays;

          // 분류
          if (dayRatio >= 0.7 || routinePatterns.test(win)) {
            routine.push({ window: win, total: info.total, days: daysAppeared, type: 'routine' });
          } else if (daysAppeared >= 2 && info.total >= 8) {
            projects.push({ window: win, total: info.total, days: daysAppeared, type: 'project' });
          } else if (info.total >= 5) {
            // 최근 1일만 등장 = 신규 또는 일시
            const recentDay = [...info.days].sort().pop();
            const isRecent = recentDay && new Date(recentDay) > new Date(Date.now() - 2 * 86400000);
            if (isRecent) {
              newItems.push({ window: win, total: info.total, days: daysAppeared, type: 'new' });
            }
          }
        }

        // 프로젝트 + 신규만 있으면 표시
        if (projects.length > 0 || newItems.length > 0) {
          members.push({
            userId: uid,
            name: data.name || uid.substring(0, 8),
            projects: projects.sort((a, b) => b.total - a.total),
            newItems: newItems.sort((a, b) => b.total - a.total),
            routineFiltered: routine.length,
            routineExamples: routine.slice(0, 3).map(r => r.window),
          });
        }
      }

      res.json({
        analyzedDays: totalDays,
        totalMembers: members.length,
        members: members.sort((a, b) => b.projects.length - a.projects.length),
        algorithm: {
          routine: '전체 기간 70%+ 날짜에 매일 등장 → 필터',
          project: '2일+ 등장, 8회+ 이벤트 → 표시',
          new: '최근 2일 내 첫 등장, 5회+ → 신규 표시',
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/raw-check — 특정 user_id raw 이벤트 직접 조회 (진단용)
  // ?hours=48 (기본 48시간), ?users=uid1,uid2 (기본: 주요 4명)
  // ═══════════════════════════════════════════════════════════════
  router.get('/raw-check', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const hours = Math.min(parseInt(req.query.hours || '48'), 168); // 최대 7일
      const defaultUsers = [
        'MNMRVD11EDCCF6E7CE', // wbk 원빈킴
        'MNMR8568CC8950F81D', // hoon J 현욱
        'MNMSAQJD78E544A631', // 강명훈
        'MNH03H73690BB2CD82', // 이재만 (임재용)
      ];
      const targetUsers = req.query.users
        ? req.query.users.split(',').map(s => s.trim()).filter(Boolean)
        : defaultUsers;

      // 1. user_id별 이벤트 타입 카운트 + 최근 시각
      const countRes = await db.query(`
        SELECT user_id,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE type = 'keyboard.chunk') as keyboard,
          COUNT(*) FILTER (WHERE type = 'mouse.chunk') as mouse,
          COUNT(*) FILTER (WHERE type = 'screen.capture') as screen,
          COUNT(*) FILTER (WHERE type = 'idle') as idle,
          COUNT(*) FILTER (WHERE type = 'clipboard.change') as clipboard,
          MIN(timestamp) as first_event,
          MAX(timestamp) as last_event
        FROM events
        WHERE user_id = ANY($1)
          AND timestamp::timestamptz > NOW() - ($2 || ' hours')::INTERVAL
        GROUP BY user_id
      `, [targetUsers, String(hours)]);

      // 2. 각 유저의 최근 이벤트 5개
      const recentRes = await db.query(`
        SELECT user_id, type, timestamp,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow') as window,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp') as app
        FROM events
        WHERE user_id = ANY($1)
          AND timestamp::timestamptz > NOW() - ($2 || ' hours')::INTERVAL
        ORDER BY timestamp DESC
        LIMIT 30
      `, [targetUsers, String(hours)]);

      // 3. 전체 DB에서 해당 user_id의 가장 최근 이벤트 (기간 무관)
      const latestEverRes = await db.query(`
        SELECT DISTINCT ON (user_id) user_id, type, timestamp
        FROM events
        WHERE user_id = ANY($1)
        ORDER BY user_id, timestamp DESC
      `, [targetUsers]);

      const countMap = {};
      for (const r of countRes.rows) countMap[r.user_id] = r;

      const recentMap = {};
      for (const r of recentRes.rows) {
        if (!recentMap[r.user_id]) recentMap[r.user_id] = [];
        if (recentMap[r.user_id].length < 5) recentMap[r.user_id].push(r);
      }

      const latestEverMap = {};
      for (const r of latestEverRes.rows) latestEverMap[r.user_id] = r;

      const names = {
        'MNMRVD11EDCCF6E7CE': 'wbk(원빈킴)',
        'MNMR8568CC8950F81D': 'hoon J(현욱)',
        'MNMSAQJD78E544A631': '강명훈',
        'MNH03H73690BB2CD82': '이재만(임재용)',
      };

      const result = targetUsers.map(uid => {
        const c = countMap[uid];
        const latest = latestEverMap[uid];
        return {
          userId: uid,
          name: names[uid] || uid.substring(0, 8),
          inRange: !!c,
          last_Xhours: c ? {
            total: parseInt(c.total),
            keyboard: parseInt(c.keyboard),
            mouse: parseInt(c.mouse || 0),
            screen: parseInt(c.screen),
            idle: parseInt(c.idle),
            clipboard: parseInt(c.clipboard),
            firstEvent: c.first_event,
            lastEvent: c.last_event,
          } : null,
          latestEver: latest ? { type: latest.type, timestamp: latest.timestamp } : null,
          recentEvents: recentMap[uid] || [],
        };
      });

      res.json({
        checkedAt: new Date().toISOString(),
        rangeHours: hours,
        users: result,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/workday — 특정 날짜 업무시간 상세 분석
  // ?date=2026-04-10 (기본 오늘 KST), ?endHour=17 (기본 17시 KST)
  // ═══════════════════════════════════════════════════════════════
  router.get('/workday', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      // KST 기준 날짜/시간 파라미터
      const now = new Date();
      const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const dateStr = req.query.date || kstNow.toISOString().slice(0, 10);
      const endHour = parseInt(req.query.endHour || '17');
      const startHour = parseInt(req.query.startHour || '8');

      // KST → UTC 변환
      const startUtc = new Date(`${dateStr}T${String(startHour).padStart(2,'0')}:00:00+09:00`).toISOString();
      const endUtc   = new Date(`${dateStr}T${String(endHour).padStart(2,'0')}:00:00+09:00`).toISOString();

      // 1. 유저별 이벤트 타입 카운트
      const countRes = await db.query(`
        SELECT e.user_id, u.name,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE e.type = 'keyboard.chunk') as keyboard,
          COUNT(*) FILTER (WHERE e.type = 'screen.capture') as screen,
          COUNT(*) FILTER (WHERE e.type = 'idle') as idle,
          COUNT(*) FILTER (WHERE e.type = 'clipboard.change') as clipboard,
          COUNT(*) FILTER (WHERE e.type = 'screen.analyzed') as analyzed,
          MIN(e.timestamp) as first_event,
          MAX(e.timestamp) as last_event
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.timestamp::timestamptz >= $1::timestamptz
          AND e.timestamp::timestamptz < $2::timestamptz
          AND e.type NOT IN ('daemon.heartbeat','daemon.update','install.progress')
        GROUP BY e.user_id, u.name
        ORDER BY total DESC
      `, [startUtc, endUtc]);

      // 2. 유저별 windowTitle 상위 20개
      const winRes = await db.query(`
        SELECT e.user_id,
          COALESCE(e.data_json->>'windowTitle', e.data_json->'appContext'->>'currentWindow') as win,
          COUNT(*) as cnt
        FROM events e
        WHERE e.timestamp::timestamptz >= $1::timestamptz
          AND e.timestamp::timestamptz < $2::timestamptz
          AND e.type IN ('keyboard.chunk','screen.capture')
          AND COALESCE(e.data_json->>'windowTitle', e.data_json->'appContext'->>'currentWindow') IS NOT NULL
          AND LENGTH(COALESCE(e.data_json->>'windowTitle', e.data_json->'appContext'->>'currentWindow')) > 1
        GROUP BY e.user_id, win
        ORDER BY e.user_id, cnt DESC
      `, [startUtc, endUtc]);

      // 3. 시간대별 활동 (KST 시간)
      const hourlyRes = await db.query(`
        SELECT e.user_id,
          EXTRACT(HOUR FROM e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul') as kst_hour,
          COUNT(*) FILTER (WHERE e.type = 'keyboard.chunk') as keyboard,
          COUNT(*) FILTER (WHERE e.type = 'screen.capture') as screen
        FROM events e
        WHERE e.timestamp::timestamptz >= $1::timestamptz
          AND e.timestamp::timestamptz < $2::timestamptz
          AND e.type IN ('keyboard.chunk','screen.capture')
        GROUP BY e.user_id, kst_hour
        ORDER BY e.user_id, kst_hour
      `, [startUtc, endUtc]);

      // 4. 클립보드 (주문/복사 내용)
      const clipRes = await db.query(`
        SELECT e.user_id, u.name,
          e.data_json->>'text' as text,
          e.timestamp
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.type = 'clipboard.change'
          AND e.timestamp::timestamptz >= $1::timestamptz
          AND e.timestamp::timestamptz < $2::timestamptz
          AND LENGTH(e.data_json->>'text') > 3
        ORDER BY e.timestamp DESC
        LIMIT 50
      `, [startUtc, endUtc]);

      // 윈도우 맵 구성
      const winMap = {};
      for (const r of winRes.rows) {
        if (!winMap[r.user_id]) winMap[r.user_id] = [];
        winMap[r.user_id].push({ window: r.win, count: parseInt(r.cnt) });
      }

      // 시간대 맵 구성
      const hourMap = {};
      for (const r of hourlyRes.rows) {
        if (!hourMap[r.user_id]) hourMap[r.user_id] = {};
        hourMap[r.user_id][parseInt(r.kst_hour)] = {
          keyboard: parseInt(r.keyboard),
          screen: parseInt(r.screen),
        };
      }

      const members = countRes.rows.map(r => ({
        userId: r.user_id,
        name: r.name || r.user_id.substring(0, 8),
        totals: {
          total: parseInt(r.total),
          keyboard: parseInt(r.keyboard),
          screen: parseInt(r.screen),
          idle: parseInt(r.idle),
          clipboard: parseInt(r.clipboard),
          analyzed: parseInt(r.analyzed),
        },
        firstEvent: r.first_event,
        lastEvent: r.last_event,
        topWindows: (winMap[r.user_id] || []).slice(0, 20),
        hourly: hourMap[r.user_id] || {},
      }));

      res.json({
        date: dateStr,
        rangeKst: `${startHour}:00 ~ ${endHour}:00`,
        startUtc,
        endUtc,
        totalMembers: members.length,
        members,
        clipboardSamples: clipRes.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/learning-data — 학습용 업무 데이터만 추출
  // 진짜 업무 이벤트만 필터링 + 분류 결과 포함
  // ?userId=X&date=2026-04-10&days=7
  // ═══════════════════════════════════════════════════════════════
  router.get('/learning-data', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = Math.min(parseInt(req.query.days) || 7, 30);
      const userId = req.query.userId || null;
      const dateStr = req.query.date || null;

      // 학습에 유효한 이벤트 타입만
      const LEARNING_TYPES = [
        'keyboard.chunk',    // 타이핑 패턴 — 핵심 학습 데이터
        'screen.capture',    // 화면 컨텍스트 (base64 제거됨, 메타만)
        'screen.analyzed',   // Vision 분석 결과
        'clipboard.change',  // 복사/붙여넣기 업무 흐름
        'order.detected',    // 주문 자동 감지
        'purchase.order.detected', // 발주 감지
      ];

      // 노이즈 필터: 이 windowTitle 패턴은 학습 가치 없음
      const NOISE_WINDOWS = [
        '', // 빈 타이틀
      ];

      let query, params;
      if (dateStr) {
        const startUtc = new Date(`${dateStr}T00:00:00+09:00`).toISOString();
        const endUtc = new Date(`${dateStr}T23:59:59+09:00`).toISOString();
        query = `
          SELECT e.id, e.type, e.user_id, u.name, e.timestamp,
            COALESCE(e.data_json->>'windowTitle', e.data_json->'appContext'->>'currentWindow', '') as window_title,
            COALESCE(e.data_json->>'app', e.data_json->'appContext'->>'currentApp', '') as app_name,
            COALESCE(e.data_json->>'rawInput', e.data_json->>'summary', '') as raw_input,
            COALESCE(e.data_json->>'hostname', '') as hostname,
            COALESCE(e.data_json->>'trigger', '') as trigger,
            e.data_json->>'activity' as vision_activity,
            e.data_json->>'screen' as vision_screen,
            e.data_json->>'text' as clip_text
          FROM events e
          LEFT JOIN orbit_auth_users u ON e.user_id = u.id
          WHERE e.type = ANY($1)
            AND e.timestamp::timestamptz >= $2::timestamptz
            AND e.timestamp::timestamptz < $3::timestamptz
            ${userId ? 'AND e.user_id = $4' : ''}
          ORDER BY e.timestamp ASC
        `;
        params = userId ? [LEARNING_TYPES, startUtc, endUtc, userId] : [LEARNING_TYPES, startUtc, endUtc];
      } else {
        query = `
          SELECT e.id, e.type, e.user_id, u.name, e.timestamp,
            COALESCE(e.data_json->>'windowTitle', e.data_json->'appContext'->>'currentWindow', '') as window_title,
            COALESCE(e.data_json->>'app', e.data_json->'appContext'->>'currentApp', '') as app_name,
            COALESCE(e.data_json->>'rawInput', e.data_json->>'summary', '') as raw_input,
            COALESCE(e.data_json->>'hostname', '') as hostname,
            COALESCE(e.data_json->>'trigger', '') as trigger,
            e.data_json->>'activity' as vision_activity,
            e.data_json->>'screen' as vision_screen,
            e.data_json->>'text' as clip_text
          FROM events e
          LEFT JOIN orbit_auth_users u ON e.user_id = u.id
          WHERE e.type = ANY($1)
            AND e.timestamp::timestamptz > NOW() - INTERVAL '${days} days'
            ${userId ? 'AND e.user_id = $2' : ''}
          ORDER BY e.timestamp ASC
        `;
        params = userId ? [LEARNING_TYPES, userId] : [LEARNING_TYPES];
      }

      const { rows } = await db.query(query, params);

      // 업무/비업무 분류 적용
      const classified = rows.map(row => {
        const cls = _classifyForLearning(row);
        return {
          id: row.id,
          type: row.type,
          userId: row.user_id,
          name: row.name,
          timestamp: row.timestamp,
          app: row.app_name,
          window: row.window_title,
          hostname: row.hostname,
          classification: cls,
          // 학습 데이터 필드
          rawInput: row.raw_input || undefined,
          visionActivity: row.vision_activity || undefined,
          visionScreen: row.vision_screen || undefined,
          clipText: row.clip_text || undefined,
        };
      });

      // 업무 데이터만 필터
      const workOnly = classified.filter(e =>
        e.classification.category === '업무' && e.classification.confidence >= 0.6
      );

      // 통계
      const stats = {
        totalEvents: rows.length,
        workEvents: workOnly.length,
        workRate: rows.length > 0 ? Math.round(workOnly.length / rows.length * 100) : 0,
        byUser: {},
        byPurpose: {},
        byApp: {},
        qualityScore: 0,
      };

      for (const e of workOnly) {
        const uid = e.name || e.userId;
        stats.byUser[uid] = (stats.byUser[uid] || 0) + 1;
        stats.byPurpose[e.classification.purpose] = (stats.byPurpose[e.classification.purpose] || 0) + 1;
        stats.byApp[e.classification.app] = (stats.byApp[e.classification.app] || 0) + 1;
      }

      // 품질 점수 (0~100) — 고신뢰 분류 비율 + 다양성 + Vision 활용률
      const highConfidence = workOnly.filter(e => e.classification.confidence >= 0.8).length;
      const visionUsed = workOnly.filter(e => e.visionScreen || e.visionActivity).length;
      const purposeCount = Object.keys(stats.byPurpose).length;
      stats.qualityScore = Math.min(100, Math.round(
        (highConfidence / Math.max(1, workOnly.length)) * 40 +
        (visionUsed / Math.max(1, workOnly.length)) * 30 +
        Math.min(purposeCount / 10, 1) * 30
      ));

      res.json({
        ok: true,
        days,
        date: dateStr || undefined,
        stats,
        // 전체 반환 시 과도한 응답 방지
        events: req.query.full === 'true' ? workOnly : workOnly.slice(0, 200),
        truncated: !req.query.full && workOnly.length > 200,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // GET /api/os/data-quality — PC별 학습 데이터 품질 리포트
  // ═══════════════════════════════════════════════════════════════
  router.get('/data-quality', async (req, res) => {
    try {
      const db = getDb();
      if (!db?.query) return res.json({ error: 'DB not available' });

      const days = Math.min(parseInt(req.query.days) || 7, 30);

      // PC별 이벤트 타입 분포 + 첫/마지막 이벤트
      const { rows: userStats } = await db.query(`
        SELECT e.user_id, u.name,
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE e.type = 'keyboard.chunk') as keyboard,
          COUNT(*) FILTER (WHERE e.type = 'screen.capture') as screen,
          COUNT(*) FILTER (WHERE e.type = 'screen.analyzed') as analyzed,
          COUNT(*) FILTER (WHERE e.type = 'clipboard.change') as clipboard,
          COUNT(*) FILTER (WHERE e.type = 'order.detected') as orders,
          COUNT(DISTINCT DATE(e.timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) as active_days,
          MIN(e.timestamp) as first_event,
          MAX(e.timestamp) as last_event
        FROM events e
        LEFT JOIN orbit_auth_users u ON e.user_id = u.id
        WHERE e.timestamp::timestamptz > NOW() - INTERVAL '${days} days'
          AND e.type IN ('keyboard.chunk','screen.capture','screen.analyzed','clipboard.change','order.detected','purchase.order.detected')
        GROUP BY e.user_id, u.name
        ORDER BY total DESC
      `);

      const users = userStats.map(r => {
        const keyboard = parseInt(r.keyboard);
        const screen = parseInt(r.screen);
        const analyzed = parseInt(r.analyzed);
        const clipboard = parseInt(r.clipboard);
        const total = parseInt(r.total);
        const activeDays = parseInt(r.active_days);

        // 데이터 품질 점수 계산
        let quality = 0;
        // 키보드 데이터 충분성 (일 50건 이상이면 만점)
        quality += Math.min(25, Math.round((keyboard / Math.max(1, activeDays)) / 50 * 25));
        // 화면 캡처 충분성
        quality += Math.min(25, Math.round((screen / Math.max(1, activeDays)) / 30 * 25));
        // Vision 분석 커버율 (screen.analyzed / screen.capture)
        quality += Math.min(25, screen > 0 ? Math.round((analyzed / screen) * 25) : 0);
        // 데이터 연속성 (active_days / total_days)
        quality += Math.min(25, Math.round((activeDays / Math.max(1, days)) * 25));

        return {
          userId: r.user_id,
          name: r.name || r.user_id.substring(0, 8),
          total,
          keyboard,
          screen,
          analyzed,
          clipboard,
          orders: parseInt(r.orders),
          activeDays,
          firstEvent: r.first_event,
          lastEvent: r.last_event,
          qualityScore: Math.min(100, quality),
          issues: [
            keyboard === 0 ? '키보드 데이터 없음' : null,
            screen === 0 ? '화면 캡처 없음' : null,
            analyzed === 0 && screen > 0 ? 'Vision 분석 미작동' : null,
            activeDays < days * 0.5 ? `수집 불연속 (${activeDays}/${days}일)` : null,
          ].filter(Boolean),
        };
      });

      // DB 크기 정보
      const { rows: [dbInfo] } = await db.query(`
        SELECT pg_database_size('railway') as bytes,
          (SELECT COUNT(*) FROM events) as total_events
      `);

      res.json({
        ok: true,
        days,
        dbSizeMB: Math.round(parseInt(dbInfo.bytes) / 1024 / 1024),
        totalEvents: parseInt(dbInfo.total_events),
        users,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[orbit-os] 회사 OS 명령 구조 시작 (/api/os/*)');
  return router;
}

// ═══════════════════════════════════════════════════════════════
// 학습 데이터용 분류 함수 (인라인 — activity-classifier 의존 없이 독립 동작)
// ═══════════════════════════════════════════════════════════════
function _classifyForLearning(row) {
  const app = (row.app_name || '').toLowerCase();
  const win = (row.window_title || '');
  const winLow = win.toLowerCase();

  // 1. nenova ERP — 무조건 업무
  if (app.includes('nenova') || app.includes('네노바') || app.includes('hwahwe') ||
      win.includes('화훼 관리') || win.includes('화훼관리')) {
    return { category: '업무', purpose: _nenovaPurpose(win), app: 'nenova', confidence: 0.95 };
  }

  // 2. Excel — 업무 키워드 매칭
  if (app.includes('excel') || winLow.includes('.xlsx') || winLow.includes('.xls')) {
    const purpose = _excelPurpose(win);
    return { category: '업무', purpose, app: 'excel', confidence: purpose === '문서작업' ? 0.70 : 0.90 };
  }

  // 3. KakaoTalk — 내부방/거래처만 업무
  if (app.includes('kakaotalk') || app.includes('카카오톡') || winLow.includes('카카오톡')) {
    if (win.includes('네노바') || win.includes('nenova')) {
      return { category: '업무', purpose: '내부소통', app: 'kakaotalk', confidence: 0.90 };
    }
    // 업무 관련 키워드
    if (/주문|발주|출고|입고|견적|물량|차감|배송|거래처/.test(win)) {
      return { category: '업무', purpose: '업무소통', app: 'kakaotalk', confidence: 0.80 };
    }
    // 개인 패턴
    if (/♡|♥|❤|사랑|엄마|아빠|친구|동창|가족/.test(win)) {
      return { category: '개인', purpose: '개인대화', app: 'kakaotalk', confidence: 0.90 };
    }
    // 기본: 낮은 신뢰도로 업무 추정 (근무 시간이면)
    return { category: '업무', purpose: '소통', app: 'kakaotalk', confidence: 0.50 };
  }

  // 4. 브라우저
  if (/chrome|firefox|edge|whale|msedge|brave/i.test(app)) {
    // 비업무 패턴 먼저
    if (/youtube|넷플릭스|netflix|tiktok|instagram|facebook|게임|나무위키/i.test(win)) {
      return { category: '기타', purpose: '웹서핑', app: 'browser', confidence: 0.80 };
    }
    // 업무 패턴
    if (/holex|꽃|품종|절화|카네이션|장미|orbit|뱅킹|은행|mail|메일/i.test(win)) {
      return { category: '업무', purpose: '웹업무', app: 'browser', confidence: 0.80 };
    }
    return { category: '업무', purpose: '웹', app: 'browser', confidence: 0.50 };
  }

  // 5. PDF/한글/Word — 업무
  if (/acrobat|pdf|hwp|한글|word/i.test(app) || /\.pdf|\.hwp|\.docx/i.test(win)) {
    return { category: '업무', purpose: '문서확인', app: 'document', confidence: 0.75 };
  }

  // 6. screen.analyzed / order.detected — 항상 업무
  if (row.type === 'screen.analyzed') {
    return { category: '업무', purpose: row.vision_screen || 'vision', app: row.app_name || 'vision', confidence: 0.90 };
  }
  if (row.type === 'order.detected' || row.type === 'purchase.order.detected') {
    return { category: '업무', purpose: '주문감지', app: 'auto', confidence: 0.95 };
  }

  // 7. clipboard — 내용 기반
  if (row.type === 'clipboard.change') {
    const text = row.clip_text || '';
    if (/주문|발주|출고|견적|물량|차감|거래처|배송|품명|수량|단가/.test(text)) {
      return { category: '업무', purpose: '업무복사', app: 'clipboard', confidence: 0.85 };
    }
    return { category: '업무', purpose: '복사', app: 'clipboard', confidence: 0.50 };
  }

  // 8. idle/잠금
  if (app === 'idle' || app === '' || winLow.includes('잠금')) {
    return { category: '기타', purpose: '대기', app: 'system', confidence: 0.95 };
  }

  // 9. 기본
  return { category: '기타', purpose: '미분류', app: app || 'unknown', confidence: 0.30 };
}

function _nenovaPurpose(title) {
  if (/신규.*주문|주문.*등록/.test(title)) return '주문입력';
  if (/주문.*관리/.test(title)) return '주문관리';
  if (/출고/.test(title)) return '출고';
  if (/재고/.test(title)) return '재고';
  if (/거래처/.test(title)) return '거래처';
  if (/발주/.test(title)) return '발주';
  if (/입고/.test(title)) return '입고';
  if (/견적/.test(title)) return '견적';
  if (/피벗|pivot/i.test(title)) return '분석';
  return '전산';
}

function _excelPurpose(title) {
  if (/물량/.test(title)) return '물량표';
  if (/차감/.test(title)) return '차감대조';
  if (/발주/.test(title)) return '발주';
  if (/매출/.test(title)) return '매출';
  if (/견적/.test(title)) return '견적';
  if (/출고/.test(title)) return '출고';
  return '문서작업';
}

module.exports = createOrbitOS;
