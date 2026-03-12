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
  AI_SOLUTION_CATALOG,
} = require('../src/learning-engine');
const { annotateEventsWithPurpose } = require('../src/purpose-classifier');

/**
 * @param {{ verifyToken, getEventsForUser, resolveUserId }} deps
 */
function createLearningRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId } = deps;
  const router = express.Router();

  function auth(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
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
  // GET /api/learning/catalog
  // AI 솔루션 카탈로그 (전체 목록)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/learning/catalog', auth, async (req, res) => {
    res.json({ ok: true, solutions: AI_SOLUTION_CATALOG });
  });

  return router;
}

module.exports = createLearningRouter;
