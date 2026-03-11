/**
 * mywork-renderer.js  v2
 * - buildPlanetSystem 오버라이드 → PPTX 구조도 카드 레이아웃
 * - 3D 그리드/행성 텍스처 디자인
 * - Y축 빌보드 (텍스트 기울어짐 방지)
 * - OrbitCam controls 기반 카메라 중앙 정렬
 * - 카드 클릭 드릴다운 / 허브 클릭 뒤로가기
 */

// ─── 위치 테이블 ─────────────────────────────────────────────────────────────
const CARD_POSITIONS = [
  { x:  5.50, y: 0, z:  0.00 },
  { x:  3.90, y: 0, z: -3.90 },
  { x:  0.00, y: 0, z: -5.50 },
  { x: -3.90, y: 0, z: -3.90 },
  { x: -5.50, y: 0, z:  0.00 },
  { x: -3.90, y: 0, z:  3.90 },
  { x:  0.00, y: 0, z:  5.50 },
  { x:  3.90, y: 0, z:  3.90 },
  { x:  9.00, y: 0, z:  0.00 },
  { x:  6.36, y: 0, z: -6.36 },
  { x:  0.00, y: 0, z: -9.00 },
  { x: -6.36, y: 0, z: -6.36 },
  { x: -9.00, y: 0, z:  0.00 },
];

const CHILD_POSITIONS = [
  { x:  4.50, y: 0, z:  0.00 },
  { x:  1.39, y: 0, z: -4.28 },
  { x: -3.64, y: 0, z: -2.65 },
  { x: -3.64, y: 0, z:  2.65 },
  { x:  1.39, y: 0, z:  4.28 },
];

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const MW = {
  hubMesh:      null,
  cardMeshes:   [],
  lineMeshes:   [],
  currentNodes: [],
  viewStack:    [],    // [{nodes, hubLabel}]
  scene:        null,
  raycaster:    new THREE.Raycaster(),
  mouse:        new THREE.Vector2(),
  animating:    false,
};

// ─── 색상 유틸 ────────────────────────────────────────────────────────────────
function _mwExtractColor(color, fallback = '#06b6d4') {
  if (!color) return fallback;
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
  if (typeof color === 'object') return color.background || color.border || color.hex || fallback;
  return fallback;
}

// hex → {r,g,b} 0-255
function _mwHex2rgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0,2),16),
    g: parseInt(h.slice(2,4),16),
    b: parseInt(h.slice(4,6),16),
  };
}

