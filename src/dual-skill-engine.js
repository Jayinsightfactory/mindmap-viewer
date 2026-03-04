/**
 * dual-skill-engine.js — 두 Ollama 모델 앙상블 분석 + 스킬/에이전트 자동 제안
 *
 * 흐름:
 * 1. 클라이언트에서 dual analysis 수신 (model1 + model2 결과)
 * 2. 앙상블 신뢰도 계산 (두 모델이 동의할수록 confidence↑)
 * 3. clientId별 패턴 누적 (카테고리 + 작업 유형별 빈도)
 * 4. 임계값 초과 + 자동화 가능 → 스킬/에이전트 제안 자동 생성
 * 5. WebSocket 브로드캐스트로 클라이언트에 즉시 알림
 */

'use strict';

const crypto = require('crypto');

// ── 패턴 누적 저장소 ──────────────────────────────────────────────────────────
// { clientId → { patternKey → PatternEntry } }
const _patternStore = new Map();

// ── 제안 저장소 ────────────────────────────────────────────────────────────────
// { clientId → [SkillSuggestion] }
const _suggestionStore = new Map();

// 패턴이 N번 반복되면 제안 생성
const PATTERN_THRESHOLD = 3;
// 최소 신뢰도 기준
const MIN_CONFIDENCE    = 0.60;

// ── 카테고리 → 스킬/에이전트 템플릿 매핑 ────────────────────────────────────
const CATEGORY_TEMPLATE = {
  refactor: { type: 'skill',  icon: '♻️',  triggerBase: '/refactor', desc: '코드 리팩토링 자동화' },
  bugfix:   { type: 'skill',  icon: '🐛',  triggerBase: '/fix',      desc: '버그 패턴 자동 감지 및 수정 제안' },
  feature:  { type: 'agent',  icon: '✨',  triggerBase: '/feature',  desc: '기능 구현 자동화 에이전트' },
  test:     { type: 'skill',  icon: '🧪',  triggerBase: '/test',     desc: '테스트 케이스 자동 생성' },
  docs:     { type: 'skill',  icon: '📝',  triggerBase: '/doc',      desc: '문서 자동 작성' },
  config:   { type: 'skill',  icon: '⚙️',  triggerBase: '/config',   desc: '설정 파일 최적화' },
  report:   { type: 'agent',  icon: '📊',  triggerBase: '/report',   desc: '보고서 자동 생성 에이전트' },
  browse:   { type: 'agent',  icon: '🔍',  triggerBase: '/research', desc: '웹 리서치 자동화 에이전트' },
  document: { type: 'skill',  icon: '📄',  triggerBase: '/draft',    desc: '문서 초안 자동 작성' },
  meeting:  { type: 'skill',  icon: '🤝',  triggerBase: '/meeting',  desc: '회의록 자동 요약' },
  analysis: { type: 'agent',  icon: '📈',  triggerBase: '/analyze',  desc: '데이터 분석 자동화 에이전트' },
  unknown:  { type: 'skill',  icon: '💡',  triggerBase: '/auto',     desc: '반복 작업 자동화' },
};

