'use strict';
/**
 * work-action-digest.js — nenova.exe 행동순서(work.action, win-action-spy) → 분석용 요약
 *
 * 원본은 버튼/칸 단위 접근성 이벤트(분당 수십~백 건)라 그대로는 분석에 못 쓴다.
 * 승격(ops-ontology promote)에서 같은 사람·같은 시간창의 다른 증거(키보드·화면해독·클립보드·주문)와
 * 한 Action 으로 묶을 때, 이 모듈이 그 창의 행동순서를 아래로 압축한다.
 *   screen  : 어느 화면(탭/폼)에서        — "신규 주문 등록", "견적서 관리"
 *   steps   : 무슨 순서로 눌렀나           — ["조회","저장","확정"]
 *   saved   : 저장 성공 메시지 횟수        — 결과 검증(ERP 대조 키)
 *   confirmed: 확정 누름 횟수
 *   errors  : 경고/오류 메시지 원문(짧게)
 *   fields  : 손댄 칸(그리드 열·필터)       — ["단 수량","필터:Prod Name"]
 *   picks   : 고른 값(국가·차수 등)         — ["호주","2026 47"]
 * 입력값(get_accValue)은 원본에도 없다(개인정보 원칙) — 값은 키보드 typedChars 로만 규모 파악.
 */

const MAIN_TITLE = /^화훼 관리 프로그램/;
const NOISE_NAMES = new Set(['MainView', 'Vertical', 'Horizontal', 'Form1', '시스템', 'Open', 'Close', 'OK', '편집', 'Clear Filter']);
const isLayout = (n) => /^layoutControl/i.test(n) || /^(panel|split|group)Control/i.test(n);
const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^(\S) (\S)$/, '$1$2').trim(); // "저  장" → "저장"
const OK_MSG = /저장되었습니다|완료되었습니다|처리되었습니다/;
const ERR_MSG = /오류|실패|없습니다|확인하세요|확인 바랍니다|입력하세요|선택하세요|중복|초과|부족/;

// 화면(탭/폼) 이름 판정: 탭(r60) 포커스 또는 메인 아닌 FOREGROUND 폼
function screenOf(a) {
  const n = norm(a.name);
  if (!n || NOISE_NAMES.has(n) || isLayout(n)) return '';
  if (a.role === 'r60' && (a.ev === 'FOCUS' || a.ev === 'SELECTION')) return n;
  if (a.ev === 'FOREGROUND' && !MAIN_TITLE.test(n)) return n;
  return '';
}

/**
 * @param {Array<{t?:string, ev:string, role:string, name:string}>} acts 시간순
 * @returns {{screen:string, screens:string[], steps:string[], saved:number, confirmed:number, errors:string[], fields:string[], picks:string[], n:number}}
 */
function digest(acts) {
  const out = { screen: '', screens: [], steps: [], saved: 0, confirmed: 0, errors: [], fields: [], picks: [], n: acts.length };
  const tms = acts.map(a => (a.t ? Date.parse(a.t) : NaN));
  // 콤보 목록 펼침 폭주: 1.5초 안 SELECTION 4건 이상 = 목록 항목 나열(선택 아님) → 값으로 쓰지 않음
  const burst = new Set();
  // (사이에 SHOW/FOCUS 가 끼어도 SELECTION 끼리만 2초 창으로 센다)
  const sel = acts.map((a, i) => (a.ev === 'SELECTION' ? i : -1)).filter(i => i >= 0);
  for (let x = 0; x < sel.length; x++) {
    let y = x; while (y + 1 < sel.length && !(tms[sel[y + 1]] - tms[sel[x]] > 2000)) y++;
    if (y - x + 1 >= 4) for (let k = x; k <= y; k++) burst.add(sel[k]);
  }
  const pushU = (arr, v, cap) => { if (v && arr[arr.length - 1] !== v && arr.length < cap) arr.push(v); };
  const addSet = (arr, v, cap) => { if (v && !arr.includes(v) && arr.length < cap) arr.push(v); };
  acts.forEach((a, i) => {
    const n = norm(a.name);
    if (!n) return;
    const sc = screenOf(a);
    if (sc) { out.screen = sc; addSet(out.screens, sc, 8); return; }
    if (a.role === 'statictext' || a.role === 'text' && a.ev === 'FOCUS' && /[다요]\.?$/.test(n)) {
      if (OK_MSG.test(n)) { out.saved++; return; }
      if (ERR_MSG.test(n)) { addSet(out.errors, n.slice(0, 60), 5); return; }
    }
    if (NOISE_NAMES.has(n) || isLayout(n) || MAIN_TITLE.test(n)) return;
    // 칸: "단 수량 row 1" → "단 수량", "Auto filter row column Prod Name"/"품목명(색상) filter row" → "필터:…"
    let m = n.match(/^Auto filter row column (.+)$/) || n.match(/^(.+?) filter row$/);
    if (m) { addSet(out.fields, '필터:' + m[1], 10); return; }
    m = n.match(/^(.+?) row \d+$/);
    if (m) { addSet(out.fields, m[1], 10); return; }
    if (a.role === 'btn' && (a.ev === 'FOCUS' || a.ev === 'STATECHANGE')) {
      if (n === '확정') out.confirmed++;
      pushU(out.steps, n, 25);
      return;
    }
    if (a.ev === 'SELECTION' && /^r2[48]$|^list$|^combo$/.test(a.role)) {
      if (!burst.has(i)) addSet(out.picks, n.slice(0, 30), 8);
      return;
    }
    if (a.ev === 'MENUPOPUP' || ((a.role === 'r7' || a.role === 'r2') && a.ev !== 'SHOW')) pushU(out.steps, '메뉴:' + n.slice(0, 20), 25);
  });
  // 연속 같은 버튼 반복(저장→OK→저장) 은 pushU 로 이미 접힘. 확정 횟수는 STATECHANGE 중복 → 최대 steps 등장수로 보정
  out.confirmed = Math.min(out.confirmed, out.steps.filter(s => s === '확정').length || out.confirmed);
  return out;
}

// Action 문장(화면해독 activity 가 없을 때의 대체)
function sentence(d) {
  if (!d || (!d.steps.length && !d.screen)) return '';
  const st = d.steps.slice(0, 6).join('→');
  const tail = [d.saved ? `저장 ${d.saved}회` : '', d.confirmed ? `확정 ${d.confirmed}회` : '', d.errors.length ? `경고 ${d.errors.length}건` : ''].filter(Boolean).join(' · ');
  return `${d.screen || 'nenova'}${st ? ': ' + st : ''}${tail ? ' (' + tail + ')' : ''}`.slice(0, 200);
}

module.exports = { digest, sentence, screenOf, norm };
