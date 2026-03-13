/**
 * db-pg.js
 * PostgreSQL 버전 — DATABASE_URL 환경변수가 있을 때 자동 사용
 * 인터페이스는 db.js 와 동일 (drop-in replacement)
 */
const { Pool } = require('pg');
const { ulid } = require('ulid');
const { createPgOps } = require('./db-user-ops');

let pool = null;

// ─── 초기화 ─────────────────────────────────────────
// 동기 반환: pool을 즉시 반환하고 테이블 생성은 비동기로 처리
// (Node.js v24+ unhandled rejection 크래시 방지)
function initDatabase() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log('[DB] PostgreSQL 풀 생성 완료');
  // 테이블 생성 비동기 실행 — 실패해도 서버 프로세스는 유지
  createTables()
    .then(() => console.log('[DB] PostgreSQL 테이블 초기화 완료'))
    .catch(e => console.warn('[DB] 테이블 초기화 경고 (재시도됨):', e.message));
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

    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS team_hierarchy_id TEXT;
    ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS department_id TEXT;

    CREATE TABLE IF NOT EXISTS team_hierarchy (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_id    TEXT,
      name         TEXT NOT NULL,
      level_type   TEXT NOT NULL DEFAULT 'team',
      icon         TEXT DEFAULT '👥',
      color        TEXT DEFAULT '#58a6ff',
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_th_ws     ON team_hierarchy(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_th_parent ON team_hierarchy(parent_id);

    CREATE TABLE IF NOT EXISTS workspace_activity (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      user_id_1     TEXT NOT NULL,
      user_id_2     TEXT NOT NULL,
      activity_type TEXT NOT NULL DEFAULT 'file_collab',
      strength      REAL DEFAULT 0.5,
      last_interaction TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_wa_ws    ON workspace_activity(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_wa_users ON workspace_activity(user_id_1, user_id_2);

    CREATE TABLE IF NOT EXISTS multilevel_cache (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      level        INTEGER NOT NULL,
      role         TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      nodes_json   TEXT NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at   TEXT,
      UNIQUE(workspace_id, level, role, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mc_ws      ON multilevel_cache(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_mc_expires ON multilevel_cache(expires_at);

    -- 사용자 프로필 (LinkedIn 수준)
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id      TEXT PRIMARY KEY,
      name         TEXT,
      headline     TEXT,
      company      TEXT,
      location     TEXT,
      bio          TEXT,
      skills       TEXT DEFAULT '[]',
      experiences  TEXT DEFAULT '[]',
      education    TEXT DEFAULT '[]',
      links        TEXT DEFAULT '{}',
      avatar_url   TEXT,
      is_public    INTEGER DEFAULT 1,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_up_user_id ON user_profiles(user_id);

    -- 노드 소프트 삭제 (숨김 처리)
    CREATE TABLE IF NOT EXISTS hidden_events (
      event_id TEXT NOT NULL,
      user_id  TEXT NOT NULL DEFAULT 'local',
      hidden_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (event_id, user_id)
    );

    -- 노드 메모
    CREATE TABLE IF NOT EXISTS node_memos (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT DEFAULT 'local',
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 즐겨찾기
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      user_id TEXT DEFAULT 'local',
      label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- 트래커 핑 (확장 프로그램 활성 상태)
    CREATE TABLE IF NOT EXISTS tracker_pings (
      user_id TEXT PRIMARY KEY,
      last_ping TIMESTAMPTZ DEFAULT NOW()
    );

    -- 메시지 서비스 토큰 저장소
    CREATE TABLE IF NOT EXISTS service_tokens (
      id BIGSERIAL PRIMARY KEY,
      userId TEXT NOT NULL,
      service TEXT NOT NULL,
      accessToken TEXT NOT NULL,
      refreshToken TEXT,
      expiresAt BIGINT,
      isActive INTEGER DEFAULT 1,
      createdAt TIMESTAMPTZ DEFAULT NOW(),
      updatedAt TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(userId, service)
    );
    CREATE INDEX IF NOT EXISTS idx_service_tokens_userId ON service_tokens(userId);
    CREATE INDEX IF NOT EXISTS idx_service_tokens_service ON service_tokens(service);

    -- 결제/구독/알림 테이블
    CREATE TABLE IF NOT EXISTS payments (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      plan_id     TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      currency    TEXT DEFAULT 'KRW',
      status      TEXT DEFAULT 'pending',
      payment_key TEXT,
      order_id    TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id     TEXT PRIMARY KEY,
      plan_id     TEXT NOT NULL DEFAULT 'free',
      started_at  TIMESTAMPTZ DEFAULT NOW(),
      expires_at  TIMESTAMPTZ,
      status      TEXT DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      data_json   JSONB DEFAULT '{}',
      is_read     INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

    -- 마켓플레이스 솔루션 설치 기록
    CREATE TABLE IF NOT EXISTS solution_installations (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      solution_id   TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      config_json   JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sol_inst_user ON solution_installations(user_id);
    CREATE INDEX IF NOT EXISTS idx_sol_inst_status ON solution_installations(status);

    -- 기업 분석 결과
    CREATE TABLE IF NOT EXISTS analysis_results (
      id                    TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL,
      company_id            TEXT NOT NULL,
      findings_json         JSONB NOT NULL,
      recommendations_json  JSONB NOT NULL,
      created_at            TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_user ON analysis_results(user_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_company ON analysis_results(company_id);

    -- 솔루션 설치 ROI 추적
    CREATE TABLE IF NOT EXISTS solution_roi (
      id                TEXT PRIMARY KEY,
      installation_id   TEXT NOT NULL,
      date              TEXT NOT NULL,
      invested          REAL DEFAULT 0,
      actual_savings    REAL DEFAULT 0,
      status            TEXT,
      FOREIGN KEY (installation_id) REFERENCES solution_installations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_roi_inst ON solution_roi(installation_id);
    CREATE INDEX IF NOT EXISTS idx_roi_date ON solution_roi(date);
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

// ─── 사용자 격리 (db-user-ops.js 공유 모듈 위임) ────
// PG 어댑터: async 함수 반환 (기존 호출자 호환)
const _userOps = createPgOps(() => pool, deserializeEvent);
const getEventsByUser  = _userOps.getEventsByUser;
const getSessionsByUser = _userOps.getSessionsByUser;
const getStatsByUser   = _userOps.getStatsByUser;
const claimLocalEvents = _userOps.claimLocalEvents;

// ─── 기타 쿼리 ─────────────────────────────────────
async function getEventsByChannel(channelId) {
  const { rows } = await pool.query('SELECT * FROM events WHERE channel_id=$1 ORDER BY timestamp ASC', [channelId]);
  return rows.map(deserializeEvent);
}

async function updateSessionTitle(sessionId, title) {
  await pool.query('UPDATE sessions SET title=$1 WHERE id=$2', [title, sessionId]);
}

// ─── 노드 숨김 (소프트 삭제) ────────────────────────
async function hideEvents(eventIds, userId = 'local') {
  for (const id of eventIds) {
    await pool.query(
      'INSERT INTO hidden_events (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [id, userId]
    );
  }
  return eventIds.length;
}

async function unhideEvents(eventIds, userId = 'local') {
  for (const id of eventIds) {
    await pool.query('DELETE FROM hidden_events WHERE event_id=$1 AND user_id=$2', [id, userId]);
  }
  return eventIds.length;
}

async function unhideAllEvents(userId = 'local') {
  const result = await pool.query('DELETE FROM hidden_events WHERE user_id=$1', [userId]);
  return result.rowCount;
}

async function getHiddenEventIds(userId = 'local') {
  const { rows } = await pool.query('SELECT event_id FROM hidden_events WHERE user_id=$1', [userId]);
  return rows.map(r => r.event_id);
}

// ─── 노드 메모 / 즐겨찾기 (db-user-ops.js 공유 모듈 위임) ──
const getNodeMemos   = _userOps.getNodeMemos;
const upsertNodeMemo = _userOps.upsertNodeMemo;
const deleteNodeMemo = _userOps.deleteNodeMemo;
const getBookmarks   = _userOps.getBookmarks;
const addBookmark    = _userOps.addBookmark;
const removeBookmark = _userOps.removeBookmark;

// ─── 트래커 핑 ─────────────────────────────────────
async function touchTrackerPing(userId = 'local') {
  await pool.query(`
    INSERT INTO tracker_pings (user_id, last_ping)
    VALUES ($1, NOW())
    ON CONFLICT (user_id) DO UPDATE SET last_ping=NOW()
  `, [userId]);
}

async function getTrackerPing(userId = 'local') {
  const { rows } = await pool.query('SELECT * FROM tracker_pings WHERE user_id=$1', [userId]);
  return rows[0] || null;
}

// ─── 메시지 서비스 토큰 CRUD (save/get은 db-user-ops.js 위임) ──
const saveServiceToken = _userOps.saveServiceToken;
const getServiceToken  = _userOps.getServiceToken;

async function getUserServiceTokens(userId) {
  const { rows } = await pool.query(`
    SELECT service, accessToken AS "accessToken"
    FROM service_tokens WHERE userId=$1 AND isActive=1
  `, [userId]);
  const result = {};
  rows.forEach(r => { result[r.service] = r.accessToken; });
  return result;
}

async function toggleServiceToken(userId, service, isActive) {
  await pool.query(
    `UPDATE service_tokens SET isActive=$1, updatedAt=NOW() WHERE userId=$2 AND service=$3`,
    [isActive ? 1 : 0, userId, service]
  );
}

async function deleteServiceToken(userId, service) {
  await pool.query('DELETE FROM service_tokens WHERE userId=$1 AND service=$2', [userId, service]);
}

async function getUserTokenStatus(userId) {
  const { rows } = await pool.query(`
    SELECT service, isActive AS "isActive", updatedAt AS "updatedAt"
    FROM service_tokens WHERE userId=$1 ORDER BY service
  `, [userId]);
  return rows.map(r => ({
    service: r.service,
    connected: r.isActive === 1,
    lastUpdated: r.updatedAt,
  }));
}

// ─── 마켓플레이스 솔루션 설치 CRUD ──────────────────
async function installSolution(userId, solutionId) {
  const installationId = `inst_${Date.now()}_${userId}`;
  await pool.query(`
    INSERT INTO solution_installations (id, user_id, solution_id, status)
    VALUES ($1,$2,$3,'pending')
  `, [installationId, userId, solutionId]);
  return installationId;
}

async function getSolutionInstallation(installationId) {
  const { rows } = await pool.query('SELECT * FROM solution_installations WHERE id=$1', [installationId]);
  return rows[0] || null;
}

async function getUserSolutionInstallations(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM solution_installations WHERE user_id=$1 ORDER BY created_at DESC', [userId]
  );
  return rows;
}

async function updateSolutionInstallationStatus(installationId, status) {
  await pool.query(
    `UPDATE solution_installations SET status=$1, updated_at=NOW() WHERE id=$2`,
    [status, installationId]
  );
}

// ─── 기업 분석 결과 CRUD ───────────────────────────
async function saveAnalysisResult(analysisId, userId, companyId, findings, recommendations) {
  await pool.query(`
    INSERT INTO analysis_results (id, user_id, company_id, findings_json, recommendations_json)
    VALUES ($1,$2,$3,$4,$5)
  `, [analysisId, userId, companyId, JSON.stringify(findings), JSON.stringify(recommendations)]);
}

async function getAnalysisResult(analysisId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM analysis_results WHERE id=$1 AND user_id=$2', [analysisId, userId]
  );
  if (!rows[0]) return null;
  const result = rows[0];
  result.findings = typeof result.findings_json === 'object' ? result.findings_json : JSON.parse(result.findings_json);
  result.recommendations = typeof result.recommendations_json === 'object' ? result.recommendations_json : JSON.parse(result.recommendations_json);
  return result;
}

async function getUserAnalysisResults(userId, limit = 10) {
  const { rows } = await pool.query(
    'SELECT id, company_id, created_at FROM analysis_results WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit]
  );
  return rows;
}

// ─── ROI 추적 CRUD ─────────────────────────────────
async function addRoiTrackingRecord(installationId, date, invested, actualSavings, status) {
  const id = `roi_${Date.now()}`;
  await pool.query(`
    INSERT INTO solution_roi (id, installation_id, date, invested, actual_savings, status)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [id, installationId, date, invested, actualSavings, status]);
  return id;
}

async function getRoiTimeline(installationId) {
  const { rows } = await pool.query(
    'SELECT * FROM solution_roi WHERE installation_id=$1 ORDER BY date ASC', [installationId]
  );
  return rows;
}

async function calculateRoi(installationId) {
  const records = await getRoiTimeline(installationId);
  if (records.length === 0) return null;
  const totalInvested = records.reduce((sum, r) => sum + r.invested, 0);
  const totalSavings = records.reduce((sum, r) => sum + r.actual_savings, 0);
  const roi = totalInvested > 0 ? ((totalSavings - totalInvested) / totalInvested * 100) : 0;
  const breakEvenDate = records.find(r => r.actual_savings >= r.invested)?.date || null;
  return { totalInvested, totalSavings, roi, breakEvenDate, timeline: records };
}

// ─── 다계층 노드 시스템 CRUD ────────────────────────
async function getMultilevelCache(workspaceId, level, role, userId) {
  const { rows } = await pool.query(`
    SELECT nodes_json FROM multilevel_cache
    WHERE workspace_id=$1 AND level=$2 AND role=$3 AND user_id=$4
    AND expires_at::timestamptz > NOW()
  `, [workspaceId, level, role, userId]);
  if (!rows[0]) return null;
  return typeof rows[0].nodes_json === 'object' ? rows[0].nodes_json : JSON.parse(rows[0].nodes_json);
}

async function saveMultilevelCache(workspaceId, level, role, userId, nodesJson) {
  const id = `cache_${workspaceId}_${level}_${role}_${userId}_${Date.now()}`;
  await pool.query(`
    INSERT INTO multilevel_cache (id, workspace_id, level, role, user_id, nodes_json, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '15 minutes')
    ON CONFLICT (workspace_id, level, role, user_id) DO UPDATE SET
      nodes_json=$6, generated_at=NOW(), expires_at=NOW() + INTERVAL '15 minutes'
  `, [id, workspaceId, level, role, userId, JSON.stringify(nodesJson)]);
}

async function invalidateMultilevelCache(workspaceId) {
  await pool.query('DELETE FROM multilevel_cache WHERE workspace_id=$1', [workspaceId]);
}

async function saveTeamHierarchy(id, workspaceId, parentId, name, levelType, icon, color) {
  await pool.query(`
    INSERT INTO team_hierarchy (id, workspace_id, parent_id, name, level_type, icon, color)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET name=$4, level_type=$5, icon=$6, color=$7
  `, [id, workspaceId, parentId || null, name, levelType, icon || '👥', color || '#58a6ff']);
}

async function getWorkspaceTeamHierarchy(workspaceId) {
  const { rows } = await pool.query(
    'SELECT * FROM team_hierarchy WHERE workspace_id=$1 ORDER BY created_at ASC', [workspaceId]
  );
  return rows;
}

async function getTeamsByParentId(parentId) {
  const { rows } = await pool.query(
    'SELECT * FROM team_hierarchy WHERE parent_id=$1 ORDER BY created_at ASC', [parentId || null]
  );
  return rows;
}

// ─── 워크스페이스 활동 CRUD ─────────────────────────
async function saveWorkspaceActivity(workspaceId, userId1, userId2, activityType, strength) {
  const id = `activity_${workspaceId}_${userId1}_${userId2}_${Date.now()}`;
  const [id1, id2] = [userId1, userId2].sort();
  await pool.query(`
    INSERT INTO workspace_activity (id, workspace_id, user_id_1, user_id_2, activity_type, strength, last_interaction)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (id) DO UPDATE SET strength=$6, last_interaction=NOW()
  `, [id, workspaceId, id1, id2, activityType, strength]);
}

async function getWorkspaceActivityByUser(workspaceId, userId) {
  const { rows } = await pool.query(`
    SELECT * FROM workspace_activity
    WHERE workspace_id=$1 AND (user_id_1=$2 OR user_id_2=$2)
    ORDER BY strength DESC, last_interaction DESC
  `, [workspaceId, userId]);
  return rows;
}

async function getWorkspaceActivityAll(workspaceId) {
  const { rows } = await pool.query(
    'SELECT * FROM workspace_activity WHERE workspace_id=$1 ORDER BY strength DESC', [workspaceId]
  );
  return rows;
}

async function updateWorkspaceActivityStrength(workspaceId, userId1, userId2, strengthDelta = 0.1) {
  const [id1, id2] = [userId1, userId2].sort();
  await pool.query(`
    UPDATE workspace_activity
    SET strength = LEAST(1.0, strength + $1), last_interaction=NOW()
    WHERE workspace_id=$2 AND user_id_1=$3 AND user_id_2=$4
  `, [strengthDelta, workspaceId, id1, id2]);
}

module.exports = {
  initDatabase, getDb,
  insertEvent, getAllEvents, getEventsBySession, getEventsByType, searchEvents,
  getSessions, getFiles, getAnnotations, insertAnnotation, deleteAnnotation,
  rollbackToEvent, clearAll, getStats, upsertFile,
  getUserLabels, setUserLabel, deleteUserLabel,
  getUserCategories, upsertUserCategory, deleteUserCategory,
  getToolLabelMappings, setToolLabelMapping, deleteToolLabelMapping,
  getUserConfig,
  // 사용자 격리
  getEventsByUser, getSessionsByUser, getStatsByUser, claimLocalEvents,
  getEventsByChannel, updateSessionTitle,
  // 노드 숨김 (소프트 삭제)
  hideEvents, unhideEvents, unhideAllEvents, getHiddenEventIds,
  // 노드 메모
  getNodeMemos, upsertNodeMemo, deleteNodeMemo,
  // 즐겨찾기
  getBookmarks, addBookmark, removeBookmark,
  // 트래커 핑
  touchTrackerPing, getTrackerPing,
  // 메시지 서비스 토큰
  saveServiceToken, getServiceToken, getUserServiceTokens, toggleServiceToken,
  deleteServiceToken, getUserTokenStatus,
  // 마켓플레이스 솔루션
  installSolution, getSolutionInstallation, getUserSolutionInstallations,
  updateSolutionInstallationStatus,
  // 기업 분석
  saveAnalysisResult, getAnalysisResult, getUserAnalysisResults,
  // ROI 추적
  addRoiTrackingRecord, getRoiTimeline, calculateRoi,
  // 다계층 노드 시스템
  getMultilevelCache, saveMultilevelCache, invalidateMultilevelCache,
  saveTeamHierarchy, getWorkspaceTeamHierarchy, getTeamsByParentId,
  // 워크스페이스 활동
  saveWorkspaceActivity, getWorkspaceActivityByUser, getWorkspaceActivityAll,
  updateWorkspaceActivityStrength,
};
