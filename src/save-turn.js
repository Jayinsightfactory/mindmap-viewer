/**
 * save-turn.js
 * Claude Code 훅 스크립트 (10개 훅 이벤트 처리)
 *
 * [로컬] 이벤트 발생 시마다:
 *   - SQLite + JSONL 저장 (영구 보존)
 *   - 로컬 서버(localhost:4747)에 실시간 전송 (개인 뷰용)
 *
 * [Railway 업로드] 하루 1번만:
 *   - 마지막 업로드 이후 쌓인 이벤트를 일괄 전송
 *   - ORBIT_SERVER_URL + ORBIT_TOKEN 환경변수 필요
 *   - ORBIT_UPLOAD_INTERVAL_MS로 주기 조정 (기본 24시간)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { normalizeHookEvent } = require('./event-normalizer');

// 로컬 서버 포트 (환경변수 또는 기본값 4747)
const SERVER_PORT = process.env.MINDMAP_PORT || 4747;
// Railway 서버 URL — 설정 시 하루 1번 일괄 업로드
// 예: export ORBIT_SERVER_URL=https://mindmap-viewer-production.up.railway.app
const ORBIT_SERVER_URL = process.env.ORBIT_SERVER_URL || null;
// 사용자 인증 토큰 (원격 서버 전송 시 필요)
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || '';
// 업로드 간격: 기본 24시간 (ms 단위)
const UPLOAD_INTERVAL_MS = parseInt(process.env.ORBIT_UPLOAD_INTERVAL_MS || String(24 * 60 * 60 * 1000));
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

// ─── 로컬 서버 실시간 전송 (localhost 전용) ──────────
function postToLocalServer(events) {
  // 로컬 서버(4747)에만 전송 — 개인 실시간 뷰용
  try {
    const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: MEMBER_NAME });
    const req = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/api/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => res.resume());
    req.on('error', () => {}); // 서버 꺼져있으면 조용히 무시
    req.setTimeout(2000, () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

// ─── 하루 1번 Railway 일괄 업로드 ────────────────────

/** 마지막 업로드 이후 쌓인 이벤트를 로컬 DB에서 읽기 */
function readEventsSince(sinceTs) {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(DB_PATH, { readonly: true });
    // created_at > 마지막 업로드 시각 인 이벤트만 조회
    const since = sinceTs ? new Date(sinceTs).toISOString() : '2000-01-01';
    const rows = db.prepare(
      'SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC'
    ).all(since);
    db.close();
    return rows;
  } catch (e) {
    log(`readEventsSince error: ${e.message}`);
    return [];
  }
}

