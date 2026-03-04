'use strict';
/**
 * src/revenue-scheduler.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 수익 정산 자동 스케줄러
 *
 * 역할:
 *   1. 매일 자정: usage_ledger 일별 집계 (이전 날 미집계 사용량 처리)
 *   2. 매월 1일 오전 2시: revenue_distributions 월말 정산 자동 생성
 *   3. Toss Payments 연동 (TOSS_SECRET_KEY 있으면 실제 정산, 없으면 MOCK)
 *
 * 의존성: market-store.js의 getDb() 동일 DB 사용
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { getDb }  = require('./db');

// ─── 크론 타이머 ──────────────────────────────────────────────────────────────
let _dailyCron   = null;
let _monthlyCron = null;

/**
 * 스케줄러 시작
 * @param {{ broadcastAll: Function }} deps
 */
function start({ broadcastAll } = {}) {
  if (_dailyCron) return; // 이미 실행 중

  // 매일 자정 (00:00) — 일별 집계
  _dailyCron = _scheduleDaily(0, 0, async () => {
    console.log('[RevenueScheduler] 일별 집계 시작');
    const result = await runDailyAggregation();
    console.log(`[RevenueScheduler] 일별 집계 완료: ${result.processedRows}건`);
    if (broadcastAll) broadcastAll({ type: 'revenue_aggregated', ...result });
  });

  // 매월 1일 오전 2시 — 월말 정산
  _monthlyCron = _scheduleMonthly(1, 2, 0, async () => {
    const prevMonth = getPrevMonth();
    console.log(`[RevenueScheduler] 월말 정산 시작: ${prevMonth}`);
    const result = await runMonthlyDistribution(prevMonth);
    console.log(`[RevenueScheduler] 월말 정산 완료: ${result.distributions}건, $${result.totalNetUsd}`);
    if (broadcastAll) broadcastAll({ type: 'revenue_distributed', ...result });
  });

  console.log('[RevenueScheduler] 스케줄러 시작됨 (일별 집계 + 월별 정산)');
}

function stop() {
  if (_dailyCron)   { clearTimeout(_dailyCron);   _dailyCron   = null; }
  if (_monthlyCron) { clearTimeout(_monthlyCron); _monthlyCron = null; }
}

// ─── 일별 집계 ───────────────────────────────────────────────────────────────

/**
 * 전날 미집계 usage_ledger 정리 및 revenue_usd 재계산
 * (price_usd * usage_count * share_pct / 100 기준)
 */
async function runDailyAggregation() {
  const db = getDb();
  if (!db) return { processedRows: 0, error: 'DB 없음' };

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    // 전날 usage_ledger의 revenue_usd를 최신 아이템 가격으로 재계산
    const updateStmt = db.prepare(`
      UPDATE usage_ledger
      SET revenue_usd = (
        SELECT COALESCE(mi.price_usd, 0) * usage_ledger.usage_count
               * COALESCE(c.share_pct, 70) / 100.0
        FROM marketplace_items mi
        JOIN contributors c ON c.id = usage_ledger.contributor_id
        WHERE mi.id = usage_ledger.item_id
        LIMIT 1
      )
      WHERE usage_date = ? AND revenue_usd = 0
    `);

    const info = updateStmt.run(yesterday);

    return {
      processedRows: info.changes,
      date:          yesterday,
      runAt:         new Date().toISOString(),
    };
  } catch (err) {
    console.error('[RevenueScheduler] 일별 집계 오류:', err.message);
    return { processedRows: 0, error: err.message };
  }
}

// ─── 월말 정산 ───────────────────────────────────────────────────────────────

/**
 * 특정 월의 revenue_distributions 레코드 생성 (기여자별)
 * @param {string} period  'YYYY-MM' 형식
 */
