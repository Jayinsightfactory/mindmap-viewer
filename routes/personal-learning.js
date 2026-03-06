'use strict';

/**
 * routes/personal-learning.js
 * 개인 학습 데이터 수신 + 작업 제안 관리 API
 *
 * POST /api/personal/keyboard           ← keyboard-watcher
 * POST /api/personal/file-content       ← file-learner
 * POST /api/personal/app-activity       ← system-monitor
 * GET  /api/personal/status             ← 오늘 통계
 * POST /api/personal/toggle             ← 기능 on/off
 * GET  /api/personal/suggestions        ← pending 제안 목록
 * POST /api/personal/suggestions/:id/accept
 * POST /api/personal/suggestions/:id/dismiss
 *
 * POST /api/personal/issue              ← 이슈 발생 마킹 (수동 or 자동)
 * GET  /api/personal/triggers           ← 학습된 트리거 패턴 목록
 * GET  /api/personal/risk               ← 현재 대화 위험도 평가
 * GET  /api/personal/signals            ← 행동 이상 신호
 * POST /api/personal/signals/:id/ack   ← 신호 확인
 */

const { Router } = require('express');
const { ulid }   = require('ulid');
const path       = require('path');

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
      const { app, title, category, duration, url, ts } = req.body;
      saveEvent('app.activity', { app, title, category, duration, url });
      // 실시간 브로드캐스트 → 마인드맵 라이브 브랜치 확장
      if (typeof broadcastAll === 'function') {
        broadcastAll({
          type: url ? 'browse' : 'app_switch',
          app, title, url, category,
          timestamp: ts || new Date().toISOString(),
        });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/ai-prompt ──────────────────────────────────────────
  // AI 툴에서 프롬프트 입력 이벤트 (keyboard-watcher가 AI 앱 감지 시 자동 호출)
  // body: { app, prompt, revision?: bool, sessionId?, ts }
  router.post('/personal/ai-prompt', (req, res) => {
    try {
      const { app, prompt, revision = false, sessionId, ts } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      saveEvent('keyboard.chunk', {
        text:     prompt,
        app,
        wordCount: prompt.split(/\s+/).length,
        isAiApp:  true,
        revision, // true이면 수정 요청 신호
        sessionId,
      }, sessionId || 'personal');

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

      // 동기화 동의 상태 (sync_level: 0=로컬, 1=제안만, 2=원본포함)
      let syncLevel = 0;
      let lastSync  = null;
      try {
        const row = db.prepare(`SELECT value FROM kv_store WHERE key='sync_level'`).get();
        syncLevel = parseInt(row?.value || '0', 10);
        const logRow = db.prepare(`SELECT synced_at FROM sync_log ORDER BY synced_at DESC LIMIT 1`).get();
        lastSync = logRow?.synced_at || null;
      } catch {}

      res.json({
        today: { keyboardChunks, keywordChars, fileContents, appActivities },
        pendingSuggestions,
        syncLevel,
        syncConsented: syncLevel >= 1,   // 하위 호환
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

  // ── GET /api/personal/signals ─────────────────────────────────────────────
  // 행동 이상 신호 목록 (미확인 우선)
  router.get('/personal/signals', (req, res) => {
    try {
      const db    = getDb();
      const limit = Math.min(parseInt(req.query.limit) || 20, 50);
      let rows = [];
      try {
        rows = db.prepare(
          `SELECT * FROM signals ORDER BY acknowledged ASC, detected_at DESC LIMIT ?`
        ).all(limit);
      } catch {
        // signals 테이블 없으면 빈 배열
      }
      const parsed = rows.map(r => ({ ...r, detail: tryParse(r.detail) }));
      res.json({ signals: parsed, total: parsed.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/personal/signals/:id/ack ────────────────────────────────────
  router.post('/personal/signals/:id/ack', (req, res) => {
    try {
      const db = getDb();
      try { db.prepare(`UPDATE signals SET acknowledged=1 WHERE id=?`).run(req.params.id); } catch {}
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/personal/issue ───────────────────────────────────────────────
  // 이슈 발생 마킹: 수동("지금 이슈 발생") or 자동(stress-detector 트리거)
  // body: { severity?, issue_type?, note?, source? }
  router.post('/personal/issue', (req, res) => {
    try {
      const db = getDb();
      const triggerEngine = requireSafe(path.join(__dirname, '../src/trigger-engine'));
      if (triggerEngine) triggerEngine.ensureTables(db);

      const { severity = 'medium', issue_type = '불명확', note = '', source = 'user_marked' } = req.body;
      const id = ulid();
      try {
        db.prepare(`
          INSERT INTO issue_events (id, source, severity, issue_type, note)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, source, severity, issue_type, note);
      } catch (e2) {
        // issue_events 테이블 없으면 생성 후 재시도
        if (triggerEngine) triggerEngine.ensureTables(db);
        db.prepare(`
          INSERT INTO issue_events (id, source, severity, issue_type, note)
          VALUES (?, ?, ?, ?, ?)
        `).run(id, source, severity, issue_type, note);
      }

      // 즉시 트리거 학습 시도 (백그라운드)
      if (triggerEngine) {
        setImmediate(() => {
          try { triggerEngine.processUnanalyzedIssues(db); } catch {}
        });
      }

      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/personal/triggers ─────────────────────────────────────────────
  // 학습된 이슈 트리거 패턴 목록 (텍스트 없음 — 태그+통계만)
  router.get('/personal/triggers', (req, res) => {
    try {
      const db          = getDb();
      const triggerEngine = requireSafe(path.join(__dirname, '../src/trigger-engine'));
      const limit       = Math.min(parseInt(req.query.limit) || 20, 50);
      const triggers    = triggerEngine ? triggerEngine.getTopTriggers(db, limit) : [];
      res.json({ triggers, total: triggers.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── GET /api/personal/risk ─────────────────────────────────────────────────
  // 현재 대화 패턴이 알려진 트리거와 얼마나 유사한지 위험도 평가
  router.get('/personal/risk', (req, res) => {
    try {
      const db            = getDb();
      const contentAnalyzer = requireSafe(path.join(__dirname, '../src/content-analyzer'));
      const triggerEngine   = requireSafe(path.join(__dirname, '../src/trigger-engine'));

      const summary  = contentAnalyzer ? contentAnalyzer.recentTagSummary(db, 4) : null;
      const riskInfo = triggerEngine   ? triggerEngine.assessCurrentRisk(db, summary) : { riskLevel: 'unknown' };

      res.json({ summary, ...riskInfo });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── POST /api/personal/media ──────────────────────────────────────────────
  // 음성/영상 전사 텍스트 수신 → events 저장 → Ollama 분석
  router.post('/personal/media', (req, res) => {
    try {
      const { text, source = 'speech', lang = 'ko-KR', duration = 0 } = req.body;
      if (!text || text.trim().length < 5) return res.status(400).json({ error: 'text required (min 5 chars)' });

      const event = saveEvent('media.transcript', {
        text: text.trim(),
        source,
        lang,
        duration,
        contentPreview: text.trim().slice(0, 100),
        textLength: text.trim().length,
      });

      // 비동기 Ollama 분석 (content-analyzer 재사용)
      const contentAnalyzer = requireSafe(path.join(__dirname, '../src/content-analyzer'));
      if (contentAnalyzer && event) {
        setImmediate(async () => {
          try {
            const db = getDb();
            const evRow = db.prepare(`SELECT * FROM events WHERE id = ?`).get(event.id);
            if (evRow) {
              const parsed = { ...evRow, data: tryParse(evRow.data_json || evRow.data), type: 'media.transcript' };
              await contentAnalyzer.analyzeAndStore([parsed], db);
            }
          } catch {}
        });
      }

      res.json({ ok: true, eventId: event?.id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/personal/guides ──────────────────────────────────────────────
  // 가이드 허브: 학습+패턴+생산성 교차 분석 가이드
  router.get('/personal/guides', (req, res) => {
    try {
      const db = getDb();

      // 1. 학습 가이드 (learning_guide 타입 suggestions)
      let learning = [];
      try {
        learning = db.prepare(
          `SELECT id, title, description, evidence, created_at FROM suggestions
           WHERE type='learning_guide' AND status='pending'
           ORDER BY priority DESC, created_at DESC LIMIT 5`
        ).all().map(r => ({ ...r, evidence: tryParse(r.evidence) }));
      } catch {}

      // 2. 작업 패턴 (반복 파일, 장시간 세션 등)
      let patterns = [];
      try {
        patterns = db.prepare(
          `SELECT id, title, description, type, created_at FROM suggestions
           WHERE type IN ('automation','review') AND status='pending'
           ORDER BY priority DESC, created_at DESC LIMIT 5`
        ).all();
      } catch {}

      // 3. 생산성 제안 (앱 전환, 템플릿, 프롬프트 등)
      let productivity = [];
      try {
        productivity = db.prepare(
          `SELECT id, title, description, type, created_at FROM suggestions
           WHERE type IN ('shortcut','template','prompt_template') AND status='pending'
           ORDER BY priority DESC, created_at DESC LIMIT 5`
        ).all();
      } catch {}

      // 4. 최근 미디어 인사이트 추가 (learning 없을 때 보강)
      if (!learning.length) {
        try {
          const since = new Date(Date.now() - 72 * 3600_000).toISOString();
          const mediaCount = db.prepare(
            `SELECT COUNT(*) as cnt FROM events WHERE type='media.transcript' AND timestamp > ?`
          ).get(since)?.cnt || 0;
          if (mediaCount > 0) {
            learning.push({
              title: '미디어 학습 데이터 수집 중',
              description: `최근 ${mediaCount}건의 음성/영상 전사가 분석 대기 중입니다. 더 많은 학습 데이터가 쌓이면 구체적인 가이드가 생성됩니다.`,
            });
          }
        } catch {}
      }

      res.json({ learning, patterns, productivity });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/personal/media/insights ────────────────────────────────────────
  // media.transcript 이벤트의 content_tags 기반 주제별 요약
  router.get('/personal/media/insights', (req, res) => {
    try {
      const db    = getDb();
      const hours = parseInt(req.query.hours) || 24;
      const since = new Date(Date.now() - hours * 3600_000).toISOString();

      // media.transcript 이벤트 ID 목록
      let mediaEventIds = [];
      try {
        mediaEventIds = db.prepare(
          `SELECT id FROM events WHERE type='media.transcript' AND timestamp > ?`
        ).all(since).map(r => r.id);
      } catch {}

      if (!mediaEventIds.length) {
        return res.json({ insights: [], totalTranscripts: 0, windowHours: hours });
      }

      // 해당 이벤트들의 content_tags 조회
      const placeholders = mediaEventIds.map(() => '?').join(',');
      let tags = [];
      try {
        tags = db.prepare(
          `SELECT * FROM content_tags WHERE event_id IN (${placeholders}) ORDER BY timestamp ASC`
        ).all(...mediaEventIds);
      } catch {}

      // 주제별 집계
      const topicCounts = {};
      const sentimentCounts = {};
      for (const t of tags) {
        topicCounts[t.topic] = (topicCounts[t.topic] || 0) + 1;
        sentimentCounts[t.sentiment] = (sentimentCounts[t.sentiment] || 0) + 1;
      }

      const topTopics = Object.entries(topicCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([topic, count]) => ({ topic, count }));

      res.json({
        insights: topTopics,
        dominantSentiment: Object.entries(sentimentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral',
        totalTranscripts: mediaEventIds.length,
        taggedCount: tags.length,
        windowHours: hours,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Palantir-inspired: 작업 스케줄 분석 ─────────────────────────────────────
  router.get('/personal/work-schedule', (req, res) => {
    try {
      const { PersonalLearningEngine } = requireSafe('../src/palantir-integration') || {};
      if (!PersonalLearningEngine) return res.json({ error: 'module_not_loaded' });

      const db = getDb();
      const engine = new PersonalLearningEngine(db);
      const events = db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT 1000').all();
      const result = engine.analyzeWorkSchedule(events, 'local');
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Palantir-inspired: 자동 스크립트 제안 ──────────────────────────────────
  router.get('/personal/auto-scripts', (req, res) => {
    try {
      const { AutoScriptGenerator } = requireSafe('../src/palantir-integration') || {};
      if (!AutoScriptGenerator) return res.json([]);

      const db = getDb();
      const events = db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT 500').all();
      const suggestions = AutoScriptGenerator.detectAndSuggest(events);
      res.json(suggestions);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};

// safe require (모듈 없으면 null)
function requireSafe(p) {
  try { return require(p); } catch { return null; }
}

function tryParse(s) {
  if (!s || typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}
