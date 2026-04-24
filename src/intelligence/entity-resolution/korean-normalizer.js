'use strict';
/**
 * src/intelligence/entity-resolution/korean-normalizer.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 한국어 친화 정규화 유틸 — Customer/Person 매칭 공통.
 *
 * 단위 테스트 가능한 순수 함수만. 외부 의존성 없음.
 *
 * 핵심 함수:
 *   normalizeName(s)           — 표시명 표준화 (법인 접미사·괄호·공백 제거)
 *   stripParticles(s)          — 조사 제거 (은/는/이/가/을/를/의/에서/로/으로/와/과/에)
 *   tokenize(s, opts)          — n-gram 또는 word 토큰화
 *   levenshtein(a, b)          — 거리 (짧은 문자열용)
 *   scoreSimilarity(a, b)      — 0.0~1.0 종합 점수
 *   findCandidates(text, golden) — 텍스트 안에서 골든 후보 찾기 (substring 우선)
 * ─────────────────────────────────────────────────────────────────────────────
 */

// 한국어 법인/조직 접미사 (정렬 길이 내림차순 — 긴 것부터 매칭)
const ORG_SUFFIXES = [
  '주식회사', '유한회사', '협동조합', '재단법인', '사단법인',
  '㈜', '㈐', '(주)', '(유)', '(재)', '(사)',
  'Corporation', 'Corp.', 'Corp', 'Co., Ltd.', 'Co.,Ltd.', 'Co.Ltd', 'Co.,Ltd', 'Co. Ltd', 'Co.Ltd.',
  'Limited', 'Ltd.', 'Ltd', 'Inc.', 'Inc', 'LLC', 'PLC',
];

// 한국어 조사
const PARTICLES = [
  '에서는', '으로는', '에게서', '로부터',
  '이라고', '라고는',
  '에서', '으로', '에게', '으로부터',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '나',
];

/** 모든 공백·특수문자(괄호/하이픈/점) 제거 + 소문자화 */
function _hardStrip(s) {
  return String(s || '').toLowerCase().replace(/[\s\-_.,/\\()[\]{}<>'"`!?@#$%^&*+=|~:;]/g, '');
}

/**
 * 법인 접미사 제거 + 양끝 공백/괄호 정리.
 * 예: "대명건설(주)" → "대명건설" / "Acme Co., Ltd." → "Acme"
 */
function stripOrgSuffix(s) {
  let t = String(s || '').trim();
  // 양 끝 괄호 제거 (이름 앞뒤 어떤 순서로 와도)
  for (let i = 0; i < 3; i++) {
    let changed = false;
    for (const suf of ORG_SUFFIXES) {
      const lower = t.toLowerCase();
      const sufLow = suf.toLowerCase();
      if (lower.endsWith(sufLow)) { t = t.slice(0, -suf.length).trim(); changed = true; }
      if (lower.startsWith(sufLow)) { t = t.slice(suf.length).trim(); changed = true; }
    }
    if (!changed) break;
  }
  return t.replace(/^[\s,()[\]{}]+|[\s,()[\]{}]+$/g, '');
}

/**
 * 한국어 조사 제거 (단어 끝). 보수적으로만 — 짧은 단어는 위험하니 길이 4+ 단어만.
 */
function stripParticles(s) {
  const t = String(s || '');
  if (t.length < 4) return t;
  for (const p of PARTICLES) {
    if (t.endsWith(p) && (t.length - p.length) >= 2) {
      return t.slice(0, -p.length);
    }
  }
  return t;
}

/**
 * 종합 정규화: 법인 접미사 제거 → 조사 제거 → 하드 스트립.
 * 매칭 키 비교용 ("대명건설(주)에서" / "(주)대명건설" / "대명건설" 모두 → "대명건설")
 */
function normalizeName(s) {
  return _hardStrip(stripParticles(stripOrgSuffix(s)));
}

/**
 * 단어 단위 토큰화. 한글/영문/숫자만 남김.
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  return String(s || '')
    .replace(/[^\u3131-\u318E\uAC00-\uD7A3a-zA-Z0-9]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

/**
 * Levenshtein 거리 (짧은 문자열에만 사용).
 */
function levenshtein(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

/**
 * 종합 유사도 (0.0~1.0).
 *  - 정규화 후 정확 일치 → 1.0
 *  - 한 쪽이 다른 쪽의 substring → 0.85
 *  - Levenshtein 기반 (max 길이 대비) → 0.0~0.8
 */
function scoreSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;
  if (na.length >= 2 && nb.length >= 2) {
    if (na.includes(nb) || nb.includes(na)) return 0.85;
  }
  const d = levenshtein(na, nb);
  const m = Math.max(na.length, nb.length);
  if (m === 0) return 0;
  const sim = 1 - (d / m);
  return Math.max(0, Math.min(0.8, sim));
}

/**
 * 큰 텍스트(클립보드/카톡 메시지) 안에서 골든 이름 후보 검색.
 * 단순 substring 기반 — 빠르고 false positive 적음.
 *
 * @param {string} text  검색 대상 텍스트
 * @param {Array<{id: string, normName: string, displayName: string}>} goldenIndex
 * @returns {Array<{id: string, displayName: string, score: number, type: 'substring'}>}
 */
function findCandidates(text, goldenIndex) {
  const norm = normalizeName(text);
  if (!norm || norm.length < 2) return [];
  const hits = [];
  for (const g of goldenIndex) {
    if (g.normName.length < 2) continue;
    if (norm.includes(g.normName)) {
      // 짧은 골든명(2글자)은 false positive 위험 → 점수 낮춤
      const score = g.normName.length >= 3 ? 0.85 : 0.6;
      hits.push({ id: g.id, displayName: g.displayName, score, type: 'substring' });
    }
  }
  return hits;
}

module.exports = {
  normalizeName,
  stripOrgSuffix,
  stripParticles,
  tokenize,
  levenshtein,
  scoreSimilarity,
  findCandidates,
  ORG_SUFFIXES,
  PARTICLES,
};
