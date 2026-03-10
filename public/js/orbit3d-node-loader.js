/**
 * orbit3d-node-loader.js
 * 3D 노드 로더 - API에서 행성 구조 로드 및 3D 렌더링
 */

let nodesData = null;
let planetMeshes = {};
let moonMeshes = {};

/**
 * 서버에서 노드 구조 로드
 */
async function loadNodesFromServer() {
  try {
    const response = await fetch('/api/nodes/structure');
    const data = await response.json();
    
    if (data.ok) {
      nodesData = data;
      console.log('[NodeLoader] 노드 로드 완료:', data.summary);
      return data;
    } else {
      console.error('[NodeLoader] API 에러:', data.error);
      return null;
    }
  } catch (e) {
    console.error('[NodeLoader] 로드 실패:', e.message);
    return null;
  }
}

/**
 * 행성 메시 생성
 * @param {Object} planet - 행성 데이터
 * @returns {THREE.Group} 행성 그룹 (텍스트 레이블 포함)
 */
function createPlanetMesh(planet) {
  const group = new THREE.Group();
  
  // 구 생성
  const geometry = new THREE.IcosahedronGeometry(planet.size || 1, 4);
  const material = new THREE.MeshStandardMaterial({
    color: planet.color || '#ffffff',
    emissive: planet.color || '#ffffff',
    emissiveIntensity: 0.3,
    metalness: 0.3,
    roughness: 0.7
  });
  
  const sphere = new THREE.Mesh(geometry, material);
  sphere.position.set(planet.position.x, planet.position.y, planet.position.z);
  sphere.userData = planet;
  
  group.add(sphere);
  
  // 라벨 텍스트 (Canvas 기반)
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  
  ctx.fillStyle = planet.color || '#ffffff';
  ctx.font = 'bold 24px Arial';
  ctx.textAlign = 'center';
  ctx.fillText(planet.name, 128, 50);
  ctx.font = '14px Arial';
  ctx.fillText(planet.label.split('\n')[1] || '', 128, 80);
  
  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.position.set(0, planet.size + 2, 0);
  sprite.scale.set(6, 3, 1);
  
  group.add(sprite);
  
  // 궤도 선 (옵션)
  const orbitGeometry = new THREE.BufferGeometry();
  const orbitPoints = [];
  const radius = Math.sqrt(planet.position.x ** 2 + planet.position.z ** 2);
  
  for (let i = 0; i <= 64; i++) {
    const angle = (i / 64) * Math.PI * 2;
    orbitPoints.push(
      Math.cos(angle) * radius,
      planet.position.y,
      Math.sin(angle) * radius
    );
  }
  
  orbitGeometry.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array(orbitPoints), 3
  ));
  
  const orbitLine = new THREE.Line(
    orbitGeometry,
    new THREE.LineBasicMaterial({ color: planet.color, transparent: true, opacity: 0.2 })
  );
  group.add(orbitLine);
  
  return group;
}

/**
 * 위성 메시 생성
 * @param {Object} moon - 위성 데이터
 * @returns {THREE.Mesh}
 */
function createMoonMesh(moon) {
  const geometry = new THREE.SphereGeometry(moon.size || 0.3, 8, 8);
  const material = new THREE.MeshStandardMaterial({
    color: moon.color || '#ffffff',
    emissive: moon.color || '#ffffff',
    emissiveIntensity: 0.2
  });
  
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(moon.position.x, moon.position.y, moon.position.z);
  mesh.userData = moon;
  
  return mesh;
}

/**
 * 모든 노드를 씬에 추가
 */
function addNodesToScene() {
  if (!nodesData || !window.scene) {
    console.warn('[NodeLoader] 데이터 또는 씬이 없음');
    return;
  }
  
  // 행성 추가
  for (const planet of nodesData.planets) {
    const mesh = createPlanetMesh(planet);
    window.scene.add(mesh);
    planetMeshes[planet.id] = mesh;
    
    // 클릭 등록
    if (window.registerInteractive) {
      mesh.children[0]?.userData && 
      window.registerInteractive(mesh.children[0], planet);
    }
  }
  
  // 위성 추가 (기본적으로 숨김, 드릴다운 시만 표시)
  for (const moon of nodesData.moons) {
    const mesh = createMoonMesh(moon);
    if (!moon.visible) mesh.visible = false;
    window.scene.add(mesh);
    moonMeshes[moon.id] = mesh;
  }
  
  console.log('[NodeLoader] 씬에 노드 추가 완료:', 
    Object.keys(planetMeshes).length, '개 행성,',
    Object.keys(moonMeshes).length, '개 위성'
  );
}

/**
 * 드릴다운: 행성 선택 시 세부 노드 표시
 * @param {string} domainName - 도메인 이름 (예: "Inventory")
 */
function drilldownPlanet(domainName) {
  // 모든 위성 숨김
  for (const moonId in moonMeshes) {
    moonMeshes[moonId].visible = false;
  }
  
  // 선택된 도메인의 위성만 표시
  for (const moonId in moonMeshes) {
    if (moonMeshes[moonId].userData.parentPlanet === domainName) {
      moonMeshes[moonId].visible = true;
    }
  }
  
  console.log('[NodeLoader] 드릴다운:', domainName);
}

// 초기화
window.addEventListener('load', async () => {
  const data = await loadNodesFromServer();
  if (data && window.scene) {
    // 약간의 지연 후 추가 (씬이 초기화되도록)
    setTimeout(addNodesToScene, 500);
  }
});

// 전역 노출
window.drilldownPlanet = drilldownPlanet;
window.loadNodesFromServer = loadNodesFromServer;
window.addNodesToScene = addNodesToScene;

console.log('[NodeLoader] 초기화 완료');
