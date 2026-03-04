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
  const dbPath   = path.join(__dirname, '..', 'data', 'users.db');
  const dir      = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
} catch {
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

  db.prepare('UPDATE users SET lastLoginAt = datetime("now") WHERE id = ?').run(user.id);

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

module.exports = {
  register, login, verifyToken, issueApiToken,
  getUserById, getUserByEmail, upgradePlan, upsertOAuthUser,
  authMiddleware, optionalAuth,
  getDb: () => db,
};
