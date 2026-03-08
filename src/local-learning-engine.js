'use strict';

/**
 * local-learning-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 로컬 학습 엔진 — 직원 PC에서 로컬로 실행되는 분석 모듈
 *
 * 핵심 원칙: "로컬 학습 → 분석 결과만 전송"
 * - 원본 키스트로크 데이터는 절대 로컬 머신 밖으로 나가지 않음
 * - 활동 분류, 패턴 감지, 세션 요약만 서버로 전송
 * - 경량 모델로 패턴 인식 수행
 *
 * 내보내는 함수:
 *   classifyActivity(windowTitle, appName, keystrokes) → 활동 유형
 *   detectPatterns(activityLog) → { repetitivePatterns, automationOpportunities, workflowSteps }
 *   summarizeSession(activities) → { summary, metrics, insights }
 *   buildLocalModel(historicalData) → 경량 패턴 인식 모델
 *   createAnalyzedOutput(rawData) → 전송용 분석 결과 (원본 데이터 없음)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ══════════════════════════════════════════════════════════════════════════════
// 활동 분류 규칙 — 앱 이름 + 윈도우 제목 + 키스트로크 패턴 기반
// ══════════════════════════════════════════════════════════════════════════════

// 앱 이름 기반 카테고리 매핑
const APP_CATEGORY_MAP = {
  // 이메일 클라이언트
  email: [
    'outlook', 'thunderbird', 'mail', 'mailspring', 'postbox',
    'gmail', 'naver mail', 'daum mail',
  ],
  // 코딩 / IDE
  coding: [
    'code', 'vscode', 'rider', 'pycharm', 'intellij', 'webstorm',
    'eclipse', 'netbeans', 'sublime', 'atom', 'vim', 'nvim', 'emacs',
    'cursor', 'windsurf', 'terminal', 'iterm', 'powershell', 'cmd',
    'warp', 'hyper', 'alacritty', 'xcode', 'android studio',
  ],
  // 문서 작성
  document: [
    'word', 'hwp', 'hanword', 'pages', 'libreoffice writer',
    'google docs', 'notion', 'obsidian', 'typora', 'bear',
  ],
  // 채팅 / 커뮤니케이션
  chat: [
    'slack', 'teams', 'kakaotalk', 'discord', 'zoom', 'line',
    'telegram', 'skype', 'wechat', 'whatsapp', 'messenger',
    'gather', 'webex',
  ],
  // 검색 / 브라우저 (윈도우 제목으로 세분화)
  search: [
    'chrome', 'firefox', 'edge', 'brave', 'whale', 'safari', 'opera',
  ],
  // 데이터 입력 / 스프레드시트
  'data-entry': [
    'excel', 'sheets', 'calc', 'numbers', 'airtable',
    'access', 'filemaker', 'libreoffice calc',
  ],
  // 프레젠테이션
  presentation: [
    'powerpnt', 'powerpoint', 'keynote', 'libreoffice impress',
    'google slides',
  ],
  // 디자인
  design: [
    'figma', 'sketch', 'photoshop', 'illustrator', 'canva',
    'xd', 'invision', 'zeplin',
  ],
  // 파일 관리
  file_manager: [
    'explorer', 'finder', 'nautilus', 'dolphin',
  ],
};

// 브라우저 윈도우 제목 기반 세분 분류 키워드
const BROWSER_TITLE_PATTERNS = {
  email:         ['gmail', 'outlook', 'mail', 'inbox', '메일', '받은편지함'],
  search:        ['google', 'bing', 'naver', 'daum', '검색', 'search'],
  chat:          ['slack', 'teams', 'discord', 'messenger', 'kakaotalk', '채팅'],
  document:      ['docs.google', 'notion.so', 'confluence', 'wiki', '문서'],
  coding:        ['github', 'gitlab', 'bitbucket', 'stackoverflow', 'stackblitz'],
  'data-entry':  ['sheets.google', 'airtable', '스프레드시트'],
  video:         ['youtube', 'vimeo', 'twitch', '동영상'],
  social:        ['facebook', 'twitter', 'instagram', 'linkedin', 'reddit'],
};

// 키스트로크 패턴 시그니처
const KEYSTROKE_SIGNATURES = {
  coding:        { symbols: /[{}()\[\]<>;=+\-*/|&!~^%]/g, threshold: 0.15 },
  'data-entry':  { tabFrequency: 0.1, numberRatio: 0.3 },
  document:      { avgWordLength: 4, spaceRatio: 0.15 },
  chat:          { avgBurstLength: 30, enterFrequency: 0.05 },
};