// ─── 카드 텍스처 (3D 그리드 행성 스타일) ────────────────────────────────────
function makeCardTexture(title, subText, accentColor, count) {
  const W = 512, H = 200;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const ac = accentColor || '#06b6d4';
  const rgb = _mwHex2rgb(ac);

  // ── 배경: 딥 우주 + 그라디언트 ──
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   `rgba(4, 10, 24, 0.97)`);
  bg.addColorStop(0.6, `rgba(8, 18, 40, 0.95)`);
  bg.addColorStop(1,   `rgba(${rgb.r*0.15|0}, ${rgb.g*0.15|0}, ${rgb.b*0.15|0}, 0.95)`);
  const rad = 18;
  ctx.beginPath();
  ctx.moveTo(rad,0); ctx.lineTo(W-rad,0);
  ctx.quadraticCurveTo(W,0,W,rad);
  ctx.lineTo(W,H-rad); ctx.quadraticCurveTo(W,H,W-rad,H);
  ctx.lineTo(rad,H);   ctx.quadraticCurveTo(0,H,0,H-rad);
  ctx.lineTo(0,rad);   ctx.quadraticCurveTo(0,0,rad,0);
  ctx.closePath();
  ctx.fillStyle = bg;
  ctx.fill();

  // ── 그리드 라인 (행성 표면 느낌) ──
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b}, 0.10)`;
  ctx.lineWidth = 0.8;
  // 가로 그리드
  for (let y = 0; y < H; y += 22) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // 세로 그리드
  for (let x = 0; x < W; x += 22) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.restore();

  // ── 왼쪽 글로우 액센트 바 ──
  const barGrad = ctx.createLinearGradient(0, 0, 0, H);
  barGrad.addColorStop(0,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  barGrad.addColorStop(0.5, `rgba(${rgb.r},${rgb.g},${rgb.b},1.0)`);
  barGrad.addColorStop(1,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  ctx.fillStyle = barGrad;
  ctx.fillRect(0, 0, 5, H);

  // ── 글로우 테두리 ──
  ctx.shadowColor   = ac;
  ctx.shadowBlur    = 14;
  ctx.strokeStyle   = `rgba(${rgb.r},${rgb.g},${rgb.b}, 0.55)`;
  ctx.lineWidth     = 2;
  ctx.beginPath();
  ctx.moveTo(rad,0); ctx.lineTo(W-rad,0);
  ctx.quadraticCurveTo(W,0,W,rad);
  ctx.lineTo(W,H-rad); ctx.quadraticCurveTo(W,H,W-rad,H);
  ctx.lineTo(rad,H);   ctx.quadraticCurveTo(0,H,0,H-rad);
  ctx.lineTo(0,rad);   ctx.quadraticCurveTo(0,0,rad,0);
  ctx.closePath();
  ctx.stroke();
  ctx.shadowBlur = 0;

  // ── 타이틀 ──
  ctx.fillStyle     = '#e2f0ff';
  ctx.font          = 'bold 38px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  ctx.textBaseline  = 'middle';
  ctx.shadowColor   = ac;
  ctx.shadowBlur    = 8;
  const maxTW = W - 28;
  let t = String(title || '작업');
  while (ctx.measureText(t).width > maxTW && t.length > 1) t = t.slice(0,-1);
  if (t !== String(title||'작업')) t += '…';
  ctx.fillText(t, 18, H * 0.40);
  ctx.shadowBlur = 0;

  // ── 서브텍스트 / 이벤트 수 ──
  const sub = subText || (count != null ? `${count}개 이벤트` : '');
  if (sub) {
    ctx.fillStyle   = `rgba(${rgb.r},${rgb.g},${rgb.b}, 0.88)`;
    ctx.font        = '22px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
    let s = String(sub);
    while (ctx.measureText(s).width > maxTW - 8 && s.length > 1) s = s.slice(0,-1);
    if (s !== String(sub)) s += '…';
    ctx.fillText(s, 18, H * 0.73);
  }

  // ── 우측 작은 펄스 점 ──
  ctx.beginPath();
  ctx.arc(W - 20, 20, 6, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b}, 0.9)`;
  ctx.shadowColor = ac; ctx.shadowBlur = 10;
  ctx.fill();
  ctx.shadowBlur = 0;

  return new THREE.CanvasTexture(canvas);
}

