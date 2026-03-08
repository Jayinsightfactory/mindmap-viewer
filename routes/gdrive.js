'use strict';
/**
 * routes/gdrive.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용자별 Google Drive 백업 / 복원 / 동기화 API
 *
 * 엔드포인트:
 *   POST /api/gdrive/backup       — 즉시 백업 실행
 *   GET  /api/gdrive/backups      — 백업 목록 조회
 *   GET  /api/gdrive/status       — Drive 연결 상태
 *   GET  /api/gdrive/sync-check   — 다른 PC 백업 확인 (F3용)
 *   POST /api/gdrive/import       — 백업 가져오기 (F3용)
 *   GET  /api/gdrive/auth-url     — OAuth2 인증 URL 반환 (웹 인증용)
 *   GET  /api/gdrive/auth-callback— OAuth2 콜백 처리 (웹 인증용)
 *   GET  /api/gdrive/auth-status  — GDrive 인증 상태 확인
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKENS_PATH = path.join(DATA_DIR, 'gdrive-tokens.json');
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function createGdriveRouter({ verifyToken, auth, dbModule, gdriveUserBackup }) {
  const router = express.Router();

  function getUserFromReq(req) {
    if (process.env.AUTH_DISABLED === '1') return { id: 'local' };
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || req.query.token;
    return verifyToken ? verifyToken(token) : null;
  }

  // POST /api/gdrive/backup — 즉시 백업
  router.post('/gdrive/backup', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.status(400).json({ error: 'Google Drive 연결이 필요합니다. Google로 다시 로그인해주세요.' });

      const result = await gdriveUserBackup.backupUserDataToDrive(user.id, accessToken, dbModule);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[gdrive/backup]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/gdrive/backups — 백업 목록
  router.get('/gdrive/backups', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.json({ backups: [], connected: false });

      const backups = await gdriveUserBackup.listBackups(accessToken);
      res.json({ ok: true, backups, connected: true });
    } catch (e) {
      res.json({ ok: false, backups: [], error: e.message });
    }
  });

  // GET /api/gdrive/status — Drive 연결 상태
  router.get('/gdrive/status', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.json({ connected: false });

      const tokens = auth.getOAuthTokens(user.id);
      if (!tokens?.refreshToken) return res.json({ connected: false });

      const accessToken = await auth.getValidGoogleToken(user.id);
      res.json({
        connected: !!accessToken,
        hasRefreshToken: !!tokens.refreshToken,
        provider: 'google',
      });
    } catch (e) {
      res.json({ connected: false, error: e.message });
    }
  });

  // GET /api/gdrive/sync-check — 다른 PC 백업 확인 (F3)
  router.get('/gdrive/sync-check', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.json({ hasBackup: false });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.json({ hasBackup: false });

      const backups = await gdriveUserBackup.listBackups(accessToken);
      if (backups.length === 0) return res.json({ hasBackup: false });

      const currentPcId = gdriveUserBackup.getPcId();
      const latest = backups[0];
      const samePC = latest.pcId === currentPcId;

      res.json({
        hasBackup: true,
        samePC,
        currentPcId,
        latestBackup: {
          fileId: latest.fileId,
          fileName: latest.fileName,
          pcId: latest.pcId,
          createdAt: latest.createdAt,
          size: latest.size,
        },
        backupCount: backups.length,
      });
    } catch (e) {
      res.json({ hasBackup: false, error: e.message });
    }
  });

  // POST /api/gdrive/import — 백업 가져오기 (F3)
  router.post('/gdrive/import', async (req, res) => {
    try {
      const user = getUserFromReq(req);
      if (!user || user.id === 'local') return res.status(401).json({ error: 'login required' });

      const { fileId } = req.body;
      if (!fileId) return res.status(400).json({ error: 'fileId required' });

      const accessToken = await auth.getValidGoogleToken(user.id);
      if (!accessToken) return res.status(400).json({ error: 'Google Drive 연결 필요' });

      const backupData = await gdriveUserBackup.downloadBackup(fileId, accessToken);
      const result = gdriveUserBackup.importBackupData(backupData, user.id, dbModule);

      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[gdrive/import]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── OAuth2 웹 인증 엔드포인트 ─────────────────────────────────────────────

  // GET /api/gdrive/auth-url — OAuth2 인증 URL 반환
  router.get('/gdrive/auth-url', (req, res) => {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return res.status(500).json({
          ok: false,
          error: 'GOOGLE_CLIENT_ID 환경변수가 설정되지 않았습니다.',
        });
      }

      // 웹 콜백용 redirect_uri 결정
      const host = req.get('host') || 'localhost:3000';
      const protocol = req.protocol || 'http';
      const redirectUri = `${protocol}://${host}/api/gdrive/auth-callback`;

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: OAUTH_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
      });

      const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;
      res.json({ ok: true, authUrl, redirectUri });
    } catch (e) {
      console.error('[gdrive/auth-url]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/gdrive/auth-callback — OAuth2 콜백 처리 (브라우저에서 리다이렉트됨)
  router.get('/gdrive/auth-callback', async (req, res) => {
    try {
      const { code, error: authError } = req.query;

      if (authError) {
        return res.status(400).send(
          `<html><body><h1>인증 실패</h1><p>${authError}</p></body></html>`
        );
      }

      if (!code) {
        return res.status(400).send(
          '<html><body><h1>인증 실패</h1><p>인증 코드가 없습니다.</p></body></html>'
        );
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return res.status(500).send(
          '<html><body><h1>서버 오류</h1><p>GOOGLE_CLIENT_ID 또는 GOOGLE_CLIENT_SECRET이 설정되지 않았습니다.</p></body></html>'
        );
      }

      // redirect_uri는 auth-url에서 사용한 것과 동일해야 함
      const host = req.get('host') || 'localhost:3000';
      const protocol = req.protocol || 'http';
      const redirectUri = `${protocol}://${host}/api/gdrive/auth-callback`;

      // authorization code → 토큰 교환
      const params = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (!tokenResponse.ok) {
        const errText = await tokenResponse.text();
        console.error('[gdrive/auth-callback] 토큰 교환 실패:', tokenResponse.status, errText);
        return res.status(500).send(
          `<html><body><h1>토큰 교환 실패</h1><p>${tokenResponse.status}</p></body></html>`
        );
      }

      const tokens = await tokenResponse.json();

      // 토큰 저장
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || 'Bearer',
        expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
        scope: tokens.scope || OAUTH_SCOPES.join(' '),
        saved_at: new Date().toISOString(),
      };
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));
      console.log('[gdrive/auth-callback] OAuth2 토큰 저장 완료');

      // 성공 페이지 응답
      res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>Google Drive 인증 완료</title>
  <style>
    body { font-family: -apple-system, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f0f4f8; }
    .card { background: white; border-radius: 16px; padding: 48px; text-align: center;
            box-shadow: 0 4px 24px rgba(0,0,0,0.1); max-width: 440px; }
    h1 { color: #1a73e8; margin: 0 0 12px; }
    p { color: #555; line-height: 1.6; }
    .btn { display: inline-block; margin-top: 16px; padding: 10px 24px;
           background: #1a73e8; color: white; border-radius: 8px;
           text-decoration: none; font-size: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Google Drive 인증 완료!</h1>
    <p>Google Drive 연결이 완료되었습니다.<br>이제 백업 기능을 사용할 수 있습니다.</p>
    <a class="btn" href="/">메인으로 돌아가기</a>
  </div>
</body>
</html>`);
    } catch (e) {
      console.error('[gdrive/auth-callback]', e.message);
      res.status(500).send(
        `<html><body><h1>오류 발생</h1><p>${e.message}</p></body></html>`
      );
    }
  });

  // GET /api/gdrive/auth-status — GDrive 인증 상태 확인
  router.get('/gdrive/auth-status', async (req, res) => {
    try {
      // OAuth2 토큰 파일 확인
      let hasOAuthTokens = false;
      let oauthValid = false;
      let oauthExpiry = null;

      if (fs.existsSync(TOKENS_PATH)) {
        try {
          const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
          hasOAuthTokens = true;
          oauthExpiry = tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null;

          // 만료 여부 확인 (5분 여유)
          const isExpired = tokens.expiry_date && Date.now() > tokens.expiry_date - 5 * 60 * 1000;
          if (!isExpired && tokens.access_token) {
            oauthValid = true;
          } else if (tokens.refresh_token) {
            // refresh_token이 있으면 갱신 가능
            oauthValid = true; // 갱신 가능한 상태
          }
        } catch {}
      }

      // Service Account 확인
      const credentialsPath = process.env.GDRIVE_CREDENTIALS_PATH || '';
      const hasServiceAccount = !!(credentialsPath && fs.existsSync(credentialsPath));

      // API Key 확인
      const hasApiKey = !!process.env.GDRIVE_API_KEY;

      // 인증 방법 결정
      let authMethod = null;
      if (hasOAuthTokens && oauthValid) authMethod = 'oauth2';
      else if (hasServiceAccount) authMethod = 'service_account';
      else if (hasApiKey) authMethod = 'api_key';

      res.json({
        ok: true,
        authenticated: !!authMethod,
        authMethod,
        oauth2: {
          hasTokens: hasOAuthTokens,
          valid: oauthValid,
          expiryDate: oauthExpiry,
        },
        serviceAccount: {
          configured: hasServiceAccount,
        },
        apiKey: {
          configured: hasApiKey,
        },
      });
    } catch (e) {
      console.error('[gdrive/auth-status]', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
}

module.exports = createGdriveRouter;
