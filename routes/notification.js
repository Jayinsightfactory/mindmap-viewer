'use strict';

/**
 * routes/notification.js
 * Orbit AI 알림 시스템 API
 *
 * 엔드포인트:
 *   GET    /api/notifications           - 내 알림 목록
 *   PUT    /api/notifications/:id/read  - 알림 읽음 처리
 *   PUT    /api/notifications/read-all  - 전체 읽음
 *   DELETE /api/notifications/:id       - 알림 삭제
 *   GET    /api/notifications/unread-count - 안읽은 알림 수
 */

const express = require('express');
const router  = express.Router();

function createNotificationRouter({ getDb, verifyToken }) {

  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });
    req.user = user;
    next();
  }

  // ── DB 헬퍼 (SQLite sync / PG async 통일) ──────────────────────────────
  function _toPg(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }
  function _isPg() { const db = getDb(); return db && !db.prepare; }

  function dbGet(sql, params = []) {
    const db = getDb();
    if (!db) return null;
    if (db.prepare) return db.prepare(sql).get(...params);
    return db.query(_toPg(sql), params).then(r => r.rows[0]);
  }
  function dbAll(sql, params = []) {
    const db = getDb();
    if (!db) return [];
    if (db.prepare) return db.prepare(sql).all(...params);
    return db.query(_toPg(sql), params).then(r => r.rows);
  }
  function dbRun(sql, params = []) {
    const db = getDb();
    if (!db) return;
    if (db.prepare) return db.prepare(sql).run(...params);
    return db.query(_toPg(sql), params);
  }

  // GET /api/notifications
  router.get('/notifications', auth, async (req, res) => {
    try {
      const rows = await Promise.resolve(dbAll(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
        [req.user.id]
      ));
      (rows || []).forEach(r => {
        try { r.data = JSON.parse(r.data_json || '{}'); } catch { r.data = {}; }
      });
      res.json(rows || []);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/notifications/unread-count
  router.get('/notifications/unread-count', auth, async (req, res) => {
    try {
      const row = await Promise.resolve(dbGet(
        'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0',
        [req.user.id]
      ));
      res.json({ count: row?.cnt || 0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/notifications/:id/read
  router.put('/notifications/:id/read', auth, async (req, res) => {
    try {
      await Promise.resolve(dbRun(
        'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
        [req.params.id, req.user.id]
      ));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/notifications/read-all
  router.put('/notifications/read-all', auth, async (req, res) => {
    try {
      await Promise.resolve(dbRun(
        'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
        [req.user.id]
      ));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/notifications/:id
  router.delete('/notifications/:id', auth, async (req, res) => {
    try {
      await Promise.resolve(dbRun(
        'DELETE FROM notifications WHERE id = ? AND user_id = ?',
        [req.params.id, req.user.id]
      ));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

// 알림 생성 유틸리티 (다른 라우터에서 사용)
function createNotification(db, { userId, type, title, body, data } = {}) {
  if (!db || !userId || !type || !title) return null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const sql = 'INSERT INTO notifications (id, user_id, type, title, body, data_json) VALUES (?, ?, ?, ?, ?, ?)';
  const params = [id, userId, type, title, body || '', JSON.stringify(data || {})];
  try {
    if (db.prepare) {
      db.prepare(sql).run(...params);
    } else {
      // PG
      let i = 0;
      const pgSql = sql.replace(/\?/g, () => `$${++i}`);
      db.query(pgSql, params).catch(e => console.warn('[notification] PG insert error:', e.message));
    }
    return id;
  } catch (e) {
    console.warn('[notification] create error:', e.message);
    return null;
  }
}

module.exports = { createNotificationRouter, createNotification };
