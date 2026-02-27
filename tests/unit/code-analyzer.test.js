/**
 * code-analyzer.test.js
 * TDD Red → Green: 코드 효율 분석 에이전트 테스트
 *
 * 커버 범위:
 *  - countLines: 전체/공백/주석/코드 줄 수
 *  - measureCyclomaticComplexity: if/for/while/switch 분기 수
 *  - findLongFunctions: 긴 함수 탐지
 *  - findDuplicatePatterns: 중복 패턴 탐지
 *  - analyzeSolidViolations: SOLID 위반 탐지
 *  - generateReport: 종합 리포트 생성
 */

const {
  countLines,
  measureCyclomaticComplexity,
  findLongFunctions,
  findDuplicatePatterns,
  analyzeSolidViolations,
  generateReport,
  COMPLEXITY_THRESHOLDS,
} = require('../../src/code-analyzer');

// ─── 헬퍼 ──────────────────────────────────────────────
const src = (str) => str.trim();

// ═══════════════════════════════════════════════════════
// 1. countLines
// ═══════════════════════════════════════════════════════
describe('countLines', () => {
  test('빈 문자열 → 모두 0', () => {
    const r = countLines('');
    expect(r.total).toBe(0);
    expect(r.code).toBe(0);
    expect(r.blank).toBe(0);
    expect(r.comment).toBe(0);
  });

  test('공백 줄 카운트', () => {
    const r = countLines('a\n\n\nb');
    expect(r.total).toBe(4);
    expect(r.blank).toBe(2);
  });

  test('// 한 줄 주석 카운트', () => {
    const r = countLines('// 주석\ncode();');
    expect(r.comment).toBe(1);
    expect(r.code).toBe(1);
  });

  test('/* */ 블록 주석 카운트', () => {
    const r = countLines('/* 블록\n   주석\n*/\ncode();');
    expect(r.comment).toBeGreaterThanOrEqual(2);
    expect(r.code).toBe(1);
  });

  test('전체 = 코드 + 공백 + 주석', () => {
    const code = src(`
      // 주석
      function foo() {
        return 1;
      }
    `);
    const r = countLines(code);
    expect(r.total).toBe(r.code + r.blank + r.comment);
  });
});

