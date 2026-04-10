'use strict';
/**
 * config/environment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 모든 환경변수 및 하드코딩 상수를 한 곳에서 관리합니다.
 *
 * 변경이 필요한 경우 이 파일만 수정하세요.
 * server.js에 하드코딩된 값을 직접 수정하지 마세요.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const path = require('path');
const os   = require('os');

// ─── 서버 기본 설정 ────────────────────────────────────────────────────────
const PORT          = process.env.PORT ? parseInt(process.env.PORT) : 4747;
const IS_RAILWAY    = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PUBLIC_DOMAIN);
const IS_PG         = !!process.env.DATABASE_URL;
const IS_DEV        = process.env.AUTH_DISABLED === '1';

// ─── 메모리 관리 ──────────────────────────────────────────────────────────
const HEAP_LIMIT_MB    = parseInt(process.env.HEAP_LIMIT_MB) || 580;  // Railway 768MB 힙 기준 안전마진
const MAX_EVENTS_LOAD  = parseInt(process.env.MAX_EVENTS_LOAD) || 200; // OOM 방지 이벤트 상한

// ─── 파일 경로 ────────────────────────────────────────────────────────────
const DATA_ROOT     = process.env.DATA_DIR || path.resolve(__dirname, '..');
const CONV_FILE     = path.join(DATA_ROOT, 'conversation.jsonl');
const SNAPSHOTS_DIR = path.join(DATA_ROOT, 'snapshots');

// ─── 관리자 ──────────────────────────────────────────────────────────────
// 여러 이메일은 쉼표로 구분: ADMIN_EMAILS=a@b.com,c@d.com
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'dlaww584@gmail.com,dlaww@kicda.com')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ADMIN_TOKENS: 이메일 인증 없이 관리자 권한을 부여할 API 토큰 목록
// Railway 환경변수: ADMIN_TOKENS=token1,token2
// 또는 ~/.orbit-config.json의 token이 자동 포함됨
const ADMIN_TOKENS = (process.env.ADMIN_TOKENS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ~/.orbit-config.json 토큰도 ADMIN_TOKENS에 포함 (로컬 마스터 토큰)
try {
  const fs = require('fs');
  const _cfgPath = require('path').join(require('os').homedir(), '.orbit-config.json');
  if (fs.existsSync(_cfgPath)) {
    const _cfg = JSON.parse(fs.readFileSync(_cfgPath, 'utf8'));
    if (_cfg.token && !ADMIN_TOKENS.includes(_cfg.token)) ADMIN_TOKENS.push(_cfg.token);
  }
} catch {}

function isAdmin(emailOrId) {
  if (!emailOrId) return false;
  // 이메일 기반 체크
  if (ADMIN_EMAILS.includes(emailOrId.toLowerCase())) return true;
  // 토큰 기반 체크 (API 토큰 직접 전달 시)
  if (ADMIN_TOKENS.includes(emailOrId)) return true;
  return false;
}

// 토큰이 관리자 토큰인지 직접 확인 (verifyToken 없이)
function isAdminToken(token) {
  if (!token) return false;
  return ADMIN_TOKENS.includes(token.replace('Bearer ', '').trim());
}

// ─── CORS ────────────────────────────────────────────────────────────────
// 추가 허용 도메인: CORS_ORIGINS=https://foo.com,https://bar.com
const _extraOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const CORS_ALLOWED_ORIGINS = [
  `http://localhost:${PORT}`,
  ...(IS_RAILWAY && process.env.RAILWAY_PUBLIC_DOMAIN
    ? [`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`]
    : []),
  'https://sparkling-determination-production-c88b.up.railway.app',
  ..._extraOrigins,
];

// ─── 리포트 스케줄 (UTC 기준 — KST는 +9) ──────────────────────────────────
// KST 09:00 → UTC 00:00 | KST 13:30 → UTC 04:30 | KST 18:00 → UTC 09:00
const REPORT_HOURS = [
  { h: 0, m: 0  },
  { h: 4, m: 30 },
  { h: 9, m: 0  },
];

// ─── Railway 동기화 ──────────────────────────────────────────────────────
function getRailwayConfig() {
  try {
    const cfgPath = path.join(os.homedir(), '.orbit-config.json');
    const fs = require('fs');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      return {
        serverUrl: process.env.ORBIT_SERVER_URL || cfg.serverUrl || null,
        token:     cfg.token || '',
        userId:    cfg.userId || null,
        email:     cfg.email || null,
      };
    }
  } catch {}
  return {
    serverUrl: process.env.ORBIT_SERVER_URL || null,
    token:     '',
    userId:    null,
    email:     null,
  };
}

module.exports = {
  PORT,
  IS_RAILWAY,
  IS_PG,
  IS_DEV,
  HEAP_LIMIT_MB,
  MAX_EVENTS_LOAD,
  DATA_ROOT,
  CONV_FILE,
  SNAPSHOTS_DIR,
  ADMIN_EMAILS,
  ADMIN_TOKENS,
  isAdmin,
  isAdminToken,
  CORS_ALLOWED_ORIGINS,
  REPORT_HOURS,
  getRailwayConfig,
};
