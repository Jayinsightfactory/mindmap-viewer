'use strict';

// Share one refresh across concurrent callers. TTL starts at completion so slow
// aggregates cannot cause a new wave of queries while the first is still running.
function sharedAsyncCache(load, ttlMs, now = Date.now) {
  let value, expiresAt = 0, pending = null;
  return function cached() {
    if (expiresAt > now()) return Promise.resolve(value);
    if (pending) return pending;
    pending = Promise.resolve().then(load).then(result => {
      value = result;
      expiresAt = now() + ttlMs;
      return result;
    }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { sharedAsyncCache };
