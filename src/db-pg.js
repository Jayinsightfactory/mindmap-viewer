/**
 * db-pg.js
 * PostgreSQL 버전 — DATABASE_URL 환경변수가 있을 때 자동 사용
 * 인터페이스는 db.js 와 동일 (drop-in replacement)
 */
const { Pool } = require('pg');
const { ulid } = require('ulid');

let pool = null;

// ─── 초기화 ─────────────────────────────────────────
async function initDatabase() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await createTables();
  console.log('[DB] PostgreSQL 초기화 완료');
  return pool;
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'claude-hook',
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'local',
      channel_id TEXT NOT NULL DEFAULT 'default',
      parent_event_id TEXT,
      timestamp TEXT NOT NULL,
      data_json JSONB NOT NULL DEFAULT '{}',
      metadata_json JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_events_session   ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type      ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_parent    ON events(parent_event_id);
    CREATE INDEX IF NOT EXISTS idx_events_data_gin  ON events USING GIN (data_json);

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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );

    CREATE TABLE IF NOT EXISTS user_labels (
      event_id TEXT PRIMARY KEY,
      custom_header TEXT,
      custom_body TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS user_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#8b949e',
      icon TEXT DEFAULT '📁',
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS category_mappings (
      event_type TEXT NOT NULL,
      category_id TEXT NOT NULL,
      PRIMARY KEY (event_type, category_id),
      FOREIGN KEY (category_id) REFERENCES user_categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_label_mappings (
      tool_name TEXT PRIMARY KEY,
      custom_label TEXT NOT NULL,
      custom_header TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      owner_id     TEXT NOT NULL,
      invite_code  TEXT UNIQUE NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      team_name    TEXT NOT NULL DEFAULT '팀 1',
      joined_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (workspace_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_wm_user ON workspace_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_wm_ws   ON workspace_members(workspace_id);
  `);
}

// ─── 이벤트 CRUD ────────────────────────────────────
async function insertEvent(event) {
  await pool.query(`
    INSERT INTO events (id, type, source, session_id, user_id, channel_id, parent_event_id, timestamp, data_json, metadata_json)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO NOTHING
  `, [
    event.id, event.type, event.source,
    event.sessionId, event.userId, event.channelId,
    event.parentEventId, event.timestamp,
    event.data, event.metadata || {},
  ]);

  await upsertSession(event);

  if (event.data?.filePath) {
    await upsertFile(event.data.filePath, event.data.fileName, event.data.language, event.timestamp);
  }
  if (event.data?.files) {
    for (const f of event.data.files) {
      if (f && !f.startsWith('[')) {
        const name = f.replace(/\\/g, '/').split('/').pop();
        await upsertFile(f, name, null, event.timestamp);
      }
    }
  }
}

async function upsertSession(event) {
  if (event.type === 'session.start') {
    await pool.query(`
      INSERT INTO sessions (id, user_id, channel_id, started_at, source, model_id, project_dir, event_count, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,1,'active')
      ON CONFLICT (id) DO UPDATE SET status='active'
    `, [event.sessionId, event.userId, event.channelId, event.timestamp,
        event.data.source || null, event.data.modelId || null, event.data.projectDir || null]);
  } else if (event.type === 'session.end') {
    await pool.query(`UPDATE sessions SET ended_at=$1, status='ended' WHERE id=$2`, [event.timestamp, event.sessionId]);
  } else {
    const { rows } = await pool.query('SELECT id FROM sessions WHERE id=$1', [event.sessionId]);
    if (rows.length > 0) {
      await pool.query('UPDATE sessions SET event_count=event_count+1 WHERE id=$1', [event.sessionId]);
    } else {
      await pool.query(`
        INSERT INTO sessions (id, user_id, channel_id, started_at, event_count, status)
        VALUES ($1,$2,$3,$4,1,'active')
      `, [event.sessionId, event.userId, event.channelId, event.timestamp]);
    }
  }
}

async function upsertFile(filePath, fileName, language, timestamp) {
  await pool.query(`
    INSERT INTO files (path, name, language, first_seen_at, last_accessed_at)
    VALUES ($1,$2,$3,$4,$4)
    ON CONFLICT (path) DO UPDATE SET last_accessed_at=$4, access_count=files.access_count+1
  `, [filePath, fileName, language, timestamp]);
}

// ─── 조회 ───────────────────────────────────────────
async function getAllEvents() {
  const { rows } = await pool.query('SELECT * FROM events ORDER BY timestamp ASC');
  return rows.map(deserializeEvent);
}

async function getEventsBySession(sessionId) {
  const { rows } = await pool.query('SELECT * FROM events WHERE session_id=$1 ORDER BY timestamp ASC', [sessionId]);
  return rows.map(deserializeEvent);
}

async function getEventsByType(type) {
  const { rows } = await pool.query('SELECT * FROM events WHERE type=$1 ORDER BY timestamp ASC', [type]);
  return rows.map(deserializeEvent);
}

async function searchEvents(query) {
  const like = `%${query}%`;
  const { rows } = await pool.query(`
    SELECT * FROM events
    WHERE data_json::text ILIKE $1 OR type ILIKE $1
    ORDER BY timestamp ASC LIMIT 100
  `, [like]);
  return rows.map(deserializeEvent);
}

async function getSessions() {
  const { rows } = await pool.query('SELECT * FROM sessions ORDER BY started_at DESC');
  return rows;
}

async function getFiles() {
  const { rows } = await pool.query('SELECT * FROM files ORDER BY access_count DESC');
  return rows;
}

async function getAnnotations() {
  const { rows } = await pool.query('SELECT * FROM annotations ORDER BY created_at ASC');
  return rows;
}

async function insertAnnotation(annotation) {
  await pool.query(
    'INSERT INTO annotations (id, event_id, label, description, color, icon) VALUES ($1,$2,$3,$4,$5,$6)',
    [annotation.id, annotation.eventId, annotation.label, annotation.description, annotation.color, annotation.icon]
  );
}

async function deleteAnnotation(id) {
  await pool.query('DELETE FROM annotations WHERE id=$1', [id]);
  await pool.query('DELETE FROM events WHERE id=$1', [id]);
}

// ─── 사용자 라벨 ─────────────────────────────────────
async function getUserLabels() {
  const { rows } = await pool.query('SELECT * FROM user_labels');
  return rows;
}

async function setUserLabel(eventId, customHeader, customBody) {
  await pool.query(`
    INSERT INTO user_labels (event_id, custom_header, custom_body, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (event_id) DO UPDATE SET custom_header=$2, custom_body=$3, updated_at=NOW()
  `, [eventId, customHeader || null, customBody || null]);
}

async function deleteUserLabel(eventId) {
  await pool.query('DELETE FROM user_labels WHERE event_id=$1', [eventId]);
}

// ─── 사용자 카테고리 ──────────────────────────────────
async function getUserCategories() {
  const { rows: cats } = await pool.query('SELECT * FROM user_categories ORDER BY sort_order ASC');
  for (const cat of cats) {
    const { rows: mappings } = await pool.query('SELECT event_type FROM category_mappings WHERE category_id=$1', [cat.id]);
    cat.mappedTypes = mappings.map(m => m.event_type);
  }
  return cats;
}

async function upsertUserCategory(category) {
  await pool.query(`
    INSERT INTO user_categories (id, name, color, icon, sort_order)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, icon=$4, sort_order=$5
  `, [category.id, category.name, category.color || '#8b949e', category.icon || '📁', category.sortOrder || 0]);

  if (category.mappedTypes) {
    await pool.query('DELETE FROM category_mappings WHERE category_id=$1', [category.id]);
    for (const type of category.mappedTypes) {
      await pool.query('INSERT INTO category_mappings (event_type, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [type, category.id]);
    }
  }
}

async function deleteUserCategory(id) {
  await pool.query('DELETE FROM category_mappings WHERE category_id=$1', [id]);
  await pool.query('DELETE FROM user_categories WHERE id=$1', [id]);
}

// ─── 도구 라벨 매핑 ───────────────────────────────────
async function getToolLabelMappings() {
  const { rows } = await pool.query('SELECT * FROM tool_label_mappings');
  return rows;
}

async function setToolLabelMapping(toolName, customLabel, customHeader) {
  await pool.query(`
    INSERT INTO tool_label_mappings (tool_name, custom_label, custom_header, updated_at)
    VALUES ($1,$2,$3,NOW())
    ON CONFLICT (tool_name) DO UPDATE SET custom_label=$2, custom_header=$3, updated_at=NOW()
  `, [toolName, customLabel, customHeader || null]);
}

async function deleteToolLabelMapping(toolName) {
  await pool.query('DELETE FROM tool_label_mappings WHERE tool_name=$1', [toolName]);
}

async function getUserConfig() {
  const [labels, categories, toolMappings] = await Promise.all([
    getUserLabels(), getUserCategories(), getToolLabelMappings(),
  ]);
  return { labels, categories, toolMappings };
}

// ─── 롤백 / 전체 삭제 ────────────────────────────────
async function rollbackToEvent(eventId) {
  const { rows } = await pool.query('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!rows.length) return false;
  await pool.query('DELETE FROM events WHERE timestamp > $1', [rows[0].timestamp]);
  return true;
}

async function clearAll() {
  await pool.query('DELETE FROM events');
  await pool.query('DELETE FROM sessions');
  await pool.query('DELETE FROM files');
  await pool.query('DELETE FROM annotations');
}

// ─── 통계 ───────────────────────────────────────────
async function getStats() {
  const [e, s, f, t, ai] = await Promise.all([
    pool.query("SELECT COUNT(*) AS c FROM events"),
    pool.query("SELECT COUNT(*) AS c FROM sessions"),
    pool.query("SELECT COUNT(*) AS c FROM files"),
    pool.query("SELECT COUNT(*) AS c FROM events WHERE type LIKE 'tool.%'"),
    pool.query(`
      SELECT metadata_json->>'aiSource' AS ai_source, COUNT(*) AS cnt
      FROM events
      WHERE metadata_json->>'aiSource' IS NOT NULL
      GROUP BY ai_source ORDER BY cnt DESC
    `),
  ]);

  const aiSourceStats = {};
  for (const row of ai.rows) {
    if (row.ai_source) aiSourceStats[row.ai_source] = parseInt(row.cnt);
  }
  const { rows: noAi } = await pool.query("SELECT COUNT(*) AS c FROM events WHERE metadata_json->>'aiSource' IS NULL");
  const noAiCount = parseInt(noAi[0].c);
  if (noAiCount > 0) aiSourceStats['claude'] = (aiSourceStats['claude'] || 0) + noAiCount;

  return {
    eventCount:   parseInt(e.rows[0].c),
    sessionCount: parseInt(s.rows[0].c),
    fileCount:    parseInt(f.rows[0].c),
    toolCount:    parseInt(t.rows[0].c),
    aiSourceStats,
  };
}

// ─── 직렬화 헬퍼 ────────────────────────────────────
function deserializeEvent(row) {
  const data     = typeof row.data_json     === 'object' ? row.data_json     : JSON.parse(row.data_json     || '{}');
  const metadata = typeof row.metadata_json === 'object' ? row.metadata_json : JSON.parse(row.metadata_json || '{}');
  const aiSource = metadata.aiSource || data.aiSource || null;
  return {
    id: row.id, type: row.type, source: row.source,
    sessionId: row.session_id, userId: row.user_id, channelId: row.channel_id,
    parentEventId: row.parent_event_id, timestamp: row.timestamp,
    data, metadata, aiSource,
  };
}

function getDb() { return pool; }

module.exports = {
  initDatabase, getDb,
  insertEvent, getAllEvents, getEventsBySession, getEventsByType, searchEvents,
  getSessions, getFiles, getAnnotations, insertAnnotation, deleteAnnotation,
  rollbackToEvent, clearAll, getStats, upsertFile,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping,
  getUserConfig,
};
