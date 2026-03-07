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
 * @param {Function} deps.getDb        - better-sqlite3 db 인스턴스 반환 (메인 DB)
 * @param {Function} deps.verifyToken  - JWT 검증 함수
 * @param {Function} [deps.searchUsers] - auth DB에서 사용자 검색 (이메일·이름)
 * @returns {express.Router}
 */
function createRouter({ getDb, verifyToken, searchUsers, getUserById, createNotification }) {

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
    try {
      const user = verifyToken(token);
      if (!user) return res.status(401).json({ error: 'invalid token' });
      req.user = user;
      next();
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
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
      // 팔로우 알림 생성
      if (typeof createNotification === 'function') {
        createNotification(db, {
          userId, type: 'follow',
          title: '새 팔로워',
          body: `${req.user.name || req.user.email || '누군가'}님이 팔로우했습니다.`,
          data: { followerId: req.user.id },
        });
      }
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

  // ── auth DB에서 사용자 정보 보완 (user_profiles에 없는 Google OAuth 유저용) ─
  function _enrichWithAuthDb(rows) {
    if (typeof getUserById !== 'function') return rows;       // getUserById 미주입 시 그대로 반환
    return rows.map(row => {
      if (row.name) return row;                               // 이미 이름 있으면 스킵
      const authUser = getUserById(row.user_id);              // auth DB에서 조회
      if (!authUser) return row;
      return {
        ...row,
        name: authUser.name || authUser.email?.split('@')[0], // Google 계정 이름
        avatar_url: row.avatar_url || authUser.avatar || null,// Google 프로필 이미지
        provider: authUser.provider || 'local',               // 인증 제공자 (google 등)
      };
    });
  }

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
      res.json(_enrichWithAuthDb(rows));                      // auth DB로 빈 이름 보완
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
      res.json(_enrichWithAuthDb(rows));                      // auth DB로 빈 이름 보완
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/search — 사용자 검색 (이름·이메일) ───────────────────
  // 메인 DB(user_profiles)와 auth DB(users) 양쪽에서 검색 후 병합
  router.get('/follow/search', auth, (req, res) => {
    const q = (req.query.q || '').trim();                   // 검색어 추출
    if (!q || q.length < 1) return res.json([]);            // 빈 검색어 → 빈 배열
    try {
      const db = getDb();                                   // 메인 DB 가져오기
      const like = `%${q}%`;                                // LIKE 패턴 (부분 일치)

      // ① 메인 DB의 user_profiles 테이블에서 검색 (프로필이 있는 사용자)
      let profileRows = [];
      try {
        profileRows = db.prepare(`
          SELECT up.user_id AS id, up.name, up.headline, up.avatar_url, NULL AS email,
                 CASE WHEN uf.follower_id IS NOT NULL THEN 1 ELSE 0 END AS is_following
          FROM user_profiles up
          LEFT JOIN user_follows uf ON uf.follower_id = ? AND uf.following_id = up.user_id
          WHERE up.user_id != ? AND up.name LIKE ?
          LIMIT 20
        `).all(req.user.id, req.user.id, like);             // 자신 제외, 이름 검색
      } catch (_) {
        // user_profiles 테이블 없으면 무시
      }

      // ② auth DB(users.db)에서 이메일·이름 검색 (searchUsers 함수 사용)
      let authRows = [];
      if (typeof searchUsers === 'function') {              // searchUsers가 주입되었을 때만
        try {
          const rawAuthRows = searchUsers(q, req.user.id, 20); // auth DB에서 검색
          // 팔로우 상태 확인을 위해 메인 DB에서 체크
          const followCheckStmt = (() => {
            try {
              return db.prepare(
                `SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?`
              );
            } catch { return null; }                        // user_follows 없으면 null
          })();

          authRows = rawAuthRows.map(u => ({                // auth 결과를 표준 형식으로 변환
            id: u.id,
            name: u.name,
            headline: null,                                 // auth DB에는 headline 없음
            avatar_url: u.avatar_url,
            email: u.email,
            plan: u.plan,
            provider: u.provider || 'local',                // 인증 제공자 (google 등)
            is_following: followCheckStmt                    // 팔로우 여부 확인
              ? (followCheckStmt.get(req.user.id, u.id) ? 1 : 0)
              : 0,
          }));
        } catch (e) {
          console.warn('[follow/search] auth DB 검색 실패:', e.message);
        }
      }

      // ③ 두 결과를 병합 (중복 제거 + email 보강)
      const seen = new Set(profileRows.map(r => r.id));
      const authById = {};
      authRows.forEach(r => { authById[r.id] = r; });

      // profileRows에 email 보강 (auth DB에서)
      const merged = profileRows.map(r => {
        const auth = authById[r.id];
        return auth ? { ...r, email: auth.email || r.email, provider: auth.provider || 'local' } : r;
      });

      for (const row of authRows) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          merged.push(row);
        }
      }

      res.json(merged.slice(0, 20));
    } catch (e) {
      console.error('[follow/search]', e.message);
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
