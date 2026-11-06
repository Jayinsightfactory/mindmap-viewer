'use strict';
// work.action 발생량 억제(PC 필터) + 그래프 비노출(서버) 검증
const { _test } = require('../../src/work-action-recorder');
const { buildGraph } = require('../../src/graph-engine');

const T0 = Date.parse('2026-11-06T04:00:00.000Z');
const ev = (sec, ev_, role, name) => ({ t: new Date(T0 + sec * 1000).toISOString(), ev: ev_, role, name });

describe('work-action 필터', () => {
  test('메뉴 깜빡임(SHOW|rNN)은 30초에 1건만', () => {
    const f = _test.makeFilter();
    let kept = 0;
    for (let s = 0; s < 60; s++) if (f.accept(ev(s, 'SHOW', 'r7', '편집'))) kept++;
    expect(kept).toBe(2); // 0초, 30초
    expect(f.st.deduped).toBe(58);
  });

  test('같은 버튼 3초 내 반복은 제거, 3초 이후는 유지', () => {
    const f = _test.makeFilter();
    expect(f.accept(ev(0, 'FOCUS', 'btn', '저 장'))).toBe(true);
    expect(f.accept(ev(1, 'FOCUS', 'btn', '저 장'))).toBe(false);
    expect(f.accept(ev(3, 'FOCUS', 'btn', '저 장'))).toBe(true);
  });

  test('서로 다른 이름·종류는 순서대로 전부 유지(행동 순서 보존)', () => {
    const f = _test.makeFilter();
    const seq = [
      ev(0, 'FOCUS', 'btn', '수  정'), ev(0.2, 'FOCUS', 'btn', '저 장'),
      ev(0.4, 'SHOW', 'window', '신규 제품 등록'), ev(0.6, 'FOCUS', 'statictext', '제품이 정상적으로 등록되었습니다.'),
      ev(0.8, 'FOCUS', 'btn', 'OK'),
    ];
    expect(seq.map(e => f.accept(e))).toEqual([true, true, true, true, true]);
  });

  test('성공 메시지(statictext)는 10초 간격 재등장 시 둘 다 유지', () => {
    const f = _test.makeFilter();
    expect(f.accept(ev(0, 'FOCUS', 'statictext', '제품이 정상적으로 등록되었습니다.'))).toBe(true);
    expect(f.accept(ev(10, 'FOCUS', 'statictext', '제품이 정상적으로 등록되었습니다.'))).toBe(true);
  });

  test('폭주 안전판: 같은 분에 maxPerMin 초과분은 버리고 다음 분에 복구', () => {
    const f = _test.makeFilter({ maxPerMin: 5 });
    let kept = 0;
    for (let i = 0; i < 20; i++) if (f.accept(ev(i * 0.5, 'FOCUS', 'btn', 'b' + i))) kept++;
    expect(kept).toBe(5);
    expect(f.st.capped).toBe(15);
    expect(f.accept(ev(61, 'FOCUS', 'btn', 'next'))).toBe(true);
  });

  test('시각 파싱 불가여도 던지지 않는다', () => {
    const f = _test.makeFilter();
    expect(() => f.accept({ ev: 'FOCUS', role: 'btn', name: 'x', t: 'garbage' })).not.toThrow();
  });
});

describe('work.action 그래프 비노출', () => {
  test('buildGraph 는 work.action 이벤트를 노드로 만들지 않는다', () => {
    const events = [
      { id: 'a1', type: 'work.action', timestamp: '2026-11-06T04:00:00Z', sessionId: 's', data: { ev: 'FOCUS', name: '저 장' } },
      { id: 'k1', type: 'keyboard.chunk', timestamp: '2026-11-06T04:00:01Z', sessionId: 's', data: {} },
    ];
    const g = buildGraph(events);
    expect(g.nodes.find(n => n.id === 'a1')).toBeUndefined();
    expect(g.nodes.find(n => n.id === 'k1')).toBeDefined();
  });
});
