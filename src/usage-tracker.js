'use strict';
/**
 * usage-tracker.js
 * 사용량 집계 + 월말 정산 스케줄러
 *
 * - 매일 자정: 전날 사용량 집계 로그 출력
 * - 매월 1일 01:00: 지난달 정산 자동 실행
 */

const marketStore = require('./market-store');

let _broadcastAll = null;
let _intervalId   = null;
let _started      = false;

/**
 * 트래커 시작
 * @param {{ broadcastAll: Function }} opts
 */
function start({ broadcastAll } = {}) {
  if (_started) return;
  _started      = true;
  _broadcastAll = broadcastAll || (() => {});

  // 1분마다 스케줄 체크 (cron 라이브러리 없이 경량 구현)
  _intervalId = setInterval(checkSchedule, 60 * 1000);

  console.log('[USAGE-TRACKER] 스케줄러 시작됨 (1분 간격 체크)');
}

function stop() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
  }
  _started = false;
}

/** 마지막 실행 날짜 추적 (메모리, 재시작 시 초기화됨) */
const lastRun = {
  dailyDate:   null,  // YYYY-MM-DD
  monthlyMonth: null, // YYYY-MM
};

function checkSchedule() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);          // YYYY-MM-DD
  const month = now.toISOString().slice(0, 7);           // YYYY-MM
  const hour  = now.getHours();

  // ── 일별 집계 (자정~01시 사이, 하루 1회) ──────────────────────────────
  if (hour === 0 && lastRun.dailyDate !== today) {
    lastRun.dailyDate = today;
    runDailySummary(today);
  }

  // ── 월말 정산 (매월 1일 01시, 월 1회) ────────────────────────────────
  if (now.getDate() === 1 && hour === 1 && lastRun.monthlyMonth !== month) {
    lastRun.monthlyMonth = month;
    runMonthlyJob(now);
  }
}

function runDailySummary(today) {
  try {
    // 전날 날짜
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().slice(0, 10);

    const leaderboard = marketStore.getLeaderboard({ period: 1, limit: 5 });
    console.log(`[USAGE-TRACKER] ${dateStr} 일별 TOP5:`);
    leaderboard.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.name} (사용: ${item.period_usage || 0}, 수익: $${(item.period_revenue || 0).toFixed(2)})`);
    });

    // WebSocket으로 대시보드 갱신 알림
    _broadcastAll({
      type:      'market.daily_summary',
      date:      dateStr,
      leaderboard,
    });
  } catch (e) {
    console.error('[USAGE-TRACKER] 일별 집계 오류:', e.message);
  }
}

function runMonthlyJob(now) {
  try {
    // 지난달
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const period = lastMonth.toISOString().slice(0, 7);

    console.log(`[USAGE-TRACKER] ${period} 월말 정산 시작...`);
    const count = marketStore.runMonthlyDistribution(period);
    console.log(`[USAGE-TRACKER] ${period} 정산 완료: ${count}명 기여자`);

    _broadcastAll({
      type:    'market.monthly_distribution',
      period,
      count,
      message: `${period} 수익 정산이 완료되었습니다. ${count}명의 기여자에게 정산 내역이 생성되었습니다.`,
    });
  } catch (e) {
    console.error('[USAGE-TRACKER] 월말 정산 오류:', e.message);
  }
}

/**
 * 수동으로 특정 기간 정산 실행 (API에서 호출)
 * @param {string} period YYYY-MM
 */
function manualDistribute(period) {
  return marketStore.runMonthlyDistribution(period);
}

module.exports = { start, stop, manualDistribute };
