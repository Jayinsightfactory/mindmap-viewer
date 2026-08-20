'use strict';
/**
 * quota-guard.js — Claude Max 구독 사용량 가드 (owner PC 백그라운드 워커용)
 *
 * 목적: vision-worker / kakao-intel-worker 가 CLI(구독)로 분석을 돌릴 때
 *       사용자(사장님)가 쓸 구독 한도를 침범하지 않게 한다.
 * 정책: 사용량(5시간창/7일창 중 높은 쪽)이 임계(기본 70%)를 넘으면 워커는 대기
 *       → 사용자 몫 최소 30%를 항상 남긴다. 리셋 시각이 지나면 자동 재개.
 *
 * 방식: Claude Code CLI가 로컬에 보관·자동갱신하는 OAuth 토큰(~/.claude/.credentials.json)으로
 *       공식 usage 엔드포인트(GET api.anthropic.com/api/oauth/usage)를 조회.
 *       토큰은 anthropic API 외 어디에도 전송하지 않는다.
 * 실패 시 fail-open(허용): 조회 불가여도 워커를 세우지 않는다 — 진짜 한도 초과면
 *       CLI 호출 자체가 실패하므로 이중 안전망이 있다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const CACHE_MS = 5 * 60 * 1000; // 사용량 조회 캐시(엔드포인트 부하 방지)
let _cache = { at: 0, result: null };

// [2026-08-20 사장님 정책] 자동화 사용량 배분:
//  · 평상시: 자동화는 하루 DAILY_CAP_PCT(=5%p, 7일창 자정 대비) 이상 안 씀 + 7일창 (100-reserve)% 넘으면 대기.
//  · 주기 막바지(7일창 리셋 ENDWEEK_HOURS 이내)에 남은 quota가 ENDWEEK_RESERVE%p 초과면:
//    일일캡 무시하고 "10%만 남기고 전부 사용"(7일창 (100-ENDWEEK_RESERVE)%까지). 낭비될 quota 활용.
//  · 5시간창은 항상 FIVE_RESERVE%는 남김(대화 세션 급사 방지).
// 주의: 7일창은 롤링이라 순증이 실사용보다 작게 나올 수 있음(다소 관대). usedToday는 사용자+자동화 합산 근사치.
const DAILY_CAP_PCT = Number(process.env.ORBIT_CLI_DAILY_CAP_PCT) || 5;
const ENDWEEK_HOURS = Number(process.env.ORBIT_CLI_ENDWEEK_HOURS) || 24;   // 리셋 임박 판정(시간)
const ENDWEEK_RESERVE = Number(process.env.ORBIT_CLI_ENDWEEK_RESERVE_PCT) || 10; // 막바지에 남길 %
const FIVE_RESERVE = Number(process.env.ORBIT_CLI_FIVE_RESERVE_PCT) || 10; // 5시간창 최소 여유 %
const _DAILY_STATE = path.join(os.homedir(), '.orbit', 'quota-daily.json');
function _dailyBaseline(weekUtil) {
  const today = new Date().toISOString().slice(0, 10); // 로컬 아님 UTC — 일 경계 일관성(리셋 튐 방지)
  let st = {};
  try { st = JSON.parse(fs.readFileSync(_DAILY_STATE, 'utf8')); } catch {}
  if (st.date !== today || typeof st.base !== 'number') {
    st = { date: today, base: weekUtil };
    try { fs.mkdirSync(path.dirname(_DAILY_STATE), { recursive: true }); fs.writeFileSync(_DAILY_STATE, JSON.stringify(st)); } catch {}
  }
  return st.base;
}

// [2026-08-20] 토큰 자동 리프레시. 원인: ~/.claude/.credentials.json의 accessToken이 만료돼도
// (CLI가 자격증명을 다른 곳에 보관하면 이 파일이 방치됨) 가드가 usage를 못 읽고 fail-open →
// 워커가 사용자 몫까지 다 씀. refreshToken(수명 김)으로 살아있는 토큰을 얻는다. CLI 파일은 건드리지 않고,
// 회전된 refresh 토큰만 ~/.orbit/quota-oauth.json에 별도 보관(재시작 후에도 리프레시 가능).
const OAUTH_CLIENT_ID = process.env.ORBIT_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const _OAUTH_STATE = path.join(os.homedir(), '.orbit', 'quota-oauth.json');
let _tok = { access: null, expMs: 0, refresh: null };

function _readCliOauth() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')).claudeAiOauth || {}; }
  catch { return {}; }
}
function _refresh(refreshToken) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID });
    const req = https.request({ hostname: 'console.anthropic.com', path: '/v1/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 15000 },
      r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { const j = JSON.parse(d); if (j && j.access_token) return resolve(j); } catch {} resolve(null); }); });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}
// 살아있는 accessToken 반환(필요 시 리프레시). 실패하면 null(가드는 fail-open 유지).
async function _liveToken() {
  const now = Date.now();
  if (_tok.access && _tok.expMs - now > 60000) return _tok.access;   // 캐시된 유효 토큰
  const cli = _readCliOauth();
  const fileExp = Number(cli.expiresAt) || 0;
  if (cli.accessToken && fileExp - now > 60000) {                    // CLI 파일 토큰이 아직 유효하면 그대로
    _tok = { access: cli.accessToken, expMs: fileExp, refresh: cli.refreshToken };
    return _tok.access;
  }
  // 만료 → refreshToken으로 갱신(별도 저장분 우선, 없으면 CLI 파일)
  let rt = _tok.refresh;
  if (!rt) { try { rt = JSON.parse(fs.readFileSync(_OAUTH_STATE, 'utf8')).refresh; } catch {} }
  if (!rt) rt = cli.refreshToken;
  if (!rt) return null;
  const j = await _refresh(rt);
  if (!j) return null;
  _tok = { access: j.access_token, expMs: now + (Number(j.expires_in) || 28800) * 1000, refresh: j.refresh_token || rt };
  if (j.refresh_token) { try { fs.mkdirSync(path.dirname(_OAUTH_STATE), { recursive: true }); fs.writeFileSync(_OAUTH_STATE, JSON.stringify({ refresh: j.refresh_token, at: now })); } catch {} }
  return _tok.access;
}

function _fetchUsage(token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/api/oauth/usage', method: 'GET',
      headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
      timeout: 10000,
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * @param {number} reservePct 사용자 몫으로 남길 % (기본 30 → 워커는 70%까지만 사용)
 * @returns {Promise<{pause:boolean, utilization:number|null, window:string, resetsAt:string|null, reason:string}>}
 */
