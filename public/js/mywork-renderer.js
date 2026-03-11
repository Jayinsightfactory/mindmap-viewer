/**
 * mywork-renderer.js
 * 기존 orbit3d 그래프 데이터를 PPTX 구조도 레이아웃으로 렌더링
 * - buildPlanetSystem(nodes) 오버라이드
 * - "내 작업" 허브 + 카드 산포 배치
 * - 클릭 시 자연스러운 노드 확장 (드릴다운 UI 없음)
 */

// ─── PPTX 구조도 기반 위치 (Slide 3 좌표 → 3D 공간 변환) ──────────────────
// My work 중심 기준, scale 0.05 적용, Z축 = PPTX Y축
const CARD_POSITIONS = [
  { x:  4.10, y: 0.27, z:  3.40 },
  { x:  5.85, y: 0.30, z: -1.00 },
  { x:  0.95, y: 0.23, z: -4.60 },
  { x: -5.30, y: 0.30, z: -2.75 },
  { x: -5.10, y: 0.28, z:  2.40 },
  { x: -1.05, y: 0.23, z:  4.55 },
  { x:  3.85, y: 0.43, z:  7.60 },
  { x: 10.30, y: 0.53, z:  2.85 },
  { x:  7.55, y: 0.49, z: -6.20 },
  { x:  0.15, y: 0.42, z: -8.40 },
  { x: -7.40, y: 0.51, z: -7.00 },
  { x:-11.20, y: 0.56, z: -1.00 },
  { x: -7.10, y: 0.49, z:  6.85 },
];

// Slide 4: 선택된 노드 기준 하위 카드 위치
const CHILD_POSITIONS = [
  { x:  4.25, y: 0.34, z:  5.20 },
  { x: -4.15, y: 0.33, z:  5.20 },
  { x: -9.70, y: 0.49, z: -1.05 },
  { x:  0.05, y: 0.28, z: -5.60 },
  { x: 10.20, y: 0.51, z: -0.55 },
];

// ─── 상태 ─────────────────────────────────────────────────────────────────
const MW = {
  hubMesh: null,
  cardMeshes: [],
  lineMeshes: [],
  currentNodes: [],
  selectedNode: null,
  viewStack: [],       // 뒤로가기 스택 [{nodes, label}]
  scene: null,
  raycaster: new THREE.Raycaster(),
  mouse: new THREE.Vector2(),
  animating: false,
};

// ─── 유틸: 캔버스로 카드 텍스처 생성 ─────────────────────────────────────
function makeCardTexture(title, sub, accentColor, w = 320, h = 120) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  // 배경
  ctx.fillStyle = 'rgba(10, 15, 30, 0.92)';
  const r = 14;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // 왼쪽 액센트 바
  ctx.fillStyle = accentColor || '#06b6d4';
  ctx.fillRect(0, 0, 4, h);

  // 테두리
  ctx.strokeStyle = (accentColor || '#06b6d4') + '55';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(w - r, 0);
  ctx.quadraticCurveTo(w, 0, w, r);
  ctx.lineTo(w, h - r); ctx.quadraticCurveTo(w, h, w - r, h);
  ctx.lineTo(r, h); ctx.quadraticCurveTo(0, h, 0, h - r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.stroke();

  // 타이틀
  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 22px "Apple SD Gothic Neo", sans-serif';
  ctx.textBaseline = 'middle';
  const maxW = w - 24;
  let t = title || '';
  while (ctx.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -1);
  if (t !== title) t += '…';
  ctx.fillText(t, 16, h * 0.42);

  // 서브 텍스트 (도메인/태그)
  if (sub) {
    ctx.fillStyle = accentColor || '#94a3b8';
    ctx.font = '14px "Apple SD Gothic Neo", sans-serif';
    let s = sub;
    while (ctx.measureText(s).width > maxW - 8 && s.length > 1) s = s.slice(0, -1);
    if (s !== sub) s += '…';
    ctx.fillText(s, 16, h * 0.72);
  }

  return new THREE.CanvasTexture(canvas);
}

// ─── 유틸: 허브(중심) 텍스처 ─────────────────────────────────────────────
function makeHubTexture(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // 외부 원
  const grad = ctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, 'rgba(6, 182, 212, 0.25)');
  grad.addColorStop(1, 'rgba(6, 182, 212, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(128, 128, 128, 0, Math.PI * 2); ctx.fill();

  // 내부 원
  ctx.fillStyle = 'rgba(10, 15, 30, 0.9)';
  ctx.beginPath(); ctx.arc(128, 128, 80, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(128, 128, 80, 0, Math.PI * 2); ctx.stroke();

  // 텍스트
  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 26px "Apple SD Gothic Neo", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label || '내 작업', 128, 128);

  return new THREE.CanvasTexture(canvas);
}

