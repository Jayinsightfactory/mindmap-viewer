'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const sidecarMod = require('../../src/rust-collector-sidecar');

describe('Phase 1 — Rust Collector Sidecar (100% Default OFF, Binary Check, Circuit Breaker Fallback)', () => {
  test('(a) 기본 OFF 무작동: opt-in 미설정 시 바이너리가 존재해도 절대 스폰하지 않음', () => {
    expect(sidecarMod.isOptedIn({}, {})).toBe(false);
    expect(sidecarMod.isOptedIn({ rustCollector: false }, { ORBIT_RUST_COLLECTOR: '0' })).toBe(false);
    expect(sidecarMod.isOptedIn({ rustCollector: 'true' }, { ORBIT_RUST_COLLECTOR: 'true' })).toBe(false);
    expect(sidecarMod.isOptedIn({ rustCollector: true }, {})).toBe(true);
    expect(sidecarMod.isOptedIn({}, { ORBIT_RUST_COLLECTOR: '1' })).toBe(true);

    const spawnMock = jest.fn();
    const onFallback = jest.fn();
    const sc = sidecarMod.createSidecar({
      spawn: spawnMock,
      existsSync: () => true,
    });

    const res = sc.start({
      config: {},
      env: {},
      serverUrl: 'https://mindmap-viewer-production-adb2.up.railway.app',
      token: 'tok-test',
      onFallback,
    });

    expect(res.active).toBe(false);
    expect(res.state).toBe('disabled');
    expect(res.reason).toBe('opt_in_disabled');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(sc.getStatus()).toMatchObject({
      optedIn: false,
      active: false,
      state: 'disabled',
      circuitOpen: false,
    });
  });

  test('(b) 바이너리 없음 시 Node 폴백: opt-in이어도 ~/.orbit/bin/orbit-collector-rs.exe 미존재 시 무스폰·Node 유지', () => {
    const spawnMock = jest.fn();
    const sc = sidecarMod.createSidecar({
      spawn: spawnMock,
      existsSync: () => false,
    });

    const res = sc.start({
      config: { rustCollector: true },
      env: {},
      homeDir: 'C:\\Users\\CanaryTest',
      serverUrl: 'https://mindmap-viewer-production-adb2.up.railway.app',
      token: 'tok-canary',
    });

    expect(res.active).toBe(false);
    expect(res.state).toBe('fallback_node');
    expect(res.reason).toBe('binary_missing');
    expect(res.binaryPath).toContain('orbit-collector-rs.exe');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(sc.getStatus()).toMatchObject({
      optedIn: true,
      active: false,
      state: 'fallback_node',
      lastError: 'binary_missing',
    });
  });

  test('(c) 크래시루프 서킷브레이커 폴백: 5분 내 3회 크래시 시 세션 동안 서킷 오픈 및 Node 즉시 폴백', () => {
    let fakeNow = 1_700_000_000_000;
    const spawnedChildren = [];
    const scheduledTimers = [];

    const spawnMock = jest.fn(() => {
      const child = new EventEmitter();
      child.pid = 40000 + spawnedChildren.length;
      child.kill = jest.fn();
      spawnedChildren.push(child);
      return child;
    });

    const onFallback = jest.fn();
    const reportEvent = jest.fn();

    const sc = sidecarMod.createSidecar({
      spawn: spawnMock,
      existsSync: () => true,
      now: () => fakeNow,
      setTimeout: (fn) => {
        const handle = { fn, cancelled: false, unref: () => {} };
        scheduledTimers.push(handle);
        return handle;
      },
      clearTimeout: (h) => {
        if (h) h.cancelled = true;
      },
    });

    const res = sc.start({
      config: {},
      env: { ORBIT_RUST_COLLECTOR: '1' },
      binaryPath: 'C:\\Users\\Canary\\.orbit\\bin\\orbit-collector-rs.exe',
      serverUrl: 'https://mindmap-viewer-production-adb2.up.railway.app',
      token: 'tok-canary-123',
      userId: 'U-CANARY',
      respawnBackoffMs: 100,
      onFallback,
      reportEvent,
    });

    expect(res.active).toBe(true);
    expect(res.state).toBe('running');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][2].env).toMatchObject({
      COLL_SERVER: 'https://mindmap-viewer-production-adb2.up.railway.app',
      COLL_TOKEN: 'tok-canary-123',
      COLL_USER: 'U-CANARY',
    });

    // Crash #1 (+10s) -> restarting, no fallback yet
    fakeNow += 10_000;
    spawnedChildren[0].emit('exit', 1, null);
    expect(sc.getStatus()).toMatchObject({
      state: 'restarting',
      crashesInWindow: 1,
      circuitOpen: false,
      fallbackTriggered: false,
    });
    expect(onFallback).not.toHaveBeenCalled();

    // Trigger scheduled respawn #2
    expect(scheduledTimers).toHaveLength(1);
    scheduledTimers[0].fn();
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Crash #2 (+20s) -> spawn error + exit deduplicated to single crash count
    fakeNow += 20_000;
    spawnedChildren[1].emit('error', new Error('ENOEXEC'));
    spawnedChildren[1].emit('exit', 1, null);
    expect(sc.getStatus()).toMatchObject({
      state: 'restarting',
      crashesInWindow: 2,
      totalCrashes: 2,
      circuitOpen: false,
    });
    expect(onFallback).not.toHaveBeenCalled();

    // Trigger scheduled respawn #3
    expect(scheduledTimers).toHaveLength(2);
    scheduledTimers[1].fn();
    expect(spawnMock).toHaveBeenCalledTimes(3);

    // Crash #3 (+30s, total 60s < 5min) -> trips circuit breaker immediately
    fakeNow += 30_000;
    spawnedChildren[2].emit('exit', 139, null);

    expect(sc.getStatus()).toMatchObject({
      active: false,
      state: 'circuit_open',
      circuitOpen: true,
      fallbackTriggered: true,
      crashesInWindow: 3,
      totalCrashes: 3,
    });
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'circuit_breaker_open',
        crashesInWindow: 3,
      })
    );
    expect(reportEvent).toHaveBeenCalledWith(
      'daemon.rust_collector.fallback',
      expect.objectContaining({ reason: 'circuit_breaker_open' })
    );

    // Circuit remains open for the session: further start() calls must not respawn
    const retryRes = sc.start({
      config: { rustCollector: true },
      env: {},
      binaryPath: 'C:\\Users\\Canary\\.orbit\\bin\\orbit-collector-rs.exe',
    });
    expect(retryRes.active).toBe(false);
    expect(retryRes.reason).toBe('circuit_breaker_open');
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  test('슬라이딩 5분 윈도우 밖의 과거 크래시는 서킷브레이커를 오발동하지 않음', () => {
    let fakeNow = 1_700_000_000_000;
    const children = [];
    const timers = [];
    const onFallback = jest.fn();

    const sc = sidecarMod.createSidecar({
      spawn: jest.fn(() => {
        const c = new EventEmitter();
        c.pid = 50000 + children.length;
        c.kill = jest.fn();
        children.push(c);
        return c;
      }),
      existsSync: () => true,
      now: () => fakeNow,
      setTimeout: (fn) => {
        const h = { fn, unref: () => {} };
        timers.push(h);
        return h;
      },
      clearTimeout: () => {},
    });

    sc.start({
      config: { rustCollector: true },
      binaryPath: 'C:\\fake\\orbit-collector-rs.exe',
      onFallback,
    });

    // Crash 1 & 2, then 6 minutes pass (> 5 min window) before Crash 3
    children[0].emit('exit', 1, null);
    timers[0].fn();
    fakeNow += 60_000;
    children[1].emit('exit', 1, null);
    timers[1].fn();
    fakeNow += 6 * 60 * 1000; // > 5 min elapsed since crashes 1 & 2
    children[2].emit('exit', 1, null);

    expect(sc.getStatus().circuitOpen).toBe(false);
    expect(sc.getStatus().crashesInWindow).toBe(1);
    expect(onFallback).not.toHaveBeenCalled();
    sc.stop();
  });
});