// ─── 허브 텍스처 (행성 느낌) ──────────────────────────────────────────────────
function makeHubTexture(label) {
  const S = 320;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  const cx = S/2, cy = S/2, R = S*0.44;

  // 외곽 글로우
  let glow = ctx.createRadialGradient(cx,cy, R*0.5, cx,cy, R*1.1);
  glow.addColorStop(0, 'rgba(6,182,212,0.28)');
  glow.addColorStop(1, 'rgba(6,182,212,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx,cy,R*1.1,0,Math.PI*2); ctx.fill();

  // 내부 행성 구
  let sphere = ctx.createRadialGradient(cx-R*0.25, cy-R*0.2, R*0.05, cx, cy, R);
  sphere.addColorStop(0,   'rgba(20,50,80,0.98)');
  sphere.addColorStop(0.5, 'rgba(8,25,50,0.98)');
  sphere.addColorStop(1,   'rgba(4,12,30,0.98)');
  ctx.fillStyle = sphere;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();

  // 그리드 (위도/경도 느낌) — clip 안에서 그리기
  ctx.save();
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.clip();
  ctx.strokeStyle = 'rgba(6,182,212,0.18)';
  ctx.lineWidth = 1;
  // 위도 (타원)
  for (let lat = -60; lat <= 60; lat += 30) {
    const ry = R * Math.cos(lat * Math.PI/180);
    const rz = R * Math.sin(lat * Math.PI/180);
    ctx.beginPath();
    ctx.ellipse(cx, cy + rz, ry, ry * 0.25, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 경도 (수직선)
  for (let lon = 0; lon < 180; lon += 36) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(lon * Math.PI / 180);
    ctx.beginPath();
    ctx.ellipse(0, 0, R * 0.25, R, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // 테두리 링
  ctx.strokeStyle = '#06b6d4';
  ctx.lineWidth   = 3;
  ctx.shadowColor = '#06b6d4';
  ctx.shadowBlur  = 18;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke();
  ctx.shadowBlur  = 0;

  // 텍스트
  ctx.fillStyle    = '#e2f0ff';
  ctx.font         = 'bold 34px "Apple SD Gothic Neo","Malgun Gothic",sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor  = '#06b6d4';
  ctx.shadowBlur   = 10;
  ctx.fillText(label || '내 작업', cx, cy);
  ctx.shadowBlur   = 0;

  return new THREE.CanvasTexture(canvas);
}

// ─── 씬 정리 ──────────────────────────────────────────────────────────────────
function clearMyWork() {
  const sc = MW.scene;
  if (!sc) return;
  [...MW.cardMeshes, ...MW.lineMeshes].forEach(m => {
    sc.remove(m);
    m.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
  });
  MW.cardMeshes = [];
  MW.lineMeshes = [];
  if (MW.hubMesh) {
    sc.remove(MW.hubMesh);
    MW.hubMesh.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
    MW.hubMesh = null;
  }
}

function clearAllPlanets() {
  const sc = MW.scene;
  if (!sc) return;
  if (typeof clearScene === 'function') clearScene();
  const cp = window._corePlanet;
  if (cp) {
    [cp.wireMesh, cp.glowMesh, cp.dustCloud].forEach(m => { if (m) sc.remove(m); });
    if (cp.orbitMeshes) cp.orbitMeshes.forEach(m => sc.remove(m));
    window._corePlanet = null;
  }
  const toRemove = sc.children.filter(c =>
    (c.type === 'Mesh' && c.geometry?.type === 'SphereGeometry' && !c.userData.isHub && !c.userData.isCard) ||
    (c.type === 'Group' && !c.userData.isCard && c.userData.id !== undefined)
  );
  toRemove.forEach(m => sc.remove(m));
}

// ─── 연결선 ───────────────────────────────────────────────────────────────────
function drawLine(from, to, colorHex) {
  const col = colorHex || 0x06b6d4;
  const mat = new THREE.LineBasicMaterial({
    color: col, transparent: true, opacity: 0.35,
  });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x,   to.y,   to.z),
  ]);
  const line = new THREE.Line(geo, mat);
  MW.scene.add(line);
  MW.lineMeshes.push(line);
}

// ─── 카드 메시 ────────────────────────────────────────────────────────────────
function createCard(node, pos) {
  const color = _mwExtractColor(node.color);
  const count = (node.children || []).length;
  const sub   = node.latestActivity
    || (count > 0 ? `${count}개 작업` : (node.domain || node.type || ''));
  const tex  = makeCardTexture(node.topic || node.name || '작업', sub, color, count||null);
  const geo  = new THREE.PlaneGeometry(5.2, 2.0);
  const mat  = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y + 1.0, pos.z);
  mesh.userData = { nodeData: node, isCard: true };
  MW.scene.add(mesh);
  MW.cardMeshes.push(mesh);
  return mesh;
}

// ─── 허브 메시 ────────────────────────────────────────────────────────────────
function createHub(label, pos) {
  const tex  = makeHubTexture(label);
  const geo  = new THREE.PlaneGeometry(3.5, 3.5);
  const mat  = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y + 1.75, pos.z);
  mesh.userData = { isHub: true };
  MW.scene.add(mesh);
  MW.hubMesh = mesh;
  return mesh;
}