async function checkQuota(reservePct) {
  const reserve = Number(process.env.ORBIT_CLI_RESERVE_PCT) || reservePct || 30;
  const threshold = 100 - reserve;
  if (Date.now() - _cache.at < CACHE_MS && _cache.result) return _cache.result;

  const token = await _liveToken();
  let result;
  if (!token) {
    result = { pause: false, utilization: null, window: '', resetsAt: null, reason: 'oauth 토큰 없음/리프레시 실패(fail-open)' };
  } else {
    const u = await _fetchUsage(token);
    const five = u && u.five_hour ? Number(u.five_hour.utilization) : null;
    const week = u && u.seven_day ? Number(u.seven_day.utilization) : null;
    if (five == null && week == null) {
      result = { pause: false, utilization: null, window: '', resetsAt: null, reason: 'usage 조회 실패(fail-open)' };
    } else {
      // ── 오늘 자동화 사용(자정 대비 7일창 순증, 사용자+자동화 합산 근사) ──
      let usedToday = null;
      if (week != null) { const base = _dailyBaseline(week); usedToday = Math.max(0, +(week - base).toFixed(1)); }
      // ── 주기 막바지 판정: 7일창 리셋 임박 + 남은 quota가 ENDWEEK_RESERVE 초과 ──
      const weekReset = (u.seven_day && u.seven_day.resets_at) ? new Date(u.seven_day.resets_at).getTime() : null;
      const hoursToReset = weekReset ? (weekReset - Date.now()) / 3600000 : 999;
      const weekRemaining = week != null ? +(100 - week).toFixed(1) : null;
      const endweek = week != null && hoursToReset <= ENDWEEK_HOURS && weekRemaining > ENDWEEK_RESERVE;

      // ── 대기 판정 ──
      // 5시간창은 항상 FIVE_RESERVE 남김(세션 급사 방지)
      const fivePause = five != null && five >= (100 - FIVE_RESERVE);
      let weekPause;
      if (week == null) weekPause = false;
      else if (endweek) weekPause = week >= (100 - ENDWEEK_RESERVE);            // 막바지: 10%만 남기고 전부 사용
      else weekPause = (usedToday >= DAILY_CAP_PCT) || (week >= threshold);     // 평상시: 일일 5%캡 + 70% 상한
      const pause = fivePause || weekPause;

      // 보고용 대표 창
      const useFive = five != null && (week == null || five >= week);
      const util = useFive ? five : week;
      const win = useFive ? '5시간창' : '7일창';
      const resetsAt = useFive ? (u.five_hour && u.five_hour.resets_at) : (u.seven_day && u.seven_day.resets_at);
      const mode = endweek ? '막바지버스트' : '평상시';
      const reason = fivePause
        ? `5시간창 ${five}% ≥ ${100 - FIVE_RESERVE}% — 세션 보호 대기 (리셋 ${(u.five_hour && u.five_hour.resets_at) || '?'})`
        : (weekPause && endweek)
        ? `막바지: 7일창 ${week}% ≥ ${100 - ENDWEEK_RESERVE}% — ${ENDWEEK_RESERVE}%만 남기고 소진, 대기`
        : (weekPause && usedToday != null && usedToday >= DAILY_CAP_PCT)
        ? `자동화 일일 ${usedToday}%p(7일창) ≥ ${DAILY_CAP_PCT}%p 상한 — 내일까지 대기`
        : weekPause
        ? `7일창 ${week}% ≥ ${threshold}% — 사용자 몫 ${reserve}% 보전 대기 (리셋 ${(u.seven_day && u.seven_day.resets_at) || '?'})`
        : endweek
        ? `막바지버스트: 7일창 ${week}%(남은 ${weekRemaining}%p, 리셋 ${Math.round(hoursToReset)}h) — ${ENDWEEK_RESERVE}%까지 사용 진행`
        : `7일창 ${week}%·5시간창 ${five == null ? '?' : five}% · 오늘 ${usedToday == null ? '?' : usedToday}%p/${DAILY_CAP_PCT}%p — 진행`;

      result = {
        pause, utilization: util, window: win, resetsAt: resetsAt || null,
        usedToday, dailyCap: DAILY_CAP_PCT, mode, endweek,
        weekUtil: week, fiveUtil: five, weekRemaining, hoursToReset: Math.round(hoursToReset), reason,
      };
    }
  }
  _cache = { at: Date.now(), result };
  return result;
}

module.exports = { checkQuota };