// ─── 색상 추출 유틸 (color가 string/number/object 모두 처리) ────────────────
function extractColor(color, fallback = '#06b6d4') {
  if (!color) return fallback;
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
  if (typeof color === 'object') {
    // { background: '#...', border: '#...' } 형태
    return color.background || color.border || color.hex || fallback;
  }
  return fallback;
}

// ─── 씬 정리 ─────────────────────────────────────────────────────────────
function clearMyWork() {
  const sc = MW.scene;
  if (!sc) return;

  [...MW.cardMeshes, ...MW.lineMeshes].forEach(m => {
    sc.remove(m);
    m.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map) c.material.map.dispose();
        c.material.dispose();
      }
    });
  });
  MW.cardMeshes = [];
  MW.lineMeshes = [];

  if (MW.hubMesh) {
    sc.remove(MW.hubMesh);
    MW.hubMesh.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map) c.material.map.dispose();
        c.material.dispose();
      }
    });
    MW.hubMesh = null;
  }
}

// ─── 행성 시스템 완전 제거 (planet, moon, orbit, core 전부) ─────────────────
function clearAllPlanets() {
  const sc = MW.scene;
  if (!sc) return;

  // orbit3d-scene.js의 clearScene (planetMeshes, satelliteMeshes 등)
  if (typeof clearScene === 'function') clearScene();

  // 중앙 코어 행성
  const cp = window._corePlanet;
  if (cp) {
    [cp.wireMesh, cp.glowMesh, cp.dustCloud].forEach(m => { if (m) sc.remove(m); });
    if (cp.orbitMeshes) cp.orbitMeshes.forEach(m => sc.remove(m));
    window._corePlanet = null;
  }

  // 씬에 남은 달/행성 SphereGeometry 직접 제거
  const toRemove = sc.children.filter(c =>
    (c.type === 'Mesh' && c.geometry?.type === 'SphereGeometry' && !c.userData.isHub && !c.userData.isCard) ||
    (c.type === 'Group' && !c.userData.isCard && c.userData.id !== undefined)
  );
  toRemove.forEach(m => sc.remove(m));
}

// ─── 연결선 그리기 ────────────────────────────────────────────────────────
function drawLine(from, to, color) {
  const mat = new THREE.LineBasicMaterial({ color: color || 0x334155, transparent: true, opacity: 0.4 });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x, to.y, to.z),
  ]);
  const line = new THREE.Line(geo, mat);
  MW.scene.add(line);
  MW.lineMeshes.push(line);
}

// ─── 카드 메시 생성 ───────────────────────────────────────────────────────
function createCard(node, pos, isHub = false) {
  const color = extractColor(node.color);
  const cardW = 3.2, cardH = 1.2;

  const tex = makeCardTexture(node.topic || node.name || '작업', node.domain || node.type, color);
  const geo = new THREE.PlaneGeometry(cardW, cardH);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y, pos.z);
  mesh.userData = { nodeData: node, isCard: true };

  MW.scene.add(mesh);
  MW.cardMeshes.push(mesh);
  return mesh;
}

// ─── 허브 메시 생성 ───────────────────────────────────────────────────────
function createHub(label, pos) {
  const tex = makeHubTexture(label);
  const geo = new THREE.PlaneGeometry(2.5, 2.5);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y, pos.z);
  mesh.userData = { isHub: true };
  MW.scene.add(mesh);
  MW.hubMesh = mesh;
  return mesh;
}

// ─── 뷰 렌더링 ────────────────────────────────────────────────────────────
function renderView(nodes, hubLabel, positions, hubPos = { x: 0, y: 0, z: 0 }) {
  clearAllPlanets();
  clearMyWork();

  // 허브
  createHub(hubLabel, hubPos);

  // 카드
  const count = Math.min(nodes.length, positions.length);
  for (let i = 0; i < count; i++) {
    const pos = {
      x: hubPos.x + positions[i].x,
      y: hubPos.y + positions[i].y,
      z: hubPos.z + positions[i].z,
    };
    const card = createCard(nodes[i], pos);
    // 허브 → 카드 연결선
    const hexStr = extractColor(nodes[i].color, '#334155').replace('#', '');
    drawLine({ x: hubPos.x, y: hubPos.y, z: hubPos.z }, pos, parseInt(hexStr, 16));
  }

  MW.currentNodes = nodes;

  // 카메라 위치 조정
  if (window.camera) {
    window.camera.position.set(hubPos.x, hubPos.y + 8, hubPos.z + 20);
    if (window.controls) {
      window.controls.target.set(hubPos.x, hubPos.y, hubPos.z);
      window.controls.update();
    }
  }
}

