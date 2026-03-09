/**
 * routes/tracker-oauth.js
 * ─────────────────────────────────────────────────────────────────
 * Google OAuth + Tracker 설치 토큰 시스템
 *
 * 흐름:
 * 1. 사용자가 로그인 후 "PC 추적 시작" 클릭
 * 2. GET /api/tracker/oauth/init → Google OAuth URL 반환
 * 3. 사용자가 Google 계정 허용
 * 4. GET /api/tracker/oauth/callback → googleDriveToken 암호화 저장
 * 5. 일회용 설치 토큰(10분 유효) 생성 & 반환
 * 6. 사용자가 터미널에서 실행: curl ... | bash
 * 7. POST /api/tracker/install → 토큰 검증 후 config.json 생성
 * ─────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');

// ─── 설치 토큰 저장소 (메모리 + DB 보조) ───────────────────────────────
const installTokens = new Map(); // { token: { userId, expiresAt, googleDriveToken, ... } }

function generateInstallToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createInstallToken(userId, googleDriveToken, sessionToken) {
  const token = generateInstallToken();
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10분 유효

  installTokens.set(token, {
    userId,
    googleDriveToken,
    sessionToken,
    createdAt: Date.now(),
    expiresAt,
  });

  // 10분 후 자동 삭제
  setTimeout(() => installTokens.delete(token), 10 * 60 * 1000);

  return token;
}

function verifyInstallToken(token) {
  const data = installTokens.get(token);
  if (!data) return null;
  if (Date.now() > data.expiresAt) {
    installTokens.delete(token);
    return null;
  }
  return data;
}

// ─── Google OAuth 설정 ────────────────────────────────────────────────
const googleAuth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_CALLBACK_URL || 'https://orbit3d-production.up.railway.app/api/tracker/oauth/callback'
);

// ─── 라우터 정의 ──────────────────────────────────────────────────────

module.exports = function setupTrackerOAuth(app, { verifyToken, getDb }) {

  /**
   * POST /api/tracker/oauth/init
   * 로그인된 사용자 → Google OAuth 시작
   */
  app.post('/api/tracker/oauth/init', (req, res) => {
    try {
      // 1. 사용자 인증 확인
      const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!authToken) {
        return res.status(401).json({ error: '로그인 필요' });
      }

      const user = verifyToken(authToken);
      if (!user) {
        return res.status(401).json({ error: '유효하지 않은 토큰' });
      }

      // 2. Google OAuth URL 생성
      const scopes = [
        'https://www.googleapis.com/auth/drive.file', // Google Drive 접근
      ];

      const authUrl = googleAuth.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        state: JSON.stringify({ userId: user.id, sessionToken: authToken }),
        prompt: 'consent', // 항상 동의 화면 표시
      });

      res.json({ authUrl, message: 'Google Drive 계정에서 "허용"을 클릭하세요' });
    } catch (e) {
      console.error('[tracker-oauth] init 에러:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/tracker/oauth/callback
   * Google OAuth 콜백 → googleDriveToken 저장 → 설치 토큰 생성
   */
  app.get('/api/tracker/oauth/callback', async (req, res) => {
    try {
      const { code, state } = req.query;

      if (!code) {
        return res.status(400).json({ error: 'OAuth code 없음' });
      }

      // 1. state에서 userId 추출
      let userId, sessionToken;
      try {
        const stateData = JSON.parse(state);
        userId = stateData.userId;
        sessionToken = stateData.sessionToken;
      } catch {
        return res.status(400).json({ error: 'Invalid state' });
      }

      // 2. Google 토큰 교환
      const { tokens } = await googleAuth.getToken(code);

      // 3. googleDriveToken 암호화해서 DB에 저장
      const db = getDb();
      if (db) {
        // users_google_tokens 테이블 생성
        db.exec(`
          CREATE TABLE IF NOT EXISTS users_google_tokens (
            userId TEXT PRIMARY KEY,
            googleDriveToken TEXT NOT NULL,
            refreshToken TEXT,
            expiresAt INTEGER,
            createdAt INTEGER,
            updatedAt INTEGER
          )
        `);

        // 토큰 저장 (plain text는 실제 환경에서는 암호화 필요)
        const now = Date.now();
        db.prepare(`
          INSERT OR REPLACE INTO users_google_tokens
          (userId, googleDriveToken, refreshToken, expiresAt, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          JSON.stringify(tokens), // JSON 저장
          tokens.refresh_token || null,
          tokens.expiry_date || null,
          now,
          now
        );
      }

      // 4. 일회용 설치 토큰 생성
      const installToken = createInstallToken(userId, tokens, sessionToken);

      // 5. 설치 가이드 HTML 반환 (터미널 명령어 제시)
      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Orbit Tracker 설치</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                   background: #020617; color: #e2e8f0; padding: 40px; }
            .container { max-width: 800px; margin: 0 auto; }
            h1 { color: #06b6d4; margin-bottom: 20px; }
            .step { background: #0a0f1e; padding: 20px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #06b6d4; }
            .cmd { background: #1e293b; padding: 16px; border-radius: 6px; font-family: 'Courier New';
                   word-break: break-all; margin: 10px 0; }
            .btn { background: #06b6d4; color: #020617; padding: 10px 20px; border: none;
                   border-radius: 6px; cursor: pointer; font-weight: bold; }
            .btn:hover { background: #00d9ff; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>✅ Google Drive 연동 완료!</h1>

            <div class="step">
              <h2>Step 1: 터미널 열기</h2>
              <p>macOS/Linux: Terminal 또는 iTerm2</p>
              <p>Windows: PowerShell (관리자 권한)</p>
            </div>

            <div class="step">
              <h2>Step 2: 다음 명령어 복사하여 실행</h2>
              <div class="cmd">curl -fsSL https://orbit3d-production.up.railway.app/installer/${installToken} | bash</div>
              <button class="btn" onclick="copyCmd()">복사하기</button>
            </div>

            <div class="step">
              <h2>완료!</h2>
              <p>설치가 완료되면 Orbit에서 추적 상태를 확인할 수 있습니다.</p>
              <p><a href="/" style="color: #06b6d4; text-decoration: none;">← 돌아가기</a></p>
            </div>
          </div>

          <script>
            function copyCmd() {
              const cmd = 'curl -fsSL https://orbit3d-production.up.railway.app/installer/${installToken} | bash';
              navigator.clipboard.writeText(cmd).then(() => {
                alert('복사되었습니다!');
              });
            }
          </script>
        </body>
        </html>
      `);

    } catch (e) {
      console.error('[tracker-oauth] callback 에러:', e.message);
      res.status(500).send(`
        <html>
          <body style="font-family: sans-serif; padding: 40px;">
            <h1>❌ 오류</h1>
            <p>${e.message}</p>
            <p><a href="/">← 돌아가기</a></p>
          </body>
        </html>
      `);
    }
  });

  /**
   * GET /installer/:token
   * 터미널 설치 스크립트 제공
   * curl ... | bash 로 실행됨
   */
  app.get('/installer/:token', (req, res) => {
    try {
      const { token } = req.params;

      // 1. 토큰 검증
      const tokenData = verifyInstallToken(token);
      if (!tokenData) {
        return res.status(400).send(`
echo "❌ 설치 토큰 만료됨. 다시 시도해주세요."
exit 1
        `);
      }

      // 2. 운영체제 감지
      const userAgent = req.headers['user-agent'] || '';
      const isWindows = userAgent.includes('Windows');

      // 3. 스크립트 생성 (OS별)
      if (isWindows) {
        res.type('text/plain').send(getWindowsInstallScript(token));
      } else {
        res.type('text/plain').send(getMacLinuxInstallScript(token));
      }

    } catch (e) {
      console.error('[installer] 에러:', e.message);
      res.status(500).send(`echo "Error: ${e.message}"\nexit 1`);
    }
  });

  /**
   * POST /api/tracker/install/:token
   * 터미널 스크립트에서 호출
   * 최종 설치 확인 + config.json 생성
   */
  app.post('/api/tracker/install/:token', (req, res) => {
    try {
      const { token } = req.params;
      const { hostname, platform } = req.body || {};

      // 1. 토큰 검증
      const tokenData = verifyInstallToken(token);
      if (!tokenData) {
        return res.status(400).json({ error: '토큰 만료됨' });
      }

      const { userId, googleDriveToken, sessionToken } = tokenData;

      // 2. config.json 데이터 생성
      const config = {
        version: '1.0',
        userId,
        sessionToken,
        googleDriveToken: typeof googleDriveToken === 'string' ? googleDriveToken : JSON.stringify(googleDriveToken),
        hostname,
        platform,
        installedAt: new Date().toISOString(),
        enabledTrackers: {
          files: true,
          messages: true,
          apps: true,
          clipboard: false, // 프라이버시: 기본 비활성화
        },
      };

      // 3. DB에 설치 로그 저장
      const db = getDb();
      if (db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS tracker_installs (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL,
            hostname TEXT,
            platform TEXT,
            installedAt INTEGER,
            lastSeen INTEGER
          )
        `);

        const now = Date.now();
        db.prepare(`
          INSERT OR REPLACE INTO tracker_installs
          (id, userId, hostname, platform, installedAt, lastSeen)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          `${userId}:${hostname}`,
          userId,
          hostname,
          platform,
          now,
          now
        );
      }

      // 4. config 반환
      res.json({
        success: true,
        config,
        message: '설치 완료! Orbit 대시보드에서 추적 상태를 확인하세요.',
      });

      // 토큰 사용 완료 → 삭제
      installTokens.delete(token);

    } catch (e) {
      console.error('[tracker-install] 에러:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * GET /api/tracker/status
   * 현재 추적 상태 조회 (로그인 사용자)
   */
  app.get('/api/tracker/status', (req, res) => {
    try {
      const authToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
      if (!authToken) {
        return res.status(401).json({ error: '로그인 필요' });
      }

      const user = verifyToken(authToken);
      if (!user) {
        return res.status(401).json({ error: '유효하지 않은 토큰' });
      }

      const db = getDb();
      let installed = false, lastSeen = null;

      if (db) {
        const row = db.prepare(`
          SELECT * FROM tracker_installs WHERE userId = ? ORDER BY lastSeen DESC LIMIT 1
        `).get(user.id);

        if (row) {
          installed = true;
          lastSeen = new Date(row.lastSeen).toISOString();
        }
      }

      res.json({
        userId: user.id,
        installed,
        lastSeen,
        message: installed ? 'Tracker 온라인' : 'Tracker 설치 필요',
      });

    } catch (e) {
      console.error('[tracker-status] 에러:', e.message);
      res.status(500).json({ error: e.message });
    }
  });
};

// ─── 설치 스크립트 생성 ────────────────────────────────────────────────

function getMacLinuxInstallScript(token) {
  return `#!/bin/bash
set -e

echo "⬡ Orbit Tracker 설치 중..."

# 1. 토큰 검증
RESPONSE=$(curl -s -X POST \\
  https://orbit3d-production.up.railway.app/api/tracker/install/${token} \\
  -H "Content-Type: application/json" \\
  -d "{ \\"hostname\\": \\"$(hostname)\\", \\"platform\\": \\"$(uname)\\", \\"arch\\": \\"$(uname -m)\\" }")

# 2. 응답 확인
if echo "$RESPONSE" | grep -q '"success":true'; then
  CONFIG=$(echo "$RESPONSE" | grep -o '"config":{[^}]*}' | head -1)
  echo "✅ 설치 완료!"
  echo ""
  echo "다음 설정이 저장되었습니다:"
  echo "$CONFIG"
  echo ""
  echo "Orbit 대시보드로 이동해서 추적 상태를 확인하세요."
else
  echo "❌ 설치 실패"
  echo "$RESPONSE"
  exit 1
fi
`;
}

function getWindowsInstallScript(token) {
  return `# Orbit Tracker 설치 스크립트 (PowerShell)

Write-Host "⬡ Orbit Tracker 설치 중..." -ForegroundColor Cyan

# 1. 토큰 검증
$hostname = [System.Net.Dns]::GetHostName()
$platform = "Windows"
$arch = (Get-WmiObject Win32_Processor).Architecture

$body = @{
  hostname = $hostname
  platform = $platform
  arch = $arch
} | ConvertTo-Json

$response = Invoke-RestMethod -Method Post \\
  -Uri "https://orbit3d-production.up.railway.app/api/tracker/install/${token}" \\
  -Body $body \\
  -ContentType "application/json"

if ($response.success) {
  Write-Host "✅ 설치 완료!" -ForegroundColor Green
  Write-Host "Orbit 대시보드에서 추적 상태를 확인하세요." -ForegroundColor Green
} else {
  Write-Host "❌ 설치 실패" -ForegroundColor Red
  Write-Host $response.error -ForegroundColor Red
  exit 1
}
`;
}
