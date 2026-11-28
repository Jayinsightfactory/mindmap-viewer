'use strict';
/**
 * admin-gate.js — 관리자 전용 주소의 자격 확인
 *
 * server.js 의 `_visionThumbAdminOk`(캡처 썸네일 보호, 2026-09-28)와 똑같은 규칙을 한 곳에 모은 것.
 *   - 자격을 받는 곳: `Authorization: Bearer <토큰>` 또는 `?token=<토큰>`
 *     (?token 은 <img>·링크처럼 헤더를 못 붙이는 자리용 — 기존 동작 유지)
 *   - 통과하는 토큰: 마스터 토큰(MASTER_TOKEN) · 관리자 API 토큰(ADMIN_TOKENS/~/.orbit-config.json)
 *                   · 관리자 이메일 계정의 사용자 토큰(ADMIN_EMAILS, PG 토큰 포함)
 *   - 401 = 토큰 없음, 403 = 토큰은 있으나 권한 없음
 *
 * 판단에 쓰는 함수는 밖에서 넣는다(server.js 의 env·isAdminReqAsync). 그래야 서버를 띄우지 않고도 검증할 수 있다.
 * 자격 판단이 예외로 깨지면 통과가 아니라 거부(403)로 떨어진다 — 빈 값·오류로 열리지 않게.
 */

function tokenFrom(req) {
  const bearer = String((req && req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;
  return String((req && req.query && req.query.token) || '').trim();
}

function createAdminGate({ isMasterToken, isAdminToken, isAdminReqAsync } = {}) {
  async function check(req) {
    const raw = tokenFrom(req);
    if (!raw) return 401;
    try {
      if (typeof isMasterToken === 'function' && isMasterToken(raw)) return 0;
      if (typeof isAdminToken === 'function' && isAdminToken(raw)) return 0;
    } catch { /* 판단 함수가 깨지면 아래 사용자 토큰 확인으로 넘어간다 */ }
    // ?token= 으로 온 토큰도 사용자 토큰으로 확인되게 헤더를 맞춰 준다(isAdminReqAsync 는 헤더만 본다).
    if (typeof isAdminReqAsync === 'function') {
      const asHeader = { headers: Object.assign({}, req && req.headers, { authorization: 'Bearer ' + raw }), query: (req && req.query) || {} };
      try { if (await isAdminReqAsync(asHeader)) return 0; } catch { /* 아래에서 거부 */ }
    }
    return 403;
  }

  // app.get(path, gate.middleware) / app.use(path, gate.middleware) 형태로 그대로 끼운다.
  async function middleware(req, res, next) {
    const code = await check(req);
    if (code) return res.status(code).json({ error: code === 401 ? 'unauthorized' : 'admin only' });
    next();
  }

  return { check, middleware };
}

module.exports = createAdminGate;
module.exports.createAdminGate = createAdminGate;
module.exports.tokenFrom = tokenFrom;
