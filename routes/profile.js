/**
 * routes/profile.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 사용자 프로필 API (LinkedIn 수준)
 * SQLite + PostgreSQL 듀얼 DB 지원
 *
 * 엔드포인트:
 *   GET  /api/profile          - 내 프로필 조회 (인증 필요)
 *   POST /api/profile          - 프로필 저장/업데이트 (인증 필요)
 *   GET  /api/profile/:userId  - 공개 프로필 조회
 *   GET  /api/profile/check    - 프로필 등록 여부 확인 (인증 필요)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps
 * @param {Function} deps.getDb        - DB 인스턴스 (SQLite or PG Pool)
 * @param {Function} deps.verifyToken  - 토큰 검증 함수
 * @returns {express.Router}
 */
function createRouter({ getDb, verifyToken }) {

  // ── DB 헬퍼: SQLite sync / PG async 통일 ──────────────────────────────────
  function _isPg(db) { return db && !db.prepare; }

  function _pgSql(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  async function dbGet(sql, params = []) {
    const db = getDb();
    if (_isPg(db)) {
      const r = await db.query(_pgSql(sql), params);
      return r.rows[0] || null;
    }
    return db.prepare(sql).get(...params) || null;
  }

  async function dbRun(sql, params = []) {
    const db = getDb();
    if (_isPg(db)) return db.query(_pgSql(sql), params);
    return db.prepare(sql).run(...params);
  }

  async function dbExec(sql) {
    const db = getDb();
    if (_isPg(db)) {
      const stmts = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const s of stmts) await db.query(s);
      return;
    }
    return db.exec(sql);
  }

  // ── DB 테이블 초기화 ──────────────────────────────────────────────────────
  async function initProfileTable() {
    const db = getDb();
    const isPg = _isPg(db);
    const tsDefault = isPg ? 'TIMESTAMPTZ DEFAULT NOW()' : 'DATETIME DEFAULT CURRENT_TIMESTAMP';

    await dbExec(`
      CREATE TABLE IF NOT EXISTS user_profiles (
        user_id      TEXT PRIMARY KEY,
        name         TEXT,
        headline     TEXT,
        company      TEXT,
        location     TEXT,
        bio          TEXT,
        skills       TEXT DEFAULT '[]',
        experiences  TEXT DEFAULT '[]',
        education    TEXT DEFAULT '[]',
        links        TEXT DEFAULT '{}',
        avatar_url   TEXT,
        is_public    INTEGER DEFAULT 1,
        created_at   ${tsDefault},
        updated_at   ${tsDefault}
      );
      CREATE INDEX IF NOT EXISTS idx_up_user_id ON user_profiles(user_id)
    `);
  }

  initProfileTable().catch(e => console.warn('[profile] DB init warn:', e.message));

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

  // ── GET /api/profile/check ─────────────────────────────────────────────────
  router.get('/profile/check', auth, async (req, res) => {
    try {
      const profile = await dbGet(
        'SELECT user_id, name, headline FROM user_profiles WHERE user_id = ?',
        [req.user.id]
      );
      res.json({ exists: !!profile, hasHeadline: !!(profile?.headline) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/profile — 내 프로필 ──────────────────────────────────────────
  router.get('/profile', auth, async (req, res) => {
    try {
      const profile = await dbGet('SELECT * FROM user_profiles WHERE user_id = ?', [req.user.id]);
      if (!profile) return res.json(null);
      ['skills', 'experiences', 'education', 'links'].forEach(k => {
        try { profile[k] = JSON.parse(profile[k]); } catch (_) { profile[k] = k === 'links' ? {} : []; }
      });
      res.json(profile);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/profile/:userId — 공개 프로필 ────────────────────────────────
  router.get('/profile/:userId', async (req, res) => {
    try {
      const profile = await dbGet(
        'SELECT * FROM user_profiles WHERE user_id = ? AND is_public = 1',
        [req.params.userId]
      );
      if (!profile) return res.status(404).json({ error: 'not found' });
      ['skills', 'experiences', 'education', 'links'].forEach(k => {
        try { profile[k] = JSON.parse(profile[k]); } catch (_) { profile[k] = k === 'links' ? {} : []; }
      });
      res.json(profile);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/profile — 저장/업데이트 ────────────────────────────────────
  router.post('/profile', auth, async (req, res) => {
    try {
      const db = getDb();
      const isPg = _isPg(db);
      const body = req.body || {};
      const {
        headline, company, location, bio,
        skills, experiences, education, links,
        avatar_url, is_public,
      } = body;
      const name = body.name || body.displayName || '';

      const nowExpr = isPg ? 'NOW()' : "datetime('now')";

      const sql = isPg
        ? `INSERT INTO user_profiles
            (user_id, name, headline, company, location, bio, skills, experiences, education, links, avatar_url, is_public, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
          ON CONFLICT(user_id) DO UPDATE SET
            name=EXCLUDED.name, headline=EXCLUDED.headline, company=EXCLUDED.company,
            location=EXCLUDED.location, bio=EXCLUDED.bio, skills=EXCLUDED.skills,
            experiences=EXCLUDED.experiences, education=EXCLUDED.education,
            links=EXCLUDED.links, avatar_url=EXCLUDED.avatar_url,
            is_public=EXCLUDED.is_public, updated_at=NOW()`
        : `INSERT INTO user_profiles
            (user_id, name, headline, company, location, bio, skills, experiences, education, links, avatar_url, is_public, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id) DO UPDATE SET
            name=excluded.name, headline=excluded.headline, company=excluded.company,
            location=excluded.location, bio=excluded.bio, skills=excluded.skills,
            experiences=excluded.experiences, education=excluded.education,
            links=excluded.links, avatar_url=excluded.avatar_url,
            is_public=excluded.is_public, updated_at=datetime('now')`;

      const params = [
        req.user.id,
        (name        || '').slice(0, 100),
        (headline    || '').slice(0, 200),
        (company     || '').slice(0, 100),
        (location    || '').slice(0, 100),
        (bio         || '').slice(0, 1000),
        JSON.stringify(Array.isArray(skills)      ? skills.slice(0, 50)      : []),
        JSON.stringify(Array.isArray(experiences) ? experiences.slice(0, 20) : []),
        JSON.stringify(Array.isArray(education)   ? education.slice(0, 10)   : []),
        JSON.stringify(links && typeof links === 'object' && !Array.isArray(links) ? links : {}),
        (avatar_url  || null),
        is_public !== false ? 1 : 0,
      ];

      if (isPg) {
        await db.query(sql, params);
      } else {
        db.prepare(sql).run(...params);
      }

      res.json({ ok: true });
    } catch (e) {
      console.error('[profile/save]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
