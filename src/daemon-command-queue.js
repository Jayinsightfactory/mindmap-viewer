// [2026-10-21 사장님 지시] 원격 명령 안전장치 — orbit_daemon_commands 큐의 만료·소비확인·중복억제·자동정리.
//   배경: 10/12 사고(force-update-all 미소비 명령이 매분 재전달 → 3일간 전 데몬 1분 재시작 루프), 6~9월 capture-config 1,256건 미소비 적체.
//   ① expires_at: 기본 10분(action 별 override). 만료 명령은 데몬에 재전달하지 않고 status='expired' 로 마감.
//   ② 소비 확인: consumed_at(전달) + executed_at/result_json(데몬 daemon.update command_executed/command_fail ack). delivered_count·redeliver_count(소비 안 된 채 재전달).
//   ③ 중복 억제: dedupe_key = lower(hostname)|action|md5(command+data). 같은 키가 pending 이면 새로 넣지 않고 기존 id 반환.
//   ④ 자동 purge: 호스트당 미소비 N건(기본 20, DAEMON_CMD_PURGE_THRESHOLD) 또는 같은 명령 3회↑ 재전달 → status='purged' + orbit_daemon_command_purges 기록 → /api/completeness/report-line 꼬리 한 줄.
//   ⑤ pg-commands-inspect/purge 는 status 기준. ⑥ 완전성 게이트 자동 restart(src/completeness.js)는 enqueue() 만 쓴다.
//   마이그레이션: ensureSchema() 서버 기동 시 idempotent ALTER(운영 실측 10/21: id 컬럼은 있으나 기본값·시퀀스 없음, 53,429행 id NULL → 시퀀스 생성+백필).
'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MIN = 10;
// action 별 기본 만료(분). 꺼진 PC 에 토큰/설정을 밀어 넣는 config 류는 다음 날 켜도 받아야 하므로 길게.
const TTL_BY_ACTION = { config: 1440, 'capture-config': 1440, reinstall: 120, update: 60, 'drive-backfill': 240, 'rpa-run': 60, 'rpa-dry-run': 60, 'run-script': 60 };
const PURGE_THRESHOLD = Math.max(parseInt(process.env.DAEMON_CMD_PURGE_THRESHOLD) || 20, 3);
const REDELIVER_LIMIT = 3;
const VOLATILE_KEYS = new Set(['ts', 'timestamp', 'reason', 'cause']);

function ttlFor(action, override) {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return n;
  return TTL_BY_ACTION[action] || DEFAULT_TTL_MIN;
}

function stableJson(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).filter((k) => !VOLATILE_KEYS.has(k)).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function dedupeKey(hostname, action, command, data) {
  const h = crypto.createHash('md5').update(String(command || '') + '|' + stableJson(data || {})).digest('hex').slice(0, 16);
  return `${String(hostname || '').toLowerCase()}|${action}|${h}`;
}

