'use strict';

/**
 * routes/personal-learning.js
 * 개인 학습 데이터 수신 + 작업 제안 관리 API
 *
 * POST /api/personal/keyboard       ← keyboard-watcher
 * POST /api/personal/file-content   ← file-learner
 * POST /api/personal/app-activity   ← system-monitor
 * GET  /api/personal/status         ← 오늘 통계
 * POST /api/personal/toggle         ← 기능 on/off
 * GET  /api/personal/suggestions    ← pending 제안 목록
 * POST /api/personal/suggestions/:id/accept
 * POST /api/personal/suggestions/:id/dismiss
 */

const { Router } = require('express');
const { ulid }   = require('ulid');

module.exports = function createPersonalLearningRouter({ getDb, insertEvent, broadcastAll }) {
  const router = Router();

  // ── 공통: 이벤트 저장 헬퍼 ─────────────────────────────────────────────────
  function saveEvent(type, data, sessionId = 'personal') {
    try {
      const event = {
        id:          ulid(),
        type,
        sessionId,
        userId:      'local',
        channelId:   'default',
        source:      'personal-agent',
        timestamp:   new Date().toISOString(),
        data,        // insertEvent 내부에서 JSON.stringify 처리
        metadata:    { aiSource: 'local' },
      };
      if (typeof insertEvent === 'function') insertEvent(event);
      return event;
    } catch {}
  }

  // ── POST /api/personal/keyboard ────────────────────────────────────────────
  router.post('/personal/keyboard', (req, res) => {
    try {
      const { text, app, wordCount, ts } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      saveEvent('keyboard.chunk', { text, app, wordCount, contentPreview: text.slice(0, 100) });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/file-content ───────────────────────────────────────
  router.post('/personal/file-content', (req, res) => {
    try {
      const { filePath, fileName, ext, sizeMB, chunkIndex, totalChunks, text, ts } = req.body;
      if (!text) return res.status(400).json({ error: 'text required' });

      saveEvent('file.content', {
        filePath, fileName, ext, sizeMB,
        chunkIndex: chunkIndex ?? 0,
        totalChunks: totalChunks ?? 1,
        contentPreview: text.slice(0, 100),
        textLength: text.length,
        // 전문 저장
        text,
      });

      res.json({ ok: true, chunkIndex, totalChunks });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/app-activity ───────────────────────────────────────
  router.post('/personal/app-activity', (req, res) => {
    try {
      const { app, title, category, duration, ts } = req.body;
      saveEvent('app.activity', { app, title, category, duration });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/personal/status ──────────────────────────────────────────────
  router.get('/personal/status', (req, res) => {
    try {
      const db  = getDb();
      const day = new Date(Date.now() - 86400_000).toISOString();

      const keyboardChunks = db.prepare(
        `SELECT COUNT(*) as cnt FROM events WHERE type='keyboard.chunk' AND timestamp > ?`
      ).get(day)?.cnt || 0;

      const fileContents = db.prepare(
        `SELECT COUNT(*) as cnt FROM events WHERE type='file.content' AND timestamp > ?`
      ).get(day)?.cnt || 0;

      const appActivities = db.prepare(
        `SELECT COUNT(*) as cnt FROM events WHERE type='app.activity' AND timestamp > ?`
      ).get(day)?.cnt || 0;

      const keywordChars = db.prepare(
        `SELECT SUM(json_extract(data_json,'$.textLength')) as total FROM events WHERE type='keyboard.chunk' AND timestamp > ?`
      ).get(day)?.total || 0;

      const pendingSuggestions = db.prepare(
        `SELECT COUNT(*) as cnt FROM suggestions WHERE status='pending'`
      ).get()?.cnt || 0;

      // 동기화 동의 상태
      let syncConsented = false;
      let lastSync = null;
      try {
        const row = db.prepare(`SELECT value FROM kv_store WHERE key='sync_consented'`).get();
        syncConsented = row?.value === '1';
        const logRow = db.prepare(`SELECT synced_at FROM sync_log ORDER BY synced_at DESC LIMIT 1`).get();
        lastSync = logRow?.synced_at || null;
      } catch {}

      res.json({
        today: { keyboardChunks, keywordChars, fileContents, appActivities },
        pendingSuggestions,
        syncConsented,
        lastSync,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/toggle ──────────────────────────────────────────────
  router.post('/personal/toggle', (req, res) => {
    try {
      const db = getDb();
      const { keyboard, fileWatcher, appMonitor } = req.body;

      const ensureKv = db.prepare(`
        CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)
      `);
      ensureKv.run();

      const upsert = db.prepare(`INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)`);
      if (keyboard  !== undefined) upsert.run('personal_keyboard',    keyboard  ? '1' : '0');
      if (fileWatcher!== undefined) upsert.run('personal_file',       fileWatcher? '1' : '0');
      if (appMonitor !== undefined) upsert.run('personal_app',        appMonitor ? '1' : '0');

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/personal/suggestions ─────────────────────────────────────────
  router.get('/personal/suggestions', (req, res) => {
    try {
      const db     = getDb();
      const status = req.query.status || 'pending';
      const limit  = Math.min(parseInt(req.query.limit) || 20, 100);

      const rows = db.prepare(
        `SELECT * FROM suggestions WHERE status=? ORDER BY priority DESC, created_at DESC LIMIT ?`
      ).all(status, limit);

      const parsed = rows.map(r => ({
        ...r,
        evidence:   tryParse(r.evidence),
        suggestion: tryParse(r.suggestion),
      }));

      res.json({ suggestions: parsed, total: parsed.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/suggestions/:id/accept ─────────────────────────────
  router.post('/personal/suggestions/:id/accept', (req, res) => {
    try {
      const db = getDb();
      db.prepare(
        `UPDATE suggestions SET status='accepted', responded_at=? WHERE id=?`
      ).run(new Date().toISOString(), req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/suggestions/:id/dismiss ────────────────────────────
  router.post('/personal/suggestions/:id/dismiss', (req, res) => {
    try {
      const db = getDb();
      db.prepare(
        `UPDATE suggestions SET status='dismissed', responded_at=? WHERE id=?`
      ).run(new Date().toISOString(), req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

function tryParse(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}
