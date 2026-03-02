/**
 * save-turn.js
 * Claude Code 훅 스크립트 (10개 훅 이벤트 처리)
 *
 * [로컬] 이벤트 발생 시마다:
 *   - SQLite + JSONL 저장 (영구 보존)
 *   - 로컬 서버(localhost:4747)에 실시간 전송 (개인 뷰용)
 *
 * [Railway 업로드] 실시간 (훅 발생 즉시):
 *   - ORBIT_SERVER_URL 설정 시 매 훅마다 즉시 전송
 *   - 실패 시 로컬 미전송 큐에 저장 → 다음 훅 실행 시 재시도
 *   - ORBIT_TOKEN 없어도 동작 (단, 서버에서 인증 필요 시 설정)
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { normalizeHookEvent } = require('./event-normalizer');

// 로컬 서버 포트 (환경변수 또는 기본값 4747)
const SERVER_PORT = process.env.MINDMAP_PORT || 4747;

// ── ~/.orbit-config.json 에서 설정 읽기 (환경변수보다 우선순위 낮음) ──────
// 이유: Claude Code가 이미 실행 중일 때 설치 스크립트가 설정한 환경변수가
//       자식 프로세스에 전달되지 않는 문제를 파일 기반 설정으로 해결
function readOrbitConfig() {
  try {
    const os = require('os');
    const configPath = path.join(os.homedir(), '.orbit-config.json');
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}
  return {};
}
const _orbitConfig = readOrbitConfig();

// Railway 서버 URL — 설정 시 훅 발생마다 즉시 전송 (실시간)
// 우선순위: 환경변수 > ~/.orbit-config.json
const ORBIT_SERVER_URL = process.env.ORBIT_SERVER_URL || _orbitConfig.serverUrl || null;
// 사용자 인증 토큰 (원격 서버 전송 시 필요)
const ORBIT_TOKEN = process.env.ORBIT_TOKEN || _orbitConfig.token || '';
// 미전송 큐 파일 (Railway 전송 실패 시 임시 저장)
const PENDING_FILE = path.join(__dirname, '.pending-upload.jsonl');
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

// ─── Railway 실시간 전송 ──────────────────────────────

/** Railway 서버에 이벤트 배열 즉시 POST */
function uploadToRailway(events) {
  return new Promise((resolve) => {
    if (!ORBIT_SERVER_URL) return resolve(null);
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

      req.on('error', (e) => { log(`Railway 전송 오류: ${e.message}`); resolve(null); });
      req.setTimeout(10000, () => { req.destroy(); log('Railway 전송 타임아웃'); resolve(null); });
      req.write(body);
      req.end();
    } catch (e) {
      log(`Railway 전송 예외: ${e.message}`);
      resolve(null);
    }
  });
}

/** 미전송 큐에 저장 (Railway 오프라인 시 백업) */
function saveToPending(events) {
  try {
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(PENDING_FILE, lines);
  } catch {}
}

/** 미전송 큐 재시도 후 비우기 */
async function flushPending() {
  if (!fs.existsSync(PENDING_FILE)) return;
  try {
    const lines = fs.readFileSync(PENDING_FILE, 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length) return;
    const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!events.length) return;
    log(`[PENDING] 미전송 ${events.length}개 재시도`);
    const status = await uploadToRailway(events);
    if (status === 200 || status === 201) {
      fs.writeFileSync(PENDING_FILE, ''); // 성공 시 큐 비우기
      log(`[PENDING] 재전송 완료: ${events.length}개`);
    }
  } catch (e) {
    log(`[PENDING] 재시도 오류: ${e.message}`);
  }
}

/** 훅 실행마다 Railway에 즉시 전송 (실시간) */
async function realtimeUpload(events) {
  if (!ORBIT_SERVER_URL) return; // 설정 없으면 스킵

  // 먼저 미전송 큐 재시도
  await flushPending();

  // 현재 이벤트 즉시 전송
  const status = await uploadToRailway(events);
  if (status === 200 || status === 201) {
    log(`[REALTIME] Railway 전송 완료: ${events.length}개`);
  } else {
    // 실패 시 큐에 저장 → 다음 훅 실행 시 재시도
    saveToPending(events);
    log(`[REALTIME] Railway 전송 실패 (status=${status}) → 큐 저장`);
  }
}