/**
 * 활동 유형 분류
 * @param {string} windowTitle - 활성 윈도우 제목
 * @param {string} appName - 활성 앱 이름
 * @param {string} keystrokes - 키스트로크 버퍼 (분석 후 폐기)
 * @returns {{ type: string, confidence: number, subCategory: string }}
 */
function classifyActivity(windowTitle, appName, keystrokes = '') {
  const app = (appName || '').toLowerCase();
  const title = (windowTitle || '').toLowerCase();
  let type = 'other';
  let confidence = 0.5;
  let subCategory = '';

  // 1단계: 앱 이름 기반 분류
  for (const [category, apps] of Object.entries(APP_CATEGORY_MAP)) {
    if (apps.some(a => app.includes(a))) {
      type = category;
      confidence = 0.8;
      break;
    }
  }

  // 2단계: 브라우저인 경우 윈도우 제목으로 세분화
  if (type === 'search') {
    for (const [subType, keywords] of Object.entries(BROWSER_TITLE_PATTERNS)) {
      if (keywords.some(k => title.includes(k))) {
        type = subType;
        subCategory = 'browser';
        confidence = 0.75;
        break;
      }
    }
  }

  // 3단계: 키스트로크 패턴으로 신뢰도 보강
  if (keystrokes && keystrokes.length > 10) {
    const analysis = _analyzeKeystrokePattern(keystrokes);
    if (analysis.suggestedType && analysis.confidence > confidence) {
      type = analysis.suggestedType;
      confidence = analysis.confidence;
    }
  }

  return { type, confidence, subCategory };
}

/**
 * 키스트로크 패턴 분석 (내부 함수)
 * @private
 */
function _analyzeKeystrokePattern(keystrokes) {
  const len = keystrokes.length;
  if (len === 0) return { suggestedType: null, confidence: 0 };

  // 기호 비율 계산 (코딩 판별)
  const symbolMatches = keystrokes.match(KEYSTROKE_SIGNATURES.coding.symbols);
  const symbolRatio = symbolMatches ? symbolMatches.length / len : 0;

  // 숫자 비율 (데이터 입력 판별)
  const numberMatches = keystrokes.match(/\d/g);
  const numberRatio = numberMatches ? numberMatches.length / len : 0;

  // Tab 비율 (데이터 입력 판별)
  const tabMatches = keystrokes.match(/\t/g);
  const tabRatio = tabMatches ? tabMatches.length / len : 0;

  // 공백 비율 (문서 작성 판별)
  const spaceMatches = keystrokes.match(/ /g);
  const spaceRatio = spaceMatches ? spaceMatches.length / len : 0;

  // Enter 빈도 (채팅 판별)
  const enterMatches = keystrokes.match(/\n/g);
  const enterRatio = enterMatches ? enterMatches.length / len : 0;

  // 판별 로직
  if (symbolRatio > KEYSTROKE_SIGNATURES.coding.threshold) {
    return { suggestedType: 'coding', confidence: 0.85 };
  }
  if (numberRatio > KEYSTROKE_SIGNATURES['data-entry'].numberRatio && tabRatio > 0.05) {
    return { suggestedType: 'data-entry', confidence: 0.8 };
  }
  if (enterRatio > KEYSTROKE_SIGNATURES.chat.enterFrequency && spaceRatio > 0.1) {
    return { suggestedType: 'chat', confidence: 0.7 };
  }
  if (spaceRatio > KEYSTROKE_SIGNATURES.document.spaceRatio) {
    return { suggestedType: 'document', confidence: 0.65 };
  }

  return { suggestedType: null, confidence: 0 };
}


// ══════════════════════════════════════════════════════════════════════════════
// 패턴 감지 — 활동 로그에서 반복 패턴, 자동화 기회, 워크플로 단계 추출
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 활동 로그에서 패턴 감지
 * @param {Array} activityLog - 활동 기록 배열
 * @returns {{ repetitivePatterns: Array, automationOpportunities: Array, workflowSteps: Array }}
 */
function detectPatterns(activityLog) {
  if (!activityLog || activityLog.length === 0) {
    return { repetitivePatterns: [], automationOpportunities: [], workflowSteps: [] };
  }

  const repetitivePatterns = _findRepetitivePatterns(activityLog);
  const automationOpportunities = _findAutomationOpportunities(activityLog);
  const workflowSteps = _extractWorkflowSteps(activityLog);

  return { repetitivePatterns, automationOpportunities, workflowSteps };
}

