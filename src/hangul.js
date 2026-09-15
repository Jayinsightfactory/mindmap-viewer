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

// ── 한/영 자동판별 변환 (2026-09-15) ─────────────────────────────────────────────
// 원인: 데몬은 IME 상태를 모르므로 영어·스페인어 입력도 QWERTY 그대로 저장되는데, qwertyToHangul을
// 무조건 적용하면 'sen la junta' → 'ㄴ두 ㅣㅁ ㅓㅕㅜㅅㅁ' 로 깨졌다. 변환 결과를 보고 "정상 IME라면
// 나올 수 없는 모양"(낱모음, 음절 사이 낱자음)이면 원문을 유지한다. 원본 inputText는 손대지 않는다.
const _EMOTICON = /^(ㅋ+|ㅎ+|ㅠ+|ㅜ+|ㅡ+|ㅇㅇ|ㅇㅋ|ㄱㄱ|ㄴㄴ|ㅊㅋ|ㅅㄱ|ㄱㅅ|ㅈㅅ|ㄷㄷ|ㅂㅂ|ㅎㅇ)$/;
const _isSyl = (ch) => { const c = ch.codePointAt(0); return c >= 0xac00 && c <= 0xd7a3; };
const _isJamo = (ch) => ch >= 'ㄱ' && ch <= 'ㅣ';
const _isVowel = (ch) => ch >= 'ㅏ' && ch <= 'ㅣ';

// 판정 원칙: 틀리면 기존 동작(한글 변환)으로 남긴다. 실데이터 1,453건 검증에서 한글 입력에도
// 오타·백스페이스 흔적('조잔ㄹ치로구나')이 흔해, 낱자모만으로 외국어라 단정하면 멀쩡한 한글이 영문으로 바뀌었다.
function _tokInfo(raw) {
  const ko = qwertyToHangul(raw);
  const hs = [...ko].filter((ch) => _isSyl(ch) || _isJamo(ch));
  const syl = hs.filter(_isSyl).length;
  const emoticon = _EMOTICON.test(hs.join(''));
  const letters = (raw.match(/[a-zA-Z]/g) || []).length;
  const latinVowel = (raw.match(/[aeiouAEIOU]/g) || []).length / (letters || 1);
  // 음절/낱자 덩어리 순서 ('ㅠ내일' → [jamo, syl]) — 숫자·기호는 경계로만 취급
  const segs = (ko.match(/[가-힣]+|[ㄱ-ㅣ]+/g) || []).map((s) => (_isSyl(s[0]) ? s.length : 0)); // 0=낱자 덩어리
  const maxRun = Math.max(0, ...segs);
  const jamoInside = segs.some((n, i) => n === 0 && i > 0 && i < segs.length - 1 && segs[i - 1] > 0 && segs[i + 1] > 0);
  return {
    raw, ko, letters,
    cleanKo: !emoticon && syl >= 2 && syl === hs.length,  // '어딘데' 같은 온전한 한글 단어 = 한글 문장 증거
    // 오타 자모가 단어 앞뒤에만 붙은 한글('ㅠ내일','ㅗㅗ연염색','장미35ㅏ') — 영문으로 뒤집지 않는다
    koWithTypo: !emoticon && maxRun >= 2 && !jamoInside,
    loneVowel: !emoticon && hs.some(_isVowel),             // 정상 조합이면 낱모음은 거의 안 나온다(ㅇ이 붙음)
    // 영/서어다운가: 모음비율 0.15 ('thanks' 0.17 통과) + 자음 4연속 없음. 반드시 낱모음 조건과 AND로 쓴다.
    // 'PDF','ERP' 같은 대문자 약어는 한글 입력으로 나올 수 없으니(전부 쌍자음이 됨) 무조건 영문.
    latinLike: /^[A-Z]{2,}$/.test(raw) || (latinVowel >= 0.15 && !/[bcdfghjklmnpqrstvwxz]{4,}/i.test(raw)),
  };
}
// koWithTypo 보호는 문맥이 한글일 때만 켠다 — 단어 하나만 보면 'ㅁ야챠ㅐㅜㄷㄴ'(adiciones)와 'ㅠ내일'이 같은 모양
const _flippable = (t, koCtx = false) => t.loneVowel && t.latinLike && !(koCtx && t.koWithTypo);

// 띄어쓰기 없이 붙은 '영문+한글'('maxifle'+'구매') / '한글+영문' → 경계에서 나눠 각각 표시
function _splitMixed(t) {
  const r = t.raw;
  for (let k = 1; k <= r.length - 4; k++) {               // 뒤쪽 한글 2음절 이상 + 앞쪽 영문
    const ko = qwertyToHangul(r.slice(k));
    if (/^[가-힣]{2,}$/.test(ko) && _flippable(_tokInfo(r.slice(0, k)))) return r.slice(0, k) + ko;
  }
  for (let k = r.length - 1; k >= 4; k--) {               // 앞쪽 한글 2음절 이상 + 뒤쪽 영문
    const ko = qwertyToHangul(r.slice(0, k));
    if (/^[가-힣]{2,}$/.test(ko) && _flippable(_tokInfo(r.slice(k)))) return ko + r.slice(k);
  }
  return null;
}

function smartQwertyToHangul(str) {
  if (!str) return '';
  const parts = String(str).split(/(\s+)/);
  const toks = parts.map((p) => (/[a-zA-Z]/.test(p) ? _tokInfo(p) : { raw: p, ko: p, skip: true }));
  const judged = toks.filter((t) => !t.skip);
  if (!judged.length) return str;
  const koCtx = judged.some((t) => t.cleanKo);             // 온전한 한글 단어가 있으면 한글 문맥
  if (!koCtx) {
    // 한글 문맥이 아니고 영문으로 뒤집을 토큰이 글자수 과반 → 외국어 문장: 짧은 우연 음절('en'→'두')까지 원문
    const total = judged.reduce((s, t) => s + t.letters, 0);
    const foreign = judged.filter((t) => _flippable(t)).reduce((s, t) => s + t.letters, 0);
    if (foreign / total >= 0.5) return toks.map((t) => t.raw).join('');
    return toks.map((t) => (t.skip ? t.raw : _flippable(t) ? t.raw : t.ko)).join('');
  }
  // 한글 문맥: 오타 붙은 한글은 보호, 확실한 영문만 원문, 붙어 친 '영문+한글'은 경계에서 분리
  return toks.map((t) => {
    if (t.skip) return t.raw;
    if (!_flippable(t, true)) return t.ko;
    return _splitMixed(t) || t.raw;
  }).join('');
}

module.exports = { qwertyToHangul, smartQwertyToHangul, getChoseong, josa };
