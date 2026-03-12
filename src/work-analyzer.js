/**
 * work-analyzer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2: 작업 분석 엔진
 *
 * 수집된 이벤트 데이터를 분석하여:
 * 1. 패턴 감지 (반복되는 작업 흐름)
 * 2. 시간 분배 분석 (목적별/도구별/시간대별)
 * 3. 반복 작업 식별 (자동화 가능 영역)
 * 4. 병목 분석 (비효율 구간)
 * 5. 개인 효율 점수 산출
 *
 * 제품 철학: 원본 데이터가 아닌 '분석 결과'를 사용자에게 제시
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { PURPOSE_CATEGORIES, classifyPurposes, summarizePurposes } = require('./purpose-classifier');

// ─── 상수 ────────────────────────────────────────────
const HOUR_MS = 3600000;
const DAY_MS  = 86400000;
const WEEK_MS = DAY_MS * 7;

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

// ─── 1. 패턴 감지 ──────────────────────────────────────
/**
 * 사용자 이벤트에서 반복 패턴을 감지
 * @param {Array} events - 정규화된 이벤트 배열
 * @returns {{ weeklyPatterns, dailyRhythm, toolSequences, workCycles }}
 */
function detectPatterns(events) {
  if (!events?.length) return { weeklyPatterns: [], dailyRhythm: [], toolSequences: [], workCycles: [] };

  // ── 요일별 작업 빈도 ──
  const weeklyMap = {};
  WEEKDAY_KO.forEach((d, i) => { weeklyMap[i] = { day: d, dayIndex: i, count: 0, purposes: {} }; });

  for (const e of events) {
    const d = new Date(e.timestamp);
    if (isNaN(d)) continue;
    const dow = d.getDay();
    weeklyMap[dow].count++;
    const purpose = e.purposeId || 'unknown';
    weeklyMap[dow].purposes[purpose] = (weeklyMap[dow].purposes[purpose] || 0) + 1;
  }

  const weeklyPatterns = Object.values(weeklyMap).map(w => ({
    ...w,
    topPurpose: Object.entries(w.purposes).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown',
    intensity: 0,
  }));
  const maxCount = Math.max(...weeklyPatterns.map(w => w.count), 1);
  weeklyPatterns.forEach(w => { w.intensity = Math.round((w.count / maxCount) * 100); });

  // ── 시간대별 활동 리듬 ──
  const hourMap = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0, label: `${i}시` }));
  for (const e of events) {
    const d = new Date(e.timestamp);
    if (!isNaN(d)) hourMap[d.getHours()].count++;
  }
  const maxHour = Math.max(...hourMap.map(h => h.count), 1);
  const dailyRhythm = hourMap.map(h => ({ ...h, intensity: Math.round((h.count / maxHour) * 100) }));

  // ── 도구 사용 시퀀스 패턴 ──
  const toolSeqMap = {};
  const toolEvents = events.filter(e => e.type === 'tool.end' || e.type === 'tool.start');
  for (let i = 0; i < toolEvents.length - 1; i++) {
    const from = toolEvents[i].data?.toolName || 'unknown';
    const to   = toolEvents[i + 1].data?.toolName || 'unknown';
    const key = `${from} → ${to}`;
    toolSeqMap[key] = (toolSeqMap[key] || 0) + 1;
  }
  const toolSequences = Object.entries(toolSeqMap)
    .map(([seq, count]) => ({ sequence: seq, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // ── 작업 사이클 (세션 기반) ──
  const sessionMap = {};
  for (const e of events) {
    const sid = e.sessionId || e.session_id || 'unknown';
    if (!sessionMap[sid]) sessionMap[sid] = { id: sid, events: [], start: null, end: null };
    sessionMap[sid].events.push(e);
    const ts = new Date(e.timestamp).getTime();
    if (!sessionMap[sid].start || ts < sessionMap[sid].start) sessionMap[sid].start = ts;
    if (!sessionMap[sid].end || ts > sessionMap[sid].end)     sessionMap[sid].end = ts;
  }
  const workCycles = Object.values(sessionMap)
    .filter(s => s.events.length >= 3)
    .map(s => ({
      sessionId: s.id,
      duration:  s.end - s.start,
      durationMin: Math.round((s.end - s.start) / 60000),
      eventCount: s.events.length,
      startTime: new Date(s.start).toISOString(),
    }))
    .sort((a, b) => b.start - a.start)
    .slice(0, 20);

  return { weeklyPatterns, dailyRhythm, toolSequences, workCycles };
}


// ─── 2. 시간 분배 분석 ─────────────────────────────────
/**
 * 시간이 어디에 쓰이는지 분석
 * @param {Array} events
 * @returns {{ byPurpose, byTool, byHour, byDayOfWeek, totalActiveMinutes, peakHour, mostProductiveDay }}
 */
function analyzeTimeDistribution(events) {
  if (!events?.length) return { byPurpose: [], byTool: [], byHour: [], byDayOfWeek: [], totalActiveMinutes: 0, peakHour: 0, mostProductiveDay: '월' };

  // 목적별 시간 추정 (연속 이벤트 간 간격 = 작업 시간)
  const purposeTime = {};
  const toolTime    = {};
  const hourTime    = Array(24).fill(0);
  const dowTime     = Array(7).fill(0);

  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let totalActiveMs = 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];
    const gap  = new Date(next.timestamp) - new Date(curr.timestamp);

    // 30분 이상 간격은 유휴 시간으로 간주
    const activeMs = Math.min(gap, 30 * 60000);
    totalActiveMs += activeMs;

    const purpose = curr.purposeId || 'unknown';
    purposeTime[purpose] = (purposeTime[purpose] || 0) + activeMs;

    const tool = curr.data?.toolName || curr.type || 'other';
    toolTime[tool] = (toolTime[tool] || 0) + activeMs;

    const d = new Date(curr.timestamp);
    if (!isNaN(d)) {
      hourTime[d.getHours()] += activeMs;
      dowTime[d.getDay()]    += activeMs;
    }
  }

  const toMin = ms => Math.round(ms / 60000);
  const totalActiveMinutes = toMin(totalActiveMs);

  const byPurpose = Object.entries(purposeTime)
    .map(([id, ms]) => {
      const cat = PURPOSE_CATEGORIES[id.toUpperCase()] || PURPOSE_CATEGORIES.UNKNOWN;
      return { purposeId: id, label: cat.label, icon: cat.icon, color: cat.color, minutes: toMin(ms), percent: Math.round(ms / totalActiveMs * 100) };
    })
    .sort((a, b) => b.minutes - a.minutes);

  const byTool = Object.entries(toolTime)
    .map(([tool, ms]) => ({ tool, minutes: toMin(ms), percent: Math.round(ms / totalActiveMs * 100) }))
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 15);

  const byHour = hourTime.map((ms, h) => ({ hour: h, label: `${h}시`, minutes: toMin(ms) }));
  const byDayOfWeek = dowTime.map((ms, d) => ({ dayIndex: d, day: WEEKDAY_KO[d], minutes: toMin(ms) }));

  const peakHour = hourTime.indexOf(Math.max(...hourTime));
  const peakDowIdx = dowTime.indexOf(Math.max(...dowTime));
  const mostProductiveDay = WEEKDAY_KO[peakDowIdx];

  return { byPurpose, byTool, byHour, byDayOfWeek, totalActiveMinutes, peakHour, mostProductiveDay };
}


