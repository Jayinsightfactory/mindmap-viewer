/**
 * game-effects.js
 * 마인드맵 노드 게임 효과 엔진
 *
 * 책임: 활동 점수 계산 + 글로우 티어 분류 + 이펙트 설정 반환
 * (Node.js 공유 모듈 — 서버와 브라우저 둘 다 require 가능하도록 설계)
 *
 * 글로우 티어:
 *   BLAZING (0.8+)  — 최고 활성, 네온 파티클 폭발
 *   HOT    (0.5~)   — 활성, 강한 펄스 글로우
 *   WARM   (0.2~)   — 약한 활성, 부드러운 글로우
 *   COOL   (0~)     — 비활성, 효과 없음
 */

// ─── 상수 ──────────────────────────────────────────────
const HALF_LIFE_MS = 5 * 60 * 1000;   // 5분 반감기
const DECAY = Math.LN2 / HALF_LIFE_MS; // 지수 감쇠 상수

const TIER = {
  BLAZING: 'BLAZING',
  HOT: 'HOT',
  WARM: 'WARM',
  COOL: 'COOL',
};

// 티어별 이펙트 설정
const EFFECT_CONFIGS = {
  [TIER.BLAZING]: {
    glowColor: '#ff6b35',        // 오렌지 네온
    glowSize: 28,
    borderWidth: 8,
    sizeMultiplier: 1.6,
    pulseSpeed: 0.8,             // 초/사이클 (빠를수록 빨리 깜빡)
    particleCount: 60,
    particleColor: '#ff6b35',
    particleLifeMs: 800,
    lightningEnabled: true,
    rippleEnabled: true,
  },
  [TIER.HOT]: {
    glowColor: '#f778ba',        // 핑크
    glowSize: 18,
    borderWidth: 5,
    sizeMultiplier: 1.4,
    pulseSpeed: 1.4,
    particleCount: 25,
    particleColor: '#f778ba',
    particleLifeMs: 600,
    lightningEnabled: false,
    rippleEnabled: true,
  },
  [TIER.WARM]: {
    glowColor: '#58a6ff',        // 파랑
    glowSize: 10,
    borderWidth: 3,
    sizeMultiplier: 1.15,
    pulseSpeed: 2.5,
    particleCount: 0,
    particleColor: '#58a6ff',
    particleLifeMs: 400,
    lightningEnabled: false,
    rippleEnabled: false,
  },
  [TIER.COOL]: {
    glowColor: '#30363d',
    glowSize: 0,
    borderWidth: 2,
    sizeMultiplier: 1.0,
    pulseSpeed: 0,
    particleCount: 0,
    particleColor: '#30363d',
    particleLifeMs: 0,
    lightningEnabled: false,
    rippleEnabled: false,
  },
};

// ─── 활동 점수 계산 ────────────────────────────────────
/**
 * 노드 배열의 activityScore를 제자리 업데이트
 * @param {Array} nodes  - { lastActiveAt, accessCount, activityScore, ... }
 * @param {number} nowMs - 기준 시각 (Date.now())
 */
function computeActivityScores(nodes, nowMs) {
  const now = nowMs || Date.now();
  for (const node of nodes) {
    const lastActive = new Date(node.lastActiveAt).getTime();
    const ageMs = Math.max(0, now - lastActive);

    // 지수 감쇠 기반 최근성 점수
    const recencyScore = Math.exp(-DECAY * ageMs);

    // 접근 빈도 보정 (log2 스케일, 최대 1.0)
    const count = Math.max(1, node.accessCount || 1);
    const frequencyScore = Math.min(1, Math.log2(count + 1) / 5);

    // 최근성 70% + 빈도 30%
    node.activityScore = Math.min(1, Math.max(0, recencyScore * 0.7 + frequencyScore * 0.3));
  }
}

// ─── 글로우 티어 분류 ──────────────────────────────────
/**
 * @param {number} score - 0~1
 * @returns {string} TIER 상수
 */
