'use strict';
/**
 * routes/event-bus.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 통합 이벤트 버스 API 라우터
 *
 * 엔드포인트:
 *   POST /api/events/publish     — 이벤트 발행
 *   GET  /api/events/subscribe   — SSE 구독 (실시간 스트림)
 *   GET  /api/events/query       — 이벤트 조회 (필터링)
 *   GET  /api/events/stats       — 이벤트 통계
 *   GET  /api/events/health      — 이벤트 버스 상태
 * ─────────────────────────────────────────────────────────────────────────────
 */
const express = require('express');
const router = express.Router();

/**
 * @param {object} deps
 * @param {object} deps.eventBus    — src/event-bus.js 모듈
 * @param {Function} deps.verifyToken — 인증 토큰 검증 함수
 * @param {Function} deps.broadcastAll — WebSocket 브로드캐스트 (선택)
 */
function createRouter(deps) {
  const { eventBus, verifyToken, broadcastAll } = deps;

  // ── 인증 미들웨어 (API 토큰 또는 Bearer 토큰) ──────────────────────────
  const authenticate = (req, res, next) => {
    // 1) Authorization 헤더
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    // 2) 쿼리 파라미터
    const queryToken = req.query.token;

    const t = token || queryToken;
    if (!t) return res.status(401).json({ error: 'Authentication required' });

    // nenova_agent 전용 API 토큰 (환경변수와 비교)
    if (process.env.AGENT_API_TOKEN && t === process.env.AGENT_API_TOKEN) {
      req.agentAuth = true;
      req.userId = 'nenova-agent';
      return next();
    }

    // Orbit 토큰 검증
    if (verifyToken) {
      const user = verifyToken(t);
      if (user) {
        req.userId = user.id;
        req.user = user;
        return next();
      }
    }

    return res.status(401).json({ error: 'Invalid token' });
  };

  // ── POST /api/events/publish — 이벤트 발행 ─────────────────────────────
  router.post('/events/publish', authenticate, async (req, res) => {
    try {
      const events = Array.isArray(req.body) ? req.body : [req.body];

      if (events.length > 100) {
        return res.status(400).json({ error: 'Max 100 events per request' });
      }

      const results = [];
      for (const evt of events) {
        if (!evt.type) {
          results.push({ error: 'type is required' });
          continue;
        }

        const saved = await eventBus.publish({
          ...evt,
          user_id: evt.user_id || req.userId,
        });
        results.push({ id: saved.id, type: saved.type, status: 'published' });
      }

      // WebSocket 으로도 알림 (Orbit 내부 연동)
      if (broadcastAll && results.length > 0) {
        broadcastAll({
          type: 'unified_event',
          data: { count: results.length, latest: results[results.length - 1] }
        });
      }

      res.json({
        published: results.filter(r => r.status === 'published').length,
        errors: results.filter(r => r.error).length,
        results,
      });
    } catch (e) {
      console.error('[EventBus] publish 오류:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/events/subscribe — SSE 실시간 스트림 ───────────────────────
  router.get('/events/subscribe', authenticate, (req, res) => {
    // SSE 헤더 설정
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',  // Nginx 버퍼링 비활성화
    });

    const filters = {};
    if (req.query.source) filters.source = req.query.source;
    if (req.query.type) filters.type = req.query.type;
    if (req.query.user_id) filters.user_id = req.query.user_id;

    const clientId = eventBus.addSSEClient(res, filters);

    // 30초 간격 keepalive
    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
    }, 30000);

    req.on('close', () => clearInterval(keepalive));
  });

  // ── GET /api/events/query — 이벤트 조회 ─────────────────────────────────
  router.get('/events/query', authenticate, async (req, res) => {
    try {
      const filters = {
        type: req.query.type,
        source: req.query.source,
        user_id: req.query.user_id,
        correlation_id: req.query.correlation_id,
        since: req.query.since,
        until: req.query.until,
        limit: req.query.limit,
        offset: req.query.offset,
      };

      const events = await eventBus.query(filters);
      res.json({ count: events.length, events });
    } catch (e) {
      console.error('[EventBus] query 오류:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/events/stats — 이벤트 통계 ─────────────────────────────────
  router.get('/events/stats', authenticate, async (req, res) => {
    try {
      const s = await eventBus.stats();
      s.sseClients = eventBus.clientCount();
      res.json(s);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/events/health — 이벤트 버스 상태 ───────────────────────────
  router.get('/events/health', (req, res) => {
    res.json({
      status: 'ok',
      sseClients: eventBus.clientCount(),
      validSources: [...eventBus.VALID_SOURCES],
    });
  });

  return router;
}

module.exports = createRouter;
