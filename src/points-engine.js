'use strict';
/**
 * src/points-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orbit Points Economy
 *
 * 포인트 누적 → 구독 할인 / 마켓 아이템 교환
 *
 * 적립 규칙:
 *   - AI 이벤트 1개 = 1pt
 *   - 세션 완료 = 10pt
 *   - 업적 달성 = 50~200pt
 *   - 마켓 아이템 배포 = 500pt
 *   - 세션 공유 = 30pt
 *   - 일일 접속 = 5pt
 *   - 7일 연속 = 100pt 보너스
 *   - MCP 서버 추천 = 20pt
 *
 * 사용 규칙:
 *   - 100pt = $1 구독 할인
 *   - 500pt = 마켓 유료 아이템 1개 교환
 *   - 1000pt = 1개월 무료 구독
 *
 * API:
 *   GET  /api/points/balance          — 내 포인트 잔액
 *   GET  /api/points/history          — 포인트 이력
 *   GET  /api/points/leaderboard      — 포인트 리더보드
 *   POST /api/points/redeem           — 포인트 사용
 *   GET  /api/points/rewards          — 사용 가능 리워드 목록
 *   POST /api/points/award            — 포인트 수동 지급 (관리자)
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ─── 포인트 저장소 (인메모리) ─────────────────────────────────────────────────
const pointsLedger = new Map(); // userId → { balance, totalEarned, totalSpent, history[] }

// ─── 적립 규칙 ────────────────────────────────────────────────────────────────
const EARN_RULES = {
  'event':           { pts: 1,   label: 'AI 이벤트',        maxPerDay: 500 },
  'session':         { pts: 10,  label: '세션 완료',         maxPerDay: 50 },
  'achievement':     { pts: 100, label: '업적 달성',         maxPerDay: null },
  'market_publish':  { pts: 500, label: '마켓 아이템 배포',  maxPerDay: null },
  'session_share':   { pts: 30,  label: '세션 공유',         maxPerDay: 5 },
  'daily_login':     { pts: 5,   label: '일일 접속',         maxPerDay: 1 },
  'streak_7':        { pts: 100, label: '7일 연속 보너스',   maxPerDay: null },
  'streak_30':       { pts: 500, label: '30일 연속 보너스',  maxPerDay: null },
  'mcp_recommend':   { pts: 20,  label: 'MCP 서버 추천',     maxPerDay: 3 },
  'feedback':        { pts: 15,  label: '피드백 제출',       maxPerDay: 2 },
  'invite':          { pts: 200, label: '친구 초대',         maxPerDay: null },
};

// ─── 리워드 목록 ──────────────────────────────────────────────────────────────
const REWARDS = [
  { id: 'discount_1',   name: '$1 구독 할인',      cost: 100,  type: 'discount',     value: 1,   description: '다음 구독 결제 $1 할인' },
  { id: 'discount_5',   name: '$5 구독 할인',      cost: 500,  type: 'discount',     value: 5,   description: '다음 구독 결제 $5 할인' },
  { id: 'discount_10',  name: '$10 구독 할인',     cost: 1000, type: 'discount',     value: 10,  description: '다음 구독 결제 $10 할인' },
  { id: 'free_month',   name: '1개월 무료 구독',   cost: 2000, type: 'subscription', value: 30,  description: '구독 30일 무료 연장' },
  { id: 'market_item',  name: '마켓 아이템 교환',  cost: 500,  type: 'market',       value: 1,   description: '유료 마켓 아이템 1개 무료 교환' },
  { id: 'badge_gold',   name: '골드 배지',         cost: 300,  type: 'cosmetic',     value: 0,   description: '프로필 골드 배지 획득' },
  { id: 'badge_diamond',name: '다이아몬드 배지',   cost: 1000, type: 'cosmetic',     value: 0,   description: '프로필 다이아몬드 배지 획득' },
  { id: 'export_pdf',   name: 'PDF 리포트 생성',   cost: 50,   type: 'feature',      value: 0,   description: '활동 PDF 리포트 즉시 생성' },
  { id: 'priority_ai',  name: '우선 AI 응답',      cost: 200,  type: 'feature',      value: 7,   description: '7일간 AI 응답 우선 처리' },
];

// ─── 포인트 헬퍼 ──────────────────────────────────────────────────────────────

function getOrInit(userId) {
  if (!pointsLedger.has(userId)) {
    pointsLedger.set(userId, {
      userId,
      balance:     0,
      totalEarned: 0,
      totalSpent:  0,
      level:       1,
      history:     [],
      redeemedRewards: [],
      badges:      [],
    });
  }
  return pointsLedger.get(userId);
}

function awardPoints(userId, reason, pts, description = '') {
  const account = getOrInit(userId);
  account.balance     += pts;
  account.totalEarned += pts;

  account.history.unshift({
    id:          `pt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type:        'earn',
    reason,
    pts,
    balance:     account.balance,
    description: description || EARN_RULES[reason]?.label || reason,
    at:          new Date().toISOString(),
  });

  // 최대 500개 이력 유지
  if (account.history.length > 500) account.history = account.history.slice(0, 500);

  // 레벨업 계산 (100pt당 1레벨, 최대 100레벨)
  account.level = Math.min(100, Math.floor(account.totalEarned / 100) + 1);

  return { userId, pts, balance: account.balance, level: account.level };
}

function spendPoints(userId, rewardId, cost) {
  const account = getOrInit(userId);
  if (account.balance < cost) {
    throw new Error(`포인트가 부족합니다. (보유: ${account.balance}, 필요: ${cost})`);
  }
  account.balance   -= cost;
  account.totalSpent += cost;

  account.history.unshift({
    id:      `pt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type:    'spend',
    reason:  rewardId,
    pts:     -cost,
    balance: account.balance,
    at:      new Date().toISOString(),
  });

  return { userId, spent: cost, balance: account.balance };
}

// ─── 이벤트 기반 자동 포인트 계산 ────────────────────────────────────────────

function computePointsFromEvents(events = [], userId = 'local') {
  let total = 0;
  const earned = [];

  // 이벤트 포인트
  const evPts = Math.min(events.length, EARN_RULES.event.maxPerDay * 365);
  if (evPts > 0) { earned.push({ reason: 'event', pts: evPts }); total += evPts; }

  // 세션 포인트
  const sessionIds = new Set(events.map(e => e.sessionId).filter(Boolean));
  const sesPts = sessionIds.size * EARN_RULES.session.pts;
  if (sesPts > 0) { earned.push({ reason: 'session', pts: sesPts }); total += sesPts; }

  // 연속 사용 포인트
  const dates = [...new Set(events.map(e => (e.timestamp || '').slice(0, 10)).filter(Boolean))].sort();
  if (dates.length >= 30) { earned.push({ reason: 'streak_30', pts: EARN_RULES.streak_30.pts }); total += EARN_RULES.streak_30.pts; }
  else if (dates.length >= 7) { earned.push({ reason: 'streak_7', pts: EARN_RULES.streak_7.pts }); total += EARN_RULES.streak_7.pts; }

  // 일일 접속
  const loginPts = dates.length * EARN_RULES.daily_login.pts;
  if (loginPts > 0) { earned.push({ reason: 'daily_login', pts: loginPts }); total += loginPts; }

  return { total, earned, userId };
}

// ─── 레벨 계산 ────────────────────────────────────────────────────────────────
function getLevel(totalEarned) {
  const level = Math.min(100, Math.floor(totalEarned / 100) + 1);
  const nextLevelPts = level * 100;
  const currentLevelPts = (level - 1) * 100;
  const progress = ((totalEarned - currentLevelPts) / (nextLevelPts - currentLevelPts)) * 100;
  return {
    level,
    progress: Math.round(progress),
    nextLevelAt: nextLevelPts,
    title: level >= 80 ? '전설' : level >= 60 ? '마스터' : level >= 40 ? '전문가' : level >= 20 ? '숙련자' : level >= 10 ? '중급자' : '입문자',
  };
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createPointsRouter({ getAllEvents, getSessions, optionalAuth } = {}) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;

  // ── 내 포인트 잔액 ────────────────────────────────────────────────────
  router.get('/points/balance', auth, (req, res) => {
    const userId  = req.user?.id || 'local';
    const events  = (getAllEvents ? getAllEvents() : []).filter(e => (e.userId || 'local') === userId);
    const computed = computePointsFromEvents(events, userId);

    // 계정 초기화 및 이벤트 기반 포인트 적용
    const account = getOrInit(userId);
    if (account.totalEarned === 0 && computed.total > 0) {
      account.balance     = computed.total;
      account.totalEarned = computed.total;
      account.level       = getLevel(computed.total).level;
    }

    const levelInfo = getLevel(account.totalEarned);

    res.json({
      userId,
      balance:       account.balance,
      totalEarned:   account.totalEarned,
      totalSpent:    account.totalSpent,
      ...levelInfo,
      rank:          [...pointsLedger.values()].filter(a => a.totalEarned > account.totalEarned).length + 1,
    });
  });

  // ── 포인트 이력 ───────────────────────────────────────────────────────
  router.get('/points/history', auth, (req, res) => {
    const userId  = req.user?.id || 'local';
    const account = getOrInit(userId);
    const { limit = 50, type } = req.query;
    let history = account.history;
    if (type) history = history.filter(h => h.type === type);
    res.json({ history: history.slice(0, Math.min(parseInt(limit) || 50, 200)), total: account.history.length });
  });

  // ── 포인트 리더보드 ───────────────────────────────────────────────────
  router.get('/points/leaderboard', (req, res) => {
    const { limit = 20 } = req.query;
    const all = [...pointsLedger.values()]
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .slice(0, Math.min(parseInt(limit) || 20, 100))
      .map((a, i) => ({
        rank:       i + 1,
        userId:     a.userId,
        balance:    a.balance,
        totalEarned: a.totalEarned,
        level:      getLevel(a.totalEarned).level,
        levelTitle: getLevel(a.totalEarned).title,
        medal:      i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null,
      }));
    res.json({ leaderboard: all, total: pointsLedger.size });
  });

  // ── 리워드 목록 ───────────────────────────────────────────────────────
  router.get('/points/rewards', auth, (req, res) => {
    const userId   = req.user?.id || 'local';
    const account  = getOrInit(userId);
    const rewards  = REWARDS.map(r => ({ ...r, affordable: account.balance >= r.cost }));
    res.json({ rewards, balance: account.balance });
  });

  // ── 포인트 사용 (리워드 교환) ─────────────────────────────────────────
  router.post('/points/redeem', auth, (req, res) => {
    const userId   = req.user?.id || 'local';
    const { rewardId } = req.body;
    if (!rewardId) return res.status(400).json({ error: 'rewardId 필드가 필요합니다.' });

    const reward = REWARDS.find(r => r.id === rewardId);
    if (!reward) return res.status(404).json({ error: '리워드를 찾을 수 없습니다.' });

    try {
      const result  = spendPoints(userId, rewardId, reward.cost);
      const account = getOrInit(userId);
      account.redeemedRewards.push({
        rewardId,
        rewardName: reward.name,
        at:         new Date().toISOString(),
        cost:       reward.cost,
      });
      res.json({ success: true, reward, ...result });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── 포인트 수동 지급 ──────────────────────────────────────────────────
  router.post('/points/award', auth, (req, res) => {
    const { userId = 'local', reason, pts, description } = req.body;
    if (!reason || !pts) return res.status(400).json({ error: 'reason, pts 필드가 필요합니다.' });

    const result = awardPoints(userId, reason, parseInt(pts), description);
    res.json({ success: true, ...result });
  });

  // ── 포인트 통계 ───────────────────────────────────────────────────────
  router.get('/points/stats', (req, res) => {
    const accounts = [...pointsLedger.values()];
    res.json({
      totalUsers:       accounts.length,
      totalPointsInCirculation: accounts.reduce((s, a) => s + a.balance, 0),
      totalPointsEarned: accounts.reduce((s, a) => s + a.totalEarned, 0),
      totalPointsSpent:  accounts.reduce((s, a) => s + a.totalSpent, 0),
      avgBalance:        accounts.length > 0 ? Math.round(accounts.reduce((s, a) => s + a.balance, 0) / accounts.length) : 0,
    });
  });

  return router;
}

module.exports = {
  awardPoints,
  spendPoints,
  computePointsFromEvents,
  getLevel,
  EARN_RULES,
  REWARDS,
  createPointsRouter,
};