function classifyGlowTier(score) {
  if (score >= 0.8) return TIER.BLAZING;
  if (score >= 0.5) return TIER.HOT;
  if (score >= 0.2) return TIER.WARM;
  return TIER.COOL;
}

// ─── 이펙트 설정 반환 ──────────────────────────────────
/**
 * @param {string} tier - classifyGlowTier 반환값
 * @returns {object} 이펙트 설정
 */
function getEffectConfig(tier) {
  return EFFECT_CONFIGS[tier] || EFFECT_CONFIGS[TIER.COOL];
}

// ─── 노드에 게임 효과 적용 (vis.js 노드 업데이트용) ────
/**
 * computeActivityScores 이후 호출.
 * vis.js의 nodes.update() 에 넘길 업데이트 배열 반환
 * @param {Array} nodes
 * @returns {Array} vis.js update 배열 [{ id, color, borderWidth, size, shadow, ... }]
 */
function buildVisUpdates(nodes) {
  return nodes.map(node => {
    const score = node.activityScore || 0;
    const tier = classifyGlowTier(score);
    const cfg = getEffectConfig(tier);

    const baseSize = node._baseSize || node.size || 16;
    const newSize = Math.round(baseSize * cfg.sizeMultiplier);

    const update = {
      id: node.id,
      size: newSize,
      borderWidth: cfg.borderWidth,
      // vis.js shadow 설정
      shadow: cfg.glowSize > 0
        ? { enabled: true, color: cfg.glowColor + 'aa', size: cfg.glowSize, x: 0, y: 0 }
        : false,
      // 커스텀 메타 (파티클/라이트닝 판단용)
      _tier: tier,
      _effectCfg: cfg,
    };

    // BLAZING/HOT 은 테두리 색도 글로우색으로
    if (tier === TIER.BLAZING || tier === TIER.HOT) {
      update.color = {
        background: node.color?.background || '#8b949e',
        border: cfg.glowColor,
        highlight: {
          background: node.color?.background || '#8b949e',
          border: cfg.glowColor,
        },
      };
    }

    return update;
  });
}

// ─── 파티클 이벤트 생성 (브라우저 Canvas용 데이터 생성) ─
/**
 * 새 노드 생성 이벤트 시 파티클 버스트 데이터 반환
 * @param {{ x, y }} pos - 캔버스 좌표
 * @param {string} tier
 * @returns {Array<{x,y,vx,vy,life,color,radius}>} 파티클 초기 상태 배열
 */
function createParticleBurst(pos, tier) {
  const cfg = getEffectConfig(tier);
  const count = cfg.particleCount;
  const particles = [];

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const speed = 1.5 + Math.random() * 3;
    particles.push({
      x: pos.x,
      y: pos.y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,             // 1.0 → 0으로 감쇠
      decay: 0.018 + Math.random() * 0.012,
      color: cfg.particleColor,
      radius: 2 + Math.random() * 3,
    });
  }
  return particles;
}

// ─── 라이트닝 경로 생성 ────────────────────────────────
/**
 * 두 좌표 간 번개 경로 점 배열 반환
 * @param {{x,y}} from
 * @param {{x,y}} to
 * @param {number} segments
 * @returns {Array<{x,y}>}
 */
function createLightningPath(from, to, segments = 8) {
  const points = [{ x: from.x, y: from.y }];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const perpLen = Math.sqrt(dx * dx + dy * dy) * 0.25;

  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const mx = from.x + dx * t;
    const my = from.y + dy * t;
    // 수직 방향으로 랜덤 오프셋
    const offset = (Math.random() - 0.5) * perpLen;
    const nx = -dy / Math.sqrt(dx * dx + dy * dy);
    const ny = dx / Math.sqrt(dx * dx + dy * dy);
    points.push({ x: mx + nx * offset, y: my + ny * offset });
  }
  points.push({ x: to.x, y: to.y });
  return points;
}

module.exports = {
  TIER,
  EFFECT_CONFIGS,
  computeActivityScores,
  classifyGlowTier,
  getEffectConfig,
  buildVisUpdates,
  createParticleBurst,
  createLightningPath,
};
