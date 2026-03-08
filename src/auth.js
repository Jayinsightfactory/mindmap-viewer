/**
 * src/auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 계정 시스템 — 사용자 DB (SQLite)
 *
 * 플랜:
 *   free  - 개인 작업 추적만 가능
 *   pro   - 테마 판매 + 감사 로그 + Shadow AI 감지
 *   team  - 채널 공유 + 팀 대시보드 + 모든 pro 기능
 *
 * 인증 방식:
 *   - 비밀번호: bcrypt (cost factor 12) — SHA-256 대비 브루트포스 저항성 수십만 배 향상
 *   - 토큰: crypto.randomBytes(24) 기반 hex 문자열 (JWT 불필요)
 *   - 토큰 만료: 로그인 토큰 30일 / API 토큰 365일 / 영구 토큰 NULL
 *
 * 환경 변수:
 *   AUTH_DISABLED=1 → 인증 비활성화 (로컬 개발용)
 * ─────────────────────────────────────────────────────────────────────────────
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

/** bcrypt 비용 인자: 12는 현대 하드웨어에서 약 250ms — 보안과 UX 균형 */
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');

let db;
try {
  const Database = require('better-sqlite3');
  const dbPath   = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'users.db') : path.join(__dirname, '..', 'data', 'users.db');
  const dir      = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
} catch (e) {
  console.error('[AUTH] DB 초기화 실패:', e.message);
  db = null; // DB 없으면 인증 비활성화 (로컬 전용 모드)
}

