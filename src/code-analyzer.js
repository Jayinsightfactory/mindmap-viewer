/**
 * code-analyzer.js
 * 코드 효율 분석 에이전트 — SOLID 원칙 기반
 *
 * 사용:
 *   const { generateReport } = require('./code-analyzer');
 *   const report = generateReport(sourceCode, 'filename.js');
 *
 * SOLID 적용:
 *  - SRP: 각 함수가 하나의 분석 책임만 담당
 *  - OCP: ANALYZERS 배열로 분석기 추가/제거 가능 (코드 수정 불필요)
 *  - DIP: generateReport 는 추상 인터페이스(ANALYZERS)에 의존
 */

// ─── 복잡도 임계값 상수 ────────────────────────────
const COMPLEXITY_THRESHOLDS = {
  LOW:    5,   // 5 이하: 간단
  MEDIUM: 10,  // 10 이하: 보통
  HIGH:   20,  // 20 초과: 리팩토링 권장
};

const FUNCTION_LENGTH_THRESHOLD = 20; // 기본 함수 길이 임계값 (줄)

// ─── 1. 줄 수 카운트 (SRP: 줄 분류 책임) ──────────
/**
 * @param {string} source
 * @returns {{ total, code, blank, comment }}
 */
function countLines(source) {
  if (!source || source.trim() === '') {
    return { total: 0, code: 0, blank: 0, comment: 0 };
  }

  const lines = source.split('\n');
  let blank = 0, comment = 0, code = 0;
  let inBlockComment = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === '') {
      blank++;
      continue;
    }

    // 블록 주석 처리
    if (inBlockComment) {
      comment++;
      if (line.includes('*/')) inBlockComment = false;
      continue;
    }

    if (line.startsWith('/*')) {
      comment++;
      if (!line.includes('*/')) inBlockComment = true;
      continue;
    }

    if (line.startsWith('//')) {
      comment++;
      continue;
    }

    code++;
  }

  return { total: lines.length, code, blank, comment };
}

// ─── 2. Cyclomatic Complexity 측정 ─────────────────
// 분기점 키워드: if(else if 제외) / else if / for / while / case / && / || / ? (삼항)
/**
 * @param {string} source
 * @returns {number} Cyclomatic Complexity (최소 1)
 */
function measureCyclomaticComplexity(source) {
  if (!source) return 1;
  let complexity = 1; // 기본값

  // else if 먼저 카운트 후 제거 → if 단독 카운트와 중복 방지
  const withoutElseIf = source.replace(/\belse\s+if\s*\(/g, () => {
    complexity++;
    return 'ELSE_IF_REPLACED(';
  });

  // 나머지 단독 if
  const ifMatches = withoutElseIf.match(/\bif\s*\(/g);
  if (ifMatches) complexity += ifMatches.length;

  // for / while
  const forMatches = source.match(/\bfor\s*\(/g);
  if (forMatches) complexity += forMatches.length;
  const whileMatches = source.match(/\bwhile\s*\(/g);
  if (whileMatches) complexity += whileMatches.length;

  // case
  const caseMatches = source.match(/\bcase\s+[^:]+:/g);
  if (caseMatches) complexity += caseMatches.length;

  // 논리 연산자
  const andMatches = source.match(/&&/g);
  if (andMatches) complexity += andMatches.length;
  const orMatches = source.match(/\|\|/g);
  if (orMatches) complexity += orMatches.length;

  // 삼항 (nullish coalescence ?? 제외)
  const ternaryMatches = source.match(/\?(?!\?)/g);
  if (ternaryMatches) complexity += ternaryMatches.length;

  return complexity;
}

// ─── 3. 긴 함수 탐지 ──────────────────────────────
const FUNCTION_PATTERNS = [
  // function 선언
  /^(?:async\s+)?function\s+(\w+)\s*\(/,
  // const/let/var foo = (async) () =>
  /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[^=]+)\s*=>/,
  // const/let/var foo = function
  /^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
  // 메서드: name(...)
  /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/,
];

/**
 * @param {string} source
 * @param {{ threshold?: number }} options
 * @returns {Array<{ name, startLine, lines, complexity }>}
 */
function findLongFunctions(source, options = {}) {
  const threshold = options.threshold ?? FUNCTION_LENGTH_THRESHOLD;
  const lines = source.split('\n');
  const results = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // 함수 이름 추출
    let funcName = null;
    for (const pat of FUNCTION_PATTERNS) {
      const m = line.match(pat);
      if (m) { funcName = m[1] || 'anonymous'; break; }
    }

    if (funcName) {
      const startLine = i + 1;
      // 중괄호 매칭으로 함수 끝 찾기
      let depth = 0;
      let started = false;
      let j = i;

      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '{') { depth++; started = true; }
          if (ch === '}') depth--;
        }
        if (started && depth === 0) break;
        j++;
      }

      const funcLines = j - i + 1;
      if (funcLines > threshold) {
        results.push({
          name:       funcName,
          startLine,
          lines:      funcLines,
          complexity: measureCyclomaticComplexity(lines.slice(i, j + 1).join('\n')),
        });
      }
      i = j + 1;
    } else {
      i++;
    }
  }

  return results;
}

