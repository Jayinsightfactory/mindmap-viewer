/**
 * purpose-classifier.js
 * 이벤트 스트림 → 목적(Purpose) 자동 분류
 *
 * "어떤 도구를 쓰든 같은 목적이면 하나의 뷰에 표시"
 *
 * 분류 전략:
 * 1. 사용자 메시지 키워드 분석 → 의도(intent) 추출
 * 2. 뒤따르는 도구 사용 패턴 분석 → 확인/보강
 * 3. 파일 경로 패턴 → 작업 도메인 추론
 * 4. 연속된 이벤트를 하나의 "Purpose 윈도우"로 묶음
 */

// ─── 목적 카테고리 정의 ─────────────────────────────
const PURPOSE_CATEGORIES = {
  IMPLEMENT:   { id: 'implement',   label: '기능 구현',    icon: '🛠',  color: '#3fb950', priority: 1 },
  FIX:         { id: 'fix',         label: '버그 수정',    icon: '🔧',  color: '#f85149', priority: 2 },
  REFACTOR:    { id: 'refactor',    label: '코드 정리',    icon: '♻️',  color: '#bc8cff', priority: 3 },
  TEST:        { id: 'test',        label: '테스트',       icon: '🧪',  color: '#ffa657', priority: 4 },
  DEPLOY:      { id: 'deploy',      label: '배포/운영',    icon: '🚀',  color: '#58a6ff', priority: 5 },
  RESEARCH:    { id: 'research',    label: '조사/분석',    icon: '🔍',  color: '#79c0ff', priority: 6 },
  CONFIG:      { id: 'config',      label: '설정/환경',    icon: '⚙️',  color: '#d29922', priority: 7 },
  REVIEW:      { id: 'review',      label: '검토/리뷰',    icon: '👁',  color: '#f778ba', priority: 8 },
  DISCUSS:     { id: 'discuss',     label: '논의/질문',    icon: '💬',  color: '#8b949e', priority: 9 },
  UNKNOWN:     { id: 'unknown',     label: '기타',         icon: '📌',  color: '#6b7280', priority: 99 },
};

// ─── 키워드 → 목적 매핑 ─────────────────────────────
const KEYWORD_RULES = [
  // 구현
  { re: /구현|만들|추가|개발|작성|create|implement|add|build|새로/ui, purpose: 'implement', weight: 3 },
  { re: /기능|feature|신규|신기능/ui,                                 purpose: 'implement', weight: 2 },
  // 수정/버그
  { re: /수정|고쳐|고치|버그|오류|에러|fix|bug|error|잘못/ui,         purpose: 'fix',       weight: 3 },
  { re: /안돼|안됨|작동|동작|실패|fail/ui,                            purpose: 'fix',       weight: 2 },
  // 리팩토링
  { re: /리팩|정리|개선|최적|refactor|optimize|clean|simplify/ui,    purpose: 'refactor',  weight: 3 },
  { re: /중복|분리|모듈|추상|extract/ui,                              purpose: 'refactor',  weight: 2 },
  // 테스트
  { re: /테스트|test|spec|검증|검사|verify|validate/ui,              purpose: 'test',      weight: 3 },
  // 배포
  { re: /배포|deploy|push|publish|release|운영|prod/ui,              purpose: 'deploy',    weight: 3 },
  { re: /커밋|commit|merge|PR|pull request/ui,                       purpose: 'deploy',    weight: 2 },
  // 조사/분석
  { re: /분석|조사|파악|확인|알아|찾아|search|analyze|investigate/ui, purpose: 'research',  weight: 2 },
  { re: /어떻게|왜|무엇|how|why|what/ui,                              purpose: 'research',  weight: 1 },
  // 설정
  { re: /설정|환경|config|setup|install|dependency|패키지/ui,        purpose: 'config',    weight: 3 },
  { re: /\.env|dotenv|환경변수/ui,                                    purpose: 'config',    weight: 3 },
  // 검토
  { re: /검토|리뷰|review|확인해|봐줘|체크/ui,                        purpose: 'review',    weight: 2 },
  // 논의
  { re: /설명|알려|뭐야|이게|어떤|explain|describe/ui,               purpose: 'discuss',   weight: 1 },
];

// ─── 도구 패턴 → 목적 신호 ──────────────────────────
const TOOL_SIGNALS = {
  Bash:      { deploy: 2, implement: 1, fix: 1 },
  Write:     { implement: 2, refactor: 1 },
  Edit:      { fix: 2, refactor: 2, implement: 1 },
  Read:      { research: 1, review: 1 },
  Grep:      { research: 2, fix: 1 },
  Glob:      { research: 1 },
  WebSearch: { research: 3 },
  WebFetch:  { research: 2 },
  Task:      { implement: 2 },
  TodoWrite: { implement: 1 },
};

// ─── 파일 경로 → 목적 신호 ──────────────────────────
const FILE_PATH_SIGNALS = [
  { re: /test|spec|__test__|\.test\./i,         purpose: 'test',      weight: 3 },
  { re: /deploy|ci|\.github|railway|docker/i,   purpose: 'deploy',    weight: 3 },
  { re: /config|\.env|settings|\.json$/i,       purpose: 'config',    weight: 2 },
  { re: /readme|\.md$/i,                        purpose: 'review',    weight: 1 },
];

