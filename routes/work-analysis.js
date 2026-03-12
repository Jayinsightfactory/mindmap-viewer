/**
 * routes/work-analysis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2: 작업 분석 엔진 API
 *
 * 개인 작업 데이터를 분석하여 패턴, 시간분배, 반복작업, 병목, 효율점수 제공
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');
const {
  detectPatterns,
  analyzeTimeDistribution,
  findRepetitiveWork,
  detectBottlenecks,
  calculateEfficiencyScore,
  generateInsightsDashboard,
  buildCapabilityProfile,
} = require('../src/work-analyzer');
const { annotateEventsWithPurpose } = require('../src/purpose-classifier');

/**
 * @param {{ verifyToken, getEventsForUser, getSessionsForUser, resolveUserId }} deps
 */
function createWorkAnalysisRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId } = deps;
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

  // ── 공통: 사용자 이벤트 로드 + purpose 어노테이션 ──
  async function loadUserEvents(req) {
    const userId = resolveUserId(req);
    const events = await getEventsForUser(userId);
    return annotateEventsWithPurpose(events || []);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/dashboard
  // 종합 인사이트 대시보드 (메인)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/dashboard', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const period = req.query.period || '30d';
      const result = generateInsightsDashboard(events, { period });
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[WorkAnalysis] dashboard error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/patterns
  // 작업 패턴 감지
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/patterns', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const patterns = detectPatterns(events);
      res.json({ ok: true, ...patterns });
    } catch (e) {
      console.error('[WorkAnalysis] patterns error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/time
  // 시간 분배 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/time', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const timeDist = analyzeTimeDistribution(events);
      res.json({ ok: true, ...timeDist });
    } catch (e) {
      console.error('[WorkAnalysis] time error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/repetitive
  // 반복 작업 식별 + 자동화 제안
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/repetitive', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const repetitive = findRepetitiveWork(events);
      res.json({ ok: true, ...repetitive });
    } catch (e) {
      console.error('[WorkAnalysis] repetitive error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/bottlenecks
  // 병목 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/bottlenecks', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const bottlenecks = detectBottlenecks(events);
      res.json({ ok: true, ...bottlenecks });
    } catch (e) {
      console.error('[WorkAnalysis] bottlenecks error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/efficiency
  // 효율 점수
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/efficiency', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const efficiency = calculateEfficiencyScore(events);
      res.json({ ok: true, ...efficiency });
    } catch (e) {
      console.error('[WorkAnalysis] efficiency error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/work-analysis/capability
  // 역량 프로필 (핵심가치 #2)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/work-analysis/capability', auth, async (req, res) => {
    try {
      const events = await loadUserEvents(req);
      const profile = buildCapabilityProfile(events);
      res.json({ ok: true, ...profile });
    } catch (e) {
      console.error('[WorkAnalysis] capability error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createWorkAnalysisRouter;
