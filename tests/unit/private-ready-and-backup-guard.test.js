'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

describe('30일 보관 데이터 유실 방지 하드 가드 (event-archiver)', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
    jest.resetModules();
  });

  test('_archiveUser: Drive 백업 미설정/실패 시 events DELETE 및 NULL archive_log 삽입을 완전 차단한다', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    delete process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID;
    const archiver = require('../../src/event-archiver');

    const queries = [];
    const pool = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT id, type, timestamp')) {
          return {
            rows: [
              { id: 'e1', type: 'screen.analyzed', timestamp: '2026-09-01T00:00:00.000Z', data_json: {}, session_id: 's1', source: 'daemon' },
              { id: 'e2', type: 'keyboard.chunk', timestamp: '2026-09-01T00:01:00.000Z', data_json: {}, session_id: 's1', source: 'daemon' },
            ],
          };
        }
        return { rows: [], rowCount: 0 };
      }),
    };

    const res = await archiver._archiveUser(pool, 'user-1', new Date('2026-10-01T00:00:00.000Z'));
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('drive_backup_missing');
    expect(res.preservedRows).toBe(2);
    expect(queries.some((q) => /DELETE\s+FROM\s+events/i.test(q))).toBe(false);
    expect(queries.some((q) => /INSERT\s+INTO\s+archive_log/i.test(q))).toBe(false);
  });

  test('deleteVerifiedArchivedEvents: drive_file IS NOT NULL 기록이 0건이면 events DELETE를 실행하지 않는다', async () => {
    const archiver = require('../../src/event-archiver');
    const queries = [];
    const pool = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('FROM archive_log')) return { rows: [{ cnt: 0 }] };
        return { rows: [], rowCount: 0 };
      }),
    };

    const res = await archiver.deleteVerifiedArchivedEvents(pool, '2026-10-01T00:00:00.000Z', { pauseMs: 0 });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('no_verified_drive_backup');
    expect(res.deleted).toBe(0);
    expect(queries.some((q) => /DELETE\s+FROM\s+events/i.test(q))).toBe(false);
  });

  test('deleteVerifiedArchivedEvents: archive_log 조회 실패 시에도 안전하게 DELETE를 차단한다', async () => {
    const archiver = require('../../src/event-archiver');
    const pool = {
      query: jest.fn(async () => { throw new Error('relation "archive_log" does not exist'); }),
    };

    const res = await archiver.deleteVerifiedArchivedEvents(pool, '2026-10-01T00:00:00.000Z', { pauseMs: 0 });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe('archive_log_unavailable');
    expect(res.deleted).toBe(0);
  });

  test('deleteVerifiedArchivedEvents: 검증된 Drive 백업이 있을 때만 EXISTS(drive_file IS NOT NULL) 조건으로 배치 삭제한다', async () => {
    const archiver = require('../../src/event-archiver');
    const queries = [];
    const pool = {
      query: jest.fn(async (sql) => {
        queries.push(sql);
        if (sql.includes('SELECT COUNT(*)::int AS cnt FROM archive_log')) return { rows: [{ cnt: 5 }] };
        if (sql.includes('DELETE FROM events')) return { rowCount: 42 };
        return { rows: [], rowCount: 0 };
      }),
    };

    const res = await archiver.deleteVerifiedArchivedEvents(pool, '2026-10-01T00:00:00.000Z', { batchSize: 100, pauseMs: 0 });
    expect(res.skipped).toBe(false);
    expect(res.deleted).toBe(42);
    const delSql = queries.find((q) => q.includes('DELETE FROM events'));
    expect(delSql).toBeTruthy();
    expect(delSql).toContain('EXISTS');
    expect(delSql).toContain('al.drive_file IS NOT NULL');
  });
});

