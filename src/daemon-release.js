'use strict';
/**
 * daemon-release.js — GitHub Private 전환 대비 무토큰(GitHub 무접속) 데몬 코드 릴리즈 서빙
 *
 * 설계 원칙:
 *   1. 직원 PC에는 GitHub 토큰을 절대 배포하지 않는다.
 *   2. 서버 RAM 증가 0MB: 번들(.tar.gz)을 메모리 Buffer에 절대 올리지 않고
 *      디스크 캐시(os.tmpdir()/orbit-daemon-releases)에 1회 생성 후 fs.createReadStream으로 스트리밍한다.
 *   3. 데몬 실행에 필요한 디렉터리/파일만 allowlist로 묶고, DB/로그/비밀파일(.env, *.db*, .git, node_modules)은 제외한다.
 *   4. GET /api/daemon/release-bundle 은 기존 Orbit 데몬 Bearer 토큰(verifyTokenAsync / admin) 인증을 강제한다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RELEASE_ALLOWLIST = [
  'daemon',
  'src',
  'setup',
  'bin',
  'config',
  'services',
  'adapters',
  'chrome-extension',
  'package.json',
  'package-lock.json',
];

const EXCLUDE_PATTERNS = [
  '*.db',
  '*.db-wal',
  '*.db-shm',
  '*.sqlite',
  '*.sqlite3',
  '*.log',
  '.env',
  '.env.*',
  'node_modules',
  '.git',
  '.orbit-release-version',
];

const _inflight = new Map();

function _sanitizeVersion(version) {
  const raw = String(version || 'unknown').trim();
  const clean = raw.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
  return clean || 'unknown';
}

function _streamSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

function _buildTarGz(rootDir, outPath) {
  return new Promise((resolve, reject) => {
    const entries = RELEASE_ALLOWLIST.filter((rel) => fs.existsSync(path.join(rootDir, rel)));
    if (entries.length === 0) {
      return reject(new Error('릴리즈 번들 대상 파일이 없습니다'));
    }
    const args = [];
    for (const pat of EXCLUDE_PATTERNS) {
      args.push(`--exclude=${pat}`);
    }
    args.push('-czf', outPath, '-C', rootDir, ...entries);
    execFile('tar', args, { timeout: 120000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        return reject(new Error(`tar 번들 생성 실패: ${stderr || err.message}`));
      }
      resolve(entries);
    });
  });
}

function _pruneOldCache(cacheDir, keepPrefix) {
  try {
    for (const name of fs.readdirSync(cacheDir)) {
      if (!name.startsWith('orbit-daemon-')) continue;
      if (name.startsWith(keepPrefix)) continue;
      try { fs.unlinkSync(path.join(cacheDir, name)); } catch {}
    }
  } catch {}
}

/**
 * 현재 서버 코드 기준 데몬 릴리즈 번들을 디스크에 1회 생성(캐시)하고 메타데이터를 반환한다.
 * 인메모리 버퍼 적재 없음 (RAM +0MB).
 */
async function ensureReleaseBundle({
  rootDir = path.resolve(__dirname, '..'),
  version = 'unknown',
  cacheDir = path.join(os.tmpdir(), 'orbit-daemon-releases'),
} = {}) {
  const safeVer = _sanitizeVersion(version);
  const key = `${cacheDir}::${safeVer}`;
  if (_inflight.has(key)) return _inflight.get(key);

  const job = (async () => {
    fs.mkdirSync(cacheDir, { recursive: true });
    const prefix = `orbit-daemon-${safeVer}`;
    const bundleFile = path.join(cacheDir, `${prefix}.tar.gz`);
    const metaFile = path.join(cacheDir, `${prefix}.meta.json`);

    if (fs.existsSync(bundleFile) && fs.existsSync(metaFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        const stat = fs.statSync(bundleFile);
        if (cached && cached.version === safeVer && cached.sha256 && stat.size === cached.sizeBytes) {
          return { meta: cached, bundleFile };
        }
      } catch {}
    }

    const tmpBundle = `${bundleFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      await _buildTarGz(rootDir, tmpBundle);
      const [sha256, stat] = await Promise.all([
        _streamSha256(tmpBundle),
        fs.promises.stat(tmpBundle),
      ]);
      fs.renameSync(tmpBundle, bundleFile);
      const meta = {
        ok: true,
        version: safeVer,
        sha256,
        sizeBytes: stat.size,
        builtAt: new Date().toISOString(),
        format: 'tar.gz',
        bundlePath: '/api/daemon/release-bundle',
        bundleAuthRequired: true,
      };
      const tmpMeta = `${metaFile}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2), 'utf8');
      fs.renameSync(tmpMeta, metaFile);
      _pruneOldCache(cacheDir, prefix);
      return { meta, bundleFile };
    } catch (e) {
      try { if (fs.existsSync(tmpBundle)) fs.unlinkSync(tmpBundle); } catch {}
      throw e;
    }
  })().finally(() => {
    _inflight.delete(key);
  });

  _inflight.set(key, job);
  return job;
}

/**
 * 기존 Orbit 데몬 Bearer 토큰(또는 관리자 토큰) 검증.
 * GitHub 토큰은 사용하지 않으며, 미인증 요청은 null 반환.
 */
