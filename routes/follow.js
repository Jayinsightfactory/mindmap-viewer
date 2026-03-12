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
 * @param {Function} deps.getDb        - DB 인스턴스 반환 (SQLite or PG Pool)
 * @param {Function} deps.verifyToken  - 토큰 검증 함수
 * @param {Function} [deps.searchUsers] - auth DB에서 사용자 검색 (이메일·이름)
 * @returns {express.Router}
 */
function createRouter({ getDb, verifyToken, searchUsers, getUserById, createNotification }) {

  // ── DB 헬퍼: SQLite sync / PG async 통일 (workspace.js 패턴) ─────────────
  function _db() { return getDb(); }
  function _isPg(db) { return !db.prepare; } // PG Pool에는 prepare() 없음

  /** SQLite의 ? 를 PG의 $1, $2, ... 로 변환 */
  function _pgSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async function dbRun(sql, params = []) {
    const db = _db();
    if (!db) throw new Error('Database not initialized');
    if (db.prepare) return db.prepare(sql).run(...params);
    return db.query(_pgSql(sql), params);
  }
  async function dbGet(sql, params = []) {
    const db = _db();
    if (!db) throw new Error('Database not initialized');
    if (db.prepare) return db.prepare(sql).get(...params);
    const r = await db.query(_pgSql(sql), params);
    return r.rows[0];
  }
  async function dbAll(sql, params = []) {
    const db = _db();
    if (!db) throw new Error('Database not initialized');
    if (db.prepare) return db.prepare(sql).all(...params);
    const r = await db.query(_pgSql(sql), params);
    return r.rows;
  }
  
  // ── 동기/비동기 모두 지원하는 dbExec ──────────────────────────────────────────
  function dbExecSync(sql) {
    const db = _db();
    if (!db) throw new Error('Database not initialized');
    if (db.exec) {
      // SQLite 동기 실행
      return db.exec(sql);
    } else {
      // PG는 동기 불가능 — 에러
      throw new Error('dbExecSync requires SQLite (synchronous execution)');
    }
  }
  
  async function dbExec(sql) {
    const db = _db();
    if (!db) throw new Error('Database not initialized');
    if (db.exec) return db.exec(sql);  // SQLite 동기 실행
    // PG: 여러 문장을 ;로 분리해서 개별 실행
    const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
    for (const s of stmts) await db.query(s);
  }

  // ── workspace_id 헬퍼 ────────────────────────────────────────────────────
  function getWorkspaceId(req) {
    return req.headers['x-workspace-id'] || req.query.workspace_id || 'global';
  }

  // ── DB 테이블 초기화 (동기 방식 — 라우터 마운트 전 완료 필수) ────────────────
  function initFollowTableSync() {
    try {
      const db = _db();
      const isPg = _isPg(db);

      if (isPg) {
        // PG는 동기 실행 불가 — 스킵 (비동기로 별도 처리)
        return false;  // 비동기로 처리 필요함
      }

      // user_follows 테이블
      dbExecSync(`
        CREATE TABLE IF NOT EXISTS user_follows (
          follower_id   TEXT NOT NULL,
          following_id  TEXT NOT NULL,
          workspace_id  TEXT NOT NULL DEFAULT 'global',
          created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (follower_id, following_id, workspace_id)
        )
      `);
      dbExecSync(`CREATE INDEX IF NOT EXISTS idx_uf_follower  ON user_follows(follower_id)`);
      dbExecSync(`CREATE INDEX IF NOT EXISTS idx_uf_following ON user_follows(following_id)`);
      dbExecSync(`CREATE INDEX IF NOT EXISTS idx_uf_workspace ON user_follows(workspace_id)`);

      // 기존 테이블에 workspace_id 컬럼 추가 (마이그레이션)
      try {
        dbExecSync(`ALTER TABLE user_follows ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'global'`);
      } catch (_) { /* 이미 존재하면 무시 */ }

      // registered_users 테이블 (OAuth 로그인 시 메인 DB에 사용자 정보 영속 저장)
      dbExecSync(`
        CREATE TABLE IF NOT EXISTS registered_users (
          user_id    TEXT PRIMARY KEY,
          email      TEXT,
          name       TEXT,
          avatar_url TEXT,
          provider   TEXT DEFAULT 'local',
          plan       TEXT DEFAULT 'free',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      dbExecSync(`CREATE INDEX IF NOT EXISTS idx_ru_email ON registered_users(email)`);
      dbExecSync(`CREATE INDEX IF NOT EXISTS idx_ru_name  ON registered_users(name)`);
      
      return true;  // 초기화 성공
    } catch (e) {
      console.warn('[follow] DB init error:', e.message);
      return false;
    }
  }

  // 비동기 초기화 (PG용)
  async function initFollowTableAsync() {
    const db = _db();
    const isPg = _isPg(db);
    if (!isPg) return;  // SQLite는 동기로 이미 처리됨

    try {
      await dbExec(`
        CREATE TABLE IF NOT EXISTS user_follows (
          follower_id   TEXT NOT NULL,
          following_id  TEXT NOT NULL,
          workspace_id  TEXT NOT NULL DEFAULT 'global',
          created_at    TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (follower_id, following_id, workspace_id)
        )
      `);
      await dbExec(`CREATE INDEX IF NOT EXISTS idx_uf_follower  ON user_follows(follower_id)`);
      await dbExec(`CREATE INDEX IF NOT EXISTS idx_uf_following ON user_follows(following_id)`);
      await dbExec(`CREATE INDEX IF NOT EXISTS idx_uf_workspace ON user_follows(workspace_id)`);
      // 기존 테이블에 workspace_id 컬럼 추가 (마이그레이션)
      try {
        await dbExec(`ALTER TABLE user_follows ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'global'`);
      } catch (_) { /* 이미 존재하면 무시 */ }

      await dbExec(`
        CREATE TABLE IF NOT EXISTS registered_users (
          user_id    TEXT PRIMARY KEY,
          email      TEXT,
          name       TEXT,
          avatar_url TEXT,
          provider   TEXT DEFAULT 'local',
          plan       TEXT DEFAULT 'free',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await dbExec(`CREATE INDEX IF NOT EXISTS idx_ru_email ON registered_users(email)`);
      await dbExec(`CREATE INDEX IF NOT EXISTS idx_ru_name  ON registered_users(name)`);
    } catch (e) {
      console.warn('[follow] DB async init error:', e.message);
    }
  }

  // 라우터 반환 전에 동기 초기화 시도
  initFollowTableSync();
  
  // PG 환경에서는 비동기 초기화 스케줄링
  if (_isPg(_db())) {
    initFollowTableAsync().catch(e => console.warn('[follow] Async DB init failed:', e.message));
  }

  // ── 사용자 등록 (OAuth 로그인 시 메인 DB에 저장) ─────────────────────────
  async function registerUser(user) {
    if (!user || !user.id) return;
    try {
      const db = _db();
      const isPg = _isPg(db);
      if (isPg) {
        await db.query(
          `INSERT INTO registered_users (user_id, email, name, avatar_url, provider, plan, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             email = COALESCE(EXCLUDED.email, registered_users.email),
             name = COALESCE(EXCLUDED.name, registered_users.name),
             avatar_url = COALESCE(EXCLUDED.avatar_url, registered_users.avatar_url),
             provider = COALESCE(EXCLUDED.provider, registered_users.provider),
             plan = COALESCE(EXCLUDED.plan, registered_users.plan),
             updated_at = NOW()`,
          [user.id, user.email || null, user.name || null, user.avatar || user.avatar_url || null,
           user.provider || 'local', user.plan || 'free']
        );
      } else {
        db.prepare(
          `INSERT INTO registered_users (user_id, email, name, avatar_url, provider, plan, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT (user_id) DO UPDATE SET
             email = COALESCE(excluded.email, registered_users.email),
             name = COALESCE(excluded.name, registered_users.name),
             avatar_url = COALESCE(excluded.avatar_url, registered_users.avatar_url),
             provider = COALESCE(excluded.provider, registered_users.provider),
             plan = COALESCE(excluded.plan, registered_users.plan),
             updated_at = datetime('now')`
        ).run(user.id, user.email || null, user.name || null, user.avatar || user.avatar_url || null,
              user.provider || 'local', user.plan || 'free');
      }
    } catch (e) {
      console.warn('[follow] registerUser warn:', e.message);
    }
  }

  // ── 인증 미들웨어 ─────────────────────────────────────────────────────────
  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') ||
                  req.headers['x-api-token'] || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });
    try {
      const user = verifyToken(token);
      if (!user) return res.status(401).json({ error: 'invalid token' });
      req.user = user;
      // 인증된 사용자를 메인 DB에 자동 등록 (비동기, 실패해도 무시)
      registerUser(user).catch(() => {});
      next();
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
  }

  // ── POST /api/follow/:userId — 팔로우 ────────────────────────────────────
  router.post('/follow/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const wsId = getWorkspaceId(req);
    if (userId === req.user.id) return res.status(400).json({ error: 'cannot follow yourself' });
    try {
      await dbRun(
        `INSERT INTO user_follows (follower_id, following_id, workspace_id)
         VALUES (?, ?, ?)
         ON CONFLICT (follower_id, following_id, workspace_id) DO NOTHING`,
        [req.user.id, userId, wsId]
      );
      // 팔로우 알림 생성
      if (typeof createNotification === 'function') {
        try {
          createNotification(_db(), {
            userId, type: 'follow',
            title: '새 팔로워',
            body: `${req.user.name || req.user.email || '누군가'}님이 팔로우했습니다.`,
            data: { followerId: req.user.id },
          });
        } catch {}
      }
      res.json({ ok: true, following: true });
    } catch (e) {
      console.error('[follow/post]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── DELETE /api/follow/:userId — 언팔로우 ────────────────────────────────
  router.delete('/follow/:userId', auth, async (req, res) => {
    const { userId } = req.params;
    const wsId = getWorkspaceId(req);
    try {
      await dbRun(
        `DELETE FROM user_follows WHERE follower_id = ? AND following_id = ? AND workspace_id = ?`,
        [req.user.id, userId, wsId]
      );
      res.json({ ok: true, following: false });
    } catch (e) {
      console.error('[follow/delete]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/check/:userId — 팔로우 여부 확인 ─────────────────────
  router.get('/follow/check/:userId', auth, async (req, res) => {
    const wsId = getWorkspaceId(req);
    try {
      const row = await dbGet(
        `SELECT 1 FROM user_follows
         WHERE follower_id = ? AND following_id = ?
           AND (workspace_id = ? OR workspace_id = 'global')`,
        [req.user.id, req.params.userId, wsId]
      );
      res.json({ following: !!row });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── auth DB에서 사용자 정보 보완 (user_profiles에 없는 Google OAuth 유저용) ─
  function _enrichWithAuthDb(rows) {
    if (typeof getUserById !== 'function') return rows;
    return rows.map(row => {
      if (row.name) return row;
      const authUser = getUserById(row.user_id);
      if (!authUser) return row;
      return {
        ...row,
        name: authUser.name || authUser.email?.split('@')[0],
        avatar_url: row.avatar_url || authUser.avatar || null,
        provider: authUser.provider || 'local',
      };
    });
  }

  // ── GET /api/follow/list — 내 팔로잉 목록 ────────────────────────────────
  router.get('/follow/list', auth, async (req, res) => {
    const wsId = getWorkspaceId(req);
    try {
      const rows = await dbAll(`
        SELECT uf.following_id AS user_id, uf.created_at,
               COALESCE(up.name, ru.name) AS name,
               up.headline, up.company,
               COALESCE(up.avatar_url, ru.avatar_url) AS avatar_url
        FROM user_follows uf
        LEFT JOIN user_profiles up ON up.user_id = uf.following_id
        LEFT JOIN registered_users ru ON ru.user_id = uf.following_id
        WHERE uf.follower_id = ?
          AND (uf.workspace_id = ? OR uf.workspace_id = 'global' OR uf.workspace_id IS NULL)
        ORDER BY uf.created_at DESC
        LIMIT 200
      `, [req.user.id, wsId]);
      res.json(_enrichWithAuthDb(rows));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/followers — 내 팔로워 목록 ───────────────────────────
  router.get('/follow/followers', auth, async (req, res) => {
    const wsId = getWorkspaceId(req);
    try {
      const rows = await dbAll(`
        SELECT uf.follower_id AS user_id, uf.created_at,
               COALESCE(up.name, ru.name) AS name,
               up.headline, up.company,
               COALESCE(up.avatar_url, ru.avatar_url) AS avatar_url
        FROM user_follows uf
        LEFT JOIN user_profiles up ON up.user_id = uf.follower_id
        LEFT JOIN registered_users ru ON ru.user_id = uf.follower_id
        WHERE uf.following_id = ?
          AND (uf.workspace_id = ? OR uf.workspace_id = 'global' OR uf.workspace_id IS NULL)
        ORDER BY uf.created_at DESC
        LIMIT 200
      `, [req.user.id, wsId]);
      res.json(_enrichWithAuthDb(rows));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/follow/search — 사용자 검색 (이름·이메일) ───────────────────
  // 메인 DB(registered_users + user_profiles)와 auth DB(users) 양쪽에서 검색 후 병합
  router.get('/follow/search', auth, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 1) return res.json([]);
    try {
      const like = `%${q}%`;

      // ① 메인 DB의 registered_users + user_profiles에서 검색 (이메일 + 이름)
      let mainRows = [];
      try {
        mainRows = await dbAll(`
          SELECT ru.user_id AS id, ru.name, up.headline,
                 COALESCE(up.avatar_url, ru.avatar_url) AS avatar_url,
                 ru.email, ru.provider, ru.plan,
                 CASE WHEN uf.follower_id IS NOT NULL THEN 1 ELSE 0 END AS is_following
          FROM registered_users ru
          LEFT JOIN user_profiles up ON up.user_id = ru.user_id
          LEFT JOIN user_follows uf ON uf.follower_id = ? AND uf.following_id = ru.user_id
          WHERE ru.user_id != ? AND (ru.email LIKE ? OR ru.name LIKE ?)
          LIMIT 20
        `, [req.user.id, req.user.id, like, like]);
      } catch (_) {
        // registered_users 테이블 없으면 기존 user_profiles 검색 시도
        try {
          mainRows = await dbAll(`
            SELECT up.user_id AS id, up.name, up.headline, up.avatar_url, NULL AS email,
                   CASE WHEN uf.follower_id IS NOT NULL THEN 1 ELSE 0 END AS is_following
            FROM user_profiles up
            LEFT JOIN user_follows uf ON uf.follower_id = ? AND uf.following_id = up.user_id
            WHERE up.user_id != ? AND up.name LIKE ?
            LIMIT 20
          `, [req.user.id, req.user.id, like]);
        } catch (_) {}
      }

      // ② auth DB(users.db)에서 이메일·이름 검색 (searchUsers 함수 사용)
      let authRows = [];
      if (typeof searchUsers === 'function') {
        try {
          const rawAuthRows = searchUsers(q, req.user.id, 20);
          // 팔로우 상태 확인
          const checkFollow = async (uid) => {
            try {
              const row = await dbGet(
                `SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?`,
                [req.user.id, uid]
              );
              return row ? 1 : 0;
            } catch { return 0; }
          };

          for (const u of rawAuthRows) {
            authRows.push({
              id: u.id,
              name: u.name,
              headline: null,
              avatar_url: u.avatar_url,
              email: u.email,
              plan: u.plan,
              provider: u.provider || 'local',
              is_following: await checkFollow(u.id),
            });
          }
        } catch (e) {
          console.warn('[follow/search] auth DB 검색 실패:', e.message);
        }
      }

      // ③ 두 결과를 병합 (중복 제거 + email 보강)
      const seen = new Set(mainRows.map(r => r.id));
      const authById = {};
      authRows.forEach(r => { authById[r.id] = r; });

      // mainRows에 email 보강 (auth DB에서)
      const merged = mainRows.map(r => {
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
  router.get('/follow/nodes', auth, async (req, res) => {
    const wsId = getWorkspaceId(req);
    try {
      // 팔로잉 유저 목록 가져오기
      const following = await dbAll(`
        SELECT uf.following_id AS user_id,
               COALESCE(up.name, ru.name) AS name,
               up.headline, up.company,
               COALESCE(up.avatar_url, ru.avatar_url) AS avatar_url,
               up.is_public
        FROM user_follows uf
        LEFT JOIN user_profiles up ON up.user_id = uf.following_id
        LEFT JOIN registered_users ru ON ru.user_id = uf.following_id
        WHERE uf.follower_id = ?
          AND (uf.workspace_id = ? OR uf.workspace_id = 'global' OR uf.workspace_id IS NULL)
        ORDER BY uf.created_at DESC
        LIMIT 100
      `, [req.user.id, wsId]);

      // 공개 프로필인 유저만 필터링
      const publicUsers = following.filter(u => u.is_public !== 0);

      // 각 유저의 노드 정보 조회
      let nodesByUser = {};
      for (const u of publicUsers) {
        try {
          nodesByUser[u.user_id] = await dbAll(`
            SELECT id, label, type, level, status, owner_id
            FROM nodes
            WHERE owner_id = ? AND (is_private IS NULL OR is_private = 0)
            LIMIT 50
          `, [u.user_id]);
        } catch (_) {
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

  // registerUser를 외부에서 사용할 수 있도록 router에 첨부
  router.registerUser = registerUser;
  
  // DB 초기화 함수를 export (server.js에서 라우터 마운트 전 호출)
  router.initFollowTablesSync = initFollowTableSync;

  return router;
}

// 라우터 팩토리 함수에 초기화 함수 첨부 (직접 호출 가능)
createRouter.initFollowTablesSync = function() {
  // Dummy 이므로 서버 시작 시 우회됨 (router 반환 후 호출됨)
};

module.exports = createRouter;
