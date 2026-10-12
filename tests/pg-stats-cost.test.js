'use strict';

test('global stats retain counts and null-source fallback with one shared aggregate', async () => {
  jest.resetModules();
  const query = jest.fn(async sql => {
    if (sql.includes('GROUP BY metadata_json')) return { rows: [
      { ai_source: null, cnt: '3', tool_count: '1' },
      { ai_source: 'claude', cnt: '5', tool_count: '2' },
      { ai_source: 'cursor', cnt: '7', tool_count: '3' },
      { ai_source: '', cnt: '2', tool_count: '0' },
    ] };
    if (sql === 'SELECT COUNT(*) AS c FROM sessions') return { rows: [{ c: '4' }] };
    if (sql === 'SELECT COUNT(*) AS c FROM files') return { rows: [{ c: '6' }] };
    return { rows: [] };
  });
  jest.doMock('pg', () => ({ Pool: jest.fn(() => ({ query })) }));
  jest.doMock('../src/migrate', () => ({ runMigrations: async () => {} }));
  const db = require('../src/db-pg');
  db.initDatabase();
  await db.waitForTables();
  query.mockClear();
  const results = await Promise.all(Array.from({ length: 30 }, () => db.getStats()));
  expect(results[0]).toEqual({ eventCount: 17, sessionCount: 4, fileCount: 6,
    toolCount: 6, aiSourceStats: { claude: 8, cursor: 7 } });
  expect(query).toHaveBeenCalledTimes(3);
  expect(results.every(r => r === results[0])).toBe(true);
});
