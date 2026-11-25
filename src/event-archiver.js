'use strict';
/**
 * event-archiver.js — events 테이블 자동 아카이브
 *
 * 동작:
 *   1. events 테이블 행 수가 THRESHOLD 초과 시 트리거
 *   2. KEEP_DAYS 이전 이벤트를 사용자별로 분석 + 요약
 *   3. 분석 결과 + 원본 배치 → Google Drive /orbit-archive/YYYY-MM/ 저장
 *   4. DB에서 해당 행 삭제
 *   5. archive_log 테이블에 기록
 *
 * 환경변수:
 *   GOOGLE_SERVICE_ACCOUNT_JSON — 서비스 계정 JSON 문자열
 *   GOOGLE_DRIVE_ARCHIVE_FOLDER_ID — 서버 전용 아카이브 폴더 ID (우선, 직원 PC Drive 업로더와 분리)
 *   GOOGLE_DRIVE_CAPTURES_FOLDER_ID — 레거시 폴백 폴더 ID
 *   ARCHIVE_THRESHOLD — 행 수 임계값 (기본 50000)
 *   ARCHIVE_KEEP_DAYS — 보존 기간(일) (기본 30)
 */

const https  = require('https');
const crypto = require('crypto');

const THRESHOLD  = parseInt(process.env.ARCHIVE_THRESHOLD)  || 50000; // 5만건 초과 시 아카이브
const KEEP_DAYS  = parseInt(process.env.ARCHIVE_KEEP_DAYS)  || 30;    // 최근 30일 유지
const BATCH_SIZE = 5000; // 한 번에 조회/삭제할 최대 행 수 (비잠금 배치 기본값)
const PG_DIET_THRESHOLD_MB = parseInt(process.env.PG_DIET_THRESHOLD_MB || process.env.ARCHIVE_PG_THRESHOLD_MB || '1500', 10) || 1500;

// ISO-8601 텍스트 타임스탬프 검증 정규식 (잘못된 형식 행에서 ::timestamptz 예외 방지)
const ISO_TS_REGEX = '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})?$';

// Drive 미구성/용량 임계 초과 시 만료(>KEEP_DAYS) 정리 대상인 raw 노이즈 텔레메트리 타입
// (order.detected, work.step, excel.activity, kakao.intel, screen.analyzed, file.change, excel.sheet, messenger.work 등 업무 이벤트는 보존)
const NOISE_TELEMETRY_TYPES = [
  'screen.capture',
  'mouse.chunk',
  'mouse_click',
  'mouse.watcher.started',
  'keyboard.chunk',
  'clipboard.change',
  'daemon.update',
  'daemon.heartbeat',
  'daemon.log.snapshot',
  'daemon.perf.issue',
  'daemon.healed',
  'daemon.diag',
  'daemon.crashmoment',
  'daemon.crash',
  'daemon.screendiag',
  'privacy.stats',
  'install.selftest',
  'window.focus',
  'app.switch',
  'idle',
  'idle.start',
  'idle.end',
  'work.action',
];

// 절대 자동 삭제하지 않는 골든/감사/검증/업무 핵심 이벤트 타입
const PROTECTED_EVENT_TYPES = [
  'orbit.golden',
  'entity.golden',
  'audit.log',
  'audit.event',
  'verification.result',
  'order.verified',
  'excel.sheet',
  'screen.analyzed',
  'session.start',
  'session.end',
  'daemon.register',
];