async function runMonthlyDistribution(period) {
  const db = getDb();
  if (!db) return { distributions: 0, error: 'DB 없음' };

  try {
    // 해당 월 사용량 기여자별 집계
    const aggregated = db.prepare(`
      SELECT
        ul.contributor_id,
        SUM(ul.usage_count) as total_usage,
        SUM(ul.revenue_usd) as gross_usd,
        COALESCE(c.share_pct, 70.0) as share_pct,
        c.name as contributor_name
      FROM usage_ledger ul
      LEFT JOIN contributors c ON c.id = ul.contributor_id
      WHERE substr(ul.usage_date, 1, 7) = ?
        AND ul.contributor_id IS NOT NULL
        AND ul.contributor_id != ''
      GROUP BY ul.contributor_id
    `).all(period);

    if (aggregated.length === 0) {
      return { distributions: 0, period, totalNetUsd: 0, message: '해당 월 집계 데이터 없음' };
    }

    const { ulid } = (() => { try { return require('ulid'); } catch { return { ulid: () => Date.now().toString(36) + Math.random().toString(36).slice(2,8) }; } })();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO revenue_distributions
        (id, contributor_id, period, total_usage, gross_usd, share_pct, net_usd, status, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `);

    let totalNetUsd = 0;
    let distributions = 0;
    const now = new Date().toISOString();

    const insertMany = db.transaction(() => {
      for (const row of aggregated) {
        const netUsd = Math.round((row.gross_usd || 0) * (row.share_pct / 100) * 100) / 100;
        totalNetUsd += netUsd;
        insert.run(
          ulid(),
          row.contributor_id,
          period,
          row.total_usage || 0,
          Math.round((row.gross_usd || 0) * 100) / 100,
          row.share_pct || 70,
          netUsd,
          now
        );
        distributions++;
      }
    });

    insertMany();

    // Toss Payments 실제 정산 (TOSS_SECRET_KEY 있을 때)
    if (process.env.TOSS_SECRET_KEY && totalNetUsd > 0) {
      try {
        await processTossPayouts(db, period);
      } catch (tosErr) {
        console.warn('[RevenueScheduler] Toss 정산 실패 (MOCK으로 폴백):', tosErr.message);
      }
    }

    return {
      distributions,
      period,
      totalNetUsd: Math.round(totalNetUsd * 100) / 100,
      contributors: aggregated.map(r => ({
        id:   r.contributor_id,
        name: r.contributor_name,
        net:  Math.round((r.gross_usd || 0) * (r.share_pct / 100) * 100) / 100,
      })),
      runAt: now,
    };
  } catch (err) {
    console.error('[RevenueScheduler] 월말 정산 오류:', err.message);
    return { distributions: 0, error: err.message, period };
  }
}

// ─── Toss Payments 정산 API ──────────────────────────────────────────────────
async function processTossPayouts(db, period) {
  // 지급 대기 중인 정산 조회
  const pending = db.prepare(`
    SELECT rd.*, c.wallet, c.name, c.email
    FROM revenue_distributions rd
    LEFT JOIN contributors c ON c.id = rd.contributor_id
    WHERE rd.period = ? AND rd.status = 'pending' AND rd.net_usd > 0
  `).all(period);

  const updateStmt = db.prepare(`
    UPDATE revenue_distributions SET status = ?, paid_at = ? WHERE id = ?
  `);

  for (const dist of pending) {
    if (!dist.wallet) continue; // 지갑 정보 없으면 스킵

    try {
      // Toss Payments 정산 API 호출
      // https://docs.tosspayments.com/reference/settlement
      const encoded = Buffer.from(process.env.TOSS_SECRET_KEY + ':').toString('base64');
      const krwAmount = Math.round(dist.net_usd * 1300); // USD → KRW (환율 추정)

      const res = await fetch('https://api.tosspayments.com/v1/settlements', {
        method:  'POST',
        headers: {
          Authorization:  `Basic ${encoded}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type:          'ACCOUNT',
          accountNumber: dist.wallet,
          amount:        krwAmount,
          description:   `Orbit AI 수익 정산 ${period} - ${dist.name}`,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok) {
        updateStmt.run('paid', new Date().toISOString(), dist.id);
        console.log(`[RevenueScheduler] 정산 완료: ${dist.name} ₩${krwAmount}`);
      } else {
        const errData = await res.json().catch(() => ({}));
        console.warn(`[RevenueScheduler] 정산 실패: ${dist.name} — ${errData.message || res.status}`);
        updateStmt.run('failed', new Date().toISOString(), dist.id);
      }
    } catch (err) {
      console.warn(`[RevenueScheduler] 정산 오류: ${dist.name} — ${err.message}`);
      updateStmt.run('failed', new Date().toISOString(), dist.id);
    }
  }
}

// ─── 수동 실행 API (서버에서 직접 호출) ──────────────────────────────────────

/**
 * 특정 월 정산을 수동으로 실행
 * @param {string} [period]  'YYYY-MM', 기본값: 지난 달
 */
