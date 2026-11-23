'use strict';
/**
 * pc-link-cache.js — orbit_pc_links(hostname → user_id) 조회 결과의 짧은 메모리 캐시.
 *
 * 왜: /api/hook 은 요청마다 orbit_pc_links 를 읽어 번호를 정한다. PG 풀이 막히면(연결 대기 5초 초과)
 *     그 조회가 실패하고, 예전 코드는 그대로 넘어가(fail-open) 토큰 번호나 임시 번호 pc_<hostname> 로 저장했다.
 *     (2026-11-23 실측: 13분 동안 "timeout exceeded when trying to connect" 1,100건+)
 *
 * 동작:
 *   - 조회 성공값을 TTL 동안 재사용(풀 부담 감소). 매핑 없음(null)도 짧게 기억.
 *   - 조회 실패 시 마지막 성공값을 돌려준다(source='stale'). 한 번도 성공한 적 없으면 source='error'.
 *   - 같은 hostname 동시 조회는 1건으로 합친다(single-flight).
 *   - 실패 직후 backoff 동안은 DB 를 다시 두드리지 않는다.
 * 호출자는 절대 예외를 받지 않는다.
 */

const DEFAULTS = {
  ttlMs: 60 * 1000,          // 매핑 있음: 60초
  negativeTtlMs: 30 * 1000,  // 매핑 없음: 30초 (새로 등록된 PC 를 빨리 반영)
  failBackoffMs: 10 * 1000,  // 조회 실패 후 재시도 간격
  maxEntries: 5000,
  logEveryMs: 60 * 1000,     // 같은 hostname 실패 로그 간격
};

function createPcLinkCache(options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const now = typeof opt.now === 'function' ? opt.now : Date.now;
  const entries = new Map();   // hostname → { userId|null, at }
  const inflight = new Map();  // hostname → Promise
  const failedAt = new Map();  // hostname → 마지막 실패 시각
  const loggedAt = new Map();  // hostname → 마지막 로그 시각
  const stats = { hit: 0, db: 0, stale: 0, error: 0, warmed: 0, warmedAt: null };

  function _remember(hostname, userId) {
    if (!entries.has(hostname) && entries.size >= opt.maxEntries) {
      entries.delete(entries.keys().next().value); // 가장 오래 전에 넣은 것부터 버림
    }
    entries.set(hostname, { userId: userId || null, at: now() });
    failedAt.delete(hostname);
  }

  function _fallback(hostname, err) {
    const e = entries.get(hostname);
    if (e) {
      stats.stale++;
      return { userId: e.userId, source: 'stale', error: err || null };
    }
    stats.error++;
    return { userId: null, source: 'error', error: err || null };
  }

  /**
   * @returns {Promise<{userId: string|null, source: 'cache'|'db'|'stale'|'error'|'skip', error?: string}>}
   *   cache/db = 믿을 수 있는 값, stale = 조회 실패라 마지막 성공값, error = 조회 실패 + 기억 없음
   */
  async function resolve(pool, hostname) {
    if (!hostname || !pool || typeof pool.query !== 'function') return { userId: null, source: 'skip' };
    const e = entries.get(hostname);
    const t = now();
    if (e && t - e.at < (e.userId ? opt.ttlMs : opt.negativeTtlMs)) {
      stats.hit++;
      return { userId: e.userId, source: 'cache' };
    }
    const f = failedAt.get(hostname);
    if (f && t - f < opt.failBackoffMs) return _fallback(hostname, 'backoff');

    let p = inflight.get(hostname);
    if (!p) {
      p = (async () => {
        try {
          const { rows } = await pool.query(
            'SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1', [hostname]
          );
          const userId = (rows && rows[0] && rows[0].user_id) || null;
          _remember(hostname, userId);
          stats.db++;
          return { userId, source: 'db' };
        } catch (err) {
          failedAt.set(hostname, now());
          return _fallback(hostname, (err && err.message) || 'query failed');
        } finally {
          inflight.delete(hostname);
        }
      })();
      inflight.set(hostname, p);
    }
    return p;
  }

  /** 부팅 직후 전체 매핑을 한 번에 채운다(쿼리 1건). 성공 시 행 수, 실패 시 -1. */
  async function warm(pool) {
    if (!pool || typeof pool.query !== 'function') return -1;
    try {
      const { rows } = await pool.query('SELECT hostname, user_id FROM orbit_pc_links');
      for (const r of rows || []) if (r && r.hostname) _remember(r.hostname, r.user_id);
      stats.warmed = (rows || []).length;
      stats.warmedAt = new Date(now()).toISOString();
      return stats.warmed;
    } catch (_) {
      return -1;
    }
  }

  /** 매핑을 쓴 직후 호출 — 다음 요청이 DB 값을 다시 읽게 한다. */
  function invalidate(hostname) {
    if (hostname) { entries.delete(hostname); failedAt.delete(hostname); }
  }

  /** 마지막으로 알고 있는 값(조회 없음). 모르면 undefined, 매핑 없음이면 null. */
  function peek(hostname) {
    const e = entries.get(hostname);
    return e ? e.userId : undefined;
  }

  /** 같은 hostname 의 실패 로그를 logEveryMs 에 1번만 남기기 위한 판정. */
  function shouldLog(hostname) {
    const t = now();
    if (loggedAt.has(hostname) && t - loggedAt.get(hostname) < opt.logEveryMs) return false;
    if (!loggedAt.has(hostname) && loggedAt.size >= opt.maxEntries) loggedAt.clear();
    loggedAt.set(hostname, t);
    return true;
  }

  function getStats() {
    return { ...stats, size: entries.size };
  }

  return { resolve, warm, invalidate, peek, shouldLog, getStats };
}

