'use strict';
/**
 * vision-prefilter.js — 해독 전 "싼 신호" 선별 (Claude 호출 $0 구간)
 *
 * 목적: owner PC 소비측(스풀/서버큐/로컬)에서 Claude 를 부르기 전에, 캡처 메타(앱·창제목·트리거)만으로
 *   ① 비업무/저정보 화면(잠금·바탕화면·영상재생·설정창 등)을 버리고
 *   ② 전환 순간(앱/창 전환·입력완료)을 우선순위 상위로 올린다.
 *   픽셀 dedup(_isDupFrame)·시간창 컷(_triageSeen)과 겹치지 않는 "메타 기반" 1차 선별.
 *
 * 안전 원칙(품질 우선): 업무 가치가 조금이라도 의심되면 버리지 않는다. 명백한 비업무 화면만 컷.
 *   업무 키워드(nenova·ERP·엑셀·메일·카톡·견적…)가 제목/앱에 있으면 저정보 패턴이어도 통과.
 *   env VISION_PREFILTER=off 로 전체 비활성(기존 동작).
 */

// 명백한 비업무/저정보 화면 — 제목/앱 패턴. 오탐 시 업무 손실이므로 보수적으로만.
const LOW_INFO_RE = new RegExp(process.env.VISION_LOWINFO_RE ||
  '잠금 화면|lock ?screen|screensaver|화면 보호기|로그인 화면|sign ?in to|' +            // 잠금/로그인
  'youtube|넷플릭스|netflix|트위치|twitch|치지직|chzzk|watch\\?v=|동영상|비디오 재생|' +   // 영상 재생
  '설정$|windows 설정|제어판|control panel|시스템 설정|설정 -|settings$|' +               // 설정/제어판
  '새 탭|new tab|시작 페이지|빈 페이지|about:blank|바탕 ?화면|^desktop$'                   // 빈 탭/바탕화면
, 'i');

// 업무 가치 신호(이게 있으면 저정보 패턴이어도 통과) — worker의 HIGH_VALUE_RE 와 취지 동일.
const BIZ_RE = new RegExp(process.env.VISION_BIZ_RE ||
  'nenova|네노바|ecount|이카운트|erp|excel|엑셀|\\.xls|주문|출고|발주|견적|재고|정산|채권|채무|' +
  '무역|통관|검수|분배|kakao|카카오|카톡|sheets|docs|스프레드시트|구글시트|송장|배송|운송|택배|' +
  'invoice|인보이스|명세|청구|입금|출금|송금|결제|매출|매입|거래처|납품|수주|mail|메일|gmail|outlook|아웃룩'
, 'i');

// 전환/입력 순간 = 루틴 파악 가치 최대 → 상위. 주기/유휴성 트리거 = 하위(배치 상한에서 먼저 밀려남).
const TRIGGER_RANK = {
  app_switch: 0, 'fallback-appchange': 0, startup: 0,            // 전환(최우선)
  keyboard_done: 1, keyboard_flush: 1, mouse_click: 1, ctrl_print: 1, excel_formula: 1, manual: 1, tool_end: 1, file_write: 1, // 입력/행동
  title_change: 2, key_burst: 2, click_burst: 2,                 // 변화
  idle_result: 8, 'fallback-timer': 8, kakao_periodic: 9,        // 주기/유휴(최하위)
};
function triggerRank(trigger) {
  const r = TRIGGER_RANK[String(trigger || '')];
  return r == null ? 4 : r; // 미상 트리거 = 중간
}
function isLowValueTrigger(trigger) { return triggerRank(trigger) >= 8; }