// ─── 4. 중복 패턴 탐지 ────────────────────────────
/**
 * 슬라이딩 윈도우(3줄 블록) 해시 기반 중복 탐지
 * @param {string} source
 * @param {{ minLines?: number }} options
 * @returns {Array<{ pattern, count, lines }>}
 */
function findDuplicatePatterns(source, options = {}) {
  const minLines = options.minLines ?? 3;
  const lines = source.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length < minLines * 2) return [];

  const blocks = new Map(); // normalized → { count, pattern, lines }

  for (let i = 0; i <= lines.length - minLines; i++) {
    const chunk = lines.slice(i, i + minLines);
    // 변수명 정규화 (공백 압축)
    const normalized = chunk.map(l => l.replace(/\s+/g, ' ')).join('\n');

    // 너무 짧은 블록(닫는 괄호만 등) 제외
    if (normalized.replace(/[{}();]/g, '').trim().length < 10) continue;

    if (!blocks.has(normalized)) {
      blocks.set(normalized, { count: 0, pattern: chunk.slice(0, 2).join(' ↵ '), lines: minLines });
    }
    blocks.get(normalized).count++;
  }

  return [...blocks.values()]
    .filter(b => b.count >= 2)
    .sort((a, b) => b.count - a.count);
}

// ─── 5. SOLID 위반 분석 ────────────────────────────
// OCP 패턴: 분석기를 배열로 관리 → 새 위반 추가 시 배열에만 추가

