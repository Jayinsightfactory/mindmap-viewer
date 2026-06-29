'use strict';
/**
 * routes/auto-doctor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 데몬 죽음/데이터 단절 자동 처리 — 2026-06-05
 *
 * 동작:
 *   1. 30분마다 모든 PC의 last_seen 검사
 *   2. last_seen > 30분 = 데이터 안 들어옴 → Claude API에 self-log 던져서 진단
 *   3. 안전 명령만 큐잉: gitpull-worker / reclone-worker / capture-diag
 *      (reinstall·restart 영구 금지)
 *   4. 처리 audit log (orbit_auto_doctor_runs)
 *
 * 안전 가드:
 *   - reinstall/restart 금지 — Guardian safe-cmd만
 *   - ANTHROPIC_API_KEY 없으면 자동 비활성
 *   - 살아있는 PC는 진단조차 안 함 (API 비용 절약)
 *   - 코드 수정/git push 자동화 없음 — safe-cmd만
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
  try { _client = require('../src/llm-usage').wrap(new Anthropic({ apiKey: key }), 'auto-doctor'); } catch { return null; }
  return _client;
}

const MASTER_TOKEN          = 'orbit_967930333cab4ff63bc0bcae68c4779e3307d77095375f0d';
const POLL_INTERVAL_MS      = 10 * 60 * 1000;   // 10분 모니터링 (빠른 감지)
const DEAD_THRESHOLD_MS     = 15 * 60 * 1000;   // 15분 = 비정상 (PC 작업 중에도 잡음)
const SAFE_CMD_COOLDOWN_MS  = 30 * 60 * 1000; // PC당 30분 1회 (safe-cmd 폭주 방지)
const FORBIDDEN_ACTIONS     = new Set(['reinstall', 'restart']);
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

// ─── safe-cmd 쿨다운 ─────────────────────────────────────────────────────────
async function canQueueSafeCmd(pool, hostname, action) {
  try {
    const { rows } = await pool.query(`
      SELECT MAX(ts) AS last_ts FROM orbit_auto_doctor_runs
      WHERE hostname = $1 AND action = $2
    `, [hostname, action]);
    const last = rows[0]?.last_ts;
    if (!last) return true;
    return (Date.now() - new Date(last).getTime()) > SAFE_CMD_COOLDOWN_MS;
  } catch { return false; }
}

// [2026-06-18] 백로그 폭탄 방지: 이미 미소비(consumed_at IS NULL) 명령이 있으면 true.
// 오래 죽은 PC에 명령이 누적→부활 시 한꺼번에 실행되어 CPU 폭주(김빛나 NENOVA 실사고:
// 20h dead 동안 gitpull/reclone/capture 수십개 쌓임 → 알약제거로 부활하자 동시 실행 → 렉).
async function hasPendingCommands(pool, hostname) {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM orbit_daemon_commands WHERE hostname = $1 AND consumed_at IS NULL LIMIT 1`,
      [hostname]
    );
    return rows.length > 0;
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

판단 기준 (reinstall/restart 금지):
- git 손상/모듈 누락 → gitpull-worker
- 12시간+ 영구 침묵 → reclone-worker
- watcher 의심 → capture-diag
- 단순 idle(점심/회의) → no_action_needed

원칙: install.ps1 재실행 금지. process.exit/restart 금지. safe-cmd만.`;

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
const SAFE_ACTIONS = new Set(['gitpull-worker', 'reclone-worker', 'capture-diag', 'clear-token-cache', 'set-config', 'update']);

async function applyAction(pool, hostname, action, reason, data = {}) {
  if (FORBIDDEN_ACTIONS.has(action) || !SAFE_ACTIONS.has(action)) {
    console.warn(`[auto-doctor] blocked unsafe action: ${action}`);
    return false;
  }
  const ts = new Date().toISOString();
  try {
    await pool.query(
      `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts)
       VALUES ($1, $2, NULL, $4, $3)`,
      [hostname, action, ts, JSON.stringify({ reason, ...data })]
    );
    if (!global._daemonCommands) global._daemonCommands = {};
    if (!global._daemonCommands[hostname]) global._daemonCommands[hostname] = [];
    global._daemonCommands[hostname].push({ action, data: { reason, ...data }, ts });
    return true;
  } catch (e) {
    console.warn(`[auto-doctor] queue ${action} for ${hostname} failed:`, e.message);
    return false;
  }
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
  // [2026-06-18] Claude 키 없어도 시간기반 복구는 돌린다 (Claude 진단은 참고용·옵션).
  await ensureTable(pool);

  const dead = await collectDeadPcs(pool);
  const result = { ok: true, checkedAt: new Date().toISOString(), deadPcs: dead.length, actions: [] };

  for (const pc of dead) {
    // [2026-06-18] 백로그 가드: 미소비 명령이 이미 쌓여있으면 이번 PC는 건너뛴다.
    // 데몬이 못 받아간 명령이 있다는 건 아직 죽었거나 처리중 → 더 쌓으면 부활 시 폭탄.
    if (await hasPendingCommands(pool, pc.hostname)) {
      await logRun(pool, pc.hostname, pc.ageMs, 'skip: pending cmd exists', null, 'backlog-guard');
      result.actions.push({ hostname: pc.hostname, action: 'skip', reason: 'pending backlog' });
      continue;
    }
    // [2026-06-18] Claude 진단 기본 OFF (무과금). 필요시 env AUTODOCTOR_CLAUDE=on. 죽은PC마다
    // Haiku 호출이 오늘 비용의 주범(죽은PC 많은 날 10분마다×PC수). 조치는 시간기반이라 진단 없어도 됨.
    const diag = (process.env.AUTODOCTOR_CLAUDE === 'on') ? await diagnoseWithClaude(pc) : null;
    const diagText = diag ? diag.diagnosis : 'claude_off';

    // Phase 0: safe-cmd only (reinstall/restart 금지)
    let action = null;
    let reason = '';
    const ageMin = Math.round(pc.ageMs / 60000);

    // 1순위: capture-diag (watcher 상태 수집)
    if (await canQueueSafeCmd(pool, pc.hostname, 'capture-diag')) {
      if (await applyAction(pool, pc.hostname, 'capture-diag', `auto: dead ${ageMin}min`, { claude: diagText })) {
        action = 'capture-diag';
        reason = `dead ${ageMin}min — diag queued`;
      }
    }

    // 2순위: gitpull-worker (코드/모듈 불일치 복구)
    if (ageMin >= 30 && await canQueueSafeCmd(pool, pc.hostname, 'gitpull-worker')) {
      if (await applyAction(pool, pc.hostname, 'gitpull-worker', `auto: dead ${ageMin}min`)) {
        action = action ? `${action}+gitpull-worker` : 'gitpull-worker';
        reason += ` + gitpull (${ageMin}min)`;
      }
    }

    // [2026-06-18] 3순위 reclone-worker 자동 큐 제거 — Windows에선 실행 중 repo 디렉터리
    // rename이 EBUSY로 실패(무용) + 성공해도 레포 통째 재클론이라 CPU/디스크 폭탄(김빛나 사고).
    // 자동복구는 gitpull-worker(가벼움)까지만. reclone이 정말 필요하면 수동으로 보낸다.

    // Claude needsRestart → gitpull-worker (가벼운 safe-cmd)만. needsReinstall→reclone도 제거(상동).
    if (diag?.needsRestart && !action?.includes('gitpull')) {
      await applyAction(pool, pc.hostname, 'gitpull-worker', `claude: ${diag.reason || diagText}`);
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
