/**
 * routes/growth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 성장 엔진 + 솔루션 마켓 API 라우터
 *
 * 담당 엔드포인트:
 *   GET  /api/growth/suggestions - AI 자동 제안 목록
 *   GET  /api/growth/patterns    - 반복 패턴 감지 결과
 *   POST /api/growth/feedback    - 제안에 피드백 등록 (👍/👎 + 대안 아이디어)
 *   GET  /api/growth/candidates  - 마켓 출시 후보 (신뢰도 0.8+, 추천 3+)
 *   POST /api/growth/analyze     - 수동 패턴 분석 트리거
 *   GET  /api/growth/solutions   - 솔루션 마켓 목록
 *   POST /api/growth/solutions   - 솔루션 마켓 등록
 *
 * 성장 루프:
 *   이벤트 패턴 감지 → AI 제안 생성 → 사용자 피드백 → 신뢰도 업데이트
 *   → 신뢰도 0.8 이상 + 추천 3 이상 → 솔루션 마켓 후보로 자동 승격
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.growthEngine   - { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates }
 * @param {object} deps.solutionStore  - { getAll, add } (src/solution-store.js)
 * @param {object} deps.db             - { getEventsByChannel }  (분석 트리거용)
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { growthEngine, solutionStore, db } = deps;

  const { analyzeAndSuggest, saveFeedback, getSuggestions, getPatterns, getMarketCandidates } = growthEngine;

  // ── AI 제안 ──────────────────────────────────────────────────────────────

  /**
   * GET /api/growth/suggestions?channel=X&limit=20
   * 현재 저장된 AI 자동 제안 목록을 반환합니다.
   * 패턴 감지 후 생성된 자동화 스크립트, 워크플로우, 별칭 등의 제안입니다.
   * @query {string} [channel] - 채널 필터
   * @query {string} [limit]   - 최대 결과 수 (기본값: 20)
   * @returns {Suggestion[]}
   */
  router.get('/growth/suggestions', (req, res) => {
    const { channel, limit } = req.query;
    res.json(getSuggestions({ channelId: channel, limit: parseInt(limit || '20') }));
  });

  // ── 패턴 목록 ────────────────────────────────────────────────────────────

  /**
   * GET /api/growth/patterns?channel=X
   * 감지된 반복 패턴 목록을 반환합니다.
   * 패턴 타입: repeat_file, repeat_command, repeat_error
   * @query {string} [channel] - 채널 필터
   * @returns {Pattern[]}
   */
  router.get('/growth/patterns', (req, res) => {
    res.json(getPatterns({ channelId: req.query.channel }));
  });

  // ── 피드백 ───────────────────────────────────────────────────────────────

  /**
   * POST /api/growth/feedback
   * AI 제안에 대한 사용자 피드백을 등록합니다.
   * 👍 → 신뢰도 상승, 👎 + 대안 아이디어 → learned_rules 테이블에 저장
   * 신뢰도가 0.8 이상이 되고 추천 수가 3 이상이면 마켓 후보로 자동 승격됩니다.
   *
   * @body {string} suggestionId    - 피드백 대상 제안 ID
   * @body {'up'|'down'} vote       - 추천 여부
   * @body {string} [reason]        - 비추천 이유
   * @body {string} [alternativeIdea] - 대안 아이디어 (학습 데이터로 사용됨)
   * @body {string} [userId]        - 피드백 제공자 ID
   * @body {string} [channelId]     - 채널 ID
   * @returns {{ ok: boolean }}
   */
  router.post('/growth/feedback', (req, res) => {
    const result = saveFeedback({ ...req.body });
    res.json(result);
  });

  // ── 마켓 후보 ────────────────────────────────────────────────────────────

  /**
   * GET /api/growth/candidates
   * 솔루션 마켓 출시 후보를 반환합니다.
   * confidence >= 0.8 AND upvotes >= 3 인 제안이 후보가 됩니다.
   * @returns {Suggestion[]}
   */
  router.get('/growth/candidates', (req, res) => {
    res.json(getMarketCandidates());
  });

  // ── 수동 분석 트리거 ─────────────────────────────────────────────────────

  /**
   * POST /api/growth/analyze
   * 지정 채널의 최근 500개 이벤트를 분석하여 패턴과 제안을 생성합니다.
   * 자동 분석은 /api/hook 이벤트 수신 시 백그라운드로 동작합니다.
   * 이 엔드포인트는 즉시 분석이 필요할 때 수동으로 호출합니다.
   *
   * @body {string} [channel] - 분석할 채널 (기본값: 'default')
   * @returns {{ ok: boolean, patterns: number, results: Pattern[] }}
   */
  router.post('/growth/analyze', (req, res) => {
    try {
      const channel      = req.body.channel || 'default';
      const recentEvents = db.getEventsByChannel
        ? db.getEventsByChannel(channel).slice(-500)
        : db.getAllEvents().slice(-500);

      const results = analyzeAndSuggest(recentEvents, channel);
      res.json({ ok: true, patterns: results.length, results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 솔루션 마켓 ──────────────────────────────────────────────────────────

  /**
   * GET /api/growth/solutions
   * 솔루션 마켓에 등록된 전체 솔루션 목록을 반환합니다.
   * 내장 솔루션 + 사용자 제출 솔루션을 모두 포함합니다.
   * @returns {Solution[]}
   */
  router.get('/growth/solutions', (req, res) => {
    res.json(solutionStore.getAll());
  });

  /**
   * POST /api/growth/solutions
   * 새 솔루션을 마켓에 등록합니다.
   * @body {Partial<Solution>} 솔루션 데이터 (title, description, type, tags 등)
   * @returns {Solution} 저장된 솔루션
   */
  router.post('/growth/solutions', (req, res) => {
    const sol = solutionStore.add(req.body);
    res.json(sol);
  });

  return router;
}

module.exports = createRouter;