// ─── 3. 반복 작업 식별 ──────────────────────────────────
/**
 * 자동화 가능한 반복 작업 찾기
 * @param {Array} events
 * @returns {{ repetitiveTasks, automationCandidates, estimatedSavings }}
 */
function findRepetitiveWork(events) {
  if (!events?.length) return { repetitiveTasks: [], automationCandidates: [], estimatedSavingsMinPerWeek: 0 };

  // Bash 명령어 반복 패턴
  const cmdMap = {};
  const bashEvents = events.filter(e => (e.type === 'tool.end' || e.type === 'tool.start') && e.data?.toolName === 'Bash');
  for (const e of bashEvents) {
    const cmd = normalizeCmd(e.data?.input?.command || e.data?.inputPreview || '');
    if (!cmd || cmd.length < 5) continue;
    if (!cmdMap[cmd]) cmdMap[cmd] = { command: cmd, count: 0, timestamps: [] };
    cmdMap[cmd].count++;
    cmdMap[cmd].timestamps.push(e.timestamp);
  }

  const repetitiveTasks = Object.values(cmdMap)
    .filter(c => c.count >= 3)
    .map(c => ({
      type: 'command',
      description: describeCmd(c.command),
      rawPattern: c.command,
      frequency: c.count,
      avgIntervalHours: calcAvgInterval(c.timestamps),
      automatable: isAutomatable(c.command),
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 20);

  // 파일 접근 패턴 반복
  const fileAccessMap = {};
  const fileEvents = events.filter(e => e.data?.filePath || e.data?.file || e.data?.path);
  for (const e of fileEvents) {
    const fp = e.data?.filePath || e.data?.file || e.data?.path || '';
    const norm = normalizePath(fp);
    if (!norm) continue;
    if (!fileAccessMap[norm]) fileAccessMap[norm] = { path: norm, count: 0, tools: new Set() };
    fileAccessMap[norm].count++;
    if (e.data?.toolName) fileAccessMap[norm].tools.add(e.data.toolName);
  }

  const repetitiveFiles = Object.values(fileAccessMap)
    .filter(f => f.count >= 5)
    .map(f => ({
      type: 'file_access',
      description: `"${shortenPath(f.path)}" 파일 반복 접근`,
      rawPattern: f.path,
      frequency: f.count,
      tools: [...f.tools],
      automatable: false,
    }))
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 10);

  // 자동화 후보 생성
  const automationCandidates = repetitiveTasks
    .filter(t => t.automatable)
    .map(t => ({
      task: t.description,
      currentFrequency: t.frequency,
      estimatedTimeSavedMin: Math.round(t.frequency * 2),  // 평균 2분/실행 절약
      difficulty: t.rawPattern.includes('git') ? 'easy' : 'medium',
      suggestion: generateAutomationSuggestion(t.rawPattern),
    }));

  const estimatedSavingsMinPerWeek = automationCandidates.reduce((s, c) => s + Math.round(c.estimatedTimeSavedMin / 4), 0);

  return {
    repetitiveTasks: [...repetitiveTasks, ...repetitiveFiles],
    automationCandidates,
    estimatedSavingsMinPerWeek,
  };
}


// ─── 4. 병목 분석 ──────────────────────────────────────
/**
 * 워크플로우 병목 지점 식별
 * @param {Array} events
 * @returns {{ bottlenecks, idleGaps, errorHotspots, switchingCost }}
 */
function detectBottlenecks(events) {
  if (!events?.length) return { bottlenecks: [], idleGaps: [], errorHotspots: [], switchingCost: { totalMinutes: 0, switches: 0 } };

  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // ── 유휴 시간 갭 ──
  const idleGaps = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = new Date(sorted[i + 1].timestamp) - new Date(sorted[i].timestamp);
    // 5분~4시간 유휴는 병목 후보
    if (gap > 5 * 60000 && gap < 4 * HOUR_MS) {
      idleGaps.push({
        afterEvent: sorted[i].id,
        beforeEvent: sorted[i + 1].id,
        gapMinutes: Math.round(gap / 60000),
        timestamp: sorted[i].timestamp,
        context: sorted[i].data?.toolName || sorted[i].type,
      });
    }
  }
  idleGaps.sort((a, b) => b.gapMinutes - a.gapMinutes);

  // ── 에러 핫스팟 ──
  const errorEvents = events.filter(e => e.type === 'tool.error' || (e.data?.is_error));
  const errorByTool = {};
  for (const e of errorEvents) {
    const tool = e.data?.toolName || 'unknown';
    if (!errorByTool[tool]) errorByTool[tool] = { tool, count: 0, samples: [] };
    errorByTool[tool].count++;
    if (errorByTool[tool].samples.length < 3) {
      errorByTool[tool].samples.push(e.data?.error || e.data?.output?.substring(0, 100) || '');
    }
  }
  const errorHotspots = Object.values(errorByTool).sort((a, b) => b.count - a.count);

  // ── 컨텍스트 스위칭 비용 ──
  let switches = 0;
  let switchTimeMs = 0;
  let lastPurpose = null;
  for (let i = 0; i < sorted.length; i++) {
    const purpose = sorted[i].purposeId || 'unknown';
    if (lastPurpose && purpose !== lastPurpose && purpose !== 'unknown' && lastPurpose !== 'unknown') {
      switches++;
      if (i < sorted.length - 1) {
        const gap = new Date(sorted[i + 1].timestamp) - new Date(sorted[i].timestamp);
        if (gap > 0 && gap < 30 * 60000) switchTimeMs += Math.min(gap, 5 * 60000);
      }
    }
    lastPurpose = purpose;
  }

  // ── 종합 병목 리스트 ──
  const bottlenecks = [];

  // 긴 유휴 = 대기/블로커
  const avgIdle = idleGaps.length > 0 ? idleGaps.reduce((s, g) => s + g.gapMinutes, 0) / idleGaps.length : 0;
  if (avgIdle > 15) {
    bottlenecks.push({
      type: 'idle_time',
      severity: avgIdle > 30 ? 'high' : 'medium',
      description: `평균 ${Math.round(avgIdle)}분 유휴 시간 (${idleGaps.length}회)`,
      impact: `주당 약 ${Math.round(avgIdle * idleGaps.length / 7)}분 낭비 추정`,
      suggestion: '작업 간 대기를 줄이기 위해 할 일 목록 사전 정리 추천',
    });
  }

  // 에러 다발 = 디버깅 병목
  const totalErrors = errorEvents.length;
  if (totalErrors > events.length * 0.1) {
    bottlenecks.push({
      type: 'error_frequency',
      severity: totalErrors > events.length * 0.2 ? 'high' : 'medium',
      description: `전체 이벤트의 ${Math.round(totalErrors / events.length * 100)}%가 에러`,
      impact: `${totalErrors}건의 에러로 디버깅 시간 소모`,
      suggestion: '테스트 자동화 및 린팅 도구 도입 추천',
    });
  }

  // 잦은 컨텍스트 스위칭
  if (switches > events.length * 0.05) {
    bottlenecks.push({
      type: 'context_switching',
      severity: switches > events.length * 0.1 ? 'high' : 'medium',
      description: `${switches}회 목적 전환 감지`,
      impact: `전환 비용 약 ${Math.round(switchTimeMs / 60000)}분`,
      suggestion: '한 가지 작업에 집중 후 전환하는 배치 작업 방식 추천',
    });
  }

  return {
    bottlenecks,
    idleGaps: idleGaps.slice(0, 10),
    errorHotspots,
    switchingCost: { totalMinutes: Math.round(switchTimeMs / 60000), switches },
  };
}