/**
 * 반복 패턴 탐지 — 같은 앱 전환 시퀀스가 반복되는지 확인
 * @private
 */
function _findRepetitivePatterns(activityLog) {
  const patterns = [];
  const appSequences = activityLog.map(a => a.app || a.app_name || '');

  // 2~5 길이의 반복 시퀀스 탐지
  for (let seqLen = 2; seqLen <= Math.min(5, Math.floor(appSequences.length / 2)); seqLen++) {
    const seqCounts = {};
    for (let i = 0; i <= appSequences.length - seqLen; i++) {
      const seq = appSequences.slice(i, i + seqLen).join(' → ');
      seqCounts[seq] = (seqCounts[seq] || 0) + 1;
    }
    for (const [seq, count] of Object.entries(seqCounts)) {
      if (count >= 3) {
        patterns.push({
          sequence: seq,
          count,
          type: 'app_switch_loop',
          description: `앱 전환 패턴 "${seq}" 가 ${count}회 반복됨`,
        });
      }
    }
  }

  // 같은 작업을 반복하는 패턴 (복사-붙여넣기 루프 등)
  const typeCounts = {};
  activityLog.forEach(a => {
    const key = `${a.activity_type || a.type}_${a.app || a.app_name}`;
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  });

  for (const [key, count] of Object.entries(typeCounts)) {
    if (count >= 5) {
      patterns.push({
        activity: key,
        count,
        type: 'repeated_action',
        description: `동일 작업 "${key}" 가 ${count}회 반복됨`,
      });
    }
  }

  return patterns;
}

/**
 * 자동화 기회 탐지
 * @private
 */
function _findAutomationOpportunities(activityLog) {
  const opportunities = [];

  // 1) 복사-붙여넣기 빈도 감지
  const copyPasteCount = activityLog.filter(a =>
    (a.patterns && a.patterns.copyPaste) ||
    (a.keystrokeMetrics && a.keystrokeMetrics.copyPasteCount > 0)
  ).length;

  if (copyPasteCount >= 5) {
    opportunities.push({
      type: 'copy_paste_automation',
      frequency: copyPasteCount,
      suggestion: '반복적인 복사-붙여넣기 작업이 감지됨 → 매크로/RPA 자동화 가능',
      priority: copyPasteCount >= 10 ? 'high' : 'medium',
    });
  }

  // 2) 같은 앱에서 반복 데이터 입력
  const dataEntryApps = activityLog.filter(a =>
    (a.activity_type || a.type) === 'data-entry'
  );
  if (dataEntryApps.length >= 10) {
    opportunities.push({
      type: 'data_entry_automation',
      frequency: dataEntryApps.length,
      suggestion: '반복적인 데이터 입력 작업 → 자동 양식 채우기 또는 CSV 임포트 가능',
      priority: 'high',
    });
  }

  // 3) 앱 간 빈번한 전환 (컨텍스트 스위칭 비용)
  let switchCount = 0;
  for (let i = 1; i < activityLog.length; i++) {
    const prev = activityLog[i - 1].app || activityLog[i - 1].app_name;
    const curr = activityLog[i].app || activityLog[i].app_name;
    if (prev !== curr) switchCount++;
  }
  const switchRate = activityLog.length > 1 ? switchCount / (activityLog.length - 1) : 0;

  if (switchRate > 0.7) {
    opportunities.push({
      type: 'context_switch_reduction',
      rate: Math.round(switchRate * 100),
      suggestion: '앱 전환 빈도가 높음 → 듀얼 모니터 또는 통합 도구 활용 추천',
      priority: 'medium',
    });
  }

  return opportunities;
}

/**
 * 워크플로 단계 추출 — 시간순으로 앱 사용 흐름 정리
 * @private
 */
function _extractWorkflowSteps(activityLog) {
  const steps = [];
  let currentStep = null;

  for (const activity of activityLog) {
    const app = activity.app || activity.app_name || 'unknown';
    const type = activity.activity_type || activity.type || 'unknown';

    if (!currentStep || currentStep.app !== app) {
      if (currentStep) {
        currentStep.endTime = activity.timestamp || new Date().toISOString();
        steps.push(currentStep);
      }
      currentStep = {
        app,
        type,
        category: activity.category || type,
        startTime: activity.timestamp || new Date().toISOString(),
        endTime: null,
        duration_sec: 0,
        activityCount: 1,
      };
    } else {
      currentStep.activityCount++;
      currentStep.duration_sec += activity.duration_sec || 0;
    }
  }

  if (currentStep) {
    currentStep.endTime = new Date().toISOString();
    steps.push(currentStep);
  }

  return steps;
}


