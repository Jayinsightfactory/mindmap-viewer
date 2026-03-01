'use strict';

/**
 * routes/follow.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 팔로우 시스템 API
 *
 * 엔드포인트:
 *   POST   /api/follow/:userId          - 팔로우 (인증 필요)
 *   DELETE /api/follow/:userId          - 언팔로우 (인증 필요)
 *   GET    /api/follow/check/:userId    - 팔로우 여부 확인 (인증 필요)
 *   GET    /api/follow/list             - 내 팔로잉 목록 (인증 필요)
 *   GET    /api/follow/followers        - 내 팔로워 목록 (인증 필요)
 *   GET    /api/follow/nodes            - 팔로잉한 유저들의 노드 (인증 필요)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const router  = express.Router();

/**
 * @param {object}   deps
 * @param {Function} deps.getDb       - better-sqlite3 db 인스턴스 반환
 * @param {Function} deps.verifyToken - JWT 검증 함수
 * @returns {express.Router}
 */
function createRouter({ getDb, verifyToken }) {

  // ── DB 테이블 초기화 ──────────────────────────────────────────────────────
  function initFollowTable() {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_follows (
        follower_id   TEXT NOT NULL,
        following_id  TEXT NOT NULL,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (follower_id, following_id)
      );
      CREATE INDEX IF NOT EXISTS idx_uf_follower   ON user_follows(follower_id);
      CREATE INDEX IF NOT EXISTS idx_uf_following  ON user_follows(following_id);
    `);
  }

  try { initFollowTable(); } catch (e) { console.warn('[follow] DB init warn:', e.message); }

  // ── 인증 미들웨어 ─────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });
    req.user = user;
    next();
  }

  // ── POST /api/follow/:userId — 팔로우 ────────────────────────────────────
  router.post('/follow/:userId', auth, (req, res) => {
    const { userId } = req.params;
    if (userId === req.user.id) return res.status(400).json({ error: 'cannot follow yourself' });
    try {
      const db = getDb();
      db.prepare(`
        INSERT OR IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)
      `).run(req.user.id, userId);
      res.json({ ok: true, following: true });
    } catch (e) {
      console.error('[follow/post]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/follow/:userId — 언팔로우 ────────────────────────────────
  router.delete('/follow/:userId', auth, (req, res) => {
    const { userId } = req.params;
    try {
      const db = getDb();
      db.prepare(`
        DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?
      `).run(req.user.id, userId);
      res.json({ ok: true, following: false });
    } catch (e) {
      console.error('[follow/delete]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/check/:userId — 팔로우 여부 확인 ─────────────────────
  router.get('/follow/check/:userId', auth, (req, res) => {
    try {
      const db  = getDb();
      const row = db.prepare(`
        SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?
      `).get(req.user.id, req.params.userId);
      res.json({ following: !!row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/list — 내 팔로잉 목록 ────────────────────────────────
  router.get('/follow/list', auth, (req, res) => {
    try {
      const db   = getDb();
      const rows = db.prepare(`
        SELECT uf.following_id AS user_id, uf.created_at,
               up.name, up.headline, up.company, up.avatar_url
        FROM user_follows uf
        LEFT JOIN user_profiles up ON up.user_id = uf.following_id
        WHERE uf.follower_id = ?
        ORDER BY uf.created_at DESC
        LIMIT 200
      `).all(req.user.id);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/followers — 내 팔로워 목록 ───────────────────────────
  router.get('/follow/followers', auth, (req, res) => {
    try {
      const db   = getDb();
      const rows = db.prepare(`
        SELECT uf.follower_id AS user_id, uf.created_at,
               up.name, up.headline, up.company, up.avatar_url
        FROM user_follows uf
        LEFT JOIN user_profiles up ON up.user_id = uf.follower_id
        WHERE uf.following_id = ?
        ORDER BY uf.created_at DESC
        LIMIT 200
      `).all(req.user.id);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/nodes — 팔로잉한 유저들의 공개 노드 ──────────────────
  // 각 팔로잉 유저의 프로필 + 노드 정보를 집계해서 반환
  // (실제 노드 데이터는 각 유저가 저장한 그래프 DB에서 가져옴)
  router.get('/follow/nodes', auth, (req, res) => {
    try {
      const db = getDb();

      // 팔로잉 유저 목록 가져오기
      const following = db.prepare(`
        SELECT uf.following_id AS user_id,
               up.name, up.headline, up.company, up.avatar_url, up.is_public
        FROM user_follows uf
        LEFT JOIN user_profiles up ON up.user_id = uf.following_id
        WHERE uf.follower_id = ?
        ORDER BY uf.created_at DESC
        LIMIT 100
      `).all(req.user.id);

      // 공개 프로필인 유저만 필터링
      const publicUsers = following.filter(u => u.is_public !== 0);

      // 각 유저의 노드 정보 조회 (nodes 테이블이 있는 경우)
      // nodes 테이블: id, label, type, owner_id 컬럼 가정
      let nodesByUser = {};
      try {
        const nodeStmt = db.prepare(`
          SELECT id, label, type, level, status, owner_id
          FROM nodes
          WHERE owner_id = ? AND (is_private IS NULL OR is_private = 0)
          LIMIT 50
        `);
        for (const u of publicUsers) {
          nodesByUser[u.user_id] = nodeStmt.all(u.user_id);
        }
      } catch (_) {
        // nodes 테이블 없으면 빈 배열
        for (const u of publicUsers) {
          nodesByUser[u.user_id] = [];
        }
      }

      const result = publicUsers.map(u => ({
        ...u,
        nodes: nodesByUser[u.user_id] || [],
      }));

      res.json(result);
    } catch (e) {
      console.error('[follow/nodes]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
