'use strict';

/**
 * routes/sync.js
 * 로컬 → 클라우드 Orbit 서버 동기화 (2단계 동의)
 *
 * sync_level 1 (서비스 가입 기본)
 *   → suggestions(구조화된 제안)만 전송
 *   → "어떤 패턴인지" 요약 데이터만 — 원문 없음
 *
 * sync_level 2 (피드백 동의 옵션)
 *   → suggestions + raw 이벤트(타이핑·파일·앱) 전송
 *   → 개인화 제안 품질 향상, 파인튜닝 데이터
 *
 * POST /api/sync/consent   ← { level: 0|1|2 }
 * GET  /api/sync/status    ← { level, lastSync, pendingCount }
 * POST /api/sync/push      ← 수동 동기화 트리거
 *
 * 자동: 30분마다 level >= 1 이면 ORBIT_CLOUD_URL로 push
 */

const { Router } = require('express');
const { ulid }   = require('ulid');
const https      = require('https');
const http       = require('http');

// raw 이벤트에서 제외할 타입 (level 1에서는 안 보냄)
const RAW_TYPES = new Set([
  'keyboard.chunk', 'file.content', 'app.activity',
  'user.message',   'assistant.message', 'assistant.response',
]);

module.exports = function createSyncRouter({ getDb, getAllEvents }) {
  const router = Router();

  // ── POST /api/sync/consent ────────────────────────────────────────────────
  // body: { level: 0 | 1 | 2 }
  //   0 = 동의 철회 (로컬 전용)
  //   1 = 제안 데이터만 (서비스 기본)
  //   2 = 원본 이벤트까지 (피드백 동의)
  router.post('/sync/consent', (req, res) => {
    try {
      const db    = getDb();
      const level = parseInt(req.body.level ?? (req.body.consented ? 1 : 0), 10);

      if (![0, 1, 2].includes(level)) {
        return res.status(400).json({ error: 'level 은 0, 1, 2 중 하나여야 합니다.' });
      }

      ensureKv(db);
      db.prepare(`INSERT OR REPLACE INTO kv_store (key,value) VALUES (?,?)`).run(
        'sync_level', String(level)
      );

      // 동의 즉시 첫 동기화 시도
      if (level >= 1) {
        pushToCloud(db, getAllEvents, level).catch(() => {});
      }

      res.json({ ok: true, level });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/sync/status ──────────────────────────────────────────────────
  router.get('/sync/status', (req, res) => {
    try {
      const db = getDb();
      ensureKv(db);

      const levelRow = db.prepare(`SELECT value FROM kv_store WHERE key='sync_level'`).get();
      const level    = parseInt(levelRow?.value || '0', 10);

      let lastSync = null, pendingCount = 0;
      try {
        const logRow = db.prepare(
          `SELECT synced_at, event_count FROM sync_log ORDER BY synced_at DESC LIMIT 1`
        ).get();
        lastSync     = logRow?.synced_at || null;
        pendingCount = lastSync
          ? db.prepare(`SELECT COUNT(*) as cnt FROM events WHERE timestamp > ?`).get(lastSync)?.cnt || 0
          : db.prepare(`SELECT COUNT(*) as cnt FROM events`).get()?.cnt || 0;
      } catch {}

      res.json({
        level,
        // 하위 호환
        consented:  level >= 1,
        lastSync,
        pendingCount,
        cloudUrl:   process.env.ORBIT_CLOUD_URL || null,
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

      const levelRow = db.prepare(`SELECT value FROM kv_store WHERE key='sync_level'`).get();
      const level    = parseInt(levelRow?.value || '0', 10);

      if (level < 1) {
        return res.status(403).json({
          error: '동의가 필요합니다. POST /api/sync/consent { level: 1 } 먼저 호출하세요.'
        });
      }

      const result = await pushToCloud(db, getAllEvents, level);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/sync/free-solutions ──────────────────────────────────────────
  // 클라우드 서버에서 검증 완료된 무료 솔루션을 가져와 로컬 캐시에 저장
  router.get('/sync/free-solutions', async (req, res) => {
    const db = getDb();
    ensureKv(db);

    // 1) 로컬 캐시 우선 반환
    let cached = [];
    try {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS free_solutions (
          id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT,
          template TEXT, accuracy REAL, usageCount INTEGER DEFAULT 0,
          fetchedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      cached = db.prepare(`SELECT * FROM free_solutions ORDER BY accuracy DESC, usageCount DESC LIMIT 50`).all();
    } catch {}

    // 2) 클라우드에서 최신 목록 pull (백그라운드)
    const cloudUrl = process.env.ORBIT_CLOUD_URL;
    if (cloudUrl) {
      pullFreeSolutions(db, cloudUrl).catch(() => {});
    }

    res.json({ solutions: cached, fromCache: true });
  });

  // ── POST /api/sync/free-solutions/use ─────────────────────────────────────
  // 무료 솔루션 사용 카운트 증가 + 클라우드에 사용 통계 보고
  router.post('/sync/free-solutions/use', (req, res) => {
    try {
      const db = getDb();
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      try {
        db.prepare(`UPDATE free_solutions SET usageCount = usageCount + 1 WHERE id = ?`).run(id);
      } catch {}
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 자동 동기화 루프 (30분) ───────────────────────────────────────────────
  setInterval(async () => {
    try {
      const db       = getDb();
      ensureKv(db);
      const levelRow = db.prepare(`SELECT value FROM kv_store WHERE key='sync_level'`).get();
      const level    = parseInt(levelRow?.value || '0', 10);
      if (level < 1) return;
      await pushToCloud(db, getAllEvents, level);
    } catch {}
  }, 30 * 60 * 1000);

  return router;
};

// ── kv_store 보장 ─────────────────────────────────────────────────────────────
function ensureKv(db) {
  db.prepare(`CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)`).run();
}

// ── 클라우드 Push ─────────────────────────────────────────────────────────────
async function pushToCloud(db, getAllEvents, level = 1) {
  const cloudUrl = process.env.ORBIT_CLOUD_URL;
  const token    = process.env.ORBIT_TOKEN;

  if (!cloudUrl) {
    return { ok: false, error: 'ORBIT_CLOUD_URL 환경변수가 설정되지 않았습니다.' };
  }

  // ── suggestions (level 1+) ──────────────────────────────────────────────
  let suggestions = [];
  try {
    suggestions = db.prepare(
      `SELECT * FROM suggestions ORDER BY created_at DESC LIMIT 1000`
    ).all();
  } catch {}

  // ── raw 이벤트 (level 2만) ─────────────────────────────────────────────
  let events = [];
  if (level >= 2) {
    try {
      let lastSync = null;
      try {
        const row = db.prepare(
          `SELECT synced_at FROM sync_log ORDER BY synced_at DESC LIMIT 1`
        ).get();
        lastSync = row?.synced_at || null;
      } catch {}

      if (typeof getAllEvents === 'function') {
        const all = getAllEvents();
        events = lastSync ? all.filter(e => (e.timestamp || '') > lastSync) : all;
        events = events.slice(0, 5000); // 최대 5000개
      }
    } catch {}
  }

  if (!suggestions.length && !events.length) {
    return { ok: true, message: '전송할 새 데이터 없음', eventCount: 0, suggestionCount: 0 };
  }

  const payload = JSON.stringify({
    source:      'orbit-local',
    syncLevel:   level,
    syncedAt:    new Date().toISOString(),
    suggestions,
    // level 1이면 events 배열은 빈 배열 — 원문 없음
    events:      level >= 2 ? events : [],
  });

  try {
    await httpPost(cloudUrl + '/api/sync/ingest', payload, token);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // 동기화 로그 기록
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id TEXT PRIMARY KEY, synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        event_count INTEGER, status TEXT
      )
    `).run();
    db.prepare(`INSERT INTO sync_log (id, event_count, status) VALUES (?,?,?)`)
      .run(ulid(), events.length, 'ok');
  } catch {}

  const msg = level >= 2
    ? `제안 ${suggestions.length}개 + 원본 이벤트 ${events.length}개`
    : `제안 ${suggestions.length}개 (원본 이벤트 제외)`;
  console.log(`[sync] 클라우드 전송 완료 (level ${level}): ${msg}`);

  return { ok: true, level, suggestionCount: suggestions.length, eventCount: events.length };
}

// ── HTTP POST 헬퍼 ────────────────────────────────────────────────────────────
function httpPost(url, body, token) {
  return new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(url);
      const mod     = parsed.protocol === 'https:' ? https : http;
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

// ── 클라우드 → 무료 솔루션 Pull ──────────────────────────────────────────────
// 오퍼레이터가 여러 사용자의 프롬프트 학습 데이터를 검증해 퍼블리시한
// 무료 솔루션 목록을 가져와 로컬 DB에 캐시
async function pullFreeSolutions(db, cloudUrl) {
  const token = process.env.ORBIT_TOKEN;
  try {
    const data = await httpGet(cloudUrl + '/api/solutions/public?type=prompt_template&limit=50', token);
    const list = JSON.parse(data).solutions || [];

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO free_solutions
        (id, type, title, description, template, accuracy, usageCount, fetchedAt)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    `);
    for (const s of list) {
      upsert.run(s.id, s.type || 'prompt_template', s.title, s.description,
                 s.template, s.accuracy || 0, s.usageCount || 0);
    }
    console.log(`[sync] 무료 솔루션 ${list.length}개 갱신`);
  } catch (err) {
    // 클라우드 미연결 시 무시
  }
}

// ── HTTP GET 헬퍼 ────────────────────────────────────────────────────────────
function httpGet(url, token) {
  return new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(url);
      const mod     = parsed.protocol === 'https:' ? https : http;
      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const req = mod.request({
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + (parsed.search || ''),
        method:   'GET',
        headers,
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve(data);
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}