// ─── 테이블 초기화 ──────────────────────────────
if (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      email        TEXT UNIQUE NOT NULL,
      name         TEXT,
      passwordHash TEXT NOT NULL DEFAULT '',
      plan         TEXT DEFAULT 'free',
      provider     TEXT DEFAULT 'local',
      providerId   TEXT,
      avatar       TEXT,
      createdAt    TEXT DEFAULT (datetime('now')),
      lastLoginAt  TEXT,
      settings     TEXT DEFAULT '{}'
    );

    -- OAuth 계정 연동 시 컬럼이 없으면 추가 (기존 DB 마이그레이션)
    -- better-sqlite3는 ALTER TABLE ADD COLUMN을 지원


    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      userId     TEXT NOT NULL,
      type       TEXT DEFAULT 'api',
      expiresAt  TEXT,
      createdAt  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id)
    );

    -- 트래커 연결 상태 컬럼 (마이그레이션)
    CREATE TABLE IF NOT EXISTS tracker_pings (
      userId       TEXT PRIMARY KEY,
      hostname     TEXT DEFAULT '',
      eventCount   INTEGER DEFAULT 0,
      lastSeen     INTEGER DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id        TEXT PRIMARY KEY,
      userId    TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now')),
      expiresAt TEXT,
      FOREIGN KEY (userId) REFERENCES users(id)
    );

    -- OAuth 토큰 저장 (Google Drive 백업용)
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      userId       TEXT PRIMARY KEY,
      accessToken  TEXT NOT NULL DEFAULT '',
      refreshToken TEXT NOT NULL DEFAULT '',
      expiresAt    INTEGER DEFAULT 0,
      updatedAt    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (userId) REFERENCES users(id)
    );

    -- 관리자 초대 테이블 (관리자가 초대한 사용자에게 팀 플랜 부여)
    CREATE TABLE IF NOT EXISTS admin_invites (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_id    TEXT NOT NULL,
      invitee_email TEXT NOT NULL,
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE(invitee_email)
    );
  `);
}

// ─── 유틸 ────────────────────────────────────────────────────────────────────

/**
 * 고유 ID를 생성합니다 (타임스탬프 base36 + 랜덤 hex).
 * @returns {string}
 */
function ulid() {
  return Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString('hex').toUpperCase();
}

/**
 * 랜덤 API 토큰을 생성합니다.
 * @returns {string} 'orbit_' 접두사 + 48자 hex
 */
function generateToken() {
  return 'orbit_' + crypto.randomBytes(24).toString('hex');
}

// ─── 사용자 등록 ──────────────────────────────────────────────────────────────

/**
 * 새 사용자를 등록하고 즉시 API 토큰을 발급합니다.
 * 비밀번호는 bcrypt(rounds=12)로 해싱합니다.
 *
 * @param {object} params
 * @param {string} params.email    - 이메일 주소 (고유)
 * @param {string} params.password - 평문 비밀번호
 * @param {string} [params.name]   - 표시 이름 (미지정 시 이메일 앞부분 사용)
 * @returns {{ ok: boolean, user: User, token: string } | { error: string }}
 */
function register({ email, password, name }) {
  if (!db) return { error: 'DB not available' };
  if (!email || !password) return { error: 'email and password required' };

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return { error: 'email already registered' };

  const id   = ulid();
  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  db.prepare(`
    INSERT INTO users (id, email, name, passwordHash)
    VALUES (?, ?, ?, ?)
  `).run(id, email.toLowerCase().trim(), name || email.split('@')[0], hash);

  const token = generateToken();
  db.prepare(`
    INSERT INTO tokens (token, userId, type, expiresAt)
    VALUES (?, ?, 'api', datetime('now', '+365 days'))
  `).run(token, id);

  return { ok: true, user: getUserById(id), token };
}

// ─── 로그인 ───────────────────────────────────────────────────────────────────

/**
 * 이메일/비밀번호로 로그인하고 세션 토큰을 발급합니다.
 * bcrypt.compareSync 로 해시 일치 여부를 검증합니다.
 *
 * @param {object} params
 * @param {string} params.email    - 이메일 주소
 * @param {string} params.password - 평문 비밀번호
 * @returns {{ ok: boolean, user: User, token: string } | { error: string }}
 */
function login({ email, password }) {
  if (!db) return { error: 'DB not available' };

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase()?.trim());
  // 이메일이 없어도 bcrypt 비교를 수행하여 타이밍 공격(timing attack) 방지
  if (!user) {
    bcrypt.hashSync('dummy', BCRYPT_ROUNDS); // 더미 연산으로 응답 시간 일정하게 유지
    return { error: 'invalid credentials' };
  }

  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) return { error: 'invalid credentials' };

  db.prepare("UPDATE users SET lastLoginAt = datetime('now') WHERE id = ?").run(user.id);

  const token = generateToken();
  db.prepare(`
    INSERT INTO tokens (token, userId, type, expiresAt)
    VALUES (?, ?, 'session', datetime('now', '+30 days'))
  `).run(token, user.id);

  return { ok: true, user: sanitizeUser(user), token };
}

// ─── 토큰 검증 ────────────────────────────────
function verifyToken(token) {
  if (!db || !token) return null;
  const raw = token.replace('Bearer ', '').trim();
  const row = db.prepare(`
    SELECT t.*, u.* FROM tokens t
    JOIN users u ON t.userId = u.id
    WHERE t.token = ?
    AND (t.expiresAt IS NULL OR t.expiresAt > datetime('now'))
  `).get(raw);
  return row ? sanitizeUser(row) : null;
}

// ─── API 토큰 발급 ────────────────────────────
function issueApiToken(userId) {
  if (!db) return null;
  const token = generateToken();
  db.prepare(`
    INSERT INTO tokens (token, userId, type)
    VALUES (?, ?, 'api')
  `).run(token, userId);
  return token;
}

// ─── 사용자 조회 ──────────────────────────────
function getUserById(id) {
  if (!db) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  return u ? sanitizeUser(u) : null;
}
function getUserByEmail(email) {
  if (!db) return null;
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase());
  return u ? sanitizeUser(u) : null;
}
function sanitizeUser(u) {
  const { passwordHash, ...safe } = u;
  try { safe.settings = JSON.parse(safe.settings || '{}'); } catch { safe.settings = {}; }
  return safe;
}

// ─── 플랜 업그레이드 ────────────────────────────
function upgradePlan(userId, plan) {
  if (!db) return false;
  db.prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, userId);
  return true;
}

// ─── OAuth upsert ──────────────────────────────────────────────────────────

/**
 * OAuth 로그인 시 사용자를 생성하거나 업데이트합니다.
 * email이 이미 존재하면 provider/providerId/avatar를 업데이트합니다.
 *
 * @param {{ provider, providerId, email, name, avatar }} profile
 * @returns {User}
 */
function upsertOAuthUser({ provider, providerId, email, name, avatar }) {
  if (!db) throw new Error('DB not available');

  // 기존 컬럼 확인 후 마이그레이션
  try {
    db.exec(`ALTER TABLE users ADD COLUMN provider   TEXT DEFAULT 'local'`);
  } catch {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN providerId TEXT`);
  } catch {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN avatar     TEXT`);
  } catch {}

  const existing = db.prepare(
    `SELECT * FROM users WHERE email = ? OR (provider = ? AND providerId = ?)`
  ).get(email.toLowerCase(), provider, String(providerId));

  if (existing) {
    db.prepare(`
      UPDATE users SET provider=?, providerId=?, avatar=?, lastLoginAt=datetime('now') WHERE id=?
    `).run(provider, String(providerId), avatar || existing.avatar, existing.id);
    return sanitizeUser(db.prepare('SELECT * FROM users WHERE id=?').get(existing.id));
  }

  const id = ulid();
  db.prepare(`
    INSERT INTO users (id, email, name, passwordHash, provider, providerId, avatar)
    VALUES (?, ?, ?, '', ?, ?, ?)
  `).run(id, email.toLowerCase(), name || email.split('@')[0], provider, String(providerId), avatar || null);

  return sanitizeUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
}

// ─── Express 미들웨어 ────────────────────────────
function authMiddleware(req, res, next) {
  if (!db || process.env.AUTH_DISABLED === '1') {
    req.user = { id: 'local', email: 'local', plan: 'pro', name: 'Local User' };
    return next();
  }
  const token = req.headers.authorization || req.query.token || req.cookies?.orbit_token;
  const user  = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: 'unauthorized', hint: 'orbit login <email> <token>' });
  }
  req.user = user;
  next();
}

function optionalAuth(req, res, next) {
  if (!db || process.env.AUTH_DISABLED === '1') {
    req.user = { id: 'local', plan: 'pro' };
    return next();
  }
  const token = req.headers.authorization || req.query.token;
  req.user    = verifyToken(token) || { id: 'anonymous', plan: 'free' };
  next();
}

// ─── OAuth 토큰 관리 (Google Drive 백업용) ────────
function saveOAuthTokens(userId, { accessToken, refreshToken, expiresAt }) {
  if (!db) return;
  db.prepare(`
    INSERT INTO oauth_tokens (userId, accessToken, refreshToken, expiresAt, updatedAt)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(userId) DO UPDATE SET
      accessToken = CASE WHEN ? != '' THEN ? ELSE accessToken END,
      refreshToken = CASE WHEN ? != '' THEN ? ELSE refreshToken END,
      expiresAt = ?, updatedAt = datetime('now')
  `).run(userId, accessToken || '', refreshToken || '', expiresAt || 0,
         accessToken || '', accessToken || '',
         refreshToken || '', refreshToken || '',
         expiresAt || 0);
}

function getOAuthTokens(userId) {
  if (!db) return null;
  return db.prepare('SELECT * FROM oauth_tokens WHERE userId = ?').get(userId) || null;
}

async function refreshGoogleAccessToken(userId) {
  const tokens = getOAuthTokens(userId);
  if (!tokens?.refreshToken) return null;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      saveOAuthTokens(userId, { accessToken: data.access_token, refreshToken: '', expiresAt });
      return data.access_token;
    }
    return null;
  } catch {
    return null;
  }
}

// 유효한 Google access token 가져오기 (만료 시 자동 갱신)
async function getValidGoogleToken(userId) {
  const tokens = getOAuthTokens(userId);
  if (!tokens) return null;
  if (tokens.accessToken && tokens.expiresAt > Date.now() + 60000) {
    return tokens.accessToken;
  }
  return refreshGoogleAccessToken(userId);
}

// Google OAuth 사용자 목록
function getGoogleOAuthUsers() {
  if (!db) return [];
  return db.prepare(`
    SELECT u.id, u.email, u.name, o.refreshToken
    FROM users u
    JOIN oauth_tokens o ON u.id = o.userId
    WHERE u.provider = 'google' AND o.refreshToken != ''
  `).all();
}

// ─── 관리자 초대 시스템 ──────────────────────────────────────────────────────

/** 관리자 이메일 목록 (환경변수 또는 기본값) */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'dlaww@kicda.com').split(',').map(s => s.trim());

/**
 * 관리자가 사용자를 초대합니다.
 * 초대된 사용자는 팀(team) 플랜 혜택을 받습니다.
 *
 * @param {string} adminEmail   - 초대하는 관리자의 이메일
 * @param {string} inviteeEmail - 초대받는 사용자의 이메일
 * @returns {{ ok: boolean } | { error: string }}
 */
function inviteUser(adminEmail, inviteeEmail) {
  if (!db) return { error: 'DB not available' };                      // DB 미사용 시 에러
  if (!ADMIN_EMAILS.includes(adminEmail.toLowerCase().trim())) {      // 관리자 이메일 확인
    return { error: 'admin only' };
  }
  if (!inviteeEmail) return { error: 'invitee email required' };      // 초대 이메일 필수

  const admin = db.prepare('SELECT id FROM users WHERE email = ?')    // 관리자 사용자 ID 조회
    .get(adminEmail.toLowerCase().trim());
  if (!admin) return { error: 'admin user not found' };               // 관리자 계정 없음

  try {
    db.prepare(`
      INSERT INTO admin_invites (inviter_id, invitee_email)
      VALUES (?, ?)
    `).run(admin.id, inviteeEmail.toLowerCase().trim());              // 초대 레코드 삽입
    return { ok: true };                                              // 성공
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {                              // 이미 초대된 이메일
      return { error: 'already invited' };
    }
    return { error: e.message };                                      // 기타 DB 오류
  }
}

/**
 * 해당 이메일이 관리자에게 초대되었는지 확인합니다.
 *
 * @param {string} email - 확인할 이메일
 * @returns {boolean} 초대 여부
 */
function isInvitedUser(email) {
  if (!db || !email) return false;                                    // DB 없거나 이메일 없으면 false
  const row = db.prepare(
    'SELECT 1 FROM admin_invites WHERE invitee_email = ?'
  ).get(email.toLowerCase().trim());                                  // 초대 테이블에서 조회
  return !!row;                                                       // 존재하면 true
}

/**
 * 사용자의 실효 플랜을 반환합니다.
 * 관리자가 초대한 사용자라면 'team' 플랜으로 처리합니다.
 * 관리자 이메일 본인도 'team' 플랜으로 처리합니다.
 *
 * @param {string} userId - 사용자 ID
 * @returns {string} 'free' | 'pro' | 'team'
 */
function getEffectivePlan(userId) {
  if (!db) return 'free';                                             // DB 없으면 기본 free
  const user = db.prepare('SELECT email, plan FROM users WHERE id = ?').get(userId);
  if (!user) return 'free';                                           // 사용자 없으면 free

  // 관리자 이메일이면 무조건 team
  if (ADMIN_EMAILS.includes(user.email.toLowerCase().trim())) return 'team';

  // 관리자에게 초대된 사용자면 team
  if (isInvitedUser(user.email)) return 'team';

  return user.plan || 'free';                                         // 그 외에는 실제 플랜 반환
}

/**
 * 관리자 초대 목록을 반환합니다.
 *
 * @param {string} adminEmail - 관리자 이메일
 * @returns {Array<{invitee_email, created_at}>}
 */
function getAdminInvites(adminEmail) {
  if (!db) return [];                                                 // DB 없으면 빈 배열
  if (!ADMIN_EMAILS.includes(adminEmail.toLowerCase().trim())) return []; // 관리자가 아니면 빈 배열

  return db.prepare(`
    SELECT invitee_email, created_at FROM admin_invites
    ORDER BY created_at DESC
  `).all();                                                           // 모든 초대 내역 조회
}

// ─── 사용자 검색 (팔로우 시스템용) ────────────────────────────────────────────
/**
 * users 테이블에서 이메일·이름으로 사용자를 검색합니다.
 * auth DB(users.db)에 직접 쿼리하므로 user_profiles가 없어도 검색 가능.
 *
 * @param {string} query     - 검색어 (이메일 또는 이름 부분 일치)
 * @param {string} excludeId - 제외할 사용자 ID (본인)
 * @param {number} [limit=20] - 최대 반환 수
 * @returns {Array<{id, email, name, avatar_url, plan}>}
 */
function searchUsers(query, excludeId, limit = 20) {
  if (!db) return [];                                       // DB 없으면 빈 배열
  const like = `%${query}%`;                                // LIKE 패턴 (부분 일치)
  return db.prepare(`
    SELECT id, email, name, avatar, plan, provider
    FROM users
    WHERE id != ? AND (email LIKE ? OR name LIKE ?)
    LIMIT ?
  `).all(excludeId || '', like, like, limit).map(u => ({    // 결과를 표준 형식으로 변환
    id: u.id,                                               // 사용자 고유 ID
    email: u.email,                                         // 이메일 주소
    name: u.name || u.email?.split('@')[0] || '사용자',      // 표시 이름 (없으면 이메일 앞부분)
    avatar_url: u.avatar || null,                           // 프로필 이미지 URL
    plan: u.plan || 'free',                                 // 요금제 (기본: free)
    provider: u.provider || 'local',                        // 인증 제공자 (google, local 등)
  }));
}

module.exports = {
  register, login, verifyToken, issueApiToken,
  getUserById, getUserByEmail, upgradePlan, upsertOAuthUser,
  authMiddleware, optionalAuth,
  getDb: () => db,
  saveOAuthTokens, getOAuthTokens, refreshGoogleAccessToken,
  getValidGoogleToken, getGoogleOAuthUsers,
  searchUsers,                                              // 팔로우 검색용 함수 추가
  inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, // 관리자 초대 시스템
  ADMIN_EMAILS,                                             // 관리자 이메일 목록 (라우터에서 사용)
};
