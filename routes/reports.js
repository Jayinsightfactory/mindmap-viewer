/**
 * routes/reports.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 리포트 생성 API 라우터 (일일/주간 요약, Slack 블록 포맷 지원)
 *
 * 담당 엔드포인트:
 *   GET /api/report/daily   - 일일 리포트 (JSON / Markdown / Slack 블록)
 *   GET /api/report/weekly  - 주간 리포트 (최근 7일)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.db              - { getAllEvents, getEventsByChannel }
 * @param {object} deps.reportGenerator - { buildReportData, renderMarkdown, renderSlackBlocks }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { db, reportGenerator } = deps;

  const { getAllEvents, getEventsByChannel } = db;
  const { buildReportData, renderMarkdown, renderSlackBlocks } = reportGenerator;

  // ── 일일 리포트 ──────────────────────────────────────────────────────────

  /**
   * GET /api/report/daily?from=ISO&to=ISO&channel=X&format=markdown
   * 지정 기간의 활동 요약 리포트를 생성합니다.
   * format 파라미터로 출력 형식을 선택할 수 있습니다.
   *
   * 활용 예시:
   *   - Slack 봇: format=slack → 블록 포맷으로 메시지 전송
   *   - 이메일: format=markdown → Markdown 텍스트
   *   - 대시보드: format 미지정 → JSON 데이터
   *
   * @query {string} [from]    - 시작 시간 (ISO 8601)
   * @query {string} [to]      - 종료 시간 (ISO 8601)
   * @query {string} [channel] - 채널 필터
   * @query {string} [format]  - 'markdown' | 'slack' | (기본값: JSON)
   * @returns {ReportData | string | SlackBlock[]}
   */
  router.get('/report/daily', (req, res) => {
    const { from, to, channel, format } = req.query;

    let events = channel
      ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
      : getAllEvents();

    // 시간 범위 필터 적용
    if (from || to) {
      const fromTs = from ? new Date(from).getTime() : 0;
      const toTs   = to   ? new Date(to).getTime()   : Infinity;
      events = events.filter(e => {
        const t = new Date(e.timestamp).getTime();
        return t >= fromTs && t <= toTs;
      });
    }

    if (!events.length) return res.json({ error: 'no events', events: 0 });

    const data = buildReportData(events, { from, to });

    if (format === 'markdown') return res.type('text/plain').send(renderMarkdown(data));
    if (format === 'slack')    return res.json(renderSlackBlocks(data));
    res.json(data);
  });

  // ── 주간 리포트 ──────────────────────────────────────────────────────────

  /**
   * GET /api/report/weekly?channel=X
   * 최근 7일간의 활동 요약 리포트를 생성합니다.
   * @query {string} [channel] - 채널 필터
   * @returns {ReportData}
   */
  router.get('/report/weekly', (req, res) => {
    const { channel } = req.query;
    const now     = Date.now();
    const cutoff  = now - 7 * 24 * 3600 * 1000;
    const from    = new Date(cutoff).toISOString();

    let events = channel
      ? (getEventsByChannel ? getEventsByChannel(channel) : getAllEvents().filter(e => e.channelId === channel))
      : getAllEvents();

    events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

    const data = buildReportData(events, { from, period: 'weekly' });
    res.json(data);
  });

  return router;
}

module.exports = createRouter;