// ─── 카메라 중앙 이동 (OrbitCam controls 사용) ──────────────────────────────
function _mwFocusCamera(hubPos, radius) {
  const r = radius || 28;
  // lerpCameraTo(r, tx, ty, tz, duration) — orbit3d-camera.js에 정의
  if (typeof lerpCameraTo === 'function') {
    lerpCameraTo(r, hubPos.x, hubPos.y, hubPos.z, 350);
  } else if (typeof controls !== 'undefined' && controls.tgt && controls.sph) {
    // 직접 OrbitCam 조작
    controls.tgt.set(hubPos.x, hubPos.y, hubPos.z);
    controls.sph.r = r;
    if (typeof controls._apply === 'function') controls._apply();
  } else if (window.camera) {
    // 최후 fallback
    window.camera.position.set(hubPos.x, hubPos.y + r * 0.28, hubPos.z + r * 0.96);
    window.camera.lookAt(hubPos.x, hubPos.y, hubPos.z);
  }
}

// ─── 뷰 렌더링 ────────────────────────────────────────────────────────────────
function renderView(nodes, hubLabel, positions, hubPos = { x:0, y:0, z:0 }) {
  clearAllPlanets();
  clearMyWork();

  createHub(hubLabel, hubPos);

  const count = Math.min(nodes.length, positions.length);
  for (let i = 0; i < count; i++) {
    const pos = {
      x: hubPos.x + positions[i].x,
      y: hubPos.y + positions[i].y,
      z: hubPos.z + positions[i].z,
    };
    createCard(nodes[i], pos);
    const hexStr = _mwExtractColor(nodes[i].color, '#334155').replace('#','');
    const col = parseInt(hexStr, 16);
    drawLine(
      { x: hubPos.x, y: hubPos.y + 1.75, z: hubPos.z },
      { x: pos.x,    y: pos.y + 1.0,     z: pos.z    },
      col
    );
  }

  MW.currentNodes = nodes;

  // 카드 수에 따라 적정 반지름 결정
  const farthest = positions.slice(0, count).reduce((mx, p) =>
    Math.max(mx, Math.hypot(p.x, p.z)), 0);
  _mwFocusCamera(hubPos, Math.max(22, farthest * 2.3));
}

// ─── 카드 클릭 ────────────────────────────────────────────────────────────────
function onMyWorkClick(event) {
  if (!window.camera || !MW.scene || MW.animating) return;

  const canvas = event.target;
  const rect   = canvas.getBoundingClientRect();
  MW.mouse.x =  ((event.clientX - rect.left) / rect.width)  * 2 - 1;
  MW.mouse.y = -((event.clientY - rect.top)  / rect.height) * 2 + 1;

  MW.raycaster.setFromCamera(MW.mouse, window.camera);
  const hits = MW.raycaster.intersectObjects(
    [...MW.cardMeshes, MW.hubMesh].filter(Boolean), false
  );
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

  // 카드 클릭 → 드릴다운
  if (hit.userData.isCard) {
    const node     = hit.userData.nodeData;
    const children = node.children || node.subtopics || node.events || [];
    if (children.length === 0) {
      if (typeof showToast === 'function') showToast(node.topic || node.name, 1800);
      return;
    }
    MW.viewStack.push({ nodes: MW.currentNodes.slice(), hubLabel: '내 작업' });
    const childNodes = children.slice(0, CHILD_POSITIONS.length).map(c =>
      typeof c === 'string'
        ? { topic: c, name: c, color: node.color || '#06b6d4' }
        : { ...c, color: c.color || node.color || '#06b6d4' }
    );
    renderView(childNodes, node.topic || node.name, CHILD_POSITIONS);
  }
}

// ─── Y축 빌보드 (텍스트 기울어짐 방지) ──────────────────────────────────────
// lookAt() 대신 Y축만 회전해 카메라를 향하게 함
function updateBillboard() {
  if (!window.camera) return;
  const cp = window.camera.position;
  const items = [...MW.cardMeshes];
  if (MW.hubMesh) items.push(MW.hubMesh);
  items.forEach(m => {
    // Y축 회전각만 계산
    m.rotation.set(0, Math.atan2(cp.x - m.position.x, cp.z - m.position.z), 0);
  });
}

// ─── buildPlanetSystem 오버라이드 ────────────────────────────────────────────
window._origBuildPlanetSystem = window.buildPlanetSystem;

