/**
 * orbit3d-multilevel-renderer.js
 * 다계층 노드 렌더링 및 드릴다운 애니메이션
 * 6단계 계층 시각화 (Level 0-5)
 */

if (!window.multiLevelRenderer) {
  window.multiLevelRenderer = {
    currentLevel: 0,
    currentNodes: [],
    nodeMeshes: {},
    connectionLines: [],
    animationState: null,
    sessionId: 'default',
    isAnimating: false
  };
}

/**
 * 노드 형태에 따른 메시 생성
 * @param {string} shape - 'circle', 'hexagon', 'diamond', 'star'
 * @param {number} size - 노드 크기
 * @param {string} color - 색상 (CSS color)
 * @returns {THREE.Mesh}
 */
function createNodeMesh(shape, size, color) {
  let geometry;

  switch (shape) {
    case 'circle':
      // 구형
      geometry = new THREE.IcosahedronGeometry(size, 3);
      break;
    case 'hexagon':
      // 육각형 (실린더 사용)
      geometry = new THREE.CylinderGeometry(size, size, size * 0.5, 6);
      break;
    case 'diamond':
      // 다이아몬드 (8면체)
      geometry = new THREE.OctahedronGeometry(size);
      break;
    case 'star':
      // 별 (복잡한 형태는 구 사용하되 극점 강조)
      geometry = new THREE.IcosahedronGeometry(size, 4);
      break;
    default:
      geometry = new THREE.SphereGeometry(size, 16, 16);
  }

  const material = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.5,
    metalness: 0.4,
    roughness: 0.6,
    wireframe: false
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.shape = shape;
  mesh.userData.color = color;

  return mesh;
}

/**
 * 노드를 3D 씬에 추가
 * @param {Array} nodes - 노드 배열
 * @param {Object} scene - Three.js 씬
 */
async function renderNodes(nodes, scene) {
  try {
    // 기존 노드 제거
    Object.values(window.multiLevelRenderer.nodeMeshes).forEach(mesh => {
      scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    window.multiLevelRenderer.nodeMeshes = {};

    // 새 노드 추가
    nodes.forEach((node, index) => {
      const mesh = createNodeMesh(node.shape, node.size, node.color);
      mesh.position.set(node.position.x, node.position.y, node.position.z);
      mesh.userData = {
        ...node,
        nodeId: node.id,
        nodeIndex: index
      };

      scene.add(mesh);
      window.multiLevelRenderer.nodeMeshes[node.id] = mesh;

      // 클릭 감지를 위해 등록
      if (window.registerInteractive) {
        window.registerInteractive(mesh);
      }
    });

    window.multiLevelRenderer.currentNodes = nodes;
    console.log(`[MultiLevelRenderer] ${nodes.length}개 노드 렌더링 완료`);
  } catch (e) {
    console.error('[MultiLevelRenderer] 노드 렌더링 실패:', e);
  }
}

/**
 * 연결선 렌더링
 * @param {Array} connections - 연결선 정보 배열
 * @param {Object} scene - Three.js 씬
 */
function renderConnections(connections, scene) {
  try {
    // 기존 연결선 제거
    window.multiLevelRenderer.connectionLines.forEach(line => {
      scene.remove(line);
      if (line.geometry) line.geometry.dispose();
      if (line.material) line.material.dispose();
    });
    window.multiLevelRenderer.connectionLines = [];

    // 새 연결선 추가
    connections.forEach(conn => {
      const points = [
        new THREE.Vector3(conn.from.x, conn.from.y, conn.from.z),
        new THREE.Vector3(conn.to.x, conn.to.y, conn.to.z)
      ];

      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: conn.color,
        linewidth: conn.thickness,
        opacity: 0.6,
        transparent: true,
        dashSize: conn.dashed ? 0.5 : 1000,
        gapSize: conn.dashed ? 0.5 : 0
      });

      const line = new THREE.Line(geometry, material);
      scene.add(line);
      window.multiLevelRenderer.connectionLines.push(line);
    });

    console.log(`[MultiLevelRenderer] ${connections.length}개 연결선 렌더링 완료`);
  } catch (e) {
    console.error('[MultiLevelRenderer] 연결선 렌더링 실패:', e);
  }
}

/**
 * 드릴다운 애니메이션 실행
 * @param {Object} fromNodes - 현재 노드들
 * @param {Object} toNodes - 목표 노드들
 * @param {Object} animation - 애니메이션 정보
 * @param {Object} scene - Three.js 씬
 */
async function animateDrillDown(fromNodes, toNodes, animation, scene) {
  return new Promise((resolve) => {
    if (window.multiLevelRenderer.isAnimating) {
      resolve();
      return;
    }

    window.multiLevelRenderer.isAnimating = true;
    const startTime = Date.now();
    const duration = animation.duration || 600;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // 이징 함수 (ease-in-out)
      const easeProgress = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

      // 현재 노드들 업데이트
      fromNodes.forEach((fromNode, index) => {
        const mesh = window.multiLevelRenderer.nodeMeshes[fromNode.id];
        if (!mesh) return;

        // 선택된 노드 기준으로 회전
        const angle = fromNode.position.angle - (animation.selectedNode === index ? 0 : animation.rotationBias);
        const currentRadius = fromNode.position.radius +
          (toNodes[0].position.radius - fromNode.position.radius) * easeProgress;

        // 점진적으로 숨김
        mesh.material.opacity = 1 - easeProgress;
        mesh.material.transparent = true;
      });

      // 목표 노드들 표시 및 배치
      toNodes.forEach((toNode) => {
        let mesh = window.multiLevelRenderer.nodeMeshes[toNode.id];

        if (!mesh) {
          // 새 노드 생성
          mesh = createNodeMesh(toNode.shape, toNode.size, toNode.color);
          scene.add(mesh);
          window.multiLevelRenderer.nodeMeshes[toNode.id] = mesh;
        }

        // 점진적 나타나기 및 움직임
        mesh.material.opacity = easeProgress;
        mesh.material.transparent = true;
        mesh.position.set(
          toNode.position.x + (Math.random() - 0.5) * 10 * (1 - easeProgress),
          toNode.position.y + (Math.random() - 0.5) * 10 * (1 - easeProgress),
          toNode.position.z + (Math.random() - 0.5) * 10 * (1 - easeProgress)
        );
      });

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // 애니메이션 완료
        fromNodes.forEach(node => {
          const mesh = window.multiLevelRenderer.nodeMeshes[node.id];
          if (mesh) scene.remove(mesh);
        });

        toNodes.forEach(node => {
          const mesh = window.multiLevelRenderer.nodeMeshes[node.id];
          if (mesh) {
            mesh.material.opacity = 1;
            mesh.material.transparent = false;
          }
        });

        window.multiLevelRenderer.isAnimating = false;
        console.log('[MultiLevelRenderer] 드릴다운 애니메이션 완료');
        resolve();
      }
    };

    animate();
  });
}

