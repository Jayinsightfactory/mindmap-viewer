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

const ENABLED = process.env.VISION_PREFILTER !== 'off';

// 측정용 스킵 사유 누적(오너 소비측). per-batch 로그 + ~/.orbit 스냅샷으로 전/후 비교.
const stats = { total: 0, skipLowInfo: 0, passBiz: 0, byReason: {} };
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
  return `prefilter total=${stats.total} 저정보컷=${stats.skipLowInfo} 업무통과=${stats.passBiz}` +
    (Object.keys(stats.byReason).length ? ` 사유=${JSON.stringify(stats.byReason)}` : '');
}

module.exports = { evaluate, triggerRank, isLowValueTrigger, snapshot, logLine, ENABLED };
