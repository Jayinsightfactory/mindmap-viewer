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
  console.log(`[DB] 경로: ${DB_PATH}`);

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

    -- ─── 워크스페이스 (회사 단위) ─────────────────────────
    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      company_name TEXT NOT NULL DEFAULT '',
      owner_id     TEXT NOT NULL,
      invite_code  TEXT UNIQUE NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- ─── 회사 (Level 3) ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS org_companies (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      status       TEXT DEFAULT 'active',
      created_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_comp_ws ON org_companies(workspace_id);

    -- ─── 부서 (Level 2) ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS org_departments (
      id           TEXT PRIMARY KEY,
      company_id   TEXT NOT NULL,
      name         TEXT NOT NULL,
      head_id      TEXT DEFAULT '',
      status       TEXT DEFAULT 'active',
      created_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (company_id) REFERENCES org_companies(id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_dept_comp ON org_departments(company_id);

    -- ─── 팀 (Level 1) ──────────────────────────────────────
    CREATE TABLE IF NOT EXISTS org_teams (
      id           TEXT PRIMARY KEY,
      department_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      leader_id    TEXT DEFAULT '',
      status       TEXT DEFAULT 'active',
      created_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (department_id) REFERENCES org_departments(id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_team_dept ON org_teams(department_id);

    -- ─── 개인/멤버 (Level 0) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS org_members (
      id           TEXT PRIMARY KEY,
      team_id      TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      position     TEXT DEFAULT '',
      status       TEXT DEFAULT 'active',
      joined_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES org_teams(id),
      UNIQUE(team_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_org_mem_team ON org_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_org_mem_user ON org_members(user_id);

    -- ─── 워크스페이스 멤버십 (기존 호환성)
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      user_id      TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      team_name    TEXT NOT NULL DEFAULT '팀 1',
      joined_at    TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (workspace_id, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
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

    -- 메시지 서비스 토큰 저장소
    CREATE TABLE IF NOT EXISTS service_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      service TEXT NOT NULL,
      accessToken TEXT NOT NULL,
      refreshToken TEXT,
      expiresAt INTEGER,
      isActive INTEGER DEFAULT 1,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now')),
      UNIQUE(userId, service),
      FOREIGN KEY (userId) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_service_tokens_userId ON service_tokens(userId);
    CREATE INDEX IF NOT EXISTS idx_service_tokens_service ON service_tokens(service);
  `);

  // ─── 컬럼 마이그레이션 (기존 DB 호환) ───────────────
  try { db.exec(`ALTER TABLE sessions ADD COLUMN title TEXT`); } catch {}

  // ─── FK 마이그레이션: workspace_members의 users FK 제거 ───
  try {
    const fkInfo = db.pragma('foreign_key_list(workspace_members)');
    const hasUserFk = fkInfo.some(fk => fk.table === 'users');
    if (hasUserFk) {
      console.log('[DB] workspace_members FK 마이그레이션 (users FK 제거)…');
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE workspace_members_new (
          workspace_id TEXT NOT NULL,
          user_id      TEXT NOT NULL,
          role         TEXT NOT NULL DEFAULT 'member',
          team_name    TEXT NOT NULL DEFAULT '팀 1',
          joined_at    TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (workspace_id, user_id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
        );
        INSERT INTO workspace_members_new SELECT * FROM workspace_members;
        DROP TABLE workspace_members;
        ALTER TABLE workspace_members_new RENAME TO workspace_members;
        CREATE INDEX IF NOT EXISTS idx_wm_user ON workspace_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_wm_ws ON workspace_members(workspace_id);
      `);
      db.pragma('foreign_keys = ON');
      console.log('[DB] workspace_members FK 마이그레이션 완료');
    }
  } catch (e) { console.warn('[DB] FK migration skip:', e.message); }

  // ─── 컬럼 마이그레이션: workspace_members에 team_hierarchy_id, department_id 추가 ───
  try {
    db.exec(`ALTER TABLE workspace_members ADD COLUMN team_hierarchy_id TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE workspace_members ADD COLUMN department_id TEXT`);
  } catch {}

  // ─── 결제/구독/알림 테이블 ───────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      plan_id     TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      currency    TEXT DEFAULT 'KRW',
      status      TEXT DEFAULT 'pending',
      payment_key TEXT,
      order_id    TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      confirmed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id     TEXT PRIMARY KEY,
      plan_id     TEXT NOT NULL DEFAULT 'free',
      started_at  TEXT DEFAULT (datetime('now')),
      expires_at  TEXT,
      status      TEXT DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT,
      data_json   TEXT DEFAULT '{}',
      is_read     INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id);

    -- ─── 마켓플레이스 솔루션 설치 기록 ─────────────────────────────────────
    CREATE TABLE IF NOT EXISTS solution_installations (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      solution_id   TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',  -- pending, installing, active, completed
      config_json   TEXT DEFAULT '{}',
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES events(user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_sol_inst_user ON solution_installations(user_id);
    CREATE INDEX IF NOT EXISTS idx_sol_inst_status ON solution_installations(status);

    -- ─── 기업 분석 결과 ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS analysis_results (
      id                    TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL,
      company_id            TEXT NOT NULL,
      findings_json         TEXT NOT NULL,
      recommendations_json  TEXT NOT NULL,
      created_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_user ON analysis_results(user_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_company ON analysis_results(company_id);

    -- ─── 솔루션 설치 ROI 추적 ──────────────────────────────────────────────────
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

    -- ─── 워크스페이스 다계층 노드 시스템 ────────────────────────────────────────
    -- 팀/부서 조직 구조
    CREATE TABLE IF NOT EXISTS team_hierarchy (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL,
      level_type TEXT NOT NULL,
      icon TEXT DEFAULT '👥',
      color TEXT DEFAULT '#58a6ff',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
      FOREIGN KEY (parent_id) REFERENCES team_hierarchy(id)
    );
    CREATE INDEX IF NOT EXISTS idx_th_ws ON team_hierarchy(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_th_parent ON team_hierarchy(parent_id);

    -- 협업 신호 (workspace_activity)
    CREATE TABLE IF NOT EXISTS workspace_activity (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      user_id_1 TEXT NOT NULL,
      user_id_2 TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      strength REAL DEFAULT 0.5,
      last_interaction TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );
    CREATE INDEX IF NOT EXISTS idx_wa_ws ON workspace_activity(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_wa_users ON workspace_activity(user_id_1, user_id_2);

    -- 다계층 노드 캐시 (권한별)
    CREATE TABLE IF NOT EXISTS multilevel_cache (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      level INTEGER NOT NULL,
      role TEXT NOT NULL,
      user_id TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      UNIQUE(workspace_id, level, role, user_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
    );
    CREATE INDEX IF NOT EXISTS idx_mc_ws ON multilevel_cache(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_mc_expires ON multilevel_cache(expires_at);
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
  // 필수 필드 기본값 보장 (INSERT OR IGNORE가 NOT NULL 위반 시 조용히 무시하므로)
  if (!event.id)        event.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  if (!event.source)    event.source = 'claude-hook';
  if (!event.sessionId) event.sessionId = 'default';
  if (!event.userId)    event.userId = 'local';
  if (!event.channelId) event.channelId = 'default';
  if (!event.timestamp) event.timestamp = new Date().toISOString();
  if (event.data == null) event.data = {};

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO events (id, type, source, session_id, user_id, channel_id, parent_event_id, timestamp, data_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    event.id, event.type, event.source,
    event.sessionId, event.userId, event.channelId,
    event.parentEventId, event.timestamp,
    JSON.stringify(event.data), JSON.stringify(event.metadata || {})
  );
  if (info.changes === 0) {
    console.warn(`[DB] insertEvent 무시됨 (중복 id=${event.id})`);
  }

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
function getAllEvents(limit) {
  if (limit) {
    return db.prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?').all(limit)
      .map(deserializeEvent).reverse();
  }
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
  try {
    const result = db.prepare(`
      UPDATE events SET user_id = ? WHERE user_id = 'local' OR user_id = 'anonymous'
    `).run(userId);
    db.prepare(`
      UPDATE sessions SET user_id = ? WHERE user_id = 'local' OR user_id = 'anonymous'
    `).run(userId);
    return result.changes;
  } catch (e) {
    // Handle foreign key constraint errors gracefully
    console.warn('[DB] claimLocalEvents error:', e.message);
    return 0;
  }
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

// ─── 메시지 서비스 토큰 CRUD ──────────────────────────────
function saveServiceToken(userId, service, { accessToken, refreshToken, expiresAt }) {
  const stmt = db.prepare(`
    INSERT INTO service_tokens (userId, service, accessToken, refreshToken, expiresAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(userId, service) DO UPDATE SET
      accessToken = excluded.accessToken,
      refreshToken = excluded.refreshToken,
      expiresAt = excluded.expiresAt,
      isActive = 1,
      updatedAt = datetime('now')
  `);
  stmt.run(userId, service, accessToken, refreshToken, expiresAt);
}

function getServiceToken(userId, service) {
  return db.prepare(`
    SELECT accessToken, refreshToken, expiresAt, isActive
    FROM service_tokens
    WHERE userId = ? AND service = ? AND isActive = 1
  `).get(userId, service);
}

function getUserServiceTokens(userId) {
  const rows = db.prepare(`
    SELECT service, accessToken FROM service_tokens
    WHERE userId = ? AND isActive = 1
  `).all(userId);

  const result = {};
  rows.forEach(r => {
    result[r.service] = r.accessToken;
  });
  return result;
}

function toggleServiceToken(userId, service, isActive) {
  db.prepare(`
    UPDATE service_tokens SET isActive = ?, updatedAt = datetime('now')
    WHERE userId = ? AND service = ?
  `).run(isActive ? 1 : 0, userId, service);
}

function deleteServiceToken(userId, service) {
  db.prepare(`
    DELETE FROM service_tokens WHERE userId = ? AND service = ?
  `).run(userId, service);
}

function getUserTokenStatus(userId) {
  const rows = db.prepare(`
    SELECT service, isActive, updatedAt FROM service_tokens
    WHERE userId = ?
    ORDER BY service
  `).all(userId);

  return rows.map(r => ({
    service: r.service,
    connected: r.isActive === 1,
    lastUpdated: r.updatedAt
  }));
}

function getDb() { return db; }

// ─── 마켓플레이스 솔루션 설치 CRUD ──────────────────────────────────────
function installSolution(userId, solutionId) {
  const installationId = `inst_${Date.now()}_${userId}`;
  db.prepare(`
    INSERT INTO solution_installations (id, user_id, solution_id, status)
    VALUES (?, ?, ?, 'pending')
  `).run(installationId, userId, solutionId);
  return installationId;
}

function getSolutionInstallation(installationId) {
  return db.prepare(`
    SELECT * FROM solution_installations WHERE id = ?
  `).get(installationId);
}

function getUserSolutionInstallations(userId) {
  return db.prepare(`
    SELECT * FROM solution_installations
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);
}

function updateSolutionInstallationStatus(installationId, status) {
  db.prepare(`
    UPDATE solution_installations
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, installationId);
}

// ─── 기업 분석 결과 CRUD ──────────────────────────────────────────────────
function saveAnalysisResult(analysisId, userId, companyId, findings, recommendations) {
  db.prepare(`
    INSERT INTO analysis_results (id, user_id, company_id, findings_json, recommendations_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(analysisId, userId, companyId, JSON.stringify(findings), JSON.stringify(recommendations));
}

function getAnalysisResult(analysisId, userId) {
  const result = db.prepare(`
    SELECT * FROM analysis_results
    WHERE id = ? AND user_id = ?
  `).get(analysisId, userId);

  if (result) {
    result.findings = JSON.parse(result.findings_json);
    result.recommendations = JSON.parse(result.recommendations_json);
  }
  return result;
}

function getUserAnalysisResults(userId, limit = 10) {
  return db.prepare(`
    SELECT id, company_id, created_at FROM analysis_results
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

// ─── ROI 추적 CRUD ──────────────────────────────────────────────────────
function addRoiTrackingRecord(installationId, date, invested, actualSavings, status) {
  const id = `roi_${Date.now()}`;
  db.prepare(`
    INSERT INTO solution_roi (id, installation_id, date, invested, actual_savings, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, installationId, date, invested, actualSavings, status);
  return id;
}

function getRoiTimeline(installationId) {
  return db.prepare(`
    SELECT * FROM solution_roi
    WHERE installation_id = ?
    ORDER BY date ASC
  `).all(installationId);
}

function calculateRoi(installationId) {
  const records = getRoiTimeline(installationId);
  if (records.length === 0) return null;

  const totalInvested = records.reduce((sum, r) => sum + r.invested, 0);
  const totalSavings = records.reduce((sum, r) => sum + r.actual_savings, 0);
  const roi = totalInvested > 0 ? ((totalSavings - totalInvested) / totalInvested * 100) : 0;
  const breakEvenDate = records.find(r => r.actual_savings >= r.invested)?.date || null;

  return {
    totalInvested,
    totalSavings,
    roi,
    breakEvenDate,
    timeline: records
  };
}

// ─── 다계층 노드 시스템 CRUD ────────────────────────────────────────────────
/**
 * 다계층 노드 캐시 조회 (권한별)
 */
function getMultilevelCache(workspaceId, level, role, userId) {
  const result = db.prepare(`
    SELECT nodes_json FROM multilevel_cache
    WHERE workspace_id = ? AND level = ? AND role = ? AND user_id = ?
    AND datetime(expires_at) > datetime('now')
  `).get(workspaceId, level, role, userId);

  return result ? JSON.parse(result.nodes_json) : null;
}

/**
 * 다계층 노드 캐시 저장 (15분 TTL)
 */
function saveMultilevelCache(workspaceId, level, role, userId, nodesJson) {
  const id = `cache_${workspaceId}_${level}_${role}_${userId}_${Date.now()}`;
  db.prepare(`
    INSERT OR REPLACE INTO multilevel_cache
    (id, workspace_id, level, role, user_id, nodes_json, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+15 minutes'))
  `).run(id, workspaceId, level, role, userId, JSON.stringify(nodesJson));
}

/**
 * 워크스페이스 캐시 무효화
 */
function invalidateMultilevelCache(workspaceId) {
  db.prepare(`
    DELETE FROM multilevel_cache WHERE workspace_id = ?
  `).run(workspaceId);
}

/**
 * 팀/부서 계층 구조 저장
 */
function saveTeamHierarchy(id, workspaceId, parentId, name, levelType, icon, color) {
  db.prepare(`
    INSERT OR REPLACE INTO team_hierarchy
    (id, workspace_id, parent_id, name, level_type, icon, color)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, workspaceId, parentId || null, name, levelType, icon || '👥', color || '#58a6ff');
}

/**
 * 워크스페이스 팀 계층 조회
 */
function getWorkspaceTeamHierarchy(workspaceId) {
  return db.prepare(`
    SELECT * FROM team_hierarchy
    WHERE workspace_id = ?
    ORDER BY created_at ASC
  `).all(workspaceId);
}

/**
 * 부모 ID로 팀/부서 조회
 */
function getTeamsByParentId(parentId) {
  return db.prepare(`
    SELECT * FROM team_hierarchy
    WHERE parent_id = ?
    ORDER BY created_at ASC
  `).all(parentId || null);
}

/**
 * 협업 신호 저장
 */
function saveWorkspaceActivity(workspaceId, userId1, userId2, activityType, strength) {
  const id = `activity_${workspaceId}_${userId1}_${userId2}_${Date.now()}`;
  // user_id_1과 user_id_2를 정렬하여 중복 방지
  const [id1, id2] = [userId1, userId2].sort();

  db.prepare(`
    INSERT OR REPLACE INTO workspace_activity
    (id, workspace_id, user_id_1, user_id_2, activity_type, strength, last_interaction)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(id, workspaceId, id1, id2, activityType, strength);
}

/**
 * 사용자의 협업 관계 조회
 */
function getWorkspaceActivityByUser(workspaceId, userId) {
  return db.prepare(`
    SELECT * FROM workspace_activity
    WHERE workspace_id = ? AND (user_id_1 = ? OR user_id_2 = ?)
    ORDER BY strength DESC, last_interaction DESC
  `).all(workspaceId, userId, userId);
}

/**
 * 워크스페이스의 모든 협업 관계 조회
 */
function getWorkspaceActivityAll(workspaceId) {
  return db.prepare(`
    SELECT * FROM workspace_activity
    WHERE workspace_id = ?
    ORDER BY strength DESC
  `).all(workspaceId);
}

/**
 * 협업 신호 업데이트 (강도 증가)
 */
function updateWorkspaceActivityStrength(workspaceId, userId1, userId2, strengthDelta = 0.1) {
  const [id1, id2] = [userId1, userId2].sort();

  db.prepare(`
    UPDATE workspace_activity
    SET strength = MIN(1.0, strength + ?),
        last_interaction = datetime('now')
    WHERE workspace_id = ? AND user_id_1 = ? AND user_id_2 = ?
  `).run(strengthDelta, workspaceId, id1, id2);
}

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
  // 메시지 서비스 토큰
  saveServiceToken,
  getServiceToken,
  getUserServiceTokens,
  toggleServiceToken,
  deleteServiceToken,
  getUserTokenStatus,
  // 마켓플레이스 솔루션
  installSolution,
  getSolutionInstallation,
  getUserSolutionInstallations,
  updateSolutionInstallationStatus,
  // 기업 분석
  saveAnalysisResult,
  getAnalysisResult,
  getUserAnalysisResults,
  // ROI 추적
  addRoiTrackingRecord,
  getRoiTimeline,
  calculateRoi,
  // 다계층 노드 시스템
  getMultilevelCache,
  saveMultilevelCache,
  invalidateMultilevelCache,
  saveTeamHierarchy,
  getWorkspaceTeamHierarchy,
  getTeamsByParentId,
  saveWorkspaceActivity,
  getWorkspaceActivityByUser,
  getWorkspaceActivityAll,
  updateWorkspaceActivityStrength,
};
