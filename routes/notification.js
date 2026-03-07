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

  // GET /api/notifications
  router.get('/notifications', auth, (req, res) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100'
      ).all(req.user.id);
      rows.forEach(r => {
        try { r.data = JSON.parse(r.data_json || '{}'); } catch { r.data = {}; }
      });
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/notifications/unread-count
  router.get('/notifications/unread-count', auth, (req, res) => {
    try {
      const db = getDb();
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0'
      ).get(req.user.id);
      res.json({ count: row?.cnt || 0 });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/notifications/:id/read
  router.put('/notifications/:id/read', auth, (req, res) => {
    try {
      const db = getDb();
      db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
        .run(req.params.id, req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/notifications/read-all
  router.put('/notifications/read-all', auth, (req, res) => {
    try {
      const db = getDb();
      db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/notifications/:id
  router.delete('/notifications/:id', auth, (req, res) => {
    try {
      const db = getDb();
      db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
        .run(req.params.id, req.user.id);
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
  try {
    db.prepare(
      'INSERT INTO notifications (id, user_id, type, title, body, data_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, userId, type, title, body || '', JSON.stringify(data || {}));
    return id;
  } catch (e) {
    console.warn('[notification] create error:', e.message);
    return null;
  }
}

module.exports = { createNotificationRouter, createNotification };
