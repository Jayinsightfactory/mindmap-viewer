'use strict';
// 훅 차단 PC 폴백 캡처 (fallback-appchange / fallback-timer) 단위 테스트 — 실제 화면캡처·네트워크 없음
process.env.ORBIT_PRIVACY_NOIO = '1';
const sc = require('../../src/screen-capture');

const T = sc._fallbackTestHooks();
const MIN = 60 * 1000;
let fg;
let calls;

beforeEach(() => {
  T.reset();
  T.setRunning(true);
  T.setIdleMs(0);                 // GetLastInputInfo 대신 고정값 (방금 입력 있음)
  calls = [];
  T.setCapture((t) => { calls.push(t); return 'fake.png'; });
  fg = { app: 'excel', title: '발주서.xlsx - Excel' };
  sc.setForegroundProvider(() => fg);
  if (sc.isPaused()) sc.resume();
});

afterAll(() => { T.setRunning(false); T.setCapture(null); });

test('입력훅 트리거가 최근에 있으면(정상 PC) 폴백은 아무것도 안 한다', () => {
  const now = Date.now();
  T.setHookAt(now - 1000);
  expect(T.tick(now)).toBeNull();
  expect(calls).toEqual([]);
});

test('훅 기아 상태: 창 전환 → fallback-appchange, 같은 창 활성 중 75초 → fallback-timer', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  expect(T.tick(now)).toBe('fallback-appchange');
  expect(T.tick(now + 30000)).toBeNull();               // 같은 창, 주기 미도달
  expect(T.tick(now + 80000)).toBe('fallback-timer');   // 활성 + 75초 경과
  fg = { app: 'nenova', title: '출고관리' };
  expect(T.tick(now + 90000)).toBe('fallback-appchange');
  expect(calls).toEqual(['fallback-appchange', 'fallback-timer', 'fallback-appchange']);
});

test('숫자/시각만 바뀐 제목은 창 전환으로 보지 않는다', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  fg = { app: 'chrome', title: '주문 12:01' };
  expect(T.tick(now)).toBe('fallback-appchange');
  fg = { app: 'chrome', title: '주문 12:02' };
  expect(T.tick(now + 30000)).toBeNull();
});

test('사용자가 유휴(입력 없음 3분+)면 주기 캡처 안 함', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  expect(T.tick(now)).toBe('fallback-appchange');
  T.setIdleMs(10 * MIN);
  expect(T.tick(now + 5 * MIN)).toBeNull();
});

test('은행 창은 캡처·메타 모두 스킵', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  fg = { app: 'chrome', title: '우리은행 기업뱅킹 - 이체' };
  expect(T.tick(now)).toBe('bank-skip');
  fg = { app: 'nProtect Online Security', title: '' };
  expect(T.tick(now + 30000)).toBe('bank-skip');
  expect(calls).toEqual([]);
});

test('은행보안 일시정지(pause) 중이면 폴백도 정지', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  sc.pause();
  expect(T.tick(now)).toBeNull();
  sc.resume();
  expect(calls).toEqual([]);
});

test('실제 capture 경로: 개인 웹(YouTube)은 개인정보 게이트에서 차단되어 파일 없음', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  T.setCapture(null); // 실제 capture() 사용
  fg = { app: 'chrome', title: '음악 - YouTube - Chrome' };
  expect(T.tick(now)).toBeNull();
});

test('유휴 중 창 목록 흔들림은 전환 캡처로 치지 않는다', () => {
  const now = Date.now();
  T.setHookAt(now - 11 * MIN);
  T.setIdleMs(10 * MIN);
  expect(T.tick(now)).toBeNull();
  fg = { app: 'chrome', title: '다른 창' };
  expect(T.tick(now + 30000)).toBeNull();
  expect(calls).toEqual([]);
});

test('송금/이체 업무 화면(ERP)은 은행 창으로 오인하지 않는다', () => {
  expect(T.BANKING_WINDOW_RE.test('수입부 송금기록 - nenovaweb')).toBe(false);
  expect(T.BANKING_WINDOW_RE.test('notepad')).toBe(false);
  expect(T.BANKING_WINDOW_RE.test('IBK기업은행')).toBe(true);
});

test('포그라운드/유휴 PS 출력 파싱', () => {
  expect(T.parseFgIdle('1200\tEXCEL\t발주서.xlsx - Excel')).toEqual({ idleMs: 1200, app: 'EXCEL', title: '발주서.xlsx - Excel' });
  expect(T.parseFgIdle('')).toEqual({ idleMs: null, app: '', title: '' });
  expect(T.PS_FG_IDLE).not.toMatch(/New-Object\s+-ComObject/i); // COM 생성 금지
});

test('트리거 설명·상태 노출', () => {
  const st = sc.getFallbackStatus();
  expect(st.provider).toBe(true);
  expect(typeof st.lastHookTriggerAt).toBe('string');
});
