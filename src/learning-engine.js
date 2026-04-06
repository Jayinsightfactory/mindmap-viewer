/**
 * learning-engine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 5: AI 학습 엔진
 *
 * 개인별 작업 패턴을 학습하여:
 * 1. 작업 루틴 모델링 (매일/매주 반복 패턴)
 * 2. 트리거 감지 (특정 조건에서 특정 행동)
 * 3. 맞춤 솔루션 자동 추천 (마켓플레이스 연결)
 * 4. AI 자동화 가능 영역 제안
 * 5. 학습 데이터 시트 (사용자 열람 가능)
 *
 * 핵심가치 #3: AI에 무지한 사람도 자기 업무 중 AI 대체 가능 영역을 제안받음
 * ─────────────────────────────────────────────────────────────────────────────
 */
'use strict';

const {
  detectPatterns,
  analyzeTimeDistribution,
  findRepetitiveWork,
  calculateEfficiencyScore,
  buildCapabilityProfile,
} = require('./work-analyzer');
const { annotateEventsWithPurpose, summarizePurposes } = require('./purpose-classifier');

// ─── AI 추천 솔루션 카탈로그 ──────────────────────────────
const AI_SOLUTION_CATALOG = [
  {
    id: 'python-automation',
    name: 'Python 자동화 스크립트',
    category: 'automation',
    icon: '🐍',
    triggers: ['repetitive_command', 'data_processing'],
    description: '반복 명령어를 Python 스크립트로 자동화',
    difficulty: 'medium',
    estimatedSetupHours: 4,
    estimatedSavingsPerWeek: 120,
  },
  {
    id: 'claude-api-integration',
    name: 'Claude API 업무 연동',
    category: 'ai',
    icon: '🤖',
    triggers: ['text_heavy', 'analysis_heavy'],
    description: '문서 분석, 코드 리뷰, 요약 등을 Claude API로 자동화',
    difficulty: 'medium',
    estimatedSetupHours: 8,
    estimatedSavingsPerWeek: 180,
  },
  {
    id: 'ci-cd-pipeline',
    name: 'CI/CD 파이프라인',
    category: 'devops',
    icon: '🚀',
    triggers: ['frequent_deploy', 'manual_test'],
    description: '배포와 테스트를 자동화된 파이프라인으로',
    difficulty: 'hard',
    estimatedSetupHours: 16,
    estimatedSavingsPerWeek: 240,
  },
  {
    id: 'git-hooks',
    name: 'Git Hooks 자동화',
    category: 'automation',
    icon: '🔗',
    triggers: ['repetitive_git', 'manual_lint'],
    description: '커밋/푸시 시 자동으로 린팅, 테스트, 포맷팅 실행',
    difficulty: 'easy',
    estimatedSetupHours: 2,
    estimatedSavingsPerWeek: 60,
  },
  {
    id: 'data-dashboard',
    name: '데이터 대시보드',
    category: 'analytics',
    icon: '📊',
    triggers: ['data_analysis', 'reporting'],
    description: '수동 데이터 집계를 실시간 대시보드로 대체',
    difficulty: 'hard',
    estimatedSetupHours: 20,
    estimatedSavingsPerWeek: 300,
  },
  {
    id: 'slack-bot',
    name: 'Slack 봇 자동화',
    category: 'communication',
    icon: '💬',
    triggers: ['frequent_communication', 'status_update'],
    description: '상태 업데이트, 알림, 일일 리포트를 Slack 봇으로',
    difficulty: 'medium',
    estimatedSetupHours: 6,
    estimatedSavingsPerWeek: 90,
  },
  {
    id: 'spreadsheet-automation',
    name: '스프레드시트 자동화',
    category: 'automation',
    icon: '📋',
    triggers: ['spreadsheet_heavy', 'data_entry'],
    description: '엑셀/시트 반복 작업을 스크립트로 자동화',
    difficulty: 'easy',
    estimatedSetupHours: 3,
    estimatedSavingsPerWeek: 150,
  },
  {
    id: 'code-generator',
    name: 'AI 코드 생성 파이프라인',
    category: 'ai',
    icon: '⚡',
    triggers: ['boilerplate_heavy', 'repetitive_code'],
    description: '반복적인 코드 패턴을 AI 템플릿으로 자동 생성',
    difficulty: 'medium',
    estimatedSetupHours: 10,
    estimatedSavingsPerWeek: 200,
  },
];


// ─── 1. 학습 프로필 구축 ──────────────────────────────────
/**
 * 사용자의 전체 이벤트에서 학습 프로필 생성
 * @param {Array} events - 어노테이션된 이벤트
 * @returns {{ routines, triggers, automationAreas, learningData }}
 */
