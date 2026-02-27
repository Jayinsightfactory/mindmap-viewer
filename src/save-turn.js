/**
 * save-turn.js
 * Claude Code 훅 스크립트 (10개 훅 이벤트 처리)
 * stdin → 이벤트 정규화 → SQLite + JSONL + HTTP POST 삼중 저장
 * HTTP POST: 서버가 실행 중이면 즉시 WebSocket 브로드캐스트 (파일 감시 레이턴시 없음)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { normalizeHookEvent } = require('./event-normalizer');

// 서버 포트 (환경변수 또는 기본값 4747)
const SERVER_PORT = process.env.MINDMAP_PORT || 4747;
// 멤버 이름: 환경변수로 설정 (예: export MINDMAP_MEMBER=다린)
const MEMBER_NAME  = process.env.MINDMAP_MEMBER  || require('os').hostname().split('.')[0];

// ── 채널 ID: 환경변수 > git remote > 현재 폴더명 ──────
function detectChannelId() {
  if (process.env.MINDMAP_CHANNEL) return process.env.MINDMAP_CHANNEL;
  try {
    const { execSync } = require('child_process');
    // 작업 디렉토리: transcript_path 기준 또는 cwd
    const cwd = process.env.MINDMAP_WORKDIR || process.cwd();
    // git remote origin URL → 리포명 추출
    const remote = execSync('git remote get-url origin 2>/dev/null', { cwd, timeout: 2000 })
      .toString().trim();
    if (remote) {
      // https://github.com/user/repo.git → repo
      // git@github.com:user/repo.git → repo
      const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
      if (match) return match[1];
    }
  } catch {}
  try {
    // git remote 없으면 현재 폴더명
    const cwd = process.env.MINDMAP_WORKDIR || process.cwd();
    return require('path').basename(cwd);
  } catch {}
  return 'default';
}
const CHANNEL_ID = detectChannelId();

// ── 경로: 스크립트 위치 기준 자동 해석 (macOS/Windows 공용) ──
const BASE_DIR = path.resolve(__dirname);
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
    const entry = {
      id: event.id, type: event.type, source: event.source,
      sessionId: event.sessionId, parentEventId: event.parentEventId,
      data: event.data, ts: event.timestamp,
    };
    fs.appendFileSync(CONV_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    log(`JSONL append error: ${e.message}`);
  }
}

// ─── HTTP POST → 서버 직접 전송 (비동기, 실패해도 무시) ─
function postToServer(events) {
  try {
    const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: MEMBER_NAME });
    const req = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/api/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      // 응답 소비 (소켓 leak 방지)
      res.resume();
    });
    req.on('error', () => {}); // 서버 미실행 시 조용히 무시
    req.setTimeout(2000, () => req.destroy()); // 2초 타임아웃
    req.write(body);
    req.end();
  } catch {}
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
      // 1. SQLite 저장 (영구 보존)
      insertToDb(event);

      // 2. JSONL 저장 (하위 호환)
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

    // 3. HTTP POST → 서버 실시간 브로드캐스트 (비동기, 파일 감시 레이턴시 제거)
    if (events.length > 0) {
      postToServer(events);
    }

    saveState(state);
  } catch (e) {
    log(`FATAL: ${e.message}\n${e.stack}`);
  }

  process.exit(0);
});
