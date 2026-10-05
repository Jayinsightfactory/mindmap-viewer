const h = require('../../src/hidden-users');
test('hides 임재용 by id and name, keeps others', () => {
  const body = { people: [{ userId: 'MNH03H73690BB2CD82', name: '임재용' }, { userId: 'X', name: 'jaeyong lim' }, { userId: 'MNIAFICB3DC88DCB34', name: '설연주' }],
    byUser: { MNH03H73690BB2CD82: 1, MNIAFICB3DC88DCB34: 2 } };
  const out = h.scrub(body);
  expect(out.people.map((p) => p.name)).toEqual(['설연주']);
  expect(Object.keys(out.byUser)).toEqual(['MNIAFICB3DC88DCB34']);
  expect(h.isHiddenValue('MNSKAQSQ649D9E5936')).toBe(true);
});
test('middleware blocks userId query and skips other paths', () => {
  let code; const res = { status: (c) => { code = c; return res; }, json: () => res };
  h.middleware({ method: 'GET', path: '/api/timetable/day', query: { userId: 'MNH03H73690BB2CD82' } }, res, () => { throw new Error('should block'); });
  expect(code).toBe(404);
  let called = false; h.middleware({ method: 'GET', path: '/api/auth/me', query: {} }, {}, () => { called = true; });
  expect(called).toBe(true);
});
test('drops string list items naming hidden user', () => {
  expect(h.scrub({ handsTo: ['설연주(5건)', 'jaeyong lim', '임재용(2건)', '임재용씨아님X'] }).handsTo).toEqual(['설연주(5건)', '임재용씨아님X']);
});
