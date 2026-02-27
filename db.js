/**
 * db.js
 * SQLite 초기화, 마이그레이션, 쿼리
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
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
  `);
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
      INSERT OR REPLACE INTO sessions (id, user_id, channel_id, started_at, source, model_id, project_dir, event_count, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active')
    `).run(
      event.sessionId, event.userId, event.channelId,
      event.timestamp, event.data.source || null,
      event.data.modelId || null, event.data.projectDir || null
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
  const eventCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const sessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const fileCount = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  const toolCount = db.prepare("SELECT COUNT(*) as c FROM events WHERE type LIKE 'tool.%'").get().c;
  return { eventCount, sessionCount, fileCount, toolCount };
}

// ─── 직렬화 헬퍼 ────────────────────────────────────
function deserializeEvent(row) {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    sessionId: row.session_id,
    userId: row.user_id,
    channelId: row.channel_id,
    parentEventId: row.parent_event_id,
    timestamp: row.timestamp,
    data: JSON.parse(row.data_json || '{}'),
    metadata: JSON.parse(row.metadata_json || '{}'),
  };
}

function getDb() { return db; }

module.exports = {
  initDatabase,
  getDb,
  insertEvent,
  getAllEvents,
  getEventsBySession,
  getEventsByType,
  searchEvents,
  getSessions,
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
};
