'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Insights, client insights, diff learning, dashboard APIs
// ══════════════════════════════════════════════════════════════════════════════

module.exports = function createInsightsApiRouter(deps) {
  const express = require('express');
  const router  = express.Router();
  const crypto  = require('crypto');

  const {
    getAllEvents, broadcastAll, broadcastToClientId,
    insightEngine, diffLearner, dualSkillEngine,
    wsChannelMap, wss,
  } = deps;

  // ── 클라이언트 인사이트 메모리 버퍼 ────────────────────────────────────
  const _clientInsights = [];
  const MAX_CLIENT_INSIGHTS = 5000;

// /insights — 최근 인사이트 조회 (userId 쿼리 파라미터로 필터링 가능)
router.get('/insights', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const userId = req.query.userId || undefined;
  res.json(insightEngine.getInsights(limit, userId));
});

// /insights/run — 즉시 분석 실행 (POST)
router.post('/insights/run', async (req, res) => {
  const { analyzeAndSuggest: saveSuggestion } = require('./src/growth-engine');
  const results = await insightEngine.runOnce({ getAllEvents, saveSuggestion, broadcastAll });
  res.json({ ok: true, count: results.length, insights: results });
});


// ── Diff 학습 API ────────────────────────────────────────────────────────────
router.get('/learn/stats',       (req, res) => res.json(diffLearner.getStats()));
router.get('/learn/suggestions', (req, res) => res.json(diffLearner.getSuggestions()));
router.post('/learn/seen/:id',   (req, res) => { diffLearner.markSeen(req.params.id); res.json({ ok: true }); });
router.post('/learn/file',       async (req, res) => {
  const { filePath, action } = req.body;
  if (!filePath) return res.status(400).json({ error: 'filePath required' });
  if (action === 'before') { diffLearner.snapshot(filePath); return res.json({ ok: true }); }
  const entry = await diffLearner.learn(filePath);
  res.json({ ok: true, entry });
});

router.post('/insights/client', (req, res) => {
  const { insights } = req.body;
  if (!Array.isArray(insights) || insights.length === 0) {
    return res.status(400).json({ error: 'insights array required' });
  }

  const received = [];
  const newSuggestions = [];

  for (const insight of insights) {
    // 원본 코드 필드가 들어오면 거부 (보안)
    if (insight.code || insight.content || insight.source) {
      continue;
    }

    // dualAnalysis 필드: 서버 측 앙상블 재계산
    let dualResult = null;
    if (insight.dualAnalysis?.primary || insight.dualAnalysis?.secondary) {
      const { primary, secondary } = insight.dualAnalysis;
      const confidence = dualSkillEngine.calcConfidence(primary, secondary);
      dualResult = dualSkillEngine.mergeAnalysis(primary, secondary, confidence);
    }

    const safe = {
      id:           require('crypto').randomUUID(),
      clientId:     String(insight.clientId    || 'unknown').slice(0, 32),
      userName:     String(insight.userName    || 'unknown').slice(0, 50),
      fileName:     String(insight.fileName    || '').slice(0, 100),
      ext:          String(insight.ext         || '').slice(0, 10),
      timestamp:    Number(insight.timestamp   || Date.now()),
      activityType: String(insight.activityType || 'file').slice(0, 20),
      addedLines:   Number(insight.addedLines  || 0),
      removedLines: Number(insight.removedLines || 0),
      changeRatio:  Number(insight.changeRatio || 0),
      pattern:      (dualResult?.pattern    || insight.pattern)    ? String(dualResult?.pattern    || insight.pattern).slice(0, 200)    : null,
      suggestion:   (dualResult?.suggestion || insight.suggestion) ? String(dualResult?.suggestion || insight.suggestion).slice(0, 500) : null,
      automatable:  dualResult ? Boolean(dualResult.automatable) : Boolean(insight.automatable),
      category:     String(dualResult?.category || insight.category || 'unknown').slice(0, 20),
      confidence:   dualResult?.confidence ?? insight.dualAnalysis?.confidence ?? null,
      receivedAt:   Date.now(),
    };

      _clientInsights.unshift(safe);
    received.push(safe);

    // 패턴 누적 → 스킬/에이전트 제안 생성
    if (safe.clientId !== 'unknown') {
      const suggestion = dualSkillEngine.accumulatePattern(
        { clientId: safe.clientId, userName: safe.userName, ext: safe.ext, fileName: safe.fileName, activityType: safe.activityType },
        { category: safe.category, automatable: safe.automatable, confidence: safe.confidence || 0.45, pattern: safe.pattern, suggestion: safe.suggestion }
      );
      if (suggestion) newSuggestions.push(suggestion);
    }
  }

  if (  _clientInsights.length > MAX_CLIENT_INSIGHTS) {
      _clientInsights.splice(MAX_CLIENT_INSIGHTS);
  }

  // 실시간 브로드캐스트
  if (typeof broadcastAll === 'function' && received.length > 0) {
    broadcastAll({ type: 'client_insights', data: received });
  }

  // 새 스킬/에이전트 제안 → 해당 클라이언트에 WebSocket 알림
  for (const suggestion of newSuggestions) {
    broadcastToClientId(suggestion.clientId, { type: 'skill_suggestion', data: suggestion });
    console.log(`[Insights] 🎯 스킬 제안 브로드캐스트 → ${suggestion.clientId}: ${suggestion.alias}`);
  }

  console.log(`[Insights] 수신: ${received.length}개 from ${received[0]?.userName || '?'}`);
  res.json({ ok: true, received: received.length, suggestions: newSuggestions.length });
});