// ─── 5. 효율 점수 ──────────────────────────────────────
/**
 * 개인 효율 점수 산출 (0-100)
 * @param {Array} events
 * @returns {{ score, grade, breakdown, comparison, insights }}
 */
function calculateEfficiencyScore(events) {
  if (!events?.length) return { score: 0, grade: 'N/A', breakdown: {}, comparison: '', insights: [] };

  const time   = analyzeTimeDistribution(events);
  const bottle = detectBottlenecks(events);
  const repeat = findRepetitiveWork(events);

  // ── 하위 점수 계산 ──

  // 집중도 (컨텍스트 스위칭 적을수록 높음)
  const switchRatio = bottle.switchingCost.switches / Math.max(events.length, 1);
  const focusScore = Math.round(Math.max(0, 100 - switchRatio * 1000));

  // 도구 활용도 (다양한 도구 사용 = 높음)
  const uniqueTools = new Set(events.filter(e => e.data?.toolName).map(e => e.data.toolName)).size;
  const toolScore = Math.min(100, uniqueTools * 15);

  // 에러 회복력 (에러 후 빠른 해결 = 높음)
  const errorRate = events.filter(e => e.type === 'tool.error').length / Math.max(events.length, 1);
  const resilienceScore = Math.round(Math.max(0, 100 - errorRate * 500));

  // 일관성 (매일 꾸준한 작업 = 높음)
  const activeDays = new Set(events.map(e => new Date(e.timestamp).toISOString().slice(0, 10))).size;
  const dateRange  = (new Date(events[events.length - 1]?.timestamp) - new Date(events[0]?.timestamp)) / DAY_MS || 1;
  const consistencyScore = Math.round(Math.min(100, (activeDays / Math.max(dateRange, 1)) * 100));

  // 자동화 (반복 작업 적을수록 높음)
  const repRatio = repeat.repetitiveTasks.length / Math.max(events.length / 100, 1);
  const automationScore = Math.round(Math.max(0, 100 - repRatio * 50));

  // 종합 점수
  const score = Math.round(
    focusScore * 0.25 +
    toolScore * 0.15 +
    resilienceScore * 0.20 +
    consistencyScore * 0.25 +
    automationScore * 0.15
  );

  const grade = score >= 90 ? 'S' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 50 ? 'D' : 'F';

  const insights = [];
  if (focusScore < 60) insights.push({ type: 'warning', message: '작업 간 전환이 잦습니다. 하나의 목적에 집중하세요.' });
  if (resilienceScore < 60) insights.push({ type: 'warning', message: '에러 발생률이 높습니다. 테스트 루틴을 강화하세요.' });
  if (consistencyScore > 80) insights.push({ type: 'positive', message: '꾸준한 작업 습관이 돋보입니다!' });
  if (automationScore < 50) insights.push({ type: 'suggestion', message: `주당 약 ${repeat.estimatedSavingsMinPerWeek}분 절약 가능한 자동화 후보가 있습니다.` });
  if (focusScore > 80 && resilienceScore > 80) insights.push({ type: 'positive', message: '높은 집중도와 안정성을 유지하고 있습니다. 우수!' });

  return {
    score,
    grade,
    breakdown: {
      focus:       { score: focusScore,       weight: 0.25, label: '집중도' },
      toolUsage:   { score: toolScore,        weight: 0.15, label: '도구 활용' },
      resilience:  { score: resilienceScore,  weight: 0.20, label: '에러 회복' },
      consistency: { score: consistencyScore, weight: 0.25, label: '꾸준함' },
      automation:  { score: automationScore,  weight: 0.15, label: '자동화' },
    },
    comparison: `상위 ${score > 80 ? '10' : score > 60 ? '30' : '50'}% 수준`,
    insights,
  };
}


