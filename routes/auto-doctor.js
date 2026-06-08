'use strict';
/**
 * routes/auto-doctor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 데몬 죽음/데이터 단절 자동 처리 — 2026-06-05
 *
 * 동작:
 *   1. 30분마다 모든 PC의 last_seen 검사
 *   2. last_seen > 30분 = 데이터 안 들어옴 → Claude API에 self-log 던져서 진단
 *   3. needsReinstall → push-exec reinstall 큐잉 (PC당 24h 1회 가드)
 *      needsRestart   → push-exec restart 큐잉
 *   4. 처리 audit log (orbit_auto_doctor_runs)
 *
 * 안전 가드:
 *   - PC당 reinstall은 24h에 1회 (무한 reinstall 방지)
 *   - ANTHROPIC_API_KEY 없으면 자동 비활성
 *   - 살아있는 PC는 진단조차 안 함 (API 비용 절약)
 *   - 코드 수정/git push 자동화 없음 — 안전 조치(reinstall/restart)만
 *
 * 엔드포인트 (디버깅/수동 트리거용):
 *   - POST /api/auto-doctor/run    — 즉시 1회 실행
 *   - GET  /api/auto-doctor/last   — 최신 결과
 *   - GET  /api/auto-doctor/history — 처리 이력
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try { _client = new Anthropic({ apiKey: key }); } catch { return null; }
  return _client;
}

const MASTER_TOKEN          = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const POLL_INTERVAL_MS      = 10 * 60 * 1000;   // 10분 모니터링 (빠른 감지)
const DEAD_THRESHOLD_MS     = 15 * 60 * 1000;   // 15분 = 비정상 (PC 작업 중에도 잡음)
const REINSTALL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // PC당 24h 1회 (무한 reinstall 방지)
const MAX_PCS_PER_RUN       = 10;                // API 비용 가드
const LOG_BYTES_MAX         = 3000;

// ─── PG 테이블 보장 ─────────────────────────────────────────────────────────
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orbit_auto_doctor_runs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      hostname TEXT NOT NULL,
      age_minutes INT,
      diagnosis TEXT,
      action TEXT,
      reason TEXT
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_auto_doctor_hostname_ts
    ON orbit_auto_doctor_runs (hostname, ts DESC)
  `);
}

// ─── 24h 가드: PC당 reinstall 1회 ────────────────────────────────────────────
async function canAutoReinstall(pool, hostname) {
  try {
    const { rows } = await pool.query(`
      SELECT MAX(ts) AS last_ts FROM orbit_auto_doctor_runs
      WHERE hostname = $1 AND action = 'reinstall'
    `, [hostname]);
    const last = rows[0]?.last_ts;
    if (!last) return true;
    return (Date.now() - new Date(last).getTime()) > REINSTALL_COOLDOWN_MS;
  } catch { return false; }
}

// ─── 데이터 안 들어오는 PC 수집 ──────────────────────────────────────────────
// 핵심: 진짜 수집 이벤트 (mouse/keyboard/screen 등) 기준으로 last_seen 계산.
// daemon.update/daemon.error/daemon.log.snapshot은 watcher 죽었어도 reportStatus만
// 보내질 수 있으므로 제외 — "PC 켜져있는데 실제 데이터 안 들어옴" 케이스 잡기 위함.
async function collectDeadPcs(pool) {
  const { rows } = await pool.query(`
    SELECT DISTINCT data_json->>'hostname' AS hostname,
           MAX(timestamp::timestamptz)      AS last_seen
    FROM events
    WHERE data_json->>'hostname' IS NOT NULL
      AND type NOT IN ('daemon.update', 'daemon.error', 'daemon.log.snapshot',
                       'install.progress', 'daemon.crash')
      AND timestamp::timestamptz > NOW() - INTERVAL '14 days'
    GROUP BY data_json->>'hostname'
    HAVING MAX(timestamp::timestamptz) < NOW() - INTERVAL '15 minutes'
    ORDER BY MAX(timestamp::timestamptz) DESC
    LIMIT $1
  `, [MAX_PCS_PER_RUN]);

  const dead = [];
  for (const r of rows) {
    const ageMs = Date.now() - new Date(r.last_seen).getTime();
    // 14일 이상은 영구 사망으로 간주 — 자동 조치 안 함 (사용자 직접 개입 필요)
    if (ageMs > 14 * 24 * 3600 * 1000) continue;

    const { rows: logRows } = await pool.query(`
      SELECT data_json
      FROM events
      WHERE type = 'daemon.log.snapshot' AND data_json->>'hostname' = $1
      ORDER BY timestamp::timestamptz DESC LIMIT 1
    `, [r.hostname]);
    const { rows: errRows } = await pool.query(`
      SELECT data_json->>'error' AS error, data_json->>'component' AS component
      FROM events
      WHERE type = 'daemon.error' AND data_json->>'hostname' = $1
        AND timestamp::timestamptz > NOW() - INTERVAL '24 hours'
      ORDER BY timestamp::timestamptz DESC LIMIT 5
    `, [r.hostname]);

    dead.push({
      hostname:     r.hostname,
      ageMs,
      recentLog:    String(logRows[0]?.data_json?.lines || '').slice(-LOG_BYTES_MAX),
      recentErrors: errRows,
    });
  }
  return dead;
}

// ─── Claude API 진단 ────────────────────────────────────────────────────────
async function diagnoseWithClaude(pc) {
  const client = getClient();
  if (!client) return null;

  const prompt = `직원 PC의 데이터 수집이 15분 이상 멈췄다. PC는 켜져있을 가능성이 높다 (업무 중 갑자기 끊김).
진단하고 자동 처리할지 결정하라.

호스트: ${pc.hostname}
마지막 실제 수집 데이터: ${Math.round(pc.ageMs / 60000)}분 전
(mouse/keyboard/screen 등 진짜 수집 이벤트 기준 — daemon.update reportStatus는 제외)

최근 self-log (마지막 ${LOG_BYTES_MAX}바이트):
${pc.recentLog || '(없음)'}

최근 24h 데몬 에러:
${pc.recentErrors.map(e => `- [${e.component}] ${e.error}`).join('\n') || '(없음)'}

다음 JSON으로만 응답 (마크다운 X):
{
  "diagnosis": "한 줄 진단",
  "needsReinstall": true|false,
  "needsRestart": true|false,
  "reason": "조치 이유 (없으면 'no_action_needed')"
}

판단 기준:
- 무한 재시작 루프, 모듈 누락 (Cannot find module 등), 영구 침묵 → reinstall
- watcher crash 흔적 (uiohook SIGSEGV 등) / 일회성 에러 → restart
- 15분~수시간 단순 idle은 보통 PC 잠시 안 쓰는 것이지만, 업무 시간대(평일 9-18시 KST)면 의심 → restart
- self-log 없거나 매우 짧으면 데몬 처음부터 안 시작했을 가능성 → reinstall

원칙: PC가 작업 중인데 데이터만 안 들어오면 = watcher 죽음 → restart로 시도.
restart는 가벼움(즉시 끝), reinstall은 무거움(3분 + npm install). 가능하면 restart 우선.`;

  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages:   [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) {
    console.warn('[auto-doctor] Claude API error:', e.message);
    return null;
  }
}

// ─── 자동 조치 (push-exec PG 큐잉) ──────────────────────────────────────────
async function applyAction(pool, hostname, action, reason) {
  const ts = new Date().toISOString();
  try {
    await pool.query(
      `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
       VALUES ($1, $2, NULL, '{}', $3)`,
      [hostname, action, ts]
    );
    return true;
  } catch (e) {
    console.warn(`[auto-doctor] queue ${action} for ${hostname} failed:`, e.message);
    return false;
  }
}

// ─── 24h 가드 (reinstall 횟수 제한) ─────────────────────────────────────────
async function recentlyReinstalled(pool, hostname) {
  try {
    const { rows } = await pool.query(`
      SELECT MAX(ts) AS last_ts FROM orbit_auto_doctor_runs
      WHERE hostname = $1 AND action = 'reinstall'
    `, [hostname]);
    const last = rows[0]?.last_ts;
    if (!last) return false;
    return (Date.now() - new Date(last).getTime()) < REINSTALL_COOLDOWN_MS;
  } catch { return false; }
}

async function logRun(pool, hostname, ageMs, diagnosis, action, reason) {
  try {
    await pool.query(`
      INSERT INTO orbit_auto_doctor_runs (hostname, age_minutes, diagnosis, action, reason)
      VALUES ($1, $2, $3, $4, $5)
    `, [hostname, Math.round(ageMs / 60000), diagnosis || null, action || null, reason || null]);
  } catch {}
}

// ─── 메인 사이클 ────────────────────────────────────────────────────────────
async function runOnce(pool) {
  if (!pool) return { ok: false, reason: 'no_db' };
  if (!getClient()) return { ok: false, reason: 'no_anthropic_key' };
  await ensureTable(pool);

  const dead = await collectDeadPcs(pool);
  const result = { ok: true, checkedAt: new Date().toISOString(), deadPcs: dead.length, actions: [] };

  for (const pc of dead) {
    const diag = await diagnoseWithClaude(pc);
    // Claude 진단 결과 (참고용 — 실제 조치 판단은 시간 기반)
    const diagText = diag ? diag.diagnosis : 'claude_skipped';

    // 2026-06-08 fix: 적극적 자가복구
    // - 15분~ : restart 무조건 (가드 없음, 가벼움)
    // - 12h~  : reinstall 추가 (24h 가드)
    // - Claude 진단은 reason으로 기록만, 판단은 시간 기반 (정책 단순화)
    let action = null;
    let reason = '';
    const ageHours = pc.ageMs / 3600000;

    // 1순위: restart (모든 죽은 PC, 매 사이클 큐잉 — watchdog가 받아 처리)
    if (await applyAction(pool, pc.hostname, 'restart', `auto: dead ${Math.round(pc.ageMs/60000)}min`)) {
      action = 'restart';
      reason = `dead ${Math.round(pc.ageMs/60000)}min (claude: ${diagText})`;
    }

    // 2순위: 12h+ 죽음이면 reinstall도 큐잉 (24h 가드)
    if (ageHours >= 12 && !(await recentlyReinstalled(pool, pc.hostname))) {
      if (await applyAction(pool, pc.hostname, 'reinstall', `auto: dead ${ageHours.toFixed(1)}h`)) {
        action = action ? 'restart+reinstall' : 'reinstall';
        reason += ` + reinstall (${ageHours.toFixed(1)}h)`;
      }
    }

    await logRun(pool, pc.hostname, pc.ageMs, diagText, action, reason);
    if (action) result.actions.push({ hostname: pc.hostname, action, ageMinutes: Math.round(pc.ageMs / 60000), reason });
  }

  if (dead.length || result.actions.length) {
    console.log(`[auto-doctor] checked ${dead.length} dead PCs → ${result.actions.length} actions queued`);
  }
  return result;
}

// ─── Router ─────────────────────────────────────────────────────────────────
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
      const result = await runOnce(pool);
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

  function startScheduler() {
    if (_scheduled) return;
    _scheduled = true;
    // 첫 실행: 서버 부팅 10분 후 (안정화 대기) → 이후 30분 주기
    setTimeout(() => {
      runSafe().catch(e => console.warn('[auto-doctor] first run err:', e.message));
      setInterval(() => {
        runSafe().catch(e => console.warn('[auto-doctor] scheduled err:', e.message));
      }, POLL_INTERVAL_MS);
    }, 10 * 60 * 1000);
    console.log(`[auto-doctor] scheduler started — first run in 10min, then every ${POLL_INTERVAL_MS/60000}min`);
  }

  router.post('/run', async (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    res.json(await runSafe());
  });

  router.get('/last', (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    res.json({ ok: true, lastRun: _lastRun, scheduled: _scheduled, running: _running });
  });

  router.get('/history', async (req, res) => {
    if (!checkAuth(req)) return res.status(403).json({ error: 'admin only' });
    const pool = dbModule.getDb ? dbModule.getDb() : null;
    if (!pool) return res.status(500).json({ error: 'no_db' });
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const { rows } = await pool.query(`
        SELECT hostname, ts, age_minutes, diagnosis, action, reason
        FROM orbit_auto_doctor_runs ORDER BY ts DESC LIMIT $1
      `, [limit]);
      res.json({ ok: true, runs: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.startScheduler = startScheduler;
  return router;
};
