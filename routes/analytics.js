/**
 * routes/analytics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 사용자 행동 분석 API
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

/**
 * @param {object} deps
 * @param {Function} deps.getDb - better-sqlite3 db 인스턴스 반환 함수
 * @returns {express.Router}
 */
function createRouter({ getDb }) {

  // ── DB 테이블 초기화 ──────────────────────────────────────────────────────
  function initAnalyticsTables() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT,
        session_id TEXT,
        event      TEXT NOT NULL,
        meta       TEXT,
        ip         TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ae_event      ON analytics_events(event);
      CREATE INDEX IF NOT EXISTS idx_ae_created_at ON analytics_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_ae_user_id    ON analytics_events(user_id);
      CREATE INDEX IF NOT EXISTS idx_ae_session_id ON analytics_events(session_id);
    `);
  }

  // 라우터 초기화 시 테이블 생성
  try { initAnalyticsTables(); } catch (e) { console.warn('[analytics] DB init warn:', e.message); }

  // ── 헬퍼 ────────────────────────────────────────────────────────────────
  function insertOne(db, { user_id, session_id, event, meta, ip }) {
    const stmt = db.prepare(`
      INSERT INTO analytics_events (user_id, session_id, event, meta, ip)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      user_id    || null,
      session_id || null,
      String(event).slice(0, 100),
      meta ? JSON.stringify(meta).slice(0, 500) : null,
      ip || null
    );
  }

  function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 45);
  }

  // ── POST /api/analytics/event ─────────────────────────────────────────────
  router.post('/analytics/event', (req, res) => {
    try {
      const { event, meta, user_id, session_id } = req.body || {};
      if (!event) return res.status(400).json({ error: 'event required' });
      const db = getDb();
      insertOne(db, { user_id, session_id, event, meta, ip: getClientIp(req) });
      res.json({ ok: true });
    } catch (e) {
      console.error('[analytics/event]', e.message);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ── POST /api/analytics/batch ─────────────────────────────────────────────
  router.post('/analytics/batch', (req, res) => {
    try {
      const { events } = req.body || {};
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'events[] required' });
      }
      const db  = getDb();
      const ip  = getClientIp(req);
      const run = db.transaction((rows) => {
        for (const row of rows.slice(0, 50)) {
          if (!row.event) continue;
          insertOne(db, { ...row, ip });
        }
      });
      run(events);
      res.json({ ok: true, saved: Math.min(events.length, 50) });
    } catch (e) {
      console.error('[analytics/batch]', e.message);
      res.status(500).json({ error: 'server error' });
    }
  });

  // ── GET /api/analytics/events ─────────────────────────────────────────────
  router.get('/analytics/events', (req, res) => {
    try {
      const db    = getDb();
      const limit = Math.min(parseInt(req.query.limit || '200'), 500);
      const rows  = db.prepare(`
        SELECT id, user_id, session_id, event, meta, ip, created_at
        FROM analytics_events
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/analytics/summary ────────────────────────────────────────────
  router.get('/analytics/summary', (req, res) => {
    try {
      const db = getDb();

      // DAU — 오늘 unique user
      const dau = db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS cnt
        FROM analytics_events
        WHERE user_id IS NOT NULL
          AND created_at >= datetime('now', 'start of day')
      `).get().cnt;

      // MAU — 이번달 unique user
      const mau = db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS cnt
        FROM analytics_events
        WHERE user_id IS NOT NULL
          AND created_at >= datetime('now', 'start of month')
      `).get().cnt;

      // 전체 유저 수
      const totalUsers = db.prepare(`
        SELECT COUNT(DISTINCT user_id) AS cnt
        FROM analytics_events
        WHERE user_id IS NOT NULL
      `).get().cnt;

      // 전체 이벤트 수
      const totalEvents = db.prepare(`
        SELECT COUNT(*) AS cnt FROM analytics_events
      `).get().cnt;

      // 오늘 이벤트 수
      const todayEvents = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM analytics_events
        WHERE created_at >= datetime('now', 'start of day')
      `).get().cnt;

      // 로그인 방법 (auth.login meta.provider 집계)
      const loginRows = db.prepare(`
        SELECT meta FROM analytics_events
        WHERE event = 'auth.login' AND meta IS NOT NULL
      `).all();
      const loginMethods = { google: 0, github: 0, email: 0 };
      loginRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          if (m.provider && loginMethods[m.provider] !== undefined) {
            loginMethods[m.provider]++;
          }
        } catch (_) {}
      });

      // 뷰 모드 전환 (view.mode_switch meta.to 집계)
      const modeRows = db.prepare(`
        SELECT meta FROM analytics_events
        WHERE event = 'view.mode_switch' AND meta IS NOT NULL
      `).all();
      const modeSwitches = { personal: 0, team: 0, company: 0, parallel: 0 };
      modeRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          if (m.to && modeSwitches[m.to] !== undefined) modeSwitches[m.to]++;
        } catch (_) {}
      });

      // 상위 10개 기능 사용
      const topFeatureRows = db.prepare(`
        SELECT event, COUNT(*) AS cnt
        FROM analytics_events
        GROUP BY event
        ORDER BY cnt DESC
        LIMIT 10
      `).all();
      const topFeatures = topFeatureRows.map(r => [r.event, r.cnt]);

      // 노드 클릭 타입별
      const nodeClickRows = db.prepare(`
        SELECT meta FROM analytics_events
        WHERE event = 'node.click' AND meta IS NOT NULL
      `).all();
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
      const effectRows = db.prepare(`
        SELECT meta FROM analytics_events
        WHERE event = 'node.effect_apply' AND meta IS NOT NULL
      `).all();
      const effectUsage = { neon: 0, matrix: 0, dna: 0, beam: 0, holo: 0, burst: 0 };
      effectRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          const k = m.effect;
          if (k && effectUsage[k] !== undefined) effectUsage[k]++;
        } catch (_) {}
      });

      // 패널 오픈 집계
      const panelRows = db.prepare(`
        SELECT meta FROM analytics_events
        WHERE event = 'view.panel_open' AND meta IS NOT NULL
      `).all();
      const panelOpens = {};
      panelRows.forEach(r => {
        try {
          const m = JSON.parse(r.meta);
          const k = m.panel || 'unknown';
          panelOpens[k] = (panelOpens[k] || 0) + 1;
        } catch (_) {}
      });

      // AI 상호작용
      const aiAccept  = db.prepare(`SELECT COUNT(*) AS cnt FROM analytics_events WHERE event='ai.suggestion_accept'`).get().cnt;
      const aiDismiss = db.prepare(`SELECT COUNT(*) AS cnt FROM analytics_events WHERE event='ai.suggestion_dismiss'`).get().cnt;
      const aiFilter  = db.prepare(`SELECT COUNT(*) AS cnt FROM analytics_events WHERE event='ai.filter_query'`).get().cnt;

      // 최근 20개 이벤트
      const recentEvents = db.prepare(`
        SELECT id, user_id, session_id, event, meta, created_at
        FROM analytics_events
        ORDER BY created_at DESC
        LIMIT 20
      `).all();

      // 일별 이벤트 수 (최근 7일)
      const dailyRows = db.prepare(`
        SELECT date(created_at) AS day, COUNT(*) AS cnt
        FROM analytics_events
        WHERE created_at >= datetime('now', '-7 days')
        GROUP BY day
        ORDER BY day ASC
      `).all();

      res.json({
        dau,
        mau,
        totalUsers,
        totalEvents,
        todayEvents,
        loginMethods,
        modeSwitches,
        topFeatures,
        nodeClicks,
        effectUsage,
        panelOpens,
        ai: { accept: aiAccept, dismiss: aiDismiss, filterQuery: aiFilter },
        dailyEvents: dailyRows,
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