// ─── 6. 종합 인사이트 대시보드 ────────────────────────────
/**
 * 모든 분석 결과를 종합하여 대시보드 데이터 생성
 * @param {Array} events
 * @param {Object} options - { period: '7d'|'30d'|'all' }
 * @returns {Object} 전체 분석 결과
 */
function generateInsightsDashboard(events, options = {}) {
  const period = options.period || 'all';
  const now = Date.now();

  // 기간 필터링
  let filtered = events;
  if (period === '7d')  filtered = events.filter(e => (now - new Date(e.timestamp)) < WEEK_MS);
  if (period === '30d') filtered = events.filter(e => (now - new Date(e.timestamp)) < DAY_MS * 30);

  const patterns    = detectPatterns(filtered);
  const timeDist    = analyzeTimeDistribution(filtered);
  const repetitive  = findRepetitiveWork(filtered);
  const bottlenecks = detectBottlenecks(filtered);
  const efficiency  = calculateEfficiencyScore(filtered);
  const purposes    = summarizePurposes(filtered);

  // 트렌드 계산 (최근 7일 vs 이전 7일)
  const recent7d = events.filter(e => (now - new Date(e.timestamp)) < WEEK_MS);
  const prev7d   = events.filter(e => {
    const age = now - new Date(e.timestamp);
    return age >= WEEK_MS && age < WEEK_MS * 2;
  });
  const trend = {
    eventCountDelta: recent7d.length - prev7d.length,
    direction: recent7d.length > prev7d.length ? 'up' : recent7d.length < prev7d.length ? 'down' : 'flat',
    recentCount: recent7d.length,
    previousCount: prev7d.length,
  };

  // 오늘의 요약
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEvents = events.filter(e => new Date(e.timestamp) >= todayStart);
  const todaySummary = {
    eventCount: todayEvents.length,
    activeMinutes: Math.round(estimateActiveTime(todayEvents) / 60000),
    topPurpose: getTopPurpose(todayEvents),
    toolsUsed: [...new Set(todayEvents.filter(e => e.data?.toolName).map(e => e.data.toolName))],
  };

  return {
    period,
    totalEvents: filtered.length,
    efficiency,
    patterns,
    timeDistribution: timeDist,
    repetitiveWork: repetitive,
    bottlenecks,
    purposes,
    trend,
    todaySummary,
    generatedAt: new Date().toISOString(),
  };
}