describe('Phase 1 — orbit_auth_tokens type PG 백업 버그 회귀 방지', () => {
  const auth = require('../../src/auth');

  afterEach(() => {
    auth._setPgPoolForTest(null);
  });

  test("(d) _pgBackupToken이 type='api'를 명시 컬럼으로 upsert하며 기존 session 오분류를 교정함", async () => {
    const queries = [];
    const mockPool = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params: params || [] });
        return { rows: [], rowCount: 1 };
      }),
    };
    auth._setPgPoolForTest(mockPool);

    await auth.pgBackupToken('orbit_test_api_token_1', 'U-DAEMON-1', null, 'api');

    const insertCall = queries.find((q) => q.sql.includes('INSERT INTO orbit_auth_tokens'));
    expect(insertCall).toBeTruthy();
    expect(insertCall.sql).toContain('(token, user_id, type, expires_at)');
    expect(insertCall.sql).toContain("WHEN EXCLUDED.type = 'api' THEN 'api'");
    expect(insertCall.params[0]).toBe('orbit_test_api_token_1');
    expect(insertCall.params[1]).toBe('U-DAEMON-1');
    expect(insertCall.params[2]).toBe('api');
    expect(insertCall.params[3]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("issueApiTokenAsync 및 3인자 레거시 호출도 SQLite type='api'를 보존함", async () => {
    const queries = [];
    const mockPool = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params: params || [] });
        return { rows: [], rowCount: 1 };
      }),
    };
    auth._setPgPoolForTest(mockPool);

    const testUserId = 'U-DAEMON-TEST-2-' + Date.now();
    const testEmail = `${testUserId.toLowerCase()}@orbit.local`;
    const sqlite = auth.getDb();
    sqlite.prepare(
      `INSERT OR IGNORE INTO users (id, email, name, passwordHash, provider) VALUES (?, ?, ?, '', 'pc_token')`
    ).run(testUserId, testEmail, 'Canary Test User');

    let token = null;
    try {
      token = await auth.issueApiTokenAsync(testUserId);
      expect(token).toMatch(/^orbit_/);

      const insertCalls = queries.filter((q) => q.sql.includes('INSERT INTO orbit_auth_tokens'));
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);
      expect(insertCalls[0].params[0]).toBe(token);
      expect(insertCalls[0].params[2]).toBe('api');

      // Legacy 3-argument caller omitting type must still infer 'api' from SQLite tokens table
      queries.length = 0;
      await auth.pgBackupToken(token, testUserId, null);
      const legacyCall = queries.find((q) => q.sql.includes('INSERT INTO orbit_auth_tokens'));
      expect(legacyCall).toBeTruthy();
      expect(legacyCall.params[2]).toBe('api');

      // Explicit session token preserves 'session'
      queries.length = 0;
      await auth.pgBackupToken('orbit_session_only_tok', testUserId, '2027-01-01T00:00:00.000Z', 'session');
      const sessCall = queries.find((q) => q.sql.includes('INSERT INTO orbit_auth_tokens'));
      expect(sessCall).toBeTruthy();
      expect(sessCall.params[2]).toBe('session');
    } finally {
      try { sqlite.prepare('DELETE FROM tokens WHERE userId = ?').run(testUserId); } catch {}
      try { sqlite.prepare('DELETE FROM users WHERE id = ?').run(testUserId); } catch {}
    }
  });

  test('server.js startup/push-token 및 rust-collector 소스 정적 가드 검증', () => {
    const root = path.join(__dirname, '..', '..');
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    expect(serverSrc).toContain("INSERT INTO orbit_auth_tokens (user_id, token, type, created_at) VALUES ($1,$2,'api',NOW())");
    expect(serverSrc).not.toContain('INSERT INTO orbit_auth_tokens (user_id, token, created_at) VALUES ($1,$2,NOW())');

    const rustMain = fs.readFileSync(path.join(root, 'rust-collector', 'src', 'main.rs'), 'utf8');
    expect(rustMain).not.toContain('fn kb_data');
    expect(rustMain).not.toContain('fn mouse_data');
    expect(rustMain).toContain('--dry-run');
    expect(rustMain).toContain('--self-test');

    const rustHttp = fs.readFileSync(path.join(root, 'rust-collector', 'src', 'http_client.rs'), 'utf8');
    expect(rustHttp).toContain('winhttp.dll');
    expect(rustHttp).toContain('WINHTTP_FLAG_SECURE');

    const agentSrc = fs.readFileSync(path.join(root, 'daemon', 'personal-agent.js'), 'utf8');
    expect(agentSrc).toContain('src/rust-collector-sidecar');
    expect(agentSrc).toContain('isOptedIn(_orbitConfig, process.env)');
  });
});
