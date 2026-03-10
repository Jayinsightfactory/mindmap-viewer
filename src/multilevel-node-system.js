/**
 * 다계층 노드 시스템 (Multi-Level Node System)
 *
 * ASCII 계획에 따른 6단계 드릴다운 구조:
 * Level 0: Compact View (~7개 프로젝트, 반지름 10-20px, 180°)
 * Level 1: Personal (~15개 개인/세션, 반지름 32-52px, 324°)
 * Level 2: Team (~25개 팀, 반지름 43-63px, 396°, 다이아몬드 ♦)
 * Level 3: Collaboration (~35개 협업, 반지름 55-75px, 468°, 큰 다이아몬드 ◆)
 * Level 4: Department (~45개 부서, 반지름 70-90px, 540°, 별 ★)
 * Level 5: Universe (~60개 생태계, 반지름 92-112px, 612°, 원 ●)
 */

const MULTILEVEL_CONFIG = {
  levels: {
    0: {
      name: 'Compact',
      nodeCount: 7,
      radiusMin: 10,
      radiusMax: 20,
      angleRange: 180,        // 반지름 180도
      shape: 'circle',        // ◉
      spacing: 'semicircle'
    },
    1: {
      name: 'Personal',
      nodeCount: 15,
      radiusMin: 32,
      radiusMax: 52,
      angleRange: 324,        // 거의 전체
      shape: 'circle',        // ◉
      spacing: 'circular'
    },
    2: {
      name: 'Team',
      nodeCount: 25,
      radiusMin: 43,
      radiusMax: 63,
      angleRange: 396,        // 360 + 36도 (겹침)
      shape: 'diamond',       // ♦
      spacing: 'circular'
    },
    3: {
      name: 'Collaboration',
      nodeCount: 35,
      radiusMin: 55,
      radiusMax: 75,
      angleRange: 468,        // 360 + 108도
      shape: 'diamond',       // ◆ (larger)
      spacing: 'circular'
    },
    4: {
      name: 'Department',
      nodeCount: 45,
      radiusMin: 70,
      radiusMax: 90,
      angleRange: 540,        // 360 + 180도
      shape: 'star',          // ★
      spacing: 'circular'
    },
    5: {
      name: 'Universe',
      nodeCount: 60,
      radiusMin: 92,
      radiusMax: 112,
      angleRange: 612,        // 360 + 252도
      shape: 'circle',        // ●
      spacing: 'circular'
    }
  },

  // 색상 시스템 (HSL 기반)
  domainColors: {
    'Engineer': { h: 240, s: 80, l: 63 },      // 파란색
    'Designer': { h: 0, s: 80, l: 63 },        // 빨간색
    'Manager': { h: 60, s: 80, l: 63 },        // 노란색
    'DataScientist': { h: 120, s: 80, l: 63 }, // 초록색
    'Product': { h: 270, s: 80, l: 63 }        // 보라색
  },

  // 밝기 (Lightness) - 협업 강도에 따라
  brightnessRanges: {
    low: 35,      // 활동 낮음 (30-40%)
    medium: 55,   // 활동 보통 (50-60%)
    high: 75      // 활동 높음 (70-80%)
  }
};

/**
 * 현재 드릴 레벨에 따른 노드 위치 계산
 * @param {number} level - 드릴 레벨 (0-5)
 * @param {number} nodeIndex - 노드 인덱스 (0부터)
 * @param {Object} centerPos - 중심 위치 {x, y, z}
 * @returns {Object} {x, y, z, radius, angle}
 */
function calculateNodePosition(level, nodeIndex, centerPos = {x: 0, y: 0, z: 0}) {
  const config = MULTILEVEL_CONFIG.levels[level];
  if (!config) return centerPos;

  const nodeCount = config.nodeCount;

  // 반지름 (여러 노드가 같은 거리에 있을 수 있음)
  const radiusVariation = (config.radiusMax - config.radiusMin) / Math.max(nodeCount - 1, 1);
  const radius = config.radiusMin + (nodeIndex % nodeCount) * radiusVariation;

  // 각도 배치
  let angle;
  if (config.spacing === 'semicircle') {
    // Level 0: 반지름만 사용 (위에서 아래로 180도)
    angle = (nodeIndex / nodeCount) * 180 - 90; // -90 ~ 90도
  } else {
    // 원형 배치: angleRange만큼 나눔
    const angleStep = config.angleRange / nodeCount;
    angle = (nodeIndex * angleStep) - (config.angleRange / 2);
  }

  // 3D 위치 계산
  const angleRad = angle * Math.PI / 180;
  const x = centerPos.x + Math.cos(angleRad) * radius;
  const y = centerPos.y + (level === 0 ?
    (nodeIndex / nodeCount) * (config.radiusMax - config.radiusMin) - config.radiusMin :
    0);
  const z = centerPos.z + Math.sin(angleRad) * radius;

  return {
    x, y, z,
    radius,
    angle,
    level,
    index: nodeIndex
  };
}

/**
 * 노드 데이터 생성 (더미 데이터 포함)
 * @param {number} level - 드릴 레벨
 * @param {Object} parentNode - 부모 노드 (드릴다운된 경우)
 * @returns {Array} 노드 배열
 */
