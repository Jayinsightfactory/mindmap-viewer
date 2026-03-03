'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — External integrations (terminal, vscode, browser, keylog, chrome, AI conversations)
// ══════════════════════════════════════════════════════════════════════════════

module.exports = function createIntegrationsRouter(deps) {
  const express = require('express');
  const router  = express.Router();

  const { broadcastAll, ollamaAnalyzer, dbModule, PORT } = deps;

// ── Chrome Extension AI 이벤트 수신 ─────────────────────────────────────────
router.post('/api/ai-events', (req, res) => {
  const event = req.body;
  console.log(`[Chrome Extension] ${event.tool} — ${event.action}: ${event.topic}`);
  if (typeof broadcastAll === 'function') broadcastAll({ type: 'ai_tool_event', data: event });
  res.json({ ok: true });
});

// ── Railway AI 대화 포워딩 헬퍼 (메타데이터만, 원문 제외) ────────────────────
function forwardConvToRailway(convMeta) {
  const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  // Railway 서버 자신이거나 URL 없으면 스킵 (무한루프 방지)
  if (!railwayUrl || process.env.RAILWAY_ENVIRONMENT) return;

  try {
    const https = require('https');
    const body  = JSON.stringify({ ...convMeta, fromRemote: true });
    const url   = new URL('/api/ai-conversation', railwayUrl);
    const req   = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => res.resume());
    req.on('error', () => {}); // 실패 시 조용히 무시
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

// ── AI 대화 수신 (Chrome Extension content-ai.js → background.js → 여기) ─────
router.post('/api/ai-conversation', (req, res) => {
  const conv = req.body;
  // messages 없는 메타데이터 전용 요청(Railway 포워딩)도 허용
  if (!conv || (!conv.messages && !conv.fromRemote)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const db = dbModule.getDb();
    if (!db) return res.json({ ok: true, stored: false, reason: 'no-db' });

    // 테이블 초기화 (없으면 생성)
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id          TEXT PRIMARY KEY,
        site        TEXT NOT NULL,
        url         TEXT,
        title       TEXT,
        msg_count   INTEGER DEFAULT 0,
        messages    TEXT,           -- JSON 원문 (로컬 only)
        shared      INTEGER DEFAULT 0,
        captured_at TEXT,
        updated_at  TEXT DEFAULT (datetime('now')),
        user_id     TEXT            -- 나중에 계정 연결용
      )
    `);

    const id       = conv.id || `conv-${Date.now()}`;
    const now      = new Date().toISOString();
    const messages = conv.messages || [];

    // INSERT OR REPLACE (같은 id = 업데이트)
    db.prepare(`
      INSERT OR REPLACE INTO ai_conversations
        (id, site, url, title, msg_count, messages, shared, captured_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      conv.site  || 'Unknown',
      conv.url   || '',
      conv.title || conv.site || '',
      conv.msgCount || messages.length,
      messages.length ? JSON.stringify(messages) : null,  // 원문 저장 (로컬만)
      conv.shared ? 1 : 0,
      conv.capturedAt || now,
      now,
    );

    // 브로드캐스트 (대시보드 실시간 업데이트)
    if (typeof broadcastAll === 'function') {
      broadcastAll({
        type:  'ai_conversation_saved',
        site:  conv.site,
        title: conv.title,
        msgs:  conv.msgCount || messages.length,
        id,
      });
    }

    console.log(`[AI대화] ${conv.site} — ${conv.msgCount || messages.length}메시지 저장 (${id})`);

    // Railway 실시간 포워딩 (원문 제외, 메타데이터만) — 로컬 요청일 때만
    if (!conv.fromRemote && messages.length > 0) {
      forwardConvToRailway({
        id,
        site:       conv.site,
        url:        conv.url,
        title:      conv.title,
        msgCount:   messages.length,
        capturedAt: conv.capturedAt || now,
        shared:     conv.shared || false,
        // messages 필드 미포함 (원문 프라이버시 보호)
      });
    }

    res.json({ ok: true, id, stored: true });
  } catch (err) {
    console.error('[AI대화] 저장 오류:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── AI 대화 목록 조회 ─────────────────────────────────────────────────────────
router.get('/api/ai-conversations', (req, res) => {
  try {
    const db = dbModule.getDb();
    if (!db) return res.json({ conversations: [] });

    db.exec(`CREATE TABLE IF NOT EXISTS ai_conversations (
      id TEXT PRIMARY KEY, site TEXT, url TEXT, title TEXT,
      msg_count INTEGER DEFAULT 0, messages TEXT, shared INTEGER DEFAULT 0,
      captured_at TEXT, updated_at TEXT, user_id TEXT
    )`);

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows  = db.prepare(`
      SELECT id, site, url, title, msg_count, shared, captured_at, updated_at
      FROM ai_conversations ORDER BY updated_at DESC LIMIT ?
    `).all(limit);

    // 원문(messages)은 목록에서 제외 — 개별 조회 시에만 반환
    res.json({ conversations: rows });
  } catch (err) {
    res.json({ conversations: [], error: err.message });
  }
});

// ── AI 대화 원문 조회 (로컬에서만 접근 가능) ────────────────────────────────
router.get('/api/ai-conversations/:id/messages', (req, res) => {
  // 로컬 접근만 허용 (127.0.0.1 / ::1)
  const ip = req.ip || req.connection.remoteAddress || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!isLocal) return res.status(403).json({ error: '로컬 접근만 허용됩니다' });

  try {
    const db = dbModule.getDb();
    if (!db) return res.json({ messages: [] });

    const row = db.prepare(`SELECT messages FROM ai_conversations WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: '대화를 찾을 수 없습니다' });

    res.json({ messages: JSON.parse(row.messages || '[]') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 터미널 명령어 수신 (쉘 훅 → 여기) ───────────────────────────────────────
router.post('/api/terminal-command', (req, res) => {
  const { command, cwd, exitCode, duration, fromRemote } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  const event = {
    id:        `term-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type:      'terminal.command',
    source:    'terminal-hook',
    sessionId: 'terminal',
    timestamp: new Date().toISOString(),
    data:      { command: command.slice(0, 200), cwd, exitCode, duration },
  };

  // Ollama 분석기에 전달
  ollamaAnalyzer.addEvent(event);

  // WebSocket 브로드캐스트
  broadcastAll({ type: 'new_event', event });

  // Railway 포워딩
  if (!fromRemote) {
    const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    if (railwayUrl && !process.env.RAILWAY_ENVIRONMENT) {
      try {
        const https = require('https');
        const body  = JSON.stringify({ command, cwd, exitCode, fromRemote: true });
        const reqFwd = https.request({
          hostname: new URL(railwayUrl).hostname, port: 443,
          path: '/api/terminal-command', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, r => r.resume());
        reqFwd.on('error', () => {});
        reqFwd.setTimeout(5000, () => reqFwd.destroy());
        reqFwd.write(body); reqFwd.end();
      } catch {}
    }
  }

  res.json({ ok: true });
});

// ── VS Code 활동 수신 ─────────────────────────────────────────────────────────
router.post('/api/vscode-activity', (req, res) => {
  const { type, data, timestamp, fromRemote } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const event = {
    id:        `vsc-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    type:      `vscode.${type}`,
    source:    'vscode-extension',
    sessionId: 'vscode',
    timestamp: timestamp || new Date().toISOString(),
    data:      data || {},
  };

  // Ollama 분석기에 전달
  ollamaAnalyzer.addEvent(event);

  // WebSocket 브로드캐스트
  broadcastAll({ type: 'new_event', event });

  // Railway 포워딩
  if (!fromRemote) {
    const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    if (railwayUrl && !process.env.RAILWAY_ENVIRONMENT) {
      try {
        const https = require('https');
        const body  = JSON.stringify({ type, data, timestamp, fromRemote: true });
        const reqFwd = https.request({
          hostname: new URL(railwayUrl).hostname, port: 443,
          path: '/api/vscode-activity', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, r => r.resume());
        reqFwd.on('error', () => {});
        reqFwd.setTimeout(5000, () => reqFwd.destroy());
        reqFwd.write(body); reqFwd.end();
      } catch {}
    }
  }

  res.json({ ok: true });
});

// ── 브라우저 활동 수신 ────────────────────────────────────────────────────────
router.post('/api/browser-activity', (req, res) => {
  const { url, title, stayMs, fromRemote } = req.body;
  if (typeof broadcastAll === 'function') {
    broadcastAll({ type: 'browser_activity', url, title, stayMs });
  }
  // Railway 포워딩 (로컬 요청일 때만, 무한루프 방지)
  if (!fromRemote) {
    const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null;
    if (railwayUrl && !process.env.RAILWAY_ENVIRONMENT) {
      try {
        const https = require('https');
        const body  = JSON.stringify({ url, title, stayMs, fromRemote: true, timestamp: new Date().toISOString() });
        const reqFwd = https.request({
          hostname: new URL(railwayUrl).hostname,
          port: 443, path: '/api/browser-activity', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, r => r.resume());
        reqFwd.on('error', () => {});
        reqFwd.setTimeout(5000, () => reqFwd.destroy());
        reqFwd.write(body);
        reqFwd.end();
      } catch {}
    }
  }
  res.json({ ok: true });
});

// ── 키로거 인사이트 수신 (keylogger.js → 여기) ────────────────────────────
// 원문 절대 미포함 — Ollama 분석 결과(패턴/주제/활동)만 수신
router.post('/api/keylog-insight', (req, res) => {
  const { insightId, insight, timestamp, fromRemote } = req.body;
  if (!insight) return res.status(400).json({ error: 'insight required' });

  // 원문 코드/텍스트 필드가 들어오면 거부 (프라이버시 보호)
  if (insight.rawText || insight.content || insight.keystrokes) {
    return res.status(400).json({ error: '원문 필드는 허용되지 않습니다' });
  }

  // WebSocket 브로드캐스트 (대시보드 실시간 표시)
  if (typeof broadcastAll === 'function') {
    broadcastAll({
      type:      'keylog_insight',
      insightId: insightId || `ki-${Date.now()}`,
      insight,             // topic, language, activity, keywords, context
      timestamp: timestamp || new Date().toISOString(),
    });
  }

  // Railway 포워딩 (분석 결과만, 원문 없음)
  if (!fromRemote) {
    const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null;
    if (railwayUrl && !process.env.RAILWAY_ENVIRONMENT) {
      try {
        const https = require('https');
        const body  = JSON.stringify({ insightId, insight, timestamp, fromRemote: true });
        const reqFwd = https.request({
          hostname: new URL(railwayUrl).hostname, port: 443,
          path: '/api/keylog-insight', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, r => r.resume());
        reqFwd.on('error', () => {});
        reqFwd.setTimeout(5000, () => reqFwd.destroy());
        reqFwd.write(body); reqFwd.end();
      } catch {}
    }
  }

  console.log(`[키로거] 인사이트 수신: ${insight.topic} (${insight.activity})`);
  res.json({ ok: true });
});

  return router;
};
