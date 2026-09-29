'use strict';
// 개인정보 게이트·메신저 로컬 추출 검증 (node tests/privacy-gate.check.js) — 네트워크·디스크 기록 없음
process.env.ORBIT_PRIVACY_NOIO = '1';
const assert = require('assert');
const os = require('os');
const g = require('../src/privacy-gate');
const x = require('../src/local-work-extractor');
const fs = require('fs'), path = require('path');
const POLICY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'privacy-policy.json'), 'utf8'));
let myId = ''; try { myId = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.orbit-config.json'), 'utf8')).userId || ''; } catch {}
if (!myId) myId = os.hostname();

let fail = 0;
const rows = [];
function check(name, got, exp) { const ok = got === exp; if (!ok) fail++; rows.push([ok ? 'PASS' : 'FAIL', name, exp, got]); }

// ── 1) classify 20케이스 (정책 파일 그대로 = localExtraction.enabled=false) ──
g._setPolicyForTest(Object.assign({}, POLICY, { localExtraction: { enabled: false, consentedUsers: [] } })); // 동의 전 기준(운영 파일 설정과 무관) g._setPauseForTest(0);
const cases = [
  ['카톡 업무방 수입방', { app: 'kakaotalk', windowTitle: '수입방' }, 'messenger_work'],
  ['카톡 업무방 현장 추가취소방', { app: 'kakaotalk', windowTitle: '현장 추가취소방' }, 'messenger_work'],
  ['카톡 업무방 네노바&선율방', { app: 'KakaoTalk.exe', windowTitle: '네노바&선율방' }, 'messenger_work'],
  ['카톡 1:1(사람 이름)', { app: 'kakaotalk', windowTitle: '홍길동' }, 'messenger_private'],
  ['카톡 친구목록 창', { app: 'kakaotalk', windowTitle: '카카오톡' }, 'messenger_private'],
  ['카톡 후보방(발주) 미적용', { app: 'kakaotalk', windowTitle: '발주 협의방' }, 'messenger_private'],
  ['위챗 WeChat', { app: 'weixin', windowTitle: 'WeChat' }, 'messenger_private'],
  ['위챗 앱명 오인(제목만 Weixin)', { app: 'flores tiba', windowTitle: 'Weixin' }, 'messenger_private'],
  ['텔레그램', { app: 'telegram', windowTitle: 'Telegram' }, 'messenger_private'],
  ['크롬 구글검색 제목', { app: 'chrome', windowTitle: '장미 가격 - Google 검색 - Chrome' }, 'personal_web'],
  ['크롬 [개인] 치환 제목', { app: 'chrome', windowTitle: '[개인]' }, 'personal_web'],
  ['크롬 URL nenovaweb', { app: 'chrome', windowTitle: '주문관리', url: 'https://www.nenovaweb.com/orders' }, 'work'],
  ['크롬 URL 쿠팡', { app: 'chrome', windowTitle: '쿠팡!', url: 'https://www.coupang.com/vp/1' }, 'personal_web'],
  ['크롬 URL 이카운트', { app: 'chrome', windowTitle: 'ECOUNT', url: 'https://loginab.ecount.com/' }, 'work'],
  ['크롬 URL 유튜브', { app: 'chrome', windowTitle: 'YouTube', url: 'https://www.youtube.com/watch?v=1' }, 'personal_web'],
  ['크롬 제목 네이버쇼핑', { app: 'chrome', windowTitle: '네이버 쇼핑 - Chrome' }, 'personal_web'],
  ['엑셀', { app: 'excel', windowTitle: '40-01차 분배표.xlsx - Excel' }, 'work'],
  ['nenova.exe', { app: 'nenova', windowTitle: '화훼 관리 프로그램 v1.0.15' }, 'work'],
  ['카카오워크(업무 메신저)', { app: 'kakaowork', windowTitle: '영업팀' }, 'work'],
  ['탐색기', { app: 'explorer', windowTitle: '39-2차 통관서류' }, 'work'],
];
for (const [name, input, exp] of cases) check('classify: ' + name, g.classify(input).kind, exp);
// 일시정지
g._setPauseForTest(Date.now() + 30 * 60000);
check('classify: 개인용무 중 엑셀', g.classify({ app: 'excel', windowTitle: 'a.xlsx' }).kind, 'paused');
g._setPauseForTest(0);

// ── 2) 동의 전: enabled=false → 1:1·위챗은 messenger_private(로컬 추출도 안 함) ──
const sent = [];
x._setSenderForTest(d => sent.push(d));
const v1 = g.classify({ app: 'kakaotalk', windowTitle: '홍길동' });
check('동의 전 1:1 = 차단', v1.kind, 'messenger_private');
// keyboard-watcher 는 kind==='messenger_local' 일 때만 feedKey 호출 → 동의 전엔 추출기로 가는 문자 0
check('동의 전 1:1 로컬추출 경로 진입', v1.kind === 'messenger_local', false);
// enabled=true 인데 명단에 없음 → 차단
g._setPolicyForTest(Object.assign({}, POLICY, { localExtraction: { enabled: true, consentedUsers: ['someone-else'] } }));
check('enabled=true·미동의자 1:1 = 차단', g.classify({ app: 'kakaotalk', windowTitle: '홍길동' }).kind, 'messenger_private');
// enabled=true + 동의자 → 로컬 처리
g._setPolicyForTest(Object.assign({}, POLICY, { localExtraction: { enabled: true, consentedUsers: [myId] } }));
check('동의자 1:1 = messenger_local', g.classify({ app: 'kakaotalk', windowTitle: '홍길동' }).kind, 'messenger_local');
check('동의자 위챗 = messenger_local', g.classify({ app: 'weixin', windowTitle: 'WeChat' }).kind, 'messenger_local');
check('동의자여도 업무방은 그대로 수집', g.classify({ app: 'kakaotalk', windowTitle: '수입방' }).kind, 'messenger_work');
check('동의 전 전송 건수', sent.length, 0);

// ── 3) 메신저 문장 10개 → messenger.work payload 에 원문 없음 ──
const DICT = { products: ['카네이션', '장미', '안스륨', '수국'], customers: ['꽃길플라워'], farms: ['BOAT', 'Cloud'], keywords: ['발주', '출고', '송금', '인보이스', 'AWB', '클레임', '취소'], units: ['박스', '단', '송이', 'box'] };
const sentences = [
  ['40-01차 카네이션 30박스 발주 부탁드립니다 홍길동 010-1234-5678', true],
  ['BOAT 쪽 안스륨 단가 다시 확인해 주세요, 김철수 과장님이 물어보셨어요', true],
  ['꽃길플라워 장미 10단 출고 취소요', true],
  ['39-2A AWB 번호 받으면 인보이스랑 같이 보내줘', true],
  ['Cloud invoice 송금 오늘 처리했어 박영희 계좌로', true],
  ['수국 5 box 클레임 사진 첨부합니다', true],
  ['오늘 저녁에 뭐 먹을래? 치킨 어때', false],
  ['주말에 엄마 생신이라 일찍 퇴근해요 010-9876-5432', false],
  ['ㅋㅋㅋ 그 영화 진짜 재밌더라', false],
  ['아이 학원 픽업 때문에 3시에 잠깐 나갈게', false],
];
const ALLOWED = ['app', 'roomKind', 'roomName', 'cycle', 'products', 'customers', 'farms', 'quantities', 'keywords', 'source', 'ts'];
const FORBIDDEN = ['홍길동', '김철수', '박영희', '010-', '1234-5678', '9876', '부탁드립니다', '물어보셨어요', '치킨', '생신', '영화', '학원', '계좌'];
sentences.forEach(([s, isWork], i) => {
  const ex = x.extract(s, { dict: DICT, readable: true });
  check(`문장${i + 1} 업무판정`, ex.isWork, isWork);
  const payload = ex.isWork ? x.buildPayload({ app: 'kakaotalk', roomKind: 'unknown', roomName: null }, ex, 'ocr') : null;
  const json = payload ? JSON.stringify(payload) : '';
  const extraKeys = payload ? Object.keys(payload).filter(k => !ALLOWED.includes(k)) : [];
  const leaked = FORBIDDEN.filter(w => json.includes(w));
  const fullLeak = json.includes(s) || s.split(/[\s,?.]+/).filter(w => w.length >= 4 && !/^[\d-]+$/.test(w)).some(w => json.includes(w) && !(payload && [...payload.products, ...payload.customers, ...payload.farms, ...payload.keywords].some(d => d.toLowerCase() === w.toLowerCase())));
  check(`문장${i + 1} 원문/이름/전화 미포함`, leaked.length === 0 && !fullLeak && extraKeys.length === 0, true);
  if (payload) rows.push(['info', `문장${i + 1} payload`, '', JSON.stringify({ cycle: payload.cycle, products: payload.products, customers: payload.customers, farms: payload.farms, quantities: payload.quantities, keywords: payload.keywords })]);
});
// processText: 업무 없음 → 전송 0, 업무 → 전송 1 (원문 필드 없음)
sent.length = 0;
x.processText({ app: 'kakaotalk' }, '오늘 저녁에 뭐 먹을래', 'ocr');
check('사적 문장 processText 전송 수', sent.length, 0);
x.processText({ app: 'kakaotalk' }, '40차 장미 발주', 'ocr');
check('업무 문장 processText 전송 수', sent.length, 1);
check('전송 데이터에 원문 없음', JSON.stringify(sent[0] || {}).includes('40차 장미 발주'), false);
// 키보드 QWERTY 원시입력(한글 복원 후 추출)
const kb = x.extract('zkspdltus 20qkrtm qkfwn', { dict: DICT });
check('QWERTY 입력 → 카네이션/발주 추출', kb.products.includes('카네이션') && kb.keywords.includes('발주'), true);

console.log('| 결과 | 케이스 | 기대 | 실제 |\n|---|---|---|---|');
for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL ' + fail}`);
process.exit(fail ? 1 : 0);
