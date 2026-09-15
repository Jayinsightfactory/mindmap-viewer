'use strict';

/**
 * routes/purposes.js
 * 목적(Purpose) 타임라인 API
 *
 * GET /api/purposes/timeline   → 목적 목록 (최신순, 파일/gitHash 포함)
 * GET /api/purposes/sessions   → 세션별 목적 요약
 */

const { Router } = require('express');
const { groupEventsByPurpose } = require('../src/purpose-engine');

module.exports = function createPurposesRouter({ getAllEvents, getEventsBySession, getSessions, getEventsForUser, getSessionsForUser, resolveUserId }) {
  const router = Router();

  // 사용자별 세션 조회 헬퍼 — getSessionsForUser는 async(Promise)라 반드시 await한다.
  // (await 없이 Promise를 넘겨 sessions.slice가 500 나던 버그 수정 2026-09-15)
  async function _getSes(req) {
    const uid = resolveUserId ? resolveUserId(req) : 'local';
    const raw = (getSessionsForUser && uid !== 'local')
      ? await getSessionsForUser(uid)
      : (typeof getSessions === 'function' ? await Promise.resolve(getSessions()) : []);
    return Array.isArray(raw) ? raw : []; // 어떤 경로든 배열 보장
  }

  // ── 목적 타임라인 ────────────────────────────────────────────────────────────
  // GET /api/purposes/timeline?session_id=xxx&limit=50
  router.get('/purposes/timeline', async (req, res) => {
    try {
      const limit     = Math.min(parseInt(req.query.limit) || 50, 200);
      const sessionId = req.query.session_id;

      let purposes = [];

      if (sessionId && typeof getEventsBySession === 'function') {
        // 특정 세션: 해당 세션 이벤트만
        const events = getEventsBySession(sessionId);
        purposes = groupEventsByPurpose(events, { limit });
      } else {
        // 전체: 사용자별 세션으로 분리 처리 후 합산
        const sessions = await _getSes(req);
        const perSess  = sessions.slice(0, 10).map(sess => {
          try {
            const evs = typeof getEventsBySession === 'function'
              ? getEventsBySession(sess.id) : [];
            return groupEventsByPurpose(evs, { limit: Math.ceil(limit / sessions.length) + 5 });
          } catch { return []; }
        });
        purposes = perSess.flat()
          .sort((a, b) => new Date(b.startTs || 0) - new Date(a.startTs || 0))
          .slice(0, limit);
      }

      res.json({ purposes, total: purposes.length });
    } catch (e) {
      console.error('[purposes/timeline]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── 세션별 목적 요약 ─────────────────────────────────────────────────────────
  // GET /api/purposes/sessions
  router.get('/purposes/sessions', async (req, res) => {
    try {
      const sessions = await _getSes(req);

      const result = sessions.slice(0, 30).map(sess => {
        let events = [];
        try {
          events = typeof getEventsBySession === 'function'
            ? getEventsBySession(sess.id)
            : [];
        } catch {}

        const purposes = groupEventsByPurpose(events, { limit: 200 });

        // 가장 많이 나온 purposeId (대표 목적)
        const countMap = {};
        purposes.forEach(p => { countMap[p.purposeId] = (countMap[p.purposeId] || 0) + 1; });
        const topId = Object.entries(countMap).sort((a, b) => b[1] - a[1])[0]?.[0];
        const topP  = purposes.find(p => p.purposeId === topId);

        // 멀티봇 감지
        const allAgents = [...new Set(purposes.flatMap(p => p.agentSources || []))];

        return {
          sessionId:    sess.id,
          sessionTitle: sess.title || `세션-${sess.id.slice(0, 6)}`,
          purposeCount: purposes.length,
          topPurpose:   topP ? { label: topP.label, icon: topP.icon, color: topP.color } : null,
          eventCount:   events.length,
          startedAt:    sess.started_at || sess.startedAt || sess.createdAt,
          agents:       allAgents,
        };
      });

      res.json({ sessions: result });
    } catch (e) {
      console.error('[purposes/sessions]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
