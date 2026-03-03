/**
 * activity-scorer.test.js
 * TDD: 활동 점수 계산 + 게임 효과 분류 로직 테스트
 * 구현 전 실패하는 테스트 먼저 작성
 */

const { computeActivityScores, classifyGlowTier, getEffectConfig } = require('../../src/game-effects.js');

// ── 활동 점수 계산 ──────────────────────────────────────
describe('computeActivityScores', () => {
  const makeNode = (overrides = {}) => ({
    id: 'n1',
    type: 'file',
    lastActiveAt: new Date().toISOString(),
    accessCount: 1,
    activityScore: 0,
    ...overrides,
  });

  test('방금 활성화된 노드는 점수 0.7 이상', () => {
    const nodes = [makeNode({ lastActiveAt: new Date().toISOString() })];
    computeActivityScores(nodes, Date.now());
    expect(nodes[0].activityScore).toBeGreaterThanOrEqual(0.7);
  });

  test('1시간 전 노드는 점수 0.1 미만', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const nodes = [makeNode({ lastActiveAt: oneHourAgo })];
    computeActivityScores(nodes, Date.now());
    expect(nodes[0].activityScore).toBeLessThan(0.1);
  });

  test('accessCount 높을수록 점수 보정 추가', () => {
    const now = new Date().toISOString();
    const lowFreq = makeNode({ lastActiveAt: now, accessCount: 1 });
    const highFreq = makeNode({ id: 'n2', lastActiveAt: now, accessCount: 20 });
    computeActivityScores([lowFreq, highFreq], Date.now());
    expect(highFreq.activityScore).toBeGreaterThan(lowFreq.activityScore);
  });

  test('점수는 항상 0~1 범위', () => {
    const nodes = [
      makeNode({ lastActiveAt: new Date().toISOString(), accessCount: 999 }),
    ];
    computeActivityScores(nodes, Date.now());
    expect(nodes[0].activityScore).toBeGreaterThanOrEqual(0);
    expect(nodes[0].activityScore).toBeLessThanOrEqual(1);
  });

  test('여러 노드 동시 계산', () => {
    const now = Date.now();
    const nodes = [
      makeNode({ id: 'n1', lastActiveAt: new Date(now).toISOString() }),
      makeNode({ id: 'n2', lastActiveAt: new Date(now - 120000).toISOString() }),
      makeNode({ id: 'n3', lastActiveAt: new Date(now - 600000).toISOString() }),
    ];
    computeActivityScores(nodes, now);
    // 최신 > 2분전 > 10분전
    expect(nodes[0].activityScore).toBeGreaterThan(nodes[1].activityScore);
    expect(nodes[1].activityScore).toBeGreaterThan(nodes[2].activityScore);
  });
});

// ── 글로우 티어 분류 ──────────────────────────────────────
describe('classifyGlowTier', () => {
  test('score 0.8+ → BLAZING 티어', () => {
    expect(classifyGlowTier(0.85)).toBe('BLAZING');
  });

  test('score 0.5~0.8 → HOT 티어', () => {
    expect(classifyGlowTier(0.65)).toBe('HOT');
  });

  test('score 0.2~0.5 → WARM 티어', () => {
    expect(classifyGlowTier(0.35)).toBe('WARM');
  });

  test('score 0.2 미만 → COOL 티어', () => {
    expect(classifyGlowTier(0.1)).toBe('COOL');
  });

  test('score 0 → COOL 티어', () => {
    expect(classifyGlowTier(0)).toBe('COOL');
  });

  test('경계값: 0.8 정확히 → BLAZING', () => {
    expect(classifyGlowTier(0.8)).toBe('BLAZING');
  });

  test('경계값: 0.5 정확히 → HOT', () => {
    expect(classifyGlowTier(0.5)).toBe('HOT');
  });
});

// ── 이펙트 설정 반환 ──────────────────────────────────────
describe('getEffectConfig', () => {
  test('BLAZING 티어 → 파티클 수 50개 이상', () => {
    const cfg = getEffectConfig('BLAZING');
    expect(cfg.particleCount).toBeGreaterThanOrEqual(50);
  });

  test('COOL 티어 → 파티클 없음', () => {
    const cfg = getEffectConfig('COOL');
    expect(cfg.particleCount).toBe(0);
  });

  test('HOT 티어 → glowColor 존재', () => {
    const cfg = getEffectConfig('HOT');
    expect(cfg.glowColor).toBeDefined();
    expect(cfg.glowColor).toMatch(/^#[0-9a-fA-F]{6}/);
  });

  test('모든 티어에 pulseSpeed 존재', () => {
    ['BLAZING', 'HOT', 'WARM', 'COOL'].forEach(tier => {
      const cfg = getEffectConfig(tier);
      expect(cfg.pulseSpeed).toBeDefined();
      expect(typeof cfg.pulseSpeed).toBe('number');
    });
  });

  test('BLAZING → borderWidth HOT보다 큼', () => {
    const blazing = getEffectConfig('BLAZING');
    const hot = getEffectConfig('HOT');
    expect(blazing.borderWidth).toBeGreaterThan(hot.borderWidth);
  });

  test('알 수 없는 티어 → 기본값 반환', () => {
    const cfg = getEffectConfig('UNKNOWN');
    expect(cfg).toBeDefined();
    expect(cfg.particleCount).toBe(0);
  });
});
