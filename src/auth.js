/**
 * auth.js
 * 계정 시스템 — 사용자 DB (SQLite)
 *
 * 개인 계정: 자신의 Claude Code/Cursor 작업만 연결
 * 팀 계정:   채널 공유 + 팀 대시보드
 * Pro 계정:  테마 판매 + 감사 로그 + Shadow AI
 */
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

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
      passwordHash TEXT NOT NULL,
      plan         TEXT DEFAULT 'free',
      createdAt    TEXT DEFAULT (datetime('now')),
      lastLoginAt  TEXT,
      settings     TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      userId     TEXT NOT NULL,
      type       TEXT DEFAULT 'api',
      expiresAt  TEXT,
      createdAt  TEXT DEFAULT (datetime('now')),
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

// ─── 유틸 ────────────────────────────────────────
function ulid() {
  return Date.now().toString(36).toUpperCase() + crypto.randomBytes(5).toString('hex').toUpperCase();
}
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + (process.env.AUTH_SECRET || 'orbit-secret')).digest('hex');
}
function generateToken() {
  return 'orbit_' + crypto.randomBytes(24).toString('hex');
}

// ─── 사용자 등록 ──────────────────────────────
function register({ email, password, name }) {
  if (!db) return { error: 'DB not available' };
  if (!email || !password) return { error: 'email and password required' };

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return { error: 'email already registered' };

  const id   = ulid();
  const hash = hashPassword(password);
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

// ─── 로그인 ───────────────────────────────────
function login({ email, password }) {
  if (!db) return { error: 'DB not available' };
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email?.toLowerCase()?.trim());
  if (!user) return { error: 'invalid credentials' };
  if (user.passwordHash !== hashPassword(password)) return { error: 'invalid credentials' };

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
  getUserById, getUserByEmail, upgradePlan,
  authMiddleware, optionalAuth,
};
