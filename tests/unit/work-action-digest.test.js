'use strict';
const { digest, sentence } = require('../../src/work-action-digest');
const T = (s) => `2026-11-09T04:00:${String(s).padStart(2, '0')}.000Z`;

describe('work-action-digest', () => {
  test('화면·단계·저장·칸 요약, 목록 펼침은 선택값 아님', () => {
    const d = digest([
      { t: T(0), ev: 'FOCUS', role: 'r60', name: '신규 주문 등록' },
      { t: T(1), ev: 'SELECTION', role: 'r28', name: '호주' },
      { t: T(2), ev: 'FOCUS', role: 'btn', name: '조  회' },
      { t: T(3), ev: 'SELECTION', role: 'r29', name: '단 수량 row 1' },
      { t: T(4), ev: 'FOCUS', role: 'text', name: 'Auto filter row column Prod Name' },
      { t: T(5), ev: 'FOCUS', role: 'btn', name: '저  장' },
      { t: T(6), ev: 'FOCUS', role: 'statictext', name: '정상적으로 저장되었습니다.' },
      { t: T(7), ev: 'FOCUS', role: 'btn', name: 'OK' },
      { t: T(10), ev: 'SELECTION', role: 'r28', name: '2026 42' },
      { t: T(10), ev: 'SELECTION', role: 'r28', name: '2026 43' },
      { t: T(10), ev: 'SHOW', role: 'r7', name: 'x' },
      { t: T(11), ev: 'SELECTION', role: 'r28', name: '2026 44' },
      { t: T(11), ev: 'SELECTION', role: 'r28', name: '2026 45' },
    ]);
    expect(d.screen).toBe('신규 주문 등록');
    expect(d.steps).toEqual(['조회', '저장']);
    expect(d.saved).toBe(1);
    expect(d.fields).toEqual(['단 수량', '필터:Prod Name']);
    expect(d.picks).toEqual(['호주']);
    expect(sentence(d)).toBe('신규 주문 등록: 조회→저장 (저장 1회)');
  });
  test('경고 메시지 수집', () => {
    const d = digest([{ ev: 'FOCUS', role: 'statictext', name: '거래처를 선택하세요.' }]);
    expect(d.errors).toEqual(['거래처를 선택하세요.']);
  });
});
