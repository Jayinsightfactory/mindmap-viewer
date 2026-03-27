'use strict';
/**
 * work-learner.js — 캡처+키로거 조합 학습 엔진
 *
 * keyboard.chunk + screen.capture를 결합하여:
 * 1. 업무 세션 감지 (시간 근접 이벤트 그룹핑)
 * 2. 활동 분류 (앱+윈도우타이틀 → 업무 유형)
 * 3. 반복 패턴 마이닝 (자동화 후보)
 * 4. 시간대별 업무 분석
 * 5. 멤버별 업무 프로필 생성
 */

// ── 업무 유형 분류 규칙 ────────────────────────────────────────────────────
const WORK_CATEGORIES = {
  '전산처리':   { apps: ['nenova'], keywords: ['주문', '관리', '입력', '조회', '화면', '프로그램'] },
  '문서작업':   { apps: ['excel', 'word', 'hwp', 'powerpnt', 'acrobat'], keywords: ['발주', '견적', '보고서', '매출', '시트'] },
  '커뮤니케이션': { apps: ['kakaotalk', 'slack', 'teams', 'outlook'], keywords: ['채팅', '메시지', '대화'] },
  '파일관리':   { apps: ['explorer'], keywords: ['폴더', '파일', '복사', '이동', '탐색기'] },
  '웹검색':     { apps: ['chrome', 'edge', 'firefox', 'whale'], keywords: ['검색', 'google', '네이버'] },
  '개발':       { apps: ['code', 'vscode', 'cursor', 'terminal', 'iterm'], keywords: ['코드', '빌드', '배포', 'git'] },
  '디자인':     { apps: ['figma', 'photoshop', 'illustrator'], keywords: ['디자인', '레이아웃'] },
};

// ── 이벤트 → 업무 세션 그룹핑 ─────────────────────────────────────────────
function groupIntoWorkSessions(events, gapMinutes = 5) {
  const sorted = events
    .filter(e => e.type === 'keyboard.chunk' || e.type === 'screen.capture')
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const sessions = [];
  let current = null;

  for (const ev of sorted) {
    const ts = new Date(ev.timestamp).getTime();
    if (!current || ts - current.endTs > gapMinutes * 60 * 1000) {
      if (current) sessions.push(current);
      current = { startTs: ts, endTs: ts, events: [ev] };
    } else {
      current.endTs = ts;
      current.events.push(ev);
    }
  }
  if (current) sessions.push(current);
  return sessions;
}

// ── 단일 이벤트 → 앱/윈도우 추출 ─────────────────────────────────────────
function extractContext(event) {
  let data = event.data || {};
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }

  if (event.type === 'keyboard.chunk') {
    const ctx = data.appContext || {};
    const steps = (data.patterns?.detected?.workflowSteps) || [];
    const app = ctx.currentApp || (steps[0]?.app) || '';
    const window = ctx.currentWindow || '';
    const wh = ctx.windowHistory || {};
    const summary = data.summary || '';
    const mouseClicks = data.mouseClicks || 0;
    return { app: app.toLowerCase(), window, windowHistory: wh, summary, mouseClicks, type: 'keyboard' };
  }

  if (event.type === 'screen.capture') {
    return {
      app: (data.app || '').toLowerCase(),
      window: data.windowTitle || '',
      trigger: data.trigger || '',
      activityLevel: data.activityLevel || '',
      type: 'capture',
    };
  }

  return { app: '', window: '', type: event.type };
}

// ── 활동 분류 ─────────────────────────────────────────────────────────────
function classifyActivity(app, windowTitle) {
  const appLow = (app || '').toLowerCase();
  const titleLow = (windowTitle || '').toLowerCase();

  for (const [category, rule] of Object.entries(WORK_CATEGORIES)) {
    if (rule.apps.some(a => appLow.includes(a))) return category;
    if (rule.keywords.some(k => titleLow.includes(k))) return category;
  }
  return '기타';
}

