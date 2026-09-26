'use strict';
/**
 * event-value-judge.js — /api/hook 로 들어오는 이벤트를 "저장할 가치가 있나"로 판정(Jev식 bool 판단, 규칙 단만).
 *   실측(2026-09-26, 2,000건 샘플): daemon.update 1,862건(93%) — 거의 전부 guardian "lifeline ok"가 PC마다 2분 간격으로 같은 내용 반복.
 *   그래프·온톨로지·분석 어디에도 안 쓰이고(NOISE_TYPES) 사후 purge 대상이면서도 PG insert·디스크·OOM 압력만 만든다.
 *   판정: 같은 PC의 같은 daemon.update(status+detail 동일)는 30분에 1건만 저장(첫 건과 상태 변화는 항상 저장 → health/알림 로직 무영향).
 *   그 외 타입은 전부 저장. 스킵 통계는 getStats()로 /api/costs 류에서 볼 수 있게.
 */
const WINDOW_MS = 30 * 60 * 1000;
const _last = new Map();   // host|status|detail → lastStoredAt
const _stats = { seen: 0, stored: 0, skipped: 0, byType: {} };

function decide(event) {
  _stats.seen++;
  const type = String(event && event.type || '');
  if (type !== 'daemon.update') { _stats.stored++; return { store: true, reason: 'not-noise-type', confidence: 1 }; }
  const d = (event && event.data) || {};
  const host = String(d.hostname || event.hostname || event.userId || '?');
  const status = String(d.status || ''); const detail = String(d.detail || '').slice(0, 60);
  const key = `${host}|${status}|${detail}`;
  const now = Date.now(); const prev = _last.get(key) || 0;
  if (now - prev < WINDOW_MS) { _stats.skipped++; _stats.byType[type] = (_stats.byType[type] || 0) + 1; return { store: false, reason: 'lifeline-repeat', confidence: 0.95, key }; }
  _last.set(key, now); if (_last.size > 5000) _last.delete(_last.keys().next().value);
  _stats.stored++; return { store: true, reason: prev ? 'window-elapsed' : 'first-or-changed', confidence: 0.95 };
}
function getStats() { const t = _stats.seen || 1; return { ..._stats, skippedShare: Math.round(1000 * _stats.skipped / t) / 10, windowMin: WINDOW_MS / 60000 }; }
module.exports = { decide, getStats, _test: { reset: () => { _last.clear(); Object.assign(_stats, { seen: 0, stored: 0, skipped: 0, byType: {} }); } } };
