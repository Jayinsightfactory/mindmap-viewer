// 캡처 보관 규칙: 최신 500장은 무조건 보관, 그 밖은 아직 스풀로 못 올린 것만 2000장째까지 보관.
const { _pruneTargets } = require('../src/screen-capture');
const names = (n) => Array.from({ length: n }, (_, i) => `screen-${String(9000000 - i)}-mouse_click-focused.png`); // 최신순

describe('캡처 보관(_pruneTargets)', () => {
  test('500장 이하면 아무것도 지우지 않는다', () => {
    expect(_pruneTargets(names(500), new Set(), 500, 2000)).toEqual([]);
  });
  test('모두 올린 상태면 예전처럼 500장 밖을 지운다', () => {
    const f = names(800);
    expect(_pruneTargets(f, new Set(f), 500, 2000)).toEqual(f.slice(500));
  });
  test('안 올린 것은 500장 밖이어도 2000장째까지 남긴다', () => {
    const f = names(2500);
    const sent = new Set(f.filter((_, i) => i % 2 === 0)); // 절반만 올림
    const del = new Set(_pruneTargets(f, sent, 500, 2000));
    expect(f.slice(0, 500).some((x) => del.has(x))).toBe(false);                      // 최신 500장은 안 지움
    expect(f.slice(500, 2000).every((x) => del.has(x) === sent.has(x))).toBe(true);   // 그 밖 2000장째까지는 올린 것만 지움
    expect(f.slice(2000).every((x) => del.has(x))).toBe(true);                        // 2000장 밖은 전부 지움
  });
  test('한도를 500으로 주면(분석 PC·디스크 부족) 예전 동작과 같다', () => {
    const f = names(900);
    expect(_pruneTargets(f, new Set(), 500, 500)).toEqual(f.slice(500));
  });
});