window.buildPlanetSystem = function(nodeList) {
  // 팀/전사/병렬 모드 → 원본에 위임
  const inTeam =
    (typeof _teamMode     !== 'undefined' && _teamMode) ||
    (typeof _companyMode  !== 'undefined' && _companyMode) ||
    (typeof _parallelMode !== 'undefined' && _parallelMode);
  if (inTeam) {
    if (typeof window._origBuildPlanetSystem === 'function')
      return window._origBuildPlanetSystem(nodeList);
    return;
  }

  if (!window.scene) {
    const wait = setInterval(() => {
      if (window.scene) { clearInterval(wait); window.buildPlanetSystem(nodeList); }
    }, 200);
    return;
  }

  MW.scene    = window.scene;
  MW.viewStack = [];

  // purposeLabel 기준 그룹화
  const groupMap = {};
  (nodeList || []).forEach(n => {
    const key = n.purposeLabel || n.domain || n.type || '기타';
    if (!groupMap[key]) {
      groupMap[key] = {
        topic:          key,
        name:           key,
        icon:           n.purposeIcon  || '',
        color:          n.purposeColor || _mwExtractColor(n.color),
        children:       [],
        latestActivity: null,
      };
    }
    groupMap[key].children.push({
      topic: n.label || n.topic || n.name || '작업',
      name:  n.label || n.name  || '작업',
      color: n.purposeColor || _mwExtractColor(n.color),
      _raw:  n,
    });
    // 가장 최근 활동명 기록
    if (!groupMap[key].latestActivity) {
      groupMap[key].latestActivity = n.label || n.topic || n.name || null;
    }
  });

  const topNodes = Object.values(groupMap)
    .sort((a, b) => b.children.length - a.children.length)
    .slice(0, CARD_POSITIONS.length);

  renderView(topNodes, '내 작업', CARD_POSITIONS);

  // 클릭 이벤트 등록 (renderer.domElement 우선 — minimap 캔버스 오바인딩 방지)
  const cvs = (typeof renderer !== 'undefined' && renderer.domElement)
    || document.getElementById('orbit-canvas')
    || document.querySelector('canvas');
  if (cvs && !cvs._mwClickBound) {
    cvs.addEventListener('click', onMyWorkClick);
    cvs._mwClickBound = true;
  }

  // 빌보드 루프 등록 (한 번만)
  if (!window._mwBillboardRegistered) {
    window._mwBillboardRegistered = true;
    (function loop() { requestAnimationFrame(loop); updateBillboard(); })();
  }
};

// ─── 초기 로드 ────────────────────────────────────────────────────────────────
(function initMyWork() {
  let triggered = false;
  const tryInit = () => {
    if (triggered) return;
    if (!window.scene) { setTimeout(tryInit, 200); return; }
    MW.scene = window.scene;
    if (MW.cardMeshes.length === 0 && !MW.hubMesh) {
      triggered = true;
      if (typeof loadData === 'function') loadData();
      else renderView([], '내 작업', CARD_POSITIONS);
    }
  };
  setTimeout(tryInit, 500);
})();

// ─── "내 화면" 복귀 훅 ────────────────────────────────────────────────────────
function _mwHookSetViewPersonal() {
  const _prev = window.setViewPersonal;
  window.setViewPersonal = function(...args) {
    // 팀/전사 모드 직접 종료
    if (typeof exitTeamMode === 'function' &&
        typeof _teamMode    !== 'undefined' && (_teamMode || _companyMode)) {
      try { exitTeamMode(); } catch(e) {}
    }
    if (typeof exitParallelMode === 'function' &&
        typeof _parallelMode    !== 'undefined' && _parallelMode) {
      try { exitParallelMode(); } catch(e) {}
    }
    // 원본 전환 (카메라 트랜지션 side effect)
    if (typeof _prev === 'function') { try { _prev(...args); } catch(e) {} }

    // 루프 재시작 + 카드 재렌더
    setTimeout(() => {
      if (typeof _orbitAnimLoop === 'function') {
        try { renderer.setAnimationLoop(_orbitAnimLoop); } catch(e) {}
        requestAnimationFrame(_orbitAnimLoop);
      }
      MW.scene = window.scene;
      if (MW.scene && typeof loadData === 'function') loadData();
    }, 200);
  };
}
_mwHookSetViewPersonal();
setTimeout(_mwHookSetViewPersonal, 1100);
