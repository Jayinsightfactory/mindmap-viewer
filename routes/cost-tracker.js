'use strict';
/**
 * routes/cost-tracker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AI 토큰 비용 추적 API
 *
 * GET  /api/costs/dashboard    — 전체 비용 대시보드
 * GET  /api/costs/by-session   — 세션별 비용 분석
 * GET  /api/costs/by-tool      — 도구별 비용 분석
 * GET  /api/costs/by-date      — 날짜별 비용 추이
 * POST /api/costs/record       — 비용 수동 기록 (클라이언트에서 전송)
 * GET  /api/costs/estimate     — 현재 세션 비용 추정
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOTE: events 테이블에 token_count, cost_usd 컬럼을 추가하는 마이그레이션이
 * 없어도 동작하도록 설계. 이벤트 data_json에서 토큰 정보를 추출하거나,
 * 별도 메모리 레저로 비용을 추적합니다.
 */

const express = require('express');

// ── 모델별 토큰 단가 (1K 토큰당 USD, 2026년 기준 추정치) ────────────────────
const TOKEN_PRICES = {
  // Anthropic Claude
  'claude-opus-4':             { input: 0.015, output: 0.075 },
  'claude-sonnet-4':           { input: 0.003, output: 0.015 },
  'claude-haiku-4':            { input: 0.00025, output: 0.00125 },
  'claude-3-5-sonnet':         { input: 0.003, output: 0.015 },
  'claude-3-5-haiku':          { input: 0.0008, output: 0.004 },
  'claude-3-opus':             { input: 0.015, output: 0.075 },
  // OpenAI
  'gpt-4o':                    { input: 0.005, output: 0.015 },
  'gpt-4o-mini':               { input: 0.00015, output: 0.0006 },
  'gpt-4-turbo':               { input: 0.01, output: 0.03 },
  'gpt-3.5-turbo':             { input: 0.0005, output: 0.0015 },
  // Cursor (Sonnet 기반 추정)
  'cursor-fast':               { input: 0.003, output: 0.015 },
  'cursor-slow':               { input: 0.015, output: 0.075 },
  // Ollama (로컬 = 무료, 전기료 추정 $0.001/1K)
  'llama3.2':                  { input: 0.001, output: 0.001 },
  'llama3.1':                  { input: 0.001, output: 0.001 },
  'orbit-insight':             { input: 0.001, output: 0.001 },
  // 기본값 (알 수 없는 모델)
  default:                     { input: 0.002, output: 0.008 },
};

// ── 이벤트 타입별 추정 토큰 수 (토큰 정보 없을 때 폴백) ──────────────────────
const ESTIMATED_TOKENS = {
  'assistant.turn': { input: 800, output: 400 },
  'user.turn':      { input: 200, output: 0   },
  'tool.start':     { input: 150, output: 50  },
  'tool.end':       { input: 50,  output: 100 },
  'tool.error':     { input: 50,  output: 50  },
};

// ── 인메모리 비용 레저 (서버 재시작 시 초기화) ──────────────────────────────
const costLedger = new Map(); // eventId → { sessionId, model, inputTokens, outputTokens, costUsd, ts }

/**
 * 모델명에서 가격 조회 (부분 매칭 지원)
 */
function getPriceForModel(modelId) {
  if (!modelId) return TOKEN_PRICES.default;
  const lower = modelId.toLowerCase();
  // 정확 매칭 먼저
  if (TOKEN_PRICES[lower]) return TOKEN_PRICES[lower];
  // 부분 매칭
  for (const [key, price] of Object.entries(TOKEN_PRICES)) {
    if (key !== 'default' && lower.includes(key)) return price;
  }
  return TOKEN_PRICES.default;
}

/**
 * 이벤트에서 토큰 수와 비용을 추출/추정
 */