router.get('/insights/feedback', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const suggestions = dualSkillEngine.getFeedback(clientId);
  res.json({ ok: true, suggestions });
});

// ── 제안 수락 ─────────────────────────────────────────────────────────────────
router.post('/insights/feedback/apply', (req, res) => {
  const { clientId, suggestionId } = req.body;
  if (!clientId || !suggestionId) return res.status(400).json({ error: 'clientId, suggestionId required' });
  const suggestion = dualSkillEngine.acceptSuggestion(clientId, suggestionId);
  if (!suggestion) return res.status(404).json({ error: 'suggestion not found' });
  res.json({ ok: true, suggestion });
});

// ── 패턴 통계 (디버그/대시보드) ──────────────────────────────────────────────
router.get('/insights/patterns', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) {
    // 전체 제안 (대시보드용)
    return res.json({ ok: true, suggestions: dualSkillEngine.getAllSuggestions(50) });
  }
  const patterns = dualSkillEngine.getPatternStats(clientId);
  const suggestions = dualSkillEngine.getFeedback(clientId);
  res.json({ ok: true, patterns, suggestions });
});

// /api/insights/dashboard — 집계 대시보드
router.get('/insights/dashboard', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 100, 1000);
  const recent = _clientInsights.slice(0, limit);

  // 클라이언트별 통계
  const byClient = {};
  for (const i of recent) {
    const key = i.clientId;
    if (!byClient[key]) byClient[key] = { userName: i.userName, count: 0, categories: {}, automatable: 0 };
    byClient[key].count++;
    byClient[key].categories[i.category] = (byClient[key].categories[i.category] || 0) + 1;
    if (i.automatable) byClient[key].automatable++;
  }

  // 자동화 가능 패턴 상위
  const automatablePatterns = recent
    .filter(i => i.automatable && i.suggestion)
    .slice(0, 10)
    .map(i => ({ userName: i.userName, fileName: i.fileName, suggestion: i.suggestion, category: i.category }));

  // 카테고리 분포
  const categoryDist = {};
  for (const i of recent) {
    categoryDist[i.category] = (categoryDist[i.category] || 0) + 1;
  }

  res.json({
    total:              _clientInsights.length,
    recentCount:        recent.length,
    byClient:           Object.values(byClient),
    automatablePatterns,
    categoryDist,
    lastUpdated:        _clientInsights[0]?.receivedAt || null,
  });
});

  return router;
};
