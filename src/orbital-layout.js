/**
 * 궤도 레이아웃 시스템
 * 행성 궤도처럼 노드들을 배치
 */

/**
 * 도메인 행성의 기본 위치 계산
 * @param {string} domain - Operations, Analytics, Design, Admin
 * @param {number} orbitRadius - 궤도 반경 (기본 40)
 * @returns {Object} {x, y, z}
 */
function getPlanetPosition(domain, orbitRadius = 40) {
  const positions = {
    'Operations': { x: 0, y: orbitRadius, z: 0 },        // 상단
    'Analytics': { x: orbitRadius, y: 0, z: 0 },          // 우측
    'Design': { x: -orbitRadius, y: 0, z: 0 },            // 좌측
    'Development': { x: -orbitRadius, y: 0, z: 0 },       // 좌측 (Design과 동일)
    'Admin': { x: 0, y: -orbitRadius, z: 0 }              // 하단
  };
  return positions[domain] || { x: 0, y: 0, z: 0 };
}

/**
 * 행성 주변 위성(세부 노드) 배치
 * 원형으로 배치하되, 행성을 중심으로 작은 원을 만듦
 * @param {number} satelliteCount - 위성 개수
 * @param {Object} planetPos - 행성 위치
 * @param {number} moonRadius - 월 궤도 반경 (기본 8)
 * @returns {Array} [{ x, y, z }, ...]
 */
function getMoonPositions(satelliteCount, planetPos, moonRadius = 8) {
  const positions = [];
  const angleStep = (360 / satelliteCount) * (Math.PI / 180);

  for (let i = 0; i < satelliteCount; i++) {
    const angle = i * angleStep;
    const x = planetPos.x + Math.cos(angle) * moonRadius;
    const y = planetPos.y + Math.sin(angle) * moonRadius * 0.3; // 세로 압축
    const z = planetPos.z + Math.sin(angle) * moonRadius;

    positions.push({ x, y, z });
  }

  return positions;
}

/**
 * 사용자 정의 노드 배치 설정
 * @param {Object} node - 노드 데이터
 * @param {number} totalNodes - 같은 도메인의 총 노드 수
 * @param {number} nodeIndex - 이 노드의 인덱스 (0부터)
 * @returns {Object} 위치 설정
 */
function getNodePlacement(node, totalNodes, nodeIndex = 0) {
  // 도메인 행성의 위치
  const planetPos = getPlanetPosition(node.category);

  // 세부 노드는 행성 주변에 배치
  if (node.type === 'subdomain' || node.type === 'event') {
    const moons = getMoonPositions(totalNodes, planetPos);
    return moons[nodeIndex] || planetPos;
  }

  // 도메인 행성
  return planetPos;
}

/**
 * 궤도 애니메이션 설정
 * @param {Object} node - Three.js 객체
 * @param {Object} planetPos - 행성 위치
 * @param {number} orbitRadius - 공전 반경
 * @param {number} speed - 회전 속도 (초 단위)
 */
function setOrbitAnimation(node, planetPos, orbitRadius, speed = 20) {
  node.userData.orbit = {
    center: planetPos,
    radius: orbitRadius,
    speed: speed,
    startTime: Date.now()
  };
}

/**
 * 궤도 애니메이션 업데이트
 * @param {Object} node - Three.js 객체
 * @param {number} deltaTime - 경과 시간 (초)
 */
function updateOrbitPosition(node, deltaTime = 0) {
  const orbitData = node.userData.orbit;
  if (!orbitData) return;

  const angle = (deltaTime / orbitData.speed) * Math.PI * 2;
  const x = orbitData.center.x + Math.cos(angle) * orbitData.radius;
  const z = orbitData.center.z + Math.sin(angle) * orbitData.radius;

  node.position.set(x, orbitData.center.y, z);
}

/**
 * 도메인 행성과 세부 노드의 3D 레이아웃 생성
 * @param {Object} domainStats - aggregateByDomain 결과
 * @returns {Object} { planets: [...], moons: [...] }
 */
function generateOrbitalLayout(domainStats) {
  const layout = { planets: [], moons: [] };

  const domains = Object.entries(domainStats)
    .filter(([_, stats]) => stats.count > 0)
    .sort((a, b) => b[1].count - a[1].count);

  const domainColors = {
    'Operations': '#10b981',
    'Analytics': '#3b82f6',
    'Design': '#ef4444',
    'Development': '#ef4444',
    'Admin': '#64748b'
  };

  for (const [domain, stats] of domains) {
    const planetPos = getPlanetPosition(domain);
    const color = domainColors[domain] || '#ffffff';

    // 행성 노드
    layout.planets.push({
      id: `planet_${domain}`,
      type: 'planet',
      name: domain,
      label: `${domain}\n(${stats.count} events)`,
      position: planetPos,
      color: color,
      size: Math.min(stats.count / 500 + 1, 2.5), // 크기는 이벤트 수에 비례
      category: domain,
      isClickable: true,
      drilldownTarget: domain
    });

    // 위성 노드 (세부 활동)
    const moons = getMoonPositions(
      Math.min(stats.count, 12), // 최대 12개
      planetPos,
      6 // 작은 궤도
    );

    const topKeywords = stats.keywords
      ? Object.entries(stats.keywords)
          .sort((a, b) => b[1] - a[1])
          .slice(0, Math.min(moons.length, 5))
      : [];

    topKeywords.forEach((kw, idx) => {
      layout.moons.push({
        id: `moon_${domain}_${idx}`,
        type: 'moon',
        name: kw[0],
        label: `${kw[0]}\n(${kw[1]})`,
        position: moons[idx],
        color: color,
        size: 0.5,
        category: domain,
        visible: false, // 기본적으로 숨김, 드릴다운 시만 표시
        parentPlanet: domain
      });
    });
  }

  return layout;
}

module.exports = {
  getPlanetPosition,
  getMoonPositions,
  getNodePlacement,
  setOrbitAnimation,
  updateOrbitPosition,
  generateOrbitalLayout
};
