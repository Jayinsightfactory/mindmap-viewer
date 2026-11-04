'use strict';
/**
 * cli-gate.js — Claude CLI 호출 동시성 게이트 ("해독 병렬화")
 *
 * 배경: vision-worker 는 지금까지 ~/.orbit/claude-cli.lock 파일락으로 claude -p 호출을
 *   전 구간 1개씩만 돌렸다(시간당 ~30건). 락을 둔 이유는 동시 호출 중 OAuth refreshToken
 *   회전 갱신이 겹치면 한쪽이 상대 토큰을 무효화해 로그인 전체가 날아가기 때문(메모리
 *   orbit-cli-oauth-expiry-quota-guard.md).
 *
 * 이 게이트는 "전 구간 직렬화" 대신 "토큰 안전 구간만 직렬화"한다:
 *   1) 평상시(토큰 만료 여유 있음): ORBIT_CLI_PARALLEL 까지 동시 호출 허용.
 *   2) 토큰 만료 임박(NEAR_EXPIRY_MS 이내): cross-process 리프레시락을 잡고
 *      가드(quota-guard._liveToken) 경유로 한 번만 갱신 → 그 사이 다른 호출은 대기.
 *      갱신은 ~/.claude/.credentials.json 을 직접 건드리지 않고 가드가 관리(회전 보존).
 *   3) 어떤 호출이든 401/invalid_grant 감지 시 즉시 전 워커를 병렬 1로 강등
 *      (~/.orbit/cli-parallel-demoted 플래그) + ~/.orbit/decode-boost.log 기록.
 *      로그인 전체 소실 방지 최우선 — 의심되면 안전하게 직렬로 되돌린다.
 *
 * 기본값은 "직렬(1)". ORBIT_CLI_PARALLEL 를 명시해야만 병렬이 된다 → 코드 배포만으로는
 * 동작이 바뀌지 않고(카나리 보존), 실험은 해당 워커 PID에만 env 로 적용한다.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ORBIT_DIR = path.join(os.homedir(), '.orbit');
const CREDS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const REFRESH_LOCK = path.join(ORBIT_DIR, 'claude-cli-refresh.lock'); // 토큰 리프레시 직렬화(cross-process)
const DEMOTE_FLAG = path.join(ORBIT_DIR, 'cli-parallel-demoted');      // 존재하면 전 워커 병렬 1 강등
const BOOST_LOG = path.join(ORBIT_DIR, 'decode-boost.log');

const NEAR_EXPIRY_MS = Number(process.env.ORBIT_CLI_NEAR_EXPIRY_MS) || 15 * 60 * 1000; // 만료 15분 이내 = 안전구간
const REFRESH_LOCK_STALE_MS = 60 * 1000; // 리프레시락 점유 60s 초과 = 죽은 프로세스로 보고 회수
const MAX_PARALLEL = 3;

function _log(msg) {
  try { fs.mkdirSync(ORBIT_DIR, { recursive: true }); fs.appendFileSync(BOOST_LOG, `${new Date().toISOString()} [cli-gate] ${msg}\n`); } catch {}
}
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isDemoted() { try { return fs.existsSync(DEMOTE_FLAG); } catch { return false; } }

// 401/invalid_grant 등 자격증명 이상 → 전 워커 병렬 1 강등(복구 전까지 유지). 로그인 소실 방지 최우선.
function demote(reason) {
  if (isDemoted()) return;
  try { fs.mkdirSync(ORBIT_DIR, { recursive: true }); fs.writeFileSync(DEMOTE_FLAG, `${new Date().toISOString()} ${reason || ''}`); } catch {}
  _log(`[DEMOTE] 병렬 강등(=1): ${reason || ''} — 복구는 플래그 삭제(${DEMOTE_FLAG})`);
  console.warn(`[cli-gate] ⚠ 자격증명 이상 감지 → 병렬 1 강등: ${reason || ''}`);
}

// claude -p 실패 출력에서 자격증명 이상 신호를 찾는다. 맞으면 demote + true 반환.
const _AUTH_RE = /invalid_grant|unauthorized|\b401\b|authentication_error|oauth|\/login|not logged in|credential|revoked|expired token|refresh token/i;
function detectAuthFailure(text) {
  if (!text) return false;
  if (_AUTH_RE.test(String(text))) { demote(`CLI 출력 자격증명 신호: ${String(text).slice(0, 160)}`); return true; }
  return false;
}

// 현재 허용 동시도. 미설정=1(직렬, 기존 동작과 동일). 강등 시 항상 1.
function parallelLimit() {
  if (isDemoted()) return 1;
  let n = parseInt(process.env.ORBIT_CLI_PARALLEL, 10);
  if (!Number.isFinite(n) || n < 1) n = 1;
  if (n > MAX_PARALLEL) n = MAX_PARALLEL;
  return n;
}

// ── 토큰 만료시각 — 호출 때마다 파일을 새로 읽는다(외부 갱신=mtime 변화 자동 반영) ──
function _credsExpiresAt() {
  try { return Number(JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')).claudeAiOauth?.expiresAt) || 0; }
  catch { return 0; }
}

function _tryRefreshLock() {
  try { const fd = fs.openSync(REFRESH_LOCK, 'wx'); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd); return true; }
  catch {
    try { const st = fs.statSync(REFRESH_LOCK); if (Date.now() - st.mtimeMs > REFRESH_LOCK_STALE_MS) { fs.unlinkSync(REFRESH_LOCK); return _tryRefreshLock(); } } catch {}
    return false;
  }
}
function _relRefreshLock() { try { fs.unlinkSync(REFRESH_LOCK); } catch {} }

// ── in-process 세마포어: 한 워커 안에서 동시 claude 호출을 parallelLimit 로 제한 ──
let _active = 0;
const _waiters = [];
function _take() {
  const limit = parallelLimit();
  if (_active < limit) { _active++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _give() {
  const w = _waiters.shift();
  if (w) { w(); return; } // 자리 넘겨받음(active 유지)
  _active = Math.max(0, _active - 1);
}

/**
 * CLI 호출 직전 호출. 동시도 한도까지 대기 후, 토큰 만료 임박이면 가드 리프레시를 직렬로 수행.
 * @returns {Promise<void>}
 */
async function acquire() {
  await _take();
  try {
    const exp = _credsExpiresAt();
    if (exp && exp - Date.now() < NEAR_EXPIRY_MS) {
      // 안전구간: 리프레시락을 잡을 때까지 대기(다른 호출이 리프레시 중이면 끝날 때까지). 최대 ~150s.
      let got = false;
      for (let i = 0; i < 300; i++) { if (_tryRefreshLock()) { got = true; break; } await _sleep(500); }
      try {
        const guard = require('./quota-guard');
        if (typeof guard._liveToken === 'function') await guard._liveToken(); // 가드 경유 갱신(크레덴셜 파일 직접 X)
        _log(`[REFRESH] 만료 임박(${Math.round((exp - Date.now()) / 1000)}s) — 가드 리프레시 후 진행${got ? '' : '(락 미획득, stale 추정)'}`);
      } catch (e) { _log(`[REFRESH] 실패(fail-open 진행): ${e.message}`); }
      finally { if (got) _relRefreshLock(); }
    }
  } catch { /* 안전구간 판정 실패해도 호출은 진행(fail-open) */ }
}

function release() { _give(); }

module.exports = { acquire, release, parallelLimit, isDemoted, demote, detectAuthFailure, NEAR_EXPIRY_MS };
