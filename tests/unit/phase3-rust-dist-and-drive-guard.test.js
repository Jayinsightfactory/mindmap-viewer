'use strict';

const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const daemonRelease = require('../../src/daemon-release');
const daemonUpdater = require('../../src/daemon-updater');
const sidecarMod = require('../../src/rust-collector-sidecar');

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('Phase 3 — Server rust-collector-meta 인증/페이로드 & env 오버라이드', () => {
  test('getRustCollectorMeta: 기본값(rust-collector-v0.2.0) 및 RUST_COLLECTOR_META_* 오버라이드 지원', () => {
    const def = daemonRelease.getRustCollectorMeta({});
    expect(def.ok).toBe(true);
    expect(def.version).toBe('0.2.0');
    expect(def.url).toBe('https://github.com/Jayinsightfactory/mindmap-viewer/releases/download/rust-collector-v0.2.0/orbit-collector-rs.exe');
    expect(def.sha256).toBe('d39953ae39d688e226e86c0124bbc75276cd9d7d8cf4ae696ab4c0b81326e48a');
    expect(def.sizeBytes).toBe(485376);
    expect(def.minDaemonVersion).toBe('2.0.0');

    const overridden = daemonRelease.getRustCollectorMeta({
      RUST_COLLECTOR_META_VERSION: '0.3.0',
      RUST_COLLECTOR_META_URL: 'https://example.com/orbit-collector-rs.exe',
      RUST_COLLECTOR_META_SHA256: 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
      RUST_COLLECTOR_META_SIZE_BYTES: '512000',
      RUST_COLLECTOR_META_MIN_DAEMON_VERSION: '2.1.0',
    });
    expect(overridden).toMatchObject({
      ok: true,
      version: '0.3.0',
      url: 'https://example.com/orbit-collector-rs.exe',
      sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      sizeBytes: 512000,
      minDaemonVersion: '2.1.0',
    });
  });

  test('GET /api/daemon/rust-collector-meta: authenticateDaemonRequest 미인증 401 / 유효 토큰 200', async () => {
    const validToken = 'orbit_phase3_valid_token';
    const verifyTokenAsync = async (tok) => (tok === validToken ? { id: 'U-1', email: 'canary@nenova.co.kr' } : null);

    const server = http.createServer(async (req, res) => {
      res.setHeader('Connection', 'close');
      if (req.url === '/api/daemon/rust-collector-meta') {
        const authUser = await daemonRelease.authenticateDaemonRequest(req, { verifyTokenAsync });
        if (!authUser) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'daemon authentication required' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...daemonRelease.getRustCollectorMeta({}), authenticated: true }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
      const unauth = await fetch(`${baseUrl}/api/daemon/rust-collector-meta`);
      expect(unauth.status).toBe(401);

      const badTok = await fetch(`${baseUrl}/api/daemon/rust-collector-meta`, {
        headers: { Authorization: 'Bearer wrong_token' },
      });
      expect(badTok.status).toBe(401);

      const okRes = await fetch(`${baseUrl}/api/daemon/rust-collector-meta`, {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(okRes.status).toBe(200);
      const body = await okRes.json();
      expect(body).toMatchObject({
        ok: true,
        authenticated: true,
        version: '0.2.0',
        sizeBytes: 485376,
      });
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Phase 3 — syncRustCollectorBinary (302 리다이렉트, SHA-256 timingSafeEqual, .tmp 정리, Node 폴백)', () => {
  let tmpDir;
  let server;
  let baseUrl;
  let validPayload;
  let validSha;
  let serveCorrupt = false;
  let downloadHits = 0;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-p3-rust-dist-'));
    validPayload = Buffer.from('MZ-fake-orbit-collector-rs-v0.2.0-binary-payload-0123456789');
    validSha = sha256Buf(validPayload);

    const validToken = 'orbit_sync_tok_123';
    const verifyTokenAsync = async (tok) => (tok === validToken ? { id: 'U-CANARY' } : null);

    server = http.createServer(async (req, res) => {
      if (req.url === '/api/daemon/rust-collector-meta') {
        const authUser = await daemonRelease.authenticateDaemonRequest(req, { verifyTokenAsync });
        if (!authUser) {
          res.statusCode = 401;
          res.end(JSON.stringify({ ok: false, error: 'daemon authentication required' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          ok: true,
          version: '0.2.0',
          url: `${baseUrl}/releases/download/rust-collector-v0.2.0/orbit-collector-rs.exe`,
          sha256: validSha,
          sizeBytes: validPayload.length,
          minDaemonVersion: '2.0.0',
        }));
        return;
      }
      if (req.url === '/releases/download/rust-collector-v0.2.0/orbit-collector-rs.exe') {
        // GitHub Release와 동일하게 302 리다이렉트 시뮬레이션
        res.statusCode = 302;
        res.setHeader('Location', '/cdn-assets/orbit-collector-rs.exe');
        res.end();
        return;
      }
      if (req.url === '/cdn-assets/orbit-collector-rs.exe') {
        downloadHits += 1;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(serveCorrupt ? Buffer.from('CORRUPT-TAMPERED-BINARY') : validPayload);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    serveCorrupt = false;
    downloadHits = 0;
  });

  test('기본 OFF: rustCollector 미설정 시 다운로드하지 않고 opt_in_disabled 반환', async () => {
    const dest = path.join(tmpDir, 'off-case', 'orbit-collector-rs.exe');
    const res = await daemonUpdater.syncRustCollectorBinary({
      serverUrl: baseUrl,
      token: 'orbit_sync_tok_123',
      config: { rustCollector: false },
      env: {},
      binaryPath: dest,
    });
    expect(res).toMatchObject({ ok: true, skipped: true, reason: 'opt_in_disabled' });
    expect(downloadHits).toBe(0);
    expect(fs.existsSync(dest)).toBe(false);
  });

  test('302 리다이렉트 추적 + SHA-256 일치 시 atomic rename 설치, 재실행 시 일치 skip', async () => {
    const dest = path.join(tmpDir, 'ok-case', 'orbit-collector-rs.exe');
    const stopMock = jest.fn();
    const fakeSidecar = {
      getStatus: () => ({ active: true }),
      stop: stopMock,
    };

    const r1 = await daemonUpdater.syncRustCollectorBinary({
      serverUrl: baseUrl,
      token: 'orbit_sync_tok_123',
      config: { rustCollector: true },
      env: {},
      binaryPath: dest,
      sidecar: fakeSidecar,
      restartDelayMs: 0,
    });
    expect(r1).toMatchObject({
      ok: true,
      updated: true,
      upToDate: false,
      version: '0.2.0',
      sha256: validSha,
      sidecarWasRunning: true,
    });
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(downloadHits).toBe(1);
    expect(fs.readFileSync(dest)).toEqual(validPayload);
    expect(fs.existsSync(`${dest}.tmp.${process.pid}`)).toBe(false);

    // 두 번째 호출: SHA-256 일치 → 다운로드 없이 즉시 skip
    const r2 = await daemonUpdater.syncRustCollectorBinary({
      serverUrl: baseUrl,
      token: 'orbit_sync_tok_123',
      config: { rustCollector: true },
      env: {},
      binaryPath: dest,
      restartDelayMs: 0,
    });
    expect(r2).toMatchObject({ ok: true, skipped: true, upToDate: true, sha256: validSha });
    expect(downloadHits).toBe(1);
  });

  test('SHA-256 불일치 시 설치 거부 + .tmp.<pid> 즉시 삭제 + 예외 미전파(Node 폴백)', async () => {
    serveCorrupt = true;
    const dest = path.join(tmpDir, 'corrupt-case', 'orbit-collector-rs.exe');
    const res = await daemonUpdater.syncRustCollectorBinary({
      serverUrl: baseUrl,
      token: 'orbit_sync_tok_123',
      config: {},
      env: { ORBIT_RUST_COLLECTOR: '1' },
      binaryPath: dest,
      restartDelayMs: 0,
    });
    expect(res).toMatchObject({
      ok: false,
      reason: 'sha256_mismatch',
      fallback: 'node',
    });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.tmp.${process.pid}`)).toBe(false);
  });

  test('다운로드 예외/네트워크 오류 시 .tmp 정리 후 예외를 전파하지 않고 Node 폴백 반환', async () => {
    const dest = path.join(tmpDir, 'err-case', 'orbit-collector-rs.exe');
    const res = await daemonUpdater.syncRustCollectorBinary({
      serverUrl: baseUrl,
      token: 'orbit_sync_tok_123',
      config: { rustCollector: true },
      env: {},
      binaryPath: dest,
      downloadFn: async (_url, tmpPath) => {
        fs.writeFileSync(tmpPath, 'partial-bytes');
        throw new Error('ECONNRESET');
      },
    });
    expect(res).toMatchObject({ ok: false, reason: 'sync_error', fallback: 'node' });
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(`${dest}.tmp.${process.pid}`)).toBe(false);
  });

  test('_timingSafeHexEqual: 길이/대소문자/유효성 검증', () => {
    expect(daemonUpdater._timingSafeHexEqual(validSha, validSha.toUpperCase())).toBe(true);
    expect(daemonUpdater._timingSafeHexEqual(validSha, '0'.repeat(64))).toBe(false);
    expect(daemonUpdater._timingSafeHexEqual('short', validSha)).toBe(false);
    expect(daemonUpdater._timingSafeHexEqual(null, validSha)).toBe(false);
  });
});

describe('Phase 3 — Guardian config 우회 감시기 (60초 루프 동적 사이드카 시작/복귀)', () => {
  test('guardian-watchdog.ps1이 ~/.orbit-config.json에 rustCollector:true를 먼저 써도 watcher.tick()이 자동 다운로드 및 사이드카 기동', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-p3-watch-'));
    try {
      const cfgPath = path.join(tmpHome, '.orbit-config.json');
      const binPath = path.join(tmpHome, '.orbit', 'bin', 'orbit-collector-rs.exe');
      fs.writeFileSync(cfgPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:9', token: 'tok', rustCollector: false }), 'utf8');

      const children = [];
      const spawnMock = jest.fn(() => {
        const c = new EventEmitter();
        c.pid = 77700 + children.length;
        c.kill = jest.fn();
        children.push(c);
        return c;
      });
      const sc = sidecarMod.createSidecar({
        spawn: spawnMock,
        existsSync: (p) => fs.existsSync(p),
      });

      const onActivated = jest.fn();
      const onDeactivated = jest.fn();
      const syncBinaryFn = jest.fn(async () => {
        fs.mkdirSync(path.dirname(binPath), { recursive: true });
        fs.writeFileSync(binPath, 'fake-exe', 'utf8');
        return { ok: true, updated: true, binaryPath: binPath };
      });

      const watcher = sidecarMod.createConfigWatcher({
        configPath: cfgPath,
        env: {},
        sidecar: sc,
        syncBinaryFn,
        getStartOpts: () => ({ binaryPath: binPath, serverUrl: 'http://127.0.0.1:9', token: 'tok' }),
        onActivated,
        onDeactivated,
      });

      // 1) 초기 OFF 상태: 아무것도 안 함
      const r0 = await watcher.tick();
      expect(r0).toMatchObject({ action: 'disabled', active: false });
      expect(syncBinaryFn).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();

      // 2) Guardian이 config 명령을 가로채 ~/.orbit-config.json에 rustCollector:true 기록 (BOM 포함 케이스 포함)
      fs.writeFileSync(cfgPath, '\uFEFF' + JSON.stringify({ serverUrl: 'http://127.0.0.1:9', token: 'tok', rustCollector: true }), 'utf8');

      const r1 = await watcher.tick();
      expect(r1).toMatchObject({ action: 'started', active: true });
      expect(syncBinaryFn).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(onActivated).toHaveBeenCalledTimes(1);
      expect(sc.getStatus().active).toBe(true);

      // 3) 이미 기동 중이면 중복 다운로드/스폰 없이 already_active
      const r2 = await watcher.tick();
      expect(r2).toMatchObject({ action: 'already_active', active: true });
      expect(syncBinaryFn).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // 4) 롤백: rustCollector:false 전환 시 사이드카 즉시 중지 + Node 복귀 콜백 호출
      fs.writeFileSync(cfgPath, JSON.stringify({ serverUrl: 'http://127.0.0.1:9', token: 'tok', rustCollector: false }), 'utf8');
      const r3 = await watcher.tick();
      expect(r3).toMatchObject({ action: 'stopped_opt_out', active: false });
      expect(onDeactivated).toHaveBeenCalledTimes(1);
      expect(children[0].kill).toHaveBeenCalledTimes(1);
      expect(sc.getStatus().active).toBe(false);
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('Phase 3 — Drive OOM 가드 & GOOGLE_DRIVE_ARCHIVE_FOLDER_ID 분리', () => {
  test('GDRIVE_SYNC_DISABLED=1|true이면 SA/폴더ID/오버라이드가 있어도 drive-config는 무조건 enabled:false 반환', () => {
    const baseEnv = {
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"sa@test.iam.gserviceaccount.com"}',
      GOOGLE_DRIVE_CAPTURES_FOLDER_ID: 'folder-captures-123',
    };

    expect(daemonRelease.isGdriveSyncDisabled({ GDRIVE_SYNC_DISABLED: '1' })).toBe(true);
    expect(daemonRelease.isGdriveSyncDisabled({ GDRIVE_SYNC_DISABLED: 'true' })).toBe(true);
    expect(daemonRelease.isGdriveSyncDisabled({ GDRIVE_SYNC_DISABLED: 'TRUE' })).toBe(true);
    expect(daemonRelease.isGdriveSyncDisabled({ GDRIVE_SYNC_DISABLED: '0' })).toBe(false);
    expect(daemonRelease.isGdriveSyncDisabled({})).toBe(false);

    expect(daemonRelease.resolveDaemonDriveConfig({
      env: { ...baseEnv, GDRIVE_SYNC_DISABLED: '1' },
      driveDisabled: false,
      folderIdOverride: 'override-folder-999',
    })).toEqual({ enabled: false, disabledReason: 'gdrive_sync_disabled_env' });

    expect(daemonRelease.resolveDaemonDriveConfig({
      env: { ...baseEnv, GDRIVE_SYNC_DISABLED: 'true' },
      driveDisabled: false,
      folderIdOverride: 'override-folder-999',
    })).toEqual({ enabled: false, disabledReason: 'gdrive_sync_disabled_env' });

    expect(daemonRelease.resolveDaemonDriveConfig({
      env: baseEnv,
      driveDisabled: true,
    })).toEqual({ enabled: false, disabledReason: 'drive_global_off' });

    expect(daemonRelease.resolveDaemonDriveConfig({
      env: baseEnv,
      driveDisabled: false,
    })).toMatchObject({ enabled: true, folderId: 'folder-captures-123' });

    // 서버 전용 GOOGLE_DRIVE_ARCHIVE_FOLDER_ID만 설정된 경우 직원 PC drive-config는 enabled:false 유지
    expect(daemonRelease.resolveDaemonDriveConfig({
      env: {
        GOOGLE_SERVICE_ACCOUNT_JSON: baseEnv.GOOGLE_SERVICE_ACCOUNT_JSON,
        GOOGLE_DRIVE_ARCHIVE_FOLDER_ID: 'shared-archive-only-folder',
      },
      driveDisabled: false,
    })).toEqual({ enabled: false });
  });

  test('event-archiver: GOOGLE_DRIVE_ARCHIVE_FOLDER_ID 우선 사용 + GOOGLE_DRIVE_CAPTURES_FOLDER_ID 폴백', () => {
    const archiver = require('../../src/event-archiver');

    expect(archiver.getArchiveParentFolderId({
      GOOGLE_DRIVE_ARCHIVE_FOLDER_ID: 'archive-dedicated-1',
      GOOGLE_DRIVE_CAPTURES_FOLDER_ID: 'captures-legacy-2',
    })).toBe('archive-dedicated-1');

    expect(archiver.getArchiveParentFolderId({
      GOOGLE_DRIVE_CAPTURES_FOLDER_ID: 'captures-legacy-2',
    })).toBe('captures-legacy-2');

    expect(archiver.getArchiveParentFolderId({})).toBeNull();

    // 서버 전용 폴더 ID만 설정해도 아카이버는 Drive 구성 완료로 판정 (직원 PC 업로더는 OFF 유지)
    expect(archiver.isDriveArchiveConfigured({
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"sa@test"}',
      GOOGLE_DRIVE_ARCHIVE_FOLDER_ID: 'archive-dedicated-1',
    })).toBe(true);

    expect(archiver.isDriveArchiveConfigured({
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"sa@test"}',
    })).toBe(false);
  });

  test('정적 배선 검증: server.js, daemon-updater.js, personal-agent.js, build-rust-collector.yml', () => {
    const root = path.join(__dirname, '..', '..');
    const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    expect(serverSrc).toContain("app.get('/api/daemon/rust-collector-meta'");
    expect(serverSrc).toContain('daemonRelease.authenticateDaemonRequest');
    expect(serverSrc).toContain('resolveDaemonDriveConfig');

    const updaterSrc = fs.readFileSync(path.join(root, 'src', 'daemon-updater.js'), 'utf8');
    expect(updaterSrc).toContain('async function syncRustCollectorBinary');
    expect(updaterSrc).toContain('crypto.timingSafeEqual');
    expect(updaterSrc).toContain('.tmp.${process.pid}');

    const agentSrc = fs.readFileSync(path.join(root, 'daemon', 'personal-agent.js'), 'utf8');
    expect(agentSrc).toContain('createConfigWatcher');
    expect(agentSrc).toContain('syncRustCollectorBinary');

    const wfPath = path.join(root, '.github', 'workflows', 'build-rust-collector.yml');
    expect(fs.existsSync(wfPath)).toBe(true);
    const wfSrc = fs.readFileSync(wfPath, 'utf8');
    expect(wfSrc).toContain('windows-latest');
    expect(wfSrc).toContain('cargo test');
    expect(wfSrc).toContain('cargo build --release');
    expect(wfSrc).toContain('SHA256SUMS.txt');
  });
});
