'use strict';
/**
 * routes/personal-insights.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 개인/팀 인사이트 분리 API
 *
 * GET  /api/me/insights        — 내 인사이트 (사용자별 필터)
 * GET  /api/me/ai-savings      — AI 도구로 절약된 추정 시간
 * GET  /api/me/skill-growth    — 기술 성장 추적 (tool 사용 패턴)
 * POST /api/me/share-consent   — 팀 집계 동의 여부 설정
 * GET  /api/me/share-history   — 공유 동의 기록
 * GET  /api/team/aggregate     — 팀 익명 집계 (최소 5인 이상만)
 * GET  /api/me/weekly-report   — 개인 주간 리포트
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

function createPersonalInsightsRouter({ getAllEvents, getStats, getSessions, getEventsForUser, getSessionsForUser, resolveUserId, authMiddleware, optionalAuth, getInsights }) {
  const router = express.Router();

  // ── 개인 인사이트 목록 ───────────────────────────────────────────────────
  // 사용자가 로그인된 경우 user_id로 필터링, 미로그인 시 전체 반환
  router.get('/me/insights', optionalAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      // 사용자 필터 (user_id 파라미터 또는 인증 토큰)
      const userId = req.user?.id || req.query.userId || 'local';
      const allInsights = typeof getInsights === 'function' ? getInsights(limit * 2, userId) : [];

      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const events = getEventsForUser ? getEventsForUser(resolveUserId(req)) : getAllEvents();
      const userEvents = events.filter(e => (e.userId || e.user_id || 'local') === userId);
      const userRatio = events.length > 0 ? userEvents.length / events.length : 1;

      // 인사이트에 개인화 스코어 추가
      const personalInsights = allInsights.slice(0, limit).map(ins => ({
        ...ins,
        personalScore: (ins.confidence || 0.5) * (userRatio > 0.1 ? userRatio + 0.5 : 0.5),
        userId,
        isPersonalized: userRatio > 0.01,
      }));

      res.json({
        insights: personalInsights,
        meta: {
          userId,
          totalEvents: events.length,
          myEvents: userEvents.length,
          myRatio: Math.round(userRatio * 100),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── AI 절약 시간 추정 ────────────────────────────────────────────────────
  router.get('/me/ai-savings', optionalAuth, (req, res) => {
    try {
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const events   = getEventsForUser ? getEventsForUser(resolveUserId(req)) : getAllEvents();
      const userId   = req.user?.id || req.query.userId || 'local';
      const myEvents = events.filter(e => (e.userId || e.user_id || 'local') === userId);

      // AI 도구별 절약 시간 추정 (경험적 값)
      const SAVINGS_PER_TOOL = {
        'tool.start':     0,      // 도구 시작 — 0 (시작만)
        'tool.end':       2.5,    // 도구 완료 — 평균 2.5분 절약 추정
        'tool.error':     0,      // 오류 — 절약 없음
        'assistant.turn': 5.0,    // AI 응답 — 평균 5분 절약 추정
        'user.turn':      0,
        'session.start':  0,
        'session.end':    0,
      };

      const toolStats = {};
      let totalMinutes = 0;

      for (const ev of myEvents) {
        const type = ev.type || ev.eventType || '';
        const base = ev.source || 'unknown';
        const key  = `${base}::${type}`;

        if (!toolStats[key]) toolStats[key] = { source: base, type, count: 0, savedMin: 0 };
        const savings = SAVINGS_PER_TOOL[type] || 0;
        toolStats[key].count++;
        toolStats[key].savedMin += savings;
        totalMinutes += savings;
      }

      // 절약 시간을 화폐 가치로 환산 (시간당 $50 개발자 기준)
      const hourlyRate = parseFloat(req.query.hourlyRate) || 50;
      const totalHours = totalMinutes / 60;
      const dollarValue = totalHours * hourlyRate;

      res.json({
        userId,
        totalEvents: myEvents.length,
        totalSavedMinutes: Math.round(totalMinutes),
        totalSavedHours: Math.round(totalHours * 10) / 10,
        estimatedDollarValue: Math.round(dollarValue * 100) / 100,
        hourlyRate,
        topTools: Object.values(toolStats)
          .sort((a, b) => b.savedMin - a.savedMin)
          .slice(0, 5)
          .map(t => ({ ...t, savedMin: Math.round(t.savedMin * 10) / 10 })),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 기술 성장 추적 ───────────────────────────────────────────────────────
  router.get('/me/skill-growth', optionalAuth, (req, res) => {
    try {
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const events = getEventsForUser ? getEventsForUser(resolveUserId(req)) : getAllEvents();
      const userId = req.user?.id || req.query.userId || 'local';
      const days   = parseInt(req.query.days) || 30;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();

      const myEvents = events.filter(e => {
        const uid = e.userId || e.user_id || 'local';
        return uid === userId && e.timestamp >= cutoff;
      });

      // 파일 확장자 → 언어 매핑
      const langFromExt = { js: 'JavaScript', ts: 'TypeScript', py: 'Python',
        java: 'Java', cpp: 'C++', rs: 'Rust', go: 'Go', rb: 'Ruby',
        php: 'PHP', cs: 'C#', swift: 'Swift', kt: 'Kotlin' };

      const skillMap = {};

      for (const ev of myEvents) {
        let data = {};
        try { data = typeof ev.data === 'string' ? JSON.parse(ev.data) : (ev.data || {}); } catch {}

        // 파일 수정 이벤트에서 언어 추출
        const filePath = data.file_path || data.path || data.tool_input?.path || '';
        if (filePath) {
          const ext  = filePath.split('.').pop()?.toLowerCase();
          const lang = langFromExt[ext] || ext || 'other';
          if (!skillMap[lang]) skillMap[lang] = { language: lang, events: 0, firstSeen: ev.timestamp, lastSeen: ev.timestamp };
          skillMap[lang].events++;
          if (ev.timestamp > skillMap[lang].lastSeen) skillMap[lang].lastSeen = ev.timestamp;
        }

        // 도구 사용 패턴
        const toolName = data.tool_name || data.toolName || '';
        if (toolName) {
          const key = `tool::${toolName}`;
          if (!skillMap[key]) skillMap[key] = { language: toolName, events: 0, type: 'tool', firstSeen: ev.timestamp, lastSeen: ev.timestamp };
          skillMap[key].events++;
        }
      }

      const skills = Object.values(skillMap)
        .sort((a, b) => b.events - a.events)
        .map(s => ({
          ...s,
          growthScore: Math.min(100, Math.round(Math.log2(s.events + 1) * 20)),
        }));

      res.json({
        userId,
        period: `${days}일`,
        totalMyEvents: myEvents.length,
        skills: skills.slice(0, 20),
        topLanguage: skills.find(s => !s.type)?.language || null,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 팀 집계 공유 동의 설정 ───────────────────────────────────────────────
  // consent 정보는 간단하게 메모리에 저장 (재시작 시 초기화 — 경량 구현)
  const consentMap = new Map(); // userId → { consent, updatedAt }

  router.post('/me/share-consent', optionalAuth, (req, res) => {
    try {
      const userId  = req.user?.id || req.body.userId || 'local';
      const consent = req.body.consent === true || req.body.consent === 'true';

      consentMap.set(userId, {
        userId,
        consent,
        updatedAt: new Date().toISOString(),
      });

      res.json({ ok: true, userId, consent, updatedAt: consentMap.get(userId).updatedAt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/me/share-history', optionalAuth, (req, res) => {
    try {
      const userId = req.user?.id || req.query.userId || 'local';
      const record = consentMap.get(userId) || { userId, consent: false, updatedAt: null };
      res.json(record);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 팀 익명 집계 (최소 5인 이상) ────────────────────────────────────────
  router.get('/team/aggregate', optionalAuth, (req, res) => {
    try {
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const events  = getEventsForUser ? getEventsForUser(resolveUserId(req)) : getAllEvents();
      const stats   = getStats();

      // 동의한 사용자 수 파악
      const consentedUsers = Array.from(consentMap.values()).filter(c => c.consent);

      // 최소 5인 미만 → 개인정보 보호를 위해 집계 거부
      if (consentedUsers.length < 5) {
        return res.json({
          available: false,
          reason: '팀 집계는 최소 5명 이상의 사용자 동의가 필요합니다.',
          consentedCount: consentedUsers.length,
          required: 5,
        });
      }

      // 익명 집계: 개인 식별 정보 없이 패턴만 추출
      const consentedIds = new Set(consentedUsers.map(u => u.userId));
      const allowedEvents = events.filter(e => consentedIds.has(e.userId || e.user_id || 'local'));

      // 시간대별 활동 분포
      const hourlyDist = new Array(24).fill(0);
      const typeCount  = {};
      const sourceDist = {};

      for (const ev of allowedEvents) {
        const hour = new Date(ev.timestamp).getHours();
        hourlyDist[hour]++;

        const type = ev.type || 'unknown';
        typeCount[type] = (typeCount[type] || 0) + 1;

        const src = ev.source || 'unknown';
        sourceDist[src] = (sourceDist[src] || 0) + 1;
      }

      // 피크 시간 찾기
      const peakHour = hourlyDist.indexOf(Math.max(...hourlyDist));

      res.json({
        available: true,
        consentedCount: consentedUsers.length,
        totalEvents: allowedEvents.length,
        // 익명 집계만 반환 — 개인 식별 데이터 없음
        aggregate: {
          hourlyActivity: hourlyDist,
          peakHour,
          peakHourLabel: `${peakHour}:00~${peakHour + 1}:00`,
          topEventTypes: Object.entries(typeCount)
            .sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([type, count]) => ({ type, count })),
          toolDistribution: Object.entries(sourceDist)
            .sort((a, b) => b[1] - a[1])
            .map(([source, count]) => ({ source, count })),
        },
        generatedAt: new Date().toISOString(),
        privacy: '개인 식별 정보 없음. 동의자 집계 데이터만 포함.',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 개인 주간 리포트 ─────────────────────────────────────────────────────
  router.get('/me/weekly-report', optionalAuth, (req, res) => {
    try {
      // 사용자별 이벤트 필터링 (없으면 전체 폴백)
      const events  = getEventsForUser ? getEventsForUser(resolveUserId(req)) : getAllEvents();
      const userId  = req.user?.id || req.query.userId || 'local';
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const dayAgo  = new Date(Date.now() - 1 * 86400000).toISOString();

      const weekEvents = events.filter(e => {
        const uid = e.userId || e.user_id || 'local';
        return uid === userId && e.timestamp >= weekAgo;
      });

      const todayEvents = events.filter(e => {
        const uid = e.userId || e.user_id || 'local';
        return uid === userId && e.timestamp >= dayAgo;
      });

      // 일별 이벤트 수
      const dailyCount = {};
      for (const ev of weekEvents) {
        const day = ev.timestamp?.slice(0, 10) || 'unknown';
        dailyCount[day] = (dailyCount[day] || 0) + 1;
      }

      // 가장 활발한 날
      const [busiestDay, busiestCount] = Object.entries(dailyCount)
        .sort((a, b) => b[1] - a[1])[0] || ['없음', 0];

      res.json({
        userId,
        period: '7일',
        summary: {
          totalEvents: weekEvents.length,
          todayEvents: todayEvents.length,
          activeDays: Object.keys(dailyCount).length,
          busiestDay,
          busiestCount,
          avgPerDay: Math.round(weekEvents.length / 7 * 10) / 10,
        },
        daily: Object.entries(dailyCount)
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([date, count]) => ({ date, count })),
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createPersonalInsightsRouter;
