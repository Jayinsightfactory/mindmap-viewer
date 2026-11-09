'use strict';
const { learnUserMap, summarize } = require('../../src/erp-change-link');

describe('erp-change-link', () => {
  test('동시 작업자는 1/k 로 세어 오귀속 방지, 계정은 한 사람에게만', () => {
    const r = (id) => ({ changeId: id });
    const cands = [
      { user: 'A', rows: [r('SD7')] }, { user: 'A', rows: [r('SD7')] }, { user: 'A', rows: [r('SD7'), r('SS1')] },
      { user: 'B', rows: [r('SS1')] }, { user: 'B', rows: [r('SS1')] }, { user: 'B', rows: [r('SS1'), r('SD7')] },
      { user: 'C', rows: [r('SS1')] }, { user: 'C', rows: [r('SS1')] },
    ];
    const m = learnUserMap(cands);
    expect(m.A).toBe('SD7');
    expect(m.B).toBe('SS1');
    expect(m.C).toBeUndefined(); // SS1 은 점수 높은 B 것
  });
  test('기존 확정 매핑 유지', () => {
    expect(learnUserMap([], { A: 'X' })).toEqual({ A: 'X' });
  });
  test('요약', () => {
    const s = summarize([{ kind: 'order', week: '46-01', cust: '주광농원', prod: 'P', changeType: '수정', column: '주문수량' }]);
    expect(s).toMatchObject({ rows: 1, kinds: ['order'], weeks: ['46-01'], customers: ['주광농원'] });
  });
});

describe('erp-change-link typedHits', () => {
  const { typedHits } = require('../../src/erp-change-link');
  test('영문자판 입력을 한글로 바꿔 거래처 검색어(앞부분)·품목 이름 확인', () => {
    const { smartQwertyToHangul } = require('../../src/hangul');
    const raw = 'smfqha dkstlfldna';
    const h = typedHits([{ cust: '늘봄플라워', prod: 'ANTHURIUM / 안시리움 Red' }, { cust: '대한꽃집', prod: 'Ruscus Green' }], raw + ' ' + smartQwertyToHangul(raw));
    expect(h.customers).toEqual(['늘봄플라워']);
    expect(h.items).toEqual(['ANTHURIUM / 안시리움 Red']);
  });
  test('입력 없으면 빈 결과', () => {
    expect(typedHits([{ cust: 'A', prod: 'B' }], '')).toEqual({ customers: [], items: [] });
  });
});