function extractCostFromEvent(ev) {
  let data = {};
  try { data = typeof ev.data === 'string' ? JSON.parse(ev.data) : (ev.data || {}); } catch {}
  let meta = {};
  try { meta = typeof ev.metadata === 'string' ? JSON.parse(ev.metadata) : (ev.metadata || {}); } catch {}

  // 1) 실제 토큰 수 (Claude Code hooks가 포함하는 경우)
  const inputTokens  = data.input_tokens  || meta.input_tokens  || data.usage?.input_tokens  || null;
  const outputTokens = data.output_tokens || meta.output_tokens || data.usage?.output_tokens || null;

  // 2) 모델 정보
  const modelId = data.model || meta.model || ev.modelId || 'default';
  const prices  = getPriceForModel(modelId);

  // 3) 토큰 없으면 이벤트 타입 기반 추정
  const est      = ESTIMATED_TOKENS[ev.type] || { input: 0, output: 0 };
  const inTok    = inputTokens  !== null ? inputTokens  : est.input;
  const outTok   = outputTokens !== null ? outputTokens : est.output;
  const costUsd  = ((inTok * prices.input) + (outTok * prices.output)) / 1000;
  const isEstimated = inputTokens === null;

  return { modelId, inputTokens: inTok, outputTokens: outTok, costUsd, isEstimated };
}

