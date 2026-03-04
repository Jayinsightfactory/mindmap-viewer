'use strict';
/**
 * routes/leaderboard.js
 * ─────────────────────────────────────────────────────────────────────────────
 * AI Leaderboard — 팀 내 AI 활용도 랭킹 + 게임화
 *
 * GET  /api/leaderboard                — 전체 랭킹
 * GET  /api/leaderboard/me             — 내 순위
 * GET  /api/leaderboard/weekly         — 이번 주 랭킹
 * GET  /api/leaderboard/tools          — 도구별 사용 랭킹
 * GET  /api/leaderboard/streaks        — 연속 사용일 랭킹
 * GET  /api/leaderboard/achievements   — 배지/업적 목록
 * GET  /api/leaderboard/achievements/:userId — 사용자 업적
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ─── 업적 정의 ────────────────────────────────────────────────────────────────
const ACHIEVEMENTS = [
  // 이벤트 수
  { id: 'first_event',    name: '첫 발걸음',      icon: '🚀', desc: '첫 AI 이벤트 기록',           condition: (s) => s.events >= 1 },
  { id: 'events_100',     name: '100클럽',         icon: '💯', desc: '누적 100개 이벤트',            condition: (s) => s.events >= 100 },
  { id: 'events_1000',    name: '천 번의 협력',    icon: '🌟', desc: '누적 1,000개 이벤트',         condition: (s) => s.events >= 1000 },
  { id: 'events_10000',   name: 'AI 마스터',       icon: '🏆', desc: '누적 10,000개 이벤트',        condition: (s) => s.events >= 10000 },

  // 세션 수
  { id: 'sessions_10',    name: '습관 형성',       icon: '📅', desc: '10회 세션 달성',              condition: (s) => s.sessions >= 10 },
  { id: 'sessions_100',   name: '꾸준한 동반자',   icon: '🤝', desc: '100회 세션 달성',             condition: (s) => s.sessions >= 100 },

  // 연속 사용
  { id: 'streak_3',       name: '3일 연속',        icon: '🔥', desc: '3일 연속 사용',               condition: (s) => s.streak >= 3 },
  { id: 'streak_7',       name: '1주 마스터',      icon: '🔥🔥', desc: '7일 연속 사용',             condition: (s) => s.streak >= 7 },
  { id: 'streak_30',      name: '30일 전설',       icon: '💎', desc: '30일 연속 사용',              condition: (s) => s.streak >= 30 },

  // 절감 시간
  { id: 'saved_1h',       name: '시간 절약자',     icon: '⏱️', desc: '1시간 이상 절감',             condition: (s) => s.savedHours >= 1 },
  { id: 'saved_10h',      name: '효율 전문가',     icon: '⚡', desc: '10시간 이상 절감',            condition: (s) => s.savedHours >= 10 },
  { id: 'saved_100h',     name: '생산성 챔피언',   icon: '👑', desc: '100시간 이상 절감',           condition: (s) => s.savedHours >= 100 },

  // 다양성
  { id: 'multi_tool',     name: '팔방미인',        icon: '🎯', desc: '5가지 이상 AI 도구 사용',     condition: (s) => s.toolTypes >= 5 },
  { id: 'multi_source',   name: '멀티플레이어',    icon: '🌐', desc: '3가지 이상 AI 소스 사용',     condition: (s) => s.sources >= 3 },

  // 공유
  { id: 'first_share',    name: '공유의 시작',     icon: '📤', desc: '첫 세션 공유',                condition: (s) => s.shares >= 1 },
  { id: 'shares_10',      name: '지식 나눔이',     icon: '🌍', desc: '10개 세션 공유',              condition: (s) => s.shares >= 10 },
];

// ─── 통계 계산 ────────────────────────────────────────────────────────────────

function computeUserStats(events, userId) {
  const userEvents = userId === '__all__'
    ? events
    : events.filter(e => (e.userId || 'local') === userId);

  const sessionSet   = new Set(userEvents.map(e => e.sessionId).filter(Boolean));
  const toolSet      = new Set(userEvents.map(e => e.type).filter(Boolean));
  const sourceSet    = new Set(userEvents.map(e => e.source).filter(Boolean));

  // 연속 사용 일수
  const dates = [...new Set(userEvents.map(e => (e.timestamp || '').slice(0, 10)).filter(Boolean))].sort();
  let streak = 0;
  if (dates.length > 0) {
    let checkDate = new Date().toISOString().slice(0, 10);
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] === checkDate) {
        streak++;
        const d = new Date(checkDate);
        d.setDate(d.getDate() - 1);
        checkDate = d.toISOString().slice(0, 10);
      } else if (dates[i] < checkDate) {
        break;
      }
    }
  }

  // 이번 주 이벤트
  const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString();
  const weekEvents = userEvents.filter(e => e.timestamp >= weekAgo).length;

  // 절감 시간 (이벤트당 2.5분 추정)
  const savedHours = Math.round(userEvents.length * 2.5 / 60 * 10) / 10;

  // 점수 계산
  const score = userEvents.length * 1
    + sessionSet.size * 5
    + streak * 10
    + weekEvents * 2
    + toolSet.size * 3
    + sourceSet.size * 5;

  return {
    userId,
    events:    userEvents.length,
    sessions:  sessionSet.size,
    streak,
    weekEvents,
    savedHours,
    toolTypes: toolSet.size,
    sources:   sourceSet.size,
    score:     Math.round(score),
    lastActive: userEvents.length > 0
      ? userEvents.reduce((m, e) => e.timestamp > m ? e.timestamp : m, '')
      : null,
  };
}

function computeAllUserStats(events) {
  const userIds = [...new Set(events.map(e => e.userId || 'local').filter(Boolean))];
  return userIds.map(uid => computeUserStats(events, uid)).sort((a, b) => b.score - a.score);
}

function getAchievements(stats) {
  return ACHIEVEMENTS.filter(ach => ach.condition(stats)).map(({ condition: _, ...rest }) => rest);
}

function getRank(allStats, userId) {
  const idx = allStats.findIndex(s => s.userId === userId);
  return idx >= 0 ? idx + 1 : null;
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createLeaderboardRouter({ getAllEvents, getSessions, optionalAuth } = {}) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;

  // ── 전체 랭킹 ─────────────────────────────────────────────────────────
  router.get('/leaderboard', (req, res) => {
    const { limit = 20, period } = req.query;
    let events = getAllEvents ? getAllEvents() : [];

    // 기간 필터
    if (period === 'week')  events = events.filter(e => e.timestamp >= new Date(Date.now() - 7  * 86400000).toISOString());
    if (period === 'month') events = events.filter(e => e.timestamp >= new Date(Date.now() - 30 * 86400000).toISOString());

    const allStats = computeAllUserStats(events);
    const rankedList = allStats
      .slice(0, Math.min(parseInt(limit) || 20, 100))
      .map((s, idx) => ({
        rank: idx + 1,
        ...s,
        achievements: getAchievements(s).length,
        topAchievement: getAchievements(s).slice(-1)[0] || null,
        medal: idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : null,
      }));

    res.json({
      leaderboard: rankedList,
      total:       allStats.length,
      period:      period || 'all-time',
      updatedAt:   new Date().toISOString(),
    });
  });

  // ── 내 순위 ───────────────────────────────────────────────────────────
  router.get('/leaderboard/me', auth, (req, res) => {
    const userId   = req.user?.id || 'local';
    const events   = getAllEvents ? getAllEvents() : [];
    const allStats = computeAllUserStats(events);
    const myStats  = allStats.find(s => s.userId === userId);

    if (!myStats) {
      return res.json({ rank: null, userId, message: '기록이 없습니다.' });
    }

    const rank         = getRank(allStats, userId);
    const achievements = getAchievements(myStats);
    const nextAchs     = ACHIEVEMENTS
      .filter(a => !achievements.find(ea => ea.id === a.id))
      .slice(0, 3)
      .map(({ condition: _, ...rest }) => rest);

    res.json({
      rank,
      total: allStats.length,
      percentile: allStats.length > 0 ? Math.round((1 - rank / allStats.length) * 100) : 0,
      ...myStats,
      achievements,
      nextAchievements: nextAchs,
    });
  });

  // ── 이번 주 랭킹 ──────────────────────────────────────────────────────
  router.get('/leaderboard/weekly', (req, res) => {
    const { limit = 10 } = req.query;
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const events  = (getAllEvents ? getAllEvents() : []).filter(e => e.timestamp >= weekAgo);

    const allStats = computeAllUserStats(events);
    const weekly   = allStats.slice(0, Math.min(parseInt(limit) || 10, 50)).map((s, i) => ({
      rank: i + 1, ...s,
      medal: i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null,
    }));

    res.json({ weekly, weekStart: weekAgo, total: allStats.length });
  });

  // ── 도구별 사용 랭킹 ──────────────────────────────────────────────────
  router.get('/leaderboard/tools', (req, res) => {
    const { limit = 15 } = req.query;
    const events = getAllEvents ? getAllEvents() : [];
    const toolCounts = {};

    for (const ev of events) {
      const t = ev.type || 'unknown';
      if (!toolCounts[t]) toolCounts[t] = { tool: t, uses: 0, users: new Set(), sessions: new Set() };
      toolCounts[t].uses++;
      if (ev.userId)    toolCounts[t].users.add(ev.userId);
      if (ev.sessionId) toolCounts[t].sessions.add(ev.sessionId);
    }

    const ranked = Object.values(toolCounts)
      .map(t => ({ ...t, users: t.users.size, sessions: t.sessions.size }))
      .sort((a, b) => b.uses - a.uses)
      .slice(0, Math.min(parseInt(limit) || 15, 50))
      .map((t, i) => ({ rank: i + 1, ...t }));

    res.json({ tools: ranked, total: Object.keys(toolCounts).length });
  });

  // ── 연속 사용일 랭킹 ──────────────────────────────────────────────────
  router.get('/leaderboard/streaks', (req, res) => {
    const events   = getAllEvents ? getAllEvents() : [];
    const allStats = computeAllUserStats(events);
    const streaks  = allStats
      .filter(s => s.streak > 0)
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 20)
      .map((s, i) => ({ rank: i + 1, userId: s.userId, streak: s.streak, score: s.score }));

    res.json({ streaks });
  });

  // ── 전체 업적 목록 ────────────────────────────────────────────────────
  router.get('/leaderboard/achievements', (req, res) => {
    res.json({
      achievements: ACHIEVEMENTS.map(({ condition: _, ...rest }) => rest),
      total: ACHIEVEMENTS.length,
    });
  });

  // ── 사용자 업적 ───────────────────────────────────────────────────────
  router.get('/leaderboard/achievements/:userId', (req, res) => {
    const events = getAllEvents ? getAllEvents() : [];
    const stats  = computeUserStats(events, req.params.userId);
    const earned = getAchievements(stats);
    const locked = ACHIEVEMENTS
      .filter(a => !earned.find(e => e.id === a.id))
      .map(({ condition: _, ...rest }) => rest);

    res.json({
      userId:     req.params.userId,
      earned,
      locked,
      progress: {
        earned: earned.length,
        total:  ACHIEVEMENTS.length,
        pct:    Math.round(earned.length / ACHIEVEMENTS.length * 100),
      },
      stats,
    });
  });

  return router;
}

module.exports = createLeaderboardRouter;
