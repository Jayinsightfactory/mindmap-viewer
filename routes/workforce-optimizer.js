'use strict';
const express = require('express');

module.exports = function ({ pool }) {
  const router = express.Router();

  // ── 공통: 유저 이름 조회 ───────────────────────────────────────────────────
  async function getUserNames() {
    try {
      const { rows } = await pool.query('SELECT id, name FROM orbit_auth_users');
      const map = {};
      rows.forEach(r => { map[r.id] = r.name || r.id; });
      return map;
    } catch { return {}; }
  }

  // ── 공통: 기간 파라미터 ────────────────────────────────────────────────────
  function getDays(req) {
    return Math.min(parseInt(req.query.days) || 7, 30);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/workforce/scores — 팀원별 효율·위험도 스코어
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/scores', async (req, res) => {
    const days = getDays(req);
    try {
      const names = await getUserNames();

      const { rows: base } = await pool.query(`
        SELECT
          user_id,
          COUNT(*)                                                              AS total_events,
          COUNT(CASE WHEN type = 'keyboard.chunk'  THEN 1 END)                AS keyboard_events,
          COUNT(CASE WHEN type = 'mouse.click'     THEN 1 END)                AS click_events,
          COUNT(CASE WHEN type = 'app.switch'      THEN 1 END)                AS app_switches,
          COUNT(DISTINCT DATE(timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')) AS active_days,
          MIN(timestamp::timestamptz)                                           AS first_seen,
          MAX(timestamp::timestamptz)                                           AS last_seen
        FROM events
        WHERE timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND user_id NOT LIKE 'local%'
          AND user_id IS NOT NULL
          AND user_id != 'system'
        GROUP BY user_id
        ORDER BY total_events DESC
      `, [days]);

      const { rows: vision } = await pool.query(`
        SELECT
          user_id,
          COUNT(*)                                                                          AS vision_total,
          COUNT(CASE WHEN data_json::jsonb->>'automatable' = 'true' THEN 1 END)            AS automatable_count,
          COUNT(DISTINCT data_json::jsonb->>'app')                                          AS unique_apps,
          (SELECT data_json::jsonb->>'app' FROM events e2
            WHERE e2.user_id = e.user_id AND e2.type = 'screen.analyzed'
              AND e2.timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
            GROUP BY data_json::jsonb->>'app'
            ORDER BY COUNT(*) DESC LIMIT 1)                                                AS top_app
        FROM events e
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND user_id NOT LIKE 'local%'
        GROUP BY user_id
      `, [days]);

      const vMap = {};
      vision.forEach(v => { vMap[v.user_id] = v; });

      const scores = base.map(u => {
        const v = vMap[u.user_id] || { vision_total: 0, automatable_count: 0, unique_apps: 0, top_app: null };
        const totalEv  = parseInt(u.total_events)       || 0;
        const kbEv     = parseInt(u.keyboard_events)    || 0;
        const vTotal   = parseInt(v.vision_total)       || 0;
        const vAuto    = parseInt(v.automatable_count)  || 0;
        const variety  = parseInt(v.unique_apps)        || 1;
        const actDays  = parseInt(u.active_days)        || 1;

        const spanH = u.first_seen && u.last_seen
          ? (new Date(u.last_seen) - new Date(u.first_seen)) / 3_600_000
          : 1;

        const automation_ratio  = vTotal > 0 ? vAuto / vTotal : 0;
        const keyboard_ratio    = totalEv > 0 ? kbEv / totalEv : 0;
        const variety_score     = Math.min(variety / 10, 1);
        const density           = totalEv / Math.max(spanH, 1);

        // 위험도 (0~100, 높을수록 자동화 대체 가능)
        const risk = Math.round(Math.min(
          automation_ratio * 0.45 +
          (1 - Math.min(keyboard_ratio * 2, 1)) * 0.30 +
          (1 - variety_score) * 0.25,
          1
        ) * 100);

        // 효율 점수 (0~100, 높을수록 핵심 인력)
        const efficiency = Math.round(
          (Math.min(density / 50, 1) * 0.40 +
           (1 - risk / 100) * 0.35 +
           (actDays / days) * 0.25) * 100
        );

        let verdict, color;
        if (risk >= 70 && efficiency < 40)      { verdict = '자동화 대체 검토';  color = '#f85149'; }
        else if (risk >= 50)                    { verdict = '부분 자동화 가능'; color = '#d29922'; }
        else if (efficiency >= 70)              { verdict = '핵심 인력';        color = '#3fb950'; }
        else                                    { verdict = '보통';              color = '#8b949e'; }

        return {
          userId: u.user_id,
          name: names[u.user_id] || u.user_id,
          totalEvents: totalEv,
          keyboardEvents: kbEv,
          activeDays: actDays,
          density: Math.round(density * 10) / 10,
          automationRatio: Math.round(automation_ratio * 100),
          keyboardRatio: Math.round(keyboard_ratio * 100),
          appVariety: variety,
          topApp: v.top_app || null,
          risk,
          efficiency,
          verdict,
          color,
          lastSeen: u.last_seen,
        };
      }).sort((a, b) => b.risk - a.risk);

      res.json({ ok: true, days, scores });
    } catch (e) {
      console.error('[workforce/scores]', e.message);
      res.json({ ok: false, error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/workforce/redundancy — 업무 중복 탐지
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/redundancy', async (req, res) => {
    const days = getDays(req);
    try {
      const names = await getUserNames();

      const { rows } = await pool.query(`
        SELECT
          user_id,
          data_json::jsonb->>'app' AS app,
          COUNT(*)                  AS cnt
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND user_id NOT LIKE 'local%'
          AND data_json::jsonb->>'app' IS NOT NULL
          AND data_json::jsonb->>'app' != ''
        GROUP BY user_id, app
        ORDER BY cnt DESC
      `, [days]);

      const appMap = {};
      rows.forEach(r => {
        if (!appMap[r.app]) appMap[r.app] = [];
        appMap[r.app].push({ userId: r.user_id, name: names[r.user_id] || r.user_id, count: parseInt(r.cnt) });
      });

      const overlaps = Object.entries(appMap)
        .filter(([, users]) => users.length >= 2)
        .map(([app, users]) => ({
          app,
          users: users.sort((a, b) => b.count - a.count),
          totalCount: users.reduce((s, u) => s + u.count, 0),
          userCount: users.length,
          level: users.length >= 3 ? 'HIGH' : 'MED',
        }))
        .sort((a, b) => b.userCount - a.userCount || b.totalCount - a.totalCount);

      res.json({ ok: true, overlaps });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/workforce/idle — 유휴 시간대 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/idle', async (req, res) => {
    const days = getDays(req);
    try {
      const names = await getUserNames();

      const { rows } = await pool.query(`
        SELECT
          user_id,
          EXTRACT(HOUR FROM timestamp::timestamptz AT TIME ZONE 'Asia/Seoul')::int AS hour,
          COUNT(*) AS cnt
        FROM events
        WHERE timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND user_id NOT LIKE 'local%'
          AND user_id IS NOT NULL
          AND user_id != 'system'
        GROUP BY user_id, hour
        ORDER BY user_id, hour
      `, [days]);

      const userMap = {};
      rows.forEach(r => {
        if (!userMap[r.user_id]) userMap[r.user_id] = new Array(24).fill(0);
        userMap[r.user_id][parseInt(r.hour)] = parseInt(r.cnt);
      });

      const analysis = Object.entries(userMap).map(([userId, hours]) => {
        const totalEv   = hours.reduce((s, c) => s + c, 0);
        // 09~18시 업무 시간대
        const workSlots = hours.slice(9, 19);
        const workEv    = workSlots.reduce((s, c) => s + c, 0);
        const idleSlots = workSlots.filter(c => c === 0).length; // 활동 0인 슬롯 수
        const idleRatio = Math.round((idleSlots / 10) * 100);
        const offEv     = totalEv - workEv;

        return {
          userId,
          name: names[userId] || userId,
          totalEvents: totalEv,
          workEvents: workEv,
          offHoursEvents: offEv,
          idleWorkSlots: idleSlots,
          idleRatio,
          heatmap: hours,
          verdict: idleRatio >= 50 ? 'HIGH_IDLE' : idleRatio >= 30 ? 'MED_IDLE' : 'ACTIVE',
        };
      }).sort((a, b) => b.idleRatio - a.idleRatio);

      res.json({ ok: true, analysis });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/workforce/automation-map — 자동화 대상 업무 맵
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/automation-map', async (req, res) => {
    const days = getDays(req);
    try {
      const names = await getUserNames();

      const { rows } = await pool.query(`
        SELECT
          user_id,
          data_json::jsonb->>'app'            AS app,
          data_json::jsonb->>'screen'         AS screen,
          data_json::jsonb->>'activity'       AS activity,
          data_json::jsonb->>'automationHint' AS hint,
          COUNT(*)                            AS frequency
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - ($1 || ' days')::INTERVAL
          AND user_id NOT LIKE 'local%'
          AND data_json::jsonb->>'automatable' = 'true'
          AND data_json::jsonb->>'activity' IS NOT NULL
        GROUP BY user_id, app, screen, activity, hint
        ORDER BY frequency DESC
        LIMIT 60
      `, [days]);

      const targets = rows.map(r => ({
        userId: r.user_id,
        name: names[r.user_id] || r.user_id,
        app: r.app,
        screen: r.screen,
        activity: r.activity,
        hint: r.hint,
        frequency: parseInt(r.frequency),
        priority: parseInt(r.frequency) >= 10 ? 'HIGH' : parseInt(r.frequency) >= 5 ? 'MED' : 'LOW',
      }));

      res.json({ ok: true, targets });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/workforce/live — 현재 팀원 실시간 상태 (커맨드센터용)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/live', async (req, res) => {
    try {
      const names = await getUserNames();

      // 최근 24시간 내 마지막 이벤트 → OFFLINE도 표시
      const { rows: recent } = await pool.query(`
        SELECT DISTINCT ON (user_id)
          user_id,
          type,
          data_json,
          timestamp
        FROM events
        WHERE timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          AND user_id NOT LIKE 'local%'
          AND user_id IS NOT NULL
          AND user_id != 'system'
          AND user_id NOT LIKE 'pc_%'
        ORDER BY user_id, timestamp DESC
      `);

      // 마지막 앱/활동: keyboard.chunk 또는 screen.analyzed 에서
      const { rows: appRows } = await pool.query(`
        SELECT DISTINCT ON (user_id)
          user_id,
          data_json
        FROM events
        WHERE type IN ('keyboard.chunk','screen.analyzed')
          AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
          AND user_id NOT LIKE 'local%'
          AND user_id NOT LIKE 'pc_%'
        ORDER BY user_id, timestamp DESC
      `);
      const appMap = {};
      appRows.forEach(r => {
        try { appMap[r.user_id] = JSON.parse(r.data_json || '{}'); } catch {}
      });

      // 최근 1시간 이벤트 수 (활동량)
      const { rows: countRows } = await pool.query(`
        SELECT user_id, COUNT(*) AS cnt
        FROM events
        WHERE timestamp::timestamptz > NOW() - INTERVAL '1 hour'
          AND user_id NOT LIKE 'local%'
          AND user_id IS NOT NULL
          AND user_id != 'system'
        GROUP BY user_id
      `);
      const cntMap = {};
      countRows.forEach(r => { cntMap[r.user_id] = parseInt(r.cnt); });

      // 최근 30분 browser.navigation URL (공급업체 웹 조회 현황)
      const { rows: navRows } = await pool.query(`
        SELECT DISTINCT ON (user_id)
          user_id,
          data_json::jsonb->>'url'   AS url,
          data_json::jsonb->>'title' AS title
        FROM events
        WHERE type = 'browser.navigation'
          AND timestamp::timestamptz > NOW() - INTERVAL '30 minutes'
          AND user_id NOT LIKE 'local%'
          AND user_id NOT LIKE 'pc_%'
        ORDER BY user_id, timestamp DESC
      `);
      const navMap = {};
      navRows.forEach(r => { if (r.url) navMap[r.user_id] = { url: r.url, title: r.title }; });

      // 오늘 자동화 가능 화면 수
      const { rows: autoRows } = await pool.query(`
        SELECT user_id,
          COUNT(*) AS total,
          COUNT(CASE WHEN data_json::jsonb->>'automatable' = 'true' THEN 1 END) AS auto_cnt
        FROM events
        WHERE type = 'screen.analyzed'
          AND timestamp::timestamptz > NOW() - INTERVAL '8 hours'
          AND user_id NOT LIKE 'local%'
        GROUP BY user_id
      `);
      const autoMap = {};
      autoRows.forEach(r => {
        autoMap[r.user_id] = {
          total: parseInt(r.total),
          auto: parseInt(r.auto_cnt),
          ratio: parseInt(r.total) > 0 ? Math.round(parseInt(r.auto_cnt) / parseInt(r.total) * 100) : 0,
        };
      });

      const members = recent.map(r => {
        let data = {};
        try { data = JSON.parse(r.data_json || '{}'); } catch {}

        const minAgo = Math.round((Date.now() - new Date(r.timestamp).getTime()) / 60000);
        const status = minAgo <= 5 ? 'ACTIVE' : minAgo <= 30 ? 'RECENT' : minAgo <= 120 ? 'IDLE' : 'OFFLINE';
        const evtCount = cntMap[r.user_id] || 0;
        const autoInfo = autoMap[r.user_id] || { ratio: 0 };
        const appData = appMap[r.user_id] || data;

        return {
          userId: r.user_id,
          name: names[r.user_id] || r.user_id,
          status,
          minAgo,
          lastType: r.type,
          currentApp: appData.appContext?.app || appData.app || appData.windowTitle || data.appContext?.app || data.app || null,
          currentActivity: appData.activity || appData.screen || appData.appContext?.category || data.activity || null,
          automatable: appData.automatable || data.automatable || false,
          eventsLastHour: evtCount,
          autoRatio: autoInfo.ratio,
          timestamp: r.timestamp,
          recentUrl: navMap[r.user_id] || null,
        };
      }).sort((a, b) => {
        const order = { ACTIVE: 0, RECENT: 1, IDLE: 2, OFFLINE: 3 };
        return (order[a.status] ?? 4) - (order[b.status] ?? 4);
      });

      res.json({ ok: true, members, updatedAt: new Date().toISOString() });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  return router;
};
