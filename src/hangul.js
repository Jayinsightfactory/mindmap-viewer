'use strict';
/**
 * src/hangul.js — 두벌식 QWERTY → 한글 역변환 (공용)
 * ─────────────────────────────────────────────────────────────────────────────
 * 키보드 훅(uiohook)이 IME 조합 전 물리키를 잡아서 inputText가 'rhksfuswk'처럼 저장됨.
 * 이를 사람이 읽는 한글('관련자')로 되돌린다 — 분석·검색·자동화 후보 가독용.
 * work-logs.html 클라이언트 토글 / work-learner.js 내부 함수와 동일 로직을 서버 공용으로 추출.
 * (2026-08-10, inputText 한글화: 조회 API·분석 워커가 QWERTY 원본 대신 한글을 쓰게)
 * (2026-08-11) es-hangul(토스, 검증됨) 우선 사용 + 초성검색·조사 헬퍼. 미설치 시 자체구현 fallback.
 */
let _esh = null; try { _esh = require('es-hangul'); } catch { /* fallback to local */ }

function qwertyToHangul(str) {
  if (!str) return '';
  if (_esh && _esh.convertQwertyToHangul) { try { return _esh.convertQwertyToHangul(str); } catch {} }
  return _qwertyToHangulLocal(str);
}
// 초성 추출 — 초성검색용 ('청화꽃집' → 'ㅊㅎㄲㅈ'). es-hangul 없으면 빈 문자열.
function getChoseong(str) { try { return (_esh && _esh.getChoseong) ? _esh.getChoseong(String(str || '')) : ''; } catch { return ''; } }
// 조사 자동교정 — 받침 따라 을/를·이/가·은/는 ('블루문'+'을/를' → '블루문을'). 미설치 시 word 그대로.
function josa(word, type) { try { return (_esh && _esh.josa) ? _esh.josa(String(word || ''), type) : String(word || ''); } catch { return String(word || ''); } }

function _qwertyToHangulLocal(str) {
  if (!str) return '';
  const M = { q:'ㅂ',w:'ㅈ',e:'ㄷ',r:'ㄱ',t:'ㅅ',y:'ㅛ',u:'ㅕ',i:'ㅑ',o:'ㅐ',p:'ㅔ',a:'ㅁ',s:'ㄴ',d:'ㅇ',f:'ㄹ',g:'ㅎ',h:'ㅗ',j:'ㅓ',k:'ㅏ',l:'ㅣ',z:'ㅋ',x:'ㅌ',c:'ㅊ',v:'ㅍ',b:'ㅠ',n:'ㅜ',m:'ㅡ',Q:'ㅃ',W:'ㅉ',E:'ㄸ',R:'ㄲ',T:'ㅆ',O:'ㅒ',P:'ㅖ' };
  const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const VC = { 'ㅗㅏ':'ㅘ','ㅗㅐ':'ㅙ','ㅗㅣ':'ㅚ','ㅜㅓ':'ㅝ','ㅜㅔ':'ㅞ','ㅜㅣ':'ㅟ','ㅡㅣ':'ㅢ' };
  const TC = { 'ㄱㅅ':'ㄳ','ㄴㅈ':'ㄵ','ㄴㅎ':'ㄶ','ㄹㄱ':'ㄺ','ㄹㅁ':'ㄻ','ㄹㅂ':'ㄼ','ㄹㅅ':'ㄽ','ㄹㅌ':'ㄾ','ㄹㅍ':'ㄿ','ㄹㅎ':'ㅀ','ㅂㅅ':'ㅄ' };
  const TS = { 'ㄳ':['ㄱ','ㅅ'],'ㄵ':['ㄴ','ㅈ'],'ㄶ':['ㄴ','ㅎ'],'ㄺ':['ㄹ','ㄱ'],'ㄻ':['ㄹ','ㅁ'],'ㄼ':['ㄹ','ㅂ'],'ㄽ':['ㄹ','ㅅ'],'ㄾ':['ㄹ','ㅌ'],'ㄿ':['ㄹ','ㅍ'],'ㅀ':['ㄹ','ㅎ'],'ㅄ':['ㅂ','ㅅ'] };
  const JONGL = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  const isC = c => CHO.includes(c);
  let out = '', cho = '', jung = '', jong = '';
  const flush = () => { if (cho && jung) { const ci = CHO.indexOf(cho), ji = JUNG.indexOf(jung), ti = JONGL.indexOf(jong || ''); out += String.fromCharCode(0xAC00 + (ci * 21 + ji) * 28 + (ti < 0 ? 0 : ti)); } else out += (cho || '') + (jung || '') + (jong || ''); cho = ''; jung = ''; jong = ''; };
  for (const ch of str) { const j = M[ch]; if (j === undefined) { flush(); out += ch; continue; } if (isC(j)) { if (!cho && !jung) cho = j; else if (cho && !jung) { flush(); cho = j; } else if (cho && jung && !jong) { if (JONGL.includes(j)) jong = j; else { flush(); cho = j; } } else { const cc = TC[jong + j]; if (cc) jong = cc; else { flush(); cho = j; } } } else { if (cho && !jung) jung = j; else if (cho && jung && !jong) { const vc = VC[jung + j]; if (vc) jung = vc; else { flush(); out += j; } } else if (cho && jung && jong) { const sp = TS[jong]; let mj; if (sp) { jong = sp[0]; mj = sp[1]; } else { mj = jong; jong = ''; } flush(); cho = mj; jung = j; } else { const vc = VC[jung + j]; if (jung && vc) { jung = vc; } else { flush(); out += j; } } } } flush(); return out;
}

module.exports = { qwertyToHangul, getChoseong, josa };
