/**
 * orbit3d-multilevel-renderer.js
 * 다계층 노드 렌더링 및 드릴다운 애니메이션
 * 6단계 계층 시각화 (Level 0-5)
 * 워크스페이스 API 통합 (로그인 시 실제 데이터)
 */

if (!window.multiLevelRenderer) {
  window.multiLevelRenderer = {
    currentLevel: 0,
    currentNodes: [],
    nodeMeshes: {},
    connectionLines: [],
    animationState: null,
    sessionId: 'default',
    isAnimating: false,
    isDragging: false,
    selectedNodeId: null,
    // 워크스페이스 모드
    workspaceMode: false,
    workspaceId: null,
    userRole: null,
    permissions: null
  };
}

// 드래그 상태 추적
document.addEventListener('mousedown', () => {
  window.multiLevelRenderer.isDragging = false;
});

document.addEventListener('mousemove', (e) => {
  if (e.buttons > 0) {
    window.multiLevelRenderer.isDragging = true;
  }
});

document.addEventListener('mouseup', () => {
  window.multiLevelRenderer.isDragging = false;
});

/**
 * 로그인 사용자 토큰 가져오기
 */
function _getRendererToken() {
  try {
    const u = typeof _orbitUser !== 'undefined' ? _orbitUser : JSON.parse(localStorage.getItem('orbitUser') || 'null');
    return u?.token || null;
  } catch { return null; }
}

/**
 * 워크스페이스 모드 초기화 - 로그인 사용자의 워크스페이스 자동 감지
 */
async function initWorkspaceMode(scene) {
  const token = _getRendererToken();
  if (!token) {
    console.log('[MultiLevelRenderer] 비로그인 → 더미 데이터 모드');
    window.multiLevelRenderer.workspaceMode = false;
    return initializeLevel0(scene);
  }

  try {
    // workspaceId가 이미 설정되어 있으면 바로 사용, 아니면 목록 조회
    let wsId = window.multiLevelRenderer.workspaceId;
    if (!wsId) {
      const res = await fetch('/api/workspace/my', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('workspace list failed');
      const workspaces = await res.json();
      if (!workspaces || workspaces.length === 0) {
        console.log('[MultiLevelRenderer] 워크스페이스 없음 → 더미 데이터 모드');
        window.multiLevelRenderer.workspaceMode = false;
        return initializeLevel0(scene);
      }
      const ws = workspaces[0];
      wsId = ws.id || ws.workspace_id;
    }

    // 워크스페이스 구조 로드 (Level 0)
    const structRes = await fetch(`/api/multilevel/workspace/${wsId}/structure`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({})
    });

    const structData = await structRes.json();
    if (structData.ok) {
      window.multiLevelRenderer.workspaceMode = true;
      window.multiLevelRenderer.workspaceId = wsId;
      window.multiLevelRenderer.sessionId = structData.sessionId || 'default';
      window.multiLevelRenderer.userRole = structData.role || structData.permissions?.role;
      window.multiLevelRenderer.permissions = structData.permissions;
      window.multiLevelRenderer.currentLevel = structData.level || 0;

      await renderNodes(structData.nodes, scene);
      if (structData.connections) renderConnections(structData.connections, scene);

      console.log(`[MultiLevelRenderer] 워크스페이스 모드 활성화: ${wsId} (${structData.permissions?.role})`);
      return structData;
    }
  } catch (e) {
    console.warn('[MultiLevelRenderer] 워크스페이스 모드 실패, 더미 데이터로 전환:', e.message);
  }

  // 폴백: 더미 데이터 모드
  window.multiLevelRenderer.workspaceMode = false;
  return initializeLevel0(scene);
}

/**
 * 카드형 노드 메시 생성 (이미지 스타일: 둥근 직사각형 카드)
 * @param {string} shape - 형태 힌트 (현재 미사용, 카드형 통일)
 * @param {number} size - 크기 배율
 * @param {string} color - 테두리/강조 색상
 * @param {string} label - 노드 라벨 텍스트
 * @returns {THREE.Group}
 */
