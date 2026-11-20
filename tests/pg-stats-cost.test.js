'use strict';

function mockPg(query) {
  jest.resetModules();
  jest.doMock('pg', () => ({ Pool: jest.fn(() => ({ query, on: jest.fn() })) }));
  jest.doMock('../src/migrate', () => ({ runMigrations: async () => {} }));
  const db = require('../src/db-pg');
  db.initDatabase();
  return db;
}

test('global stats retain counts and null-source fallback with one shared aggregate', async () => {
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
  const db = mockPg(query);
  await db.waitForTables();
  query.mockClear();
  const results = await Promise.all(Array.from({ length: 30 }, () => db.getStats()));
  expect(results[0]).toEqual({ eventCount: 17, sessionCount: 4, fileCount: 6,
    toolCount: 6, aiSourceStats: { claude: 8, cursor: 7 }, estimated: false });
  // reltuples 추정 1 + 집계 3, 동시 30 호출이 한 번의 갱신을 공유
  expect(query).toHaveBeenCalledTimes(4);
  expect(query.mock.calls.some(([sql]) => sql.includes('TABLESAMPLE'))).toBe(false);
  expect(results.every(r => r === results[0])).toBe(true);
});

test('large events table uses reltuples + TABLESAMPLE instead of a full scan', async () => {
  const query = jest.fn(async sql => {
    if (sql.includes('pg_class')) return { rows: [{ n: '1000000' }] };
    if (sql.includes('GROUP BY metadata_json')) return { rows: [
      { ai_source: null, cnt: '3000', tool_count: '1000' },
      { ai_source: 'cursor', cnt: '2000', tool_count: '0' },
    ] };
    if (sql === 'SELECT COUNT(*) AS c FROM sessions') return { rows: [{ c: '4' }] };
    if (sql === 'SELECT COUNT(*) AS c FROM files') return { rows: [{ c: '6' }] };
    return { rows: [] };
  });
  const db = mockPg(query);
  await db.waitForTables();
  query.mockClear();
  const r = await db.getStats();
  expect(query.mock.calls.find(([sql]) => sql.includes('GROUP BY metadata_json'))[0]).toContain('TABLESAMPLE SYSTEM');
  expect(r).toEqual({ eventCount: 1000000, sessionCount: 4, fileCount: 6,
    toolCount: 200000, aiSourceStats: { claude: 600000, cursor: 400000 }, estimated: true });
});

test('insertEvent strips NUL characters that PG jsonb rejects', async () => {
  const query = jest.fn(async () => ({ rows: [], rowCount: 1 }));
  const db = mockPg(query);
  await db.waitForTables();
  query.mockClear();
  await db.insertEvent({ id: 'e1', type: 'daemon.log.snapshot', sessionId: 's1', userId: 'u1',
    timestamp: new Date().toISOString(), data: { logType: 'install', lines: 'a\u0000b\u0000c' }, metadata: { m: 'x\u0000' } });
  const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO events'));
  const [dataParam, metaParam] = insert[1].slice(8, 10);
  expect(dataParam).not.toContain('\\u0000');
  expect(JSON.parse(dataParam)).toEqual({ logType: 'install', lines: 'abc' });
  expect(JSON.parse(metaParam)).toEqual({ m: 'x' });
});