// ─── Ollama 분석 (로컬 서버 없이 직접 호출) ────────────────────
// Stop 이벤트마다 작업 요약을 Ollama로 분석 → Railway 직접 전송
// 로컬 서버 종료 시에도 학습이 계속됨

const OLLAMA_PORT  = parseInt(process.env.OLLAMA_PORT  || '11434');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';

// Ollama /api/generate 직접 호출
function callOllama(prompt) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model:   OLLAMA_MODEL,
      prompt,
      stream:  false,
      options: { temperature: 0.2, num_predict: 300 },
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port:     OLLAMA_PORT,
      path:     '/api/generate',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const resp  = JSON.parse(data);
          const text  = resp.response || '';
          const match = text.match(/\{[\s\S]*\}/); // JSON 부분만 추출
          resolve(match ? JSON.parse(match[0]) : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));   // Ollama 꺼진 경우 조용히 무시
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Stop 이벤트에서 최근 대화를 Ollama로 분석 → Railway 직접 전송
// 플랫폼(로컬 서버) 꺼져도 학습 계속
async function analyzeAndUpload(hookData, events) {
  try {
    // 사용자 요청 텍스트 추출
    const userMsg = (hookData.transcript || [])
      .filter(m => m.role === 'user')
      .map(m => Array.isArray(m.content)
        ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
        : String(m.content || ''))
      .pop() || '';

    const toolNames = events
      .filter(e => e.type === 'tool.end')
      .map(e => e.data?.toolName)
      .filter(Boolean);

    if (!userMsg && toolNames.length === 0) return; // 분석할 내용 없으면 스킵

    const prompt = `다음 Claude Code 작업을 분석해서 JSON으로만 응답하세요.

사용자 요청: "${userMsg.slice(0, 300)}"
사용된 도구: ${toolNames.slice(0, 5).join(', ') || '없음'}

아래 JSON 형식으로만 응답 (추가 설명 없이):
{
  "topic": "작업 주제 (20자 이내)",
  "category": "버그수정|기능추가|리팩토링|문서|분석|기타",
  "tools": ["사용된도구들"],
  "summary": "작업 요약 (50자 이내)",
  "complexity": "low|medium|high"
}`;

    const insight = await callOllama(prompt);
    if (!insight) return; // Ollama 응답 없으면 조용히 스킵

    log(`[Ollama] 분석 완료: ${insight.topic} (${insight.category})`);

    // Railway로 직접 전송 (로컬 서버 불필요)
    if (ORBIT_SERVER_URL) {
      const insightEvent = {
        id:        `oi-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        type:      'ollama.insight',
        source:    'save-turn',
        sessionId: hookData.session_id || 'unknown',
        userId:    'local',
        channelId: CHANNEL_ID,
        timestamp: new Date().toISOString(),
        data:      { insight, model: OLLAMA_MODEL },
        metadata:  { hookEvent: hookData.hook_event_name },
      };
      await uploadToRailway([insightEvent]); // 기존 Railway 전송 함수 재사용
      log(`[Ollama] Railway 전송 완료`);
    }
  } catch (e) {
    log(`[Ollama] 분석 오류: ${e.message}`);
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
    if (!state.sessions) state.sessions = {};
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

    // Stop일 때 스냅샷 마커 저장 + Ollama 분석
    if (hookData.hook_event_name === 'Stop') {
      const lastEventId = events.length > 0 ? events[events.length - 1].id : 'unknown';
      const snapshotDir = path.join(SNAPSHOTS_DIR, `event-${lastEventId}`);
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(
        path.join(snapshotDir, 'marker.json'),
        JSON.stringify({ eventId: lastEventId, ts: new Date().toISOString(), session: sessionId }, null, 2)
      );

      // ★ Ollama 분석: 작업 완료 시 자동으로 요약 생성 → Railway 전송
      // 로컬 서버가 꺼져 있어도 Ollama(11434)가 실행 중이면 분석 계속
      analyzeAndUpload(hookData, events).catch(() => {}); // 비동기, 실패해도 무시
    }

    // 3. 로컬 서버에 실시간 전송 (localhost만, 개인 뷰용)
    if (events.length > 0) {
      postToLocalServer(events);
    }

    // 4. Railway 실시간 전송 (ORBIT_SERVER_URL 설정 시 즉시 전송)
    if (events.length > 0) {
      await realtimeUpload(events);
    }

    saveState(state);
  } catch (e) {
    log(`FATAL: ${e.message}\n${e.stack}`);
  }

  process.exit(0);
});
