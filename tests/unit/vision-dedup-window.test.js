// E1 시간창 dedup — 고정 레이아웃 앱이 몇 시간씩 '중복'으로 버려지던 문제(2026-11-03) 회귀 방지
const { _isDupHash, _dupCache } = require('../../bin/vision-worker.js');

const H = '0101010101010101010101010101010101010101010101010101010101010101';
const T0 = Date.parse('2026-11-03T03:00:00Z');

beforeEach(() => _dupCache.clear());

test('10분 안의 같은 화면은 중복', () => {
  expect(_isDupHash(H, 'u|nenova', T0)).toBe(false);
  expect(_isDupHash(H, 'u|nenova', T0 + 60 * 1000)).toBe(true);
});

test('같은 화면이 계속돼도 10분마다 1장은 분석된다(스킵 프레임은 ring에 안 들어감)', () => {
  expect(_isDupHash(H, 'u|nenova', T0)).toBe(false);
  for (let m = 1; m < 10; m++) expect(_isDupHash(H, 'u|nenova', T0 + m * 60000)).toBe(true);
  expect(_isDupHash(H, 'u|nenova', T0 + 10 * 60000)).toBe(false);
  expect(_isDupHash(H, 'u|nenova', T0 + 3 * 3600000)).toBe(false);
});

test('키가 다르면 독립', () => {
  expect(_isDupHash(H, 'a|nenova', T0)).toBe(false);
  expect(_isDupHash(H, 'b|nenova', T0)).toBe(false);
});
