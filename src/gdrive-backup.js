'use strict';
/**
 * src/gdrive-backup.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Drive 자동 백업 — 회사 데이터베이스 + 분석 결과 백업
 *
 * 사용법:
 *   1. Google Cloud Console에서 Service Account 생성
 *   2. Google Drive 폴더에 Service Account 이메일 공유
 *   3. 환경변수 설정:
 *      GDRIVE_CREDENTIALS_PATH=./data/gdrive-credentials.json
 *      GDRIVE_FOLDER_ID=1abc... (구글드라이브 폴더 ID)
 *
 * 또는 간단하게:
 *   GDRIVE_API_KEY로 직접 업로드 (REST API 방식)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const { ulid } = require('ulid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_PATH = path.join(DATA_DIR, 'gdrive-tokens.json');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── 백업 설정 ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled: false,
  intervalHours: 6,           // 6시간마다 백업
  folderId: '',               // Google Drive 폴더 ID
  credentialsPath: '',        // Service Account JSON 경로
  maxBackups: 30,             // 최대 보관 수
  includeDb: true,            // SQLite DB 포함
  includeReports: true,       // 진단 리포트 포함
  includeInsights: true,      // 인사이트 데이터 포함
};

let _config = { ...DEFAULT_CONFIG };
let _timer = null;

// ── 설정 로드/저장 ──────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const configPath = path.join(DATA_DIR, 'gdrive-config.json');
    if (fs.existsSync(configPath)) {
      _config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    }
  } catch {}
  // 환경변수 오버라이드
  if (process.env.GDRIVE_FOLDER_ID) _config.folderId = process.env.GDRIVE_FOLDER_ID;
  if (process.env.GDRIVE_CREDENTIALS_PATH) _config.credentialsPath = process.env.GDRIVE_CREDENTIALS_PATH;
  if (process.env.GDRIVE_ENABLED === '1') _config.enabled = true;
  return _config;
}

function saveConfig(config) {
  _config = { ...DEFAULT_CONFIG, ..._config, ...config };
  fs.writeFileSync(path.join(DATA_DIR, 'gdrive-config.json'), JSON.stringify(_config, null, 2));
}

// ── DB 백업 생성 ─────────────────────────────────────────────────────────────

function createDbBackup(db) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = path.join(backupDir, `orbit-backup-${timestamp}.db`);

  // SQLite backup API
  try {
    db.backup(backupPath);
    console.log(`[gdrive-backup] DB 백업 생성: ${backupPath}`);
    return backupPath;
  } catch (e) {
    // backup API 없으면 파일 복사
    const srcPath = path.join(DATA_DIR, 'mindmap.db');
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, backupPath);
      console.log(`[gdrive-backup] DB 복사 백업: ${backupPath}`);
      return backupPath;
    }
    console.error('[gdrive-backup] DB 백업 실패:', e.message);
    return null;
  }
}

// ── 분석 리포트 JSON 생성 ────────────────────────────────────────────────────

function createAnalysisExport(db) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const exportPath = path.join(DATA_DIR, 'backups', `orbit-analysis-${timestamp}.json`);

  try {
    const ontology = require('./company-ontology');
    ontology.ensureCompanyTables(db);

    const companies = ontology.listCompanies(db, { limit: 100 });
    const allData = {};

    for (const company of companies) {
      const companyData = {
        company,
        departments: ontology.listDepartments(db, company.id),
        employees: ontology.listEmployees(db, company.id).map(e => ({
          ...e, tracker_token: '***' // 토큰 마스킹
        })),
        processes: ontology.listProcesses(db, company.id),
        systems: ontology.listSystems(db, company.id),
      };

      // 최근 진단
      try {
        const diag = db.prepare(
          'SELECT * FROM diagnoses WHERE company_id = ? ORDER BY diagnosed_at DESC LIMIT 1'
        ).get(company.id);
        if (diag) companyData.latestDiagnosis = diag;
      } catch {}

      // 활동 통계 (최근 7일)
      try {
        const stats = ontology.getActivityStats(db, company.id,
          new Date(Date.now() - 7 * 86400_000).toISOString());
        companyData.weeklyStats = stats;
      } catch {}

      allData[company.id] = companyData;
    }

    const exportData = {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      companyCount: companies.length,
      data: allData,
    };

    fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
    console.log(`[gdrive-backup] 분석 데이터 내보내기: ${exportPath}`);
    return exportPath;
  } catch (e) {
    console.error('[gdrive-backup] 분석 내보내기 실패:', e.message);
    return null;
  }
}

// ── Google Drive 업로드 (REST API) ──────────────────────────────────────────

async function uploadToGDrive(filePath, folderId, accessToken) {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const fileName = path.basename(filePath);
  const fileSize = fs.statSync(filePath).size;

  try {
    // Multipart upload
    const boundary = '-------' + Date.now();
    const metadata = JSON.stringify({
      name: fileName,
      parents: folderId ? [folderId] : [],
    });

    const fileContent = fs.readFileSync(filePath);

    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
      body,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upload failed: ${response.status} ${errText}`);
    }

    const result = await response.json();
    console.log(`[gdrive-backup] 업로드 완료: ${fileName} → ${result.id}`);
    return { fileId: result.id, fileName, fileSize };
  } catch (e) {
    console.error(`[gdrive-backup] 업로드 실패: ${fileName}:`, e.message);
    return null;
  }
}

// ── OAuth2 토큰 파일 인증 ────────────────────────────────────────────────────

/**
 * data/gdrive-tokens.json에서 OAuth2 토큰을 로드
 */
function loadOAuthTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[gdrive-backup] OAuth2 토큰 파일 로드 실패:', e.message);
  }
  return null;
}

/**
 * OAuth2 토큰 파일 저장
 */
function saveOAuthTokens(tokens) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tokenData = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || 'Bearer',
    expiry_date: tokens.expiry_date || (Date.now() + (tokens.expires_in || 3600) * 1000),
    scope: tokens.scope || 'https://www.googleapis.com/auth/drive.file',
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
  return tokenData;
}

/**
 * 토큰이 만료되었으면 자동으로 갱신
 * @returns {string|null} 유효한 access_token 또는 null
 */
async function refreshTokenIfNeeded() {
  const tokens = loadOAuthTokens();
  if (!tokens) return null;

  // 만료 시간 체크 (5분 여유)
  const isExpired = tokens.expiry_date && Date.now() > tokens.expiry_date - 5 * 60 * 1000;

  if (!isExpired && tokens.access_token) {
    return tokens.access_token;
  }

  // 만료됨 — refresh_token으로 갱신 시도
  if (!tokens.refresh_token) {
    console.warn('[gdrive-backup] refresh_token 없음 — 재인증 필요 (npm run gdrive-auth)');
    return null;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn('[gdrive-backup] GOOGLE_CLIENT_ID/SECRET 미설정 — 토큰 갱신 불가');
    return null;
  }

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    });

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[gdrive-backup] 토큰 갱신 실패:', response.status, errText);
      return null;
    }

    const data = await response.json();
    const newTokens = {
      ...data,
      refresh_token: data.refresh_token || tokens.refresh_token,
    };
    saveOAuthTokens(newTokens);
    console.log('[gdrive-backup] OAuth2 토큰 갱신 완료');
    return newTokens.access_token;
  } catch (e) {
    console.error('[gdrive-backup] 토큰 갱신 오류:', e.message);
    return null;
  }
}

/**
 * 인증 헤더를 반환
 * 우선순위: OAuth2 토큰 파일 > Service Account > API Key
 * @returns {{ Authorization: string }|null}
 */
async function getAuthHeaders() {
  // 1순위: OAuth2 토큰 파일 (data/gdrive-tokens.json)
  const oauthToken = await refreshTokenIfNeeded();
  if (oauthToken) {
    return { Authorization: `Bearer ${oauthToken}` };
  }

  // 2순위: Service Account
  if (_config.credentialsPath && fs.existsSync(_config.credentialsPath)) {
    const saToken = await getServiceAccountToken(_config.credentialsPath);
    if (saToken) {
      return { Authorization: `Bearer ${saToken}` };
    }
  }

  // 3순위: API Key (제한적 — 일부 API만 가능)
  if (process.env.GDRIVE_API_KEY) {
    // API Key는 Authorization 헤더가 아닌 쿼리 파라미터로 사용하므로
    // 여기서는 null 반환하고, 호출 측에서 별도 처리
    console.warn('[gdrive-backup] API Key 방식은 업로드에 제한이 있습니다.');
    return null;
  }

  console.warn('[gdrive-backup] 인증 수단 없음 — npm run gdrive-auth 로 인증해주세요.');
  return null;
}

