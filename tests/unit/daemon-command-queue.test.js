// [2026-10-21] 원격 명령 안전장치 — src/daemon-command-queue.js 단위 테스트(가짜 pool)
const q = require('../../src/daemon-command-queue');

function fakePool(handlers) {
  const log = [];
  return {
    log,
    async query(sql, params) {
      log.push([sql, params]);
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
      return { rows: [], rowCount: 0 };
    },
  };
}

test('dedupe_key: 같은 host(대소문자 무시)+action+args → 같은 키, ts/reason 같은 휘발 키는 무시', () => {
  const a = q.dedupeKey('DESKTOP-A', 'restart', null, { reason: 'x', ts: '1' });
  const b = q.dedupeKey('desktop-a', 'restart', null, { reason: 'y', ts: '2' });
  const c = q.dedupeKey('desktop-a', 'exec', 'dir', {});
  const d = q.dedupeKey('desktop-a', 'exec', 'dir /s', {});
  expect(a).toBe(b);
  expect(c).not.toBe(d);
  expect(a.startsWith('desktop-a|restart|')).toBe(true);
});

test('ttlFor: 기본 10분, action 별 기본, 명령별 override', () => {
  expect(q.ttlFor('restart')).toBe(10);
  expect(q.ttlFor('config')).toBe(1440);
  expect(q.ttlFor('restart', 3)).toBe(3);
  expect(q.ttlFor('restart', 'abc')).toBe(10);
});

test('enqueue: INSERT 성공 → 새 id, ON CONFLICT(pending 중복) → 기존 id 반환(deduped)', async () => {
  let inserted = 0;
  const pool = fakePool([
    [/^INSERT INTO orbit_daemon_commands/, () => (inserted++ === 0 ? { rows: [{ id: 101, expires_at: 'E' }] } : { rows: [] })],
    [/^SELECT id, expires_at FROM orbit_daemon_commands WHERE dedupe_key/, () => ({ rows: [{ id: 101, expires_at: 'E' }] })],
  ]);
  const r1 = await q.enqueue(pool, { hostname: 'H', action: 'restart' });
  const r2 = await q.enqueue(pool, { hostname: 'h', action: 'restart', data: { reason: 'again' } });
  expect(r1).toEqual({ id: 101, deduped: false, expires_at: 'E' });
  expect(r2).toEqual({ id: 101, deduped: true, expires_at: 'E' });
  const ins = pool.log.find(([s]) => /^INSERT/.test(s));
  expect(ins[1][4]).toBe('10'); // ttl 분
  expect(ins[1][5]).toBe(q.dedupeKey('H', 'restart', null, {}));
});

test('fetchForHost: 만료 마감(UPDATE expired) → 미만료 pending 만 → id 로 소비(delivered/redeliver 집계)', async () => {
  const pool = fakePool([
    [/^SELECT id, action, command, data_json, ts, delivered_count/, (sql) => {
      expect(sql).toMatch(/expires_at > NOW\(\)/);
      expect(sql).toMatch(/status = 'pending'/);
      return { rows: [{ id: 7, action: 'restart', command: null, data_json: {}, ts: 'T', delivered_count: 0 }] };
    }],
  ]);
  const cmds = await q.fetchForHost(pool, 'H');
  expect(cmds).toEqual([{ id: 7, action: 'restart', command: null, data: {}, ts: 'T' }]);
  expect(pool.log[0][0]).toMatch(/SET status = 'expired'/);
  const consume = pool.log.find(([s]) => /SET consumed_at = NOW\(\), status = 'consumed'/.test(s));
  expect(consume[1]).toEqual([[7]]);
  expect(consume[0]).toMatch(/redeliver_count = redeliver_count \+ CASE WHEN delivered_count > 0/);
});

test('ack: command_executed/command_fail 만, detail 첫 토큰이 action, 가장 최근 소비 1건에 기록', async () => {
  const pool = fakePool([[/^UPDATE orbit_daemon_commands SET executed_at/, () => ({ rowCount: 1 })]]);
  expect(await q.ack(pool, { hostname: 'H', status: 'update_success', detail: 'x' })).toBe(0);
  expect(await q.ack(pool, { hostname: 'H', status: 'command_executed', detail: 'exec: dir output' })).toBe(1);
  const [sql, params] = pool.log[0];
  expect(params.slice(0, 3)).toEqual(['H', 'exec', 'executed']);
  expect(JSON.parse(params[3])).toMatchObject({ ok: true, status: 'command_executed' });
  expect(sql).toMatch(/executed_at IS NULL/);
  await q.ack(pool, { hostname: 'H', status: 'command_fail', detail: 'rpa execute: boom' });
  expect(pool.log[1][1].slice(1, 3)).toEqual(['rpa', 'failed']);
});

test('sweep: 호스트당 미소비 ≥ N → purged + 기록, 같은 명령 재전달 ≥ 3 → purged + 기록', async () => {
  const pool = fakePool([
    [/HAVING COUNT\(\*\) >= \$1/, (s, p) => { expect(p[0]).toBe(q.PURGE_THRESHOLD); return { rows: [{ hostname: 'STALE', cnt: 25, actions: 'capture-config' }] }; }],
    [/redeliver_count >= \$1 AND status IN/, () => ({ rows: [{ hostname: 'LOOP', action: 'update', cnt: 1 }] })],
    [/SET status = 'purged'/, () => ({ rowCount: 5 })],
    [/SET status = 'expired'/, () => ({ rowCount: 3 })],
  ]);
  const out = await q.sweep(pool);
  expect(out.expired).toBe(3);
  expect(out.purges.map((p) => [p.hostname, p.count])).toEqual([['STALE', 5], ['LOOP', 5]]);
  expect(pool.log.filter(([s]) => /INSERT INTO orbit_daemon_command_purges/.test(s))).toHaveLength(2);
});

test('purge(관리자): pending 만 purged, 건수>0 이면 기록', async () => {
  const pool = fakePool([[/SET status = 'purged'/, () => ({ rowCount: 2 })]]);
  expect(await q.purge(pool, { hostname: 'H', actions: ['restart'] })).toBe(2);
  expect(pool.log[0][0]).toMatch(/status = 'pending'/);
  expect(pool.log[0][1]).toEqual(['H', ['restart']]);
  expect(pool.log[1][0]).toMatch(/orbit_daemon_command_purges/);
});