function createNodeMesh(shape, size, color, label = '') {
  const group = new THREE.Group();

  // 카드 크기
  const cardW = Math.max(2.5, 1.5 + label.length * 0.12) * size;
  const cardH = 1.1 * size;

  // 캔버스로 카드 텍스처 생성 (둥근 직사각형 + 텍스트)
  const cw = 256, ch = 96;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');

  // 파싱: CSS color → hex for canvas
  const hexColor = color.startsWith('#') ? color : '#58a6ff';
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  // 배경: 반투명 다크
  const radius = 16;
  ctx.clearRect(0, 0, cw, ch);

  // 둥근 직사각형 배경
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(cw - radius, 0);
  ctx.quadraticCurveTo(cw, 0, cw, radius);
  ctx.lineTo(cw, ch - radius);
  ctx.quadraticCurveTo(cw, ch, cw - radius, ch);
  ctx.lineTo(radius, ch);
  ctx.quadraticCurveTo(0, ch, 0, ch - radius);
  ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0);
  ctx.closePath();

  // 배경 채우기 (반투명 다크블루)
  ctx.fillStyle = `rgba(10, 20, 40, 0.85)`;
  ctx.fill();

  // 테두리 (색상 강조)
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.9)`;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 라벨 텍스트
  const displayText = (label || '').substring(0, 20);
  ctx.fillStyle = `rgb(${Math.min(255, r + 80)}, ${Math.min(255, g + 80)}, ${Math.min(255, b + 80)})`;
  ctx.font = `bold ${displayText.length > 12 ? 16 : 20}px "Inter", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayText, cw / 2, ch / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  // PlaneGeometry로 카드 생성 (항상 카메라를 향하게 Billboard 처리는 animate loop에서)
  const geometry = new THREE.PlaneGeometry(cardW, cardH);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.shape = 'card';
  mesh.userData.color = color;
  mesh.userData.isCard = true;
  group.add(mesh);

  // 선택 시 강조 테두리 (초기에는 숨김)
  const borderGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(cardW + 0.1, cardH + 0.1));
  const borderMat = new THREE.LineBasicMaterial({ color: hexColor, linewidth: 2 });
  const border = new THREE.LineSegments(borderGeo, borderMat);
  border.visible = false;
  border.userData.isBorder = true;
  group.add(border);

  return group;
}

/**
 * 노드를 3D 씬에 추가
 */
async function renderNodes(nodes, scene) {
  try {
    // 기존 노드 제거
    Object.values(window.multiLevelRenderer.nodeMeshes).forEach(mesh => {
      if (mesh.children) {
        mesh.children.forEach(child => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) {
            if (child.material.map) child.material.map.dispose();
            child.material.dispose();
          }
        });
      }
      scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    });
    window.multiLevelRenderer.nodeMeshes = {};

    // 새 노드 추가
    nodes.forEach((node, index) => {
      const mesh = createNodeMesh(node.shape, node.size, node.color, node.name);
      mesh.position.set(node.position.x, node.position.y, node.position.z);
      mesh.userData = {
        ...node,
        nodeId: node.id,
        nodeIndex: index,
        isNode: true
      };

      // 카드 노드: 카메라를 향하게 (billboard)
      if (window.camera) {
        mesh.lookAt(window.camera.position);
      }

      scene.add(mesh);
      window.multiLevelRenderer.nodeMeshes[node.id] = mesh;

      if (window.registerInteractive && mesh.children && mesh.children[0]) {
        window.registerInteractive(mesh.children[0]);
      }
    });

    // 카드 노드가 항상 카메라를 향하도록 업데이트 함수 등록
    window.multiLevelRenderer._updateCardBillboard = () => {
      if (!window.camera) return;
      Object.values(window.multiLevelRenderer.nodeMeshes).forEach(mesh => {
        if (mesh.userData.isNode) {
          mesh.lookAt(window.camera.position);
        }
      });
    };

    window.multiLevelRenderer.currentNodes = nodes;

    // 워크스페이스 모드: 카메라를 노드 가까이 이동 (기존 궤도 뷰는 멀어짐)
    if (window.multiLevelRenderer.workspaceMode && window.camera) {
      // 노드 중심 계산
      let cx = 0, cy = 0, cz = 0;
      if (nodes.length > 0) {
        nodes.forEach(n => { cx += n.position.x; cy += n.position.y; cz += n.position.z; });
        cx /= nodes.length; cy /= nodes.length; cz /= nodes.length;
      }
      // 카드 시야각: 중심에서 약간 위, 앞쪽에 카메라 배치
      const targetZ = cz + 18;
      window.camera.position.set(cx, cy + 4, targetZ);
      if (window.controls) {
        window.controls.target.set(cx, cy, cz);
        window.controls.update();
      }
    }

    console.log(`[MultiLevelRenderer] ${nodes.length}개 노드 렌더링 완료`);
  } catch (e) {
    console.error('[MultiLevelRenderer] 노드 렌더링 실패:', e);
  }
}

/**
 * 연결선 렌더링
 */
