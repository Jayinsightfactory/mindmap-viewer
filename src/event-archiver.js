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
 *   GOOGLE_DRIVE_CAPTURES_FOLDER_ID — 캡처 폴더 ID (아카이브 폴더의 부모)
 *   ARCHIVE_THRESHOLD — 행 수 임계값 (기본 50000)
 *   ARCHIVE_KEEP_DAYS — 보존 기간(일) (기본 30)
 */

const https  = require('https');
const crypto = require('crypto');

const THRESHOLD  = parseInt(process.env.ARCHIVE_THRESHOLD)  || 50000; // 5만건 초과 시 아카이브
const KEEP_DAYS  = parseInt(process.env.ARCHIVE_KEEP_DAYS)  || 30;    // 최근 30일 유지
const BATCH_SIZE = 5000; // 한 번에 조회할 최대 행 수

// ══════════════════════════════════════════════════════════════════════════════
// Drive 인증 (서비스 계정 JWT)
// ══════════════════════════════════════════════════════════════════════════════
let _token = null;
let _tokenExpiry = 0;
let _archiveFolderId = null; // 캐시

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
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
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
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
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
  const search = await _get('www.googleapis.com', `/drive/v3/files?q=${q}&fields=files(id,name)`, token);
  if (search.files && search.files.length > 0) return search.files[0].id;

  // 없으면 생성
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const created = await _postWithAuth('www.googleapis.com', '/drive/v3/files', JSON.stringify(meta), 'application/json', token);
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
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
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
      path: '/upload/drive/v3/files?uploadType=multipart&fields=id,name',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': bodyBuf.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function _getArchiveFolder(monthKey) {
  const token = await _getToken();
  const parentId = process.env.GOOGLE_DRIVE_CAPTURES_FOLDER_ID || null;

  // orbit-archive 루트 폴더
  if (!_archiveFolderId) {
    _archiveFolderId = await _ensureFolder('orbit-archive', parentId, token);
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
async function _archiveUser(pool, userId, cutoffDate) {
  // 아카이브 대상 조회 (BATCH_SIZE 단위로 처리해 메모리 제한)
  const { rows } = await pool.query(
    `SELECT id, type, timestamp, data_json, session_id, source
     FROM events
     WHERE user_id = $1 AND timestamp < $2
     ORDER BY timestamp ASC
     LIMIT $3`,
    [userId, cutoffDate.toISOString(), BATCH_SIZE]
  );
  if (rows.length === 0) return { skipped: true };

  const summary = _summarizeEvents(rows);
  const monthKey = cutoffDate.toISOString().slice(0, 7); // YYYY-MM
  const filename = `${userId.replace(/[^a-zA-Z0-9]/g, '_')}-${Date.now()}.json`;

  const archivePayload = {
    userId,
    archivedAt: new Date().toISOString(),
    cutoffDate: cutoffDate.toISOString(),
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

  // Drive 업로드
  let driveFileId = null;
  const saEnabled = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (saEnabled) {
    try {
      const { token, monthFolderId } = await _getArchiveFolder(monthKey);
      const uploaded = await _uploadJson(archivePayload, filename, monthFolderId, token);
      driveFileId = uploaded?.id || null;
      console.log(`[archiver] Drive 업로드 완료: ${filename} (${uploaded?.id})`);
    } catch (e) {
      console.error(`[archiver] Drive 업로드 실패 (${userId}):`, e.message);
      // Drive 실패해도 DB 삭제는 진행 (이미 rows를 메모리에 로드했으므로)
    }
  }

  // DB 삭제
  const ids = rows.map(r => r.id);
  const { rowCount } = await pool.query(
    `DELETE FROM events WHERE id = ANY($1)`,
    [ids]
  );

  // 아카이브 로그 저장
  const fromDate = new Date(rows[0].timestamp);
  const toDate   = new Date(rows[rows.length - 1].timestamp);
  await pool.query(
    `INSERT INTO archive_log (user_id, from_date, to_date, row_count, drive_file, summary)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, fromDate, toDate, rowCount, driveFileId, JSON.stringify(summary)]
  );

  return { userId, rowCount, driveFileId, summary };
}

// ══════════════════════════════════════════════════════════════════════════════
// 메인: 크기 체크 후 아카이브 실행
// ══════════════════════════════════════════════════════════════════════════════
let _running = false;

async function checkAndArchive(pool) {
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

    if (stats.rows < THRESHOLD) {
      console.log(`[archiver] 임계값(${THRESHOLD.toLocaleString()}) 미만 — 아카이브 불필요`);
      return { skipped: true, rows: stats.rows, threshold: THRESHOLD };
    }

    console.log(`[archiver] 임계값 초과! 아카이브 시작 (KEEP_DAYS=${KEEP_DAYS}일)`);

    const cutoffDate = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);

    // 아카이브 대상 사용자 조회
    const { rows: userRows } = await pool.query(
      `SELECT DISTINCT user_id FROM events WHERE timestamp < $1 AND user_id IS NOT NULL`,
      [cutoffDate.toISOString()]
    );
    const userIds = userRows.map(r => r.user_id).filter(Boolean);
    console.log(`[archiver] 아카이브 대상: ${userIds.length}명 (${cutoffDate.toISOString()} 이전)`);

    const results = [];
    let totalArchived = 0;
    for (const uid of userIds) {
      try {
        const result = await _archiveUser(pool, uid, cutoffDate);
        if (!result.skipped) {
          results.push(result);
          totalArchived += result.rowCount || 0;
          console.log(`[archiver] ${uid}: ${result.rowCount}행 삭제 → Drive: ${result.driveFileId || '없음'}`);
        }
      } catch (e) {
        console.error(`[archiver] ${uid} 아카이브 실패:`, e.message);
      }
    }

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    const afterStats = await getTableStats(pool);

    console.log(`[archiver] 완료: ${totalArchived}행 아카이브, ${elapsed}초 소요`);
    console.log(`[archiver] 테이블 크기: ${stats.rows}행 → ${afterStats.rows}행 (${stats.sizePretty} → ${afterStats.sizePretty})`);

    return {
      triggered:      true,
      beforeRows:     stats.rows,
      afterRows:      afterStats.rows,
      archivedRows:   totalArchived,
      users:          results.length,
      cutoffDate:     cutoffDate.toISOString(),
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

module.exports = { checkAndArchive, getTableStats, THRESHOLD, KEEP_DAYS };