/**
 * 서버에서 노드 데이터 로드 및 렌더링
 * @param {number} level - 대상 레벨
 * @param {Object} scene - Three.js 씬
 * @param {string} nodeId - 드릴다운할 노드 ID (선택사항)
 */
async function loadAndRenderLevel(level, scene, nodeId = null) {
  try {
    const sessionId = window.multiLevelRenderer.sessionId;
    let response;

    if (nodeId && level > window.multiLevelRenderer.currentLevel) {
      // 드릴다운
      response = await fetch('/api/multilevel/drill/down', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, nodeId, level })
      });
    } else if (nodeId && level < window.multiLevelRenderer.currentLevel) {
      // 드릴업
      response = await fetch('/api/multilevel/drill/up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
    } else {
      // 직접 레벨 접근
      response = await fetch(`/api/multilevel/level/${level}`);
    }

    const data = await response.json();

    if (data.ok) {
      // 노드 렌더링
      await renderNodes(data.nodes, scene);

      // 연결선 렌더링 (있을 경우)
      if (data.connections) {
        renderConnections(data.connections, scene);
      }

      // 상태 업데이트
      window.multiLevelRenderer.currentLevel = data.level;
      window.multiLevelRenderer.animationState = data.animation;

      console.log(`[MultiLevelRenderer] Level ${data.level} (${data.levelConfig.name}) 로드 완료`);
      return data;
    } else {
      console.error('[MultiLevelRenderer] API 에러:', data.error);
      return null;
    }
  } catch (e) {
    console.error('[MultiLevelRenderer] 로드 실패:', e);
    return null;
  }
}

/**
 * 초기화: Level 0 로드
 * @param {Object} scene - Three.js 씬
 */
async function initializeLevel0(scene) {
  try {
    const response = await fetch('/api/multilevel/structure');
    const data = await response.json();

    if (data.ok) {
      await renderNodes(data.nodes, scene);
      window.multiLevelRenderer.currentLevel = 0;
      console.log('[MultiLevelRenderer] Level 0 초기화 완료');
      return data;
    }
  } catch (e) {
    console.error('[MultiLevelRenderer] Level 0 초기화 실패:', e);
  }
}

/**
 * 모든 레벨 미리 로드 (캐싱용)
 */
async function preloadAllLevels() {
  try {
    const response = await fetch('/api/multilevel/all-levels');
    const data = await response.json();

    if (data.ok) {
      window.multiLevelRenderer.allLevelsCache = data.allLevels;
      console.log('[MultiLevelRenderer] 모든 레벨 미리로드 완료');
      return data;
    }
  } catch (e) {
    console.error('[MultiLevelRenderer] 미리로드 실패:', e);
  }
}

/**
 * 마우스 클릭으로 노드 선택 시 드릴다운
 * @param {THREE.Mesh} mesh - 클릭된 메시
 * @param {Object} scene - Three.js 씬
 */
async function handleNodeClick(mesh, scene) {
  if (!mesh.userData.nodeId) return;

  const currentLevel = window.multiLevelRenderer.currentLevel;
  if (currentLevel >= 5) {
    console.log('[MultiLevelRenderer] 최대 레벨에 도달');
    return;
  }

  console.log(`[MultiLevelRenderer] 노드 클릭: ${mesh.userData.nodeId}, 드릴다운 시작...`);
  await loadAndRenderLevel(currentLevel + 1, scene, mesh.userData.nodeId);
}

/**
 * UI 버튼 핸들러들
 */
async function drillDown(nodeId, scene) {
  await loadAndRenderLevel(window.multiLevelRenderer.currentLevel + 1, scene, nodeId);
}

async function drillUp(scene) {
  await loadAndRenderLevel(Math.max(0, window.multiLevelRenderer.currentLevel - 1), scene);
}

async function resetToLevel0(scene) {
  // 세션 초기화
  await fetch(`/api/nodes/reset?sessionId=${window.multiLevelRenderer.sessionId}`);
  await initializeLevel0(scene);
}

// 전역 함수 노출
window.multiLevelRenderer.loadAndRenderLevel = loadAndRenderLevel;
window.multiLevelRenderer.initializeLevel0 = initializeLevel0;
window.multiLevelRenderer.handleNodeClick = handleNodeClick;
window.multiLevelRenderer.drillDown = drillDown;
window.multiLevelRenderer.drillUp = drillUp;
window.multiLevelRenderer.resetToLevel0 = resetToLevel0;
window.multiLevelRenderer.preloadAllLevels = preloadAllLevels;
