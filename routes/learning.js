/**
 * routes/learning.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5: AI 학습 + 맞춤 기획 제시 API
 *
 * 개인별 작업 패턴 학습 → 맞춤 솔루션 자동 추천 (마켓플레이스 연결)
 * 학습 데이터 시트 열람
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');
const {
  buildLearningProfile,
  generatePersonalRecommendations,
  buildRoutines,
  identifyAutomationAreas,
  AI_SOLUTION_CATALOG,
} = require('../src/learning-engine');
const { annotateEventsWithPurpose } = require('../src/purpose-classifier');

/**
 * @param {{ verifyToken, getEventsForUser, resolveUserId, db }} deps
 */
function createLearningRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId, db } = deps;
  const router = express.Router();

  // ── 인증 미들웨어 (Bearer + Cookie + query token 지원) ──
  function auth(req, res, next) {
    const token = req.headers.authorization || req.query.token || req.cookies?.orbit_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  }

  async function loadAnnotatedEvents(req) {
    const userId = resolveUserId(req);
    const events = await getEventsForUser(userId);
    return annotateEventsWithPurpose(events || []);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/profile
  // 학습 프로필 (루틴, 트리거, 자동화 영역)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/profile', auth, async (req, res) => {
    try {
      const events = await loadAnnotatedEvents(req);
      const profile = buildLearningProfile(events);
      res.json({ ok: true, ...profile });
    } catch (e) {
      console.error('[Learning] profile error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/recommendations
  // 맞춤 솔루션 추천 (마켓플레이스 연결)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/recommendations', auth, async (req, res) => {
    try {
      const events = await loadAnnotatedEvents(req);
      const profile = buildLearningProfile(events);
      const recs = generatePersonalRecommendations(profile);
      res.json({ ok: true, ...recs });
    } catch (e) {
      console.error('[Learning] recommendations error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/data-sheet
  // 학습 데이터 시트 (사용자 열람)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/data-sheet', auth, async (req, res) => {
    try {
      const events = await loadAnnotatedEvents(req);
      const profile = buildLearningProfile(events);
      res.json({
        ok: true,
        entries: profile.learningData,
        totalEntries: profile.learningData.length,
        categories: [...new Set(profile.learningData.map(e => e.category))],
      });
    } catch (e) {
      console.error('[Learning] data-sheet error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/routines
  // 작업 루틴만
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/routines', auth, async (req, res) => {
    try {
      const events = await loadAnnotatedEvents(req);
      const profile = buildLearningProfile(events);
      res.json({ ok: true, routines: profile.routines });
    } catch (e) {
      console.error('[Learning] routines error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/triggers
  // 트리거 패턴만
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/triggers', auth, async (req, res) => {
    try {
      const events = await loadAnnotatedEvents(req);
      const profile = buildLearningProfile(events);
      res.json({ ok: true, triggers: profile.triggers });
    } catch (e) {
      console.error('[Learning] triggers error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/automation-areas
  // AI 자동화 가능 영역 (learning-engine.identifyAutomationAreas)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/automation-areas', auth, async (req, res) => {
    try {
      const events = await loadAnnotatedEvents(req);
      const profile = buildLearningProfile(events);
      res.json({ ok: true, automationAreas: profile.automationAreas });
    } catch (e) {
      console.error('[Learning] automation-areas error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/learning/catalog
  // AI 솔루션 카탈로그 (전체 목록)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/catalog', auth, async (req, res) => {
    res.json({ ok: true, solutions: AI_SOLUTION_CATALOG });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /api/learning/feedback
  // 추천 피드백 저장 (liked / dismissed)
  // body: { recommendationId, action: 'liked'|'dismissed', userId? }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.post('/learning/feedback', auth, async (req, res) => {
    try {
      const { recommendationId, action } = req.body || {};
      if (!recommendationId || !['liked', 'dismissed'].includes(action)) {
        return res.status(400).json({ error: 'recommendationId and action(liked|dismissed) required' });
      }
      const userId = resolveUserId(req);

      // DB가 있으면 PG에 저장, 없으면 in-memory 로그만
      if (db && db.query) {
        await db.query(`
          CREATE TABLE IF NOT EXISTS learning_feedback (
            id           BIGSERIAL PRIMARY KEY,
            user_id      TEXT NOT NULL,
            recommendation_id TEXT NOT NULL,
            action       TEXT NOT NULL,
            created_at   TIMESTAMPTZ DEFAULT NOW()
          )
        `);
        await db.query(
          'INSERT INTO learning_feedback (user_id, recommendation_id, action) VALUES ($1,$2,$3)',
          [userId, recommendationId, action]
        );
      } else {
        console.log(`[Learning] feedback (no DB): user=${userId} rec=${recommendationId} action=${action}`);
      }

      res.json({ ok: true, userId, recommendationId, action });
    } catch (e) {
      console.error('[Learning] feedback error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createLearningRouter;
