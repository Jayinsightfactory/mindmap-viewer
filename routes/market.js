'use strict';
/**
 * routes/market.js
 * 수익 공유 마켓 2.0 API 라우터
 *
 * POST /api/market/contributors          — 기여자 등록
 * GET  /api/market/contributors/:id      — 기여자 프로필
 * GET  /api/market/contributors/me       — 내 기여자 목록
 *
 * POST /api/market/items                 — 아이템 등록
 * GET  /api/market/items                 — 아이템 목록 (카테고리 필터)
 * GET  /api/market/items/:id             — 아이템 상세
 * POST /api/market/items/:id/use         — 사용량 기록
 * POST /api/market/items/:id/rate        — 별점 등록
 *
 * GET  /api/market/leaderboard           — 기간별 인기 순위
 * GET  /api/market/revenue/:contributorId — 기여자 수익 현황
 * POST /api/market/distribute            — 월말 정산 실행 (관리자)
 * GET  /api/market/distributions         — 정산 기록 조회
 */

const express = require('express');

function createMarketRouter({ marketStore, authMiddleware, optionalAuth }) {
  const router = express.Router();

  // ── 입력 검증 헬퍼 ───────────────────────────────────────────────────────
  function validate(res, obj, fields) {
    for (const [key, rule] of Object.entries(fields)) {
      if (rule.required && (obj[key] === undefined || obj[key] === null || obj[key] === '')) {
        res.status(400).json({ error: `${key} 필드가 필요합니다.` });
        return false;
      }
      if (rule.maxLen && typeof obj[key] === 'string' && obj[key].length > rule.maxLen) {
        res.status(400).json({ error: `${key}는 ${rule.maxLen}자 이하여야 합니다.` });
        return false;
      }
      if (rule.enum && obj[key] !== undefined && !rule.enum.includes(obj[key])) {
        res.status(400).json({ error: `${key}는 [${rule.enum.join(', ')}] 중 하나여야 합니다.` });
        return false;
      }
    }
    return true;
  }

  // ── 기여자 등록 ─────────────────────────────────────────────────────────
  router.post('/market/contributors', optionalAuth, (req, res) => {
    const { name, type, email, wallet, sharePct } = req.body;
    const ok = validate(res, req.body, {
      name: { required: true, maxLen: 100 },
      type: { enum: ['individual', 'team', 'enterprise', 'nation'] },
    });
    if (!ok) return;

    try {
      const userId = req.user?.id || 'local';
      const result = marketStore.registerContributor({ userId, name, type, email, wallet, sharePct });
      res.json({ success: true, contributorId: result.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 내 기여자 목록 ───────────────────────────────────────────────────────
  router.get('/market/contributors/me', optionalAuth, (req, res) => {
    const userId = req.user?.id || 'local';
    res.json(marketStore.getContributorByUser(userId));
  });

  // ── 기여자 프로필 ────────────────────────────────────────────────────────
  router.get('/market/contributors/:id', (req, res) => {
    const contributor = marketStore.getContributor(req.params.id);
    if (!contributor) return res.status(404).json({ error: '기여자를 찾을 수 없습니다.' });

    // 민감 정보 제거 후 반환
    const { wallet: _w, email: _e, ...safe } = contributor;
    res.json(safe);
  });

  // ── 아이템 등록 ─────────────────────────────────────────────────────────
  router.post('/market/items', optionalAuth, (req, res) => {
    const { contributorId, name, description, category, tags, version, priceType, priceUsd } = req.body;
    const ok = validate(res, req.body, {
      contributorId: { required: true },
      name:          { required: true, maxLen: 200 },
      category:      { enum: ['tool', 'template', 'workflow', 'ai-model'] },
      priceType:     { enum: ['free', 'subscription', 'one-time'] },
    });
    if (!ok) return;

    try {
      const result = marketStore.registerItem({
        contributorId, name, description, category, tags, version, priceType,
        priceUsd: priceUsd ? parseFloat(priceUsd) : 0.0,
      });
      res.json({ success: true, itemId: result.id });
    } catch (e) {
      const status = e.message.includes('찾을 수 없') ? 404 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── 아이템 목록 ─────────────────────────────────────────────────────────
  router.get('/market/items', (req, res) => {
    const { category, limit = 50, offset = 0 } = req.query;
    const items = marketStore.getItems({
      category:  category || undefined,
      limit:     Math.min(parseInt(limit) || 50, 200),
      offset:    parseInt(offset) || 0,
    });
    res.json(items);
  });

  // ── 아이템 상세 ─────────────────────────────────────────────────────────
  router.get('/market/items/:id', (req, res) => {
    const item = marketStore.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: '아이템을 찾을 수 없습니다.' });
    res.json(item);
  });

  // ── 사용량 기록 ─────────────────────────────────────────────────────────
  router.post('/market/items/:id/use', optionalAuth, (req, res) => {
    const { revenueUsd } = req.body;
    const userId = req.user?.id || 'local';
    try {
      marketStore.recordUsage({
        itemId:     req.params.id,
        userId,
        revenueUsd: revenueUsd ? parseFloat(revenueUsd) : 0.0,
      });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 별점 등록 ────────────────────────────────────────────────────────────
  router.post('/market/items/:id/rate', optionalAuth, (req, res) => {
    const { score } = req.body;
    if (!score || isNaN(score)) {
      return res.status(400).json({ error: 'score(1-5) 필드가 필요합니다.' });
    }
    try {
      marketStore.rateItem(req.params.id, score);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 리더보드 ─────────────────────────────────────────────────────────────
  router.get('/market/leaderboard', (req, res) => {
    const { period = 7, limit = 20 } = req.query;
    const board = marketStore.getLeaderboard({
      period: Math.min(parseInt(period) || 7, 90),
      limit:  Math.min(parseInt(limit)  || 20, 100),
    });
    res.json(board);
  });

  // ── 기여자 수익 현황 ──────────────────────────────────────────────────────
  router.get('/market/revenue/:contributorId', optionalAuth, (req, res) => {
    const { months = 3 } = req.query;
    try {
      const data = marketStore.getRevenueByContributor({
        contributorId: req.params.contributorId,
        months:        Math.min(parseInt(months) || 3, 24),
      });
      if (!data.contributor) return res.status(404).json({ error: '기여자를 찾을 수 없습니다.' });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 월말 정산 실행 ────────────────────────────────────────────────────────
  router.post('/market/distribute', async (req, res) => {
    const { period } = req.body;
    try {
      // revenue-scheduler의 고급 정산 함수 사용 (Toss Payments 연동 포함)
      let result;
      try {
        const scheduler = require('../src/revenue-scheduler');
        result = await scheduler.manualDistribution(period || undefined);
      } catch {
        // revenue-scheduler 없으면 market-store 레거시 함수 사용
        const count = marketStore.runMonthlyDistribution(period || undefined);
        result = { distributions: count, period: period || 'last-month' };
      }
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 수익 정산 스케줄러 상태 ──────────────────────────────────────────────
  router.get('/market/scheduler/status', (req, res) => {
    try {
      const scheduler = require('../src/revenue-scheduler');
      res.json(scheduler.getSchedulerStatus());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 일별 집계 수동 실행 ──────────────────────────────────────────────────
  router.post('/market/scheduler/aggregate-daily', async (req, res) => {
    try {
      const scheduler = require('../src/revenue-scheduler');
      const result = await scheduler.runDailyAggregation();
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 정산 기록 조회 ────────────────────────────────────────────────────────
  router.get('/market/distributions', optionalAuth, (req, res) => {
    const { contributorId, period } = req.query;
    const distributions = marketStore.getDistributions({
      contributorId: contributorId || undefined,
      period:        period        || undefined,
    });
    res.json(distributions);
  });

  // ── 기여자별 아이템 목록 ──────────────────────────────────────────────────
  router.get('/market/contributors/:id/items', (req, res) => {
    const items = marketStore.getItemsByContributor(req.params.id);
    res.json(items);
  });

  return router;
}

module.exports = createMarketRouter;
