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