// ── 세션 분석 ─────────────────────────────────────────────────────────────
function analyzeSession(session) {
  const apps = {};
  const categories = {};
  const windows = [];
  let totalKeys = 0;
  let totalClicks = 0;
  let captureCount = 0;

  for (const ev of session.events) {
    const ctx = extractContext(ev);
    if (ctx.app) apps[ctx.app] = (apps[ctx.app] || 0) + 1;
    if (ctx.window) windows.push(ctx.window);
    if (ctx.mouseClicks) totalClicks += ctx.mouseClicks;
    if (ctx.type === 'capture') captureCount++;

    const cat = classifyActivity(ctx.app, ctx.window);
    categories[cat] = (categories[cat] || 0) + 1;
  }

  const durationMin = Math.round((session.endTs - session.startTs) / 60000);
  const primaryApp = Object.entries(apps).sort((a, b) => b[1] - a[1])[0]?.[0] || '알 수 없음';
  const primaryCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] || '기타';

  // 고유 윈도우 타이틀 (반복 제거)
  const uniqueWindows = [...new Set(windows)].slice(0, 5);

  return {
    startTime: new Date(session.startTs).toISOString(),
    endTime: new Date(session.endTs).toISOString(),
    durationMin,
    eventCount: session.events.length,
    primaryApp,
    primaryCategory,
    apps,
    categories,
    uniqueWindows,
    totalClicks,
    captureCount,
  };
}

// ── 반복 패턴 감지 ────────────────────────────────────────────────────────
function detectPatterns(sessions) {
  // 앱 전환 시퀀스 추출
  const sequences = [];
  for (const sess of sessions) {
    const appSeq = [];
    let lastApp = '';
    for (const ev of sess.events) {
      const ctx = extractContext(ev);
      if (ctx.app && ctx.app !== lastApp) {
        appSeq.push(ctx.app);
        lastApp = ctx.app;
      }
    }
    if (appSeq.length >= 2) sequences.push(appSeq);
  }

  // 2-gram, 3-gram 빈도 계산
  const ngrams = {};
  for (const seq of sequences) {
    for (let n = 2; n <= Math.min(4, seq.length); n++) {
      for (let i = 0; i <= seq.length - n; i++) {
        const gram = seq.slice(i, i + n).join(' → ');
        ngrams[gram] = (ngrams[gram] || 0) + 1;
      }
    }
  }

  // 2회 이상 반복된 패턴만
  const patterns = Object.entries(ngrams)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => {
      const apps = pattern.split(' → ');
      const isAutomatable = apps.some(a =>
        ['nenova', 'excel', 'explorer'].includes(a)
      );
      return {
        pattern,
        count,
        automatable: isAutomatable,
        suggestion: isAutomatable
          ? `이 작업 흐름(${pattern})이 ${count}회 반복됨 — 자동화 가능`
          : `반복 패턴: ${pattern} (${count}회)`,
      };
    });

  return patterns;
}

// ── 시간대별 업무 분석 ────────────────────────────────────────────────────
function analyzeTimeDistribution(events) {
  const hourly = Array(24).fill(0);
  const hourlyApps = {};

  for (const ev of events) {
    if (ev.type !== 'keyboard.chunk') continue;
    const h = new Date(ev.timestamp).getHours();
    hourly[h]++;
    const ctx = extractContext(ev);
    if (ctx.app) {
      if (!hourlyApps[h]) hourlyApps[h] = {};
      hourlyApps[h][ctx.app] = (hourlyApps[h][ctx.app] || 0) + 1;
    }
  }

  // 피크 시간
  const peakHour = hourly.indexOf(Math.max(...hourly));
  // 업무 시간 (첫/마지막 활동)
  const firstHour = hourly.findIndex(c => c > 0);
  const lastHour = 23 - [...hourly].reverse().findIndex(c => c > 0);

  return { hourly, hourlyApps, peakHour, firstHour, lastHour };
}

