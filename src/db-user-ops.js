/* db-user-ops.js — User-scoped DB operations (shared SQLite/PG) */

/**
 * Shared implementation of user-scoped DB operations.
 *
 * Both db.js (SQLite) and db-pg.js (PostgreSQL) delegate to these functions
 * instead of maintaining their own copies. This prevents sync drift.
 *
 * Two factory functions are provided:
 *   - createSqliteOps(getDb, deserializeEvent)  → synchronous functions (for db.js)
 *   - createPgOps(pool, deserializeEvent)        → async functions (for db-pg.js)
 *
 * The SQL queries are defined once and shared. Adapter-specific execution
 * preserves the existing sync/async contract so callers don't break.
 */

// ─── SQLite adapter (synchronous, for db.js) ─────────────────────────────────

function createSqliteOps(getDb, deserializeEvent) {

  function getEventsByUser(userId) {
    return getDb().prepare(
      'SELECT * FROM events WHERE user_id = ? ORDER BY timestamp ASC'
    ).all(userId).map(deserializeEvent);
  }

  function getSessionsByUser(userId) {
    return getDb().prepare(
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY started_at DESC'
    ).all(userId);
  }

  function getStatsByUser(userId) {
    const db = getDb();
    const eventCount   = db.prepare('SELECT COUNT(*) as c FROM events WHERE user_id = ?').get(userId).c;
    const sessionCount = db.prepare('SELECT COUNT(*) as c FROM sessions WHERE user_id = ?').get(userId).c;
    const fileCount    = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
    const toolCount    = db.prepare("SELECT COUNT(*) as c FROM events WHERE user_id = ? AND type LIKE 'tool.%'").get(userId).c;
    return { eventCount, sessionCount, fileCount, toolCount, aiSourceStats: {} };
  }

  function claimLocalEvents(userId) {
    try {
      const db = getDb();
      const result = db.prepare(
        "UPDATE events SET user_id = ? WHERE user_id = 'local' OR user_id = 'anonymous'"
      ).run(userId);
      db.prepare(
        "UPDATE sessions SET user_id = ? WHERE user_id = 'local' OR user_id = 'anonymous'"
      ).run(userId);
      return result.changes;
    } catch (e) {
      console.warn('[DB] claimLocalEvents error:', e.message);
      return 0;
    }
  }

  function getNodeMemos(userId = 'local') {
    return getDb().prepare(
      'SELECT * FROM node_memos WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(userId);
  }

  function upsertNodeMemo(id, eventId, userId, content) {
    getDb().prepare(`
      INSERT OR REPLACE INTO node_memos (id, event_id, user_id, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM node_memos WHERE id = ?), datetime('now')), datetime('now'))
    `).run(id, eventId, userId || 'local', content, id);
  }

  function deleteNodeMemo(id) {
    getDb().prepare('DELETE FROM node_memos WHERE id = ?').run(id);
  }

  function getBookmarks(userId = 'local') {
    return getDb().prepare(
      'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
  }

  function addBookmark(id, eventId, userId, label) {
    getDb().prepare(
      'INSERT OR IGNORE INTO bookmarks (id, event_id, user_id, label) VALUES (?, ?, ?, ?)'
    ).run(id, eventId, userId || 'local', label || null);
  }

  function removeBookmark(id) {
    getDb().prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }

  function saveServiceToken(userId, service, { accessToken, refreshToken, expiresAt }) {
    getDb().prepare(`
      INSERT INTO service_tokens (userId, service, accessToken, refreshToken, expiresAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(userId, service) DO UPDATE SET
        accessToken = excluded.accessToken,
        refreshToken = excluded.refreshToken,
        expiresAt = excluded.expiresAt,
        isActive = 1,
        updatedAt = datetime('now')
    `).run(userId, service, accessToken, refreshToken, expiresAt);
  }

  function getServiceToken(userId, service) {
    return getDb().prepare(`
      SELECT accessToken, refreshToken, expiresAt, isActive
      FROM service_tokens
      WHERE userId = ? AND service = ? AND isActive = 1
    `).get(userId, service);
  }

  return {
    getEventsByUser,
    getSessionsByUser,
    getStatsByUser,
    claimLocalEvents,
    getNodeMemos,
    upsertNodeMemo,
    deleteNodeMemo,
    getBookmarks,
    addBookmark,
    removeBookmark,
    saveServiceToken,
    getServiceToken,
  };
}

// ─── PostgreSQL adapter (async, for db-pg.js) ────────────────────────────────

function createPgOps(getPool, deserializeEvent) {

  async function getEventsByUser(userId, limit = 3000) {
    // LIMIT 필수 — 무제한 스캔 시 OOM 크래시 (Bad Gateway 근본 원인)
    // 최근 N건만 역순으로 가져온 뒤 시간순 정렬
    const { rows } = await getPool().query(
      `SELECT * FROM events
       WHERE user_id = $1 OR data_json->>'userId' = $1
       ORDER BY timestamp DESC LIMIT $2`, [userId, Math.min(limit, 5000)]
    );
    return rows.map(deserializeEvent).reverse();
  }

  async function getSessionsByUser(userId) {
    const { rows } = await getPool().query(
      'SELECT * FROM sessions WHERE user_id=$1 ORDER BY started_at DESC', [userId]
    );
    return rows;
  }

  async function getStatsByUser(userId) {
    const pool = getPool();
    const [e, s, f, t] = await Promise.all([
      pool.query('SELECT COUNT(*) AS c FROM events WHERE user_id=$1', [userId]),
      pool.query('SELECT COUNT(*) AS c FROM sessions WHERE user_id=$1', [userId]),
      pool.query('SELECT COUNT(*) AS c FROM files'),
      pool.query("SELECT COUNT(*) AS c FROM events WHERE user_id=$1 AND type LIKE 'tool.%'", [userId]),
    ]);
    return {
      eventCount:   parseInt(e.rows[0].c),
      sessionCount: parseInt(s.rows[0].c),
      fileCount:    parseInt(f.rows[0].c),
      toolCount:    parseInt(t.rows[0].c),
      aiSourceStats: {},
    };
  }

  async function claimLocalEvents(userId) {
    try {
      const pool = getPool();
      const result = await pool.query(
        "UPDATE events SET user_id=$1 WHERE user_id='local' OR user_id='anonymous'", [userId]
      );
      await pool.query(
        "UPDATE sessions SET user_id=$1 WHERE user_id='local' OR user_id='anonymous'", [userId]
      );
      return result.rowCount;
    } catch (e) {
      console.warn('[DB-PG] claimLocalEvents error:', e.message);
      return 0;
    }
  }

  async function getNodeMemos(userId = 'local') {
    const { rows } = await getPool().query(
      'SELECT * FROM node_memos WHERE user_id=$1 ORDER BY updated_at DESC', [userId]
    );
    return rows;
  }

  async function upsertNodeMemo(id, eventId, userId, content) {
    await getPool().query(`
      INSERT INTO node_memos (id, event_id, user_id, content, created_at, updated_at)
      VALUES ($1,$2,$3,$4,NOW(),NOW())
      ON CONFLICT (id) DO UPDATE SET content=$4, updated_at=NOW()
    `, [id, eventId, userId || 'local', content]);
  }

  async function deleteNodeMemo(id) {
    await getPool().query('DELETE FROM node_memos WHERE id=$1', [id]);
  }

  async function getBookmarks(userId = 'local') {
    const { rows } = await getPool().query(
      'SELECT * FROM bookmarks WHERE user_id=$1 ORDER BY created_at DESC', [userId]
    );
    return rows;
  }

  async function addBookmark(id, eventId, userId, label) {
    await getPool().query(
      'INSERT INTO bookmarks (id, event_id, user_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [id, eventId, userId || 'local', label || null]
    );
  }

  async function removeBookmark(id) {
    await getPool().query('DELETE FROM bookmarks WHERE id=$1', [id]);
  }

  async function saveServiceToken(userId, service, { accessToken, refreshToken, expiresAt }) {
    await getPool().query(`
      INSERT INTO service_tokens (userId, service, accessToken, refreshToken, expiresAt, updatedAt)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (userId, service) DO UPDATE SET
        accessToken=EXCLUDED.accessToken,
        refreshToken=EXCLUDED.refreshToken,
        expiresAt=EXCLUDED.expiresAt,
        isActive=1,
        updatedAt=NOW()
    `, [userId, service, accessToken, refreshToken, expiresAt]);
  }

  async function getServiceToken(userId, service) {
    const { rows } = await getPool().query(`
      SELECT accessToken AS "accessToken", refreshToken AS "refreshToken",
             expiresAt AS "expiresAt", isActive AS "isActive"
      FROM service_tokens
      WHERE userId=$1 AND service=$2 AND isActive=1
    `, [userId, service]);
    return rows[0] || null;
  }

  return {
    getEventsByUser,
    getSessionsByUser,
    getStatsByUser,
    claimLocalEvents,
    getNodeMemos,
    upsertNodeMemo,
    deleteNodeMemo,
    getBookmarks,
    addBookmark,
    removeBookmark,
    saveServiceToken,
    getServiceToken,
  };
}

// ─── Exported function names (for db-interface.js validation) ────────────────
const SHARED_FUNCTION_NAMES = [
  'getEventsByUser',
  'getSessionsByUser',
  'getStatsByUser',
  'claimLocalEvents',
  'getNodeMemos',
  'upsertNodeMemo',
  'deleteNodeMemo',
  'getBookmarks',
  'addBookmark',
  'removeBookmark',
  'saveServiceToken',
  'getServiceToken',
];

module.exports = { createSqliteOps, createPgOps, SHARED_FUNCTION_NAMES };
