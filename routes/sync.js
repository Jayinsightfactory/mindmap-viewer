'use strict';

/**
 * routes/sync.js
 * 로컬 → 클라우드 Orbit 서버 동기화
 *
 * POST /api/sync/consent    ← { consented: bool }
 * GET  /api/sync/status     ← { consented, lastSync, pendingCount }
 * POST /api/sync/push       ← 수동 동기화 트리거
 *
 * 자동: 30분마다 consented=true 이면 ORBIT_CLOUD_URL로 push
 */

const { Router } = require('express');
const { ulid }   = require('ulid');
const https      = require('https');
const http       = require('http');

module.exports = function createSyncRouter({ getDb, getAllEvents }) {
  const router = Router();

  // ── POST /api/sync/consent ────────────────────────────────────────────────
  router.post('/sync/consent', (req, res) => {
    try {
      const db        = getDb();
      const consented = !!req.body.consented;

      ensureKv(db);
      db.prepare(`INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)`).run(
        'sync_consented', consented ? '1' : '0'
      );

      if (consented) {
        // 동의 즉시 첫 동기화 시도 (비동기)
        pushToCloud(db, getAllEvents).catch(() => {});
      }

      res.json({ ok: true, consented });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/sync/status ──────────────────────────────────────────────────
  router.get('/sync/status', (req, res) => {
    try {
      const db = getDb();
      ensureKv(db);

      const consentRow = db.prepare(`SELECT value FROM kv_store WHERE key='sync_consented'`).get();
      const consented  = consentRow?.value === '1';

      let lastSync = null, pendingCount = 0;
      try {
        const logRow = db.prepare(`SELECT synced_at, event_count FROM sync_log ORDER BY synced_at DESC LIMIT 1`).get();
        lastSync     = logRow?.synced_at || null;
        // 마지막 동기화 이후 이벤트 수
        pendingCount = lastSync
          ? db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?`).get(lastSync)?.cnt || 0
          : (db.prepare(`SELECT COUNT(*) as cnt FROM events`).get()?.cnt || 0);
      } catch {}

      res.json({
        consented,
        lastSync,
        pendingCount,
        cloudUrl: process.env.ORBIT_CLOUD_URL || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/sync/push ───────────────────────────────────────────────────
  router.post('/sync/push', async (req, res) => {
    try {
      const db = getDb();
      ensureKv(db);

      const consentRow = db.prepare(`SELECT value FROM kv_store WHERE key='sync_consented'`).get();
      if (consentRow?.value !== '1') {
        return res.status(403).json({ error: '동의가 필요합니다. POST /api/sync/consent 먼저 호출하세요.' });
      }

      const result = await pushToCloud(db, getAllEvents);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── 자동 동기화 루프 (30분) ──────────────────────────────────────────────
  setInterval(async () => {
    try {
      const db = getDb();
      ensureKv(db);
      const row = db.prepare(`SELECT value FROM kv_store WHERE key='sync_consented'`).get();
      if (row?.value !== '1') return;
      await pushToCloud(db, getAllEvents);
    } catch {}
  }, 30 * 60 * 1000);

  return router;
};

// ── kv_store 테이블 보장 ──────────────────────────────────────────────────────
function ensureKv(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)
  `).run();
}

// ── 클라우드 Push ─────────────────────────────────────────────────────────────
async function pushToCloud(db, getAllEvents) {
  const cloudUrl = process.env.ORBIT_CLOUD_URL;
  const token    = process.env.ORBIT_TOKEN;

  if (!cloudUrl) {
    return { ok: false, error: 'ORBIT_CLOUD_URL 환경변수가 설정되지 않았습니다.' };
  }

  // 마지막 동기화 이후 이벤트 수집
  let lastSync = null;
  try {
    const row = db.prepare(`SELECT synced_at FROM sync_log ORDER BY synced_at DESC LIMIT 1`).get();
    lastSync = row?.synced_at || null;
  } catch {}

  let events = [];
  try {
    if (typeof getAllEvents === 'function') {
      const all = getAllEvents();
      events = lastSync ? all.filter(e => (e.timestamp || '') > lastSync) : all;
    }
  } catch {}

  // suggestions
  let suggestions = [];
  try {
    suggestions = db.prepare(`SELECT * FROM suggestions ORDER BY created_at DESC LIMIT 500`).all();
  } catch {}

  if (!events.length && !suggestions.length) {
    return { ok: true, message: '전송할 새 데이터 없음', eventCount: 0 };
  }

  const payload = JSON.stringify({
    source:      'orbit-local',
    syncedAt:    new Date().toISOString(),
    events:      events.slice(0, 5000),   // 최대 5000개
    suggestions,
  });

  try {
    await httpPost(cloudUrl + '/api/sync/ingest', payload, token);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // 동기화 로그 기록
  try {
    ensureKv(db);
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id TEXT PRIMARY KEY, synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        event_count INTEGER, status TEXT
      )
    `).run();
    db.prepare(
      `INSERT INTO sync_log (id, event_count, status) VALUES (?,?,?)`
    ).run(ulid(), events.length, 'ok');
  } catch {}

  console.log(`[sync] 클라우드 전송 완료: 이벤트 ${events.length}개, 제안 ${suggestions.length}개`);
  return { ok: true, eventCount: events.length, suggestionCount: suggestions.length };
}

// ── HTTP POST 헬퍼 ────────────────────────────────────────────────────────────
function httpPost(url, body, token) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const mod    = parsed.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const req = mod.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + (parsed.search || ''),
        method:   'POST',
        headers,
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          else resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}
