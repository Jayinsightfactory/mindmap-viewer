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
// mywork-renderer.js와 동일한 고정 카드 사이즈
const _ML_CARD_W = 4.5;
const _ML_CARD_H = 2.1;

function createNodeMesh(shape, size, color, label = '') {
  const group = new THREE.Group();

  // 고정 카드 크기 (사이즈 통일 — 동적 크기 제거)
  const cardW = _ML_CARD_W;
  const cardH = _ML_CARD_H;

  // 고해상도 캔버스 (1024×480 @ 2× scale → 512×240 논리 공간)
  const cw = 1024, ch = 480;
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);  // 실제 렌더 영역 512×240 유지

  // CSS color 파싱
  const hexColor = (color || '#58a6ff').startsWith('#') ? (color || '#58a6ff') : '#58a6ff';
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  const W = 512, H = 240;  // 논리 크기 (scale 2 적용 후)
  const radius = 16;
  ctx.clearRect(0, 0, W, H);

  // 배경 그래디언트 (딥우주)
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   `rgba(4,10,24,0.98)`);
  bg.addColorStop(0.7, `rgba(8,18,40,0.97)`);
  bg.addColorStop(1,   `rgba(${r*0.12|0},${g*0.12|0},${b*0.12|0},0.97)`);
  ctx.beginPath();
  ctx.moveTo(radius, 0); ctx.lineTo(W-radius, 0);
  ctx.quadraticCurveTo(W, 0, W, radius); ctx.lineTo(W, H-radius);
  ctx.quadraticCurveTo(W, H, W-radius, H); ctx.lineTo(radius, H);
  ctx.quadraticCurveTo(0, H, 0, H-radius); ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0); ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();

  // 왼쪽 액센트 바
  const bar = ctx.createLinearGradient(0, 0, 0, H);
  bar.addColorStop(0,   `rgba(${r},${g},${b},0.0)`);
  bar.addColorStop(0.5, `rgba(${r},${g},${b},1.0)`);
  bar.addColorStop(1,   `rgba(${r},${g},${b},0.0)`);
  ctx.fillStyle = bar; ctx.fillRect(0, 0, 5, H);

  // 글로우 테두리
  ctx.shadowColor = hexColor; ctx.shadowBlur = 12;
  ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(radius, 0); ctx.lineTo(W-radius, 0);
  ctx.quadraticCurveTo(W, 0, W, radius); ctx.lineTo(W, H-radius);
  ctx.quadraticCurveTo(W, H, W-radius, H); ctx.lineTo(radius, H);
  ctx.quadraticCurveTo(0, H, 0, H-radius); ctx.lineTo(0, radius);
  ctx.quadraticCurveTo(0, 0, radius, 0); ctx.closePath();
  ctx.stroke(); ctx.shadowBlur = 0;

  // 타이틀 텍스트 (상단 30%)
  const maxTW = W - 28;
  ctx.font = 'bold 34px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
  ctx.fillStyle = '#e8f4ff';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = hexColor; ctx.shadowBlur = 5;
  let t = String(label || '노드').substring(0, 30);
  while (ctx.measureText(t).width > maxTW && t.length > 1) t = t.slice(0, -1);
  if (t !== String(label || '노드')) t += '…';
  ctx.fillText(t, 16, H * 0.26);
  ctx.shadowBlur = 0;

  // 구분선
  ctx.strokeStyle = `rgba(${r},${g},${b},0.2)`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(16, H*0.46); ctx.lineTo(W-16, H*0.46); ctx.stroke();

  // 서브 텍스트 (하단, 역할/레벨 표시)
  ctx.font = '21px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
  ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
  ctx.fillText(shape || '', 16, H * 0.66);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 16;
  texture.needsUpdate = true;

  // PlaneGeometry — 고정 사이즈
  const geometry = new THREE.PlaneGeometry(cardW, cardH);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
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
