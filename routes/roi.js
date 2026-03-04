'use strict';
/**
 * routes/roi.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ROI Calculator — AI 도구 투자 대비 효과 계산
 *
 * GET  /api/roi/dashboard              — ROI 종합 대시보드
 * GET  /api/roi/calculate              — 커스텀 파라미터로 ROI 계산
 * GET  /api/roi/breakdown              — 절감 항목별 세부 내역
 * GET  /api/roi/projection             — 향후 N개월 ROI 예측
 * GET  /api/roi/comparison             — Before/After AI 비교
 * POST /api/roi/settings               — ROI 계산 파라미터 저장
 * GET  /api/roi/settings               — 저장된 파라미터 조회
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ─── 기본 ROI 파라미터 ────────────────────────────────────────────────────────
const DEFAULT_PARAMS = {
  // 인건비 (시간당 USD)
  hourlyRateUsd:        50,

  // 도구 비용 (월 USD)
  toolCostPerMonthUsd:  20,

  // 절감 시간 추정 (이벤트 유형별 평균 분)
  minutesSavedPerEvent: {
    'assistant.turn':  3.0,   // AI 응답 1회 → 3분 절감
    'tool.use':        2.0,   // 도구 사용 → 2분 절감
    'file.read':       1.0,   // 파일 읽기 → 1분 절감
    'code.complete':   4.0,   // 코드 자동완성 → 4분 절감
    'search':          2.5,   // 검색 → 2.5분 절감
    'default':         2.0,   // 기본값
  },

  // 팀 규모
  teamSize:             1,

  // 도구 학습 곡선 (0~1, 1에 가까울수록 학습 완료)
  proficiency:          0.8,

  // 오버헤드 계수 (컨텍스트 전환, 프롬프트 작성 비용)
  overheadFactor:       0.85,
};

// ─── 저장된 파라미터 (인메모리) ───────────────────────────────────────────────
let savedParams = { ...DEFAULT_PARAMS };

// ─── ROI 계산 엔진 ────────────────────────────────────────────────────────────

function calcROI(events = [], sessions = [], params = {}) {
  const p = { ...DEFAULT_PARAMS, ...savedParams, ...params };

  // 이벤트별 절감 시간 계산
  let totalSavedMinutes = 0;
  const byType          = {};

  for (const ev of events) {
    const type = ev.type || 'default';
    const minsKey = Object.keys(p.minutesSavedPerEvent).find(k => type.includes(k)) || 'default';
    const mins = (p.minutesSavedPerEvent[minsKey] || p.minutesSavedPerEvent.default) * p.proficiency * p.overheadFactor;

    totalSavedMinutes += mins;
    byType[type] = (byType[type] || 0) + mins;
  }

  const totalSavedHours = totalSavedMinutes / 60;
  const totalSavedUsd   = totalSavedHours * p.hourlyRateUsd;

  // 기간 계산
  const timestamps = events.map(e => e.timestamp).filter(Boolean).sort();
  const firstDate   = timestamps[0] ? new Date(timestamps[0]) : new Date();
  const lastDate    = timestamps[timestamps.length - 1] ? new Date(timestamps[timestamps.length - 1]) : new Date();
  const daysActive  = Math.max(1, Math.round((lastDate - firstDate) / 86400000));
  const monthsActive = Math.max(1, daysActive / 30);

  // 비용 계산
  const totalToolCostUsd = p.toolCostPerMonthUsd * monthsActive;
  const netSavedUsd      = totalSavedUsd - totalToolCostUsd;
  const roiPct           = totalToolCostUsd > 0 ? (netSavedUsd / totalToolCostUsd) * 100 : 0;

  // 주간/월간 평균
  const avgSavedHoursPerWeek  = (totalSavedHours / daysActive) * 7;
  const avgSavedHoursPerMonth = (totalSavedHours / daysActive) * 30;

  // 절감 항목별 상위
  const breakdownTop = Object.entries(byType)
    .map(([type, mins]) => ({
      type,
      minutes: Math.round(mins * 10) / 10,
      hours:   Math.round(mins / 60 * 100) / 100,
      usd:     Math.round(mins / 60 * p.hourlyRateUsd * 100) / 100,
      pct:     Math.round(mins / totalSavedMinutes * 100),
    }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 10);

  // 팀 규모 반영
  const teamMultiplier = p.teamSize;
  const teamSavedUsd   = totalSavedUsd * teamMultiplier;
  const teamCostUsd    = p.toolCostPerMonthUsd * monthsActive * teamMultiplier;
  const teamNetUsd     = teamSavedUsd - teamCostUsd;
  const teamRoiPct     = teamCostUsd > 0 ? (teamNetUsd / teamCostUsd) * 100 : 0;

  return {
    // 개인 ROI
    individual: {
      savedMinutes:   Math.round(totalSavedMinutes),
      savedHours:     Math.round(totalSavedHours * 10) / 10,
      savedUsd:       Math.round(totalSavedUsd * 100) / 100,
      toolCostUsd:    Math.round(totalToolCostUsd * 100) / 100,
      netSavedUsd:    Math.round(netSavedUsd * 100) / 100,
      roiPct:         Math.round(roiPct),
      avgSavedHoursPerWeek:  Math.round(avgSavedHoursPerWeek * 10) / 10,
      avgSavedHoursPerMonth: Math.round(avgSavedHoursPerMonth * 10) / 10,
    },
    // 팀 ROI
    team: {
      size:        p.teamSize,
      savedUsd:    Math.round(teamSavedUsd * 100) / 100,
      costUsd:     Math.round(teamCostUsd  * 100) / 100,
      netSavedUsd: Math.round(teamNetUsd   * 100) / 100,
      roiPct:      Math.round(teamRoiPct),
    },
    // 메타데이터
    meta: {
      totalEvents:     events.length,
      totalSessions:   sessions.length,
      daysActive,
      monthsActive:    Math.round(monthsActive * 10) / 10,
      params:          { hourlyRateUsd: p.hourlyRateUsd, toolCostPerMonthUsd: p.toolCostPerMonthUsd, teamSize: p.teamSize },
    },
    breakdown: breakdownTop,
  };
}

// ─── 예측 엔진 ────────────────────────────────────────────────────────────────

function projectROI(events = [], sessions = [], months = 12, params = {}) {
  const p       = { ...DEFAULT_PARAMS, ...savedParams, ...params };
  const baseROI = calcROI(events, sessions, params);
  const { daysActive } = baseROI.meta;

  // 일일 평균 이벤트
  const dailyEvents = events.length / Math.max(1, daysActive);

  // 성장 곡선: 처음엔 빠르게 성장, 이후 안정화 (S-커브)
  const projections = [];
  for (let m = 1; m <= months; m++) {
    const growthFactor  = 1 + 0.1 * Math.log(m + 1); // 점진적 생산성 향상
    const projEvents    = dailyEvents * 30 * m * growthFactor;
    const projSavedH    = projEvents * (baseROI.individual.savedHours / Math.max(1, events.length));
    const projSavedUsd  = projSavedH * p.hourlyRateUsd;
    const projCostUsd   = p.toolCostPerMonthUsd * m;
    const projNetUsd    = projSavedUsd - projCostUsd;

    projections.push({
      month:        m,
      projEvents:   Math.round(projEvents),
      savedHours:   Math.round(projSavedH * 10) / 10,
      savedUsd:     Math.round(projSavedUsd * 100) / 100,
      costUsd:      Math.round(projCostUsd * 100) / 100,
      netSavedUsd:  Math.round(projNetUsd * 100) / 100,
      roiPct:       projCostUsd > 0 ? Math.round((projNetUsd / projCostUsd) * 100) : 0,
    });
  }

  // 손익분기점
  const breakEvenMonth = projections.find(p => p.netSavedUsd >= 0)?.month || null;

  return { projections, breakEvenMonth, baseData: baseROI.individual };
}

// ─── 라우터 팩토리 ────────────────────────────────────────────────────────────

function createRoiRouter({ getAllEvents, getSessions, optionalAuth } = {}) {
  const router = express.Router();
  const noAuth = (req, res, next) => next();
  const auth   = optionalAuth || noAuth;

  // ── ROI 대시보드 ──────────────────────────────────────────────────────
  router.get('/roi/dashboard', (req, res) => {
    const events   = getAllEvents ? getAllEvents() : [];
    const sessions = getSessions  ? getSessions()  : [];
    const roi      = calcROI(events, sessions);

    // 등급 산정
    const roiPct = roi.individual.roiPct;
    const grade = roiPct >= 500 ? { grade: 'S', label: '초월적 효율', color: '#ffd700' }
                : roiPct >= 200 ? { grade: 'A', label: '탁월한 투자', color: '#58a6ff' }
                : roiPct >= 100 ? { grade: 'B', label: '좋은 투자',   color: '#3fb950' }
                : roiPct >= 50  ? { grade: 'C', label: '수익 발생',   color: '#d29922' }
                : roiPct >= 0   ? { grade: 'D', label: '손익분기점',  color: '#f0883e' }
                :                 { grade: 'F', label: '개선 필요',   color: '#f85149' };

    res.json({ ...roi, grade });
  });

  // ── 커스텀 파라미터 ROI 계산 ──────────────────────────────────────────
  router.get('/roi/calculate', (req, res) => {
    const {
      hourlyRateUsd, toolCostPerMonthUsd, teamSize,
      proficiency, overheadFactor,
    } = req.query;

    const params = {};
    if (hourlyRateUsd)       params.hourlyRateUsd       = parseFloat(hourlyRateUsd);
    if (toolCostPerMonthUsd) params.toolCostPerMonthUsd = parseFloat(toolCostPerMonthUsd);
    if (teamSize)            params.teamSize            = parseInt(teamSize);
    if (proficiency)         params.proficiency         = parseFloat(proficiency);
    if (overheadFactor)      params.overheadFactor      = parseFloat(overheadFactor);

    const events   = getAllEvents ? getAllEvents() : [];
    const sessions = getSessions  ? getSessions()  : [];
    const roi      = calcROI(events, sessions, params);
    res.json(roi);
  });

  // ── 절감 항목별 세부 내역 ─────────────────────────────────────────────
  router.get('/roi/breakdown', (req, res) => {
    const events   = getAllEvents ? getAllEvents() : [];
    const sessions = getSessions  ? getSessions()  : [];
    const roi      = calcROI(events, sessions);
    res.json({
      breakdown:  roi.breakdown,
      individual: roi.individual,
      meta:       roi.meta,
    });
  });

  // ── ROI 예측 ──────────────────────────────────────────────────────────
  router.get('/roi/projection', (req, res) => {
    const { months = 12, hourlyRateUsd, toolCostPerMonthUsd } = req.query;
    const params = {};
    if (hourlyRateUsd)       params.hourlyRateUsd       = parseFloat(hourlyRateUsd);
    if (toolCostPerMonthUsd) params.toolCostPerMonthUsd = parseFloat(toolCostPerMonthUsd);

    const events   = getAllEvents ? getAllEvents() : [];
    const sessions = getSessions  ? getSessions()  : [];
    res.json(projectROI(events, sessions, Math.min(parseInt(months) || 12, 36), params));
  });

  // ── Before/After 비교 ─────────────────────────────────────────────────
  router.get('/roi/comparison', (req, res) => {
    const events   = getAllEvents ? getAllEvents() : [];
    const sessions = getSessions  ? getSessions()  : [];

    // 기간을 반으로 나눠 비교
    const sorted   = [...events].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    const mid      = Math.floor(sorted.length / 2);
    const firstHalf  = sorted.slice(0, mid);
    const secondHalf = sorted.slice(mid);

    const before = calcROI(firstHalf,  [], {});
    const after  = calcROI(secondHalf, [], {});

    const improvement = {
      eventsGrowth:    secondHalf.length - firstHalf.length,
      savedHoursGrowth: after.individual.savedHours - before.individual.savedHours,
      roiGrowth:       after.individual.roiPct - before.individual.roiPct,
    };

    res.json({
      before: before.individual,
      after:  after.individual,
      improvement,
      message: improvement.savedHoursGrowth > 0
        ? `📈 후반 기간에 ${improvement.savedHoursGrowth.toFixed(1)}시간 더 절감했습니다.`
        : '📊 더 많은 데이터가 쌓이면 Before/After 비교가 정확해집니다.',
    });
  });

  // ── 파라미터 저장 ─────────────────────────────────────────────────────
  router.post('/roi/settings', auth, (req, res) => {
    const { hourlyRateUsd, toolCostPerMonthUsd, teamSize, proficiency, overheadFactor } = req.body;
    if (hourlyRateUsd       !== undefined) savedParams.hourlyRateUsd       = parseFloat(hourlyRateUsd);
    if (toolCostPerMonthUsd !== undefined) savedParams.toolCostPerMonthUsd = parseFloat(toolCostPerMonthUsd);
    if (teamSize            !== undefined) savedParams.teamSize            = parseInt(teamSize);
    if (proficiency         !== undefined) savedParams.proficiency         = parseFloat(proficiency);
    if (overheadFactor      !== undefined) savedParams.overheadFactor      = parseFloat(overheadFactor);

    res.json({ success: true, settings: savedParams });
  });

  // ── 파라미터 조회 ─────────────────────────────────────────────────────
  router.get('/roi/settings', (req, res) => {
    res.json({ settings: savedParams, defaults: DEFAULT_PARAMS });
  });

  return router;
}

module.exports = createRoiRouter;