describe('배포 교체 시 무중단 DDL lock_timeout 보호 (db-pg.js)', () => {
  afterEach(() => {
    jest.resetModules();
  });

  test('createTables는 lock_timeout=5s를 적용하고 55P03(lock_timeout) 시 부팅을 중단하지 않는다', async () => {
    const clientQueries = [];
    const release = jest.fn();
    const client = {
      query: jest.fn(async (sql) => {
        clientQueries.push(sql);
        if (sql.includes('CREATE TABLE IF NOT EXISTS events')) {
          const err = new Error('canceling statement due to lock timeout');
          err.code = '55P03';
          throw err;
        }
        return { rows: [] };
      }),
      release,
    };
    const poolQuery = jest.fn(async () => ({ rows: [] }));
    jest.doMock('pg', () => ({
      Pool: jest.fn(() => ({
        connect: jest.fn(async () => client),
        query: poolQuery,
        on: jest.fn(),
      })),
    }));
    jest.doMock('../../src/migrate', () => ({ runMigrations: async () => {} }));
    jest.doMock('../../src/daemon-command-queue', () => ({ ensureSchema: async () => {} }));

    const db = require('../../src/db-pg');
    db.initDatabase();
    await expect(db.waitForTables()).resolves.toBeUndefined();

    expect(clientQueries[0]).toContain("SET lock_timeout = '5s'");
    const ddlSql = clientQueries.find((q) => q.includes('CREATE TABLE IF NOT EXISTS events'));
    expect(ddlSql).toContain("information_schema.columns");
    expect(ddlSql).toContain("set_config('lock_timeout', '5s', true)");
    expect(clientQueries[clientQueries.length - 1]).toBe('RESET lock_timeout');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('GitHub Private 전환 대비 — 무토큰 데몬 릴리즈 번들 서빙 및 1차 업데이트 경로', () => {
  let tmpBase;
  let fakeSrcRoot;
  let fakeCacheDir;
  let fakeClientRoot;
  let server;
  let baseUrl;

  beforeAll(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-r4-test-'));
    fakeSrcRoot = path.join(tmpBase, 'server-repo');
    fakeCacheDir = path.join(tmpBase, 'cache');
    fakeClientRoot = path.join(tmpBase, 'client-repo');

    // 서버 코드 fixture (민감파일/DB 파일 포함해 제외 검증)
    fs.mkdirSync(path.join(fakeSrcRoot, 'daemon'), { recursive: true });
    fs.mkdirSync(path.join(fakeSrcRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fakeSrcRoot, 'node_modules', 'dummy'), { recursive: true });
    fs.writeFileSync(path.join(fakeSrcRoot, 'daemon', 'personal-agent.js'), '// v2 agent\n', 'utf8');
    fs.writeFileSync(path.join(fakeSrcRoot, 'src', 'daemon-updater.js'), '// v2 updater\n', 'utf8');
    fs.writeFileSync(path.join(fakeSrcRoot, 'src', 'mindmap.db'), 'SHOULD_NOT_BUNDLE', 'utf8');
    fs.writeFileSync(path.join(fakeSrcRoot, 'src', 'mindmap.db-wal'), 'SHOULD_NOT_BUNDLE', 'utf8');
    fs.writeFileSync(path.join(fakeSrcRoot, '.env'), 'SECRET=1234', 'utf8');
    fs.writeFileSync(path.join(fakeSrcRoot, 'package.json'), '{"name":"orbit","version":"2.0.1"}\n', 'utf8');
    fs.writeFileSync(path.join(fakeSrcRoot, 'node_modules', 'dummy', 'index.js'), 'x', 'utf8');

    // 클라이언트 fixture (기존 node_modules 보존 검증)
    fs.mkdirSync(path.join(fakeClientRoot, 'daemon'), { recursive: true });
    fs.mkdirSync(path.join(fakeClientRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(fakeClientRoot, 'node_modules', 'keep-pkg'), { recursive: true });
    fs.writeFileSync(path.join(fakeClientRoot, 'daemon', 'personal-agent.js'), '// v1 agent\n', 'utf8');
    fs.writeFileSync(path.join(fakeClientRoot, 'src', 'daemon-updater.js'), '// v1 updater\n', 'utf8');
    fs.writeFileSync(path.join(fakeClientRoot, 'package.json'), '{"name":"orbit","version":"2.0.0"}\n', 'utf8');
    fs.writeFileSync(path.join(fakeClientRoot, 'node_modules', 'keep-pkg', 'ok.txt'), 'PRESERVED', 'utf8');

    const daemonRelease = require('../../src/daemon-release');
    const validToken = 'orbit-test-daemon-token-999';
    const verifyTokenAsync = async (tok) => (tok === validToken ? { id: 'emp-1', email: 'emp@nenova.co.kr' } : null);

    server = http.createServer(async (req, res) => {
      if (req.url === '/api/daemon/release-meta') {
        const authUser = await daemonRelease.authenticateDaemonRequest(req, { verifyTokenAsync });
        const { meta } = await daemonRelease.ensureReleaseBundle({
          rootDir: fakeSrcRoot,
          version: 'a1b2c3d4',
          cacheDir: fakeCacheDir,
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...meta, authenticated: !!authUser }));
        return;
      }
      if (req.url === '/api/daemon/release-bundle') {
        const authUser = await daemonRelease.authenticateDaemonRequest(req, { verifyTokenAsync });
        if (!authUser) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'daemon authentication required' }));
          return;
        }
        await daemonRelease.streamReleaseBundle(res, {
          rootDir: fakeSrcRoot,
          version: 'a1b2c3d4',
          cacheDir: fakeCacheDir,
        });
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  });

  test('release-bundle은 미인증 요청에 401을 반환하고, 인증 시 디스크 캐시 스트리밍으로 200을 반환하며 민감파일을 제외한다', async () => {
    const unauth = await fetch(`${baseUrl}/api/daemon/release-bundle`);
    expect(unauth.status).toBe(401);

    const metaRes = await fetch(`${baseUrl}/api/daemon/release-meta`, {
      headers: { Authorization: 'Bearer orbit-test-daemon-token-999' },
    });
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json();
    expect(meta.ok).toBe(true);
    expect(meta.version).toBe('a1b2c3d4');
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.sizeBytes).toBeGreaterThan(100);
    expect(meta.authenticated).toBe(true);
    expect(meta.bundleAuthRequired).toBe(true);
  });

  test('daemon-updater.updateFromServerBundle: GitHub 토큰 없이 번들 적용·SHA-256 검증·node_modules 보존·재실행 시 upToDate 판정', async () => {
    const updater = require('../../src/daemon-updater');

    const r1 = await updater.updateFromServerBundle({
      serverUrl: baseUrl,
      token: 'orbit-test-daemon-token-999',
      rootDir: fakeClientRoot,
    });
    expect(r1.ok).toBe(true);
    expect(r1.upToDate).toBe(false);
    expect(r1.version).toBe('a1b2c3d4');
    expect(r1.pkgChanged).toBe(true);

    // 파일 교체 확인 + 기존 node_modules 보존 + 민감파일(.env, *.db) 미포함 확인
    expect(fs.readFileSync(path.join(fakeClientRoot, 'daemon', 'personal-agent.js'), 'utf8')).toContain('v2 agent');
    expect(fs.readFileSync(path.join(fakeClientRoot, 'node_modules', 'keep-pkg', 'ok.txt'), 'utf8')).toBe('PRESERVED');
    expect(fs.existsSync(path.join(fakeClientRoot, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(fakeClientRoot, 'src', 'mindmap.db'))).toBe(false);
    expect(fs.existsSync(path.join(fakeClientRoot, 'src', 'mindmap.db-wal'))).toBe(false);

    // 번들 버전 기록 및 getLocalVersion 일관성 확인 (무한 재시작 루프 방지)
    expect(updater.getLocalVersion(fakeClientRoot)).toBe('a1b2c3d4');

    // 두 번째 호출은 즉시 upToDate (다운로드 생략)
    const r2 = await updater.updateFromServerBundle({
      serverUrl: baseUrl,
      token: 'orbit-test-daemon-token-999',
      rootDir: fakeClientRoot,
    });
    expect(r2.ok).toBe(true);
    expect(r2.upToDate).toBe(true);

    // 토큰 없으면 안전하게 실패해 2차 git fallback으로 넘김
    const rNoTok = await updater.updateFromServerBundle({
      serverUrl: baseUrl,
      token: '',
      rootDir: fakeClientRoot,
    });
    expect(rNoTok.ok).toBe(false);
    expect(rNoTok.reason).toBe('missing_server_or_token');
  });
});