function buildLearningProfile(events) {
  if (!events?.length) return { routines: [], triggers: [], automationAreas: [], learningData: [] };

  const patterns = detectPatterns(events);
  const time     = analyzeTimeDistribution(events);
  const rep      = findRepetitiveWork(events);
  const cap      = buildCapabilityProfile(events);

  // ── 루틴 모델링 ──
  const routines = buildRoutines(patterns, time);

  // ── 트리거 감지 ──
  const triggers = detectTriggers(events, patterns);

  // ── AI 자동화 가능 영역 ──
  const automationAreas = identifyAutomationAreas(events, rep, cap);

  // ── 학습 데이터 시트 ──
  const learningData = compileLearningSheet(events, routines, triggers, automationAreas, cap);

  return { routines, triggers, automationAreas, learningData };
}


// ─── 2. 루틴 모델링 ────────────────────────────────────
function buildRoutines(patterns, time) {
  const routines = [];

  // 요일별 주요 활동
  for (const wp of (patterns.weeklyPatterns || [])) {
    if (wp.count > 5 && wp.intensity > 50) {
      routines.push({
        type: 'weekly',
        day: wp.day,
        dayIndex: wp.dayIndex,
        description: `${wp.day}요일: 주로 "${wp.topPurpose}" 작업 (활동도 ${wp.intensity}%)`,
        topPurpose: wp.topPurpose,
        confidence: wp.intensity / 100,
      });
    }
  }

  // 시간대별 패턴
  const peakHours = (patterns.dailyRhythm || [])
    .filter(h => h.intensity > 60)
    .map(h => h.hour);

  if (peakHours.length > 0) {
    const start = Math.min(...peakHours);
    const end   = Math.max(...peakHours);
    routines.push({
      type: 'daily',
      description: `주요 작업 시간: ${start}시~${end}시`,
      peakHours,
      confidence: 0.8,
    });
  }

  // 가장 생산적인 시간대
  if (time.peakHour !== undefined) {
    routines.push({
      type: 'peak',
      description: `최고 생산성 시간: ${time.peakHour}시`,
      peakHour: time.peakHour,
      confidence: 0.9,
    });
  }

  return routines;
}


