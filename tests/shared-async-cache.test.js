'use strict';
const { sharedAsyncCache } = require('../src/shared-async-cache');

test('concurrent refreshes share one query and expire from completion', async () => {
  let now = 0, finish;
  const load = jest.fn(() => new Promise(resolve => { finish = resolve; }));
  const cached = sharedAsyncCache(load, 60_000, () => now);
  const callers = Array.from({ length: 100 }, () => cached());
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(1);
  now = 10_000;
  finish({ count: 12 });
  expect(await Promise.all(callers)).toEqual(Array(100).fill({ count: 12 }));
  now = 69_999;
  expect(await cached()).toEqual({ count: 12 });
  expect(load).toHaveBeenCalledTimes(1);
  now = 70_000;
  const next = cached();
  await Promise.resolve();
  expect(load).toHaveBeenCalledTimes(2);
  finish({ count: 13 });
  expect(await next).toEqual({ count: 13 });
});

test('failed refresh releases the in-flight promise for retry', async () => {
  const load = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(7);
  const cached = sharedAsyncCache(load, 60_000);
  await expect(cached()).rejects.toThrow('offline');
  expect(await cached()).toBe(7);
  expect(load).toHaveBeenCalledTimes(2);
});