function renderConnections(connections, scene) {
  try {
    window.multiLevelRenderer.connectionLines.forEach(line => {
      scene.remove(line);
      if (line.geometry) line.geometry.dispose();
      if (line.material) line.material.dispose();
    });
    window.multiLevelRenderer.connectionLines = [];

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

      const easeProgress = progress < 0.5 ? 2 * progress * progress : -1 + (4 - 2 * progress) * progress;

      fromNodes.forEach((fromNode, index) => {
        const mesh = window.multiLevelRenderer.nodeMeshes[fromNode.id];
        if (!mesh) return;

        const angle = fromNode.position.angle - (animation.selectedNode === index ? 0 : animation.rotationBias);
        const currentRadius = fromNode.position.radius +
          (toNodes[0].position.radius - fromNode.position.radius) * easeProgress;

        mesh.material.opacity = 1 - easeProgress;
        mesh.material.transparent = true;
      });

      toNodes.forEach((toNode) => {
        let mesh = window.multiLevelRenderer.nodeMeshes[toNode.id];

        if (!mesh) {
          mesh = createNodeMesh(toNode.shape, toNode.size, toNode.color);
          scene.add(mesh);
          window.multiLevelRenderer.nodeMeshes[toNode.id] = mesh;
        }

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
 * 워크스페이스 모드일 경우 워크스페이스 API 사용
 */
async function loadAndRenderLevel(level, scene, nodeId = null) {
  try {
    const mlr = window.multiLevelRenderer;
    let response;

    if (mlr.workspaceMode && mlr.workspaceId) {
      // 워크스페이스 모드: 인증된 API 사용
      const token = _getRendererToken();
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      };
      const wsId = mlr.workspaceId;

      if (nodeId && level > mlr.currentLevel) {
        response = await fetch(`/api/multilevel/workspace/${wsId}/drill/down`, {
          method: 'POST', headers,
          body: JSON.stringify({ sessionId: mlr.sessionId, nodeId, level })
        });
      } else if (level < mlr.currentLevel) {
        response = await fetch(`/api/multilevel/workspace/${wsId}/drill/up`, {
          method: 'POST', headers,
          body: JSON.stringify({ sessionId: mlr.sessionId })
        });
      } else {
        response = await fetch(`/api/multilevel/workspace/${wsId}/structure`, {
          method: 'POST', headers,
          body: JSON.stringify({})
        });
      }
    } else {
      // 더미 데이터 모드
      const sessionId = mlr.sessionId;

      if (nodeId && level > mlr.currentLevel) {
        response = await fetch('/api/multilevel/drill/down', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, nodeId, level })
        });
      } else if (nodeId && level < mlr.currentLevel) {
        response = await fetch('/api/multilevel/drill/up', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
      } else {
        response = await fetch(`/api/multilevel/level/${level}`);
      }
    }

    const data = await response.json();

    if (data.ok) {
      await renderNodes(data.nodes, scene);

      if (data.connections) {
        renderConnections(data.connections, scene);
      }

      mlr.currentLevel = data.level;
      mlr.animationState = data.animation;

      if (data.permissions) {
        mlr.permissions = data.permissions;
        mlr.userRole = data.permissions.role;
      }

      const levelName = data.levelConfig?.name || data.levelName || '';
      console.log(`[MultiLevelRenderer] Level ${data.level} (${levelName}) 로드 완료 [${mlr.workspaceMode ? 'workspace' : 'dummy'}]`);
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
 * 초기화: Level 0 로드 (더미 데이터 모드)
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
 */
async function handleNodeClick(mesh, scene) {
  if (!mesh.userData.nodeId) return;

  const currentLevel = window.multiLevelRenderer.currentLevel;
  if (currentLevel >= 5) {
    console.log('[MultiLevelRenderer] 최대 레벨에 도달');
    return;
  }

  console.log(`[MultiLevelRenderer] 노드 클릭: ${mesh.userData.nodeId}, 드릴다운 시작...`);
  const data = await loadAndRenderLevel(currentLevel + 1, scene, mesh.userData.nodeId);
  if (data && typeof updateDrillUI === 'function') updateDrillUI();
}

/**
 * UI 버튼 핸들러들
 */
async function drillDown(nodeId, scene) {
  const data = await loadAndRenderLevel(window.multiLevelRenderer.currentLevel + 1, scene, nodeId);
  if (data && typeof updateDrillUI === 'function') updateDrillUI();
}

async function drillUp(scene) {
  const mlr = window.multiLevelRenderer;

  if (mlr.workspaceMode && mlr.workspaceId) {
    const token = _getRendererToken();
    const response = await fetch(`/api/multilevel/workspace/${mlr.workspaceId}/drill/up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ sessionId: mlr.sessionId })
    });
    const data = await response.json();
    if (data.ok) {
      await renderNodes(data.nodes, scene);
      if (data.connections) renderConnections(data.connections, scene);
      mlr.currentLevel = data.level;
      if (typeof updateDrillUI === 'function') updateDrillUI();
      return data;
    }
  } else {
    const data = await loadAndRenderLevel(Math.max(0, mlr.currentLevel - 1), scene);
    if (data && typeof updateDrillUI === 'function') updateDrillUI();
    return data;
  }
}

async function resetToLevel0(scene) {
  const mlr = window.multiLevelRenderer;

  if (mlr.workspaceMode && mlr.workspaceId) {
    const token = _getRendererToken();
    await fetch(`/api/multilevel/workspace/${mlr.workspaceId}/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ sessionId: mlr.sessionId })
    });
    return initWorkspaceMode(scene);
  } else {
    await fetch(`/api/nodes/reset?sessionId=${mlr.sessionId}`);
    return initializeLevel0(scene);
  }
}

// 전역 함수 노출
window.multiLevelRenderer.loadAndRenderLevel = loadAndRenderLevel;
window.multiLevelRenderer.initializeLevel0 = initializeLevel0;
window.multiLevelRenderer.initWorkspaceMode = initWorkspaceMode;
window.multiLevelRenderer.handleNodeClick = handleNodeClick;
window.multiLevelRenderer.drillDown = drillDown;
window.multiLevelRenderer.drillUp = drillUp;
window.multiLevelRenderer.resetToLevel0 = resetToLevel0;
window.multiLevelRenderer.preloadAllLevels = preloadAllLevels;