async function authenticateDaemonRequest(req, { verifyTokenAsync, isAdminReqAsync } = {}) {
  try {
    if (typeof isAdminReqAsync === 'function' && await isAdminReqAsync(req)) {
      return { role: 'admin', id: 'admin' };
    }
  } catch {}
  const raw = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim()
    || String(req.headers?.['x-api-token'] || '').trim();
  if (!raw) return null;
  if (typeof verifyTokenAsync === 'function') {
    try {
      const user = await verifyTokenAsync(raw);
      if (user) return { role: 'daemon', id: user.id || user.email || 'user' };
    } catch {}
  }
  return null;
}

/**
 * 디스크 캐시 번들을 스트리밍으로 응답한다 (인메모리 버퍼 적재 금지).
 */
async function streamReleaseBundle(res, opts = {}) {
  const { meta, bundleFile } = await ensureReleaseBundle(opts);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Length', String(meta.sizeBytes));
  res.setHeader('Content-Disposition', `attachment; filename="orbit-daemon-${meta.version}.tar.gz"`);
  res.setHeader('X-Release-Version', meta.version);
  res.setHeader('X-Release-Sha256', meta.sha256);
  res.setHeader('Cache-Control', 'private, max-age=300');

  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(bundleFile);
    rs.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy(err);
      reject(err);
    });
    res.on('finish', () => resolve(meta));
    rs.pipe(res);
  });
}

const DEFAULT_RUST_COLLECTOR_META = Object.freeze({
  version: '0.2.0',
  tag: 'rust-collector-v0.2.0',
  filename: 'orbit-collector-rs.exe',
  url: 'https://github.com/Jayinsightfactory/mindmap-viewer/releases/download/rust-collector-v0.2.0/orbit-collector-rs.exe',
  sha256: 'd39953ae39d688e226e86c0124bbc75276cd9d7d8cf4ae696ab4c0b81326e48a',
  sizeBytes: 485376,
  minDaemonVersion: '2.0.0',
});

/**
 * Rust 수집기(.exe) 원격 배포 메타데이터 반환.
 * 기본값은 GitHub Release rust-collector-v0.2.0이며, RUST_COLLECTOR_META_* 환경변수로 오버라이드 가능.
 */
function getRustCollectorMeta(env = process.env) {
  const src = env || {};
  const version = String(src.RUST_COLLECTOR_META_VERSION || DEFAULT_RUST_COLLECTOR_META.version).trim()
    || DEFAULT_RUST_COLLECTOR_META.version;
  const url = String(src.RUST_COLLECTOR_META_URL || DEFAULT_RUST_COLLECTOR_META.url).trim()
    || DEFAULT_RUST_COLLECTOR_META.url;
  const sha256 = String(src.RUST_COLLECTOR_META_SHA256 || DEFAULT_RUST_COLLECTOR_META.sha256).trim().toLowerCase()
    || DEFAULT_RUST_COLLECTOR_META.sha256;
  const parsedSize = parseInt(String(src.RUST_COLLECTOR_META_SIZE_BYTES || ''), 10);
  const sizeBytes = Number.isFinite(parsedSize) && parsedSize > 0
    ? parsedSize
    : DEFAULT_RUST_COLLECTOR_META.sizeBytes;
  const minDaemonVersion = String(src.RUST_COLLECTOR_META_MIN_DAEMON_VERSION || DEFAULT_RUST_COLLECTOR_META.minDaemonVersion).trim()
    || DEFAULT_RUST_COLLECTOR_META.minDaemonVersion;
  return {
    ok: true,
    version,
    url,
    sha256,
    sizeBytes,
    minDaemonVersion,
    filename: DEFAULT_RUST_COLLECTOR_META.filename,
  };
}

/**
 * GDRIVE_SYNC_DISABLED 환경변수가 '1' 또는 'true'인지 판정한다.
 */
function isGdriveSyncDisabled(env = process.env) {
  const raw = String((env && env.GDRIVE_SYNC_DISABLED) || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * GET /api/daemon/drive-config 응답 생성 (직원 PC Drive 업로더 OOM 원천 차단 가드 포함).
 */
function resolveDaemonDriveConfig({ env = process.env, driveDisabled = false, folderIdOverride = null } = {}) {
  if (isGdriveSyncDisabled(env)) {
    return { enabled: false, disabledReason: 'gdrive_sync_disabled_env' };
  }
  if (driveDisabled) {
    return { enabled: false, disabledReason: 'drive_global_off' };
  }
  const saJson = env && env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderId = folderIdOverride || (env && env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID);
  if (!saJson || !folderId) {
    return { enabled: false };
  }
  return { enabled: true, credentialsJson: saJson, folderId };
}

module.exports = {
  RELEASE_ALLOWLIST,
  EXCLUDE_PATTERNS,
  DEFAULT_RUST_COLLECTOR_META,
  ensureReleaseBundle,
  authenticateDaemonRequest,
  streamReleaseBundle,
  getRustCollectorMeta,
  isGdriveSyncDisabled,
  resolveDaemonDriveConfig,
};
