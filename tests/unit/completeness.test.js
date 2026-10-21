'use strict';
const { buildReport, classifyZero, reportLine, median, expectedFor } = require('../../src/completeness');

describe('completeness', () => {
  test('expectedFor: 같은 요일 표본 부족하면 최근 평일 중앙값, 캡처 모듈 죽은 날은 표본 제외', () => {
    const byDay = {}; const base = Date.parse('2026-10-21T00:00:00Z');
    for (let i = 1; i <= 10; i++) { const d = new Date(base - i * 864e5).toISOString().slice(0, 10); byDay[d] = { capture: i === 1 ? 3 : 100 + i, heartbeat: 500, analyzed: 0, keyboard: 0, mouse: 0 }; }
    const e = expectedFor(byDay, '2026-10-21');
    expect(e).toBeGreaterThan(100); // 어제 캡처 3(죽음)은 표본에 포함되지만 중앙값이라 100대 유지
  });
  test('median', () => { expect(median([])).toBe(0); expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(3); });
  test('classifyZero 4종 + 장기 무응답', () => {
    expect(classifyZero({ heartbeat: 5, keyboard: 3, mouse: 0 }, { silentWeekdays: 0 }).cause).toBe('daemon-down');
    expect(classifyZero({ heartbeat: 5, keyboard: 0, mouse: 0 }, { silentWeekdays: 0 }).cause).toBe('unused');
    expect(classifyZero({ heartbeat: 0, keyboard: 2, mouse: 0 }, { silentWeekdays: 0 }).cause).toBe('daemon-down');
    expect(classifyZero({ heartbeat: 0, keyboard: 0, mouse: 0 }, { silentWeekdays: 0 }).cause).toBe('pc-off');
    expect(classifyZero({ heartbeat: 0, keyboard: 0, mouse: 0 }, { silentWeekdays: 3 })).toMatchObject({ cause: 'long-silent', restart: true });
  });
  test('buildReport: 기대치=4주 같은 요일 중앙값, 수신률, 유실 표시, 큐 적체', () => {
    const KST = 9 * 3600e3, today = new Date(Date.now() + KST).toISOString().slice(0, 10);
    const byDay = {};
    for (let w = 1; w <= 4; w++) for (let i = 0; i < 7; i++) { const d = new Date(Date.parse(today + 'T00:00:00Z') - (w * 7 + i) * 864e5).toISOString().slice(0, 10); byDay[d] = { capture: 40, analyzed: 30, keyboard: 10, mouse: 10, heartbeat: 100 }; }
    for (let i = 1; i < 7; i++) { const d = new Date(Date.parse(today + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10); byDay[d] = { capture: 40, analyzed: 30, keyboard: 10, mouse: 10, heartbeat: 100 }; }
    byDay[today] = { capture: 10, analyzed: 0, keyboard: 5, mouse: 0, heartbeat: 50 };
    const dead = new Date(Date.parse(today + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10); byDay[dead] = { capture: 1, analyzed: 0, keyboard: 1, mouse: 103, heartbeat: 257 };
    const rep = buildReport({ byUser: { 홍길동: byDay, U2: {} }, lastHb: { 홍길동: { at: 'x', hostname: 'PC1', userId: 'U1' } }, liveKeys: [], names: { U1: '홍길동' }, uids: { 홍길동: ['U1'] } }, 7);
    const e = rep.employees.find((x) => x.userId === 'U1');
    expect(e.days.every((d) => d.expected === 40)).toBe(true);
    const t = e.days.find((d) => d.date === today);
    expect(t.receivedPct).toBe(25); expect(t.status).toBe('lost'); expect(t.cause.cause).toBe('partial');
    expect(e.overallPct).toBeLessThanOrEqual(100);
    expect(e.days.find((d) => d.date === dead).cause.cause).toBe('daemon-down');
    expect(rep.employees.find((x) => x.name === 'U2')).toBeUndefined();
    expect(reportLine(rep, { actions: [] })).toContain('홍길동');
  });
});
