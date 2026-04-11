/**
 * PC Activity Recording API (8개 엔드포인트)
 * Python recorder ↔ Node.js 서버 브리지
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

function createRecordingRouter({ broadcastAll }) {
  const router = express.Router();

  // 녹화 상태 (메모리)
  const state = {
    recording: false,
    session_id: null,
    session_name: null,
    started_at: null,
    playback: false,
    playback_session: null,
  };

  // ─── 1. 녹화 시작/종료 알림 ───────────────────────────────────────
  router.post('/recording/status', (req, res) => {
    const { action, session_id, name, total_events } = req.body;

    if (action === 'start') {
      state.recording = true;
      state.session_id = session_id;
      state.session_name = name;
      state.started_at = new Date().toISOString();

      broadcastAll({
        type: 'recording_start',
        session_id,
        name,
        timestamp: state.started_at,
      });

      res.json({ ok: true, message: '녹화 시작 알림 수신' });

    } else if (action === 'stop') {
      state.recording = false;

      broadcastAll({
        type: 'recording_stop',
        session_id: state.session_id,
        total_events: total_events || 0,
        timestamp: new Date().toISOString(),
      });

      state.session_id = null;
      state.session_name = null;
      state.started_at = null;

      res.json({ ok: true, message: '녹화 종료 알림 수신' });

    } else {
      res.status(400).json({ error: 'action은 start 또는 stop' });
    }
  });

  // ─── 2. 활동 요약 수신 ────────────────────────────────────────────
  router.post('/recording/activity', (req, res) => {
    const { session_id, counts, total } = req.body;

    broadcastAll({
      type: 'recording_activity',
      session_id,
      counts: counts || {},
      total: total || 0,
      timestamp: new Date().toISOString(),
    });

    res.json({ ok: true });
  });

  // ─── 3. 세션 목록 (recording.db 직접 조회) ───────────────────────
  router.get('/recording/sessions', (req, res) => {
    try {
      const db = _getRecordingDb();
      if (!db) return res.json({ sessions: [], message: 'recording.db 없음' });

      const limit = parseInt(req.query.limit) || 50;
      const rows = db.prepare(
        'SELECT * FROM recording_sessions ORDER BY started_at DESC LIMIT ?'
      ).all(limit);
      db.close();

      res.json({ sessions: rows });
    } catch (e) {
      res.json({ sessions: [], error: e.message });
    }
  });

  // ─── 4. 세션 상세 ─────────────────────────────────────────────────
  router.get('/recording/sessions/:id', (req, res) => {
    try {
      const db = _getRecordingDb();
      if (!db) return res.status(404).json({ error: 'recording.db 없음' });

      const session = db.prepare(
        'SELECT * FROM recording_sessions WHERE id = ?'
      ).get(req.params.id);

      if (!session) {
        db.close();
        return res.status(404).json({ error: '세션 없음' });
      }

      const eventCount = db.prepare(
        'SELECT event_type, COUNT(*) as count FROM activity_events WHERE session_id = ? GROUP BY event_type'
      ).all(req.params.id);

      const screenshotCount = db.prepare(
        'SELECT COUNT(*) as count FROM screenshots WHERE session_id = ?'
      ).get(req.params.id);

      db.close();

      res.json({
        session,
        event_breakdown: eventCount,
        screenshot_count: screenshotCount?.count || 0,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 5. 이벤트 조회 ──────────────────────────────────────────────
  router.get('/recording/sessions/:id/events', (req, res) => {
    try {
      const db = _getRecordingDb();
      if (!db) return res.json({ events: [] });

      const limit = parseInt(req.query.limit) || 1000;
      const offset = parseInt(req.query.offset) || 0;
      const type = req.query.type;

      let rows;
      if (type) {
        rows = db.prepare(
          'SELECT * FROM activity_events WHERE session_id = ? AND event_type = ? ORDER BY timestamp_ms LIMIT ? OFFSET ?'
        ).all(req.params.id, type, limit, offset);
      } else {
        rows = db.prepare(
          'SELECT * FROM activity_events WHERE session_id = ? ORDER BY timestamp_ms LIMIT ? OFFSET ?'
        ).all(req.params.id, limit, offset);
      }

      db.close();

      // data_json 파싱
      for (const row of rows) {
        try { row.data = JSON.parse(row.data_json); } catch { row.data = {}; }
        delete row.data_json;
      }

      res.json({ events: rows });
    } catch (e) {
      res.json({ events: [], error: e.message });
    }
  });

  // ─── 6. 재생 트리거 ──────────────────────────────────────────────
  router.post('/recording/play', (req, res) => {
    const { session_id, speed } = req.body;

    state.playback = true;
    state.playback_session = session_id;

    broadcastAll({
      type: 'playback_start',
      session_id,
      speed: speed || 1.0,
      timestamp: new Date().toISOString(),
    });

    res.json({ ok: true, message: '재생 시작 알림' });
  });

  // ─── 7. 재생 중지 ────────────────────────────────────────────────
  router.post('/recording/stop-playback', (req, res) => {
    state.playback = false;

    broadcastAll({
      type: 'playback_stop',
      session_id: state.playback_session,
      timestamp: new Date().toISOString(),
    });

    state.playback_session = null;
    res.json({ ok: true, message: '재생 중지 알림' });
  });

  // ─── 8. 스크린샷 서빙 ────────────────────────────────────────────
  router.get('/recording/screenshots/:id', (req, res) => {
    try {
      const db = _getRecordingDb();
      if (!db) return res.status(404).json({ error: 'recording.db 없음' });

      const row = db.prepare(
        'SELECT * FROM screenshots WHERE id = ?'
      ).get(req.params.id);
      db.close();

      if (!row) return res.status(404).json({ error: '스크린샷 없음' });

      const filePath = row.file_path;
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: '파일 없음' });
      }

      res.sendFile(path.resolve(filePath));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 헬퍼 ────────────────────────────────────────────────────────
  function _getRecordingDb() {
    const dbPath = path.join(__dirname, '..', 'data', 'recording.db');
    if (!fs.existsSync(dbPath)) return null;

    try {
      const Database = require('better-sqlite3');
      return new Database(dbPath, { readonly: true });
    } catch {
      // better-sqlite3가 없으면 null 반환
      return null;
    }
  }

  return router;
}

module.exports = createRecordingRouter;
