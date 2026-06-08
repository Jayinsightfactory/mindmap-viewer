'use strict';
/**
 * routes/auto-doctor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 자가진화 데몬 닥터 — 2026-06-05 추가
 *
 * 책임:
 *   1. 모든 PC의 데몬 상태(daemon.update + daemon.log.snapshot) 수집
 *   2. Claude API로 각 PC 진단 (어떤 모듈 죽음, 어떤 에러, 재설치/재시작 필요?)
 *   3. 안전 자동 조치만 실행 (reinstall/restart push-exec) — PC당 24h 1회 가드
 *   4. 코드 수정 권고는 PG에 저장 (사용자가 대시보드에서 검토 후 적용)
 *   5. 24h 스케줄러 + 수동 트리거 엔드포인트
 *
 * 안전성:
 *   - 자동 reinstall은 PC당 24h 1회만 (무한 reinstall 루프 방지)
 *   - 모든 진단/조치 audit log (orbit_auto_doctor_runs 테이블)
 *   - ANTHROPIC_API_KEY 없으면 자동 비활성
 *   - 코드 변경은 자동 push 안 함 — 권고만 (사용자 승인 트리거)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try { _client = new Anthropic({ apiKey: key }); } catch { return null; }
  return _client;
}

const MASTER_TOKEN = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const REINSTALL_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // 24h
const MAX_PCS_PER_RUN       = 20;                    // Claude API 호출 cost 가드
const LOG_BYTES_MAX         = 3000;                  // Claude 입력 sample 한도

// ─── PG 테이블 보장 ─────────────────────────────────────────────────────────
async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orbit_auto_doctor_runs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      hostname TEXT NOT NULL,
      status TEXT,
      diagnosis JSONB,
      actions JSONB
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auto_doctor_hostname_ts
    ON orbit_auto_doctor_runs (hostname, ts DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orbit_auto_doctor_proposals (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      hostname TEXT,
      file_path TEXT,
      reason TEXT,
      suggestion TEXT,
      applied BOOLEAN DEFAULT false,
      applied_at TIMESTAMPTZ
    )
  `);
}

// ─── 24h 가드: PC당 reinstall 1회 ────────────────────────────────────────────
async function canAutoReinstall(pool, hostname) {
  try {
    const { rows } = await pool.query(`
      SELECT MAX(ts) AS last_ts FROM orbit_auto_doctor_runs
      WHERE hostname = $1 AND actions::text LIKE '%"reinstall"%'
    `, [hostname]);
    const last = rows[0]?.last_ts;
    if (!last) return true;
    return (Date.now() - new Date(last).getTime()) > REINSTALL_COOLDOWN_MS;
  } catch { return false; }
}

// ─── PC 환경 수집 ────────────────────────────────────────────────────────────
async function collectPcEnvironments(pool) {
  // 1) 최근 7일 안에 데이터 보낸 모든 PC
  const { rows: hostnames } = await pool.query(`
    SELECT DISTINCT data_json->>'hostname' AS hostname,
           MAX(timestamp::timestamptz) AS last_seen
    FROM events
    WHERE type = 'daemon.update'
      AND data_json->>'hostname' IS NOT NULL
      AND timestamp::timestamptz > NOW() - INTERVAL '7 days'
    GROUP BY data_json->>'hostname'
    ORDER BY MAX(timestamp::timestamptz) DESC
    LIMIT $1
  `, [MAX_PCS_PER_RUN]);

  // 2) 각 PC별 최신 self-log + 최근 에러 수집
  const enriched = [];
  for (const pc of hostnames) {
    const hostname = pc.hostname;
    const lastSeenMs = Date.now() - new Date(pc.last_seen).getTime();

    // 최신 self-log (가장 최근 1건)
    const { rows: logRows } = await pool.query(`
      SELECT data_json
      FROM events
      WHERE type = 'daemon.log.snapshot' AND data_json->>'hostname' = $1
      ORDER BY timestamp::timestamptz DESC LIMIT 1
    `, [hostname]);
    const recentLog = logRows[0]?.data_json?.lines || '';

    // 최근 24h 데몬 에러 (최대 5건)
    const { rows: errRows } = await pool.query(`
      SELECT data_json->>'error' AS error, data_json->>'component' AS component
      FROM events
      WHERE type = 'daemon.error' AND data_json->>'hostname' = $1
        AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
      ORDER BY timestamp::timestamptz DESC LIMIT 5
    `, [hostname]);

    // 상태 분류
    const ageHours = lastSeenMs / (3600 * 1000);
    const status = ageHours < 0.5 ? 'alive'
                 : ageHours < 24  ? 'stale'
                 : 'dead';

    enriched.push({
      hostname,
      lastSeenMs,
      status,
      recentLog: String(recentLog).slice(-LOG_BYTES_MAX),
      recentErrors: errRows,
    });
  }
  return enriched;
}

// ─── Claude API로 PC 진단 ────────────────────────────────────────────────────
async function diagnoseWithClaude(pc) {
  const client = getClient();
  if (!client) return { ok: false, reason: 'no_api_key', needsReinstall: false, needsRestart: false };

  const prompt = `직원 PC의 Orbit 데몬 환경을 진단하라.

호스트: ${pc.hostname}
상태: ${pc.status} (마지막 데이터 ${Math.round(pc.lastSeenMs / 60000)}분 전)

최근 self-log (마지막 ${LOG_BYTES_MAX}바이트):
${pc.recentLog || '(없음)'}

최근 24시간 데몬 에러:
${pc.recentErrors.map(e => `- [${e.component}] ${e.error}`).join('\n') || '(없음)'}

다음 JSON으로만 응답하라 (마크다운 X, 순수 JSON):
{
  "diagnosis": "현재 상태 한 줄 진단",
  "severity": "ok|warning|critical",
  "needsReinstall": true|false,
  "needsRestart": true|false,
  "reinstallReason": "왜 reinstall 필요 (없으면 null)",
  "restartReason": "왜 restart 필요 (없으면 null)",
  "codeChange": {
    "file": "수정 필요한 파일 경로 (없으면 null)",
    "reason": "코드 수정 이유 (없으면 null)",
    "suggestion": "구체적 수정 제안 (없으면 null)"
  },
  "userNote": "관리자에게 알릴 한 줄 (필요 시)"
}

판단 기준:
- 'dead' 상태 + 무한루프 흔적 → needsReinstall: true
- 모듈 누락 에러 (Cannot find module 등) → needsReinstall: true
- 일시적 crash + 정상 시작 흔적 있음 → needsRestart: true
- 'alive' 상태 → 보통 ok (조치 불필요)
- 같은 에러가 반복되면 codeChange 권고`;

  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, reason: 'parse_fail', needsReinstall: false, needsRestart: false };
    const parsed = JSON.parse(m[0]);
    return { ok: true, ...parsed };
  } catch (e) {
    return { ok: false, reason: e.message.slice(0, 200), needsReinstall: false, needsRestart: false };
  }
}

// ─── 안전 자동 조치 (reinstall/restart push-exec) ───────────────────────────
async function applySafeActions(pool, pc, diag) {
  const actions = [];
  const ts = new Date().toISOString();

  // 1) reinstall (24h 가드)
  if (diag.needsReinstall) {
    const can = await canAutoReinstall(pool, pc.hostname);
    if (can) {
      try {
        await pool.query(
          `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
           VALUES ($1, 'reinstall', NULL, '{}', $2)`,
          [pc.hostname, ts]
        );
        actions.push({ action: 'reinstall', reason: diag.reinstallReason || 'auto-doctor', ts });
      } catch (e) {
        actions.push({ action: 'reinstall', error: e.message });
      }
    } else {
      actions.push({ action: 'reinstall_skipped', reason: 'cooldown_24h' });
    }
  }

  // 2) restart (가드 없음 — 안전한 조치)
  if (diag.needsRestart) {
    try {
      await pool.query(
        `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
         VALUES ($1, 'restart', NULL, '{}', $2)`,
        [pc.hostname, ts]
      );
      actions.push({ action: 'restart', reason: diag.restartReason || 'auto-doctor', ts });
    } catch (e) {
      actions.push({ action: 'restart', error: e.message });
    }
  }

  return actions;
}

// ─── 코드 수정 권고 저장 (자동 적용 X) ──────────────────────────────────────
async function saveCodeProposal(pool, pc, diag) {
  const cc = diag.codeChange;
  if (!cc || !cc.file || !cc.suggestion) return null;
  try {
    const { rows } = await pool.query(`
      INSERT INTO orbit_auto_doctor_proposals (hostname, file_path, reason, suggestion)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [pc.hostname, cc.file, cc.reason || '', cc.suggestion]);
    return rows[0]?.id;
  } catch { return null; }
}

// ─── audit log 저장 ─────────────────────────────────────────────────────────
async function saveRun(pool, pc, diag, actions) {
  try {
    await pool.query(`
      INSERT INTO orbit_auto_doctor_runs (hostname, status, diagnosis, actions)
      VALUES ($1, $2, $3, $4)
    `, [pc.hostname, pc.status, JSON.stringify(diag), JSON.stringify(actions)]);
  } catch {}
}

// ─── 메인 진단 사이클 ────────────────────────────────────────────────────────
async function runDoctor(pool) {
  if (!pool) return { ok: false, reason: 'no_db' };
  if (!getClient()) return { ok: false, reason: 'no_anthropic_key' };
  await ensureTables(pool);

  const pcs = await collectPcEnvironments(pool);
  const summary = { pcs: pcs.length, alive: 0, stale: 0, dead: 0, actions: 0, proposals: 0, details: [] };

  for (const pc of pcs) {
    summary[pc.status]++;
    const diag = await diagnoseWithClaude(pc);
    if (!diag.ok && diag.reason) {
      summary.details.push({ hostname: pc.hostname, status: pc.status, error: diag.reason });
      continue;
    }
    const actions = await applySafeActions(pool, pc, diag);
    const proposalId = await saveCodeProposal(pool, pc, diag);
    await saveRun(pool, pc, diag, actions);

    summary.actions += actions.filter(a => !a.error && !a.action?.includes('skipped')).length;
    if (proposalId) summary.proposals++;
    summary.details.push({
      hostname: pc.hostname,
      status: pc.status,
      diagnosis: diag.diagnosis,
      severity: diag.severity,
      actions,
      proposalId,
    });
  }

  console.log(`[auto-doctor] run complete: ${summary.pcs} PCs (${summary.alive} alive, ${summary.dead} dead) → ${summary.actions} actions, ${summary.proposals} proposals`);
  return { ok: true, summary };
}

// ─── Router 생성 ────────────────────────────────────────────────────────────
module.exports = function(dbModule) {
  const router = express.Router();
  let _scheduled = false;
  let _lastRun = null;
  let _running  = false;

  function checkAuth(req) {
    const tok = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (tok === MASTER_TOKEN) return true;
    try {
      const env = require('../config/environment');
      if (env.isAdminToken && env.isAdminToken(tok)) return true;
    } catch {}
    return false;
  }

  async function runSafe() {
    if (_running) return { ok: false, reason: 'already_running' };
    _running = true;
    try {
      const pool = dbModule.getDb ? dbModule.getDb() : null;
      const result = await runDoctor(pool);
      _lastRun = { ts: new Date().toISOString(), ...result };
      return result;
    } catch (e) {
      const err = { ok: false, error: e.message };
      _lastRun = { ts: new Date().toISOString(), ...err };
      return err;
    } finally {
      _running = false;
    }
  }

  // 24h 스케줄러
  function startScheduler() {
    if (_scheduled) return;
    _scheduled = true;
    setTimeout(() => {
      runSafe().catch(e => console.warn('[auto-doctor] first run err:', e.message));
      setInterval(() => {
        runSafe().catch(e => console.warn('[auto-doctor] scheduled err:', e.message));
      }, 24 * 3600 * 1000);
    }, 60 * 60 * 1000);
    console.log('[auto-doctor] scheduler started — first run in 1h, then every 24h');
  }

  // POST /api/auto-doctor/run — 수동 트리거
  router.post('/run', async (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    const result = await runSafe();
    res.json(result);
  });

  // GET /api/auto-doctor/last — 최신 결과 (인메모리)
  router.get('/last', (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    res.json({ ok: true, lastRun: _lastRun, scheduled: _scheduled, running: _running });
  });

  // GET /api/auto-doctor/history?limit=N — 과거 run 이력
  router.get('/history', async (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!pool) return res.status(500).json({ error: 'no_db' });
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const { rows } = await pool.query(`
        SELECT hostname, ts, status, diagnosis, actions
        FROM orbit_auto_doctor_runs ORDER BY ts DESC LIMIT $1
      `, [limit]);
      res.json({ ok: true, runs: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/auto-doctor/proposals — 미적용 코드 수정 권고
  router.get('/proposals', async (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!pool) return res.status(500).json({ error: 'no_db' });
    try {
      const { rows } = await pool.query(`
        SELECT id, hostname, file_path, reason, suggestion, ts
        FROM orbit_auto_doctor_proposals
        WHERE applied = false ORDER BY ts DESC LIMIT 100
      `);
      res.json({ ok: true, proposals: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/auto-doctor/dismiss-proposal { id } — 권고 무시
  router.post('/dismiss-proposal', async (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id required' });
    const pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!pool) return res.status(500).json({ error: 'no_db' });
    try {
      await pool.query(`
        UPDATE orbit_auto_doctor_proposals
        SET applied = true, applied_at = NOW()
        WHERE id = $1
      `, [id]);
      res.json({ ok: true, id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.startScheduler = startScheduler;
  return router;
};