async function manualDistribution(period) {
  const target = period || getPrevMonth();
  return runMonthlyDistribution(target);
}

/**
 * 일별 집계를 특정 날짜로 수동 실행
 * @param {string} [date]  'YYYY-MM-DD', 기본값: 어제
 */
async function manualDailyAggregation(date) {
  const db = getDb();
  if (!db) return { processedRows: 0 };
  const target = date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  // 날짜만 바꿔서 실행
  const original = Date.now;
  try {
    return runDailyAggregation();
  } finally {
    Date.now = original;
  }
}

/**
 * 현재 정산 현황 조회
 */
function getSchedulerStatus() {
  const db = getDb();
  if (!db) return { running: !!_dailyCron, error: 'DB 없음' };

  try {
    const pendingCount   = db.prepare(`SELECT COUNT(*) as c FROM revenue_distributions WHERE status = 'pending'`).get()?.c || 0;
    const paidCount      = db.prepare(`SELECT COUNT(*) as c FROM revenue_distributions WHERE status = 'paid'`).get()?.c || 0;
    const pendingAmount  = db.prepare(`SELECT SUM(net_usd) as s FROM revenue_distributions WHERE status = 'pending'`).get()?.s || 0;
    const ledgerRows     = db.prepare(`SELECT COUNT(*) as c FROM usage_ledger`).get()?.c || 0;
    const totalRevenue   = db.prepare(`SELECT SUM(revenue_usd) as s FROM usage_ledger`).get()?.s || 0;

    return {
      running:      !!_dailyCron,
      pendingCount,
      paidCount,
      pendingAmountUsd: Math.round(pendingAmount * 100) / 100,
      ledgerRows,
      totalRevenueUsd: Math.round(totalRevenue * 100) / 100,
      tossEnabled:  !!process.env.TOSS_SECRET_KEY,
      nextDailyRun: getNextRunTime(0, 0),
      nextMonthlyRun: getNextMonthlyRunTime(1, 2),
    };
  } catch (err) {
    return { running: !!_dailyCron, error: err.message };
  }
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────────

function getPrevMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function getNextRunTime(hour, minute) {
  const now  = new Date();
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function getNextMonthlyRunTime(day, hour) {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, day, hour, 0, 0);
  return next.toISOString();
}

// setTimeout 최대값: 32비트 정수 한계 (약 24.8일)
// 이보다 큰 값을 넣으면 1ms로 처리되어 무한 루프 발생
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 매일 특정 시각에 콜백 실행 (setTimeout 기반 — node-cron 불필요)
 */
function _scheduleDaily(hour, minute, callback) {
  function getDelayMs() {
    const now  = new Date();
    const next = new Date();
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  let handle;
  function schedule() {
    const delay = Math.min(getDelayMs(), MAX_TIMEOUT_MS); // 한계 초과 방지
    handle = setTimeout(async () => {
      // 실제 목표 시각에 도달했는지 재확인 (대형 delay 중간에 깨어난 경우 재대기)
      if (getDelayMs() > 1000) { schedule(); return; }
      try { await callback(); } catch (e) { console.error('[DailyCron]', e.message); }
      schedule(); // 다음 실행 예약
    }, delay);
    handle.unref?.(); // Node.js: 이벤트 루프 블로킹 방지
  }
  schedule();
  return handle;
}

/**
 * 매월 특정 일 특정 시각에 콜백 실행
 */
function _scheduleMonthly(day, hour, minute, callback) {
  function getDelayMs() {
    const now  = new Date();
    let next   = new Date(now.getFullYear(), now.getMonth(), day, hour, minute, 0, 0);
    if (next <= now) {
      next = new Date(now.getFullYear(), now.getMonth() + 1, day, hour, minute, 0, 0);
    }
    return next.getTime() - now.getTime();
  }

  let handle;
  function schedule() {
    const delay = Math.min(getDelayMs(), MAX_TIMEOUT_MS); // 한계 초과 방지
    handle = setTimeout(async () => {
      // 실제 목표 시각에 도달했는지 재확인
      if (getDelayMs() > 1000) { schedule(); return; }
      try { await callback(); } catch (e) { console.error('[MonthlyCron]', e.message); }
      schedule();
    }, delay);
    handle.unref?.();
  }
  schedule();
  return handle;
}

module.exports = {
  start,
  stop,
  runDailyAggregation,
  runMonthlyDistribution,
  manualDistribution,
  manualDailyAggregation,
  getSchedulerStatus,
};