// ── 모델 추천 매핑 (카테고리별 최적 모델) ────────────────────────────────────
const CATEGORY_MODEL = {
  refactor: 'codellama',
  bugfix:   'codellama',
  feature:  'codellama',
  test:     'codellama',
  docs:     'llama3.2',
  config:   'llama3.2',
  report:   'llama3.2',
  browse:   'llama3.2',
  document: 'llama3.2',
  meeting:  'llama3.2',
  analysis: 'llama3.2',
  unknown:  'llama3.2',
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * 앙상블 신뢰도 계산
 * - 두 모델이 카테고리 동의 → +0.30
 * - 두 모델 모두 automatable → +0.20
 * - 패턴 키워드 유사도 → +0.10
 * - 기본 0.40 (단일 모델 결과만 있어도)
 */
function calcConfidence(primary, secondary) {
  if (!primary && !secondary) return 0;
  if (!primary || !secondary)  return 0.45;

  let score = 0.40;
  if (primary.category === secondary.category) score += 0.30;
  if (primary.automatable && secondary.automatable) score += 0.20;
  if (primary.pattern && secondary.pattern) {
    // 단순 키워드 오버랩
    const w1 = new Set((primary.pattern  || '').split(/\s+/));
    const w2 = new Set((secondary.pattern || '').split(/\s+/));
    const inter = [...w1].filter(w => w2.has(w) && w.length > 1).length;
    const union = new Set([...w1, ...w2]).size;
    if (union > 0) score += 0.10 * (inter / union);
  }
  return Math.min(Math.round(score * 100) / 100, 0.95);
}

/**
 * 최적 대표 분석 결과 선택 (신뢰도 높은 모델 우선)
 */
function mergeAnalysis(primary, secondary, confidence) {
  if (!primary && !secondary) return null;
  if (!primary) return secondary;
  if (!secondary) return primary;
  // 동의한 경우: 더 구체적인 suggestion 선택
  const suggestion = (primary.suggestion?.length || 0) >= (secondary.suggestion?.length || 0)
    ? primary.suggestion : secondary.suggestion;
  return {
    pattern:     primary.pattern || secondary.pattern,
    category:    confidence >= 0.70 ? primary.category : (primary.category || secondary.category),
    suggestion,
    automatable: primary.automatable && secondary.automatable,
    model1:      primary.model  || 'llama3.2',
    model2:      secondary.model || 'codellama',
    confidence,
  };
}

/**
 * 패턴 키 생성 (카테고리 + 파일 확장자 기반)
 */
function makePatternKey(category, ext, activityType) {
  const base = `${category}:${ext || 'any'}:${activityType || 'file'}`;
  return base.toLowerCase().replace(/[^a-z0-9:]/g, '_');
}

/**
 * 패턴 누적 처리 — 임계값 도달 시 제안 생성
 * @returns {SkillSuggestion|null} 새로 생성된 제안 (없으면 null)
 */
function accumulatePattern(insight, dualResult) {
  const { clientId, userName, ext, fileName, activityType } = insight;
  const { category, automatable, confidence } = dualResult;

  if (!clientId || confidence < MIN_CONFIDENCE) return null;

  // 클라이언트 패턴 맵 초기화
  if (!_patternStore.has(clientId)) _patternStore.set(clientId, new Map());
  const clientPatterns = _patternStore.get(clientId);

  const key = makePatternKey(category, ext, activityType);

  if (!clientPatterns.has(key)) {
    clientPatterns.set(key, {
      key, category, ext, activityType,
      count: 0, totalConfidence: 0,
      patterns: [],        // 분석 텍스트 샘플 (최대 5개)
      suggestions: [],     // 제안 텍스트 샘플
      fileNames: new Set(),
      lastSeen: null,
      alreadyProposed: false,
    });
  }

  const entry = clientPatterns.get(key);
  entry.count++;
  entry.totalConfidence += confidence;
  entry.lastSeen = Date.now();
  if (fileName) entry.fileNames.add(fileName);
  if (dualResult.pattern && entry.patterns.length < 5)     entry.patterns.push(dualResult.pattern);
  if (dualResult.suggestion && entry.suggestions.length < 5) entry.suggestions.push(dualResult.suggestion);

  // 임계값 도달 + 자동화 가능 + 아직 제안 안 함
  if (
    entry.count >= PATTERN_THRESHOLD &&
    automatable &&
    !entry.alreadyProposed &&
    (entry.totalConfidence / entry.count) >= MIN_CONFIDENCE
  ) {
    entry.alreadyProposed = true;
    return _buildSuggestion(clientId, userName, entry, dualResult);
  }

  return null;
}

/**
 * 스킬/에이전트 제안 객체 생성
 */
function _buildSuggestion(clientId, userName, entry, dualResult) {
  const tpl   = CATEGORY_TEMPLATE[entry.category] || CATEGORY_TEMPLATE.unknown;
  const model = CATEGORY_MODEL[entry.category]   || 'llama3.2';

  // 트리거 슬래시 커맨드 고유화 (카테고리 + ext)
  const extSlug = (entry.ext || '').replace('.', '') || 'all';
  const trigger = `${tpl.triggerBase}-${extSlug}`;

  // 시스템 프롬프트 자동 생성
  const samplePattern    = entry.patterns[0]   || `${entry.category} 작업 자동화`;
  const sampleSuggestion = entry.suggestions[0] || tpl.desc;

  let systemPrompt;
  if (tpl.type === 'skill') {
    systemPrompt = `당신은 ${samplePattern} 전문가입니다. 사용자의 ${entry.ext || '파일'} 변경을 분석하여 ${sampleSuggestion}을 제공합니다.`;
  } else {
    systemPrompt = `당신은 ${samplePattern} 자동화 에이전트입니다. 백그라운드에서 ${sampleSuggestion}을 실행합니다.`;
  }

  const suggestion = {
    id:          crypto.randomUUID(),
    clientId,
    userName,
    type:        tpl.type,           // 'skill' | 'agent'
    icon:        tpl.icon,
    alias:       `${samplePattern.slice(0, 20)}`,
    trigger,                          // '/refactor-js' 형태
    model,
    systemPrompt: systemPrompt.slice(0, 300),
    autoRun:     tpl.type === 'agent' && entry.category !== 'feature',
    evidence: {
      patternCount:  entry.count,
      avgConfidence: Math.round((entry.totalConfidence / entry.count) * 100) / 100,
      category:      entry.category,
      files:         [...entry.fileNames].slice(0, 5),
      activityType:  entry.activityType,
      patterns:      entry.patterns.slice(0, 2),
    },
    createdAt: Date.now(),
    accepted:  false,
  };

  // 저장
  if (!_suggestionStore.has(clientId)) _suggestionStore.set(clientId, []);
  const list = _suggestionStore.get(clientId);
  list.unshift(suggestion);
  if (list.length > 50) list.splice(50);

  console.log(`[DualSkillEngine] 🎯 새 제안 생성: [${clientId}] ${tpl.type} "${suggestion.alias}" (신뢰도 ${suggestion.evidence.avgConfidence})`);
  return suggestion;
}

/**
 * 클라이언트의 미수락 제안 목록 반환
 */
function getFeedback(clientId) {
  return (_suggestionStore.get(clientId) || []).filter(s => !s.accepted);
}

/**
 * 모든 클라이언트의 최근 제안 (대시보드용)
 */
function getAllSuggestions(limit = 50) {
  const all = [];
  for (const list of _suggestionStore.values()) all.push(...list);
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/**
 * 제안 수락 처리
 */
function acceptSuggestion(clientId, suggestionId) {
  const list = _suggestionStore.get(clientId);
  if (!list) return null;
  const s = list.find(s => s.id === suggestionId);
  if (s) { s.accepted = true; s.acceptedAt = Date.now(); }
  return s || null;
}

/**
 * 패턴 통계 반환 (클라이언트별)
 */
function getPatternStats(clientId) {
  const map = _patternStore.get(clientId);
  if (!map) return [];
  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map(e => ({
      key:          e.key,
      category:     e.category,
      activityType: e.activityType,
      count:        e.count,
      avgConf:      Math.round((e.totalConfidence / e.count) * 100) / 100,
      fileCount:    e.fileNames.size,
      proposed:     e.alreadyProposed,
      lastSeen:     e.lastSeen,
    }));
}

module.exports = {
  calcConfidence,
  mergeAnalysis,
  accumulatePattern,
  getFeedback,
  getAllSuggestions,
  acceptSuggestion,
  getPatternStats,
};
