'use strict';
/**
 * src/intelligence/adapters/erp-client.js
 * ─────────────────────────────────────────────────────────────────────────────
 * nenova-erp-ui (Railway) HTTP 클라이언트
 *
 * - JWT 자동 로그인/갱신 (8h 만료 → 7h 시점 사전 갱신)
 * - Bearer Authorization 헤더 자동 부착
 * - read-only 호출만 (GET 전용 헬퍼). POST/PATCH/DELETE 노출 안 함.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BASE_URL = process.env.NENOVA_ERP_URL || 'https://nenova-erp-production.up.railway.app';
const USER     = process.env.NENOVA_ERP_USER || '';
const PASS     = process.env.NENOVA_ERP_PASS || '';

// 7h = 사전 갱신 임계값 (8h 만료 1시간 전)
const TOKEN_REFRESH_MS = 7 * 60 * 60 * 1000;

let _token = null;
let _tokenIssuedAt = 0;
let _refreshing = null;          // in-flight Promise (동시 호출 합류)

async function _login() {
  if (!USER || !PASS) {
    throw new Error('[erp-client] NENOVA_ERP_USER / NENOVA_ERP_PASS 환경변수 누락');
  }
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER, password: PASS }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.success || !json.token) {
    throw new Error(`[erp-client] 로그인 실패 (${res.status}): ${json.error || res.statusText}`);
  }
  _token = json.token;
  _tokenIssuedAt = Date.now();
  return _token;
}

async function _ensureToken() {
  const fresh = _token && (Date.now() - _tokenIssuedAt) < TOKEN_REFRESH_MS;
  if (fresh) return _token;
  if (_refreshing) return _refreshing;
  _refreshing = _login().finally(() => { _refreshing = null; });
  return _refreshing;
}

/**
 * GET 호출 — read-only.
 * @param {string} path  '/api/orders' 같이 leading slash 포함
 * @param {object} params  쿼리 파라미터
 * @returns {Promise<any>} 파싱된 JSON
 */
async function get(path, params = {}) {
  const token = await _ensureToken();
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  // 401 → 1회 자동 재로그인 후 재시도
  if (res.status === 401) {
    _token = null;
    const newToken = await _ensureToken();
    const retry = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${newToken}` },
    });
    if (!retry.ok) throw new Error(`[erp-client] GET ${path} 실패 (${retry.status})`);
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[erp-client] GET ${path} 실패 (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** 토큰 강제 무효화 (테스트/순환 시) */
function invalidate() {
  _token = null;
  _tokenIssuedAt = 0;
}

/** 현재 토큰 상태 (디버그) */
function status() {
  return {
    hasToken: !!_token,
    ageMs: _token ? Date.now() - _tokenIssuedAt : null,
    baseUrl: BASE_URL,
    user: USER || '(unset)',
  };
}

module.exports = { get, invalidate, status };
