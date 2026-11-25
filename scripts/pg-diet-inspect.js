#!/usr/bin/env node
'use strict';
/**
 * scripts/pg-diet-inspect.js — PostgreSQL 용량 진단 & 비잠금 배치 다이어트 CLI
 *
 * 사용법:
 *   node scripts/pg-diet-inspect.js                         # 기본 --dry-run (읽기 전용 진단)
 *   node scripts/pg-diet-inspect.js --dry-run --keep-days 30
 *   node scripts/pg-diet-inspect.js --apply --batch-size 5000 --max-batches 20
 *   node scripts/pg-diet-inspect.js --apply --batch-size 5000 --max-batches 50 --sleep-sec 0.1
 *
 * 안전 규칙:
 *   - 기본 모드는 --dry-run (DB 쓰기 0회).
 *   - --apply 는 골든/감사/검증/업무 핵심 레코드를 보존하면서 만료(>KEEP_DAYS)된 raw 노이즈 텔레메트리만
 *     LIMIT batchSize + pg_sleep(sleepSec) 비잠금 배치로 삭제한다.
 *   - 테이블을 잠그는 VACUUM FULL 은 절대 실행하지 않고 non-locking VACUUM (ANALYZE) 만 사용한다.
 *   - DATABASE_URL, 시크릿, PII 는 절대 출력하지 않는다.
 */

require('dotenv').config();

const {
  pruneExpiredNoiseEvents,
  buildSafeCutoffClause,
  KEEP_DAYS,
  BATCH_SIZE,
  NOISE_TELEMETRY_TYPES,
  PROTECTED_EVENT_TYPES,
} = require('../src/event-archiver');

function parseArgs(argv = []) {
  const opts = {
    apply: false,
    dryRun: true,
    batchSize: BATCH_SIZE,
    maxBatches: 20,
    keepDays: KEEP_DAYS || 30,
    sleepSeconds: 0.1,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') {
      opts.apply = true;
      opts.dryRun = false;
    } else if (arg === '--dry-run') {
      opts.apply = false;
      opts.dryRun = true;
    } else if (arg === '--batch-size' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) opts.batchSize = Math.min(Math.max(n, 100), 20000);
    } else if (arg === '--max-batches' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) opts.maxBatches = Math.min(Math.max(n, 1), 500);
    } else if (arg === '--keep-days' && argv[i + 1] !== undefined) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) opts.keepDays = Math.min(Math.max(n, 1), 3650);
    } else if (arg === '--sleep-sec' && argv[i + 1] !== undefined) {
      const s = Number(argv[++i]);
      if (Number.isFinite(s) && s >= 0) opts.sleepSeconds = Math.min(s, 5);
    } else if (arg === '--json') {
      opts.json = true;
    }
  }
  return opts;
}

function _bytesToMB(bytes) {
  return Math.round((Number(bytes || 0) / 1024 / 1024) * 100) / 100;
}

async function _tableExists(pool, tableName) {
  const { rows } = await pool.query('SELECT to_regclass($1) AS reg', [`public.${tableName}`]);
  return Boolean(rows?.[0]?.reg);
}