function normalizeCutoffIso(cutoff) {
  const d = cutoff instanceof Date ? cutoff : new Date(cutoff);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid cutoff timestamp: ${cutoff}`);
  }
  return d.toISOString();
}

/**
 * TEXT 타입 timestamp 컬럼을 안전하게 TIMESTAMPTZ로 캐스팅하는 SQL 표현식.
 * 비ISO 문자열이 섞여 있어도 invalid input syntax 예외를 내지 않고 NULL로 평가된다.
 */
function safeTextTimestampExpr(col = 'timestamp') {
  return `(CASE WHEN ${col} ~ '${ISO_TS_REGEX}' THEN ${col}::timestamptz ELSE NULL END)`;
}

/**
 * events.timestamp(TEXT) 또는 unified_events.timestamp(TIMESTAMPTZ) 비교 시
 * text < timestamptz 타입 에러를 원천 차단하고, B-tree 인덱스 사전필터 + 정확한 timestamptz 비교를 조합한다.
 */
function buildSafeCutoffClause(col = 'timestamp', paramRef = '$1', { isTextColumn = true } = {}) {
  if (!isTextColumn) {
    return `${col} < (${paramRef})::timestamptz`;
  }
  return `${col} < to_char(((${paramRef})::timestamptz + INTERVAL '1 day') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AND ${safeTextTimestampExpr(col)} < (${paramRef})::timestamptz`;
}

function _parseJsonSafe(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function isProtectedEvent(row) {
  if (!row) return true;
  if (PROTECTED_EVENT_TYPES.includes(row.type)) return true;
  const meta = _parseJsonSafe(row.metadata_json || row.metadata);
  const data = _parseJsonSafe(row.data_json || row.data);
  const flags = [meta.golden, meta.audit, meta.verified, meta.preserve, data.golden, data.audit, data.verified, data.preserve];
  return flags.some((f) => f === true || String(f).toLowerCase() === 'true');
}

/**
 * 명시적 보존 정책 해석:
 *   ARCHIVE_REQUIRE_DRIVE_BACKUP=true|1|strict : Drive 백업 없으면 절대 삭제 금지
 *   ARCHIVE_REQUIRE_DRIVE_BACKUP=false|0|off   : Drive 미구성 시 만료 노이즈 텔레메트리 비잠금 배치 정리 허용
 *   미설정 / auto (기본)                        : GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_DRIVE_CAPTURES_FOLDER_ID 모두 설정 시 Drive 우선,
 *                                               Drive 미구성(폴더 ID 미설정 포함)이거나 PG 임계치 초과 상태에서 Drive 백업 실패/0건 시 노이즈만 정리
 */
function getArchiveParentFolderId(env = process.env) {
  const dedicated = env && env.GOOGLE_DRIVE_ARCHIVE_FOLDER_ID && String(env.GOOGLE_DRIVE_ARCHIVE_FOLDER_ID).trim();
  if (dedicated) return dedicated;
  const legacy = env && env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID && String(env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID).trim();
  return legacy || null;
}

function isDriveArchiveConfigured(env = process.env) {
  return Boolean(
    env && env.GOOGLE_SERVICE_ACCOUNT_JSON && String(env.GOOGLE_SERVICE_ACCOUNT_JSON).trim() &&
    getArchiveParentFolderId(env)
  );
}

function resolveRetentionPolicy({
  sizeMB = 0,
  driveConfigured = undefined,
  driveBackupFailed = false,
  verifiedBatches = null,
  env = process.env,
} = {}) {
  const isDriveReady = driveConfigured !== undefined ? Boolean(driveConfigured) : isDriveArchiveConfigured(env);
  const raw = String(env.ARCHIVE_REQUIRE_DRIVE_BACKUP ?? 'auto').trim().toLowerCase();
  const pgThresholdMB = parseInt(env.PG_DIET_THRESHOLD_MB || env.ARCHIVE_PG_THRESHOLD_MB || String(PG_DIET_THRESHOLD_MB), 10) || PG_DIET_THRESHOLD_MB;

  if (raw === 'true' || raw === '1' || raw === 'strict') {
    return { requireDriveBackup: true, allowNoiseRetention: false, mode: 'strict_drive_required', pgThresholdMB, driveConfigured: isDriveReady };
  }
  if (raw === 'false' || raw === '0' || raw === 'off') {
    return { requireDriveBackup: false, allowNoiseRetention: true, mode: 'retention_without_drive', pgThresholdMB, driveConfigured: isDriveReady };
  }
  const overThreshold = Number(sizeMB) >= pgThresholdMB;
  if (overThreshold && (!isDriveReady || driveBackupFailed || verifiedBatches === 0)) {
    return { requireDriveBackup: false, allowNoiseRetention: true, mode: 'pg_threshold_noise_retention', pgThresholdMB, driveConfigured: isDriveReady };
  }
  if (isDriveReady) {
    return { requireDriveBackup: true, allowNoiseRetention: false, mode: 'drive_archive_primary', pgThresholdMB, driveConfigured: isDriveReady };
  }
  return { requireDriveBackup: true, allowNoiseRetention: false, mode: 'drive_unconfigured_below_threshold', pgThresholdMB, driveConfigured: isDriveReady };
}

// ══════════════════════════════════════════════════════════════════════════════
// Drive 인증 (서비스 계정 JWT)
// ══════════════════════════════════════════════════════════════════════════════
let _token = null;
let _tokenExpiry = 0;
let _archiveFolderId = null; // 캐시
let _archiveFolderParentId = null; // 캐시 키(부모 폴더 변경 시 무효화)

async function _getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;

  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!saRaw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 미설정');
  const sa = JSON.parse(saRaw);

  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await _post('oauth2.googleapis.com', '/token', body, 'application/x-www-form-urlencoded');
  _token = result.access_token;
  _tokenExpiry = Date.now() + (result.expires_in - 60) * 1000;
  return _token;
}

// ── HTTPS 유틸 ─────────────────────────────────────────────────────────────
function _post(host, path, body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': buf.length },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch {}
        if (res.statusCode >= 400 || (parsed && typeof parsed === 'object' && parsed.error)) {
          const msg = parsed?.error_description || parsed?.error?.message || parsed?.error || d.slice(0, 200);
          return reject(new Error(`HTTP ${res.statusCode}: ${msg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function _get(host, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: host, path, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch {}
        if (res.statusCode >= 400 || (parsed && typeof parsed === 'object' && parsed.error)) {
          const msg = parsed?.error?.message || parsed?.error || d.slice(0, 200);
          return reject(new Error(`Drive GET HTTP ${res.statusCode}: ${msg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Drive 폴더/파일 관리
// ══════════════════════════════════════════════════════════════════════════════
async function _ensureFolder(name, parentId, token) {
  // 기존 폴더 검색
  const q = encodeURIComponent(
    `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    + (parentId ? ` and '${parentId}' in parents` : '')
  );
  const search = await _get('www.googleapis.com', `/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`, token);
  if (search.files && search.files.length > 0) return search.files[0].id;

  // 없으면 생성
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const created = await _postWithAuth('www.googleapis.com', '/drive/v3/files?supportsAllDrives=true', JSON.stringify(meta), 'application/json', token);
  if (!created?.id) throw new Error(`Drive 폴더 생성 응답에 id 없음 (${name}): ${JSON.stringify(created).slice(0, 200)}`);
  return created.id;
}

function _postWithAuth(host, path, body, contentType, token) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': contentType, 'Content-Length': buf.length },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch {}
        if (res.statusCode >= 400 || (parsed && typeof parsed === 'object' && parsed.error)) {
          const msg = parsed?.error?.message || parsed?.error || d.slice(0, 200);
          return reject(new Error(`Drive POST HTTP ${res.statusCode}: ${msg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

async function _uploadJson(content, filename, folderId, token) {
  const buf     = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  const boundary = 'ARC' + Date.now();
  const meta     = JSON.stringify({ name: filename, parents: [folderId] });

  const bodyParts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
  ];
  const bodyBuf = Buffer.concat([
    Buffer.from(bodyParts.join('')),
    buf,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: '/upload/drive/v3/files?uploadType=multipart&fields=id,name&supportsAllDrives=true',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let parsed = d;
        try { parsed = JSON.parse(d); } catch {}
        if (res.statusCode >= 400 || (parsed && typeof parsed === 'object' && parsed.error)) {
          const msg = parsed?.error?.message || parsed?.error || d.slice(0, 200);
          return reject(new Error(`Drive Upload HTTP ${res.statusCode}: ${msg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function _getArchiveFolder(monthKey) {
  const token = await _getToken();
  const parentId = getArchiveParentFolderId(process.env);

  // orbit-archive 루트 폴더
  if (!_archiveFolderId || _archiveFolderParentId !== parentId) {
    _archiveFolderId = await _ensureFolder('orbit-archive', parentId, token);
    _archiveFolderParentId = parentId;
  }
  // 월별 하위 폴더
  const monthFolderId = await _ensureFolder(monthKey, _archiveFolderId, token);
  return { token, monthFolderId };
}

// ══════════════════════════════════════════════════════════════════════════════
// 분석 요약 (work-learner 없이 독립 동작)
// ══════════════════════════════════════════════════════════════════════════════
function _summarizeEvents(rows) {
  const appCounts = {};
  const typeCounts = {};
  const hourCounts = new Array(24).fill(0);
  let firstTs = null, lastTs = null;

  for (const row of rows) {
    typeCounts[row.type] = (typeCounts[row.type] || 0) + 1;

    const ts = new Date(row.timestamp);
    if (!firstTs || ts < firstTs) firstTs = ts;
    if (!lastTs  || ts > lastTs)  lastTs  = ts;
    hourCounts[ts.getUTCHours()]++;

    const data = row.data_json
      ? (typeof row.data_json === 'string' ? (() => { try { return JSON.parse(row.data_json); } catch { return {}; } })() : row.data_json)
      : {};
    const app = data.app || data.appName || null;
    if (app) appCounts[app] = (appCounts[app] || 0) + 1;
  }

  const topApps = Object.entries(appCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const peakHour = hourCounts.indexOf(Math.max(...hourCounts));

  return {
    totalEvents: rows.length,
    dateRange: {
      from: firstTs?.toISOString(),
      to:   lastTs?.toISOString(),
    },
    eventTypes: typeCounts,
    topApps,
    peakHour: `${peakHour}:00 UTC`,
    hourlyDistribution: hourCounts,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 아카이브 로그 테이블 초기화
// ══════════════════════════════════════════════════════════════════════════════
async function _ensureArchiveTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS archive_log (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      from_date   TIMESTAMPTZ NOT NULL,
      to_date     TIMESTAMPTZ NOT NULL,
      row_count   INTEGER NOT NULL,
      drive_file  TEXT,
      summary     JSONB
    )
  `);
}

// ══════════════════════════════════════════════════════════════════════════════
// 테이블 크기 조회
// ══════════════════════════════════════════════════════════════════════════════
async function getTableStats(pool) {
  const [countRes, sizeRes] = await Promise.all([
    pool.query('SELECT COUNT(*) AS cnt FROM events'),
    pool.query(`SELECT pg_size_pretty(pg_total_relation_size('events')) AS pretty,
                       pg_total_relation_size('events') AS bytes`),
  ]);
  return {
    rows:      parseInt(countRes.rows[0].cnt),
    sizePretty: sizeRes.rows[0].pretty,
    sizeBytes: parseInt(sizeRes.rows[0].bytes),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 사용자 1명 아카이브
// ══════════════════════════════════════════════════════════════════════════════
async function _archiveUser(pool, userId, cutoffDate, opts = {}) {
  const cutoffIso = normalizeCutoffIso(cutoffDate);
  // 아카이브 대상 조회 (BATCH_SIZE 단위로 처리해 메모리 제한, 안전한 TEXT timestamp 비교)
  const { rows } = await pool.query(
    `SELECT id, type, timestamp, data_json, metadata_json, session_id, source
     FROM events
     WHERE user_id = $1 AND ${buildSafeCutoffClause('timestamp', '$2', { isTextColumn: true })}
     ORDER BY timestamp ASC
     LIMIT $3`,
    [userId, cutoffIso, BATCH_SIZE]
  );
  if (rows.length === 0) return { skipped: true };

  const summary = _summarizeEvents(rows);
  const monthKey = cutoffIso.slice(0, 7); // YYYY-MM
  const filename = `${userId.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}.json`;

  const archivePayload = {
    userId,
    archivedAt: new Date().toISOString(),
    cutoffDate: cutoffIso,
    summary,
    // 원본 이벤트 (screen.capture 이미지 제외 — 용량 절약)
    events: rows.map(r => ({
      id: r.id,
      type: r.type,
      timestamp: r.timestamp,
      session_id: r.session_id,
      source: r.source,
      data: (() => {
        const d = r.data_json
          ? (typeof r.data_json === 'string' ? (() => { try { return JSON.parse(r.data_json); } catch { return {}; } })() : r.data_json)
          : {};
        // 이미지 데이터 제거 (용량 절약)
        const { thumbnail, screenshot, imageBase64, base64, ...rest } = d;
        return rest;
      })(),
    })),
  };

  // Drive 업로드 (실제 Drive 업로드 완료(drive_file IS NOT NULL) 시 원본 전체 삭제)
  let driveFileId = null;
  const saEnabled = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const folderIdSet = Boolean(getArchiveParentFolderId(process.env));
  if (saEnabled) {
    try {
      const { token, monthFolderId } = await _getArchiveFolder(monthKey);
      const uploaded = await _uploadJson(archivePayload, filename, monthFolderId, token);
      const candidateId = typeof uploaded?.id === 'string' ? uploaded.id.trim() : '';
      if (!candidateId) {
        throw new Error(`Drive 업로드 응답에 파일 id 없음: ${JSON.stringify(uploaded).slice(0, 200)}`);
      }
      driveFileId = candidateId;
      console.log(`[archiver] Drive 업로드 완료: ${filename} (${driveFileId})`);
    } catch (e) {
      console.error(`[archiver] Drive 업로드 실패 (${userId}):`, e.message);
    }
  }

  // Drive 백업 미확인 시 명시적 보존 정책(ARCHIVE_REQUIRE_DRIVE_BACKUP) 평가
  if (!driveFileId) {
    const policy = resolveRetentionPolicy({
      sizeMB: opts.sizeMB || 0,
      driveConfigured: isDriveArchiveConfigured(),
      driveBackupFailed: saEnabled,
    });
    if (opts.allowNoiseRetention === true || policy.allowNoiseRetention) {
      const deletable = rows.filter((r) => NOISE_TELEMETRY_TYPES.includes(r.type) && !isProtectedEvent(r));
      const preservedRows = rows.length - deletable.length;
      if (deletable.length === 0) {
        console.log(`[archiver] ${userId}: Drive 미구성 — 만료 행 ${rows.length}건 모두 골든/감사/업무 보호 대상(삭제 0건)`);
        return { userId, skipped: true, reason: 'only_protected_rows', preservedRows, driveFileId: null, mode: policy.mode };
      }
      const noiseIds = deletable.map((r) => r.id);
      const { rowCount } = await pool.query(`DELETE FROM events WHERE id = ANY($1)`, [noiseIds]);
      console.log(`[archiver] ${userId}: Drive 미구성 보존정책(${policy.mode}) — 만료 노이즈 ${rowCount}건 삭제, 보호 레코드 ${preservedRows}건 보존`);
      return { userId, skipped: false, rowCount, preservedRows, driveFileId: null, mode: policy.mode, summary };
    }
    console.warn(`[archiver] Drive 백업 미확인(drive_file=null, saEnabled=${saEnabled}, folderIdSet=${folderIdSet}) — ${userId} ${rows.length}건 원본 보존(DELETE 차단)`);
    return { userId, skipped: true, reason: 'drive_backup_missing', preservedRows: rows.length, driveFileId: null };
  }

  // 아카이브 로그 먼저 기록 (drive_file 검증값 확정) 후 DB 삭제
  const fromDate = new Date(rows[0].timestamp);
  const toDate   = new Date(rows[rows.length - 1].timestamp);
  await pool.query(
    `INSERT INTO archive_log (user_id, from_date, to_date, row_count, drive_file, summary)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, fromDate, toDate, rows.length, driveFileId, JSON.stringify(summary)]
  );

  // DB 삭제 (Drive 백업 + archive_log 기록 완료된 행만)
  const ids = rows.map(r => r.id);
  const { rowCount } = await pool.query(
    `DELETE FROM events WHERE id = ANY($1)`,
    [ids]
  );

  return { userId, rowCount, driveFileId, summary };
}

/**
 * 비잠금 배치 노이즈 텔레메트리 정리 헬퍼.
 * - 만료(>KEEP_DAYS)된 raw 노이즈 텔레메트리만 LIMIT 5000 + pg_sleep(0.1) 으로 안전하게 삭제한다.
 * - 골든(orbit.golden/entity.golden), 감사(audit.*), 검증(verification.*), 업무 핵심 이벤트 및
 *   metadata_json/data_json 보호 플래그(golden/audit/verified/preserve='true') 행은 영구 보존한다.
 */
async function pruneExpiredNoiseEvents(pool, cutoff, {
  batchSize = BATCH_SIZE,
  maxBatches = 20,
  sleepSeconds = 0.1,
  noiseTypes = NOISE_TELEMETRY_TYPES,
  tag = 'retention',
} = {}) {
  if (!pool?.query) return { skipped: true, reason: 'no_pool', deleted: 0, batchesRun: 0 };
  const cutoffIso = normalizeCutoffIso(cutoff);
  const safeBatch = Math.min(Math.max(parseInt(batchSize, 10) || BATCH_SIZE, 100), 20000);
  const safeMaxBatches = Math.min(Math.max(parseInt(maxBatches, 10) || 20, 1), 500);
  const safeSleep = Number.isFinite(Number(sleepSeconds)) ? Math.max(0, Number(sleepSeconds)) : 0.1;
  const types = Array.isArray(noiseTypes) && noiseTypes.length > 0 ? noiseTypes : NOISE_TELEMETRY_TYPES;

  let deleted = 0;
  let batchesRun = 0;
  for (let i = 0; i < safeMaxBatches; i++) {
    const r = await pool.query(
      `DELETE FROM events
       WHERE id IN (
         SELECT e.id FROM events e
         WHERE ${buildSafeCutoffClause('e.timestamp', '$1', { isTextColumn: true })}
           AND e.type = ANY($2)
           AND NOT (e.type = ANY($3))
           AND COALESCE(e.metadata_json->>'golden', '') <> 'true'
           AND COALESCE(e.metadata_json->>'audit', '') <> 'true'
           AND COALESCE(e.metadata_json->>'verified', '') <> 'true'
           AND COALESCE(e.metadata_json->>'preserve', '') <> 'true'
           AND COALESCE(e.data_json->>'golden', '') <> 'true'
           AND COALESCE(e.data_json->>'audit', '') <> 'true'
           AND COALESCE(e.data_json->>'verified', '') <> 'true'
           AND COALESCE(e.data_json->>'preserve', '') <> 'true'
         LIMIT $4
       )`,
      [cutoffIso, types, PROTECTED_EVENT_TYPES, safeBatch]
    );
    const n = r?.rowCount || 0;
    deleted += n;
    batchesRun++;
    if (n < safeBatch) break;
    if (safeSleep > 0 && i + 1 < safeMaxBatches) {
      await pool.query('SELECT pg_sleep($1)', [safeSleep]).catch(() => {});
    }
  }

  console.log(`[${tag}] 만료 노이즈 텔레메트리 정리 완료: deleted=${deleted} batches=${batchesRun} cutoff=${cutoffIso}`);
  return { skipped: false, mode: 'noise_retention', deleted, batchesRun, cutoffIso, batchSize: safeBatch };
}

// ══════════════════════════════════════════════════════════════════════════════
// 메인: 크기 체크 후 아카이브 실행
// ══════════════════════════════════════════════════════════════════════════════
let _running = false;

async function checkAndArchive(pool, opts = {}) {
  if (_running) {
    console.log('[archiver] 이미 실행 중 — 스킵');
    return null;
  }
  _running = true;
  const startMs = Date.now();

  try {
    await _ensureArchiveTable(pool);

    const stats = await getTableStats(pool);
    console.log(`[archiver] events 테이블: ${stats.rows.toLocaleString()}행 (${stats.sizePretty})`);

    const sizeMB = Math.round(stats.sizeBytes / 1024 / 1024);
    const driveReady = isDriveArchiveConfigured();
    const policy = resolveRetentionPolicy({ sizeMB, driveConfigured: driveReady });
    if (stats.rows < THRESHOLD && sizeMB < policy.pgThresholdMB) {
      console.log(`[archiver] 임계값 미만 — 스킵 (현재: ${stats.rows}행, ${sizeMB}MB)`);
      return { skipped: true, rows: stats.rows, sizeMB, threshold: THRESHOLD, policyMode: policy.mode };
    }
    if (sizeMB >= policy.pgThresholdMB) {
      console.log(`[archiver] DB ${sizeMB}MB — 용량 임계값(${policy.pgThresholdMB}MB) 초과! 강제 아카이브/정리 (${policy.mode})`);
    }

    console.log(`[archiver] 임계값 초과! 아카이브 시작 (KEEP_DAYS=${KEEP_DAYS}일, mode=${policy.mode})`);

    const cutoffDate = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoffDate.toISOString();

    const results = [];
    let totalArchived = 0;
    let noisePrunedRows = 0;

    if (policy.driveConfigured) {
      // Drive 구성 시 기존대로 사용자별 Drive 아카이브 → 삭제
      const { rows: userRows } = await pool.query(
        `SELECT DISTINCT user_id FROM events WHERE ${buildSafeCutoffClause('timestamp', '$1', { isTextColumn: true })} AND user_id IS NOT NULL`,
        [cutoffIso]
      );
      const userIds = userRows.map(r => r.user_id).filter(Boolean);
      console.log(`[archiver] 아카이브 대상: ${userIds.length}명 (${cutoffIso} 이전)`);

      for (const uid of userIds) {
        try {
          const result = await _archiveUser(pool, uid, cutoffDate, { sizeMB, allowNoiseRetention: policy.allowNoiseRetention });
          if (!result.skipped) {
            results.push(result);
            totalArchived += result.rowCount || 0;
            console.log(`[archiver] ${uid}: ${result.rowCount}행 삭제 → Drive: ${result.driveFileId || '없음'}`);
          }
        } catch (e) {
          console.error(`[archiver] ${uid} 아카이브 실패:`, e.message);
        }
      }
    }

    // Drive 미구성이거나 Drive 아카이브 0건이고 정책상 노이즈 정리가 허용된 경우 비잠금 배치 정리 실행
    const fallbackPolicy = resolveRetentionPolicy({
      sizeMB,
      driveConfigured: policy.driveConfigured,
      driveBackupFailed: policy.driveConfigured && totalArchived === 0,
      verifiedBatches: totalArchived === 0 ? 0 : null,
    });
    if ((!policy.driveConfigured || totalArchived === 0) && (policy.allowNoiseRetention || fallbackPolicy.allowNoiseRetention)) {
      const pruneRes = await pruneExpiredNoiseEvents(pool, cutoffIso, {
        batchSize: opts.batchSize || BATCH_SIZE,
        maxBatches: opts.maxBatches || 20,
        sleepSeconds: opts.sleepSeconds !== undefined ? opts.sleepSeconds : 0.1,
        tag: 'archiver',
      });
      noisePrunedRows = pruneRes.deleted || 0;
      totalArchived += noisePrunedRows;
    }

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const afterStats = await getTableStats(pool);

    console.log(`[archiver] 완료: ${totalArchived}행 정리(noise=${noisePrunedRows}), ${elapsed}초 소요`);
    console.log(`[archiver] 테이블 크기: ${stats.rows}행 → ${afterStats.rows}행 (${stats.sizePretty} → ${afterStats.sizePretty})`);

    return {
      triggered:      true,
      policyMode:     policy.mode,
      beforeRows:     stats.rows,
      afterRows:      afterStats.rows,
      archivedRows:   totalArchived,
      noisePrunedRows,
      users:          results.length,
      cutoffDate:     cutoffIso,
      elapsedSeconds: elapsed,
      results,
    };
  } catch (e) {
    console.error('[archiver] 오류:', e.message);
    throw e;
  } finally {
    _running = false;
  }
}

/**
 * 백스톱/정기 정리용 안전 삭제 헬퍼.
 * 1) archive_log 에 drive_file IS NOT NULL(실제 Google Drive 업로드 검증) 기록이 있으면
 *    안전한 TEXT→TIMESTAMPTZ 비교로 검증 구간 events 만 배치 삭제한다.
 * 2) Drive 백업 기록이 0건이거나 미설정인 경우:
 *    - 명시적 보존 정책(ARCHIVE_REQUIRE_DRIVE_BACKUP=false 또는 PG 임계치 초과 + allowNoiseFallback=true)이
 *      허용되면 골든/감사/검증 레코드는 보존하면서 만료 노이즈 텔레메트리만 비잠금 배치(LIMIT 5000 + pg_sleep(0.1))로 정리한다.
 *    - 그 외 기본 호출에서는 기존 유실 방지 하드 가드 그대로 DELETE 를 차단한다.
 */
async function deleteVerifiedArchivedEvents(pool, cutoffIso, {
  batchSize = BATCH_SIZE,
  maxBatches = 50,
  pauseMs = 1000,
  sleepSeconds = 0.1,
  allowNoiseFallback = false,
  sizeMB = 0,
  tag = 'cleanup',
} = {}) {
  if (!pool?.query) return { skipped: true, reason: 'no_pool', deleted: 0, verifiedBatches: 0 };
  const safeCutoffIso = normalizeCutoffIso(cutoffIso);
  const policy = resolveRetentionPolicy({
    sizeMB,
    driveConfigured: isDriveArchiveConfigured(),
    verifiedBatches: 0,
  });
  const canNoiseFallback = allowNoiseFallback === true || policy.allowNoiseRetention;

  let verifiedBatches = 0;
  try {
    const check = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM archive_log WHERE drive_file IS NOT NULL AND TRIM(drive_file) <> ''`
    );
    verifiedBatches = Number(check.rows[0]?.cnt || 0);
  } catch (e) {
    if (canNoiseFallback) {
      console.warn(`[${tag}] archive_log 조회 불가(${e.message}) — 보존정책(${policy.mode})에 따라 만료 노이즈 텔레메트리만 배치 정리`);
      const pruneRes = await pruneExpiredNoiseEvents(pool, safeCutoffIso, {
        batchSize: Math.min(batchSize, BATCH_SIZE),
        maxBatches,
        sleepSeconds,
        tag,
      });
      return {
        skipped: false,
        mode: 'noise_retention_fallback',
        policyMode: policy.mode,
        deleted: pruneRes.deleted,
        batchesRun: pruneRes.batchesRun,
        verifiedBatches: 0,
        cutoffIso: safeCutoffIso,
      };
    }
    console.warn(`[${tag}] archive_log 검증 조회 실패(${e.message}) — events 원본 DELETE 차단`);
    return { skipped: true, reason: 'archive_log_unavailable', deleted: 0, verifiedBatches: 0 };
  }

  if (verifiedBatches <= 0) {
    if (canNoiseFallback) {
      console.warn(`[${tag}] archive_log 검증 백업 0건 — 보존정책(${policy.mode})에 따라 만료 노이즈 텔레메트리만 비잠금 배치 정리`);
      const pruneRes = await pruneExpiredNoiseEvents(pool, safeCutoffIso, {
        batchSize: Math.min(batchSize, BATCH_SIZE),
        maxBatches,
        sleepSeconds,
        tag,
      });
      return {
        skipped: false,
        mode: 'noise_retention_fallback',
        policyMode: policy.mode,
        deleted: pruneRes.deleted,
        batchesRun: pruneRes.batchesRun,
        verifiedBatches: 0,
        cutoffIso: safeCutoffIso,
      };
    }
    console.warn(`[${tag}] archive_log에 drive_file IS NOT NULL 백업 기록 0건 — events 원본 DELETE 차단 (유실 방지 하드 가드)`);
    return { skipped: true, reason: 'no_verified_drive_backup', deleted: 0, verifiedBatches: 0 };
  }

  let deleted = 0;
  const safeTsExpr = safeTextTimestampExpr('e.timestamp');
  for (let i = 0; i < maxBatches; i++) {
    const r = await pool.query(
      `DELETE FROM events
       WHERE id IN (
         SELECT e.id FROM events e
         WHERE ${buildSafeCutoffClause('e.timestamp', '$1', { isTextColumn: true })}
           AND EXISTS (
             SELECT 1 FROM archive_log al
             WHERE al.drive_file IS NOT NULL AND TRIM(al.drive_file) <> ''
               AND al.user_id = e.user_id
               AND ${safeTsExpr} >= al.from_date
               AND ${safeTsExpr} <= al.to_date
           )
         LIMIT $2
       )`,
      [safeCutoffIso, batchSize]
    );
    deleted += r.rowCount || 0;
    if ((r.rowCount || 0) < batchSize) break;
    if (pauseMs > 0) await new Promise((res) => setTimeout(res, pauseMs));
  }
  return { skipped: false, mode: 'verified_drive_archive', deleted, verifiedBatches, cutoffIso: safeCutoffIso };
}

module.exports = {
  checkAndArchive,
  getTableStats,
  deleteVerifiedArchivedEvents,
  pruneExpiredNoiseEvents,
  resolveRetentionPolicy,
  getArchiveParentFolderId,
  isDriveArchiveConfigured,
  buildSafeCutoffClause,
  safeTextTimestampExpr,
  normalizeCutoffIso,
  isProtectedEvent,
  _archiveUser,
  THRESHOLD,
  KEEP_DAYS,
  BATCH_SIZE,
  PG_DIET_THRESHOLD_MB,
  ISO_TS_REGEX,
  NOISE_TELEMETRY_TYPES,
  PROTECTED_EVENT_TYPES,
};
