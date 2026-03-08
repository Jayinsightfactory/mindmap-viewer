#!/usr/bin/env node
'use strict';
/**
 * cli/gdrive-auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Google Drive OAuth2 CLI 인증 도구
 *
 * 사용법:
 *   node cli/gdrive-auth.js
 *
 * 환경변수:
 *   GOOGLE_CLIENT_ID     — Google OAuth2 클라이언트 ID
 *   GOOGLE_CLIENT_SECRET — Google OAuth2 클라이언트 시크릿
 *
 * 동작:
 *   1. 로컬 HTTP 서버(port 3847)를 열어 OAuth 콜백을 수신
 *   2. Google OAuth2 인증 URL을 브라우저에서 자동으로 열기
 *   3. 사용자가 Google 계정으로 로그인 및 권한 승인
 *   4. 콜백에서 authorization code를 받아 토큰으로 교환
 *   5. data/gdrive-tokens.json에 토큰 저장
 *   6. 기존 토큰이 유효하면 인증 과정 건너뛰기
 * ─────────────────────────────────────────────────────────────────────────────
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { exec } = require('child_process');

// ── 경로 설정 ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_PATH = path.join(DATA_DIR, 'gdrive-tokens.json');

// ── OAuth2 설정 ──────────────────────────────────────────────────────────────

const PORT = 3847;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── 환경변수 확인 ────────────────────────────────────────────────────────────

function getCredentials() {
  // .env 파일 로드 시도
  try {
    require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  } catch {}

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('');
    console.error('  [오류] 환경변수가 설정되지 않았습니다.');
    console.error('');
    console.error('  다음 환경변수를 설정해주세요:');
    console.error('    GOOGLE_CLIENT_ID=your-client-id');
    console.error('    GOOGLE_CLIENT_SECRET=your-client-secret');
    console.error('');
    console.error('  설정 방법:');
    console.error('    1. .env 파일에 추가');
    console.error('    2. 또는 터미널에서 export로 설정');
    console.error('');
    console.error('  Google Cloud Console에서 OAuth2 클라이언트를 생성하세요:');
    console.error('    https://console.cloud.google.com/apis/credentials');
    console.error('');
    process.exit(1);
  }

  return { clientId, clientSecret };
}

// ── 토큰 파일 관리 ───────────────────────────────────────────────────────────

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('  [경고] 토큰 파일 읽기 실패:', e.message);
  }
  return null;
}

function saveTokens(tokens) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tokenData = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || 'Bearer',
    expiry_date: tokens.expiry_date || (Date.now() + (tokens.expires_in || 3600) * 1000),
    scope: tokens.scope || SCOPES.join(' '),
    saved_at: new Date().toISOString(),
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
  return tokenData;
}

// ── 토큰 유효성 확인 ─────────────────────────────────────────────────────────

async function isTokenValid(tokens) {
  if (!tokens || !tokens.access_token) return false;

  // 만료 시간 체크 (5분 여유)
  if (tokens.expiry_date && Date.now() > tokens.expiry_date - 5 * 60 * 1000) {
    return false;
  }

  // Google tokeninfo API로 실제 유효성 확인
  try {
    const response = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`,
      { signal: AbortSignal.timeout(5000) }
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ── 토큰 갱신 ────────────────────────────────────────────────────────────────

async function refreshToken(tokens, clientId, clientSecret) {
  if (!tokens || !tokens.refresh_token) {
    return null;
  }

  console.log('  [정보] 토큰을 갱신하는 중...');

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
      throw new Error(`토큰 갱신 실패: ${response.status} ${errText}`);
    }

    const data = await response.json();
    // refresh_token은 응답에 포함되지 않을 수 있으므로 기존 값 유지
    const newTokens = {
      ...data,
      refresh_token: data.refresh_token || tokens.refresh_token,
    };
    const saved = saveTokens(newTokens);
    console.log('  [성공] 토큰이 갱신되었습니다.');
    return saved;
  } catch (e) {
    console.error('  [오류] 토큰 갱신 실패:', e.message);
    return null;
  }
}

// ── OAuth2 인증 URL 생성 ─────────────────────────────────────────────────────

function buildAuthUrl(clientId) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

// ── 브라우저 열기 (OS별) ─────────────────────────────────────────────────────

function openBrowser(url) {
  const platform = process.platform;
  let command;

  if (platform === 'darwin') {
    command = `open "${url}"`;
  } else if (platform === 'win32') {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      console.error('  [경고] 브라우저를 자동으로 열지 못했습니다.');
      console.log('  아래 URL을 직접 브라우저에 붙여넣어 주세요:');
      console.log(`  ${url}`);
    }
  });
}

// ── Authorization code를 토큰으로 교환 ───────────────────────────────────────

async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const params = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`토큰 교환 실패: ${response.status} ${errText}`);
  }

  return response.json();
}

// ── 콜백 HTML 응답 ───────────────────────────────────────────────────────────

function getSuccessHtml() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Google Drive 인증 완료</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f0f4f8; }
    .card { background: white; border-radius: 16px; padding: 48px; text-align: center;
            box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 440px; }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { color: #1a73e8; margin: 0 0 12px; }
    p { color: #555; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10004;</div>
    <h1>인증 완료!</h1>
    <p>Google Drive 연결이 완료되었습니다.<br>이 창을 닫고 터미널로 돌아가세요.</p>
  </div>
</body>
</html>`;
}

function getErrorHtml(message) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Google Drive 인증 실패</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #fef2f2; }
    .card { background: white; border-radius: 16px; padding: 48px; text-align: center;
            box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 440px; }
    .icon { font-size: 64px; margin-bottom: 16px; }
    h1 { color: #dc2626; margin: 0 0 12px; }
    p { color: #555; line-height: 1.6; }
    code { background: #f5f5f5; padding: 4px 8px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">&#10060;</div>
    <h1>인증 실패</h1>
    <p>${message}</p>
    <p>터미널에서 다시 시도해주세요.</p>
  </div>
</body>
</html>`;
}

// ── 메인 실행 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  Google Drive OAuth2 인증 도구              │');
  console.log('  │  Orbit AI — mindmap-viewer                  │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');

  const { clientId, clientSecret } = getCredentials();

  // ── 기존 토큰 확인 ──────────────────────────────────────────────────────
  const existingTokens = loadTokens();
  if (existingTokens) {
    console.log('  [정보] 기존 토큰 파일을 발견했습니다.');

    // 아직 유효한지 확인
    const valid = await isTokenValid(existingTokens);
    if (valid) {
      console.log('  [성공] 토큰이 유효합니다. 인증이 이미 완료되어 있습니다.');
      console.log(`  토큰 위치: ${TOKENS_PATH}`);
      console.log('');
      process.exit(0);
    }

    // 만료되었으면 갱신 시도
    console.log('  [정보] 토큰이 만료되었습니다. 갱신을 시도합니다...');
    const refreshed = await refreshToken(existingTokens, clientId, clientSecret);
    if (refreshed) {
      console.log(`  토큰 위치: ${TOKENS_PATH}`);
      console.log('');
      process.exit(0);
    }
    console.log('  [정보] 갱신 실패. 새로 인증을 진행합니다.');
  }

  // ── 새 인증 흐름 ────────────────────────────────────────────────────────
  console.log('  [1단계] 로컬 서버를 시작합니다 (port: ' + PORT + ')...');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        console.error(`  [오류] 인증 거부됨: ${error}`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getErrorHtml(`인증이 거부되었습니다: ${error}`));
        server.close();
        reject(new Error(error));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getErrorHtml('인증 코드가 없습니다.'));
        return;
      }

      try {
        console.log('  [3단계] 인증 코드를 토큰으로 교환하는 중...');
        const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);
        const saved = saveTokens(tokens);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getSuccessHtml());

        console.log('');
        console.log('  ┌─────────────────────────────────────────────┐');
        console.log('  │  인증 완료!                                 │');
        console.log('  └─────────────────────────────────────────────┘');
        console.log('');
        console.log(`  토큰 저장 위치: ${TOKENS_PATH}`);
        console.log(`  만료 시간: ${new Date(saved.expiry_date).toLocaleString('ko-KR')}`);
        console.log('');
        console.log('  이제 Google Drive 백업 기능을 사용할 수 있습니다.');
        console.log('');

        // 서버 종료 (약간의 지연)
        setTimeout(() => {
          server.close();
          resolve(saved);
        }, 1000);
      } catch (e) {
        console.error('  [오류] 토큰 교환 실패:', e.message);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getErrorHtml(`토큰 교환 실패: ${e.message}`));
        server.close();
        reject(e);
      }
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`  [오류] 포트 ${PORT}이 이미 사용 중입니다.`);
        console.error('  다른 gdrive-auth 프로세스가 실행 중인지 확인해주세요.');
      } else {
        console.error('  [오류] 서버 시작 실패:', err.message);
      }
      reject(err);
    });

    server.listen(PORT, () => {
      const authUrl = buildAuthUrl(clientId);

      console.log('  [2단계] 브라우저에서 Google 로그인을 진행해주세요.');
      console.log('');
      console.log('  브라우저가 자동으로 열립니다...');
      console.log('');
      console.log('  만약 브라우저가 열리지 않으면, 아래 URL을 직접 열어주세요:');
      console.log(`  ${authUrl}`);
      console.log('');
      console.log('  대기 중... (Ctrl+C로 취소)');

      openBrowser(authUrl);

      // 5분 타임아웃
      setTimeout(() => {
        console.error('');
        console.error('  [타임아웃] 5분 내에 인증이 완료되지 않았습니다.');
        console.error('  다시 시도해주세요: npm run gdrive-auth');
        server.close();
        process.exit(1);
      }, 5 * 60 * 1000);
    });
  });
}

// ── 실행 ─────────────────────────────────────────────────────────────────────

main().catch((e) => {
  console.error('  [오류]', e.message);
  process.exit(1);
});
