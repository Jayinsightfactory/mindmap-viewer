/**
 * routes/analysis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 코드 복잡도 분석 + Context Bridge API 라우터
 *
 * 담당 엔드포인트:
 *   POST /api/analyze          - 코드 문자열 복잡도 분석
 *   GET  /api/analyze          - 파일 경로로 복잡도 분석
 *   GET  /api/analyze-project  - 프로젝트 전체 파일 일괄 분석
 *   GET  /api/context/bridge   - 컨텍스트 추출 (Markdown/Prompt 포맷 지원)
 *   GET  /api/conflicts        - 파일/이벤트 충돌 감지
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

// 프로젝트 분석 시 제외할 디렉토리/파일 패턴
const IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', 'tests'];

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.db             - { getAllEvents, getEventsBySession, getEventsByChannel }
 * @param {object} deps.codeAnalyzer   - { generateReport }
 * @param {object} deps.contextBridge  - { extractContext, renderContextMd, renderContextPrompt, saveContextFile }
 * @param {object} deps.conflictDetector - { detectConflicts }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { db, codeAnalyzer, contextBridge, conflictDetector, getEventsForUser, resolveUserId } = deps;

  const { getAllEvents, getEventsBySession, getEventsByChannel } = db;

  // 사용자별 이벤트 조회 헬퍼
  function _getUserEvents(req) {
    const uid = resolveUserId ? resolveUserId(req) : 'local';
    return (getEventsForUser && uid !== 'local') ? getEventsForUser(uid) : getAllEvents();
  }
  const { generateReport } = codeAnalyzer;
  const { extractContext, renderContextMd, renderContextPrompt, saveContextFile } = contextBridge;
  const { detectConflicts } = conflictDetector;

  // ── 코드 복잡도 분석 ─────────────────────────────────────────────────────

  /**
   * POST /api/analyze
   * 코드 문자열을 받아 순환 복잡도, 줄 수, 리팩토링 제안을 분석합니다.
   * @body {string} code     - 분석할 코드 (필수)
   * @body {string} filename - 파일명 (그레이드 리포트 표시용, 기본값: 'unknown')
   * @returns {CodeReport} { complexity, grade, lines, functions, suggestions[] }
   */
  router.post('/analyze', (req, res) => {
    const { code, filename = 'unknown' } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code 필드 필요' });
    try {
      const report = generateReport(code, filename);
      console.log(`[ANALYZE] ${filename} → 복잡도 ${report.complexity}, 등급 ${report.grade}`);
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/analyze?file=<절대경로>
   * 로컬 파일을 읽어 복잡도 분석을 수행합니다.
   * @query {string} file - 분석할 파일의 절대 경로 (필수)
   * @returns {CodeReport}
   */
  router.get('/analyze', (req, res) => {
    const filePath = req.query.file;
    if (!filePath) return res.status(400).json({ error: 'file 쿼리 파라미터 필요' });
    try {
      const code   = fs.readFileSync(filePath, 'utf8');
      const report = generateReport(code, path.basename(filePath));
      console.log(`[ANALYZE] ${filePath} → 복잡도 ${report.complexity}, 등급 ${report.grade}`);
      res.json(report);
    } catch (e) {
      res.status(404).json({ error: `파일 읽기 실패: ${e.message}` });
    }
  });

  /**
   * GET /api/analyze-project?dir=<경로>&ext=js,ts
   * 지정 디렉토리의 파일을 최대 30개까지 일괄 분석합니다.
   * @query {string} [dir] - 분석 루트 디렉토리 (기본값: 서버 루트)
   * @query {string} [ext] - 확장자 목록, 쉼표 구분 (기본값: 'js')
   * @returns {{ reports: CodeReport[], avgComplexity: number, gradeCount: object, fileCount: number }}
   */
  router.get('/analyze-project', (req, res) => {
    const dir  = req.query.dir || path.resolve(__dirname, '..');
    const exts = (req.query.ext || 'js').split(',');

    /**
     * 디렉토리를 재귀 탐색하여 파일 목록을 수집합니다.
     * @param {string} d - 탐색 디렉토리 경로
     * @returns {string[]} 파일 절대 경로 배열
     */
    function collectFiles(d) {
      let results = [];
      try {
        for (const entry of fs.readdirSync(d)) {
          if (IGNORE_DIRS.some(ig => entry.startsWith(ig))) continue;
          const full = path.join(d, entry);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) results = results.concat(collectFiles(full));
          else if (exts.some(e => entry.endsWith('.' + e))) results.push(full);
        }
      } catch {}
      return results;
    }

    const files   = collectFiles(dir).slice(0, 30); // 최대 30개
    const reports = files.map(f => {
      try {
        const code = fs.readFileSync(f, 'utf8');
        return generateReport(code, path.relative(dir, f));
      } catch {
        return null;
      }
    }).filter(Boolean);

    // 프로젝트 전체 요약
    const avgComplexity = reports.length
      ? Math.round(reports.reduce((s, r) => s + r.complexity, 0) / reports.length)
      : 0;
    const gradeCount = ['A', 'B', 'C', 'D', 'F'].reduce((acc, g) => {
      acc[g] = reports.filter(r => r.grade === g).length;
      return acc;
    }, {});

    res.json({ reports, avgComplexity, gradeCount, fileCount: reports.length });
  });

  // ── Context Bridge ────────────────────────────────────────────────────────

  /**
   * GET /api/context/bridge?session=X&channel=Y&format=markdown&save=1
   * 현재 작업 컨텍스트(최근 2시간)를 AI 프롬프트 형식으로 추출합니다.
   * Claude, Cursor 등 AI 툴에서 "지금 무엇을 하고 있나요?" 컨텍스트 주입에 활용됩니다.
   *
   * @query {string} [session]  - 특정 세션으로 필터
   * @query {string} [channel]  - 특정 채널로 필터
   * @query {string} [format]   - 'markdown' | 'prompt' | (기본값: JSON)
   * @query {string} [save]     - '1' 또는 디렉토리 경로 → ORBIT_CONTEXT.md 저장
   * @returns {Context | string}
   */
  router.get('/context/bridge', (req, res) => {
    const { session, channel, format, save } = req.query;

    // 이벤트 소스 결정 (session > channel > 사용자별 전체)
    const userEvents = _getUserEvents(req);
    let events = session
      ? getEventsBySession(session)
      : channel
        ? (getEventsByChannel ? getEventsByChannel(channel) : userEvents.filter(e => e.channelId === channel))
        : userEvents;

    // 최근 2시간으로 제한 (컨텍스트 과부하 방지)
    const cutoff = Date.now() - 2 * 3600 * 1000;
    events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

    // 이벤트가 없으면 최근 100개로 fallback
    if (!events.length) events = userEvents.slice(-100);

    const ctx = extractContext(events, { sessionId: session });

    // 파일 저장 요청
    if (save) {
      const targetDir = save === '1' ? process.cwd() : save;
      try {
        saveContextFile(ctx, targetDir);
        return res.json({ ok: true, saved: path.join(targetDir, 'ORBIT_CONTEXT.md'), ctx });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // 포맷별 응답
    if (format === 'markdown') return res.type('text/plain').send(renderContextMd(ctx));
    if (format === 'prompt')   return res.type('text/plain').send(renderContextPrompt(ctx));
    res.json(ctx);
  });

  // ── 충돌 감지 ────────────────────────────────────────────────────────────

  /**
   * GET /api/conflicts?channel=X&hours=24
   * 지정 시간 윈도우 내에서 파일/이벤트 충돌(동시 편집, 브랜치 충돌 등)을 감지합니다.
   * @query {string} [channel] - 채널 필터
   * @query {string} [hours]   - 탐색 시간 윈도우 (기본값: 24)
   * @returns {{ conflicts: Conflict[], checkedEvents: number, windowHours: number }}
   */
  router.get('/conflicts', (req, res) => {
    const { channel, hours } = req.query;

    const userEvents = _getUserEvents(req);
    let events = channel
      ? (getEventsByChannel ? getEventsByChannel(channel) : userEvents.filter(e => e.channelId === channel))
      : userEvents;

    const h      = parseInt(hours || '24');
    const cutoff = Date.now() - h * 3600 * 1000;
    events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

    const conflicts = detectConflicts(events);
    res.json({ conflicts, checkedEvents: events.length, windowHours: h });
  });

  return router;
}

module.exports = createRouter;