// ─── 7. 역량 프로필 생성 (핵심가치 #2: 역량 레퍼런스) ────
/**
 * 사용자의 작업 데이터에서 역량 포트폴리오 생성
 * LinkedIn 프로필처럼 개인 역량을 시각화
 * @param {Array} events
 * @returns {{ skills, expertise, workStyle, topProjects }}
 */
function buildCapabilityProfile(events) {
  if (!events?.length) return { skills: [], expertise: [], workStyle: {}, topProjects: [] };

  // ── 기술 스택 추출 ──
  const skillMap = {};
  for (const e of events) {
    // 도구 → 기술
    const tool = e.data?.toolName;
    if (tool) {
      skillMap[tool] = (skillMap[tool] || 0) + 1;
    }

    // Bash 명령어에서 기술 추출
    const cmd = e.data?.input?.command || e.data?.inputPreview || '';
    for (const [pattern, skill] of SKILL_PATTERNS) {
      if (pattern.test(cmd)) {
        skillMap[skill] = (skillMap[skill] || 0) + 1;
      }
    }

    // 파일 확장자에서 언어 추출
    const fp = e.data?.filePath || e.data?.file || e.data?.path || '';
    const ext = fp.split('.').pop()?.toLowerCase();
    if (ext && EXTENSION_TO_LANG[ext]) {
      skillMap[EXTENSION_TO_LANG[ext]] = (skillMap[EXTENSION_TO_LANG[ext]] || 0) + 1;
    }
  }

  const skills = Object.entries(skillMap)
    .map(([name, usage]) => ({
      name,
      usage,
      level: usage > 100 ? 'expert' : usage > 30 ? 'advanced' : usage > 10 ? 'intermediate' : 'beginner',
      category: categorizeSkill(name),
    }))
    .sort((a, b) => b.usage - a.usage)
    .slice(0, 25);

  // ── 전문 분야 ──
  const purposeStats = summarizePurposes(events);
  const expertise = purposeStats.slice(0, 5).map(p => ({
    area: p.label,
    icon: p.icon,
    eventCount: p.eventCount,
    confidence: p.avgConfidence,
  }));

  // ── 작업 스타일 ──
  const eff = calculateEfficiencyScore(events);
  const workStyle = {
    type: determineWorkStyle(eff.breakdown),
    focusLevel: eff.breakdown.focus?.score || 0,
    consistency: eff.breakdown.consistency?.score || 0,
    toolDiversity: eff.breakdown.toolUsage?.score || 0,
    overallGrade: eff.grade,
  };

  // ── 주요 프로젝트 추정 ──
  const projMap = {};
  for (const e of events) {
    const dir = e.data?.projectDir || extractProjectDir(e.data?.filePath || e.data?.file || '');
    if (dir) {
      if (!projMap[dir]) projMap[dir] = { dir, events: 0, firstSeen: e.timestamp, lastSeen: e.timestamp };
      projMap[dir].events++;
      if (e.timestamp > projMap[dir].lastSeen) projMap[dir].lastSeen = e.timestamp;
      if (e.timestamp < projMap[dir].firstSeen) projMap[dir].firstSeen = e.timestamp;
    }
  }
  const topProjects = Object.values(projMap)
    .sort((a, b) => b.events - a.events)
    .slice(0, 8)
    .map(p => ({
      name: shortenPath(p.dir),
      eventCount: p.events,
      period: `${p.firstSeen.slice(0, 10)} ~ ${p.lastSeen.slice(0, 10)}`,
    }));

  return { skills, expertise, workStyle, topProjects };
}