// ── 조작 기반 선별(사장님 확정 2026-11-04) ───────────────────────────────────
// 기준 하나로 통일: 같은 app+창제목이 반복돼도 그 사이 "조작(클릭·타이핑·스크롤)"이
// 있었으면 작업이 진행된 것 → 해독 유지. 조작 없이 같은 창이면 과감히 누락.
// 단, 창 제목이 바뀌면(문서 전환 등) 조작 없어도 키가 새로 생겨 1장은 해독.
// 조작 증거: 조작성 트리거(클릭/키입력/수식확정/인쇄…) 또는 캡처에 붙은 recentClicks/lastClick.
const OP_TRIGGERS = new Set(['mouse_click', 'keyboard_done', 'keyboard_flush', 'click_burst', 'key_burst', 'excel_formula', 'ctrl_print', 'file_write', 'manual', 'tool_end', 'scroll']);
const OP_WINDOW_MS = Number(process.env.VISION_OP_WINDOW_MS) || 10 * 60 * 1000; // 같은 창 "조작 없음" 판정 시간창
const _opSeen = new Map(); // key(user|app|title) → 마지막 해독 캡처시각
function hasOperation(trigger, item) {
  if (OP_TRIGGERS.has(String(trigger || ''))) return true;
  if (item && Array.isArray(item.recentClicks) && item.recentClicks.length) return true;
  if (item && item.lastClick) return true;
  return false;
}
/**
 * 같은 창 반복을 조작 유무로 선별. key 는 user|app|title 권장.
 * @returns {{skip:boolean, reason:string}}
 */
function selectByOperation(key, trigger, item, atMs) {
  if (!ENABLED) return { skip: false, reason: 'prefilter_off' };
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const last = _opSeen.get(key);
  const seenRecently = last != null && Math.abs(at - last) < OP_WINDOW_MS;
  if (!seenRecently) { _opSeen.set(key, at); _trim(_opSeen); return { skip: false, reason: 'new_or_title_change' }; } // 새 창/제목 → 1장 해독
  if (hasOperation(trigger, item)) { _opSeen.set(key, at); return { skip: false, reason: 'operated' }; }             // 조작 있었음 → 유지
  stats.skipNoOp++; _bump('same_window_no_op');
  return { skip: true, reason: 'same_window_no_op' };                                                               // 같은 창·무조작 → 누락
}
function _trim(m) { if (m.size > 1000) { const k = m.keys().next().value; m.delete(k); } }
function _resetState() { _opSeen.clear(); } // 테스트용

const ENABLED = process.env.VISION_PREFILTER !== 'off';

// 측정용 스킵 사유 누적(오너 소비측). per-batch 로그 + ~/.orbit 스냅샷으로 전/후 비교.
const stats = { total: 0, skipLowInfo: 0, skipNoOp: 0, passBiz: 0, byReason: {} };
function _bump(reason) { stats.byReason[reason] = (stats.byReason[reason] || 0) + 1; }

/**
 * 메타만으로 해독 가치 판정. 이미지/Claude 불필요.
 * @returns {{skip:boolean, reason:string, rank:number}}
 */
function evaluate(app, windowTitle, trigger) {
  stats.total++;
  const rank = triggerRank(trigger);
  if (!ENABLED) return { skip: false, reason: 'prefilter_off', rank };
  const hay = `${app || ''} ${windowTitle || ''}`;
  if (BIZ_RE.test(hay)) { stats.passBiz++; return { skip: false, reason: 'biz_keyword', rank: Math.min(rank, 2) }; } // 업무신호 = 통과 + 승격
  if (LOW_INFO_RE.test(hay)) { stats.skipLowInfo++; _bump('low_info'); return { skip: true, reason: 'low_info_screen', rank }; }
  return { skip: false, reason: 'ok', rank };
}

function snapshot() { return JSON.parse(JSON.stringify(stats)); }
function logLine() {
  return `prefilter total=${stats.total} 저정보컷=${stats.skipLowInfo} 무조작컷=${stats.skipNoOp} 업무통과=${stats.passBiz}` +
    (Object.keys(stats.byReason).length ? ` 사유=${JSON.stringify(stats.byReason)}` : '');
}

module.exports = { evaluate, selectByOperation, hasOperation, triggerRank, isLowValueTrigger, snapshot, logLine, _resetState, ENABLED };
