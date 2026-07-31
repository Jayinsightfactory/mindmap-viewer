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

// [2026-07-31] 자동화 일일 사용 상한 — 7일창 utilization이 "오늘 자정 대비" DAILY_CAP %p 이상
// 오르면 자동화 워커 대기(내일 리셋). 목적: 자동화가 하루에 구독의 10%(기본) 넘게 안 쓰게(사장님 지시).
// 주의: 7일창은 롤링이라 옛 사용분이 빠지며 순증이 실사용보다 작게 나올 수 있음(다소 관대). 그래도 상한 역할.
const DAILY_CAP_PCT = Number(process.env.ORBIT_CLI_DAILY_CAP_PCT) || 10;
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

function _readToken() {
  try {
    const cr = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    return (cr.claudeAiOauth && cr.claudeAiOauth.accessToken) || cr.accessToken || null;
  } catch { return null; }
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

  const token = _readToken();
  let result;
  if (!token) {
    result = { pause: false, utilization: null, window: '', resetsAt: null, reason: 'oauth 토큰 없음(fail-open)' };
  } else {
    const u = await _fetchUsage(token);
    const five = u && u.five_hour ? Number(u.five_hour.utilization) : null;
    const week = u && u.seven_day ? Number(u.seven_day.utilization) : null;
    if (five == null && week == null) {
      result = { pause: false, utilization: null, window: '', resetsAt: null, reason: 'usage 조회 실패(fail-open)' };
    } else {
      const useFive = (five || 0) >= (week || 0);
      const util = useFive ? five : week;
      const resetsAt = useFive ? (u.five_hour && u.five_hour.resets_at) : (u.seven_day && u.seven_day.resets_at);
      const win = useFive ? '5시간창' : '7일창';
      // 일일 캡: 7일창이 오늘 자정 대비 DAILY_CAP %p 이상 올랐으면 자동화 대기(사용자 지시)
      let dailyPause = false, usedToday = null;
      if (week != null) {
        const base = _dailyBaseline(week);
        usedToday = Math.max(0, +(week - base).toFixed(1));
        if (usedToday >= DAILY_CAP_PCT) dailyPause = true;
      }
      const thPause = util >= threshold;
      result = {
        pause: thPause || dailyPause, utilization: util, window: win, resetsAt: resetsAt || null,
        usedToday, dailyCap: DAILY_CAP_PCT,
        reason: dailyPause
          ? `자동화 일일 사용 ${usedToday}%p(7일창) ≥ ${DAILY_CAP_PCT}%p 상한 — 내일까지 대기(자동화 몫 제한)`
          : thPause
          ? `구독 사용량 ${util}%(${win}) ≥ ${threshold}% — 사용자 몫 ${reserve}% 보전 위해 대기 (리셋 ${resetsAt || '?'})`
          : `구독 사용량 ${util}%(${win}) < ${threshold}% · 오늘 자동화 ${usedToday == null ? '?' : usedToday}%p/${DAILY_CAP_PCT}%p — 진행`,
      };
    }
  }
  _cache = { at: Date.now(), result };
  return result;
}

module.exports = { checkQuota };