// ── Service Account 인증 ────────────────────────────────────────────────────

async function getServiceAccountToken(credentialsPath) {
  try {
    const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

    // JWT 생성 (간단한 구현 — jose 라이브러리 없이)
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/drive.file',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })).toString('base64url');

    // RS256 서명
    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(creds.private_key, 'base64url');

    const jwt = `${header}.${payload}.${signature}`;

    // 토큰 교환
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    const data = await response.json();
    return data.access_token;
  } catch (e) {
    console.error('[gdrive-backup] 인증 실패:', e.message);
    return null;
  }
}

// ── 전체 백업 실행 ──────────────────────────────────────────────────────────

async function runBackup(db) {
  loadConfig();
  if (!_config.folderId) {
    console.warn('[gdrive-backup] GDRIVE_FOLDER_ID 미설정 — 로컬 백업만 수행');
  }

  const results = { local: [], gdrive: [], errors: [] };

  // 1. 로컬 백업 생성
  if (_config.includeDb) {
    const dbPath = createDbBackup(db);
    if (dbPath) results.local.push(dbPath);
  }

  const analysisPath = createAnalysisExport(db);
  if (analysisPath) results.local.push(analysisPath);

  // 2. Google Drive 업로드 (설정된 경우)
  if (_config.folderId) {
    try {
      // 새 인증 우선순위: OAuth2 토큰 > Service Account > API Key
      const headers = await getAuthHeaders();
      const token = headers
        ? headers.Authorization.replace('Bearer ', '')
        : (_config.credentialsPath ? await getServiceAccountToken(_config.credentialsPath) : null);

      if (token) {
        for (const localPath of results.local) {
          const uploadResult = await uploadToGDrive(localPath, _config.folderId, token);
          if (uploadResult) {
            results.gdrive.push(uploadResult);

            // 백업 로그 기록
            try {
              db.prepare(`
                INSERT INTO gdrive_backup_log (id, file_name, file_size, gdrive_id, status)
                VALUES (?, ?, ?, ?, 'success')
              `).run(ulid(), uploadResult.fileName, uploadResult.fileSize, uploadResult.fileId);
            } catch {}
          }
        }
      } else {
        console.warn('[gdrive-backup] 인증 토큰 없음 — GDrive 업로드 건너뜀');
      }
    } catch (e) {
      results.errors.push(e.message);
    }
  }

  // 3. 오래된 로컬 백업 정리
  cleanOldBackups();

  console.log(`[gdrive-backup] 완료 — 로컬: ${results.local.length}, GDrive: ${results.gdrive.length}`);
  return results;
}

// ── 오래된 백업 정리 ────────────────────────────────────────────────────────

function cleanOldBackups() {
  const backupDir = path.join(DATA_DIR, 'backups');
  if (!fs.existsSync(backupDir)) return;

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('orbit-'))
    .map(f => ({ name: f, time: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);

  // 최대 보관 수 초과 시 삭제
  if (files.length > _config.maxBackups) {
    for (const f of files.slice(_config.maxBackups)) {
      try { fs.unlinkSync(path.join(backupDir, f.name)); } catch {}
    }
  }
}

// ── 스케줄러 ────────────────────────────────────────────────────────────────

function start(db) {
  loadConfig();
  if (!_config.enabled) {
    console.log('[gdrive-backup] 비활성화 상태 (GDRIVE_ENABLED=1 로 활성화)');
    return;
  }

  const intervalMs = (_config.intervalHours || 6) * 3600_000;
  console.log(`[gdrive-backup] 시작 — ${_config.intervalHours}시간 주기`);

  // 즉시 1회 + 주기 반복
  runBackup(db);
  _timer = setInterval(() => runBackup(db), intervalMs);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  loadConfig, saveConfig,
  createDbBackup, createAnalysisExport,
  uploadToGDrive, getServiceAccountToken,
  loadOAuthTokens, saveOAuthTokens,
  refreshTokenIfNeeded, getAuthHeaders,
  runBackup, cleanOldBackups,
  start, stop,
};