// ─── 점수 계산 ──────────────────────────────────────
function scoreEvents(events) {
  const scores = {};
  for (const cat of Object.keys(PURPOSE_CATEGORIES)) {
    scores[cat.toLowerCase()] = 0;
  }

  for (const event of events) {
    // 1. 사용자 메시지 키워드 분석
    if (event.type === 'user.message') {
      const text = (event.data.content || event.data.contentPreview || '').toLowerCase();
      for (const rule of KEYWORD_RULES) {
        if (rule.re.test(text)) {
          scores[rule.purpose] = (scores[rule.purpose] || 0) + rule.weight * 2; // 사용자 의도 가중치 2배
        }
      }
    }

    // 2. 도구 패턴 신호
    if (event.type === 'tool.end' || event.type === 'tool.start') {
      const toolName = event.data.toolName || '';
      const signals = TOOL_SIGNALS[toolName] || {};
      for (const [purpose, weight] of Object.entries(signals)) {
        scores[purpose] = (scores[purpose] || 0) + weight;
      }

      // Bash 명령어 세분화
      if (toolName === 'Bash') {
        const cmd = String(event.data.inputPreview || event.data.input?.command || '');
        if (/git push|deploy|railway|heroku/i.test(cmd)) scores.deploy += 3;
        if (/npm test|jest|pytest|cargo test/i.test(cmd)) scores.test += 3;
        if (/git commit|git add/i.test(cmd)) scores.deploy += 1;
        if (/npm install|pip install/i.test(cmd)) scores.config += 2;
      }
    }

    // 3. 파일 경로 신호
    const filePath = event.data.filePath || event.data.files?.[0] || '';
    if (filePath) {
      for (const sig of FILE_PATH_SIGNALS) {
        if (sig.re.test(filePath)) {
          scores[sig.purpose] = (scores[sig.purpose] || 0) + sig.weight;
        }
      }
    }
  }

  return scores;
}

// ─── 최고 점수 목적 선택 ────────────────────────────
function pickTopPurpose(scores) {
  let best = 'unknown';
  let bestScore = 0;
  for (const [purpose, score] of Object.entries(scores)) {
    if (score > bestScore && PURPOSE_CATEGORIES[purpose.toUpperCase()]) {
      bestScore = score;
      best = purpose;
    }
  }
  return { purposeId: best, confidence: Math.min(bestScore / 10, 1.0) };
}

// ─── 목적 윈도우 분할 ───────────────────────────────
// 사용자 메시지가 새로 오면 새 목적 윈도우 시작
function splitIntoWindows(events) {
  const windows = [];
  let current = [];
  let windowStart = null;

  for (const event of events) {
    if (event.type === 'user.message' && current.length > 0) {
      windows.push({ events: current, startAt: windowStart });
      current = [];
      windowStart = null;
    }
    if (!windowStart) windowStart = event.timestamp;
    current.push(event);
  }
  if (current.length > 0) {
    windows.push({ events: current, startAt: windowStart });
  }
  return windows;
}

// ─── 이벤트 배열 → Purpose 분류 결과 ────────────────
/**
 * @param {Array} events - 정규화된 이벤트 배열
 * @returns {Array} purposes - [{ purposeId, label, icon, color, confidence, eventIds, startAt, endAt }]
 */
function classifyPurposes(events) {
  if (!events || events.length === 0) return [];

  const windows = splitIntoWindows(events);
  const purposes = [];

  for (const window of windows) {
    const scores = scoreEvents(window.events);
    const { purposeId, confidence } = pickTopPurpose(scores);
    const category = PURPOSE_CATEGORIES[purposeId.toUpperCase()] || PURPOSE_CATEGORIES.UNKNOWN;

    const lastEvent = window.events[window.events.length - 1];
    purposes.push({
      purposeId,
      label:      category.label,
      icon:       category.icon,
      color:      category.color,
      confidence: Math.round(confidence * 100) / 100,
      scores,
      eventIds:   window.events.map(e => e.id),
      startAt:    window.startAt || window.events[0]?.timestamp,
      endAt:      lastEvent?.timestamp,
    });
  }

  return purposes;
}

// ─── 이벤트에 purposeId 주입 ────────────────────────
/**
 * 각 이벤트 객체에 .purposeId, .purposeLabel, .purposeColor, .purposeIcon 주입
 * graph-engine.buildGraph() 전에 호출
 */
function annotateEventsWithPurpose(events) {
  const purposes = classifyPurposes(events);
  const eventPurposeMap = new Map();

  for (const p of purposes) {
    for (const eid of p.eventIds) {
      eventPurposeMap.set(eid, p);
    }
  }

  return events.map(event => {
    const p = eventPurposeMap.get(event.id);
    if (!p) return event;
    return {
      ...event,
      purposeId:    p.purposeId,
      purposeLabel: p.label,
      purposeColor: p.color,
      purposeIcon:  p.icon,
    };
  });
}

// ─── 채널/세션 단위 목적 요약 ────────────────────────
/**
 * 이벤트 배열로부터 목적별 집계 통계 반환
 * settings.html / dashboard.html 의 "AI 인사이트" 탭에서 사용
 */
function summarizePurposes(events) {
  const purposes = classifyPurposes(events);
  const stats = {};

  for (const p of purposes) {
    if (!stats[p.purposeId]) {
      stats[p.purposeId] = {
        purposeId:  p.purposeId,
        label:      p.label,
        icon:       p.icon,
        color:      p.color,
        count:      0,
        eventCount: 0,
        avgConfidence: 0,
      };
    }
    stats[p.purposeId].count++;
    stats[p.purposeId].eventCount += p.eventIds.length;
    stats[p.purposeId].avgConfidence += p.confidence;
  }

  // 평균 신뢰도 계산
  for (const s of Object.values(stats)) {
    s.avgConfidence = Math.round((s.avgConfidence / s.count) * 100) / 100;
  }

  return Object.values(stats).sort((a, b) => b.count - a.count);
}

module.exports = {
  PURPOSE_CATEGORIES,
  classifyPurposes,
  annotateEventsWithPurpose,
  summarizePurposes,
};
