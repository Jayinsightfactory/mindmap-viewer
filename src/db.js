/**
 * db.js
 * SQLite 초기화, 마이그레이션, 쿼리
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'mindmap.db');
const CONV_FILE = path.join(__dirname, 'conversation.jsonl');

let db = null;

// ─── 초기화 ─────────────────────────────────────────
function initDatabase() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  createTables();
  migrateFromJsonl();

  return db;
}

function createTables() {
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

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_event_id);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      channel_id TEXT NOT NULL DEFAULT 'default',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      source TEXT,
      model_id TEXT,
      project_dir TEXT,
      title TEXT,
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

    CREATE TABLE IF NOT EXISTS annotations (
      id TEXT PRIMARY KEY,
      event_id TEXT,
      label TEXT NOT NULL,
      description TEXT,
      color TEXT DEFAULT '#f0c674',
      icon TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    -- 사용자 커스텀 라벨 (노드별 라벨 오버라이드)
    CREATE TABLE IF NOT EXISTS user_labels (
      event_id TEXT PRIMARY KEY,
      custom_header TEXT,
      custom_body TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 사용자 커스텀 카테고리
    CREATE TABLE IF NOT EXISTS user_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#8b949e',
      icon TEXT DEFAULT '📁',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 이벤트 타입 → 사용자 카테고리 매핑
    CREATE TABLE IF NOT EXISTS category_mappings (
      event_type TEXT NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (event_type, category_id),
      FOREIGN KEY (category_id) REFERENCES user_categories(id) ON DELETE CASCADE
    );

    -- 도구명 커스텀 매핑 (사용자가 도구 이름을 자유롭게 변경)
    CREATE TABLE IF NOT EXISTS tool_label_mappings (
      tool_name TEXT PRIMARY KEY,
      custom_label TEXT NOT NULL,
      custom_header TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 세션 목표 + 결과 (MCP save_outcome tool이 기록)
    CREATE TABLE IF NOT EXISTS outcomes (
      id           TEXT PRIMARY KEY,
      session_id   TEXT,
      user_id      TEXT DEFAULT 'local',
      goal         TEXT,
      result       TEXT,
      summary      TEXT,
      tools_used   TEXT,
      duration_min INTEGER,
      tags         TEXT,
      created_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suggestions (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      priority     INTEGER DEFAULT 3,
      title        TEXT NOT NULL,
      description  TEXT,
      evidence     TEXT,
      suggestion   TEXT,
      confidence   REAL DEFAULT 0.5,
      status       TEXT DEFAULT 'pending',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      responded_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          TEXT PRIMARY KEY,
      synced_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      event_count INTEGER,
      status      TEXT
    );

    CREATE TABLE IF NOT EXISTS kv_store (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- ─── 워크스페이스 (팀/회사 단위) ─────────────────────
    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      owner_id     TEXT NOT NULL,
      invite_code  TEXT UNIQUE NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- 워크스페이스 멤버십
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      team_name    TEXT NOT NULL DEFAULT '팀 1',
      joined_at    TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (user_id)      REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_wm_user ON workspace_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_wm_ws   ON workspace_members(workspace_id);

    -- 노드 소프트 삭제 (숨김 처리)
    CREATE TABLE IF NOT EXISTS hidden_events (
      event_id TEXT NOT NULL,
      user_id  TEXT NOT NULL DEFAULT 'local',
      hidden_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (event_id, user_id)
    );

    -- 노드 메모
    CREATE TABLE IF NOT EXISTS node_memos (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT DEFAULT 'local',
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- 즐겨찾기
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT DEFAULT 'local',
      label TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 트래커 핑 (확장 프로그램 활성 상태)
    CREATE TABLE IF NOT EXISTS tracker_pings (
      user_id TEXT PRIMARY KEY,
      last_ping TEXT DEFAULT (datetime('now'))
    );
  `);

  // ─── 컬럼 마이그레이션 (기존 DB 호환) ───────────────
  try { db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`); } catch {}
}

// ─── JSONL 마이그레이션 ─────────────────────────────
function migrateFromJsonl() {
  const count = db.prepare('SELECT COUNT(*) as c FROM events').get();
  if (count.c > 0) return; // 이미 데이터 있으면 스킵

  if (!fs.existsSync(CONV_FILE)) return;

  const content = fs.readFileSync(CONV_FILE, 'utf8');
  const lines = content.split('\n').filter(Boolean);

  if (lines.length === 0) return;

  console.log(`[DB] JSONL에서 ${lines.length}개 레코드 마이그레이션 중...`);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO events (id, type, source, session_id, user_id, channel_id, parent_event_id, timestamp, data_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // 기존 형식을 새 형식으로 변환
        const event = convertLegacyEntry(entry);
        if (event) {
          insert.run(
            event.id, event.type, event.source,
            event.sessionId, event.userId, event.channelId,
            event.parentEventId, event.timestamp,
            JSON.stringify(event.data), JSON.stringify(event.metadata || {})
          );
        }
      } catch (e) {
        // 잘못된 줄 무시
      }
    }
  });
  tx();

  const migrated = db.prepare('SELECT COUNT(*) as c FROM events').get();
  console.log(`[DB] 마이그레이션 완료: ${migrated.c}개 이벤트`);
}

function convertLegacyEntry(entry) {
  const { ulid: ulidFn } = require('ulid');
  const id = ulidFn(entry.ts ? new Date(entry.ts).getTime() : Date.now());

  if (entry.type === 'user') {
    return {
      id,
      type: 'user.message',
      source: 'claude-hook',
      sessionId: entry.session || 'unknown',
      userId: 'local',
      channelId: 'default',
      parentEventId: null,
      timestamp: entry.ts || new Date().toISOString(),
      data: {
        content: entry.content || '',
        contentPreview: (entry.content || '').substring(0, 200),
        wordCount: (entry.content || '').split(/\s+/).filter(Boolean).length,
      },
      metadata: { legacyId: entry.id },
    };
  }

  if (entry.type === 'assistant') {
    return {
      id,
      type: 'assistant.message',
      source: 'claude-hook',
      sessionId: entry.session || 'unknown',
      userId: 'local',
      channelId: 'default',
      parentEventId: null,
      timestamp: entry.ts || new Date().toISOString(),
      data: {
        content: entry.content || '',
        contentPreview: (entry.content || '').substring(0, 200),
        toolCalls: (entry.tools || []).map(t => ({ name: t.name })),
      },
      metadata: { legacyId: entry.id },
    };
  }

  if (entry.type === 'tool_event') {
    return {
      id,
      type: 'tool.end',
      source: 'claude-hook',
      sessionId: entry.session || 'unknown',
      userId: 'local',
      channelId: 'default',
      parentEventId: null,
      timestamp: entry.ts || new Date().toISOString(),
      data: {
        toolName: entry.tool || 'Unknown',
        inputPreview: entry.tool || '',
        success: entry.ok !== false,
        files: entry.files || [],
      },
      metadata: { legacyId: entry.id },
    };
  }

  return null;
}

// ─── 이벤트 CRUD ────────────────────────────────────
function insertEvent(event) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events (id, type, source, session_id, user_id, channel_id, parent_event_id, timestamp, data_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    event.id, event.type, event.source,
    event.sessionId, event.userId, event.channelId,
    event.parentEventId, event.timestamp,
    JSON.stringify(event.data), JSON.stringify(event.metadata || {})
  );

  // 세션 업데이트
  upsertSession(event);

  // 파일 업데이트
  if (event.data && event.data.filePath) {
    upsertFile(event.data.filePath, event.data.fileName, event.data.language, event.timestamp);
  }
  if (event.data && event.data.files) {
    for (const f of event.data.files) {
      if (f && !f.startsWith('[')) {
        const name = f.replace(/\\/g, '/').split('/').pop();
        upsertFile(f, name, null, event.timestamp);
      }
    }
  }
}

function upsertSession(event) {
  if (event.type === 'session.start') {
    db.prepare(`
      INSERT OR REPLACE INTO sessions (id, user_id, channel_id, started_at, source, model_id, project_dir, title, event_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active')
    `).run(
      event.sessionId, event.userId, event.channelId,
      event.timestamp, event.data.source || null,
      event.data.modelId || null, event.data.projectDir || null,
      event.data.title || null
    );
  } else if (event.type === 'session.end') {
    db.prepare(`UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ?`)
      .run(event.timestamp, event.sessionId);
  } else {
    // 세션이 없으면 생성, 있으면 카운트 증가
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(event.sessionId);
    if (existing) {
      db.prepare('UPDATE sessions SET event_count = event_count + 1 WHERE id = ?')
        .run(event.sessionId);
    } else {
      db.prepare(`
        INSERT INTO sessions (id, user_id, channel_id, started_at, event_count, status)
        VALUES (?, ?, ?, ?, 1, 'active')
      `).run(event.sessionId, event.userId, event.channelId, event.timestamp);
    }
  }
}

function upsertFile(filePath, fileName, language, timestamp) {
  const existing = db.prepare('SELECT path FROM files WHERE path = ?').get(filePath);
  if (existing) {
    db.prepare('UPDATE files SET last_accessed_at = ?, access_count = access_count + 1 WHERE path = ?')
      .run(timestamp, filePath);
  } else {
    db.prepare('INSERT INTO files (path, name, language, first_seen_at, last_accessed_at) VALUES (?, ?, ?, ?, ?)')
      .run(filePath, fileName, language, timestamp, timestamp);
  }
}

// ─── 조회 ───────────────────────────────────────────
function getAllEvents() {
  return db.prepare('SELECT * FROM events ORDER BY timestamp ASC').all()
    .map(deserializeEvent);
}

function getEventsBySession(sessionId) {
  return db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId)
    .map(deserializeEvent);
}

function getEventsByChannel(channelId) {
  return db.prepare('SELECT * FROM events WHERE channel_id = ? ORDER BY timestamp ASC').all(channelId)
    .map(deserializeEvent);
}

// 특정 사용자의 이벤트만 조회 (user_id 필터 — 프라이버시 격리)
// 'local'로 저장된 이벤트는 계정 주장(claim) 후 해당 user_id로 업데이트됨
function getEventsByUser(userId) {
  return db.prepare(`
    SELECT * FROM events WHERE user_id = ? ORDER BY timestamp ASC
  `).all(userId).map(deserializeEvent);
}

// 특정 사용자의 세션만 조회
function getSessionsByUser(userId) {
  return db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC
  `).all(userId);
}

// 특정 사용자의 통계
function getStatsByUser(userId) {
  const eventCount   = db.prepare('SELECT COUNT(*) as c FROM events WHERE user_id = ?').get(userId).c;
  const sessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(userId).c;
  const fileCount    = db.prepare('SELECT COUNT(*) as c FROM files').get().c; // 파일은 공용
  const toolCount    = db.prepare("SELECT COUNT(*) as c FROM events WHERE user_id = ? AND type LIKE 'tool.%'").get(userId).c;
  return { eventCount, sessionCount, fileCount, toolCount, aiSourceStats: {} };
}

// 'local' 이벤트를 특정 user_id로 귀속 (최초 로그인 시 기존 데이터 주장)
function claimLocalEvents(userId) {
  const result = db.prepare(`
    UPDATE events SET user_id = ? WHERE user_id = 'local' OR user_id = 'anonymous'
  `).run(userId);
  db.prepare(`
    UPDATE sessions SET user_id = ? WHERE user_id = 'local' OR user_id = 'anonymous'
  `).run(userId);
  return result.changes;
}

function getEventsByType(type) {
  return db.prepare('SELECT * FROM events WHERE type = ? ORDER BY timestamp ASC').all(type)
    .map(deserializeEvent);
}

function searchEvents(query) {
  const like = `%${query}%`;
  return db.prepare(`
    SELECT * FROM events
    WHERE data_json LIKE ? OR type LIKE ?
    ORDER BY timestamp ASC
    LIMIT 100
  `).all(like, like).map(deserializeEvent);
}

function getSessions() {
  return db.prepare('SELECT * FROM sessions ORDER BY started_at DESC').all();
}

function updateSessionTitle(sessionId, title) {
  return db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, sessionId);
}

function getFiles() {
  return db.prepare('SELECT * FROM files ORDER BY access_count DESC').all();
}

function getAnnotations() {
  return db.prepare('SELECT * FROM annotations ORDER BY created_at ASC').all();
}

function insertAnnotation(annotation) {
  db.prepare('INSERT INTO annotations (id, event_id, label, description, color, icon) VALUES (?, ?, ?, ?, ?, ?)')
    .run(annotation.id, annotation.eventId, annotation.label, annotation.description, annotation.color, annotation.icon);
}

function deleteAnnotation(id) {
  db.prepare('DELETE FROM annotations WHERE id = ?').run(id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
}

// ─── 사용자 라벨 CRUD ────────────────────────────────
function getUserLabels() {
  return db.prepare('SELECT * FROM user_labels').all();
}

function setUserLabel(eventId, customHeader, customBody) {
  db.prepare(`
    INSERT OR REPLACE INTO user_labels (event_id, custom_header, custom_body, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(eventId, customHeader || null, customBody || null);
}

function deleteUserLabel(eventId) {
  db.prepare('DELETE FROM user_labels WHERE event_id = ?').run(eventId);
}

// ─── 사용자 카테고리 CRUD ────────────────────────────
function getUserCategories() {
  const cats = db.prepare('SELECT * FROM user_categories ORDER BY sort_order ASC').all();
  for (const cat of cats) {
    const mappings = db.prepare('SELECT event_type FROM category_mappings WHERE category_id = ?').all(cat.id);
    cat.mappedTypes = mappings.map(m => m.event_type);
  }
  return cats;
}

function upsertUserCategory(category) {
  db.prepare(`
    INSERT OR REPLACE INTO user_categories (id, name, color, icon, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM user_categories WHERE id = ?), datetime('now')))
  `).run(category.id, category.name, category.color || '#8b949e', category.icon || '📁', category.sortOrder || 0, category.id);

  // 매핑 업데이트
  if (category.mappedTypes) {
    db.prepare('DELETE FROM category_mappings WHERE category_id = ?').run(category.id);
    const ins = db.prepare('INSERT OR IGNORE INTO category_mappings (event_type, category_id) VALUES (?, ?)');
    for (const type of category.mappedTypes) {
      ins.run(type, category.id);
    }
  }
}

function deleteUserCategory(id) {
  db.prepare('DELETE FROM category_mappings WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM user_categories WHERE id = ?').run(id);
}

// ─── 도구 라벨 매핑 CRUD ────────────────────────────
function getToolLabelMappings() {
  return db.prepare('SELECT * FROM tool_label_mappings').all();
}

function setToolLabelMapping(toolName, customLabel, customHeader) {
  db.prepare(`
    INSERT OR REPLACE INTO tool_label_mappings (tool_name, custom_label, custom_header, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(toolName, customLabel, customHeader || null);
}

function deleteToolLabelMapping(toolName) {
  db.prepare('DELETE FROM tool_label_mappings WHERE tool_name = ?').run(toolName);
}

// ─── 전체 사용자 설정 한번에 가져오기 ───────────────
function getUserConfig() {
  return {
    labels: getUserLabels(),
    categories: getUserCategories(),
    toolMappings: getToolLabelMappings(),
  };
}

// ─── 롤백 ───────────────────────────────────────────
function rollbackToEvent(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return false;

  db.prepare('DELETE FROM events WHERE timestamp > ?').run(event.timestamp);
  return true;
}

function clearAll() {
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM files');
  db.exec('DELETE FROM annotations');
}

// ─── 통계 ───────────────────────────────────────────
function getStats() {
  const eventCount   = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const sessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const fileCount    = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const toolCount    = db.prepare("SELECT COUNT(*) as c FROM events WHERE type LIKE 'tool.%'").get().c;

  // ── AI 소스별 이벤트 통계 ──────────────────────────
  // metadata_json 내 aiSource 값을 기반으로 집계
  const aiSourceRows = db.prepare(`
    SELECT
      json_extract(metadata_json, '$.aiSource') AS aiSource,
      COUNT(*) AS cnt
    FROM events
    WHERE json_extract(metadata_json, '$.aiSource') IS NOT NULL
    GROUP BY aiSource
    ORDER BY cnt DESC
  `).all();

  const aiSourceStats = {};
  for (const row of aiSourceRows) {
    if (row.aiSource) aiSourceStats[row.aiSource] = row.cnt;
  }

  // claude 이벤트 (aiSource 없는 기존 이벤트 포함)
  const claudeWithMeta = aiSourceStats['claude'] || 0;
  const noAiSource     = db.prepare("SELECT COUNT(*) as c FROM events WHERE json_extract(metadata_json, '$.aiSource') IS NULL").get().c;
  if (noAiSource > 0) aiSourceStats['claude'] = claudeWithMeta + noAiSource;

  return { eventCount, sessionCount, fileCount, toolCount, aiSourceStats };
}

// ─── 직렬화 헬퍼 ────────────────────────────────────
function deserializeEvent(row) {
  const data     = JSON.parse(row.data_json     || '{}');
  const metadata = JSON.parse(row.metadata_json || '{}');

  // ── 멀티 AI 필드 복원 ──────────────────────────
  // aiSource 는 insertEvent 시 metadata_json 에 저장됨
  // DB 라운드트립 후에도 graph-engine 이 올바른 스타일을 적용할 수 있도록 복원
  const aiSource = metadata.aiSource || data.aiSource || null;

  return {
    id:            row.id,
    type:          row.type,
    source:        row.source,
    sessionId:     row.session_id,
    userId:        row.user_id,
    channelId:     row.channel_id,
    parentEventId: row.parent_event_id,
    timestamp:     row.timestamp,
    data,
    metadata,
    aiSource,   // graph-engine 에서 AI_SOURCE_STYLES 조회에 사용
  };
}

// ─── 노드 숨김 (소프트 삭제) ──────────────────────
function hideEvents(eventIds, userId = 'local') {
  const stmt = db.prepare('INSERT OR IGNORE INTO hidden_events (event_id, user_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const id of eventIds) stmt.run(id, userId);
  });
  tx();
  return eventIds.length;
}

function unhideEvents(eventIds, userId = 'local') {
  const stmt = db.prepare('DELETE FROM hidden_events WHERE event_id = ? AND user_id = ?');
  const tx = db.transaction(() => {
    for (const id of eventIds) stmt.run(id, userId);
  });
  tx();
  return eventIds.length;
}

function unhideAllEvents(userId = 'local') {
  return db.prepare('DELETE FROM hidden_events WHERE user_id = ?').run(userId).changes;
}

function getHiddenEventIds(userId = 'local') {
  return db.prepare('SELECT event_id FROM hidden_events WHERE user_id = ?')
    .all(userId).map(r => r.event_id);
}

// ─── 노드 메모 CRUD ─────────────────────────────────
function getNodeMemos(userId = 'local') {
  return db.prepare('SELECT * FROM node_memos WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}

function upsertNodeMemo(id, eventId, userId, content) {
  db.prepare(`
    INSERT OR REPLACE INTO node_memos (id, event_id, user_id, content, created_at, updated_at)
    VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM node_memos WHERE id = ?), datetime('now')), datetime('now'))
  `).run(id, eventId, userId || 'local', content, id);
}

function deleteNodeMemo(id) {
  db.prepare('DELETE FROM node_memos WHERE id = ?').run(id);
}

// ─── 즐겨찾기 CRUD ──────────────────────────────────
function getBookmarks(userId = 'local') {
  return db.prepare('SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

function addBookmark(id, eventId, userId, label) {
  db.prepare('INSERT OR IGNORE INTO bookmarks (id, event_id, user_id, label) VALUES (?, ?, ?, ?)')
    .run(id, eventId, userId || 'local', label || null);
}

function removeBookmark(id) {
  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
}

// ─── 트래커 핑 ──────────────────────────────────────
function touchTrackerPing(userId = 'local') {
  db.prepare(`
    INSERT OR REPLACE INTO tracker_pings (user_id, last_ping)
    VALUES (?, datetime('now'))
  `).run(userId);
}

function getTrackerPing(userId = 'local') {
  return db.prepare('SELECT * FROM tracker_pings WHERE user_id = ?').get(userId);
}

function getDb() { return db; }

module.exports = {
  initDatabase,
  getDb,
  insertEvent,
  getAllEvents,
  getEventsBySession,
  getEventsByChannel,
  getEventsByType,
  searchEvents,
  getSessions,
  updateSessionTitle,
  getFiles,
  getAnnotations,
  insertAnnotation,
  deleteAnnotation,
  rollbackToEvent,
  clearAll,
  getStats,
  upsertFile,
  // 사용자 커스터마이징
  getUserLabels,
  setUserLabel,
  deleteUserLabel,
  getUserCategories,
  upsertUserCategory,
  deleteUserCategory,
  getToolLabelMappings,
  setToolLabelMapping,
  deleteToolLabelMapping,
  getUserConfig,
  // 사용자 격리
  getEventsByUser,
  getSessionsByUser,
  getStatsByUser,
  claimLocalEvents,
  // 노드 숨김 (소프트 삭제)
  hideEvents,
  unhideEvents,
  unhideAllEvents,
  getHiddenEventIds,
  // 노드 메모
  getNodeMemos,
  upsertNodeMemo,
  deleteNodeMemo,
  // 즐겨찾기
  getBookmarks,
  addBookmark,
  removeBookmark,
  // 트래커 핑
  touchTrackerPing,
  getTrackerPing,
};
