'use strict';

const fs = require('fs');
const path = require('path');

describe('Phase 0 — 0021 Migration Static Integrity & Runner Safety', () => {
  const upPath = path.join(__dirname, '..', '..', 'migrations', '0021_phase0_workspace_rls_and_retention.sql');
  const downPath = path.join(__dirname, '..', '..', 'migrations', '0021_phase0_workspace_rls_and_retention.down.sql');

  test('0021 up SQL adds workspace_id default WS-NENOVA-2026, RLS policies, and CONCURRENTLY indexes for all 4 core tables', () => {
    expect(fs.existsSync(upPath)).toBe(true);
    const sql = fs.readFileSync(upPath, 'utf8');

    for (const table of ['events', 'sessions', 'kakao_messages', 'messenger_messages']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE\\s+${table}\\s+ADD COLUMN\\s+workspace_id\\s+TEXT\\s+NOT NULL\\s+DEFAULT\\s+'WS-NENOVA-2026'`, 'i'));
      expect(sql).toMatch(new RegExp(`ALTER TABLE\\s+${table}\\s+ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(sql).toMatch(new RegExp(`CREATE POLICY\\s+${table}_workspace_isolation\\s+ON\\s+${table}`, 'i'));
    }

    // Fail-closed tenant predicate + system bypass
    expect(sql).toContain("current_setting('app.rls_bypass', true) = 'on'");
    expect(sql).toContain("workspace_id = NULLIF(current_setting('app.tenant_id', true), '')");

    // Non-locking composite indexes (no table-locking CREATE INDEX on events)
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_workspace_timestamp');
    expect(sql).toContain('ON events (workspace_id, timestamp)');
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_workspace_started_at');
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_kakao_messages_workspace_created_at');
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messenger_messages_workspace_created_at');
    expect(sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orbit_auth_tokens_created_at');
    expect(sql).toContain('ON orbit_auth_tokens (created_at DESC NULLS LAST)');
    expect(sql).not.toMatch(/VACUUM\s+FULL/i);
  });

  test('0021 down SQL fully reverses policies, RLS, indexes, columns, and _migrations record', () => {
    expect(fs.existsSync(downPath)).toBe(true);
    const sql = fs.readFileSync(downPath, 'utf8');

    for (const table of ['events', 'sessions', 'kakao_messages', 'messenger_messages']) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${table}_workspace_isolation ON ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} DROP COLUMN IF EXISTS workspace_id`);
    }
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_events_workspace_timestamp');
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_sessions_workspace_started_at');
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_kakao_messages_workspace_created_at');
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_messenger_messages_workspace_created_at');
    expect(sql).toContain('DROP INDEX CONCURRENTLY IF EXISTS idx_orbit_auth_tokens_created_at');
    expect(sql).toContain("DELETE FROM _migrations WHERE name = '0021_phase0_workspace_rls_and_retention.sql'");
  });

  test('src/migrate.js excludes *.down.sql and splits CONCURRENTLY statements outside transactions', async () => {
    const { runMigrations, splitSqlStatements } = require('../../src/migrate');
    const upSql = fs.readFileSync(upPath, 'utf8');
    const stmts = splitSqlStatements(upSql);

    // Must preserve DO $$ ... END $$ blocks intact and separate each CREATE INDEX CONCURRENTLY
    expect(stmts.some((s) => s.includes('DO $$') && s.includes('ENABLE ROW LEVEL SECURITY'))).toBe(true);
    const stripComments = (s) => s.replace(/--[^\n]*\n?/g, '').trim();
    const concurrentStmts = stmts.filter((s) => /^CREATE INDEX CONCURRENTLY/i.test(stripComments(s)));
    expect(concurrentStmts.length).toBe(5);
    for (const cs of concurrentStmts) {
      expect(cs).not.toContain('DO $$');
    }

    // runMigrations must NEVER execute .down.sql files
    const executedFiles = [];
    const executedSql = [];
    const fakePool = {
      query: jest.fn(async (sql, params) => {
        executedSql.push(sql);
        if (sql.includes('SELECT name FROM _migrations')) {
          // Pretend 0001..0020 already applied so only 0021 runs
          const existing = fs.readdirSync(path.join(__dirname, '..', '..', 'migrations'))
            .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && !f.startsWith('0021_'));
          return { rows: existing.map((name) => ({ name })) };
        }
        if (sql.includes('INSERT INTO _migrations')) {
          executedFiles.push(params[0]);
        }
        return { rows: [] };
      }),
    };

    await runMigrations(fakePool);
    expect(executedFiles).toEqual(['0021_phase0_workspace_rls_and_retention.sql']);
    expect(executedSql.some((q) => /DISABLE ROW LEVEL SECURITY/i.test(q))).toBe(false);
  });
});

describe('Phase 0 — PG RLS Helpers (withTenant / withSystemBypass) & Workspace Resolution', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function createMockPool(queryHandler) {
    const log = [];
    const client = {
      query: jest.fn(async (sql, params) => {
        log.push({ sql: String(sql).trim(), params: params || [] });
        if (queryHandler) return queryHandler(sql, params);
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn(async () => client),
      query: jest.fn(async (sql, params) => {
        log.push({ sql: String(sql).trim(), params: params || [], directPool: true });
        if (queryHandler) return queryHandler(sql, params);
        return { rows: [], rowCount: 0 };
      }),
      on: jest.fn(),
    };
    return { pool, client, log };
  }

  test('withTenant sets transaction-local app.tenant_id & app.rls_bypass=off, commits, and always releases client', async () => {
    const { pool, client, log } = createMockPool();
    const dbPg = require('../../src/db-pg');

    const result = await dbPg.withTenant('WS-TENANT-A', async (c) => {
      await c.query('SELECT * FROM events LIMIT 1');
      return { ok: true };
    }, pool);

    expect(result).toEqual({ ok: true });
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(log[0].sql).toBe('BEGIN');
    expect(log[1].sql).toBe("SELECT set_config('app.rls_bypass', 'off', true)");
    expect(log[2].sql).toBe("SELECT set_config('app.tenant_id', $1, true)");
    expect(log[2].params).toEqual(['WS-TENANT-A']);
    expect(log[3].sql).toBe('SELECT * FROM events LIMIT 1');
    expect(log[4].sql).toBe('COMMIT');
    // Never uses session-level SET app.tenant_id
    expect(log.some((e) => /^SET\s+app\./i.test(e.sql))).toBe(false);
  });

  test('withTenant rolls back and releases client on callback failure, and rejects empty workspaceId', async () => {
    const { pool, client, log } = createMockPool();
    const dbPg = require('../../src/db-pg');

    await expect(dbPg.withTenant('', async () => {}, pool)).rejects.toThrow(/workspaceId/i);
    await expect(dbPg.withTenant('   ', async () => {}, pool)).rejects.toThrow(/workspaceId/i);

    await expect(
      dbPg.withTenant('WS-TENANT-B', async () => {
        throw new Error('boom');
      }, pool)
    ).rejects.toThrow('boom');

    expect(log.some((e) => e.sql === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('withSystemBypass sets transaction-local app.rls_bypass=on and releases client', async () => {
    const { pool, client, log } = createMockPool();
    const dbPg = require('../../src/db-pg');

    const out = await dbPg.withSystemBypass(async (c) => {
      await c.query('SELECT workspace_id FROM orbit_pc_links WHERE hostname = $1', ['PC-01']);
      return 'done';
    }, pool);

    expect(out).toBe('done');
    expect(log[0].sql).toBe('BEGIN');
    expect(log[1].sql).toBe("SELECT set_config('app.rls_bypass', 'on', true)");
    expect(log[2].sql).toBe("SELECT set_config('app.tenant_id', '', true)");
    expect(log[4].sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('resolveWorkspaceId prioritizes orbit_pc_links -> orbit_auth_tokens -> workspace_members -> legacy Nenova fallback', async () => {
    const dbPg = require('../../src/db-pg');
    dbPg.clearWorkspaceCache();

    // 1) orbit_pc_links hit
    const m1 = createMockPool((sql) => {
      if (sql.includes('FROM orbit_pc_links')) return { rows: [{ workspace_id: 'WS-ACME-01' }] };
      return { rows: [] };
    });
    const r1 = await dbPg.resolveWorkspaceId({ pool: m1.pool, hostname: 'ACME-PC-1', useCache: false });
    expect(r1).toEqual({ workspaceId: 'WS-ACME-01', source: 'orbit_pc_links' });
    // Lookup must execute under system bypass
    expect(m1.log.some((e) => e.sql.includes("set_config('app.rls_bypass', 'on', true)"))).toBe(true);

    // 2) orbit_auth_tokens hit when pc_links empty
    const m2 = createMockPool((sql) => {
      if (sql.includes('FROM orbit_auth_tokens')) return { rows: [{ workspace_id: 'WS-BETA-02' }] };
      return { rows: [] };
    });
    const r2 = await dbPg.resolveWorkspaceId({ pool: m2.pool, hostname: 'UNKNOWN-PC', token: 'tok-beta', useCache: false });
    expect(r2).toEqual({ workspaceId: 'WS-BETA-02', source: 'orbit_auth_tokens' });

    // 3) Legacy Nenova employee PC daemon fallback -> WS-NENOVA-2026
    const m3 = createMockPool(() => ({ rows: [] }));
    const r3 = await dbPg.resolveWorkspaceId({ pool: m3.pool, hostname: 'DESKTOP-NENOVA01', token: 'legacy-tok', userId: 'emp-1', useCache: false });
    expect(r3).toEqual({ workspaceId: 'WS-NENOVA-2026', source: 'legacy_nenova_fallback' });

    // 4) Non-legacy explicit workspace without DB mapping does NOT silently inherit WS-NENOVA-2026
    const m4 = createMockPool(() => ({ rows: [] }));
    const r4 = await dbPg.resolveWorkspaceId({
      pool: m4.pool,
      hostname: 'EXT-PC',
      requestedWorkspaceId: 'WS-EXTERNAL-99',
      useCache: false,
    });
    expect(r4).toEqual({ workspaceId: null, source: 'unmapped' });
  });

  test('insertEvent writes events & sessions with workspace_id inside transaction-local withTenant', async () => {
    const { pool, client, log } = createMockPool();
    jest.doMock('pg', () => ({ Pool: jest.fn(() => pool) }));
    jest.doMock('../../src/migrate', () => ({ runMigrations: async () => {} }));
    jest.doMock('../../src/daemon-command-queue', () => ({ ensureSchema: async () => {} }));

    const dbPg = require('../../src/db-pg');
    dbPg.initDatabase();
    await dbPg.waitForTables();
    log.length = 0;

    await dbPg.insertEvent({
      id: 'ev-rls-1',
      type: 'keyboard.chunk',
      source: 'daemon',
      sessionId: 'sess-rls-1',
      userId: 'emp-1',
      workspaceId: 'WS-TENANT-Z',
      timestamp: new Date().toISOString(),
      data: { app: 'Excel' },
    });

    const tenantSet = log.find((e) => e.sql.includes("set_config('app.tenant_id'"));
    expect(tenantSet).toBeTruthy();
    expect(tenantSet.params).toEqual(['WS-TENANT-Z']);

    const evInsert = log.find((e) => e.sql.includes('INSERT INTO events'));
    expect(evInsert).toBeTruthy();
    expect(evInsert.sql).toContain('workspace_id');
    expect(evInsert.params).toContain('WS-TENANT-Z');

    const sessInsert = log.find((e) => e.sql.includes('INSERT INTO sessions'));
    expect(sessInsert).toBeTruthy();
    expect(sessInsert.sql).toContain('workspace_id');
    expect(sessInsert.params).toContain('WS-TENANT-Z');

    expect(log[log.length - 1].sql).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('Phase 0 — 30일 삭제 버그 수정 (Safe TEXT Timestamp & Retention Policy)', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  test('buildSafeCutoffClause avoids raw text<timestamptz and guards ::timestamptz cast with ISO regex', () => {
    const archiver = require('../../src/event-archiver');
    const clause = archiver.buildSafeCutoffClause('e.timestamp', '$1', { isTextColumn: true });

    expect(clause).toContain('to_char');
    expect(clause).toContain('CASE WHEN e.timestamp ~');
    expect(clause).toContain('e.timestamp::timestamptz ELSE NULL END');
    expect(clause).toContain('< ($1)::timestamptz');
    expect(clause).not.toMatch(/e\.timestamp\s*<\s*NOW\(\)/i);

    const tsClause = archiver.buildSafeCutoffClause('timestamp', '$1', { isTextColumn: false });
    expect(tsClause).toBe('timestamp < ($1)::timestamptz');

    expect(() => archiver.normalizeCutoffIso('not-a-date')).toThrow(/Invalid cutoff/);
  });

  test('resolveRetentionPolicy handles strict, disabled, Drive-configured, and PG-threshold modes cleanly', () => {
    const archiver = require('../../src/event-archiver');

    expect(archiver.resolveRetentionPolicy({ sizeMB: 10900, driveConfigured: false, env: { ARCHIVE_REQUIRE_DRIVE_BACKUP: 'true' } }))
      .toMatchObject({ requireDriveBackup: true, allowNoiseRetention: false, mode: 'strict_drive_required' });

    expect(archiver.resolveRetentionPolicy({ sizeMB: 100, driveConfigured: false, env: { ARCHIVE_REQUIRE_DRIVE_BACKUP: 'false' } }))
      .toMatchObject({ requireDriveBackup: false, allowNoiseRetention: true, mode: 'retention_without_drive' });

    // Auto mode: Drive unconfigured + PG >= 1500MB unlocks non-locking noise retention (fixes 10.9GB deadlock)
    expect(archiver.resolveRetentionPolicy({ sizeMB: 10900, driveConfigured: false, env: {} }))
      .toMatchObject({ requireDriveBackup: false, allowNoiseRetention: true, mode: 'pg_threshold_noise_retention' });

    // Auto mode: Drive unconfigured + PG < 1500MB stays conservative
    expect(archiver.resolveRetentionPolicy({ sizeMB: 500, driveConfigured: false, env: {} }))
      .toMatchObject({ requireDriveBackup: true, allowNoiseRetention: false, mode: 'drive_unconfigured_below_threshold' });

    // Auto mode: Drive configured uses Drive archive primary
    expect(archiver.resolveRetentionPolicy({ sizeMB: 10900, driveConfigured: true, env: {} }))
      .toMatchObject({ requireDriveBackup: true, allowNoiseRetention: false, mode: 'drive_archive_primary' });

    // Live Railway case: GOOGLE_SERVICE_ACCOUNT_JSON SET but GOOGLE_DRIVE_CAPTURES_FOLDER_ID UNSET + sizeMB >= 1500
    expect(archiver.resolveRetentionPolicy({
      sizeMB: 3193,
      env: { GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}', GOOGLE_DRIVE_CAPTURES_FOLDER_ID: '' },
    })).toMatchObject({ driveConfigured: false, allowNoiseRetention: true, mode: 'pg_threshold_noise_retention' });

    // Drive configured but 0 verified backups or Drive upload failed when PG >= threshold
    expect(archiver.resolveRetentionPolicy({
      sizeMB: 3193,
      driveConfigured: true,
      driveBackupFailed: true,
      env: {},
    })).toMatchObject({ allowNoiseRetention: true, mode: 'pg_threshold_noise_retention' });

    // Verify daemon noise types included & business/domain types excluded
    for (const noiseType of ['daemon.healed', 'daemon.diag', 'privacy.stats', 'daemon.crashmoment', 'daemon.crash', 'mouse.watcher.started', 'daemon.screendiag', 'install.selftest', 'idle']) {
      expect(archiver.NOISE_TELEMETRY_TYPES).toContain(noiseType);
    }
    for (const bizType of ['order.detected', 'work.step', 'excel.activity', 'kakao.intel', 'screen.analyzed', 'file.change', 'excel.sheet', 'messenger.work']) {
      expect(archiver.NOISE_TELEMETRY_TYPES).not.toContain(bizType);
    }
  });

  test('pruneExpiredNoiseEvents deletes in LIMIT 5000 + pg_sleep(0.1) batches while preserving golden/audit/verified records', async () => {
    const archiver = require('../../src/event-archiver');
    const calls = [];
    let batchNum = 0;
    const pool = {
      query: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('DELETE FROM events')) {
          batchNum++;
          return { rowCount: batchNum === 1 ? 5000 : 1200 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const res = await archiver.pruneExpiredNoiseEvents(pool, '2026-10-01T00:00:00.000Z', {
      batchSize: 5000,
      maxBatches: 10,
      sleepSeconds: 0.1,
      tag: 'test-retention',
    });

    expect(res.skipped).toBe(false);
    expect(res.deleted).toBe(6200);
    expect(res.batchesRun).toBe(2);

    const delCalls = calls.filter((c) => c.sql.includes('DELETE FROM events'));
    expect(delCalls).toHaveLength(2);
    expect(delCalls[0].sql).toContain('LIMIT $4');
    expect(delCalls[0].sql).toContain("COALESCE(e.metadata_json->>'golden', '') <> 'true'");
    expect(delCalls[0].sql).toContain("COALESCE(e.metadata_json->>'audit', '') <> 'true'");
    expect(delCalls[0].sql).toContain("COALESCE(e.metadata_json->>'verified', '') <> 'true'");
    expect(delCalls[0].sql).toContain('NOT (e.type = ANY($3))');
    expect(delCalls[0].params[3]).toBe(5000);

    const sleepCalls = calls.filter((c) => c.sql.includes('pg_sleep'));
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0].params).toEqual([0.1]);
  });

  test('deleteVerifiedArchivedEvents falls back to noise retention when ARCHIVE_REQUIRE_DRIVE_BACKUP=false or PG over threshold', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.ARCHIVE_REQUIRE_DRIVE_BACKUP = 'false';
    const archiver = require('../../src/event-archiver');

    const queries = [];
    const pool = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('FROM archive_log')) return { rows: [{ cnt: 0 }] };
        if (sql.includes('DELETE FROM events')) return { rowCount: 320 };
        return { rows: [], rowCount: 0 };
      }),
    };

    const res = await archiver.deleteVerifiedArchivedEvents(pool, '2026-10-01T00:00:00.000Z', {
      batchSize: 5000,
      maxBatches: 5,
      sleepSeconds: 0,
      tag: 'test-cleanup',
    });

    expect(res.skipped).toBe(false);
    expect(res.mode).toBe('noise_retention_fallback');
    expect(res.deleted).toBe(320);
    const delQuery = queries.find((q) => q.sql.includes('DELETE FROM events'));
    expect(delQuery.sql).toContain('NOT (e.type = ANY($3))');
    expect(delQuery.sql).toContain('CASE WHEN e.timestamp ~');
  });

  test('_archiveUser with ARCHIVE_REQUIRE_DRIVE_BACKUP=false deletes noise rows and preserves golden/screen.analyzed rows', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    process.env.ARCHIVE_REQUIRE_DRIVE_BACKUP = 'false';
    const archiver = require('../../src/event-archiver');

    let deletedIds = [];
    const pool = {
      query: jest.fn(async (sql, params) => {
        if (sql.includes('SELECT id, type, timestamp')) {
          return {
            rows: [
              { id: 'e-noise-1', type: 'mouse.chunk', timestamp: '2026-09-01T00:00:00.000Z', data_json: {}, metadata_json: {} },
              { id: 'e-golden-1', type: 'mouse.chunk', timestamp: '2026-09-01T00:01:00.000Z', data_json: {}, metadata_json: { golden: true } },
              { id: 'e-analyzed-1', type: 'screen.analyzed', timestamp: '2026-09-01T00:02:00.000Z', data_json: {}, metadata_json: {} },
            ],
          };
        }
        if (sql.includes('DELETE FROM events WHERE id = ANY($1)')) {
          deletedIds = params[0];
          return { rowCount: deletedIds.length };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const res = await archiver._archiveUser(pool, 'emp-1', new Date('2026-10-01T00:00:00.000Z'));
    expect(res.skipped).toBe(false);
    expect(res.rowCount).toBe(1);
    expect(res.preservedRows).toBe(2);
    expect(deletedIds).toEqual(['e-noise-1']);
  });
});

describe('Phase 0 — scripts/pg-diet-inspect.js CLI (dry-run default & non-locking apply)', () => {
  const pgDiet = require('../../scripts/pg-diet-inspect');

  test('parseArgs defaults to dryRun=true, batchSize=5000, and parses --apply flags cleanly', () => {
    expect(pgDiet.parseArgs([])).toMatchObject({
      dryRun: true,
      apply: false,
      batchSize: 5000,
      maxBatches: 20,
      sleepSeconds: 0.1,
    });

    expect(pgDiet.parseArgs(['--apply', '--batch-size', '5000', '--max-batches', '15', '--keep-days', '45'])).toMatchObject({
      dryRun: false,
      apply: true,
      batchSize: 5000,
      maxBatches: 15,
      keepDays: 45,
    });
  });

  test('inspectDatabase (--dry-run) runs read-only queries and outputs table/index MB and candidate counts', async () => {
    const executed = [];
    const pool = {
      query: jest.fn(async (sql) => {
        executed.push(sql);
        if (sql.includes('pg_database_size')) return { rows: [{ bytes: 10900 * 1024 * 1024 }] };
        if (sql.includes('pg_stat_user_tables')) {
          return { rows: [{ table_name: 'events', total_bytes: 9500 * 1024 * 1024, table_bytes: 7000 * 1024 * 1024, index_bytes: 2500 * 1024 * 1024, live_tuples: 5000000, dead_tuples: 420000 }] };
        }
        if (sql.includes('pg_stat_user_indexes')) {
          return { rows: [{ index_name: 'idx_events_timestamp', table_name: 'events', index_bytes: 1200 * 1024 * 1024, idx_scan: 1200 }] };
        }
        if (sql.includes('pg_indexes')) return { rows: [] };
        if (sql.includes('to_regclass')) return { rows: [{ reg: 'events' }] };
        if (sql.includes('deletable_noise')) return { rows: [{ deletable_noise: 3100000, preserved_other: 45000 }] };
        return { rows: [{ cnt: 100 }] };
      }),
    };

    const report = await pgDiet.inspectDatabase(pool, { keepDays: 30 });
    expect(report.databaseSizeMB).toBeCloseTo(10900, 1);
    expect(report.tables[0]).toMatchObject({ table: 'events', totalMB: 9500, tableMB: 7000, indexMB: 2500 });
    expect(report.candidates.eventsExpiredNoise).toBe(3100000);
    expect(report.candidates.eventsExpiredProtected).toBe(45000);
    expect(executed.some((q) => /\bDELETE\b|\bVACUUM\b/i.test(q))).toBe(false);
    // Must avoid unindexed full COUNT(*) on orbit_auth_tokens when created_at index is missing
    expect(executed.some((q) => q.includes('FROM orbit_auth_tokens'))).toBe(false);
    expect(report.candidates.unusedSessionTokensEstimated).toBe(true);

    const text = pgDiet.formatReport(report);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('events');
    expect(text).toContain('3100000');
  });

  test('applyDiet executes batched deletes and non-locking VACUUM (ANALYZE), never VACUUM FULL', async () => {
    const executed = [];
    const pool = {
      query: jest.fn(async (sql) => {
        executed.push(sql);
        if (sql.includes('pg_database_size')) return { rows: [{ bytes: 8000 * 1024 * 1024 }] };
        if (sql.includes('pg_stat_user_tables')) return { rows: [] };
        if (sql.includes('pg_stat_user_indexes')) return { rows: [] };
        if (sql.includes('to_regclass')) return { rows: [{ reg: 'events' }] };
        if (sql.includes('deletable_noise')) return { rows: [{ deletable_noise: 1500, preserved_other: 100 }] };
        if (sql.includes('DELETE FROM events')) return { rowCount: 1500 };
        return { rows: [{ cnt: 0 }], rowCount: 0 };
      }),
    };

    const res = await pgDiet.applyDiet(pool, { batchSize: 5000, maxBatches: 5, sleepSeconds: 0 });
    expect(res.deletedEvents).toBe(1500);
    expect(res.vacuumAnalyzeRan).toBe(true);
    expect(executed.some((q) => q.includes('VACUUM (ANALYZE) events'))).toBe(true);
    expect(executed.some((q) => /VACUUM\s+FULL/i.test(q))).toBe(false);
  });
});