// ─── 헬퍼 함수들 ─────────────────────────────────────────

const SKILL_PATTERNS = [
  [/\bnpm\b|yarn|pnpm/i,          'Node.js'],
  [/\bpython\b|pip|conda/i,       'Python'],
  [/\bgit\b/i,                    'Git'],
  [/\bdocker\b|compose/i,         'Docker'],
  [/\bkubectl|k8s\b/i,            'Kubernetes'],
  [/\brailway|heroku|vercel/i,    'Cloud Deploy'],
  [/\bnext|react|vue|angular/i,   'Frontend Framework'],
  [/\bpostgres|mysql|sqlite/i,    'Database'],
  [/\bjest|mocha|pytest/i,        'Testing'],
  [/\bcurl|wget|fetch/i,          'API/HTTP'],
  [/\baws|gcloud|azure/i,         'Cloud Services'],
  [/\btailwind|scss|less/i,       'CSS Framework'],
];

const EXTENSION_TO_LANG = {
  js: 'JavaScript', ts: 'TypeScript', py: 'Python', rb: 'Ruby',
  go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin',
  swift: 'Swift', cpp: 'C++', c: 'C', cs: 'C#',
  php: 'PHP', sql: 'SQL', html: 'HTML', css: 'CSS',
  jsx: 'React/JSX', tsx: 'React/TSX', vue: 'Vue',
  sh: 'Shell', yml: 'YAML', json: 'JSON', md: 'Markdown',
};

