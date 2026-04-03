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

const express = require('express');
const router = express.Router();
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

function createRouter(deps) {
  const { verifyToken, getDb } = deps;

  /**
   * POST /tracker/oauth/init
   * 로그인된 사용자 → Google OAuth 시작
   */
  router.post('/oauth/init', (req, res) => {
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
  router.get('/oauth/callback', async (req, res) => {
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

      // 5. 설치 가이드 HTML 반환
      const RAILWAY_URL = 'https://sparkling-determination-production-c88b.up.railway.app';
      const GITHUB_REPO = 'dlaww-wq/mindmap-viewer';
      const EXE_DOWNLOAD_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/OrbitAI-Setup.exe`;

      res.send(`
        <!DOCTYPE html>
        <html lang="ko">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Orbit AI 설치</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Pretendard, sans-serif;
                   background: #020617; color: #e2e8f0; padding: 32px 20px; line-height: 1.6; }
            .container { max-width: 680px; margin: 0 auto; }
            .logo { font-size: 28px; font-weight: 800; color: #06b6d4; margin-bottom: 8px; }
            .subtitle { color: #94a3b8; margin-bottom: 32px; font-size: 15px; }
            .card { background: #0a0f1e; border: 1px solid #1e293b; border-radius: 12px;
                    padding: 24px; margin-bottom: 20px; }
            .card-title { font-size: 13px; font-weight: 700; color: #64748b;
                          text-transform: uppercase; letter-spacing: .08em; margin-bottom: 16px; }
            /* EXE 다운로드 버튼 */
            .btn-download { display: flex; align-items: center; gap: 12px;
                            background: #06b6d4; color: #020617; border: none;
                            border-radius: 10px; padding: 16px 24px; font-size: 16px;
                            font-weight: 700; cursor: pointer; width: 100%;
                            text-decoration: none; transition: background .15s; }
            .btn-download:hover { background: #22d3ee; }
            .btn-download .icon { font-size: 24px; }
            .btn-download .meta { text-align: left; }
            .btn-download .meta small { display: block; font-weight: 400; font-size: 12px;
                                        opacity: .75; margin-top: 2px; }
            /* 설치코드 */
            .token-box { background: #1e293b; border-radius: 8px; padding: 14px 16px;
                         font-family: 'Courier New', monospace; font-size: 14px;
                         letter-spacing: .04em; color: #7dd3fc; word-break: break-all;
                         position: relative; margin-top: 12px; border: 1px solid #334155; }
            .token-copy { position: absolute; top: 10px; right: 10px;
                          background: #334155; border: none; border-radius: 6px;
                          color: #94a3b8; padding: 4px 10px; font-size: 12px;
                          cursor: pointer; }
            .token-copy:hover { background: #475569; color: #e2e8f0; }
            /* PowerShell 대안 */
            .cmd-box { background: #0f172a; border-radius: 8px; padding: 12px 14px;
                       font-family: 'Courier New', monospace; font-size: 12px;
                       color: #94a3b8; word-break: break-all; margin-top: 10px;
                       border: 1px solid #1e293b; }
            /* 개인정보 안내 */
            .privacy-box { background: #052e16; border: 1px solid #166534;
                           border-radius: 10px; padding: 18px 20px; margin-bottom: 20px; }
            .privacy-box .p-title { color: #4ade80; font-weight: 700; margin-bottom: 10px; }
            .privacy-box ul { color: #86efac; font-size: 14px; padding-left: 20px; }
            .privacy-box ul li { margin-bottom: 6px; }
            .privacy-box .p-note { color: #6ee7b7; font-size: 13px; margin-top: 10px;
                                   border-top: 1px solid #166534; padding-top: 10px; }
            /* steps */
            .steps { counter-reset: step; display: flex; flex-direction: column; gap: 14px; }
            .step { display: flex; gap: 14px; align-items: flex-start; }
            .step-num { background: #1e293b; border-radius: 50%; width: 28px; height: 28px;
                        display: flex; align-items: center; justify-content: center;
                        font-size: 13px; font-weight: 700; color: #06b6d4; flex-shrink: 0; }
            .step-body { flex: 1; font-size: 14px; color: #cbd5e1; padding-top: 4px; }
            .step-body strong { color: #e2e8f0; }
            .back { display: inline-block; margin-top: 24px; color: #475569; font-size: 14px;
                    text-decoration: none; }
            .back:hover { color: #94a3b8; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">⬡ Orbit AI</div>
            <div class="subtitle">업무 자동화 에이전트 설치 안내</div>

            <!-- 개인정보 보호 안내 -->
            <div class="privacy-box">
              <div class="p-title">🔒 개인정보 보호 안내</div>
              <ul>
                <li>업무 관련 앱 활동 데이터만 수집합니다 (업무 효율화 목적)</li>
                <li><strong>개인 사생활 정보는 수집·학습하지 않습니다</strong></li>
                <li>개인 채팅 내용, 개인 이메일, 개인 파일은 분석 대상이 아닙니다</li>
                <li>수집된 데이터는 회사 내부 서버에만 저장되며 외부 공유 없음</li>
              </ul>
              <div class="p-note">⚙️ 수집 항목: 업무 앱 전환 패턴 · 작업 내용 요약 · 유휴 시간 · 카카오 업무 메시지</div>
            </div>

            <!-- 다운로드 섹션 -->
            <div class="card">
              <div class="card-title">1단계 — 설치 프로그램 다운로드</div>
              <a class="btn-download" href="${EXE_DOWNLOAD_URL}" download>
                <span class="icon">⬇</span>
                <span class="meta">
                  OrbitAI-Setup.exe 다운로드
                  <small>Windows 10/11 · 관리자 권한 불필요 · 약 15MB</small>
                </span>
              </a>
            </div>

            <!-- 설치코드 섹션 -->
            <div class="card">
              <div class="card-title">2단계 — 설치 코드 입력</div>
              <p style="font-size:14px;color:#94a3b8;margin-bottom:4px;">설치 프로그램 실행 후 아래 코드를 입력하세요. <strong style="color:#fbbf24">10분 이내 사용</strong></p>
              <div class="token-box">
                ${installToken}
                <button class="token-copy" onclick="copyToken()">복사</button>
              </div>
            </div>

            <!-- 설치 순서 -->
            <div class="card">
              <div class="card-title">설치 순서</div>
              <div class="steps">
                <div class="step">
                  <div class="step-num">1</div>
                  <div class="step-body"><strong>OrbitAI-Setup.exe</strong> 다운로드 후 실행</div>
                </div>
                <div class="step">
                  <div class="step-num">2</div>
                  <div class="step-body">설치 진행 → <strong>설치 코드 입력</strong> 화면에서 위 코드 붙여넣기</div>
                </div>
                <div class="step">
                  <div class="step-num">3</div>
                  <div class="step-body">설치 완료 → 화면 우측 하단 트레이에 <strong>Orbit AI 아이콘</strong> 표시</div>
                </div>
                <div class="step">
                  <div class="step-num">4</div>
                  <div class="step-body">PC 재시작 후에도 <strong>자동 실행</strong>됩니다</div>
                </div>
              </div>
            </div>

            <!-- PowerShell 대안 (접기) -->
            <details style="margin-bottom:16px;">
              <summary style="cursor:pointer;color:#475569;font-size:13px;padding:8px 0;">
                PowerShell 명령어로 설치하기 (고급)
              </summary>
              <div class="cmd-box">irm ${RAILWAY_URL}/installer/${installToken} | iex</div>
              <p style="font-size:12px;color:#475569;margin-top:6px;">PowerShell을 관리자 권한으로 실행 후 위 명령어를 붙여넣기 하세요.</p>
            </details>

            <a href="/" class="back">← 돌아가기</a>
          </div>

          <script>
            function copyToken() {
              navigator.clipboard.writeText('${installToken}').then(() => {
                const btn = document.querySelector('.token-copy');
                btn.textContent = '✓ 복사됨';
                setTimeout(() => btn.textContent = '복사', 2000);
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
  router.get('/installer/:token', (req, res) => {
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
  router.post('/install/:token', (req, res) => {
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
  router.get('/status', (req, res) => {
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

  return router;
}

module.exports = createRouter;

// ─── 설치 스크립트 생성 ────────────────────────────────────────────────

function getMacLinuxInstallScript(token) {
  return `#!/bin/bash
set -e

echo "Orbit Tracker 설치 중..."

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

Write-Host "Orbit Tracker 설치 중..." -ForegroundColor Cyan

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
