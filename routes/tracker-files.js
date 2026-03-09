/**
 * routes/tracker-files.js
 * ─────────────────────────────────────────────────────────────────
 * 파일 추적 API 라우터
 *
 * 엔드포인트:
 *   POST /api/tracker/files/sync     - 수동 동기화
 *   GET  /api/tracker/files/summary  - 일일 요약
 *   GET  /api/tracker/files/history  - 변경 이력
 *   GET  /api/tracker/files/{date}   - 특정 날짜 데이터
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

function createRouter({ verifyToken, syncScheduler }) {
  // ── 인증 미들웨어 ────────────────────────────────────────────────
  function authRequired(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'token required' });

    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });

    req.user = user;
    next();
  }

  // ── POST /api/tracker/files/sync ─────────────────────────────────
  /**
   * 수동 파일 동기화
   * 클라이언트에서 명시적으로 동기화 요청할 때 사용
   */
  router.post('/files/sync', authRequired, async (req, res) => {
    try {
      if (!syncScheduler) {
        return res.status(503).json({ error: 'Sync scheduler not available' });
      }

      const result = await syncScheduler.manualSync();

      res.json({
        ok: true,
        message: 'Sync completed',
        data: {
          date: result.date,
          fileChanges: result.files.length,
          messageCount: result.messages.summary?.totalMessages || 0,
          timestamp: result.timestamp,
        },
      });
    } catch (e) {
      console.error('[tracker-files/sync]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/tracker/files/summary ──────────────────────────────
  /**
   * 오늘 파일 변경 요약
   */
  router.get('/files/summary', authRequired, (req, res) => {
    try {
      if (!syncScheduler || !syncScheduler.fileWatcher) {
        return res.json({
          date: new Date().toISOString().split('T')[0],
          totalChanges: 0,
          byCategory: {},
          byChangeType: { created: 0, modified: 0, deleted: 0 },
        });
      }

      const summary = syncScheduler.fileWatcher.generateDailySummary();

      res.json({
        date: summary.date,
        totalChanges: summary.todayChanges,
        trackedFiles: summary.totalFiles,
        byCategory: summary.byCategory,
        byChangeType: summary.byChangeType,
      });
    } catch (e) {
      console.error('[tracker-files/summary]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/tracker/files/history ─────────────────────────────
  /**
   * 오늘 파일 변경 이력 (최근 50개)
   */
  router.get('/files/history', authRequired, (req, res) => {
    try {
      if (!syncScheduler || !syncScheduler.fileWatcher) {
        return res.json({ changes: [] });
      }

      const changes = syncScheduler.fileWatcher.getDailyChanges();
      const limited = changes.slice(-50);  // 최근 50개

      res.json({
        date: new Date().toISOString().split('T')[0],
        count: limited.length,
        changes: limited.map(c => ({
          path: c.path,
          name: c.name,
          ext: c.ext,
          category: c.category,
          program: c.program,
          type: c.change.type,
          sizeChange: c.change.sizeChange,
          linesChange: c.change.linesChange,
          timestamp: c.timestamp,
        })),
      });
    } catch (e) {
      console.error('[tracker-files/history]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/tracker/files/:date ─────────────────────────────────
  /**
   * 특정 날짜의 파일 데이터 조회 (로컬 캐시에서)
   * 형식: YYYY-MM-DD
   */
  router.get('/files/:date', authRequired, (req, res) => {
    try {
      if (!syncScheduler) {
        return res.status(503).json({ error: 'Sync scheduler not available' });
      }

      const { date } = req.params;
      const dataDir = path.join(require('os').homedir(), '.orbit-tracker');
      const filePath = path.join(dataDir, `tracker-${date}.json`);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Data not found for this date' });
      }

      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      res.json({
        date: data.date,
        fileChanges: data.files.length,
        filesByCategory: data.fileSummary?.byCategory || {},
        filesByType: data.fileSummary?.byChangeType || {},
        messageCount: data.messageSummary?.totalMessages || 0,
        files: data.files.map(f => ({
          path: f.path,
          name: f.name,
          ext: f.ext,
          category: f.category,
          program: f.program,
          type: f.change.type,
          sizeChange: f.change.sizeChange,
          linesChange: f.change.linesChange,
        })),
      });
    } catch (e) {
      console.error('[tracker-files/:date]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/tracker/files/status ────────────────────────────────
  /**
   * 파일 감시 상태 조회
   */
  router.get('/files/status', authRequired, (req, res) => {
    try {
      if (!syncScheduler) {
        return res.json({
          isInitialized: false,
          message: 'Sync scheduler not available',
        });
      }

      const status = syncScheduler.getStatus();

      res.json({
        isInitialized: status.isInitialized,
        trackedFiles: status.fileWatcher?.trackedFiles || 0,
        dailyChanges: status.fileWatcher?.dailyChanges || 0,
        lastActiveApp: status.fileWatcher?.lastActiveApp || 'Unknown',
        nextSyncTime: status.nextSyncTime,
      });
    } catch (e) {
      console.error('[tracker-files/status]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createRouter;