async function inspectDatabase(pool, { keepDays = KEEP_DAYS || 30 } = {}) {
  const cutoffIso = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();

  const dbSizeRes = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
  const databaseSizeMB = _bytesToMB(dbSizeRes.rows?.[0]?.bytes);

  const tablesRes = await pool.query(`
    SELECT
      relname AS table_name,
      pg_total_relation_size(relid) AS total_bytes,
      pg_relation_size(relid) AS table_bytes,
      pg_indexes_size(relid) AS index_bytes,
      COALESCE(n_live_tup, 0)::bigint AS live_tuples,
      COALESCE(n_dead_tup, 0)::bigint AS dead_tuples
    FROM pg_stat_user_tables
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 15
  `);

  const indexesRes = await pool.query(`
    SELECT
      indexrelname AS index_name,
      relname AS table_name,
      pg_relation_size(indexrelid) AS index_bytes,
      COALESCE(idx_scan, 0)::bigint AS idx_scan
    FROM pg_stat_user_indexes
    ORDER BY pg_relation_size(indexrelid) DESC
    LIMIT 15
  `);

  const tables = (tablesRes.rows || []).map((r) => ({
    table: r.table_name,
    totalMB: _bytesToMB(r.total_bytes),
    tableMB: _bytesToMB(r.table_bytes),
    indexMB: _bytesToMB(r.index_bytes),
    liveTuples: Number(r.live_tuples || 0),
    deadTuples: Number(r.dead_tuples || 0),
  }));

  const indexes = (indexesRes.rows || []).map((r) => ({
    index: r.index_name,
    table: r.table_name,
    sizeMB: _bytesToMB(r.index_bytes),
    scans: Number(r.idx_scan || 0),
  }));

  const candidates = {
    cutoffIso,
    keepDays,
    eventsExpiredNoise: 0,
    eventsExpiredProtected: 0,
    unusedSessionTokens30d: 0,
    crashes90d: 0,
    diagnostics90d: 0,
  };

  if (await _tableExists(pool, 'events')) {
    const safeWhere = buildSafeCutoffClause('e.timestamp', '$1', { isTextColumn: true });
    const evCand = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE e.type = ANY($2)
             AND NOT (e.type = ANY($3))
             AND COALESCE(e.metadata_json->>'golden', '') <> 'true'
             AND COALESCE(e.metadata_json->>'audit', '') <> 'true'
             AND COALESCE(e.metadata_json->>'verified', '') <> 'true'
             AND COALESCE(e.metadata_json->>'preserve', '') <> 'true'
             AND COALESCE(e.data_json->>'golden', '') <> 'true'
             AND COALESCE(e.data_json->>'audit', '') <> 'true'
             AND COALESCE(e.data_json->>'verified', '') <> 'true'
             AND COALESCE(e.data_json->>'preserve', '') <> 'true'
         )::bigint AS deletable_noise,
         COUNT(*) FILTER (
           WHERE NOT (
             e.type = ANY($2)
             AND NOT (e.type = ANY($3))
             AND COALESCE(e.metadata_json->>'golden', '') <> 'true'
             AND COALESCE(e.metadata_json->>'audit', '') <> 'true'
             AND COALESCE(e.metadata_json->>'verified', '') <> 'true'
             AND COALESCE(e.metadata_json->>'preserve', '') <> 'true'
             AND COALESCE(e.data_json->>'golden', '') <> 'true'
             AND COALESCE(e.data_json->>'audit', '') <> 'true'
             AND COALESCE(e.data_json->>'verified', '') <> 'true'
             AND COALESCE(e.data_json->>'preserve', '') <> 'true'
           )
         )::bigint AS preserved_other
       FROM events e
       WHERE ${safeWhere}`,
      [cutoffIso, NOISE_TELEMETRY_TYPES, PROTECTED_EVENT_TYPES]
    );
    candidates.eventsExpiredNoise = Number(evCand.rows?.[0]?.deletable_noise || 0);
    candidates.eventsExpiredProtected = Number(evCand.rows?.[0]?.preserved_other || 0);
  }

  if (await _tableExists(pool, 'orbit_auth_tokens')) {
    // Avoid unindexed full seq-scan on bloated orbit_auth_tokens heap (use index check + safe fallback to pg_stat_user_tables)
    const idxCheck = await pool.query(`
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'orbit_auth_tokens'
        AND indexdef ILIKE '%created_at%'
      LIMIT 1
    `).catch(() => ({ rows: [] }));
    if ((idxCheck.rows || []).length > 0) {
      const tokRes = await pool.query(`
        SELECT COUNT(*)::bigint AS cnt
        FROM orbit_auth_tokens
        WHERE type = 'session' AND last_used_at IS NULL
          AND created_at < NOW() - INTERVAL '30 days'
      `);
      candidates.unusedSessionTokens30d = Number(tokRes.rows?.[0]?.cnt || 0);
      candidates.unusedSessionTokensEstimated = false;
    } else {
      const tokStat = tables.find((t) => t.table === 'orbit_auth_tokens');
      candidates.unusedSessionTokens30d = tokStat ? tokStat.deadTuples : 0;
      candidates.unusedSessionTokensEstimated = true;
    }
  }

  if (await _tableExists(pool, 'orbit_crashes')) {
    const crRes = await pool.query(`SELECT COUNT(*)::bigint AS cnt FROM orbit_crashes WHERE ts < NOW() - INTERVAL '90 days'`);
    candidates.crashes90d = Number(crRes.rows?.[0]?.cnt || 0);
  }

  if (await _tableExists(pool, 'orbit_diagnostics')) {
    const dgRes = await pool.query(`SELECT COUNT(*)::bigint AS cnt FROM orbit_diagnostics WHERE created_at < NOW() - INTERVAL '90 days'`);
    candidates.diagnostics90d = Number(dgRes.rows?.[0]?.cnt || 0);
  }

  return {
    inspectedAt: new Date().toISOString(),
    databaseSizeMB,
    tables,
    indexes,
    candidates,
  };
}

async function applyDiet(pool, opts = {}) {
  const keepDays = opts.keepDays || KEEP_DAYS || 30;
  const batchSize = opts.batchSize || BATCH_SIZE;
  const maxBatches = opts.maxBatches || 20;
  const sleepSeconds = opts.sleepSeconds !== undefined ? opts.sleepSeconds : 0.1;
  const cutoffIso = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();

  const before = await inspectDatabase(pool, { keepDays });
  const pruneRes = await pruneExpiredNoiseEvents(pool, cutoffIso, {
    batchSize,
    maxBatches,
    sleepSeconds,
    tag: 'pg-diet',
  });

  let vacuumRan = false;
  if (pruneRes.deleted > 0) {
    // Non-locking space map & planner stats refresh (NEVER VACUUM FULL)
    await pool.query('VACUUM (ANALYZE) events');
    vacuumRan = true;
  }

  const afterSizeRes = await pool.query('SELECT pg_database_size(current_database()) AS bytes');
  const afterDatabaseSizeMB = _bytesToMB(afterSizeRes.rows?.[0]?.bytes);

  return {
    mode: 'apply',
    cutoffIso,
    keepDays,
    batchSize,
    maxBatches,
    sleepSeconds,
    beforeDatabaseSizeMB: before.databaseSizeMB,
    afterDatabaseSizeMB,
    deletedEvents: pruneRes.deleted,
    batchesRun: pruneRes.batchesRun,
    vacuumAnalyzeRan: vacuumRan,
    before,
  };
}

function formatReport(report, opts = {}) {
  const lines = [];
  const isApply = report.mode === 'apply';
  const inspect = isApply ? report.before : report;

  lines.push(`=== PG Diet Inspect (${isApply ? 'APPLY' : 'DRY-RUN'}) ===`);
  lines.push(`Database Size (before): ${inspect.databaseSizeMB.toFixed(2)} MB`);
  lines.push('');
  lines.push('[Top Tables (MB)]');
  for (const t of inspect.tables.slice(0, 10)) {
    lines.push(
      `  ${t.table.padEnd(28)} total=${t.totalMB.toFixed(2)}MB  table=${t.tableMB.toFixed(2)}MB  index=${t.indexMB.toFixed(2)}MB  live=${t.liveTuples}  dead=${t.deadTuples}`
    );
  }
  lines.push('');
  lines.push('[Top Indexes (MB)]');
  for (const idx of inspect.indexes.slice(0, 10)) {
    lines.push(
      `  ${idx.index.padEnd(36)} table=${idx.table.padEnd(20)} size=${idx.sizeMB.toFixed(2)}MB  scans=${idx.scans}`
    );
  }
  lines.push('');
  lines.push(`[Retention Candidates (> ${inspect.candidates.keepDays} days, cutoff=${inspect.candidates.cutoffIso})]`);
  lines.push(`  events (deletable raw noise):      ${inspect.candidates.eventsExpiredNoise}`);
  lines.push(`  events (protected/preserved):      ${inspect.candidates.eventsExpiredProtected}`);
  lines.push(`  orbit_auth_tokens (unused >30d):   ${inspect.candidates.unusedSessionTokens30d}`);
  lines.push(`  orbit_crashes (>90d):              ${inspect.candidates.crashes90d}`);
  lines.push(`  orbit_diagnostics (>90d):          ${inspect.candidates.diagnostics90d}`);

  if (isApply) {
    lines.push('');
    lines.push('[Apply Result]');
    lines.push(`  Deleted noise events: ${report.deletedEvents} (batches=${report.batchesRun}, batchSize=${report.batchSize})`);
    lines.push(`  VACUUM (ANALYZE):     ${report.vacuumAnalyzeRan ? 'executed (non-locking)' : 'skipped (0 deleted)'}`);
    lines.push(`  Database Size (after): ${report.afterDatabaseSizeMB.toFixed(2)} MB`);
  } else {
    lines.push('');
    lines.push(
      `[Dry-Run] 0 rows deleted. To apply non-locking cleanup: node scripts/pg-diet-inspect.js --apply --batch-size ${opts.batchSize || 5000} --max-batches ${opts.maxBatches || 20}`
    );
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    console.error('[pg-diet] DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Use system bypass inside read/maintenance session if non-owner role is used
    const result = opts.apply
      ? await applyDiet(pool, opts)
      : await inspectDatabase(pool, opts);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatReport(result, opts));
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[pg-diet] Failed:', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  inspectDatabase,
  applyDiet,
  formatReport,
};