// ══════════════════════════════════════════════════════════════════════════════
// 세션 요약 — 활동 데이터를 압축해서 메트릭 + 인사이트 생성
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 세션 요약 생성
 * @param {Array} activities - 분석된 활동 배열
 * @returns {{ summary: string, metrics: Object, insights: Object }}
 */
function summarizeSession(activities) {
  if (!activities || activities.length === 0) {
    return {
      summary: '활동 데이터 없음',
      metrics: { typingSpeed: 0, activeTime: 0, idleTime: 0, contextSwitches: 0 },
      insights: { topApps: [], workflowSteps: [], efficiency_score: 0 },
    };
  }

  // ── 메트릭 계산 ──
  const metrics = _calculateMetrics(activities);

  // ── 인사이트 생성 ──
  const insights = _generateInsights(activities, metrics);

  // ── 텍스트 요약 ──
  const summary = _generateTextSummary(activities, metrics, insights);

  return { summary, metrics, insights };
}

/**
 * 메트릭 계산
 * @private
 */
function _calculateMetrics(activities) {
  let totalDuration = 0;
  let activeTime = 0;
  let idleTime = 0;
  let contextSwitches = 0;
  let totalKeystrokes = 0;
  let totalWords = 0;
  let copyPasteCount = 0;

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    const dur = a.duration_sec || 0;
    totalDuration += dur;

    if (a.activity_type === 'idle' || a.type === 'idle') {
      idleTime += dur;
    } else {
      activeTime += dur;
    }

    // 컨텍스트 스위치 카운트
    if (i > 0) {
      const prevApp = activities[i - 1].app || activities[i - 1].app_name;
      const currApp = a.app || a.app_name;
      if (prevApp !== currApp) contextSwitches++;
    }

    // 키스트로크 메트릭 (로컬 분석 결과에서)
    if (a.keystrokeMetrics) {
      totalKeystrokes += a.keystrokeMetrics.totalKeys || 0;
      totalWords += a.keystrokeMetrics.wordCount || 0;
      copyPasteCount += a.keystrokeMetrics.copyPasteCount || 0;
    }
  }

  // 분당 타이핑 속도 (WPM)
  const activeMinutes = activeTime / 60;
  const typingSpeed = activeMinutes > 0 ? Math.round(totalWords / activeMinutes) : 0;

  return {
    typingSpeed,
    activeTime,
    idleTime,
    totalDuration,
    contextSwitches,
    totalKeystrokes,
    totalWords,
    copyPasteCount,
  };
}

/**
 * 인사이트 생성
 * @private
 */
function _generateInsights(activities, metrics) {
  // 상위 앱 사용 시간
  const appDurations = {};
  activities.forEach(a => {
    const app = a.app || a.app_name || 'unknown';
    appDurations[app] = (appDurations[app] || 0) + (a.duration_sec || 0);
  });

  const topApps = Object.entries(appDurations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([app, duration]) => ({ app, duration_sec: duration }));

  // 카테고리별 시간 분포
  const categoryDistribution = {};
  activities.forEach(a => {
    const cat = a.category || a.activity_type || a.type || 'other';
    categoryDistribution[cat] = (categoryDistribution[cat] || 0) + (a.duration_sec || 0);
  });

  // 워크플로 단계
  const workflowSteps = _extractWorkflowSteps(activities);

  // 효율성 점수 (0~100) — 활성 시간 비율 + 컨텍스트 스위치 패널티
  const activeRatio = metrics.totalDuration > 0
    ? metrics.activeTime / metrics.totalDuration
    : 0;
  const switchPenalty = Math.min(metrics.contextSwitches * 0.5, 20);
  const efficiency_score = Math.max(0, Math.min(100,
    Math.round(activeRatio * 100 - switchPenalty)
  ));

  return {
    topApps,
    categoryDistribution,
    workflowSteps,
    efficiency_score,
  };
}

/**
 * 텍스트 요약 생성
 * @private
 */
