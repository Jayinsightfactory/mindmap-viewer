/**
 * PC Activity Recording API (8개 엔드포인트 + 3개 통합 엔드포인트)
 * Python recorder ↔ Node.js 서버 브리지
 * + Vision-learning 클릭 자동 피딩
 * + Process-mining 이벤트 동기화
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

function createRecordingRouter({ broadcastAll, getDb }) {
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

  // ═══════════════════════════════════════════════════════════════════
  // 9. Recorder 클릭 → Vision-learning 자동 피딩
  // POST /api/recording/sync-clicks
  // 최근 recorder 클릭 이벤트를 vision-learning ui_click_map에 동기화
  // ═══════════════════════════════════════════════════════════════════
  router.post('/recording/sync-clicks', async (req, res) => {
    try {
      const db = getDb ? getDb() : null;
      if (!db?.query) return res.json({ error: 'DB not available', synced: 0 });

      const rdb = _getRecordingDb();
      if (!rdb) return res.json({ error: 'recording.db 없음', synced: 0 });

      const { limit: lim, sessionId } = req.body;
      const maxRows = Math.min(parseInt(lim) || 500, 5000);

      // 최근 클릭 이벤트 (windowTitle 있는 것만)
      let clickRows;
      if (sessionId) {
        clickRows = rdb.prepare(`
          SELECT event_type, timestamp_abs, data_json
          FROM activity_events
          WHERE session_id = ? AND event_type = 'mouse_click'
          ORDER BY timestamp_ms DESC LIMIT ?
        `).all(sessionId, maxRows);
      } else {
        clickRows = rdb.prepare(`
          SELECT event_type, timestamp_abs, data_json
          FROM activity_events
          WHERE event_type = 'mouse_click'
          ORDER BY timestamp_abs DESC LIMIT ?
        `).all(maxRows);
      }
      rdb.close();

      let synced = 0;
      let skipped = 0;

      for (const row of clickRows) {
        let data;
        try { data = JSON.parse(row.data_json); } catch { continue; }

        // pressed=false(뗌 이벤트)이거나 windowTitle 없으면 스킵
        if (!data.pressed || !data.windowTitle) { skipped++; continue; }

        const x = data.x || 0;
        const y = data.y || 0;
        const windowTitle = data.windowTitle || '';
        const processName = data.processName || '';

        // 정규화 좌표 (1920x1080 기준, 실제 해상도 비율 적용)
        const screenW = 1920;
        const screenH = 1080;
        const nx = Math.min(1, Math.max(0, x / screenW));
        const ny = Math.min(1, Math.max(0, y / screenH));

        // 앱·화면 추론
        let appName = 'unknown';
        let screenName = 'unknown';
        const lowerTitle = windowTitle.toLowerCase();
        if (lowerTitle.includes('nenova') || lowerTitle.includes('네노바') || lowerTitle.includes('화훼관리')) {
          appName = 'nenova';
          const parts = windowTitle.split(/\s*[-–]\s*/);
          if (parts.length > 1) screenName = parts[parts.length - 1].trim();
        } else if (lowerTitle.includes('chrome') || lowerTitle.includes('edge')) {
          appName = 'browser';
        } else if (lowerTitle.includes('excel')) {
          appName = 'excel';
        } else if (lowerTitle.includes('kakaotalk') || lowerTitle.includes('카카오톡')) {
          appName = 'kakaotalk';
        } else if (processName) {
          appName = processName;
        }

        // ui_click_map에 삽입
        try {
          await db.query(`
            INSERT INTO ui_click_map (app_name, screen_name, click_x, click_y, user_id, timestamp, element_id)
            VALUES ($1, $2, $3, $4, $5, $6, NULL)
          `, [appName, screenName, nx, ny, null, new Date(row.timestamp_abs)]);
          synced++;
        } catch (e) {
          // 중복 등 무시
        }
      }

      res.json({
        ok: true,
        synced,
        skipped,
        total: clickRows.length,
        message: `${synced}개 클릭 → vision-learning 동기화`,
      });
    } catch (e) {
      console.error('[recording/sync-clicks]', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 10. Recorder 통합 현황
  // GET /api/recording/integration-status
  // ═══════════════════════════════════════════════════════════════════
  router.get('/recording/integration-status', (req, res) => {
    try {
      const rdb = _getRecordingDb();
      if (!rdb) return res.json({ available: false, message: 'recording.db 없음' });

      const sessionCount = rdb.prepare('SELECT COUNT(*) as c FROM recording_sessions').get().c;
      const totalEvents = rdb.prepare('SELECT COUNT(*) as c FROM activity_events').get().c;
      const clickEvents = rdb.prepare("SELECT COUNT(*) as c FROM activity_events WHERE event_type = 'mouse_click'").get().c;
      const keyEvents = rdb.prepare("SELECT COUNT(*) as c FROM activity_events WHERE event_type = 'keydown'").get().c;
      const screenshotCount = rdb.prepare('SELECT COUNT(*) as c FROM screenshots').get().c;

      // 윈도우 타이틀 있는 클릭 비율
      const clicksWithTitle = rdb.prepare(`
        SELECT COUNT(*) as c FROM activity_events
        WHERE event_type = 'mouse_click'
          AND data_json LIKE '%windowTitle%'
      `).get().c;

      const latestSession = rdb.prepare(
        'SELECT * FROM recording_sessions ORDER BY started_at DESC LIMIT 1'
      ).get();

      rdb.close();

      res.json({
        available: true,
        sessions: sessionCount,
        totalEvents,
        clicks: clickEvents,
        clicksWithWindowTitle: clicksWithTitle,
        titleCoverage: clickEvents > 0 ? Math.round(clicksWithTitle / clickEvents * 100) : 0,
        keydowns: keyEvents,
        screenshots: screenshotCount,
        latestSession: latestSession || null,
        integrationReady: clicksWithTitle > 0,
      });
    } catch (e) {
      res.json({ available: false, error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // 11. Recorder → Process Mining 이벤트 변환 미리보기
  // GET /api/recording/mining-preview?sessionId=xxx&limit=100
  // ═══════════════════════════════════════════════════════════════════
  router.get('/recording/mining-preview', (req, res) => {
    try {
      const rdb = _getRecordingDb();
      if (!rdb) return res.json({ events: [], message: 'recording.db 없음' });

      const { sessionId, limit: lim } = req.query;
      const maxRows = Math.min(parseInt(lim) || 100, 1000);

      let rows;
      if (sessionId) {
        rows = rdb.prepare(`
          SELECT event_type, timestamp_abs, data_json
          FROM activity_events
          WHERE session_id = ? AND event_type IN ('mouse_click', 'keydown')
          ORDER BY timestamp_ms ASC LIMIT ?
        `).all(sessionId, maxRows);
      } else {
        rows = rdb.prepare(`
          SELECT event_type, timestamp_abs, data_json
          FROM activity_events
          WHERE event_type IN ('mouse_click', 'keydown')
          ORDER BY timestamp_abs DESC LIMIT ?
        `).all(maxRows);
      }
      rdb.close();

      const events = rows.map(row => {
        let data;
        try { data = JSON.parse(row.data_json); } catch { data = {}; }
        if (row.event_type === 'mouse_click' && data.pressed === false) return null;

        return {
          type: row.event_type === 'mouse_click' ? 'recorder.click' : 'recorder.key',
          timestamp: row.timestamp_abs,
          app: data.processName || '',
          windowTitle: data.windowTitle || '',
          activity: row.event_type === 'mouse_click'
            ? `click(${data.x},${data.y})`
            : `key:${data.key || ''}`,
          hasWindowContext: !!(data.windowTitle),
        };
      }).filter(Boolean);

      res.json({
        total: events.length,
        withWindowContext: events.filter(e => e.hasWindowContext).length,
        events,
      });
    } catch (e) {
      res.json({ events: [], error: e.message });
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
