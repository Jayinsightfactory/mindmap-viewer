/**
 * routes/intelligence.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 3: 팔란티어 플랜 — 데이터 인텔리전스 API
 *
 * 작업 데이터 → 의사결정 인사이트
 * 부서별/역할별 업무 흐름 시각화
 * 실시간 대시보드 + 이상 탐지
 * 관리자/팀장 레벨 데이터 집계
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const express = require('express');
const {
  detectPatterns,
  analyzeTimeDistribution,
  detectBottlenecks,
  calculateEfficiencyScore,
  buildCapabilityProfile,
} = require('../src/work-analyzer');
const { annotateEventsWithPurpose, summarizePurposes } = require('../src/purpose-classifier');

/**
 * @param {{ verifyToken, getEventsForUser, resolveUserId, getDb, getUserById, ADMIN_EMAILS }} deps
 */
function createIntelligenceRouter(deps) {
  const { verifyToken, getEventsForUser, resolveUserId, getDb, getUserById, ADMIN_EMAILS = '' } = deps;
  const router = express.Router();

  // ── 인증 미들웨어 (Bearer + Cookie + query token 지원) ──
  function auth(req, res, next) {
    const token = req.headers.authorization || req.query.token || req.cookies?.orbit_token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  }

  // ── 관리자 확인 ──
  function isAdmin(user) {
    if (!user?.email) return false;
    const admins = (ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    return admins.includes(user.email.toLowerCase());
  }

  // ── 워크스페이스 멤버 로드 ──
  async function getWorkspaceMembers(workspaceId) {
    const db = getDb();
    if (!db) return [];
    try {
      if (typeof db.query === 'function') {
        // PostgreSQL
        const { rows } = await db.query(
          `SELECT wm.user_id, wm.role, wm.team_name, wm.joined_at
           FROM workspace_members wm WHERE wm.workspace_id = $1`,
          [workspaceId]
        );
        return rows;
      } else {
        // SQLite
        return db.prepare(
          `SELECT user_id, role, team_name, joined_at
           FROM workspace_members WHERE workspace_id = ?`
        ).all(workspaceId);
      }
    } catch { return []; }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/intelligence/team-overview
  // 팀 레벨 분석 — 워크스페이스의 모든 멤버 집계
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/intelligence/team-overview', auth, async (req, res) => {
    try {
      const workspaceId = req.query.workspaceId;
      if (!workspaceId) return res.status(400).json({ error: 'workspaceId required' });

      const members = await getWorkspaceMembers(workspaceId);
      if (!members.length) return res.json({ ok: true, members: [], summary: null });

      const memberAnalytics = [];
      let totalEvents = 0;
      let totalActiveMin = 0;
      const allPurposes = {};

      for (const m of members) {
        try {
          const events = await getEventsForUser(m.user_id);
          const annotated = annotateEventsWithPurpose(events || []);
          const eff = calculateEfficiencyScore(annotated);
          const time = analyzeTimeDistribution(annotated);
          const cap = buildCapabilityProfile(annotated);

          totalEvents += annotated.length;
          totalActiveMin += time.totalActiveMinutes;

          // 목적 집계
          for (const p of (time.byPurpose || [])) {
            allPurposes[p.purposeId] = (allPurposes[p.purposeId] || 0) + p.minutes;
          }

          memberAnalytics.push({
            userId: m.user_id,
            role: m.role,
            teamName: m.team_name,
            eventCount: annotated.length,
            efficiencyScore: eff.score,
            grade: eff.grade,
            activeMinutes: time.totalActiveMinutes,
            topSkills: cap.skills.slice(0, 5).map(s => s.name),
            workStyle: cap.workStyle.type,
            peakHour: time.peakHour,
          });
        } catch { /* skip member on error */ }
      }

      const teamPurposes = Object.entries(allPurposes)
        .map(([id, min]) => ({ purposeId: id, totalMinutes: min }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes);

      const summary = {
        memberCount: members.length,
        totalEvents,
        totalActiveMinutes: totalActiveMin,
        avgEfficiency: Math.round(memberAnalytics.reduce((s, m) => s + m.efficiencyScore, 0) / Math.max(memberAnalytics.length, 1)),
        topPurposes: teamPurposes.slice(0, 5),
      };

      res.json({ ok: true, members: memberAnalytics, summary });
    } catch (e) {
      console.error('[Intelligence] team-overview error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/intelligence/anomalies
  // 이상 탐지 — 비정상 패턴 감지
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/intelligence/anomalies', auth, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const events = await getEventsForUser(userId);
      const annotated = annotateEventsWithPurpose(events || []);

      const anomalies = detectAnomalies(annotated);
      res.json({ ok: true, anomalies });
    } catch (e) {
      console.error('[Intelligence] anomalies error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/intelligence/decisions
  // 의사결정 지원 인사이트
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/intelligence/decisions', auth, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const events = await getEventsForUser(userId);
      const annotated = annotateEventsWithPurpose(events || []);

      const decisions = generateDecisionInsights(annotated);
      res.json({ ok: true, ...decisions });
    } catch (e) {
      console.error('[Intelligence] decisions error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/intelligence/workflow
  // 업무 흐름 시각화 데이터
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/intelligence/workflow', auth, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const events = await getEventsForUser(userId);
      const annotated = annotateEventsWithPurpose(events || []);

      const workflow = buildWorkflowGraph(annotated);
      res.json({ ok: true, ...workflow });
    } catch (e) {
      console.error('[Intelligence] workflow error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/intelligence/realtime
  // 실시간 활동 스냅샷 (대시보드 위젯용)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/intelligence/realtime', auth, async (req, res) => {
    try {
      const workspaceId = req.query.workspaceId;
      const members = workspaceId ? await getWorkspaceMembers(workspaceId) : [{ user_id: resolveUserId(req) }];

      const now = Date.now();
      const RECENT_WINDOW = 15 * 60 * 1000; // 15분

      const activeMembers = [];
      let recentEvents = 0;
      const recentPurposes = {};

      for (const m of members) {
        try {
          const events = await getEventsForUser(m.user_id);
          const recent = (events || []).filter(e => (now - new Date(e.timestamp).getTime()) < RECENT_WINDOW);
          if (recent.length > 0) {
            const annotated = annotateEventsWithPurpose(recent);
            const lastEvent = annotated[annotated.length - 1];
            activeMembers.push({
              userId: m.user_id,
              lastActivity: lastEvent?.timestamp,
              currentPurpose: lastEvent?.purposeLabel || '작업 중',
              recentEventCount: recent.length,
            });
            recentEvents += recent.length;
            for (const e of annotated) {
              const p = e.purposeId || 'unknown';
              recentPurposes[p] = (recentPurposes[p] || 0) + 1;
            }
          }
        } catch { /* skip */ }
      }

      res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        activeMembers,
        activeMemberCount: activeMembers.length,
        totalMemberCount: members.length,
        recentEvents,
        recentPurposes,
      });
    } catch (e) {
      console.error('[Intelligence] realtime error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/intelligence/heatmap
  // 작업 히트맵 (시간대 × 요일)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  router.get('/intelligence/heatmap', auth, async (req, res) => {
    try {
      const userId = resolveUserId(req);
      const events = await getEventsForUser(userId);

      // 24시간 × 7요일 격자
      const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
      const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];

      for (const e of (events || [])) {
        const d = new Date(e.timestamp);
        if (!isNaN(d)) grid[d.getDay()][d.getHours()]++;
      }

      const maxVal = Math.max(...grid.flat(), 1);
      const heatmap = grid.map((row, dow) => ({
        day: WEEKDAY[dow],
        dayIndex: dow,
        hours: row.map((count, h) => ({
          hour: h,
          count,
          intensity: Math.round((count / maxVal) * 100),
        })),
      }));

      res.json({ ok: true, heatmap, maxValue: maxVal });
    } catch (e) {
      console.error('[Intelligence] heatmap error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}


// ─── 이상 탐지 로직 ────────────────────────────────────
function detectAnomalies(events) {
  if (!events?.length) return [];
  const anomalies = [];

  // 1. 비정상 활동 시간 (새벽 2-5시 작업)
  const lateNight = events.filter(e => {
    const h = new Date(e.timestamp).getHours();
    return h >= 2 && h <= 5;
  });
  if (lateNight.length > 5) {
    anomalies.push({
      type: 'unusual_hours',
      severity: 'warning',
      description: `새벽 시간대(02-05시) 작업 ${lateNight.length}건 감지`,
      suggestion: '수면 패턴이 불규칙할 수 있습니다. 작업 시간 조정을 고려하세요.',
      count: lateNight.length,
    });
  }

  // 2. 에러 급증
  const now = Date.now();
  const DAY = 86400000;
  const recentErrors = events.filter(e => e.type === 'tool.error' && (now - new Date(e.timestamp)) < DAY);
  const prevErrors   = events.filter(e => e.type === 'tool.error' && (now - new Date(e.timestamp)) >= DAY && (now - new Date(e.timestamp)) < DAY * 2);
  if (recentErrors.length > prevErrors.length * 2 && recentErrors.length > 3) {
    anomalies.push({
      type: 'error_spike',
      severity: 'alert',
      description: `에러가 전일 대비 ${Math.round(recentErrors.length / Math.max(prevErrors.length, 1) * 100)}% 증가`,
      suggestion: '코드 품질 검토 또는 환경 설정 확인 필요',
      count: recentErrors.length,
    });
  }

  // 3. 갑작스러운 활동 중단
  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (sorted.length > 10) {
    const lastEvent = sorted[sorted.length - 1];
    const gap = now - new Date(lastEvent.timestamp);
    const avgGap = estimateAverageSessionGap(sorted);
    if (gap > avgGap * 3 && gap > 2 * DAY) {
      anomalies.push({
        type: 'activity_drop',
        severity: 'info',
        description: `최근 ${Math.round(gap / DAY)}일간 활동 없음 (평소 간격: ${Math.round(avgGap / DAY)}일)`,
        suggestion: '작업 재개를 위한 컨텍스트 복구가 필요할 수 있습니다.',
        count: 0,
      });
    }
  }

  // 4. 단일 파일 과다 수정
  const fileEdits = {};
  for (const e of events) {
    const fp = e.data?.filePath || e.data?.file || '';
    if (fp && (e.type === 'tool.end' && (e.data?.toolName === 'Edit' || e.data?.toolName === 'Write'))) {
      fileEdits[fp] = (fileEdits[fp] || 0) + 1;
    }
  }
  const hotFiles = Object.entries(fileEdits).filter(([_, c]) => c > 20);
  if (hotFiles.length > 0) {
    anomalies.push({
      type: 'file_churn',
      severity: 'info',
      description: `${hotFiles.length}개 파일에 과다 수정 (20회 이상)`,
      suggestion: '리팩토링이 필요하거나, 설계 검토를 고려하세요.',
      count: hotFiles.length,
      details: hotFiles.slice(0, 5).map(([f, c]) => ({ file: f.split('/').pop(), edits: c })),
    });
  }

  return anomalies;
}

function estimateAverageSessionGap(sortedEvents) {
  const sessions = new Set(sortedEvents.map(e => e.sessionId || e.session_id));
  if (sessions.size < 2) return 86400000;
  const sessionStarts = {};
  for (const e of sortedEvents) {
    const sid = e.sessionId || e.session_id;
    if (!sessionStarts[sid]) sessionStarts[sid] = new Date(e.timestamp).getTime();
  }
  const starts = Object.values(sessionStarts).sort((a, b) => a - b);
  let totalGap = 0;
  for (let i = 1; i < starts.length; i++) totalGap += starts[i] - starts[i - 1];
  return totalGap / (starts.length - 1);
}


// ─── 의사결정 인사이트 ──────────────────────────────────
function generateDecisionInsights(events) {
  if (!events?.length) return { actions: [], predictions: [], risks: [] };

  const time  = analyzeTimeDistribution(events);
  const bottle = detectBottlenecks(events);
  const cap   = buildCapabilityProfile(events);

  const actions = [];
  const predictions = [];
  const risks = [];

  // 액션 아이템 생성
  if (time.byPurpose.find(p => p.purposeId === 'fix' && p.percent > 30)) {
    actions.push({
      priority: 'high',
      category: 'quality',
      title: '버그 수정 비중 과다',
      description: `전체 작업의 ${time.byPurpose.find(p => p.purposeId === 'fix').percent}%가 버그 수정에 투입`,
      action: '코드 리뷰 프로세스 강화 및 자동 테스트 커버리지 확대 추천',
    });
  }

  if (bottle.switchingCost.switches > 20) {
    actions.push({
      priority: 'medium',
      category: 'productivity',
      title: '잦은 컨텍스트 스위칭',
      description: `${bottle.switchingCost.switches}회 작업 전환으로 약 ${bottle.switchingCost.totalMinutes}분 낭비`,
      action: '타임 블로킹 기법으로 하나의 작업에 집중 시간 확보',
    });
  }

  // 예측
  const recentPurpose = time.byPurpose[0];
  if (recentPurpose) {
    predictions.push({
      type: 'trend',
      title: `현재 주력 작업: ${recentPurpose.label}`,
      description: `전체 시간의 ${recentPurpose.percent}%를 ${recentPurpose.label}에 투자 중`,
      confidence: 0.8,
    });
  }

  // 역량 기반 예측
  if (cap.skills.length > 0) {
    const topSkill = cap.skills[0];
    predictions.push({
      type: 'capability',
      title: `핵심 역량: ${topSkill.name}`,
      description: `${topSkill.name} 활용도가 가장 높으며, ${topSkill.level} 수준`,
      confidence: 0.7,
    });
  }

  // 리스크
  const errorRate = events.filter(e => e.type === 'tool.error').length / events.length;
  if (errorRate > 0.15) {
    risks.push({
      level: 'high',
      title: '에러 발생률 주의',
      description: `전체 이벤트의 ${Math.round(errorRate * 100)}%가 에러 — 코드 품질 리스크`,
      mitigation: '린팅, 타입 검사, 자동 테스트 도입',
    });
  }

  if (time.totalActiveMinutes > 600 && time.peakHour >= 22) {
    risks.push({
      level: 'medium',
      title: '야간 작업 패턴',
      description: '주요 작업이 밤 시간대에 집중됨 — 번아웃 리스크',
      mitigation: '정규 근무 시간 내 작업 배분 권장',
    });
  }

  return { actions, predictions, risks, generatedAt: new Date().toISOString() };
}


// ─── 업무 흐름 그래프 ──────────────────────────────────
function buildWorkflowGraph(events) {
  if (!events?.length) return { nodes: [], edges: [], stages: [] };

  // 목적(purpose) 전환 그래프
  const nodeMap = {};
  const edgeMap = {};

  let prev = null;
  for (const e of events) {
    const p = e.purposeId || 'unknown';
    if (!nodeMap[p]) nodeMap[p] = { id: p, label: e.purposeLabel || p, count: 0, color: e.purposeColor || '#6b7280' };
    nodeMap[p].count++;

    if (prev && prev !== p) {
      const key = `${prev}→${p}`;
      if (!edgeMap[key]) edgeMap[key] = { from: prev, to: p, weight: 0 };
      edgeMap[key].weight++;
    }
    prev = p;
  }

  const nodes = Object.values(nodeMap).sort((a, b) => b.count - a.count);
  const edges = Object.values(edgeMap).sort((a, b) => b.weight - a.weight);

  // 스테이지 (시간순 목적 변화)
  const stages = [];
  let currentPurpose = null;
  let stageStart = null;
  for (const e of events) {
    const p = e.purposeId || 'unknown';
    if (p !== currentPurpose) {
      if (currentPurpose) {
        stages.push({
          purpose: currentPurpose,
          label: events.find(ev => ev.purposeId === currentPurpose)?.purposeLabel || currentPurpose,
          start: stageStart,
          end: e.timestamp,
        });
      }
      currentPurpose = p;
      stageStart = e.timestamp;
    }
  }
  if (currentPurpose) {
    stages.push({
      purpose: currentPurpose,
      label: events.find(ev => ev.purposeId === currentPurpose)?.purposeLabel || currentPurpose,
      start: stageStart,
      end: events[events.length - 1]?.timestamp,
    });
  }

  return { nodes, edges: edges.slice(0, 30), stages: stages.slice(-50) };
}


module.exports = createIntelligenceRouter;
