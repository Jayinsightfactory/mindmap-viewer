'use strict';
/**
 * daemon/local-buffer.js
 * 오프라인/전송 실패 시 chunk를 SQLite WAL에 보관 후 자동 재전송.
 */

const path = require('path');
const os   = require('os');
const fs   = require('fs');

const DB_PATH = path.join(os.homedir(), '.orbit', 'chunk-buffer.db');
const MAX_QUEUE = 5000;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let _db = null;
let _flushTimer = null;
let _sendFn = null;

function _openDb() {
  if (_db) return _db;
  try {
    const Database = require('better-sqlite3');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS pending_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_chunks(created_at);
    `);
    return _db;
  } catch (e) {
    console.warn('[local-buffer] SQLite unavailable:', e.message);
    return null;
  }
}

function enqueue(eventType, payload) {
  const db = _openDb();
  if (!db) return false;
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM pending_chunks').get().c;
    if (count >= MAX_QUEUE) {
      db.prepare('DELETE FROM pending_chunks WHERE id IN (SELECT id FROM pending_chunks ORDER BY created_at ASC LIMIT 100)').run();
    }
    db.prepare(
      'INSERT INTO pending_chunks (event_type, payload, created_at) VALUES (?, ?, ?)'
    ).run(eventType, typeof payload === 'string' ? payload : JSON.stringify(payload), Date.now());
    return true;
  } catch (e) {
    console.warn('[local-buffer] enqueue failed:', e.message);
    return false;
  }
}

function _pruneOld() {
  const db = _openDb();
  if (!db) return;
  try {
    db.prepare('DELETE FROM pending_chunks WHERE created_at < ?').run(Date.now() - MAX_AGE_MS);
  } catch {}
}

async function flush(sendFn) {
  const db = _openDb();
  const send = sendFn || _sendFn;
  if (!db || !send) return { sent: 0, failed: 0 };

  _pruneOld();
  const rows = db.prepare(
    'SELECT id, event_type, payload FROM pending_chunks ORDER BY created_at ASC LIMIT 50'
  ).all();

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload);
      const ok = await send(payload, row.event_type);
      if (ok) {
        db.prepare('DELETE FROM pending_chunks WHERE id = ?').run(row.id);
        sent++;
      } else {
        db.prepare('UPDATE pending_chunks SET attempts = attempts + 1 WHERE id = ?').run(row.id);
        failed++;
      }
    } catch {
      db.prepare('UPDATE pending_chunks SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      failed++;
    }
  }
  return { sent, failed, pending: db.prepare('SELECT COUNT(*) AS c FROM pending_chunks').get().c };
}

function start(sendFn, intervalMs = 60 * 1000) {
  _sendFn = sendFn;
  if (_flushTimer) return;
  _openDb();
  _flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, intervalMs);
  setTimeout(() => flush().catch(() => {}), 15 * 1000);
  console.log('[local-buffer] started');
}

function stop() {
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  try { _db?.close(); } catch {}
  _db = null;
}

function getStats() {
  const db = _openDb();
  if (!db) return { pending: 0, available: false };
  try {
    return { pending: db.prepare('SELECT COUNT(*) AS c FROM pending_chunks').get().c, available: true };
  } catch {
    return { pending: 0, available: false };
  }
}

module.exports = { enqueue, flush, start, stop, getStats };
