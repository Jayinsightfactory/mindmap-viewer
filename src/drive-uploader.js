'use strict';
/**
 * drive-uploader.js — Google Drive 캡처 업로드
 *
 * 서비스 계정으로 "Orbit AI Captures" 공유 폴더에 스크린캡처 업로드.
 * 관리자만 접근 가능한 폴더 → 사용자는 캡처 원본 못 봄.
 *
 * 사용: daemon에서 캡처 후 upload() 호출
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const https = require('https');
const crypto = require('crypto');

let _credentials = null;  // { client_email, private_key }
let _folderId = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _enabled = false;
let _hostFolder = null;   // 호스트별 하위 폴더 ID

// ── 초기화 (서버에서 인증 정보 수신) ──────────────────────────────────────────
function init(config) {
  if (config.credentials) {
    _credentials = config.credentials;
  } else if (config.credentialsJson) {
    try { _credentials = JSON.parse(config.credentialsJson); } catch {}
  }
  _folderId = config.folderId || null;
  _enabled = !!(_credentials && _credentials.private_key && _folderId);
  if (_enabled) {
    console.log(`[drive-uploader] 활성화 — 폴더: ${_folderId}`);
  }
  return _enabled;
}

// ── JWT 생성 (서비스 계정 인증) ───────────────────────────────────────────────
function _createJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: _credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(_credentials.private_key, 'base64url');
  return `${unsigned}.${signature}`;
}

// ── 액세스 토큰 발급 ─────────────────────────────────────────────────────────
async function _getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiry) return _accessToken;

  const jwt = _createJwt();
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            _accessToken = parsed.access_token;
            _tokenExpiry = Date.now() + (parsed.expires_in - 60) * 1000;
            resolve(_accessToken);
          } else {
            reject(new Error(parsed.error_description || 'token failed'));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 호스트별 하위 폴더 생성/조회 ──────────────────────────────────────────────
async function _getHostFolder() {
  if (_hostFolder) return _hostFolder;

  const token = await _getAccessToken();
  const hostname = os.hostname();

  // 기존 폴더 검색
  const query = encodeURIComponent(`name='${hostname}' and '${_folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const searchResult = await _httpsGet(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`, token);
  const parsed = JSON.parse(searchResult);
  if (parsed.files && parsed.files.length > 0) {
    _hostFolder = parsed.files[0].id;
    return _hostFolder;
  }

  // 없으면 생성
  const metadata = JSON.stringify({
    name: hostname,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [_folderId],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.googleapis.com',
      path: '/drive/v3/files',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(metadata),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const f = JSON.parse(data);
          _hostFolder = f.id;
          console.log(`[drive-uploader] 호스트 폴더 생성: ${hostname} (${f.id})`);
          resolve(_hostFolder);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(metadata);
    req.end();
  });
}

function _httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── 파일 업로드 (multipart) ───────────────────────────────────────────────────
async function upload(filepath, metadata = {}) {
  if (!_enabled) return null;
  if (!fs.existsSync(filepath)) return null;

  try {
    const token = await _getAccessToken();
    const folderId = await _getHostFolder();
    const filename = path.basename(filepath);
    const fileContent = fs.readFileSync(filepath);

    const fileMeta = JSON.stringify({
      name: filename,
      parents: [folderId],
      description: JSON.stringify({
        trigger: metadata.trigger || '',
        app: metadata.app || '',
        windowTitle: metadata.windowTitle || '',
        activityLevel: metadata.activityLevel || '',
        hostname: os.hostname(),
        ts: new Date().toISOString(),
      }),
    });

    const boundary = '----OrbitUpload' + Date.now();
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
        `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
        fileMeta + `\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: image/png\r\n\r\n`
      ),
      fileContent,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files?uploadType=multipart&fields=id,name,size',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.id) {
              console.log(`[drive-uploader] 업로드 완료: ${filename} (${result.size} bytes)`);
              resolve(result);
            } else {
              console.warn(`[drive-uploader] 업로드 실패:`, data.slice(0, 200));
              resolve(null);
            }
          } catch (e) { resolve(null); }
        });
      });
      req.on('error', (e) => { console.warn(`[drive-uploader] 에러:`, e.message); resolve(null); });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.write(body);
      req.end();
    });
  } catch (e) {
    console.warn(`[drive-uploader] 업로드 에러:`, e.message);
    return null;
  }
}

// ── 배치 업로드 (미업로드 캡처 일괄) ─────────────────────────────────────────
async function uploadPending(captureDir) {
  if (!_enabled) return 0;
  const dir = captureDir || path.join(os.homedir(), '.orbit', 'captures');
  if (!fs.existsSync(dir)) return 0;

  const uploaded = path.join(dir, '.uploaded');
  let uploadedSet = new Set();
  try { uploadedSet = new Set(fs.readFileSync(uploaded, 'utf8').split('\n').filter(Boolean)); } catch {}

  const files = fs.readdirSync(dir).filter(f => f.startsWith('screen-') && f.endsWith('.png') && !uploadedSet.has(f));
  let count = 0;

  for (const f of files.slice(0, 20)) { // 한 번에 최대 20개
    const filepath = path.join(dir, f);
    // 파일명에서 메타데이터 추출: screen-{ts}-{trigger}-{activity}.png
    const parts = f.replace('.png', '').split('-');
    const trigger = parts[2] || '';
    const activity = parts[3] || '';

    const result = await upload(filepath, { trigger, activityLevel: activity });
    if (result) {
      uploadedSet.add(f);
      count++;
    }
  }

  // 업로드 기록 저장
  if (count > 0) {
    fs.writeFileSync(uploaded, [...uploadedSet].join('\n'), 'utf8');
    console.log(`[drive-uploader] ${count}개 캡처 업로드 완료`);
  }
  return count;
}

function isEnabled() { return _enabled; }

module.exports = { init, upload, uploadPending, isEnabled };
