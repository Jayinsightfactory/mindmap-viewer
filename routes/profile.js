/**
 * routes/profile.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit AI 사용자 프로필 API (LinkedIn 수준)
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
 * @param {Function} deps.getDb        - better-sqlite3 db 인스턴스
 * @param {Function} deps.verifyToken  - JWT 검증 함수
 * @returns {express.Router}
 */
function createRouter({ getDb, verifyToken }) {

  // ── DB 테이블 초기화 ──────────────────────────────────────────────────────
  function initProfileTable() {
    const db = getDb();
    db.exec(`
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
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_up_user_id ON user_profiles(user_id);
    `);
  }

  try { initProfileTable(); } catch (e) { console.warn('[profile] DB init warn:', e.message); }

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
  router.get('/profile/check', auth, (req, res) => {
    try {
      const db      = getDb();
      const profile = db.prepare('SELECT user_id, name, headline FROM user_profiles WHERE user_id = ?')
                        .get(req.user.id);
      res.json({ exists: !!profile, hasHeadline: !!(profile?.headline) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/profile — 내 프로필 ──────────────────────────────────────────
  router.get('/profile', auth, (req, res) => {
    try {
      const db      = getDb();
      const profile = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(req.user.id);
      if (!profile) return res.json(null);
      // JSON 파싱
      ['skills', 'experiences', 'education', 'links'].forEach(k => {
        try { profile[k] = JSON.parse(profile[k]); } catch (_) { profile[k] = k === 'links' ? {} : []; }
      });
      res.json(profile);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/profile/:userId — 공개 프로필 ────────────────────────────────
  router.get('/profile/:userId', (req, res) => {
    try {
      const db      = getDb();
      const profile = db.prepare(
        'SELECT * FROM user_profiles WHERE user_id = ? AND is_public = 1'
      ).get(req.params.userId);
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
  router.post('/profile', auth, (req, res) => {
    try {
      const db = getDb();
      const {
        name, headline, company, location, bio,
        skills, experiences, education, links,
        avatar_url, is_public,
      } = req.body || {};

      db.prepare(`
        INSERT INTO user_profiles
          (user_id, name, headline, company, location, bio, skills, experiences, education, links, avatar_url, is_public, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
          name         = excluded.name,
          headline     = excluded.headline,
          company      = excluded.company,
          location     = excluded.location,
          bio          = excluded.bio,
          skills       = excluded.skills,
          experiences  = excluded.experiences,
          education    = excluded.education,
          links        = excluded.links,
          avatar_url   = excluded.avatar_url,
          is_public    = excluded.is_public,
          updated_at   = datetime('now')
      `).run(
        req.user.id,
        (name        || '').slice(0, 100),
        (headline    || '').slice(0, 200),
        (company     || '').slice(0, 100),
        (location    || '').slice(0, 100),
        (bio         || '').slice(0, 1000),
        JSON.stringify(Array.isArray(skills)      ? skills.slice(0, 50)      : []),
        JSON.stringify(Array.isArray(experiences) ? experiences.slice(0, 20) : []),
        JSON.stringify(Array.isArray(education)   ? education.slice(0, 10)   : []),
        JSON.stringify(typeof links === 'object' && links ? links : {}),
        (avatar_url  || null),
        is_public !== false ? 1 : 0,
      );

      res.json({ ok: true });
    } catch (e) {
      console.error('[profile/save]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
