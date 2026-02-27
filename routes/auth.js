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
 * @param {object} deps.auth - { register, login, verifyToken }
 * @returns {express.Router}
 */
function createRouter(deps) {
  const { auth } = deps;
  const { register: authRegister, login: authLogin, verifyToken } = auth;

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
    res.json({ user });
  });

  return router;
}

module.exports = createRouter;