// ─── 카드 클릭 처리 ───────────────────────────────────────────────────────
function onMyWorkClick(event) {
  if (!window.camera || !MW.scene || MW.animating) return;

  const canvas = event.target;
  const rect = canvas.getBoundingClientRect();
  MW.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  MW.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  MW.raycaster.setFromCamera(MW.mouse, window.camera);
  const hits = MW.raycaster.intersectObjects([...MW.cardMeshes, MW.hubMesh].filter(Boolean), false);

  if (!hits.length) return;
  const hit = hits[0].object;

  // 허브 클릭 → 뒤로가기
  if (hit.userData.isHub) {
    if (MW.viewStack.length > 0) {
      const prev = MW.viewStack.pop();
      renderView(prev.nodes, prev.hubLabel, CARD_POSITIONS);
    }
    return;
  }

  // 카드 클릭 → 하위 노드 표시
  if (hit.userData.isCard) {
    const node = hit.userData.nodeData;
    const children = node.subtopics || node.children || node.events || [];

    if (children.length === 0) {
      // 하위 없음: 토스트
      if (typeof showToast === 'function') showToast(node.topic || node.name, 1500);
      return;
    }

    // 현재 상태 스택에 저장
    MW.viewStack.push({ nodes: MW.currentNodes, hubLabel: '내 작업' });

    // 선택 노드를 허브로 올리고 자식 카드 표시
    const childNodes = children.slice(0, CHILD_POSITIONS.length).map(c =>
      typeof c === 'string'
        ? { topic: c, name: c, color: node.color || '#06b6d4' }
        : { ...c, color: c.color || node.color || '#06b6d4' }
    );
    renderView(childNodes, node.topic || node.name, CHILD_POSITIONS);
    return;
  }
}

// ─── 빌보드: 카드가 항상 카메라를 향하도록 ─────────────────────────────
function updateBillboard() {
  if (!window.camera) return;
  const camPos = window.camera.position;
  const items = [...MW.cardMeshes];
  if (MW.hubMesh) items.push(MW.hubMesh);
  items.forEach(m => m.lookAt(camPos));
}

// ─── buildPlanetSystem 오버라이드 ─────────────────────────────────────────
// orbit3d-scene.js의 buildPlanetSystem 대신 카드 레이아웃 렌더링
window._origBuildPlanetSystem = window.buildPlanetSystem;

window.buildPlanetSystem = function(nodeList) {
  // scene이 아직 없으면 대기
  if (!window.scene) {
    const wait = setInterval(() => {
      if (window.scene) { clearInterval(wait); window.buildPlanetSystem(nodeList); }
    }, 200);
    return;
  }

  MW.scene = window.scene;
  MW.viewStack = [];

  // renderView 내부에서 clearAllPlanets() 호출함

  // 최상위 노드를 project 카드로 사용
  const topNodes = (nodeList || []).map(n => ({
    topic: n.topic || n.title || n.name || '작업',
    name: n.topic || n.title || n.name || '작업',
    domain: n.domain || n.type || '',
    color: n.color || '#06b6d4',
    subtopics: n.subtopics || n.children || [],
    events: n.events || [],
    size: n.size || 1,
    _raw: n,
  }));

  renderView(topNodes, '내 작업', CARD_POSITIONS);

  // 클릭 이벤트 등록 (한 번만)
  const canvas = document.getElementById('orbit-canvas') || document.querySelector('canvas');
  if (canvas && !canvas._mwClickBound) {
    canvas.addEventListener('click', onMyWorkClick);
    canvas._mwClickBound = true;
  }

  // 애니메이션 루프에 빌보드 업데이트 등록
  if (!window._mwBillboardRegistered) {
    window._mwBillboardRegistered = true;
    const origAnimate = window.animate;
    if (typeof origAnimate === 'function') {
      window.animate = function(...args) {
        origAnimate(...args);
        updateBillboard();
      };
    } else {
      // animate 함수가 아직 없으면 requestAnimationFrame 루프 직접 등록
      (function loop() {
        requestAnimationFrame(loop);
        updateBillboard();
      })();
    }
  }
};

// ─── 빈 상태(노드 없음)일 때도 허브는 표시 ─────────────────────────────
(function initEmpty() {
  const tryInit = () => {
    if (window.scene) {
      MW.scene = window.scene;
      if (MW.cardMeshes.length === 0 && !MW.hubMesh) {
        renderView([], '내 작업', CARD_POSITIONS);
      }
    } else {
      setTimeout(tryInit, 600);
    }
  };
  setTimeout(tryInit, 1500);
})();
