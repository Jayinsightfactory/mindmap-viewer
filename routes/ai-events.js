/**
 * routes/ai-events.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 멀티 AI 이벤트 수신 및 AI 소스 관리 라우터
 *
 * 담당 엔드포인트:
 *   POST /api/ai-event    - AI 어댑터(Gemini, OpenAI, Cursor 등)의 이벤트 수신
 *   GET  /api/ai-sources  - 지원 AI 소스 목록 + 스타일 정보 (프론트 필터 UI용)
 *
 * 사용 시나리오:
 *   adapters/ 폴더의 각 AI 어댑터(gemini-adapter.js, openai-adapter.js 등)가
 *   normalizeAiEvent()로 표준화한 이벤트를 POST /api/ai-event 로 전송합니다.
 *   서버는 DB에 저장 후 모든 WebSocket 클라이언트에 실시간 브로드캐스트합니다.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {Function} deps.broadcastAll - (msg) → void
 * @param {object}   deps.db           - { insertEvent, getAllEvents, getSessions, getStats }
 * @param {object}   deps.aiAdapter    - { getAiStyle, AI_SOURCES }
 * @param {Function} deps.getFullGraph - () → { nodes, edges }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { broadcastAll, db, aiAdapter, getFullGraph } = deps;
  const { insertEvent, getSessions, getStats } = db;
  const { getAiStyle, AI_SOURCES } = aiAdapter;

  // ── 멀티 AI 이벤트 수신 ──────────────────────────────────────────────────

  /**
   * POST /api/ai-event
   * Gemini, Perplexity, OpenAI, VSCode, Cursor 등 외부 AI 어댑터에서 전송하는 이벤트를 수신합니다.
   *
   * 요청 body는 adapters/ai-adapter-base.js 의 normalizeAiEvent() 반환 형식을 따릅니다:
   * {
   *   id:       string,      // 이벤트 고유 ID (UUID 권장)
   *   type:     string,      // 'user.message' | 'tool.start' | 'tool.end' | ...
   *   aiSource: string,      // 'claude' | 'gemini' | 'openai' | 'perplexity' | ...
   *   source:   string,      // 이벤트 발생 소스 (자동 보완: 'ai-adapter')
   *   data:     object,      // 이벤트 상세 데이터 (aiLabel, model 등)
   *   _style:   object       // 시각화 스타일 힌트 (없으면 서버에서 보완)
   * }
   *
   * @returns {{ success: boolean, id: string, aiSource: string, style: object }}
   */
  router.post('/ai-event', (req, res) => {
    const event = req.body;

    // 필수 필드 검증
    if (!event || !event.id || !event.type || !event.aiSource) {
      return res.status(400).json({ error: 'id, type, aiSource 필드 필요' });
    }

    // AI 소스 스타일 결정 (알 수 없는 AI도 허용 — 기본 스타일 사용)
    const style = getAiStyle(event.aiSource);

    // 클라이언트가 _style 힌트를 보내지 않은 경우 서버에서 보완
    if (!event._style) {
      event._style = {
        color:      { background: style.color, border: style.borderColor,
                      highlight: { background: style.color, border: style.borderColor } },
        shape:      style.shape,
        badgeBg:    style.badgeBg,
        badgeColor: style.badgeColor,
      };
    }

    // 필수 DB 필드 보완 (어댑터가 생략한 경우)
    if (!event.source)    event.source    = 'ai-adapter';
    if (!event.userId)    event.userId    = 'local';
    if (!event.channelId) event.channelId = 'default';
    if (!event.metadata)  event.metadata  = {};

    // 메타데이터에 AI 정보 기록 (검색/필터용)
    event.metadata.aiSource = event.aiSource;
    event.metadata.aiLabel  = event.data?.aiLabel || null;
    event.metadata.model    = event.data?.model    || null;

    // DB 저장 (중복 ID는 경고 후 계속)
    try {
      insertEvent(event);
    } catch (e) {
      console.warn('[ai-event] insert 경고:', e.message);
    }

    // 실시간 브로드캐스트 (전체 채널)
    const graph = getFullGraph(null);
    broadcastAll({ type: 'update', graph, sessions: getSessions(), stats: getStats() });

    res.json({ success: true, id: event.id, aiSource: event.aiSource, style });
  });

  // ── AI 소스 목록 ─────────────────────────────────────────────────────────

  /**
   * GET /api/ai-sources
   * 지원되는 모든 AI 소스의 ID와 시각화 스타일을 반환합니다.
   * 프론트엔드의 AI 필터 UI에서 사용합니다.
   *
   * @returns {{ id: string, style: AiStyle }[]}
   */
  router.get('/ai-sources', (req, res) => {
    const sources = Object.values(AI_SOURCES).map(src => ({
      id:    src,
      style: getAiStyle(src),
    }));
    res.json(sources);
  });

  return router;
}

module.exports = createRouter;