function normalizeCmd(cmd) {
  return (cmd || '')
    .replace(/\s+/g, ' ')
    .replace(/['"][^'"]*['"]/g, '"..."')
    .trim()
    .slice(0, 100);
}

function describeCmd(cmd) {
  if (/git push/i.test(cmd)) return 'Git 코드 푸시';
  if (/git commit/i.test(cmd)) return 'Git 커밋';
  if (/git status/i.test(cmd)) return 'Git 상태 확인';
  if (/npm test|jest/i.test(cmd)) return '테스트 실행';
  if (/npm run dev/i.test(cmd)) return '개발 서버 시작';
  if (/npm install/i.test(cmd)) return '패키지 설치';
  if (/docker/i.test(cmd)) return 'Docker 명령';
  if (/curl|wget/i.test(cmd)) return 'HTTP 요청';
  return cmd.slice(0, 40);
}

function isAutomatable(cmd) {
  return /git (push|commit|status|log)|npm (test|run|install)|docker|curl|wget|cp |mv |rm |mkdir/i.test(cmd);
}

function generateAutomationSuggestion(cmd) {
  if (/git push/i.test(cmd)) return 'CI/CD 파이프라인으로 자동 배포 설정';
  if (/git commit.*push/i.test(cmd)) return 'Git hook으로 커밋→푸시 자동화';
  if (/npm test/i.test(cmd)) return 'pre-commit hook으로 자동 테스트';
  if (/npm run dev/i.test(cmd)) return '개발 환경 자동 시작 스크립트 작성';
  if (/docker/i.test(cmd)) return 'Docker Compose로 환경 자동화';
  return 'Shell 스크립트 또는 Makefile로 자동화 가능';
}

