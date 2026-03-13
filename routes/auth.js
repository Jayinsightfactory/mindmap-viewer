/**
 * routes/auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 계정 인증 API 라우터
 *
 * 담당 엔드포인트:
 *   POST /api/auth/register - 회원가입 (이메일, 비밀번호, 이름)
 *   POST /api/auth/login    - 로그인 → 액세스 토큰 발급
 *   GET  /api/auth/me       - 현재 로그인 사용자 정보 조회
 *
 * 인증 방식:
 *   - 헤더: Authorization: <token>
 *   - 쿼리: ?token=<token>
 *
 * 환경 변수:
 *   AUTH_DISABLED=1 → 인증 미들웨어 비활성화 (로컬 개발용)
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();

/**
 * @param {object} deps - 의존성 객체
 * @param {object} deps.auth - { register, login, verifyToken, inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, ADMIN_EMAILS }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { auth } = deps;
  const { register: authRegister, login: authLogin, verifyToken,
          inviteUser, isInvitedUser, getEffectivePlan, getAdminInvites, ADMIN_EMAILS } = auth;

  // ── 회원가입 ─────────────────────────────────────────────────────────────

  /**
   * POST /api/auth/register
   * 새 계정을 생성하고 즉시 액세스 토큰을 반환합니다.
   * @body {string} email    - 이메일 주소 (중복 불가)
   * @body {string} password - 비밀번호 (8자 이상 권장)
   * @body {string} [name]   - 표시 이름
   * @returns {{ user: User, token: string } | { error: string }}
   */
  router.post('/auth/register', (req, res) => {
    const result = authRegister(req.body);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // ── 로그인 ───────────────────────────────────────────────────────────────

  /**
   * POST /api/auth/login
   * 이메일/비밀번호로 인증 후 액세스 토큰을 발급합니다.
   * @body {string} email    - 이메일 주소
   * @body {string} password - 비밀번호
   * @returns {{ user: User, token: string } | { error: string }}
   */
  router.post('/auth/login', (req, res) => {
    const result = authLogin(req.body);
    if (result.error) return res.status(401).json(result);
    res.json(result);
  });

  // ── 현재 사용자 조회 ─────────────────────────────────────────────────────

  /**
   * GET /api/auth/me
   * Authorization 헤더 또는 ?token 쿼리의 토큰을 검증하고 사용자 정보를 반환합니다.
   * @header {string} [Authorization] - 액세스 토큰
   * @query  {string} [token]         - 액세스 토큰 (헤더 대체)
   * @returns {{ user: User } | { error: 'unauthorized' }}
   */
  router.get('/auth/me', (req, res) => {
    const token = req.headers.authorization || req.query.token;
    const user  = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    // 관리자 초대 여부에 따른 실효 플랜 계산
    const effectivePlan = getEffectivePlan(user.id);            // 초대된 사용자면 'team' 반환
    const isAdmin = ADMIN_EMAILS.includes(                      // 관리자 여부 확인
      (user.email || '').toLowerCase().trim()
    );
    res.json({
      user: { ...user, effectivePlan, isAdmin },                // 실효 플랜 + 관리자 여부 포함
    });
  });

  // ── 임시 디버그 (배포 확인 후 제거) ────────────────────────────────────
  router.get('/auth/_debug-sync', async (req, res) => {
    const authMod = require('../src/auth');
    const authDb = authMod.getDb();
    if (!authDb) return res.json({ error: 'no db' });
    const users = authDb.prepare('SELECT id, email, LENGTH(passwordHash) as pwLen FROM users').all();
    const tokens = authDb.prepare('SELECT token, userId, type FROM tokens LIMIT 10').all();

    // 환경변수 진단
    const envKeys = Object.keys(process.env).filter(k =>
      /DATABASE|PG|POSTGRES|RAILWAY/i.test(k)
    );
    const envDiag = {};
    for (const k of envKeys) envDiag[k] = process.env[k] ? `SET (${process.env[k].length} chars)` : 'EMPTY';
    envDiag._DATABASE_URL_truthy = !!process.env.DATABASE_URL;
    envDiag._NODE_ENV = process.env.NODE_ENV || 'unset';

    // PG 직접 연결 시도 (하드코딩 URL)
    const PG_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
    let pgStatus = 'no url';
    let pgUsers = [];
    try {
      if (PG_URL) {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: PG_URL, max: 1 });
        const r = await pool.query('SELECT id, email, LENGTH(password_hash) as pw_len FROM orbit_auth_users');
        pgUsers = r.rows;
        pgStatus = 'connected via ' + (process.env.DATABASE_URL ? 'DATABASE_URL' : 'DATABASE_PUBLIC_URL');
        pool.end();
      }
    } catch (e) { pgStatus = 'error: ' + e.message; }

    // 수동 sync 시도
    let syncResult = 'skipped';
    try {
      await authMod.initFromPg();
      const usersAfter = authDb.prepare('SELECT id, email, LENGTH(passwordHash) as pwLen FROM users').all();
      syncResult = { synced: usersAfter.length, users: usersAfter };
    } catch (e) { syncResult = 'error: ' + e.message; }

    res.json({ sqlite: { users, tokens }, env: envDiag, pg: { status: pgStatus, users: pgUsers }, syncResult });
  });

  // ── 로그아웃 ─────────────────────────────────────────────────────────────

  /**
   * DELETE /api/auth/logout
   * 현재 토큰을 무효화하고 서버 사이드 세션을 정리합니다.
   */
  router.delete('/auth/logout', (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim()
                || req.query.token;
    if (!token) return res.json({ ok: true });

    // 토큰 삭제 (서버 사이드 무효화)
    try {
      const authDb = auth.getDb ? auth.getDb() : null;
      if (authDb) {
        authDb.prepare('DELETE FROM tokens WHERE token = ?').run(token);
      }
    } catch (e) {
      console.warn('[auth/logout] 토큰 삭제 실패:', e.message);
    }

    // ~/.orbit-config.json에서 토큰 정리
    try {
      const os = require('os');
      const fs = require('fs');
      const path = require('path');
      const cfgPath = path.join(os.homedir(), '.orbit-config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.token === token) {
        delete cfg.token;
        delete cfg.userId;
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      }
    } catch {} // config 없으면 무시

    res.json({ ok: true });
  });

  // ── 관리자 초대 - 사용자 초대 ─────────────────────────────────────────────

  /**
   * POST /api/auth/invite
   * 관리자(dlaww@kicda.com)가 이메일로 사용자를 초대합니다.
   * 초대된 사용자는 팀(team) 플랜 혜택을 자동 부여받습니다.
   * @body {string} email - 초대할 사용자 이메일
   * @returns {{ ok: true } | { error: string }}
   */
  router.post('/auth/invite', (req, res) => {
    const token = req.headers.authorization || req.query.token; // 인증 토큰 추출
    const admin = verifyToken(token);                           // 토큰 검증
    if (!admin) return res.status(401).json({ error: 'unauthorized' });

    // 관리자 이메일인지 확인
    if (!ADMIN_EMAILS.includes((admin.email || '').toLowerCase().trim())) {
      return res.status(403).json({ error: 'admin only' });     // 관리자만 접근 가능
    }

    const { email } = req.body;                                 // 초대할 이메일
    if (!email) return res.status(400).json({ error: 'email required' });

    const result = inviteUser(admin.email, email);              // 초대 실행
    if (result.error) return res.status(400).json(result);      // 에러 시 400 반환
    res.json(result);                                           // 성공 응답
  });

  // ── 관리자 초대 - 초대 목록 조회 ──────────────────────────────────────────

  /**
   * GET /api/auth/invites
   * 관리자가 초대한 사용자 목록을 반환합니다.
   * @returns {{ invites: Array<{invitee_email, created_at}> } | { error: string }}
   */
  router.get('/auth/invites', (req, res) => {
    const token = req.headers.authorization || req.query.token; // 인증 토큰 추출
    const admin = verifyToken(token);                           // 토큰 검증
    if (!admin) return res.status(401).json({ error: 'unauthorized' });

    // 관리자 이메일인지 확인
    if (!ADMIN_EMAILS.includes((admin.email || '').toLowerCase().trim())) {
      return res.status(403).json({ error: 'admin only' });     // 관리자만 접근 가능
    }

    const invites = getAdminInvites(admin.email);               // 초대 목록 조회
    res.json({ invites });                                      // 목록 반환
  });

  return router;
}

module.exports = createRouter;
