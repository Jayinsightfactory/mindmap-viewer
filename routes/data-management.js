'use strict';
/**
 * routes/data-management.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용자 데이터 관리 API (GDPR 스타일)
 *
 * 엔드포인트:
 *   GET    /api/me/export-data   — 내 데이터 전체 JSON 다운로드
 *   DELETE /api/me/delete-data   — 내 데이터 전체 삭제 (계정 유지)
 *   GET    /api/me/data-summary  — 내 데이터 요약 (카운트)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

/**
 * @param {object} deps
 * @param {Function} deps.verifyToken   - JWT 검증 함수
 * @param {object}   deps.dbModule      - db.js 또는 db-pg.js 모듈 (getDb, getEventsByUser 등)
 * @returns {express.Router}
 */
function createDataManagementRouter({ verifyToken, dbModule }) {
  const router = express.Router();

  const {
    getEventsByUser,
    getSessionsByUser,
    getBookmarks,
    getNodeMemos,
    getHiddenEventIds,
    getUserServiceTokens,
    getDb,
  } = dbModule;

  // ── 인증 미들웨어 ──────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });
    req.user = user;
    next();
  }

  // ── 헬퍼: Promise.resolve로 sync/async 양쪽 대응 ──────────────────────────
  async function safeCall(fn, ...args) {
    if (typeof fn !== 'function') return [];
    try {
      return await Promise.resolve(fn(...args)) || [];
    } catch (e) {
      console.warn('[data-management] safeCall error:', e.message);
      return [];
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GET /api/me/export-data — 전체 데이터 JSON 다운로드
  // ══════════════════════════════════════════════════════════════════════════════
  router.get('/me/export-data', auth, async (req, res) => {
    try {
      const userId = req.user.id;

      // 병렬로 모든 데이터 조회
      const [events, sessions, bookmarks, memos, hiddenIds] = await Promise.all([
        safeCall(getEventsByUser, userId),
        safeCall(getSessionsByUser, userId),
        safeCall(getBookmarks, userId),
        safeCall(getNodeMemos, userId),
        safeCall(getHiddenEventIds, userId),
      ]);

      // 서비스 토큰은 민감 정보 → 마스킹
      let serviceTokens = [];
      try {
        const raw = await Promise.resolve(
          typeof getUserServiceTokens === 'function' ? getUserServiceTokens(userId) : {}
        );
        // getUserServiceTokens는 { service: token } 형태 반환
        if (raw && typeof raw === 'object') {
          serviceTokens = Object.entries(raw).map(([service, token]) => ({
            service,
            tokenPreview: typeof token === 'string' ? token.slice(0, 8) + '****' : '****',
          }));
        }
      } catch {}

      // suggestions (growth-engine) — DB에서 직접 조회
      let suggestions = [];
      try {
        const db = getDb();
        if (db && db.prepare) {
          // SQLite
          suggestions = db.prepare(
            'SELECT id, type, title, description, confidence, status, created_at FROM suggestions ORDER BY created_at DESC LIMIT 200'
          ).all();
        } else if (db && db.query) {
          // PostgreSQL pool
          const { rows } = await db.query(
            'SELECT id, type, title, description, confidence, status, created_at FROM suggestions ORDER BY created_at DESC LIMIT 200'
          );
          suggestions = rows;
        }
      } catch {}

      const exportData = {
        exportedAt: new Date().toISOString(),
        userId,
        events,
        sessions,
        bookmarks,
        memos,
        hiddenEventIds: hiddenIds,
        serviceTokens,
        suggestions,
      };

      // JSON 다운로드 헤더
      const filename = `orbit-data-export-${userId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json(exportData);
    } catch (err) {
      console.error('[data-management] export error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // DELETE /api/me/delete-data — 내 데이터 전체 삭제 (계정은 유지)
  // ══════════════════════════════════════════════════════════════════════════════
  router.delete('/me/delete-data', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const { confirm } = req.body || {};

      if (confirm !== 'DELETE_ALL_MY_DATA') {
        return res.status(400).json({
          error: '확인 코드가 필요합니다.',
          hint: '{ "confirm": "DELETE_ALL_MY_DATA" } 를 body에 포함하세요.',
        });
      }

      const deleted = {};
      const db = getDb();

      if (db && db.prepare) {
        // ── SQLite (동기) ───────────────────────────────────────────────────
        deleted.events       = db.prepare('DELETE FROM events WHERE user_id = ?').run(userId).changes;
        deleted.sessions     = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
        deleted.bookmarks    = db.prepare('DELETE FROM bookmarks WHERE user_id = ?').run(userId).changes;
        deleted.memos        = db.prepare('DELETE FROM node_memos WHERE user_id = ?').run(userId).changes;
        deleted.hiddenEvents = db.prepare('DELETE FROM hidden_events WHERE user_id = ?').run(userId).changes;
      } else if (db && db.query) {
        // ── PostgreSQL (비동기) ──────────────────────────────────────────────
        const run = async (sql) => {
          const r = await db.query(sql, [userId]);
          return r.rowCount || 0;
        };
        deleted.events       = await run('DELETE FROM events WHERE user_id = $1');
        deleted.sessions     = await run('DELETE FROM sessions WHERE user_id = $1');
        deleted.bookmarks    = await run('DELETE FROM bookmarks WHERE user_id = $1');
        deleted.memos        = await run('DELETE FROM node_memos WHERE user_id = $1');
        deleted.hiddenEvents = await run('DELETE FROM hidden_events WHERE user_id = $1');
      } else {
        return res.status(500).json({ error: 'DB not available' });
      }

      console.log(`[data-management] 사용자 ${userId} 데이터 삭제 완료:`, deleted);
      res.json({ ok: true, userId, deleted, deletedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[data-management] delete error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // GET /api/me/data-summary — 내 데이터 요약
  // ══════════════════════════════════════════════════════════════════════════════
  router.get('/me/data-summary', auth, async (req, res) => {
    try {
      const userId = req.user.id;
      const db = getDb();

      let summary = {};

      if (db && db.prepare) {
        // ── SQLite ─────────────────────────────────────────────────────────
        const q = (sql) => db.prepare(sql).get(userId);
        summary.eventCount    = q('SELECT COUNT(*) AS c FROM events WHERE user_id = ?').c;
        summary.sessionCount  = q('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').c;
        summary.bookmarkCount = q('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = ?').c;
        summary.memoCount     = q('SELECT COUNT(*) AS c FROM node_memos WHERE user_id = ?').c;

        const first = db.prepare('SELECT MIN(timestamp) AS t FROM events WHERE user_id = ?').get(userId);
        const last  = db.prepare('SELECT MAX(timestamp) AS t FROM events WHERE user_id = ?').get(userId);
        summary.firstEvent = first?.t || null;
        summary.lastEvent  = last?.t || null;
      } else if (db && db.query) {
        // ── PostgreSQL ─────────────────────────────────────────────────────
        const q = async (sql) => {
          const { rows } = await db.query(sql, [userId]);
          return parseInt(rows[0]?.c || '0');
        };
        summary.eventCount    = await q('SELECT COUNT(*) AS c FROM events WHERE user_id = $1');
        summary.sessionCount  = await q('SELECT COUNT(*) AS c FROM sessions WHERE user_id = $1');
        summary.bookmarkCount = await q('SELECT COUNT(*) AS c FROM bookmarks WHERE user_id = $1');
        summary.memoCount     = await q('SELECT COUNT(*) AS c FROM node_memos WHERE user_id = $1');

        const { rows: firstRow } = await db.query('SELECT MIN(timestamp) AS t FROM events WHERE user_id = $1', [userId]);
        const { rows: lastRow }  = await db.query('SELECT MAX(timestamp) AS t FROM events WHERE user_id = $1', [userId]);
        summary.firstEvent = firstRow[0]?.t || null;
        summary.lastEvent  = lastRow[0]?.t || null;
      }

      res.json({ userId, ...summary, generatedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[data-management] summary error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createDataManagementRouter;