/** Railway 서버에 이벤트 배열 일괄 POST */
function uploadToRailway(events) {
  return new Promise((resolve) => {
    try {
      const body = JSON.stringify({ events, channelId: CHANNEL_ID, memberName: MEMBER_NAME });
      const url  = new URL('/api/hook', ORBIT_SERVER_URL);
      const isHttps = url.protocol === 'https:';
      const mod  = isHttps ? https : http;
      const headers = {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (ORBIT_TOKEN) headers['Authorization'] = `Bearer ${ORBIT_TOKEN}`;

      const req = mod.request({
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers,
      }, res => { res.resume(); resolve(res.statusCode); });

      req.on('error', (e) => { log(`Railway 업로드 오류: ${e.message}`); resolve(null); });
      req.setTimeout(30000, () => { req.destroy(); log('Railway 업로드 타임아웃'); resolve(null); });
      req.write(body);
      req.end();
    } catch (e) {
      log(`Railway 업로드 예외: ${e.message}`);
      resolve(null);
    }
  });
}

/**
 * 업로드 슬롯 결정: 하루 2번 (12시, 18시)
 * - 12:00~17:59 → "noon"   슬롯
 * - 18:00~23:59 → "evening" 슬롯
 * - 해당 슬롯을 오늘 아직 안 올렸으면 슬롯 문자열 반환, 아니면 null
 * 예) "2026-03-02-noon", "2026-03-02-evening"
 */
function currentUploadSlot(state) {
  const now   = new Date();
  const hour  = now.getHours();
  const today = now.toISOString().slice(0, 10); // YYYY-MM-DD

  let slot = null;
  if (hour >= 18) slot = `${today}-evening`; // 오후 6시 이후
  else if (hour >= 12) slot = `${today}-noon`; // 정오 이후

  if (!slot) return null;                          // 아직 업로드 시간 아님
  if ((state.uploadedSlots || []).includes(slot)) return null; // 이미 이 슬롯 완료

  return slot;
}

/** 하루 2번(12시·18시) 이후 첫 훅 실행 시 일괄 업로드 */
async function dailyUploadIfDue(state) {
  if (!ORBIT_SERVER_URL || !ORBIT_TOKEN) return; // 설정 없으면 스킵

  const slot = currentUploadSlot(state);
  if (!slot) return; // 업로드 시간 아님 또는 이미 완료

  if (!state.uploadedSlots) state.uploadedSlots = [];

  // 마지막 업로드 이후 쌓인 이벤트 조회
  const pending = readEventsSince(state.lastUploadTs || 0);
  if (pending.length === 0) {
    // 새 이벤트 없어도 슬롯 기록 (중복 방지)
    state.uploadedSlots.push(slot);
    // 슬롯 기록은 최근 10개만 유지 (파일 비대화 방지)
    if (state.uploadedSlots.length > 10) state.uploadedSlots = state.uploadedSlots.slice(-10);
    return;
  }

  log(`[UPLOAD] Railway 일괄 업로드 시작: ${pending.length}개 이벤트`);

  // SQLite row → 이벤트 객체 변환
  const events = pending.map(row => ({
    id:            row.id,
    type:          row.type,
    source:        row.source,
    sessionId:     row.session_id,
    userId:        row.user_id,
    channelId:     row.channel_id || CHANNEL_ID,
    parentEventId: row.parent_event_id,
    timestamp:     row.timestamp,
    data:          JSON.parse(row.data_json || '{}'),
    metadata:      JSON.parse(row.metadata_json || '{}'),
  }));

  const now    = Date.now();
  const status = await uploadToRailway(events);
  if (status === 200 || status === 201) {
    state.lastUploadTs = now;       // 다음 업로드 기준 시각
    state.uploadedSlots.push(slot); // 이 슬롯 완료 표시
    if (state.uploadedSlots.length > 10) state.uploadedSlots = state.uploadedSlots.slice(-10);
    log(`[UPLOAD] 완료 [${slot}]: ${events.length}개 → status ${status}`);
  } else {
    // 실패 시 슬롯 기록 안 함 → 다음 훅 실행 시 재시도
    log(`[UPLOAD] 실패 [${slot}]: status ${status} — 재시도 예정`);
  }
}

// ─── 메인 처리 ──────────────────────────────────────
let inputData = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { inputData += chunk; });
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(inputData);
    const sessionId = hookData.session_id || 'unknown';

    log(`hook=${hookData.hook_event_name} tool=${hookData.tool_name || '-'} session=${sessionId}`);

    // 세션 상태 로드
    const state = loadState();
    if (!state.sessions)     state.sessions = {};
    if (!state.lastUploadTs) state.lastUploadTs = 0; // 마지막 Railway 업로드 시각 (ms)
    if (!state.sessions[sessionId]) {
      state.sessions[sessionId] = {
        lastUserId:      null,
        lastAssistantId: null,
        sessionStartId:  null,
        pendingTools:    [],
        subagentStartIds: {},
      };
    }
    const sessionState = state.sessions[sessionId];

    // 이벤트 정규화
    const events = normalizeHookEvent(hookData, sessionState);

    // 각 이벤트 로컬 저장 + 상태 업데이트
    for (const event of events) {
      insertToDb(event);     // 1. SQLite 저장 (영구 보존)
      appendToJsonl(event);  // 2. JSONL 저장 (하위 호환)

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
          sessionState.pendingTools.push({ name: event.data.toolName, id: event.id });
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

    // 3. 로컬 서버에 실시간 전송 (localhost만, 개인 뷰용)
    if (events.length > 0) {
      postToLocalServer(events);
    }

    // 4. Railway 일괄 업로드 (하루 1번) — 24시간 경과 시에만 실행
    await dailyUploadIfDue(state);

    saveState(state);
  } catch (e) {
    log(`FATAL: ${e.message}\n${e.stack}`);
  }

  process.exit(0);
});