const SOLID_ANALYZERS = [
  // SRP: 파일이 300줄 이상이거나 함수가 50줄 이상
  {
    type: 'SRP',
    check(source) {
      const { total } = countLines(source);
      const longFns = findLongFunctions(source, { threshold: 50 });
      const issues = [];
      if (total > 300) {
        issues.push({ message: `파일이 ${total}줄 → 단일 책임 분리 검토`, severity: 'warn' });
      }
      longFns.forEach(fn => {
        issues.push({ message: `함수 '${fn.name}' ${fn.lines}줄 → 분리 권장`, severity: 'warn' });
      });
      return issues;
    },
  },

  // OCP: if-else 체인이 5개 이상
  {
    type: 'OCP',
    check(source) {
      const elseIfMatches = (source.match(/\belse\s+if\b/g) || []).length;
      if (elseIfMatches >= 4) { // else if 4개 = 총 5분기
        return [{ message: `else-if 체인 ${elseIfMatches + 1}개 → Strategy/Map 패턴 적용 검토`, severity: 'warn' }];
      }
      const caseMatches = (source.match(/\bcase\b/g) || []).length;
      if (caseMatches >= 5) {
        return [{ message: `switch case ${caseMatches}개 → 전략 패턴 적용 검토`, severity: 'info' }];
      }
      return [];
    },
  },

  // LSP: 서브클래스가 부모 메서드를 throw 로 막는 패턴
  {
    type: 'LSP',
    check(source) {
      if (/throw\s+new\s+Error\s*\(\s*['"`]Not\s+implemented/i.test(source)) {
        return [{ message: `'Not implemented' 예외 → LSP 위반 가능성`, severity: 'info' }];
      }
      return [];
    },
  },

  // ISP: 함수 파라미터가 5개 이상
  {
    type: 'ISP',
    check(source) {
      const issues = [];
      const fnMatches = [...source.matchAll(/function\s+(\w+)\s*\(([^)]{30,})\)/g)];
      for (const m of fnMatches) {
        const params = m[2].split(',').length;
        if (params >= 5) {
          issues.push({ message: `함수 '${m[1]}' 파라미터 ${params}개 → 객체 인자(options)로 묶기 권장`, severity: 'warn' });
        }
      }
      return issues;
    },
  },

  // DIP: new 직접 생성이 3회 이상
  {
    type: 'DIP',
    check(source) {
      const newMatches = (source.match(/\bnew\s+[A-Z]\w+/g) || []);
      if (newMatches.length >= 3) {
        const classes = [...new Set(newMatches.map(m => m.replace('new ', '')))];
        return [{ message: `직접 인스턴스화 ${newMatches.length}회 (${classes.slice(0, 3).join(', ')}…) → 의존성 주입 검토`, severity: 'warn' }];
      }
      return [];
    },
  },
];

/**
 * @param {string} source
 * @param {string} filename
 * @returns {{ violations: Array<{ type, message, severity }>, score: number }}
 */
function analyzeSolidViolations(source, filename = '') {
  const violations = [];

  for (const analyzer of SOLID_ANALYZERS) {
    const issues = analyzer.check(source);
    for (const issue of issues) {
      violations.push({ type: analyzer.type, file: filename, ...issue });
    }
  }

  // 점수: 위반당 warn=-15, info=-5, 최저 0
  const deduction = violations.reduce((sum, v) => sum + (v.severity === 'warn' ? 15 : 5), 0);
  const score = Math.max(0, 100 - deduction);

  return { violations, score };
}

// ─── 6. 종합 리포트 생성 ──────────────────────────
function calcGrade(complexity, solidScore, longFnCount, duplicateCount) {
  let pts = 100;
  // 복잡도
  if (complexity > COMPLEXITY_THRESHOLDS.HIGH) pts -= 30;
  else if (complexity > COMPLEXITY_THRESHOLDS.MEDIUM) pts -= 15;
  else if (complexity > COMPLEXITY_THRESHOLDS.LOW) pts -= 5;
  // SOLID 점수
  pts -= (100 - solidScore) * 0.3;
  // 긴 함수
  pts -= longFnCount * 8;
  // 중복
  pts -= duplicateCount * 5;

  if (pts >= 90) return 'A';
  if (pts >= 75) return 'B';
  if (pts >= 60) return 'C';
  if (pts >= 40) return 'D';
  return 'F';
}

/**
 * @param {string} source
 * @param {string} filename
 * @returns {{ file, lines, complexity, longFunctions, duplicates, solid, grade, summary }}
 */
function generateReport(source, filename = 'unknown') {
  const lines        = countLines(source);
  const complexity   = measureCyclomaticComplexity(source);
  const longFunctions = findLongFunctions(source);
  const duplicates   = findDuplicatePatterns(source);
  const solid        = analyzeSolidViolations(source, filename);
  const grade        = calcGrade(complexity, solid.score, longFunctions.length, duplicates.length);

  // 한 줄 요약
  const complexityLabel = complexity <= COMPLEXITY_THRESHOLDS.LOW    ? '간단'
                        : complexity <= COMPLEXITY_THRESHOLDS.MEDIUM ? '보통'
                        : complexity <= COMPLEXITY_THRESHOLDS.HIGH   ? '복잡'
                        : '매우 복잡';
  const summary = [
    `📄 ${filename}: ${lines.total}줄 (코드 ${lines.code}줄)`,
    `⚡ 복잡도 ${complexity} (${complexityLabel})`,
    longFunctions.length > 0 ? `⚠️  긴 함수 ${longFunctions.length}개` : null,
    duplicates.length > 0 ? `♻️  중복 패턴 ${duplicates.length}개` : null,
    solid.violations.length > 0 ? `🔴 SOLID 위반 ${solid.violations.length}개` : '✅ SOLID 양호',
    `📊 등급: ${grade}`,
  ].filter(Boolean).join('  |  ');

  return { file: filename, lines, complexity, longFunctions, duplicates, solid, grade, summary };
}

module.exports = {
  countLines,
  measureCyclomaticComplexity,
  findLongFunctions,
  findDuplicatePatterns,
  analyzeSolidViolations,
  generateReport,
  COMPLEXITY_THRESHOLDS,
};