function _generateTextSummary(activities, metrics, insights) {
  const parts = [];
  const totalMin = Math.round(metrics.totalDuration / 60);
  const activeMin = Math.round(metrics.activeTime / 60);

  parts.push(`총 ${totalMin}분 중 ${activeMin}분 활성 작업`);

  if (insights.topApps.length > 0) {
    const topApp = insights.topApps[0];
    parts.push(`주요 사용 앱: ${topApp.app} (${Math.round(topApp.duration_sec / 60)}분)`);
  }

  if (metrics.contextSwitches > 0) {
    parts.push(`컨텍스트 전환: ${metrics.contextSwitches}회`);
  }

  if (metrics.typingSpeed > 0) {
    parts.push(`타이핑 속도: ${metrics.typingSpeed} WPM`);
  }

  parts.push(`효율성 점수: ${insights.efficiency_score}/100`);

  return parts.join(' | ');
}


// ══════════════════════════════════════════════════════════════════════════════
// 로컬 모델 — 경량 패턴 인식 (통계 기반)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 경량 로컬 모델 구축 — 히스토리 데이터에서 패턴 학습
 * @param {Array} historicalData - 과거 분석 결과 배열
 * @returns {{ appUsageProfile: Object, typicalWorkflow: Array, baselineMetrics: Object, anomalyThresholds: Object }}
 */
