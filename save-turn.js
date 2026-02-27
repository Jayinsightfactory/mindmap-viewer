/**
 * save-turn.js
 * Claude Code 훅 스크립트 (10개 훅 이벤트 처리)
 * stdin → 이벤트 정규화 → SQLite + JSONL 이중 저장
 */
const fs = require('fs');
const path = require('path');
const { normalizeHookEvent } = require('./event-normalizer');

const BASE_DIR = path.join('C:', 'Users', 'cando', 'mindmap-viewer');
const CONV_FILE = path.join(BASE_DIR, 'conversation.jsonl');
const STATE_FILE = path.join(BASE_DIR, '.hook-state.json');
const SNAPSHOTS_DIR = path.join(BASE_DIR, 'snapshots');
const LOG_FILE = path.join(BASE_DIR, 'hook.log');
const DB_PATH = path.join(BASE_DIR, 'data', 'mindmap.db');

function log(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 디렉토리 보장
[BASE_DIR, SNAPSHOTS_DIR, path.join(BASE_DIR, 'data')].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
if (!fs.existsSync(CONV_FILE)) fs.writeFileSync(CONV_FILE, '');

// ─── 세션 상태 관리 ─────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ─── SQLite 직접 삽입 (훅 스크립트용 경량 버전) ─────
function insertToDb(event) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    // 테이블 없으면 생성
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'claude-hook',
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'local',
        channel_id TEXT NOT NULL DEFAULT 'default',
        parent_event_id TEXT,
        timestamp TEXT NOT NULL,
        data_json TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'local',
        channel_id TEXT NOT NULL DEFAULT 'default',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        source TEXT,
        model_id TEXT,
        project_dir TEXT,
        event_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active'
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        name TEXT,
        language TEXT,
        first_seen_at TEXT,
        last_accessed_at TEXT,
        access_count INTEGER DEFAULT 1
      );
    `);

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO events (id, type, source, session_id, user_id, channel_id, parent_event_id, timestamp, data_json, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      event.id, event.type, event.source,
      event.sessionId, event.userId, event.channelId,
      event.parentEventId, event.timestamp,
      JSON.stringify(event.data), JSON.stringify(event.metadata || {})
    );

    // 세션 upsert
    const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(event.sessionId);
    if (event.type === 'session.start') {
      db.prepare(`INSERT OR REPLACE INTO sessions (id, user_id, channel_id, started_at, source, model_id, project_dir, event_count, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active')`)
        .run(event.sessionId, event.userId, event.channelId, event.timestamp, event.data.source, event.data.modelId, event.data.projectDir);
    } else if (event.type === 'session.end') {
      db.prepare(`UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ?`)
        .run(event.timestamp, event.sessionId);
    } else if (existingSession) {
      db.prepare('UPDATE sessions SET event_count = event_count + 1 WHERE id = ?')
        .run(event.sessionId);
    } else {
      db.prepare(`INSERT INTO sessions (id, user_id, channel_id, started_at, event_count, status) VALUES (?, ?, ?, ?, 1, 'active')`)
        .run(event.sessionId, event.userId, event.channelId, event.timestamp);
    }

    // 파일 upsert
    if (event.data.filePath) {
      const f = db.prepare('SELECT path FROM files WHERE path = ?').get(event.data.filePath);
      if (f) {
        db.prepare('UPDATE files SET last_accessed_at = ?, access_count = access_count + 1 WHERE path = ?')
          .run(event.timestamp, event.data.filePath);
      } else {
        db.prepare('INSERT INTO files (path, name, language, first_seen_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)')
          .run(event.data.filePath, event.data.fileName, event.data.language, event.timestamp, event.timestamp);
      }
    }

    db.close();
  } catch (e) {
    log(`DB insert error: ${e.message}`);
  }
}

// ─── JSONL 저장 (하위 호환) ─────────────────────────
function appendToJsonl(event) {
  try {
    // 기존 형식과 호환되는 간결한 포맷
    const entry = {
      id: event.id,
      type: event.type,
      source: event.source,
      sessionId: event.sessionId,
      parentEventId: event.parentEventId,
      data: event.data,
      ts: event.timestamp,
    };
    fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    log(`JSONL append error: ${e.message}`);
  }
}

// ─── 메인 처리 ──────────────────────────────────────
let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { inputData += chunk; });
process.stdin.on('end', () => {
  try {
    const hookData = JSON.parse(inputData);
    const sessionId = hookData.session_id || 'unknown';

    log(`hook=${hookData.hook_event_name} tool=${hookData.tool_name || '-'} session=${sessionId}`);

    // 세션 상태 로드
    const state = loadState();
    if (!state.sessions) state.sessions = {};
    if (!state.sessions[sessionId]) {
      state.sessions[sessionId] = {
        lastUserId: null,
        lastAssistantId: null,
        sessionStartId: null,
        pendingTools: [],
        subagentStartIds: {},
      };
    }
    const sessionState = state.sessions[sessionId];

    // 이벤트 정규화
    const events = normalizeHookEvent(hookData, sessionState);

    // 각 이벤트 저장 + 상태 업데이트
    for (const event of events) {
      // SQLite 저장
      insertToDb(event);

      // JSONL 저장
      appendToJsonl(event);

      // 세션 상태 추적 (부모-자식 관계를 위해)
      switch (event.type) {
        case 'session.start':
          sessionState.sessionStartId = event.id;
          break;
        case 'user.message':
          sessionState.lastUserId = event.id;
          sessionState.pendingTools = [];
          break;
        case 'assistant.message':
          sessionState.lastAssistantId = event.id;
          break;
        case 'tool.end':
        case 'tool.error':
          sessionState.pendingTools.push({
            name: event.data.toolName,
            id: event.id,
          });
          break;
        case 'subagent.start':
          if (event.data.agentId) {
            sessionState.subagentStartIds[event.data.agentId] = event.id;
          }
          break;
      }

      log(`saved event id=${event.id} type=${event.type}`);
    }

    // Stop일 때 스냅샷 마커 저장
    if (hookData.hook_event_name === 'Stop') {
      const lastEventId = events.length > 0 ? events[events.length - 1].id : 'unknown';
      const snapshotDir = path.join(SNAPSHOTS_DIR, `event-${lastEventId}`);
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(
        path.join(snapshotDir, 'marker.json'),
        JSON.stringify({ eventId: lastEventId, ts: new Date().toISOString(), session: sessionId }, null, 2)
      );
    }

    saveState(state);
  } catch (e) {
    log(`FATAL: ${e.message}\n${e.stack}`);
  }

  process.exit(0);
});