/**
 * 번호 결정(순수 함수) — /api/hook · excel-ingest 공용.
 * @param {string|null} tokenUserId 토큰으로 확인된 번호(없으면 null)
 * @param {string} deviceId hostname
 * @param {{userId: string|null, source: string}} link resolve() 결과
 * @returns {{userId: string, overridden: boolean, degraded: boolean}}
 *   degraded = pc_links 를 못 읽었고 기억도 없어 토큰/임시 번호를 그대로 쓴 경우(로그 대상)
 */
function decideUserId(tokenUserId, deviceId, link) {
  const base = tokenUserId || (deviceId ? `pc_${deviceId}` : 'local');
  const l = link || { userId: null, source: 'skip' };
  if (l.userId && l.userId !== base) return { userId: l.userId, overridden: true, degraded: false };
  return { userId: base, overridden: false, degraded: l.source === 'error' };
}

/**
 * daemon-health 표시용(순수 함수) — 임시 번호(pc_<hostname>) 줄을 본 목록에서 떼어 낸다.
 * 떼는 조건: 같은 hostname 의 진짜 번호 줄이 이미 있거나, peek(hostname) 이 진짜 번호를 알고 있을 때.
 * 등록된 적 없는 PC 의 pc_ 줄은 본 목록에 그대로 둔다(새 PC 를 놓치지 않게).
 */
function splitProvisionalDaemons(list, peek) {
  const isTemp = id => /^pc_/.test(String(id || ''));
  const realHosts = new Set();
  for (const d of list || []) if (!isTemp(d.userId) && d.hostname) realHosts.add(String(d.hostname).toLowerCase());
  const daemons = [];
  const provisional = [];
  for (const d of list || []) {
    if (!isTemp(d.userId)) { daemons.push(d); continue; }
    const host = d.hostname || String(d.userId).slice(3);
    const known = typeof peek === 'function' ? peek(host) : null;
    const mapped = known && !isTemp(known) && known !== 'local' ? known : null;
    if (mapped || realHosts.has(String(host).toLowerCase())) provisional.push({ ...d, mappedUserId: mapped });
    else daemons.push(d);
  }
  return { daemons, provisional };
}

module.exports = { createPcLinkCache, decideUserId, splitProvisionalDaemons, shared: createPcLinkCache() };