function normalizePath(fp) {
  return (fp || '').replace(/^\/Users\/[^/]+/, '~').replace(/\\/g, '/');
}

function shortenPath(fp) {
  const parts = (fp || '').split('/');
  return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : fp;
}

function extractProjectDir(fp) {
  if (!fp) return null;
  const match = fp.match(/^(.*?\/[^/]+\/)/) || fp.match(/^([^/]+\/[^/]+)/);
  return match ? match[1] : null;
}

function categorizeSkill(name) {
  if (['JavaScript', 'TypeScript', 'Python', 'Go', 'Rust', 'Java', 'C++', 'Ruby', 'PHP'].includes(name)) return 'language';
  if (['React/JSX', 'React/TSX', 'Vue', 'Frontend Framework', 'CSS Framework', 'HTML', 'CSS'].includes(name)) return 'frontend';
  if (['Node.js', 'Database', 'SQL'].includes(name)) return 'backend';
  if (['Docker', 'Kubernetes', 'Cloud Deploy', 'Cloud Services'].includes(name)) return 'devops';
  if (['Git', 'Testing', 'API/HTTP'].includes(name)) return 'tool';
  return 'other';
}

function determineWorkStyle(breakdown) {
  if (!breakdown) return '분석 중';
  const f = breakdown.focus?.score || 0;
  const c = breakdown.consistency?.score || 0;
  const t = breakdown.toolUsage?.score || 0;

  if (f > 80 && c > 80) return '🎯 집중형 장인';
  if (t > 80 && f > 60) return '🛠 멀티툴 마스터';
  if (c > 80) return '📊 꾸준한 실행가';
  if (f > 80) return '🔥 딥 다이버';
  return '🌱 성장형 개발자';
}

function estimateActiveTime(events) {
  if (events.length < 2) return 0;
  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  let total = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = new Date(sorted[i + 1].timestamp) - new Date(sorted[i].timestamp);
    total += Math.min(gap, 30 * 60000);
  }
  return total;
}

function getTopPurpose(events) {
  const map = {};
  for (const e of events) {
    const p = e.purposeId || 'unknown';
    map[p] = (map[p] || 0) + 1;
  }
  const top = Object.entries(map).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const cat = PURPOSE_CATEGORIES[top[0].toUpperCase()];
  return cat ? { id: top[0], label: cat.label, icon: cat.icon } : null;
}

function calcAvgInterval(timestamps) {
  if (timestamps.length < 2) return 0;
  const sorted = timestamps.map(t => new Date(t).getTime()).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < sorted.length; i++) total += sorted[i] - sorted[i - 1];
  return Math.round(total / (sorted.length - 1) / HOUR_MS * 10) / 10;
}


// ─── Export ──────────────────────────────────────────────
module.exports = {
  detectPatterns,
  analyzeTimeDistribution,
  findRepetitiveWork,
  detectBottlenecks,
  calculateEfficiencyScore,
  generateInsightsDashboard,
  buildCapabilityProfile,
};