function generateNodesForLevel(level, parentNode = null) {
  const config = MULTILEVEL_CONFIG.levels[level];
  const nodes = [];

  // 실제 데이터가 있으면 사용, 없으면 더미 데이터 생성
  const nodeCount = config.nodeCount;

  for (let i = 0; i < nodeCount; i++) {
    const position = calculateNodePosition(level, i);

    // 도메인 결정 (로드 밸런싱)
    const domains = Object.keys(MULTILEVEL_CONFIG.domainColors);
    const domain = domains[i % domains.length];
    const domainColor = MULTILEVEL_CONFIG.domainColors[domain];

    // 협업 강도 (0-1 범위)
    const collaborationStrength = Math.random() * 0.5 + 0.5;
    const brightness =
      collaborationStrength < 0.4 ? MULTILEVEL_CONFIG.brightnessRanges.low :
      collaborationStrength < 0.7 ? MULTILEVEL_CONFIG.brightnessRanges.medium :
      MULTILEVEL_CONFIG.brightnessRanges.high;

    nodes.push({
      id: `${level}-${i}`,
      level,
      index: i,
      name: generateNodeName(level, i, domain),
      domain,
      color: `hsl(${domainColor.h}, ${domainColor.s}%, ${brightness}%)`,
      shape: config.shape,
      position,
      size: calculateNodeSize(level),
      collaborationStrength,
      brightness,
      children: null,
      parent: parentNode ? parentNode.id : null
    });
  }

  return nodes;
}

/**
 * 레벨별 노드 이름 생성
 */
function generateNodeName(level, index, domain) {
  const levelNames = {
    0: `Project ${String.fromCharCode(65 + index)}`,
    1: `${domain} ${index + 1}`,
    2: `Team ${index + 1}`,
    3: `Collab ${index + 1}`,
    4: `Dept ${index + 1}`,
    5: `Node ${index + 1}`
  };
  return levelNames[level] || `Node ${index}`;
}

/**
 * 레벨별 노드 크기 계산
 */
function calculateNodeSize(level) {
  const sizes = {
    0: 0.8,   // 작은 프로젝트 노드
    1: 1.0,   // 개인 노드
    2: 1.2,   // 팀 노드
    3: 1.5,   // 협업 노드
    4: 2.0,   // 부서 노드
    5: 2.5    // 우주 노드
  };
  return sizes[level] || 1.0;
}

/**
 * 드릴다운 애니메이션 계산
 * 현재 레벨에서 다음 레벨로 확장할 때 사용
 * @param {Array} currentNodes - 현재 노드 배열
 * @param {Array} nextNodes - 다음 레벨 노드 배열
 * @returns {Object} 애니메이션 정보
 */
function calculateDrillDownAnimation(currentNodes, nextNodes, selectedNodeIndex) {
  const currentConfig = MULTILEVEL_CONFIG.levels[currentNodes[0].level];
  const nextConfig = MULTILEVEL_CONFIG.levels[nextNodes[0].level];

  return {
    duration: 600, // ms
    radiusExpansion: nextConfig.radiusMax / currentConfig.radiusMax,
    angleExpansion: nextConfig.angleRange / currentConfig.angleRange,
    selectedNode: selectedNodeIndex,
    // 현재 선택된 노드 기준으로 회전
    rotationBias: selectedNodeIndex
  };
}

/**
 * 노드 연결선 생성 (부모-자식 관계)
 * @param {Array} parentNodes - 부모 노드 배열
 * @param {Array} childNodes - 자식 노드 배열
 * @returns {Array} 연결선 정보
 */
function generateConnectionLines(parentNodes, childNodes, selectedParentIndex = 0) {
  const lines = [];
  const selectedParent = parentNodes[selectedParentIndex];

  // 선택된 부모와 모든 자식을 연결
  childNodes.forEach((child, index) => {
    lines.push({
      from: selectedParent.position,
      to: child.position,
      strength: child.collaborationStrength,
      color: child.color,
      thickness: 1 + child.collaborationStrength * 3,
      dashed: child.collaborationStrength < 0.5
    });
  });

  return lines;
}

/**
 * 현재 노드에서 레벨 드릴다운
 * @param {Object} selectedNode - 선택된 노드
 * @param {number} targetLevel - 목표 레벨
 * @returns {Object} {nodes, animation}
 */
function drillToLevel(selectedNode, targetLevel) {
  // 선택된 노드 기준으로 다음 레벨 생성
  const nextNodes = generateNodesForLevel(targetLevel, selectedNode);

  // 현재 레벨에서 이 노드로 인접한 노드들 (애니메이션 계산용)
  const currentLevel = selectedNode.level;
  const currentNodes = generateNodesForLevel(currentLevel);

  const animation = calculateDrillDownAnimation(
    currentNodes,
    nextNodes,
    selectedNode.index
  );

  return {
    nodes: nextNodes,
    animation,
    selectedParent: selectedNode
  };
}

/**
 * 상위 레벨로 돌아가기
 * @param {Object} currentNode - 현재 레벨의 노드들
 * @returns {Array} 상위 레벨 노드
 */
function drillUp(currentLevel) {
  if (currentLevel === 0) return generateNodesForLevel(0);
  return generateNodesForLevel(currentLevel - 1);
}

/**
 * 초기 레벨 0 (Compact View) 생성
 */
function initializeCompactView() {
  return {
    level: 0,
    nodes: generateNodesForLevel(0),
    parent: null,
    canDrillUp: false,
    canDrillDown: true
  };
}

module.exports = {
  MULTILEVEL_CONFIG,
  calculateNodePosition,
  generateNodesForLevel,
  calculateDrillDownAnimation,
  generateConnectionLines,
  drillToLevel,
  drillUp,
  initializeCompactView
};
