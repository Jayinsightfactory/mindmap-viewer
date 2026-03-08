/**
 * routes/analytics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 사용자 행동 분석 API (SQLite + PostgreSQL 듀얼 호환)
 *
 * 엔드포인트:
 *   POST /api/analytics/event   - 단일 이벤트 저장
 *   POST /api/analytics/batch   - 배치(최대 50개) 저장
 *   GET  /api/analytics/summary - 어드민용 집계 통계
 *   GET  /api/analytics/events  - 최근 200개 원본 이벤트
 *
 * 수집 이벤트:
 *   auth.login / auth.logout / auth.register
 *   view.mode_switch / view.filter_change / view.panel_open
 *   node.click / node.effect_apply / node.edit
 *   ai.filter_query / ai.suggestion_accept / ai.suggestion_dismiss
 *   session.start / session.heartbeat / session.end
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

function createRouter({ getDb }) {

  // ── DB 헬퍼: SQLite sync / PG async 통일 ──────────────────────────────────
  function _db() { return getDb(); }

  function _pgSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async function dbRun(sql, params = []) {
    const db = _db();
    if (db.prepare) return db.prepare(sql).run(...params);
    return db.query(_pgSql(sql), params);
  }
  async function dbGet(sql, params = []) {
    const db = _db();
    if (db.prepare) return db.prepare(sql).get(...params);
    const r = await db.query(_pgSql(sql), params);
    return r.rows[0];
  }
  async function dbAll(sql, params = []) {
    const db = _db();
    if (db.prepare) return db.prepare(sql).all(...params);
    const r = await db.query(_pgSql(sql), params);
    return r.rows;
  }
  async function dbExec(sql) {
    const db = _db();
    if (db.exec) return db.exec(sql);
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of stmts) await db.query(s);
  }

  const isPg = !_db().prepare;

  // ── DB 테이블 초기화 ──────────────────────────────────────────────────────
  async function initAnalyticsTables() {
    const idCol = isPg
      ? 'id BIGSERIAL PRIMARY KEY'
      : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
    const tsCol = isPg
      ? 'created_at TIMESTAMPTZ DEFAULT NOW()'
      : 'created_at DATETIME DEFAULT CURRENT_TIMESTAMP';

    await dbExec(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        ${idCol},
        user_id    TEXT,
        session_id TEXT,
        event      TEXT NOT NULL,
        meta       TEXT,
        ip         TEXT,
        ${tsCol}
      );
      CREATE INDEX IF NOT EXISTS idx_ae_event      ON analytics_events(event);
      CREATE INDEX IF NOT EXISTS idx_ae_created_at ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_ae_user_id    ON analytics_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_ae_session_id ON analytics_events(session_id)
    `);
  }

  initAnalyticsTables().catch(e => console.warn('[analytics] DB init warn:', e.message));

  // ── 헬퍼 ────────────────────────────────────────────────────────────────
  async function insertOne({ user_id, session_id, event, meta, ip }) {
    await dbRun(
      `INSERT INTO analytics_events (user_id, session_id, event, meta, ip) VALUES (?, ?, ?, ?, ?)`,
      [
        user_id    || null,
        session_id || null,
        String(event).slice(0, 100),
        meta ? JSON.stringify(meta).slice(0, 500) : null,
        ip || null,
      ]
    );
  }

  function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 45);
  }

  // ── 날짜 SQL 분기 ──────────────────────────────────────────────────────────
  const SQL_START_OF_DAY   = isPg ? `CURRENT_DATE`               : `datetime('now', 'start of day')`;
  const SQL_START_OF_MONTH = isPg ? `date_trunc('month', NOW())` : `datetime('now', 'start of month')`;
  const SQL_LAST_7_DAYS    = isPg ? `NOW() - INTERVAL '7 days'`  : `datetime('now', '-7 days')`;
  const SQL_DATE_OF_COL    = isPg ? `TO_CHAR(created_at, 'YYYY-MM-DD')` : `date(created_at)`;

  // ── POST /api/analytics/event ─────────────────────────────────────────────
  router.post('/analytics/event', async (req, res) => {
    try {
      const { event, meta, user_id, session_id } = req.body || {};
      if (!event) return res.status(400).json({ error: 'event required' });
      await insertOne({ user_id, session_id, event, meta, ip: getClientIp(req) });
      res.json({ ok: true });
    } catch (e) {
      console.error('[analytics/event]', e.message);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ── POST /api/analytics/batch ─────────────────────────────────────────────
  router.post('/analytics/batch', async (req, res) => {
    try {
      const { events } = req.body || {};
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'events[] required' });
      }
      const ip = getClientIp(req);
      const db = _db();

      if (db.prepare) {
        // SQLite: transaction
        const run = db.transaction((rows) => {
          for (const row of rows.slice(0, 50)) {
            if (!row.event) continue;
            db.prepare(
              `INSERT INTO analytics_events (user_id, session_id, event, meta, ip) VALUES (?, ?, ?, ?, ?)`
            ).run(
              row.user_id || null, row.session_id || null,
              String(row.event).slice(0, 100),
              row.meta ? JSON.stringify(row.meta).slice(0, 500) : null, ip
            );
          }
        });
        run(events);
      } else {
        // PostgreSQL: 개별 INSERT
        for (const row of events.slice(0, 50)) {
          if (!row.event) continue;
          await insertOne({ ...row, ip });
        }
      }

      res.json({ ok: true, saved: Math.min(events.length, 50) });
    } catch (e) {
      console.error('[analytics/batch]', e.message);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ── GET /api/analytics/events ─────────────────────────────────────────────
  router.get('/analytics/events', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '200'), 500);
      const rows  = await dbAll(
        `SELECT id, user_id, session_id, event, meta, ip, created_at
         FROM analytics_events ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/analytics/summary ────────────────────────────────────────────
  router.get('/analytics/summary', async (req, res) => {
    try {
      // DAU
      const dauRow = await dbGet(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM analytics_events
         WHERE user_id IS NOT NULL AND created_at >= ${SQL_START_OF_DAY}`
      );
      const dau = Number(dauRow?.cnt || 0);

      // MAU
      const mauRow = await dbGet(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM analytics_events
         WHERE user_id IS NOT NULL AND created_at >= ${SQL_START_OF_MONTH}`
      );
      const mau = Number(mauRow?.cnt || 0);

      // 전체 유저 수
      const totalUsersRow = await dbGet(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM analytics_events WHERE user_id IS NOT NULL`
      );
      const totalUsers = Number(totalUsersRow?.cnt || 0);

      // 전체/오늘 이벤트 수
      const totalRow = await dbGet(`SELECT COUNT(*) AS cnt FROM analytics_events`);
      const totalEvents = Number(totalRow?.cnt || 0);

      const todayRow = await dbGet(
        `SELECT COUNT(*) AS cnt FROM analytics_events WHERE created_at >= ${SQL_START_OF_DAY}`
      );
      const todayEvents = Number(todayRow?.cnt || 0);

      // 로그인 방법
      const loginRows = await dbAll(
        `SELECT meta FROM analytics_events WHERE event = 'auth.login' AND meta IS NOT NULL`
      );
      const loginMethods = { google: 0, github: 0, email: 0 };
      loginRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          if (m.provider && loginMethods[m.provider] !== undefined) loginMethods[m.provider]++;
        } catch (_) {}
      });

      // 뷰 모드 전환
      const modeRows = await dbAll(
        `SELECT meta FROM analytics_events WHERE event = 'view.mode_switch' AND meta IS NOT NULL`
      );
      const modeSwitches = { personal: 0, team: 0, company: 0, parallel: 0 };
      modeRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          if (m.to && modeSwitches[m.to] !== undefined) modeSwitches[m.to]++;
        } catch (_) {}
      });

      // 상위 10개 기능
      const topFeatureRows = await dbAll(
        `SELECT event, COUNT(*) AS cnt FROM analytics_events GROUP BY event ORDER BY cnt DESC LIMIT 10`
      );
      const topFeatures = topFeatureRows.map(r => [r.event, Number(r.cnt)]);

      // 노드 클릭 타입별
      const nodeClickRows = await dbAll(
        `SELECT meta FROM analytics_events WHERE event = 'node.click' AND meta IS NOT NULL`
      );
      const nodeClicks = { planet: 0, team: 0, task: 0, dept: 0, ptask: 0, prequest: 0, presult: 0 };
      nodeClickRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          const k = m.node_type;
          if (k && nodeClicks[k] !== undefined) nodeClicks[k]++;
          else if (k) nodeClicks[k] = (nodeClicks[k] || 0) + 1;
        } catch (_) {}
      });

      // 마켓 이펙트 사용
      const effectRows = await dbAll(
        `SELECT meta FROM analytics_events WHERE event = 'node.effect_apply' AND meta IS NOT NULL`
      );
      const effectUsage = { neon: 0, matrix: 0, dna: 0, beam: 0, holo: 0, burst: 0 };
      effectRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          const k = m.effect;
          if (k && effectUsage[k] !== undefined) effectUsage[k]++;
        } catch (_) {}
      });

      // 패널 오픈 집계
      const panelRows = await dbAll(
        `SELECT meta FROM analytics_events WHERE event = 'view.panel_open' AND meta IS NOT NULL`
      );
      const panelOpens = {};
      panelRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          const k = m.panel || 'unknown';
          panelOpens[k] = (panelOpens[k] || 0) + 1;
        } catch (_) {}
      });

      // AI 상호작용
      const aiAcceptRow  = await dbGet(`SELECT COUNT(*) AS cnt FROM analytics_events WHERE event='ai.suggestion_accept'`);
      const aiDismissRow = await dbGet(`SELECT COUNT(*) AS cnt FROM analytics_events WHERE event='ai.suggestion_dismiss'`);
      const aiFilterRow  = await dbGet(`SELECT COUNT(*) AS cnt FROM analytics_events WHERE event='ai.filter_query'`);

      // 최근 20개 이벤트
      const recentEvents = await dbAll(
        `SELECT id, user_id, session_id, event, meta, created_at
         FROM analytics_events ORDER BY created_at DESC LIMIT 20`
      );

      // 일별 이벤트 수 (최근 7일)
      const dailyRows = await dbAll(
        `SELECT ${SQL_DATE_OF_COL} AS day, COUNT(*) AS cnt
         FROM analytics_events WHERE created_at >= ${SQL_LAST_7_DAYS}
         GROUP BY day ORDER BY day ASC`
      );

      res.json({
        dau, mau, totalUsers,
        totalEvents, todayEvents,
        loginMethods, modeSwitches, topFeatures,
        nodeClicks, effectUsage, panelOpens,
        ai: {
          accept:      Number(aiAcceptRow?.cnt || 0),
          dismiss:     Number(aiDismissRow?.cnt || 0),
          filterQuery: Number(aiFilterRow?.cnt || 0),
        },
        dailyEvents: dailyRows.map(r => ({ day: r.day, cnt: Number(r.cnt) })),
        recentEvents,
        generatedAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[analytics/summary]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