function buildLocalModel(historicalData) {
  if (!historicalData || historicalData.length === 0) {
    return {
      appUsageProfile: {},
      typicalWorkflow: [],
      baselineMetrics: {},
      anomalyThresholds: {},
      modelVersion: 1,
      lastUpdated: new Date().toISOString(),
    };
  }

  // 앱 사용 프로필 구축 — 앱별 평균 사용 시간, 빈도
  const appUsageProfile = {};
  const allMetrics = [];

  for (const session of historicalData) {
    if (session.insights && session.insights.topApps) {
      for (const appInfo of session.insights.topApps) {
        if (!appUsageProfile[appInfo.app]) {
          appUsageProfile[appInfo.app] = { totalDuration: 0, sessionCount: 0 };
        }
        appUsageProfile[appInfo.app].totalDuration += appInfo.duration_sec || 0;
        appUsageProfile[appInfo.app].sessionCount++;
      }
    }

    if (session.metrics) {
      allMetrics.push(session.metrics);
    }
  }

  // 앱별 평균 계산
  for (const app of Object.keys(appUsageProfile)) {
    const profile = appUsageProfile[app];
    profile.avgDuration = profile.sessionCount > 0
      ? Math.round(profile.totalDuration / profile.sessionCount)
      : 0;
  }

  // 기준 메트릭 (중앙값 기반)
  const baselineMetrics = _computeBaseline(allMetrics);

  // 이상 탐지 임계값 (기준 ± 2 표준편차)
  const anomalyThresholds = _computeAnomalyThresholds(allMetrics, baselineMetrics);

  // 전형적인 워크플로 패턴 (가장 빈번한 앱 전환 시퀀스)
  const typicalWorkflow = _findTypicalWorkflow(historicalData);

  return {
    appUsageProfile,
    typicalWorkflow,
    baselineMetrics,
    anomalyThresholds,
    modelVersion: 1,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * 기준 메트릭 계산 (중앙값)
 * @private
 */
function _computeBaseline(allMetrics) {
  if (allMetrics.length === 0) return {};

  const fields = ['typingSpeed', 'activeTime', 'idleTime', 'contextSwitches'];
  const baseline = {};

  for (const field of fields) {
    const values = allMetrics
      .map(m => m[field])
      .filter(v => typeof v === 'number')
      .sort((a, b) => a - b);

    if (values.length > 0) {
      const mid = Math.floor(values.length / 2);
      baseline[field] = values.length % 2 === 0
        ? (values[mid - 1] + values[mid]) / 2
        : values[mid];
    }
  }

  return baseline;
}

/**
 * 이상 탐지 임계값 계산
 * @private
 */
function _computeAnomalyThresholds(allMetrics, baseline) {
  if (allMetrics.length < 3) return {};

  const thresholds = {};
  const fields = ['typingSpeed', 'activeTime', 'idleTime', 'contextSwitches'];

  for (const field of fields) {
    const values = allMetrics.map(m => m[field]).filter(v => typeof v === 'number');
    if (values.length < 3) continue;

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);

    thresholds[field] = {
      low: Math.max(0, Math.round(mean - 2 * stddev)),
      high: Math.round(mean + 2 * stddev),
    };
  }

  return thresholds;
}

/**
 * 전형적 워크플로 패턴 추출
 * @private
 */
function _findTypicalWorkflow(historicalData) {
  const transitionCounts = {};

  for (const session of historicalData) {
    if (!session.insights || !session.insights.workflowSteps) continue;
    const steps = session.insights.workflowSteps;

    for (let i = 0; i < steps.length - 1; i++) {
      const from = steps[i].app || 'unknown';
      const to = steps[i + 1].app || 'unknown';
      const key = `${from} → ${to}`;
      transitionCounts[key] = (transitionCounts[key] || 0) + 1;
    }
  }

  return Object.entries(transitionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([transition, count]) => ({ transition, count }));
}


// ══════════════════════════════════════════════════════════════════════════════
// 전송용 분석 결과 생성 — 원본 데이터 제거, 분석 결과만 포함
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 최종 분석 결과 생성 — 서버 전송용
 * 원본 키스트로크 절대 포함하지 않음
 *
 * @param {Object} rawData - { activities, keystrokeBuffer, startTime, endTime }
 * @returns {Object} 분석 결과 (원본 데이터 없음)
 */
function createAnalyzedOutput(rawData) {
  const {
    activities = [],
    keystrokeBuffer = '',
    startTime = new Date().toISOString(),
    endTime = new Date().toISOString(),
  } = rawData;

  // ── 각 활동에 대해 분류 실행 ──
  const classifiedActivities = activities.map(a => {
    const classification = classifyActivity(
      a.window_title || a.title || '',
      a.app_name || a.app || '',
      keystrokeBuffer
    );

    return {
      type: classification.type,
      app: a.app_name || a.app || 'unknown',
      duration: a.duration_sec || 0,
      category: classification.type,
      confidence: classification.confidence,
      // 원본 윈도우 제목 대신 앱+카테고리만
      appContext: `${a.app_name || a.app || 'unknown'}:${classification.type}`,
    };
  });

  // ── 패턴 감지 ──
  const patterns = detectPatterns(activities);

  // ── 세션 요약 ──
  const { summary, metrics, insights } = summarizeSession(activities);

  // ── 키스트로크 메트릭만 추출 (내용 절대 포함 안 함) ──
  const keystrokeMetrics = _extractKeystrokeMetrics(keystrokeBuffer);

  // ── 최종 출력: 원본 데이터 없음 ──
  return {
    period: {
      start: startTime,
      end: endTime,
    },
    activities: classifiedActivities,
    patterns: {
      repetitive: patterns.repetitivePatterns,
      automation_opportunities: patterns.automationOpportunities,
    },
    metrics: {
      typingSpeed: metrics.typingSpeed,
      activeTime: metrics.activeTime,
      idleTime: metrics.idleTime,
      contextSwitches: metrics.contextSwitches,
      totalKeystrokes: keystrokeMetrics.totalKeys,
      copyPasteCount: keystrokeMetrics.copyPasteCount,
    },
    insights: {
      topApps: insights.topApps,
      workflowSteps: insights.workflowSteps,
      efficiency_score: insights.efficiency_score,
      categoryDistribution: insights.categoryDistribution,
    },
    summary,
    // 원본 키스트로크 내용 없음 — 절대 전송하지 않음
  };
}

/**
 * 키스트로크 버퍼에서 메트릭만 추출 (내용 제거)
 * @private
 */
function _extractKeystrokeMetrics(buffer) {
  if (!buffer || buffer.length === 0) {
    return { totalKeys: 0, wordCount: 0, copyPasteCount: 0, avgWordLength: 0 };
  }

  const totalKeys = buffer.length;
  const words = buffer.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const avgWordLength = wordCount > 0
    ? Math.round(words.reduce((s, w) => s + w.length, 0) / wordCount * 10) / 10
    : 0;

  // Ctrl+C / Ctrl+V 패턴 추정 (연속 동일 텍스트 블록)
  let copyPasteCount = 0;
  if (buffer.length > 20) {
    const chunks = buffer.match(/.{10,}/g) || [];
    const seen = new Set();
    for (const chunk of chunks) {
      if (seen.has(chunk)) copyPasteCount++;
      seen.add(chunk);
    }
  }

  return { totalKeys, wordCount, copyPasteCount, avgWordLength };
}


// ══════════════════════════════════════════════════════════════════════════════
// 내보내기
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
  classifyActivity,
  detectPatterns,
  summarizeSession,
  buildLocalModel,
  createAnalyzedOutput,

  // 테스트용 내부 함수
  _analyzeKeystrokePattern,
  _extractKeystrokeMetrics,
};