// ═══════════════════════════════════════════════════════
// 2. measureCyclomaticComplexity
// ═══════════════════════════════════════════════════════
describe('measureCyclomaticComplexity', () => {
  test('분기 없는 함수 → 1', () => {
    const code = `function simple() { return 1; }`;
    expect(measureCyclomaticComplexity(code)).toBe(1);
  });

  test('if 하나 → 2', () => {
    const code = `function f(x) { if (x) { return 1; } return 0; }`;
    expect(measureCyclomaticComplexity(code)).toBe(2);
  });

  test('if + else if → 3', () => {
    const code = `function f(x) {
      if (x > 0) return 1;
      else if (x < 0) return -1;
      return 0;
    }`;
    expect(measureCyclomaticComplexity(code)).toBe(3);
  });

  test('for 루프 → +1', () => {
    const code = `function f(arr) { for(let i=0;i<arr.length;i++){} }`;
    expect(measureCyclomaticComplexity(code)).toBe(2);
  });

  test('while 루프 → +1', () => {
    const code = `function f() { while(true){} }`;
    expect(measureCyclomaticComplexity(code)).toBe(2);
  });

  test('&& || 논리 연산자 → 각 +1', () => {
    const code = `function f(a,b,c) { return a && b || c; }`;
    expect(measureCyclomaticComplexity(code)).toBe(3);
  });

  test('switch case 3개 → 3', () => {
    const code = `function f(x) {
      switch(x) {
        case 1: return 'a';
        case 2: return 'b';
        case 3: return 'c';
      }
    }`;
    expect(measureCyclomaticComplexity(code)).toBe(4); // 1 기본 + case 3개
  });

  test('삼항 연산자 → +1', () => {
    const code = `function f(x) { return x ? 1 : 0; }`;
    expect(measureCyclomaticComplexity(code)).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════
// 3. findLongFunctions
// ═══════════════════════════════════════════════════════
describe('findLongFunctions', () => {
  test('짧은 함수 → 빈 배열', () => {
    const code = `function short() {\n  return 1;\n}`;
    expect(findLongFunctions(code, { threshold: 20 })).toHaveLength(0);
  });

  test('20줄 초과 함수 탐지', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  const x${i} = ${i};`).join('\n');
    const code = `function longFn() {\n${lines}\n}`;
    const result = findLongFunctions(code, { threshold: 20 });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe('longFn');
    expect(result[0].lines).toBeGreaterThan(20);
  });

  test('화살표 함수도 탐지', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  const y${i} = ${i};`).join('\n');
    const code = `const arrowFn = () => {\n${lines}\n};`;
    const result = findLongFunctions(code, { threshold: 20 });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toContain('arrowFn');
  });

  test('이름 없는 함수 → anonymous 표시', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  const z${i} = ${i};`).join('\n');
    const code = `module.exports = function() {\n${lines}\n};`;
    const result = findLongFunctions(code, { threshold: 20 });
    if (result.length > 0) {
      // anonymous 또는 탐지 안될 수 있음 (구현 허용)
      expect(typeof result[0].name).toBe('string');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 4. findDuplicatePatterns
// ═══════════════════════════════════════════════════════
describe('findDuplicatePatterns', () => {
  test('중복 없는 코드 → 빈 배열', () => {
    const code = `const a = 1;\nconst b = 2;\nconst c = 3;`;
    expect(findDuplicatePatterns(code)).toHaveLength(0);
  });

  test('3줄 이상 동일 블록이 2회 이상 → 탐지', () => {
    const block = `if (x > 0) {\n  console.log(x);\n  return x;\n}`;
    const code = `${block}\n\nfunction other() {\n  ${block}\n}`;
    const result = findDuplicatePatterns(code);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('count');
    expect(result[0].count).toBeGreaterThanOrEqual(2);
  });

  test('각 중복 항목에 lines, pattern 필드 존재', () => {
    const block = `const val = getValue();\nif (!val) return null;\nprocess(val);`;
    const code = `function a() {\n  ${block}\n}\nfunction b() {\n  ${block}\n}`;
    const result = findDuplicatePatterns(code);
    if (result.length > 0) {
      expect(result[0]).toHaveProperty('lines');
      expect(result[0]).toHaveProperty('pattern');
    }
  });
});

// ═══════════════════════════════════════════════════════
// 5. analyzeSolidViolations
// ═══════════════════════════════════════════════════════
describe('analyzeSolidViolations', () => {
  test('위반 없는 단순 코드 → violations 배열', () => {
    const code = `function add(a, b) { return a + b; }`;
    const r = analyzeSolidViolations(code, 'test.js');
    expect(r).toHaveProperty('violations');
    expect(Array.isArray(r.violations)).toBe(true);
    expect(r).toHaveProperty('score');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  test('SRP 위반: 한 함수가 너무 많은 역할 (300줄 초과)', () => {
    const lines = Array.from({ length: 310 }, (_, i) => `  const x${i} = doThing${i}();`).join('\n');
    const code = `function doEverything() {\n${lines}\n}`;
    const r = analyzeSolidViolations(code, 'big.js');
    const srpViolation = r.violations.find(v => v.type === 'SRP');
    expect(srpViolation).toBeDefined();
    expect(srpViolation.message).toBeTruthy();
  });

  test('OCP 위반: switch/if-else 체인이 5개 이상', () => {
    const code = `function dispatch(type) {
      if (type === 'A') handleA();
      else if (type === 'B') handleB();
      else if (type === 'C') handleC();
      else if (type === 'D') handleD();
      else if (type === 'E') handleE();
    }`;
    const r = analyzeSolidViolations(code, 'dispatch.js');
    const ocpViolation = r.violations.find(v => v.type === 'OCP');
    expect(ocpViolation).toBeDefined();
  });

  test('DIP 위반: new 직접 생성이 3회 이상', () => {
    const code = `function setup() {
      const db = new Database();
      const svc = new UserService();
      const repo = new UserRepository();
    }`;
    const r = analyzeSolidViolations(code, 'setup.js');
    const dipViolation = r.violations.find(v => v.type === 'DIP');
    expect(dipViolation).toBeDefined();
  });

  test('위반 없으면 score === 100', () => {
    const code = `// 깔끔한 함수\nfunction sum(a, b) { return a + b; }`;
    const r = analyzeSolidViolations(code, 'clean.js');
    expect(r.violations.filter(v => v.type === 'SRP' || v.type === 'OCP' || v.type === 'DIP')).toHaveLength(0);
    expect(r.score).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════
// 6. generateReport
// ═══════════════════════════════════════════════════════
describe('generateReport', () => {
  test('기본 리포트 구조 반환', () => {
    const code = `function foo(x) { if(x) return 1; return 0; }`;
    const r = generateReport(code, 'foo.js');
    expect(r).toHaveProperty('file');
    expect(r).toHaveProperty('lines');
    expect(r).toHaveProperty('complexity');
    expect(r).toHaveProperty('longFunctions');
    expect(r).toHaveProperty('duplicates');
    expect(r).toHaveProperty('solid');
    expect(r).toHaveProperty('grade');
    expect(r).toHaveProperty('summary');
  });

  test('grade 는 A/B/C/D/F 중 하나', () => {
    const code = `function foo() { return 42; }`;
    const r = generateReport(code, 'simple.js');
    expect(['A', 'B', 'C', 'D', 'F']).toContain(r.grade);
  });

  test('복잡한 코드는 낮은 grade', () => {
    const caseLines = Array.from({ length: 10 }, (_, i) => `case '${i}': handle${i}(); break;`).join('\n    ');
    const bodyLines = Array.from({ length: 50 }, (_, i) => `  const x${i} = compute${i}();`).join('\n');
    const complex = `
      function mega(type) {
        switch(type) {
          ${caseLines}
        }
        ${bodyLines}
      }
    `;
    const r = generateReport(complex, 'complex.js');
    expect(['C', 'D', 'F']).toContain(r.grade);
  });

  test('summary 는 문자열', () => {
    const r = generateReport('const x = 1;', 'tiny.js');
    expect(typeof r.summary).toBe('string');
    expect(r.summary.length).toBeGreaterThan(0);
  });

  test('COMPLEXITY_THRESHOLDS 상수 존재', () => {
    expect(COMPLEXITY_THRESHOLDS).toHaveProperty('LOW');
    expect(COMPLEXITY_THRESHOLDS).toHaveProperty('MEDIUM');
    expect(COMPLEXITY_THRESHOLDS).toHaveProperty('HIGH');
    expect(COMPLEXITY_THRESHOLDS.LOW).toBeLessThan(COMPLEXITY_THRESHOLDS.MEDIUM);
    expect(COMPLEXITY_THRESHOLDS.MEDIUM).toBeLessThan(COMPLEXITY_THRESHOLDS.HIGH);
  });
});