// ── 전체 멤버 분석 실행 ───────────────────────────────────────────────────
async function analyzeUser(pool, userId) {
  // LIMIT + 최근 30일만 — 무제한 스캔 시 OOM (Bad Gateway 근본 원인)
  const { rows } = await pool.query(
    `SELECT id, type, timestamp, data_json FROM events
     WHERE user_id=$1
       AND type IN ('keyboard.chunk','screen.capture','idle')
       AND timestamp > NOW() - INTERVAL '30 days'
     ORDER BY timestamp DESC LIMIT 5000`,
    [userId]
  );

  const events = rows.map(r => ({
    id: r.id,
    type: r.type,
    timestamp: r.timestamp,
    data: typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r.data_json,
  }));

  if (events.length < 3) {
    return { userId, status: 'insufficient', eventCount: events.length, message: '데이터 부족 (3건 이상 필요)' };
  }

  // 1. 세션 그룹핑
  const workSessions = groupIntoWorkSessions(events);
  const sessionAnalyses = workSessions.map(analyzeSession);

  // 2. 앱 사용 통계
  const appTotals = {};
  const categoryTotals = {};
  for (const sa of sessionAnalyses) {
    for (const [app, cnt] of Object.entries(sa.apps)) {
      appTotals[app] = (appTotals[app] || 0) + cnt;
    }
    for (const [cat, cnt] of Object.entries(sa.categories)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + cnt;
    }
  }

  // 3. 반복 패턴
  const patterns = detectPatterns(workSessions);

  // 4. 시간대 분석
  const timeAnalysis = analyzeTimeDistribution(events);

  // 5. 총 업무 시간
  const totalWorkMin = sessionAnalyses.reduce((s, a) => s + a.durationMin, 0);

  // 6. 자동화 점수 (0~100)
  const automationScore = Math.min(100, Math.round(
    (patterns.filter(p => p.automatable).length * 20) +
    (categoryTotals['전산처리'] ? 15 : 0) +
    (categoryTotals['파일관리'] ? 10 : 0) +
    (Object.keys(appTotals).length <= 3 ? 10 : 0) // 앱 적으면 루틴성
  ));

  return {
    userId,
    status: 'ok',
    eventCount: events.length,
    sessionCount: workSessions.length,
    totalWorkMin,
    topApps: Object.entries(appTotals).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topCategories: Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]),
    patterns,
    timeAnalysis: {
      peakHour: timeAnalysis.peakHour,
      workHours: `${timeAnalysis.firstHour}:00 ~ ${timeAnalysis.lastHour}:00`,
      hourly: timeAnalysis.hourly,
    },
    automationScore,
    sessions: sessionAnalyses.slice(0, 10), // 최근 10개 세션
    insights: _generateInsights(sessionAnalyses, patterns, categoryTotals, appTotals, automationScore),
  };
}

// ── 인사이트 자동 생성 ────────────────────────────────────────────────────
function _generateInsights(sessions, patterns, categories, apps, autoScore) {
  const insights = [];

  // 주요 업무
  const topCat = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];
  if (topCat) {
    insights.push({ type: 'info', text: `주요 업무: ${topCat[0]} (전체의 ${Math.round(topCat[1] / Object.values(categories).reduce((s, v) => s + v, 0) * 100)}%)` });
  }

  // 자동화 가능 패턴
  const autoPatterns = patterns.filter(p => p.automatable);
  if (autoPatterns.length > 0) {
    insights.push({ type: 'automation', text: `자동화 가능 패턴 ${autoPatterns.length}개 감지 — ${autoPatterns[0].pattern}` });
  }

  // 앱 집중도
  const topApp = Object.entries(apps).sort((a, b) => b[1] - a[1])[0];
  const totalAppUse = Object.values(apps).reduce((s, v) => s + v, 0);
  if (topApp && totalAppUse > 0) {
    const pct = Math.round(topApp[1] / totalAppUse * 100);
    if (pct >= 50) {
      insights.push({ type: 'focus', text: `${topApp[0]}에 ${pct}% 집중 — 이 앱 최적화가 효율 향상의 핵심` });
    }
  }

  // 자동화 점수
  if (autoScore >= 50) {
    insights.push({ type: 'score', text: `자동화 가능성 ${autoScore}/100 — 반복 작업 비율 높음` });
  } else if (autoScore >= 25) {
    insights.push({ type: 'score', text: `자동화 가능성 ${autoScore}/100 — 부분 자동화 가능` });
  }

  return insights;
}

// ── 전체 워크스페이스 분석 ────────────────────────────────────────────────
async function analyzeWorkspace(pool, memberIds) {
  const results = [];
  for (const uid of memberIds) {
    const result = await analyzeUser(pool, uid);
    results.push(result);
  }

  // 팀 전체 패턴
  const allPatterns = results.flatMap(r => r.patterns || []);
  const teamInsights = [];

  // 공통 앱
  const allApps = {};
  results.forEach(r => {
    (r.topApps || []).forEach(([app]) => { allApps[app] = (allApps[app] || 0) + 1; });
  });
  const sharedApps = Object.entries(allApps).filter(([_, cnt]) => cnt >= 2).map(([app]) => app);
  if (sharedApps.length) {
    teamInsights.push({ type: 'team', text: `팀 공통 앱: ${sharedApps.join(', ')}` });
  }

  return { members: results, teamInsights, analyzedAt: new Date().toISOString() };
}

module.exports = { analyzeUser, analyzeWorkspace, groupIntoWorkSessions, classifyActivity, detectPatterns };
