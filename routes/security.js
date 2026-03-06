/**
 * routes/security.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 보안 관련 API 라우터 (Shadow AI 감지, 감사 로그)
 *
 * 담당 엔드포인트:
 *   GET  /api/shadow-ai              - Shadow AI 감지 결과 조회
 *   GET  /api/shadow-ai/approved     - 승인된 AI 소스 목록
 *   POST /api/shadow-ai/approved     - AI 소스 승인 추가/제거
 *   GET  /api/audit                  - 감사 로그 조회 (JSON 또는 HTML)
 *   GET  /api/audit/verify           - 감사 로그 무결성 검증
 *   GET  /api/audit/report           - 감사 리포트 HTML 출력
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.db              - { getAllEvents, getEventsByChannel }
 * @param {object} deps.shadowAiDetector - { detectShadowAI, getApprovedSources, addApprovedSource, removeApprovedSource }
 * @param {object} deps.auditLog        - { queryAuditLog, verifyIntegrity, renderAuditHtml }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { db, shadowAiDetector, auditLog, getEventsForUser, resolveUserId } = deps;

  const { getAllEvents, getEventsByChannel } = db;

  // 사용자별 이벤트 조회 헬퍼
  function _getUserEvents(req) {
    const uid = resolveUserId ? resolveUserId(req) : 'local';
    return (getEventsForUser && uid !== 'local') ? getEventsForUser(uid) : getAllEvents();
  }
  const { detectShadowAI, getApprovedSources, addApprovedSource, removeApprovedSource } = shadowAiDetector;
  const { queryAuditLog, verifyIntegrity, renderAuditHtml } = auditLog;

  // ── Shadow AI 감지 ───────────────────────────────────────────────────────

  /**
   * GET /api/shadow-ai?channel=X&hours=168
   * 지정된 시간 윈도우 내에서 비승인 AI 도구 사용을 탐지합니다.
   * 기본 168시간(7일) 분석.
   *
   * @query {string} [channel] - 채널 필터 (미지정 시 전체)
   * @query {string} [hours]   - 탐색 시간 윈도우 (기본값: 168 = 7일)
   * @returns {{ findings: ShadowAiFinding[], checkedEvents: number, windowHours: number }}
   */
  router.get('/shadow-ai', (req, res) => {
    const { channel, hours } = req.query;

    const userEvents = _getUserEvents(req);
    let events = channel
      ? (getEventsByChannel ? getEventsByChannel(channel) : userEvents.filter(e => e.channelId === channel))
      : userEvents;

    const h      = parseInt(hours || '168');
    const cutoff = Date.now() - h * 3600 * 1000;
    events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

    const findings = detectShadowAI(events);
    res.json({ findings, checkedEvents: events.length, windowHours: h });
  });

  /**
   * GET /api/shadow-ai/approved
   * 팀에서 공식 승인한 AI 소스 목록을 반환합니다.
   * @returns {{ approved: string[] }}
   */
  router.get('/shadow-ai/approved', (req, res) => {
    res.json({ approved: getApprovedSources() });
  });

  /**
   * POST /api/shadow-ai/approved
   * AI 소스를 승인 목록에 추가하거나 제거합니다.
   * @body {string} source - AI 소스 식별자 (필수)
   * @body {string} [action] - 'remove' 이면 제거, 기본값은 추가
   * @returns {{ ok: boolean, action: 'added' | 'removed', source: string }}
   */
  router.post('/shadow-ai/approved', (req, res) => {
    const { source, action } = req.body;
    if (!source) return res.status(400).json({ error: 'source required' });

    if (action === 'remove') {
      removeApprovedSource(source);
      res.json({ ok: true, action: 'removed', source });
    } else {
      addApprovedSource(source);
      res.json({ ok: true, action: 'added', source });
    }
  });

  // ── 감사 로그 ─────────────────────────────────────────────────────────────

  /**
   * GET /api/audit?from=ISO&to=ISO&type=X&channel=Y&format=html
   * 감사 로그를 조건 필터로 조회합니다.
   * format=html 이면 렌더링된 HTML을 반환합니다 (브라우저에서 직접 열기용).
   *
   * @query {string} [from]     - 시작 시간 (ISO 8601)
   * @query {string} [to]       - 종료 시간 (ISO 8601)
   * @query {string} [type]     - 이벤트 타입 필터
   * @query {string} [channel]  - 채널 필터
   * @query {string} [memberId] - 멤버 ID 필터
   * @query {string} [limit]    - 최대 결과 수 (기본값: 1000)
   * @query {string} [format]   - 'html' 이면 HTML 응답
   * @returns {{ entries: AuditEntry[], total: number } | HTML}
   */
  router.get('/audit', (req, res) => {
    const { from, to, type, channel, memberId, limit, format } = req.query;
    const entries = queryAuditLog({
      from, to, type, channel, memberId,
      limit: parseInt(limit || '1000'),
    });

    if (format === 'html') {
      return res.type('text/html').send(renderAuditHtml(entries, { from, to }));
    }
    res.json({ entries, total: entries.length });
  });

  /**
   * GET /api/audit/verify
   * 감사 로그의 해시 체인 무결성을 검증합니다.
   * 조작된 로그 항목이 있으면 tampered: true 와 함께 위치 정보를 반환합니다.
   * @returns {{ ok: boolean, tampered: boolean, details?: object }}
   */
  router.get('/audit/verify', (req, res) => {
    const result = verifyIntegrity();
    res.json(result);
  });

  /**
   * GET /api/audit/report?from=ISO&to=ISO&channel=X
   * 지정 기간의 감사 리포트를 HTML로 렌더링합니다.
   * 브라우저에서 직접 열어 PDF로 출력하거나 이메일 첨부용으로 활용합니다.
   * @query {string} [from]    - 시작 시간
   * @query {string} [to]      - 종료 시간
   * @query {string} [channel] - 채널 필터
   * @returns {HTML}
   */
  router.get('/audit/report', (req, res) => {
    const { from, to, channel } = req.query;
    const entries = queryAuditLog({ from, to, channel, limit: 2000 });
    const html = renderAuditHtml(entries, { from, to, title: 'Orbit AI 감사 리포트' });
    res.type('text/html').send(html);
  });

  return router;
}

module.exports = createRouter;