async function ensureSchema(pool) {
  await pool.query(`
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS id INTEGER;
    CREATE SEQUENCE IF NOT EXISTS orbit_daemon_commands_id_seq;
    ALTER TABLE orbit_daemon_commands ALTER COLUMN id SET DEFAULT nextval('orbit_daemon_commands_id_seq');
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '${DEFAULT_TTL_MIN} minutes');
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS result_json JSONB;
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS delivered_count INTEGER DEFAULT 0;
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS redeliver_count INTEGER DEFAULT 0;
    ALTER TABLE orbit_daemon_commands ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
    CREATE TABLE IF NOT EXISTS orbit_daemon_command_purges (
      id SERIAL PRIMARY KEY, hostname TEXT, reason TEXT, count INTEGER DEFAULT 0, actions TEXT, ts TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // id 백필: 시퀀스를 기존 최대값 뒤로 맞춘 뒤 NULL 행에 번호 부여(1회만 비용, 이후는 0행)
  await pool.query(`SELECT setval('orbit_daemon_commands_id_seq', GREATEST(COALESCE((SELECT MAX(id) FROM orbit_daemon_commands), 0), COALESCE((SELECT last_value FROM orbit_daemon_commands_id_seq), 0)) + 1, false)`);
  await pool.query(`UPDATE orbit_daemon_commands SET id = nextval('orbit_daemon_commands_id_seq') WHERE id IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dcs_id ON orbit_daemon_commands(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dcs_pending ON orbit_daemon_commands(hostname, status) WHERE consumed_at IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dcs_dedupe ON orbit_daemon_commands(dedupe_key) WHERE status = 'pending' AND consumed_at IS NULL AND dedupe_key IS NOT NULL`);
  // 과거 행 상태 백필: 이미 소비된 행은 consumed, 묵은 미소비 행은 expires_at = ts+10분(다음 sweep 에서 expired 마감)
  await pool.query(`UPDATE orbit_daemon_commands SET status = 'consumed' WHERE consumed_at IS NOT NULL AND status = 'pending'`);
  await pool.query(`UPDATE orbit_daemon_commands SET expires_at = ts + INTERVAL '${DEFAULT_TTL_MIN} minutes' WHERE expires_at IS NULL`);
}

/** 만료된 pending → expired (hostname 지정 시 그 호스트만). 반환: 마감 행 수 */
async function expireStale(pool, hostname) {
  const r = hostname
    ? await pool.query(`UPDATE orbit_daemon_commands SET status = 'expired' WHERE lower(hostname) = lower($1) AND status = 'pending' AND consumed_at IS NULL AND expires_at <= NOW()`, [hostname])
    : await pool.query(`UPDATE orbit_daemon_commands SET status = 'expired' WHERE status = 'pending' AND consumed_at IS NULL AND expires_at <= NOW()`);
  return r.rowCount || 0;
}

/**
 * 명령 적재(모든 서버측 INSERT 가 이 함수만 쓴다).
 * @returns {{id:number, deduped:boolean, expires_at:string}}
 */
async function enqueue(pool, { hostname, action, command = null, data = {}, ttlMinutes } = {}) {
  if (!hostname || !action) throw new Error('hostname/action 필수');
  const key = dedupeKey(hostname, action, command, data);
  const ttl = ttlFor(action, ttlMinutes);
  await expireStale(pool, hostname).catch(() => {});
  const ins = await pool.query(
    `INSERT INTO orbit_daemon_commands (hostname, action, command, data_json, ts, expires_at, status, dedupe_key)
     VALUES ($1,$2,$3,$4::jsonb,NOW(),NOW() + ($5 || ' minutes')::interval,'pending',$6)
     ON CONFLICT (dedupe_key) WHERE status = 'pending' AND consumed_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, expires_at`,
    [hostname, action, command || null, JSON.stringify(data || {}), String(ttl), key]
  );
  if (ins.rows.length) return { id: ins.rows[0].id, deduped: false, expires_at: ins.rows[0].expires_at };
  const { rows } = await pool.query(`SELECT id, expires_at FROM orbit_daemon_commands WHERE dedupe_key = $1 AND status = 'pending' AND consumed_at IS NULL LIMIT 1`, [key]);
  return { id: rows[0]?.id ?? null, deduped: true, expires_at: rows[0]?.expires_at ?? null };
}

/** 데몬 폴링: 만료 마감 → pending(미만료) 상위 10건 → 소비 처리(delivered/redeliver 집계). */
async function fetchForHost(pool, hostname) {
  await expireStale(pool, hostname).catch(() => {});
  const { rows } = await pool.query(
    `SELECT id, action, command, data_json, ts, delivered_count FROM orbit_daemon_commands
      WHERE hostname = $1 AND consumed_at IS NULL AND status = 'pending' AND ts <= NOW() AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY CASE action WHEN 'restart' THEN 1 WHEN 'exec' THEN 2 WHEN 'update' THEN 3 WHEN 'reinstall' THEN 4 ELSE 10 END ASC, ts ASC
      LIMIT 10`, [hostname]);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id).filter((x) => x !== null && x !== undefined);
  // delivered_count>0 인 행이 다시 뽑혔다 = 지난 전달이 소비 처리되지 않았다(10/12 유형) → redeliver_count 증가
  await pool.query(
    `UPDATE orbit_daemon_commands SET consumed_at = NOW(), status = 'consumed', delivered_count = delivered_count + 1,
            redeliver_count = redeliver_count + CASE WHEN delivered_count > 0 THEN 1 ELSE 0 END
      WHERE id = ANY($1::int[])`, [ids]);
  return rows.map((r) => ({ id: r.id, action: r.action, command: r.command, data: r.data_json, ts: r.ts }));
}

/** 데몬 ack(daemon.update status=command_executed|command_fail|command_failed, detail='restart' | 'exec: ...'). 가장 최근 소비된 같은 action 1건에 기록. */
async function ack(pool, { hostname, status, detail }) {
  if (!hostname || !/^command_(executed|fail|failed)$/.test(String(status || ''))) return 0;
  const text = String(detail || '');
  const action = (text.split(/[:\s]/)[0] || '').trim();
  if (!action) return 0;
  const ok = status === 'command_executed';
  const r = await pool.query(
    `UPDATE orbit_daemon_commands SET executed_at = NOW(), status = $3, result_json = $4::jsonb
      WHERE id = (SELECT id FROM orbit_daemon_commands
                   WHERE lower(hostname) = lower($1) AND action = $2 AND consumed_at IS NOT NULL AND executed_at IS NULL
                     AND consumed_at > NOW() - INTERVAL '2 hours'
                   ORDER BY consumed_at DESC LIMIT 1)`,
    [hostname, action, ok ? 'executed' : 'failed', JSON.stringify({ ok, status, detail: text.slice(0, 500) })]);
  return r.rowCount || 0;
}

/** 자동 정리: 호스트당 미소비 ≥ N 또는 같은 명령 재전달 ≥ 3 → purged + 기록. 반환: purge 기록 배열 */
async function sweep(pool) {
  const out = { expired: 0, purges: [] };
  out.expired = await expireStale(pool);
  const { rows: hosts } = await pool.query(
    `SELECT hostname, COUNT(*)::int AS cnt, string_agg(DISTINCT action, ',') AS actions FROM orbit_daemon_commands
      WHERE status = 'pending' AND consumed_at IS NULL GROUP BY hostname HAVING COUNT(*) >= $1`, [PURGE_THRESHOLD]);
  for (const h of hosts) {
    const r = await pool.query(`UPDATE orbit_daemon_commands SET status = 'purged', consumed_at = NOW() WHERE hostname = $1 AND status = 'pending' AND consumed_at IS NULL`, [h.hostname]);
    const rec = { hostname: h.hostname, reason: `미소비 누적 ${h.cnt}건(기준 ${PURGE_THRESHOLD})`, count: r.rowCount || 0, actions: h.actions };
    await pool.query(`INSERT INTO orbit_daemon_command_purges (hostname, reason, count, actions) VALUES ($1,$2,$3,$4)`, [rec.hostname, rec.reason, rec.count, rec.actions]);
    out.purges.push(rec);
  }
  const { rows: loops } = await pool.query(
    `SELECT hostname, action, COUNT(*)::int AS cnt FROM orbit_daemon_commands
      WHERE redeliver_count >= $1 AND status IN ('pending','consumed') AND executed_at IS NULL GROUP BY hostname, action`, [REDELIVER_LIMIT]);
  for (const l of loops) {
    const r = await pool.query(`UPDATE orbit_daemon_commands SET status = 'purged', consumed_at = COALESCE(consumed_at, NOW()) WHERE hostname = $1 AND action = $2 AND redeliver_count >= $3 AND status IN ('pending','consumed') AND executed_at IS NULL`, [l.hostname, l.action, REDELIVER_LIMIT]);
    const rec = { hostname: l.hostname, reason: `같은 명령 ${REDELIVER_LIMIT}회 이상 재전달(10/12 유형)`, count: r.rowCount || 0, actions: l.action };
    await pool.query(`INSERT INTO orbit_daemon_command_purges (hostname, reason, count, actions) VALUES ($1,$2,$3,$4)`, [rec.hostname, rec.reason, rec.count, rec.actions]);
    out.purges.push(rec);
  }
  if (out.purges.length) console.warn('[daemon-cmd-queue] 자동 purge', JSON.stringify(out.purges));
  return out;
}

/** 관리자 purge(pg-commands-purge): pending 만 purged 로 마감 + 기록 */
async function purge(pool, { hostname, actions, purgeAll, reason = 'admin' } = {}) {
  const conds = [`status = 'pending'`, `consumed_at IS NULL`]; const params = [];
  if (hostname) { params.push(hostname); conds.push(`hostname = $${params.length}`); }
  if (!purgeAll) { params.push(actions); conds.push(`action = ANY($${params.length})`); }
  const r = await pool.query(`UPDATE orbit_daemon_commands SET status = 'purged', consumed_at = NOW() WHERE ${conds.join(' AND ')}`, params);
  const n = r.rowCount || 0;
  if (n) await pool.query(`INSERT INTO orbit_daemon_command_purges (hostname, reason, count, actions) VALUES ($1,$2,$3,$4)`, [hostname || 'ALL', reason, n, purgeAll ? '*' : (actions || []).join(',')]).catch(() => {});
  return n;
}

/** 카톡 아침 보고 꼬리: 최근 24시간 자동/수동 purge 와 만료 건수 */
async function reportTail(pool) {
  try {
    const { rows } = await pool.query(`SELECT hostname, reason, count FROM orbit_daemon_command_purges WHERE ts > NOW() - INTERVAL '24 hours' ORDER BY ts DESC LIMIT 10`);
    const { rows: ex } = await pool.query(`SELECT COUNT(*)::int AS n FROM orbit_daemon_commands WHERE status = 'expired' AND expires_at > NOW() - INTERVAL '24 hours'`);
    const parts = [];
    if (rows.length) parts.push(`명령큐 정리 ${rows.map((r) => `${r.hostname} ${r.count}건(${r.reason})`).join(', ')}`);
    if (ex[0]?.n) parts.push(`만료 ${ex[0].n}건`);
    return parts.length ? ' / ' + parts.join(' / ') : '';
  } catch { return ''; }
}

let _timer = null;
function startSweeper(getPool, intervalMs = 5 * 60 * 1000) {
  if (_timer) return _timer;
  _timer = setInterval(async () => { try { const p = getPool(); if (p?.query) await sweep(p); } catch (e) { console.warn('[daemon-cmd-queue] sweep 실패:', e.message); } }, intervalMs);
  _timer.unref();
  return _timer;
}

module.exports = { ensureSchema, enqueue, fetchForHost, ack, sweep, purge, reportTail, expireStale, startSweeper, dedupeKey, ttlFor, stableJson, DEFAULT_TTL_MIN, PURGE_THRESHOLD, REDELIVER_LIMIT };