// ─── 3. 트리거 감지 ────────────────────────────────────
function detectTriggers(events, patterns) {
  const triggers = [];

  // 도구 시퀀스 트리거 (A 다음에 항상 B)
  for (const seq of (patterns.toolSequences || []).slice(0, 5)) {
    if (seq.count >= 5) {
      triggers.push({
        type: 'tool_sequence',
        condition: seq.sequence.split(' → ')[0],
        action: seq.sequence.split(' → ')[1],
        frequency: seq.count,
        description: `"${seq.sequence}" 패턴 ${seq.count}회 반복`,
        automatable: true,
      });
    }
  }

  // 에러 후 행동 패턴
  const sorted = [...events].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const postErrorActions = {};
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].type === 'tool.error') {
      const nextTool = sorted[i + 1].data?.toolName || sorted[i + 1].type;
      postErrorActions[nextTool] = (postErrorActions[nextTool] || 0) + 1;
    }
  }
  const topPostError = Object.entries(postErrorActions).sort((a, b) => b[1] - a[1])[0];
  if (topPostError && topPostError[1] >= 3) {
    triggers.push({
      type: 'error_response',
      condition: '에러 발생',
      action: topPostError[0],
      frequency: topPostError[1],
      description: `에러 후 주로 "${topPostError[0]}" 사용 (${topPostError[1]}회)`,
      automatable: false,
    });
  }

  // 시간대 트리거 (특정 시간에 특정 작업)
  const hourPurpose = {};
  for (const e of events) {
    const h = new Date(e.timestamp).getHours();
    const p = e.purposeId || 'unknown';
    const key = `${h}:${p}`;
    hourPurpose[key] = (hourPurpose[key] || 0) + 1;
  }
  const strongTimeTriggers = Object.entries(hourPurpose)
    .filter(([_, count]) => count >= 10)
    .map(([key, count]) => {
      const [hour, purpose] = key.split(':');
      return { hour: parseInt(hour), purpose, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  for (const tt of strongTimeTriggers) {
    triggers.push({
      type: 'time_trigger',
      condition: `${tt.hour}시`,
      action: tt.purpose,
      frequency: tt.count,
      description: `${tt.hour}시에 주로 "${tt.purpose}" 작업 (${tt.count}회)`,
      automatable: false,
    });
  }

  return triggers;
}


// ─── 4. AI 자동화 가능 영역 ──────────────────────────────
function identifyAutomationAreas(events, repetitive, capability) {
  const areas = [];
  const matchedSolutions = new Set();

  // 반복 명령어 → Python 자동화 / Git Hooks
  if (repetitive.automationCandidates?.length > 0) {
    const hasGitRepeat = repetitive.automationCandidates.some(c => /git/i.test(c.task));
    const hasGeneralRepeat = repetitive.automationCandidates.some(c => !/git/i.test(c.task));

    if (hasGitRepeat) {
      matchedSolutions.add('git-hooks');
      areas.push({
        area: 'Git 작업 자동화',
        description: '반복적인 Git 명령어를 hooks로 자동화',
        currentWaste: `주당 ~${repetitive.estimatedSavingsMinPerWeek}분`,
        solutions: ['git-hooks'],
        priority: 'high',
      });
    }
    if (hasGeneralRepeat) {
      matchedSolutions.add('python-automation');
      areas.push({
        area: '명령어 자동화',
        description: '반복 실행되는 명령어를 스크립트로 자동화',
        currentWaste: `주당 ~${Math.round(repetitive.estimatedSavingsMinPerWeek * 0.7)}분`,
        solutions: ['python-automation'],
        priority: 'medium',
      });
    }
  }

  // 배포 패턴 → CI/CD
  const deployEvents = events.filter(e => e.purposeId === 'deploy');
  if (deployEvents.length > 10) {
    matchedSolutions.add('ci-cd-pipeline');
    areas.push({
      area: '배포 자동화',
      description: `${deployEvents.length}건의 수동 배포를 CI/CD로 자동화`,
      currentWaste: `배포당 ~15분 절약 가능`,
      solutions: ['ci-cd-pipeline'],
      priority: 'high',
    });
  }

  // 테스트 빈도 → 자동 테스트
  const testEvents = events.filter(e => e.purposeId === 'test');
  const errorEvents = events.filter(e => e.type === 'tool.error');
  if (errorEvents.length > 20 && testEvents.length < errorEvents.length * 0.3) {
    matchedSolutions.add('ci-cd-pipeline');
    areas.push({
      area: '자동 테스트 강화',
      description: `에러 ${errorEvents.length}건 대비 테스트 ${testEvents.length}건 — 테스트 커버리지 부족`,
      currentWaste: '디버깅 시간 대폭 감소 가능',
      solutions: ['ci-cd-pipeline'],
      priority: 'high',
    });
  }

  // 연구/분석 비중 높음 → Claude API
  const researchEvents = events.filter(e => e.purposeId === 'research');
  if (researchEvents.length > events.length * 0.2) {
    matchedSolutions.add('claude-api-integration');
    areas.push({
      area: 'AI 기반 리서치',
      description: '조사/분석 작업을 Claude API로 가속',
      currentWaste: `전체 작업의 ${Math.round(researchEvents.length / events.length * 100)}%가 조사`,
      solutions: ['claude-api-integration'],
      priority: 'medium',
    });
  }

  // 솔루션 상세 매핑
  const recommendations = AI_SOLUTION_CATALOG
    .filter(s => matchedSolutions.has(s.id))
    .map(s => ({
      ...s,
      matchReason: areas.find(a => a.solutions.includes(s.id))?.area || '',
    }));

  return { areas, recommendations, totalSolutions: recommendations.length };
}


// ─── 5. 학습 데이터 시트 ──────────────────────────────────
function compileLearningSheet(events, routines, triggers, automationAreas, capability) {
  const entries = [];

  // 기본 프로필 정보
  entries.push({
    category: 'profile',
    key: '총 이벤트',
    value: String(events.length),
    insight: events.length > 1000 ? '충분한 데이터로 정확한 분석 가능' : '더 많은 데이터 수집 시 정확도 향상',
  });

  entries.push({
    category: 'profile',
    key: '활동 기간',
    value: calcActivePeriod(events),
    insight: '',
  });

  entries.push({
    category: 'profile',
    key: '작업 스타일',
    value: capability.workStyle?.type || '분석 중',
    insight: '',
  });

  // 루틴 데이터
  for (const r of routines) {
    entries.push({
      category: 'routine',
      key: r.type === 'weekly' ? `${r.day}요일 패턴` : r.type === 'peak' ? '피크 타임' : '일일 패턴',
      value: r.description,
      insight: r.confidence > 0.7 ? '강한 패턴' : '약한 패턴',
    });
  }

  // 트리거 데이터
  for (const t of triggers) {
    entries.push({
      category: 'trigger',
      key: t.type,
      value: t.description,
      insight: t.automatable ? '자동화 가능' : '수동 패턴',
    });
  }

  // 역량 데이터
  for (const s of (capability.skills || []).slice(0, 10)) {
    entries.push({
      category: 'skill',
      key: s.name,
      value: `${s.level} (사용 ${s.usage}회)`,
      insight: s.category,
    });
  }

  // 자동화 추천
  for (const a of (automationAreas.areas || [])) {
    entries.push({
      category: 'automation',
      key: a.area,
      value: a.currentWaste,
      insight: `우선순위: ${a.priority}`,
    });
  }

  // 반복작업 상세 (automationAreas 있을 경우)
  const repWork = (automationAreas?.areas || automationAreas) || [];
  for (const area of repWork.slice(0, 5)) {
    if (area.description || area.type) {
      entries.push({
        category: '반복작업',
        key: area.description || area.type,
        value: area.estimatedTimeSavedMin ? `주 ${area.estimatedTimeSavedMin}분 절약 가능` : '절약 가능',
        insight: area.automationScript || '자동화 스크립트 작성 권장',
      });
    }
  }

  return entries;
}

function calcActivePeriod(events) {
  if (!events?.length) return '0일';
  const dates = events.map(e => new Date(e.timestamp)).filter(d => !isNaN(d)).sort((a, b) => a - b);
  if (dates.length < 2) return '1일';
  const days = Math.ceil((dates[dates.length - 1] - dates[0]) / 86400000);
  return days > 30 ? `${Math.round(days / 30)}개월` : `${days}일`;
}


// ─── 6. 맞춤 추천 생성 (마켓플레이스 연결) ──────────────
/**
 * 학습 결과 기반 마켓플레이스 솔루션 추천
 * @param {Object} learningProfile
 * @returns {{ recommendations, totalSavingsPerWeek }}
 */
function generatePersonalRecommendations(learningProfile) {
  const { automationAreas, routines, triggers, patterns, learningData } = learningProfile;
  const profile = { patterns, triggers, automationAreas: automationAreas?.areas, learningData, routines };
  const recommendations = (automationAreas?.recommendations || []).map(sol => ({
    ...sol,
    personalFit: calculatePersonalFit(sol, profile),
    estimatedSavingsPerWeek: _estimateSavingsFromData(sol, profile),
  }));

  recommendations.sort((a, b) => b.personalFit - a.personalFit);

  const totalSavingsPerWeek = recommendations.reduce((s, r) => s + r.estimatedSavingsPerWeek, 0);

  return { recommendations, totalSavingsPerWeek };
}

function calculatePersonalFit(solution, profile) {
  const { patterns, triggers, automationAreas, learningData } = profile;

  let fit = 40;

  // 1. 트리거 매칭
  const matchedTriggers = (triggers || []).filter(t =>
    (solution.trigger_keywords || solution.tags || []).some(k =>
      (t.trigger || t.action || '').toLowerCase().includes(k.toLowerCase())
    )
  );
  fit += Math.min(matchedTriggers.length * 12, 24);

  // 2. 반복 패턴 강도
  const strongRoutines = (patterns?.weeklyPatterns || []).filter(p => (p.intensity || 0) > 60);
  if (strongRoutines.length >= 3) fit += 15;
  else if (strongRoutines.length >= 1) fit += 8;

  // 3. 자동화 영역 일치
  const matchedAreas = (automationAreas || []).filter(a =>
    (solution.tags || []).some(tag =>
      (a.type || '').includes(tag) || (a.description || '').toLowerCase().includes((solution.name || '').toLowerCase())
    )
  );
  fit += Math.min(matchedAreas.length * 8, 16);

  // 4. 데이터 풍부도
  const dataEntries = (learningData || []).length;
  if (dataEntries >= 20) fit += 5;

  // 5. 난이도 조정
  if (solution.difficulty === 'hard' && dataEntries < 10) fit -= 10;
  if (solution.difficulty === 'easy') fit += 5;

  return Math.min(Math.max(Math.round(fit), 0), 100);
}

function _estimateSavingsFromData(solution, profile) {
  const matchedArea = (profile.automationAreas || []).find(a =>
    (solution.tags || []).some(tag => (a.type || '').includes(tag))
  );
  if (matchedArea?.estimatedTimeSavedMin) {
    const base = solution.estimatedSavingsPerWeek || 60;
    const dataRatio = Math.min((matchedArea.estimatedTimeSavedMin * 4) / base, 2.0); // 주간 환산
    return Math.round(base * Math.max(dataRatio, 0.5));
  }
  return solution.estimatedSavingsPerWeek || 60;
}


// ─── Export ──────────────────────────────────────────────
module.exports = {
  buildLearningProfile,
  generatePersonalRecommendations,
  AI_SOLUTION_CATALOG,
};
