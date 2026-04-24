'use strict';
/**
 * src/intelligence/entity-resolution/scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer 2 매처/시더의 부팅·주기 실행 스케줄러.
 *
 *   - 부팅 즉시: Person 시드 (PC 매핑은 즉시 가능, 새 PC 자동 흡수)
 *   - 5분 후: 1차 매처/부트스트랩 (publisher가 일부 데이터 발행 시점)
 *   - 60분 주기: 매처/부트스트랩 반복 (멱등)
 *
 * 모두 멱등이라 동시 실행/재시도 안전.
 * 실패는 console.warn 만 — 서비스 영향 없음.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { seed: seedPerson }            = require('./seed-person-from-pc-links');
const { matchOnce: matchPersonERP }   = require('./match-person-erp');
const { bootstrap: bootstrapCustomer }= require('./bootstrap-customer');
const { matchOnce: matchCustomerFuzzy }= require('./match-customer-fuzzy');

let _pool = null;
let _running = false;
let _hourlyTimer = null;

async function _runSeedPerson() {
  try {
    const r = await seedPerson(_pool);
    console.log(`[er-scheduler] seed-person: seeded=${r.seeded} updated=${r.updated} skipped=${r.skipped} total=${r.total}`);
  } catch (e) {
    console.warn('[er-scheduler] seed-person 실패:', e.message);
  }
}

async function _runMatchersAndBootstrap() {
  try {
    const r = await matchPersonERP(_pool);
    console.log(`[er-scheduler] match-person-erp: candidates=${r.candidates} matched=${r.matched} skipped=${r.skipped} ambiguous=${r.ambiguous}`);
  } catch (e) {
    console.warn('[er-scheduler] match-person-erp 실패:', e.message);
  }
  try {
    const r = await bootstrapCustomer(_pool);
    console.log(`[er-scheduler] bootstrap-customer: candidates=${r.candidates} seeded=${r.seeded} skipped=${r.skipped}`);
  } catch (e) {
    console.warn('[er-scheduler] bootstrap-customer 실패:', e.message);
  }
  try {
    const r = await matchCustomerFuzzy(_pool);
    console.log(`[er-scheduler] match-customer-fuzzy: customers=${r.customers} orbit=${r.matchedOrbit} agent=${r.matchedAgent} skipped=${r.skipped}`);
  } catch (e) {
    console.warn('[er-scheduler] match-customer-fuzzy 실패:', e.message);
  }
}

/**
 * 시작.
 * @param {import('pg').Pool} pool
 * @param {object} opts { firstDelayMs: 5*60*1000, hourlyMs: 60*60*1000 }
 */
function start(pool, opts = {}) {
  if (_running) return;
  _pool = pool;
  _running = true;

  const firstDelay = opts.firstDelayMs ?? 5 * 60 * 1000;
  const hourlyMs   = opts.hourlyMs ?? 60 * 60 * 1000;

  // 1) 즉시: Person 시드
  _runSeedPerson().catch(() => {});

  // 2) 5분 후: 1차 매처
  setTimeout(() => {
    if (_running) _runMatchersAndBootstrap().catch(() => {});
  }, firstDelay);

  // 3) 60분 주기: Person 시드 + 매처/부트스트랩 반복
  _hourlyTimer = setInterval(() => {
    if (!_running) return;
    _runSeedPerson().catch(() => {});
    _runMatchersAndBootstrap().catch(() => {});
  }, hourlyMs);

  console.log(`[er-scheduler] 시작 (first=${firstDelay}ms, hourly=${hourlyMs}ms)`);
}

function stop() {
  _running = false;
  if (_hourlyTimer) { clearInterval(_hourlyTimer); _hourlyTimer = null; }
}

module.exports = { start, stop };