function createCostTrackerRouter({ getAllEvents, getSessions, getEventsForUser, getSessionsForUser, resolveUserId, optionalAuth }) {
  const router = express.Router();

  // ── 비용 대시보드 ────────────────────────────────────────────────────────
  router.get('/costs/dashboard', optionalAuth, async (req, res) => {
    try {
      const days    = parseInt(req.query.days) || 30;
      const cutoff  = new Date(Date.now() - days * 86400000).toISOString();
      // 사용자별 이벤트 필터링 (getEventsForUser 없으면 전체 폴백)
      const rawEvents = getEventsForUser ? await getEventsForUser(resolveUserId(req)) : getAllEvents();
      const events  = rawEvents.filter(e => e.timestamp >= cutoff);

      let totalCost = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let estimatedCount = 0;
      const byModel   = {};
      const bySource  = {};
      const bySession = {};

      for (const ev of events) {
        // 인메모리 레저 우선, 없으면 추출
        const recorded = costLedger.get(ev.id);
        const cost = recorded || extractCostFromEvent(ev);

        totalCost   += cost.costUsd;
        totalInput  += cost.inputTokens;
        totalOutput += cost.outputTokens;
        if (cost.isEstimated) estimatedCount++;

        // 모델별
        const m = cost.modelId || 'unknown';
        if (!byModel[m]) byModel[m] = { model: m, cost: 0, inputTokens: 0, outputTokens: 0, events: 0 };
        byModel[m].cost         += cost.costUsd;
        byModel[m].inputTokens  += cost.inputTokens;
        byModel[m].outputTokens += cost.outputTokens;
        byModel[m].events++;

        // 소스별
        const s = ev.source || 'unknown';
        if (!bySource[s]) bySource[s] = { source: s, cost: 0, events: 0 };
        bySource[s].cost   += cost.costUsd;
        bySource[s].events++;

        // 세션별
        const sid = ev.sessionId || ev.session_id || 'unknown';
        if (!bySession[sid]) bySession[sid] = { sessionId: sid, cost: 0, events: 0 };
        bySession[sid].cost   += cost.costUsd;
        bySession[sid].events++;
      }

      res.json({
        period: `${days}일`,
        summary: {
          totalCostUsd:      Math.round(totalCost   * 100000) / 100000,
          totalInputTokens:  totalInput,
          totalOutputTokens: totalOutput,
          totalTokens:       totalInput + totalOutput,
          eventCount:        events.length,
          estimatedRatio:    events.length > 0 ? Math.round(estimatedCount / events.length * 100) : 0,
          avgCostPerEvent:   events.length > 0 ? Math.round(totalCost / events.length * 1000000) / 1000000 : 0,
          avgDailyCost:      Math.round(totalCost / days * 100000) / 100000,
        },
        byModel: Object.values(byModel)
          .sort((a, b) => b.cost - a.cost)
          .map(m => ({ ...m, cost: Math.round(m.cost * 100000) / 100000 })),
        bySource: Object.values(bySource)
          .sort((a, b) => b.cost - a.cost)
          .map(s => ({ ...s, cost: Math.round(s.cost * 100000) / 100000 })),
        topSessions: Object.values(bySession)
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 10)
          .map(s => ({ ...s, cost: Math.round(s.cost * 100000) / 100000 })),
        generatedAt: new Date().toISOString(),
        note: estimatedCount > 0 ? `${estimatedCount}개 이벤트는 추정 토큰 수 사용` : '모든 토큰 수 실측',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 세션별 비용 ──────────────────────────────────────────────────────────
  router.get('/costs/by-session', optionalAuth, async (req, res) => {
    try {
      const limit    = Math.min(parseInt(req.query.limit) || 20, 100);
      // 사용자별 이벤트/세션 필터링 (없으면 전체 폴백)
      const events   = getEventsForUser ? await getEventsForUser(resolveUserId(req)) : getAllEvents();
      const sessions = getSessionsForUser ? await getSessionsForUser(resolveUserId(req)) : (getSessions ? getSessions() : []);

      const sessionCosts = {};
      for (const ev of events) {
        const sid = ev.sessionId || ev.session_id || 'unknown';
        if (!sessionCosts[sid]) sessionCosts[sid] = { sessionId: sid, cost: 0, events: 0, inputTokens: 0, outputTokens: 0, firstTs: ev.timestamp, lastTs: ev.timestamp };
        const cost = extractCostFromEvent(ev);
        sessionCosts[sid].cost         += cost.costUsd;
        sessionCosts[sid].inputTokens  += cost.inputTokens;
        sessionCosts[sid].outputTokens += cost.outputTokens;
        sessionCosts[sid].events++;
        if (ev.timestamp > sessionCosts[sid].lastTs) sessionCosts[sid].lastTs = ev.timestamp;
      }

      // 세션 메타데이터 병합
      const sessionMeta = {};
      for (const s of sessions) sessionMeta[s.id] = s;

      const result = Object.values(sessionCosts)
        .sort((a, b) => b.cost - a.cost)
        .slice(0, limit)
        .map(s => ({
          ...s,
          cost: Math.round(s.cost * 100000) / 100000,
          source: sessionMeta[s.sessionId]?.source || 'unknown',
          durationMin: sessionMeta[s.sessionId]
            ? Math.round((new Date(s.lastTs) - new Date(s.firstTs)) / 60000)
            : null,
        }));

      res.json({ sessions: result, total: Object.keys(sessionCosts).length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 도구별 비용 ──────────────────────────────────────────────────────────
  router.get('/costs/by-tool', optionalAuth, async (req, res) => {
    try {
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const events = getEventsForUser ? await getEventsForUser(resolveUserId(req)) : getAllEvents();
      const toolCosts = {};

      for (const ev of events) {
        let data = {};
        try { data = typeof ev.data === 'string' ? JSON.parse(ev.data) : (ev.data || {}); } catch {}
        const toolName = data.tool_name || data.toolName || ev.type || 'unknown';
        if (!toolCosts[toolName]) toolCosts[toolName] = { tool: toolName, cost: 0, events: 0, inputTokens: 0, outputTokens: 0 };
        const cost = extractCostFromEvent(ev);
        toolCosts[toolName].cost         += cost.costUsd;
        toolCosts[toolName].inputTokens  += cost.inputTokens;
        toolCosts[toolName].outputTokens += cost.outputTokens;
        toolCosts[toolName].events++;
      }

      res.json({
        tools: Object.values(toolCosts)
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 30)
          .map(t => ({ ...t, cost: Math.round(t.cost * 100000) / 100000 })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 날짜별 비용 추이 ─────────────────────────────────────────────────────
  router.get('/costs/by-date', optionalAuth, async (req, res) => {
    try {
      const days   = parseInt(req.query.days) || 30;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const rawEvents = getEventsForUser ? await getEventsForUser(resolveUserId(req)) : getAllEvents();
      const events = rawEvents.filter(e => e.timestamp >= cutoff);

      const daily = {};
      for (const ev of events) {
        const date = ev.timestamp?.slice(0, 10) || 'unknown';
        if (!daily[date]) daily[date] = { date, cost: 0, events: 0, inputTokens: 0, outputTokens: 0 };
        const cost = extractCostFromEvent(ev);
        daily[date].cost         += cost.costUsd;
        daily[date].inputTokens  += cost.inputTokens;
        daily[date].outputTokens += cost.outputTokens;
        daily[date].events++;
      }

      // 모든 날짜 채우기 (이벤트 없는 날 = 0)
      const result = [];
      for (let i = days - 1; i >= 0; i--) {
        const d    = new Date(Date.now() - i * 86400000);
        const date = d.toISOString().slice(0, 10);
        result.push(daily[date] || { date, cost: 0, events: 0, inputTokens: 0, outputTokens: 0 });
      }

      res.json({
        days,
        series: result.map(d => ({ ...d, cost: Math.round(d.cost * 100000) / 100000 })),
        totalCost: Math.round(result.reduce((s, d) => s + d.cost, 0) * 100000) / 100000,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 비용 수동 기록 (Claude Code hooks에서 토큰 수 전송) ─────────────────
  router.post('/costs/record', (req, res) => {
    try {
      const { eventId, sessionId, model, inputTokens, outputTokens } = req.body;
      if (!eventId) return res.status(400).json({ error: 'eventId 필요' });

      const prices  = getPriceForModel(model || 'default');
      const inTok   = parseInt(inputTokens)  || 0;
      const outTok  = parseInt(outputTokens) || 0;
      const costUsd = ((inTok * prices.input) + (outTok * prices.output)) / 1000;

      costLedger.set(eventId, {
        eventId, sessionId, modelId: model, inputTokens: inTok, outputTokens: outTok, costUsd,
        isEstimated: false, recordedAt: new Date().toISOString(),
      });

      res.json({ ok: true, costUsd: Math.round(costUsd * 1000000) / 1000000 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 현재 세션 비용 추정 ──────────────────────────────────────────────────
  router.get('/costs/estimate', optionalAuth, async (req, res) => {
    try {
      const sessionId = req.query.sessionId;
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const rawEvents = getEventsForUser ? await getEventsForUser(resolveUserId(req)) : getAllEvents();
      const events    = rawEvents.filter(e => !sessionId || (e.sessionId || e.session_id) === sessionId);
      const today     = new Date().toISOString().slice(0, 10);
      const todayEvs  = events.filter(e => e.timestamp?.slice(0, 10) === today);

      let totalCost = 0;
      for (const ev of todayEvs) {
        const cost = costLedger.get(ev.id) || extractCostFromEvent(ev);
        totalCost += cost.costUsd;
      }

      // 월 예상 비용 (오늘까지의 평균 기반)
      const dayOfMonth   = new Date().getDate();
      const monthlyGuess = dayOfMonth > 0 ? (totalCost / dayOfMonth) * 30 : 0;

      res.json({
        sessionId: sessionId || 'all',
        todayEvents: todayEvs.length,
        todayCostUsd: Math.round(totalCost * 100000) / 100000,
        estimatedMonthlyCostUsd: Math.round(monthlyGuess * 100) / 100,
        pricingNote: '추정치입니다. 실제 청구 금액과 다를 수 있습니다.',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 가격 테이블 조회 ─────────────────────────────────────────────────────
  router.get('/costs/prices', (req, res) => {
    res.json({
      models: Object.entries(TOKEN_PRICES).map(([model, p]) => ({
        model,
        inputPer1k:  p.input,
        outputPer1k: p.output,
        currency:    'USD',
      })),
      updatedAt: '2026-02-28',
    });
  });

  return router;
}

module.exports = createCostTrackerRouter;
