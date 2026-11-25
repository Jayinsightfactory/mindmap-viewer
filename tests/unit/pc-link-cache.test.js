'use strict';

const fs = require('fs');
const path = require('path');
const { createPcLinkCache, decideUserId, splitProvisionalDaemons } = require('../../src/pc-link-cache');

function fakePool(handler) {
  return { query: jest.fn(async (sql, params) => handler(sql, params)) };
}

describe('pc-link-cache: orbit_pc_links 조회 캐시', () => {
  test('조회 성공값을 TTL 동안 재사용하고, TTL 이 지나면 다시 조회한다', async () => {
    let t = 1000;
    const cache = createPcLinkCache({ now: () => t });
    const pool = fakePool(() => ({ rows: [{ user_id: 'MNREAL01' }] }));

    expect(await cache.resolve(pool, 'DESKTOP-A')).toEqual({ userId: 'MNREAL01', source: 'db' });
    expect(await cache.resolve(pool, 'DESKTOP-A')).toEqual({ userId: 'MNREAL01', source: 'cache' });
    expect(pool.query).toHaveBeenCalledTimes(1);

    t += 61 * 1000;
    expect((await cache.resolve(pool, 'DESKTOP-A')).source).toBe('db');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('조회가 실패하면 마지막 성공값을 돌려준다(stale) — 임시 번호로 새지 않는다', async () => {
    let t = 1000;
    let fail = false;
    const cache = createPcLinkCache({ now: () => t });
    const pool = fakePool(() => {
      if (fail) throw new Error('timeout exceeded when trying to connect');
      return { rows: [{ user_id: 'MNREAL01' }] };
    });
    await cache.resolve(pool, 'DESKTOP-A');

    t += 5 * 60 * 1000; // TTL 지남
    fail = true;
    const r = await cache.resolve(pool, 'DESKTOP-A');
    expect(r.userId).toBe('MNREAL01');
    expect(r.source).toBe('stale');
    expect(decideUserId(null, 'DESKTOP-A', r)).toEqual({ userId: 'MNREAL01', overridden: true, degraded: false });
  });

  test('조회 실패 + 기억 없음이면 error 를 돌려주고 예외를 던지지 않는다', async () => {
    const cache = createPcLinkCache();
    const pool = fakePool(() => { throw new Error('timeout exceeded when trying to connect'); });
    const r = await cache.resolve(pool, 'DESKTOP-NEW');
    expect(r.userId).toBeNull();
    expect(r.source).toBe('error');
    expect(r.error).toMatch(/timeout/);
    // 데이터는 버리지 않는다: 기존처럼 임시 번호로 받되 degraded 로 표시(로그 대상)
    expect(decideUserId(null, 'DESKTOP-NEW', r)).toEqual({ userId: 'pc_DESKTOP-NEW', overridden: false, degraded: true });
  });

  test('실패 직후 backoff 동안은 DB 를 다시 두드리지 않는다', async () => {
    let t = 1000;
    const cache = createPcLinkCache({ now: () => t });
    const pool = fakePool(() => { throw new Error('down'); });
    await cache.resolve(pool, 'H');
    await cache.resolve(pool, 'H');
    expect(pool.query).toHaveBeenCalledTimes(1);
    t += 11 * 1000;
    await cache.resolve(pool, 'H');
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  test('같은 hostname 동시 조회는 쿼리 1건으로 합친다', async () => {
    const cache = createPcLinkCache();
    let release;
    const gate = new Promise(r => { release = r; });
    const pool = { query: jest.fn(async () => { await gate; return { rows: [{ user_id: 'MNREAL01' }] }; }) };
    const all = Promise.all([cache.resolve(pool, 'H'), cache.resolve(pool, 'H'), cache.resolve(pool, 'H')]);
    release();
    const rs = await all;
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(rs.every(r => r.userId === 'MNREAL01')).toBe(true);
  });

  test('매핑 없음도 짧게 기억하고, invalidate 하면 바로 다시 읽는다', async () => {
    let t = 1000;
    let rows = [];
    const cache = createPcLinkCache({ now: () => t });
    const pool = fakePool(() => ({ rows }));
    expect(await cache.resolve(pool, 'H')).toEqual({ userId: null, source: 'db' });
    rows = [{ user_id: 'MNNEW01' }];
    expect((await cache.resolve(pool, 'H')).userId).toBeNull(); // 30초 안: 아직 예전 값
    cache.invalidate('H');
    expect(await cache.resolve(pool, 'H')).toEqual({ userId: 'MNNEW01', source: 'db' });
  });

  test('warm 은 전체 매핑을 한 번에 채운다 — 이후 조회가 실패해도 번호를 안다', async () => {
    let t = 1000;
    const cache = createPcLinkCache({ now: () => t });
    const okPool = fakePool(() => ({ rows: [{ hostname: 'A', user_id: 'MNA' }, { hostname: 'B', user_id: 'MNB' }] }));
    expect(await cache.warm(okPool)).toBe(2);
    expect(cache.peek('A')).toBe('MNA');
    expect(cache.peek('ZZZ')).toBeUndefined();

    t += 10 * 60 * 1000;
    const badPool = fakePool(() => { throw new Error('down'); });
    expect(await cache.resolve(badPool, 'B')).toMatchObject({ userId: 'MNB', source: 'stale' });
    expect(await cache.warm(badPool)).toBe(-1);
  });

  test('pool/hostname 이 없으면 조회하지 않는다', async () => {
    const cache = createPcLinkCache();
    expect(await cache.resolve(null, 'H')).toEqual({ userId: null, source: 'skip' });
    expect(await cache.resolve(fakePool(() => ({ rows: [] })), '')).toEqual({ userId: null, source: 'skip' });
  });

  test('shouldLog 는 같은 hostname 에 1분에 1번만 true', () => {
    let t = 1000;
    const cache = createPcLinkCache({ now: () => t });
    expect(cache.shouldLog('H')).toBe(true);
    expect(cache.shouldLog('H')).toBe(false);
    t += 61 * 1000;
    expect(cache.shouldLog('H')).toBe(true);
  });
});

describe('decideUserId: 기존 동작 불변', () => {
  test('정상 토큰 + pc_links 가 같은 번호 → 토큰 번호 그대로', () => {
    expect(decideUserId('MNREAL01', 'H', { userId: 'MNREAL01', source: 'db' }))
      .toEqual({ userId: 'MNREAL01', overridden: false, degraded: false });
  });
  test('정상 토큰 + pc_links 가 다른 번호 → pc_links 번호로 덮어씀(토큰 ghosting 방지)', () => {
    expect(decideUserId('MNOLD', 'H', { userId: 'MNREAL01', source: 'cache' }))
      .toEqual({ userId: 'MNREAL01', overridden: true, degraded: false });
  });
  test('토큰 실패 + pc_links 있음 → pc_links 번호', () => {
    expect(decideUserId(null, 'H', { userId: 'MNREAL01', source: 'db' }).userId).toBe('MNREAL01');
  });
  test('토큰 실패 + 등록 안 된 PC → 임시 번호(예전과 같음, degraded 아님)', () => {
    expect(decideUserId(null, 'H', { userId: null, source: 'db' }))
      .toEqual({ userId: 'pc_H', overridden: false, degraded: false });
  });
  test('토큰도 hostname 도 없음 → local', () => {
    expect(decideUserId(null, '', { userId: null, source: 'skip' }).userId).toBe('local');
  });
});

describe('splitProvisionalDaemons: daemon-health 한 PC 두 줄 방지', () => {
  const real = { userId: 'MNREAL01', hostname: 'DESKTOP-A', state: 'ok' };
  const temp = { userId: 'pc_DESKTOP-A', hostname: 'DESKTOP-A', state: 'dead' };
  const unknownPc = { userId: 'pc_NEWPC', hostname: 'NEWPC', state: 'ok' };

  test('같은 PC 의 진짜 번호 줄이 있으면 임시 번호 줄은 provisional 로', () => {
    const r = splitProvisionalDaemons([real, temp, unknownPc], () => undefined);
    expect(r.daemons).toEqual([real, unknownPc]);
    expect(r.provisional).toEqual([{ ...temp, mappedUserId: null }]);
  });
  test('진짜 번호 줄이 없어도 pc_links 에 등록된 PC 면 provisional + 번호 표시', () => {
    const r = splitProvisionalDaemons([temp], h => (h === 'DESKTOP-A' ? 'MNREAL01' : undefined));
    expect(r.daemons).toEqual([]);
    expect(r.provisional[0].mappedUserId).toBe('MNREAL01');
  });
  test('등록 안 된 PC 의 임시 번호 줄은 본 목록에 남는다', () => {
    const r = splitProvisionalDaemons([unknownPc], () => null);
    expect(r.daemons).toEqual([unknownPc]);
    expect(r.provisional).toEqual([]);
  });
});

describe('server.js 배선', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  test('/api/hook 이 pc-link-cache 를 거친다(직접 조회 후 무음 fail-open 금지)', () => {
    const i = src.indexOf("app.post('/api/hook'");
    const body = src.slice(i, i + 4000);
    expect(body).toContain('_pcLinkCache.resolve(_pgPool, deviceId)');
    expect(body).toContain('pc_link lookup FAILED, no cache');
    expect(body).not.toContain('SELECT user_id FROM orbit_pc_links WHERE hostname = $1 LIMIT 1');
  });
  test('orbit_pc_links 에 번호를 쓰는 곳마다 캐시를 비운다', () => {
    const writes = (src.match(/INSERT INTO orbit_pc_links/g) || []).length;
    const invalidations = (src.match(/_pcLinkCache\.invalidate\(/g) || []).length;
    expect(writes).toBeGreaterThan(0);
    expect(invalidations).toBeGreaterThanOrEqual(writes);
  });
});

describe('canAutoLink: 자동 경로는 이미 묶인 컴퓨터·숨김 번호를 건드리지 못한다', () => {
  const { canAutoLink, AUTO_LINK_GUARD_SQL } = require('../../src/pc-link-cache');
  const hidden = id => id === 'MNHIDDEN01';

  test('묶음이 없거나 임시 번호로 묶인 컴퓨터는 진짜 번호로 묶을 수 있다', () => {
    expect(canAutoLink(null, 'MNREAL01', hidden)).toEqual({ ok: true });
    expect(canAutoLink('pc_DESKTOP-A', 'MNREAL01', hidden)).toEqual({ ok: true });
    expect(canAutoLink('local', 'MNREAL01', hidden)).toEqual({ ok: true });
  });
  test('이미 진짜 번호에 묶인 컴퓨터는 다른 번호로 덮어쓰지 못한다(2026-11-23 CAA5TA1 사고)', () => {
    expect(canAutoLink('MNREAL01', 'MNOTHER02', hidden)).toEqual({ ok: false, reason: 'already_linked' });
  });
  test('같은 번호로 다시 묶는 것은 허용(갱신)', () => {
    expect(canAutoLink('MNREAL01', 'MNREAL01', hidden)).toEqual({ ok: true });
  });
  test('숨김 번호로는 묶지 못한다(2026-11-23 HGNEA1S 사고) — 묶음이 없어도', () => {
    expect(canAutoLink(null, 'MNHIDDEN01', hidden)).toEqual({ ok: false, reason: 'hidden_target' });
    expect(canAutoLink('pc_X', 'MNHIDDEN01', hidden)).toEqual({ ok: false, reason: 'hidden_target' });
  });
  test('임시 번호·local 로는 묶지 못한다', () => {
    expect(canAutoLink(null, 'pc_DESKTOP-A', hidden).ok).toBe(false);
    expect(canAutoLink(null, 'local', hidden).ok).toBe(false);
  });
  test('기본 숨김 판정은 config/hidden-users.json 의 번호를 쓴다', () => {
    const ids = [...require('../../src/hidden-users').load().ids];
    expect(ids.length).toBeGreaterThan(0);
    expect(canAutoLink(null, ids[0])).toEqual({ ok: false, reason: 'hidden_target' });
  });
  test('SQL 가드는 임시 번호 줄만 덮어쓰게 한다', () => {
    expect(AUTO_LINK_GUARD_SQL).toContain("left(orbit_pc_links.user_id, 3) = 'pc_'");
    expect(AUTO_LINK_GUARD_SQL).not.toMatch(/TRUE|1\s*=\s*1/i);
  });
});

describe('pc-user-resolver: 숨김 번호를 돌려주지 않는다', () => {
  const resolver = require('../../src/pc-user-resolver');
  const hiddenIds = [...require('../../src/hidden-users').load().ids];

  test('같은 이름의 계정이 여럿이면 숨김이 아닌 번호를 고른다', async () => {
    const host = Object.keys(resolver.PC_NAME_MAP)[0];
    const pool = { query: jest.fn(async () => ({ rows: [{ id: hiddenIds[0] }, { id: 'MNREALNEW01' }] })) };
    expect(await resolver.resolveByName(pool, host)).toBe('MNREALNEW01');
  });
  test('숨김 번호만 있으면 매칭 없음', async () => {
    const host = Object.keys(resolver.PC_NAME_MAP)[0];
    const pool = { query: jest.fn(async () => ({ rows: [{ id: hiddenIds[0] }] })) };
    expect(await resolver.resolveByName(pool, host)).toBeNull();
  });
  test('직접 매핑 표에 DESKTOP-CAA5TA1 이 없다(잘못된 번호로 덮어쓴 원인 제거)', () => {
    expect(resolver.PC_USER_MAP['DESKTOP-CAA5TA1']).toBeUndefined();
    expect(resolver.resolveByDirect('DESKTOP-CAA5TA1')).toBeNull();
  });
  test('직접 매핑 값이 숨김 번호면 돌려주지 않는다', () => {
    for (const [host, id] of Object.entries(resolver.PC_USER_MAP)) {
      if (hiddenIds.includes(id)) expect(resolver.resolveByDirect(host)).toBeNull();
      else expect(resolver.resolveByDirect(host)).toBe(id);
    }
  });
});

describe('planInlineThumbs: /api/learning/logs 썸네일 예산', () => {
  const { planInlineThumbs } = require('../../src/pc-link-cache');
  const rows = [{ id: 'a', thumb_len: 80000 }, { id: 'b', thumb_len: '0' }, { id: 'c', thumb_len: 70000 }];

  test('원문 모드가 아니면 썸네일을 읽지 않는다', () => {
    expect(planInlineThumbs(rows, { raw: false })).toEqual({ ids: [], omitted: 0 });
  });
  test('원문 모드 + 예산 안 → 예전처럼 싣는다', () => {
    expect(planInlineThumbs(rows, { raw: true })).toEqual({ ids: ['a', 'c'], omitted: 0 });
  });
  test('원문 모드 + 예산 초과 → 한 장도 싣지 않는다(2,000줄 137MB 사고)', () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ id: 'e' + i, thumb_len: 68000 }));
    expect(planInlineThumbs(big, { raw: true })).toEqual({ ids: [], omitted: 2000 });
  });
  test('noThumb=1 이면 싣지 않는다', () => {
    expect(planInlineThumbs(rows, { raw: true, noThumb: true })).toEqual({ ids: [], omitted: 2 });
  });
});

describe('server.js 배선(묶음 덮어쓰기 가드 · 썸네일)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  test('자동 분류·link-pc·설치 이름 매칭의 덮어쓰기에 가드가 붙어 있다', () => {
    const guarded = (src.match(/WHERE \$\{_AUTO_LINK_GUARD_SQL\}/g) || []).length;
    expect(guarded).toBe(3);
    const i = src.indexOf("app.post('/api/daemon/link-pc'");
    expect(src.slice(i, i + 2500)).toContain('_canAutoLink(_exLink && _exLink.user_id, user.id)');
    const h = src.indexOf("app.post('/api/hook'");
    expect(src.slice(h, h + 6000)).toContain('_canAutoLink(_exLink && _exLink.user_id, r.userId)');
  });
  test('/api/learning/logs 는 썸네일을 본 조회에서 뺀다', () => {
    const i = src.indexOf("app.get('/api/learning/logs'");
    const body = src.slice(i, i + 6500);
    expect(body).toContain("(data_json - 'thumbnail') AS data_json");
    expect(body).toContain('_planInlineThumbs(finalRows');
    expect(body).not.toContain('"SELECT id, type, user_id, timestamp, data_json FROM events');
  });
});
