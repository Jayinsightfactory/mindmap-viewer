/**
 * mywork-renderer.js  v3
 * - 3단계 드릴다운 (카테고리 → 이벤트 → 세부정보)
 * - 스프라이트 빌보드 (camera.quaternion 복사 → 텍스트 기울어짐 완전 제거)
 * - renderOrder: 연결선(0) < 카드(1) → 선이 카드 뒤로
 * - 3D 그리드/행성 텍스처, lerpCameraTo 중앙정렬
 */

// ─── 위치 테이블 (3단계) ──────────────────────────────────────────────────────
// 0단계: 카테고리 카드 (최대 13개, 이중 원형)
const CARD_POSITIONS = [
  { x:  5.50, y: 0, z:  0.00 },
  { x:  3.90, y: 0, z: -3.90 },
  { x:  0.00, y: 0, z: -5.50 },
  { x: -3.90, y: 0, z: -3.90 },
  { x: -5.50, y: 0, z:  0.00 },
  { x: -3.90, y: 0, z:  3.90 },
  { x:  0.00, y: 0, z:  5.50 },
  { x:  3.90, y: 0, z:  3.90 },
  { x:  9.20, y: 0, z:  0.00 },
  { x:  6.51, y: 0, z: -6.51 },
  { x:  0.00, y: 0, z: -9.20 },
  { x: -6.51, y: 0, z: -6.51 },
  { x: -9.20, y: 0, z:  0.00 },
];

// 1단계: 이벤트 카드 (최대 7개, 중간 원형)
const CHILD_POSITIONS = [
  { x:  5.00, y: 0, z:  0.00 },
  { x:  2.50, y: 0, z: -4.33 },
  { x: -2.50, y: 0, z: -4.33 },
  { x: -5.00, y: 0, z:  0.00 },
  { x: -2.50, y: 0, z:  4.33 },
  { x:  2.50, y: 0, z:  4.33 },
  { x:  0.00, y: 0, z: -6.00 },
];

// 2단계: 세부정보 카드 (최대 5개, 작은 원형)
const GRAND_POSITIONS = [
  { x:  3.20, y: 0, z:  0.00 },
  { x:  0.99, y: 0, z: -3.04 },
  { x: -2.57, y: 0, z: -1.87 },
  { x: -2.57, y: 0, z:  1.87 },
  { x:  0.99, y: 0, z:  3.04 },
];

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const MW = {
  hubMesh:          null,
  cardMeshes:       [],
  lineMeshes:       [],
  currentNodes:     [],
  currentHubLabel:  '내 작업',
  currentPositions: null,   // 현재 레벨에서 쓴 positions 배열
  viewStack:        [],     // [{nodes, hubLabel, positions}]
  scene:            null,
  raycaster:        new THREE.Raycaster(),
  mouse:            new THREE.Vector2(),
  animating:        false,
};

// ─── 색상 유틸 ────────────────────────────────────────────────────────────────
function _mwExtractColor(color, fallback = '#06b6d4') {
  if (!color) return fallback;
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
  if (typeof color === 'object') return color.background || color.border || color.hex || fallback;
  return fallback;
}
function _mwHex2rgb(hex) {
  const h = (hex || '#06b6d4').replace('#', '');
  return { r: parseInt(h.slice(0,2),16)||6, g: parseInt(h.slice(2,4),16)||182, b: parseInt(h.slice(4,6),16)||212 };
}

// ─── 2단계용 세부 노드 생성 (rawNode 프로퍼티 → 카드화) ─────────────────────
function _mwMakeDetailNodes(rawNode, parentColor) {
  const pc = parentColor || '#06b6d4';
  const mk = (topic, name, color) => ({
    topic, name: String(name || '').slice(0, 40),
    color, children: [],  // 3단계가 끝이므로 자식 없음
  });
  const out = [];
  // 시간
  if (rawNode.timestamp || rawNode.createdAt || rawNode.time) {
    const ts = rawNode.timestamp || rawNode.createdAt || rawNode.time;
    const dt = new Date(ts);
    const label = isNaN(dt.getTime()) ? String(ts).slice(0,20)
      : dt.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    out.push(mk('🕐 시간', label, '#64748b'));
  }
  // 세션 ID
  if (rawNode.session || rawNode.sessionId || rawNode.session_id) {
    const sid = rawNode.session || rawNode.sessionId || rawNode.session_id;
    out.push(mk('🔗 세션', String(sid).slice(0,20), '#8b5cf6'));
  }
  // 도메인/카테고리
  if (rawNode.domain || rawNode.category) {
    out.push(mk('🌐 도메인', rawNode.domain || rawNode.category, '#06b6d4'));
  }
  // 유형
  if (rawNode.type || rawNode.eventType || rawNode.purposeLabel) {
    out.push(mk('🏷️ 유형', rawNode.type || rawNode.eventType || rawNode.purposeLabel, '#f59e0b'));
  }
  // 프로젝트
  if (rawNode.projectName || rawNode.project || rawNode.repo) {
    out.push(mk('📁 프로젝트', rawNode.projectName || rawNode.project || rawNode.repo, '#10b981'));
  }
  // 상세 레이블 (이름과 다를 때)
  if (rawNode.detail || rawNode.description || rawNode.summary) {
    out.push(mk('📝 요약', rawNode.detail || rawNode.description || rawNode.summary, '#ec4899'));
  }

  // 아무것도 없으면 기본 카드 생성
  if (out.length === 0) {
    out.push(mk('📋 상세', rawNode.label || rawNode.name || rawNode.id || '없음', pc));
  }
  return out.slice(0, GRAND_POSITIONS.length);
}

// ─── 카드 텍스처 (3D 그리드 행성 스타일) ────────────────────────────────────
function makeCardTexture(title, subText, accentColor) {
  const W = 512, H = 192;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ac = accentColor || '#06b6d4';
  const rgb = _mwHex2rgb(ac);

  // 배경 딥우주 그라디언트
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   `rgba(4,10,24,0.98)`);
  bg.addColorStop(0.7, `rgba(8,18,40,0.97)`);
  bg.addColorStop(1,   `rgba(${rgb.r*0.12|0},${rgb.g*0.12|0},${rgb.b*0.12|0},0.97)`);
  const R = 16;
  ctx.beginPath();
  ctx.moveTo(R,0); ctx.lineTo(W-R,0);
  ctx.quadraticCurveTo(W,0,W,R); ctx.lineTo(W,H-R);
  ctx.quadraticCurveTo(W,H,W-R,H); ctx.lineTo(R,H);
  ctx.quadraticCurveTo(0,H,0,H-R); ctx.lineTo(0,R);
  ctx.quadraticCurveTo(0,0,R,0); ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();

  // 그리드 라인 (클립 내부)
  ctx.save(); ctx.clip();
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.09)`;
  ctx.lineWidth = 0.8;
  for (let y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  for (let x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  ctx.restore();

  // 왼쪽 글로우 액센트 바
  const bar = ctx.createLinearGradient(0,0,0,H);
  bar.addColorStop(0,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  bar.addColorStop(0.5, `rgba(${rgb.r},${rgb.g},${rgb.b},1.0)`);
  bar.addColorStop(1,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  ctx.fillStyle = bar; ctx.fillRect(0,0,5,H);

  // 글로우 테두리
  ctx.shadowColor = ac; ctx.shadowBlur = 12;
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.6)`;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(R,0); ctx.lineTo(W-R,0);
  ctx.quadraticCurveTo(W,0,W,R); ctx.lineTo(W,H-R);
  ctx.quadraticCurveTo(W,H,W-R,H); ctx.lineTo(R,H);
  ctx.quadraticCurveTo(0,H,0,H-R); ctx.lineTo(0,R);
  ctx.quadraticCurveTo(0,0,R,0); ctx.closePath();
  ctx.stroke(); ctx.shadowBlur = 0;

  // 타이틀 (밝고 크게)
  ctx.fillStyle = '#e8f4ff';
  ctx.font = 'bold 36px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = ac; ctx.shadowBlur = 6;
  const maxW = W - 30;
  let t = String(title || '작업');
  while (ctx.measureText(t).width > maxW && t.length > 1) t = t.slice(0,-1);
  if (t !== String(title||'작업')) t += '…';
  ctx.fillText(t, 18, H * 0.38);
  ctx.shadowBlur = 0;

  // 서브텍스트
  if (subText) {
    ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.90)`;
    ctx.font = '21px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
    let s = String(subText);
    while (ctx.measureText(s).width > maxW - 6 && s.length > 1) s = s.slice(0,-1);
    if (s !== String(subText)) s += '…';
    ctx.fillText(s, 18, H * 0.70);
  }

  // 우측 상단 펄스 점
  ctx.beginPath(); ctx.arc(W-20, 20, 5, 0, Math.PI*2);
  ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.9)`;
  ctx.shadowColor = ac; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;

  return new THREE.CanvasTexture(canvas);
}

// ─── 허브 텍스처 (행성 구체) ──────────────────────────────────────────────────
function makeHubTexture(label) {
  const S = 320; const cx=S/2, cy=S/2, R=S*0.44;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');

  // 외곽 글로우
  let glow = ctx.createRadialGradient(cx,cy,R*0.4,cx,cy,R*1.15);
  glow.addColorStop(0,'rgba(6,182,212,0.3)'); glow.addColorStop(1,'rgba(6,182,212,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx,cy,R*1.15,0,Math.PI*2); ctx.fill();

  // 구체 그라디언트
  let sp = ctx.createRadialGradient(cx-R*0.28,cy-R*0.22,R*0.04,cx,cy,R);
  sp.addColorStop(0,'rgba(22,55,88,0.99)');
  sp.addColorStop(0.5,'rgba(8,26,54,0.99)');
  sp.addColorStop(1,'rgba(4,12,30,0.99)');
  ctx.fillStyle = sp;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();

  // 위도/경도 그리드
  ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.clip();
  ctx.strokeStyle = 'rgba(6,182,212,0.2)'; ctx.lineWidth = 1;
  for (let lat=-60; lat<=60; lat+=30) {
    const ry=R*Math.cos(lat*Math.PI/180), rz=R*Math.sin(lat*Math.PI/180);
    ctx.beginPath(); ctx.ellipse(cx, cy+rz, ry, ry*0.22, 0, 0, Math.PI*2); ctx.stroke();
  }
  for (let lon=0; lon<180; lon+=36) {
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(lon*Math.PI/180);
    ctx.beginPath(); ctx.ellipse(0,0,R*0.22,R,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  // 테두리 링
  ctx.strokeStyle='#06b6d4'; ctx.lineWidth=3;
  ctx.shadowColor='#06b6d4'; ctx.shadowBlur=20;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke();
  ctx.shadowBlur=0;

  // 텍스트
  ctx.fillStyle='#e8f4ff'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.shadowColor='#06b6d4'; ctx.shadowBlur=10;
  ctx.font='bold 32px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
  ctx.fillText(label||'내 작업', cx, cy);
  ctx.shadowBlur=0;

  return new THREE.CanvasTexture(canvas);
}

// ─── 씬 정리 ──────────────────────────────────────────────────────────────────
function clearMyWork() {
  const sc = MW.scene; if (!sc) return;
  [...MW.cardMeshes, ...MW.lineMeshes].forEach(m => {
    sc.remove(m);
    m.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
  });
  MW.cardMeshes = []; MW.lineMeshes = [];
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
  const sc = MW.scene; if (!sc) return;
  if (typeof clearScene === 'function') clearScene();
  const cp = window._corePlanet;
  if (cp) {
    [cp.wireMesh, cp.glowMesh, cp.dustCloud].forEach(m => { if(m) sc.remove(m); });
    if (cp.orbitMeshes) cp.orbitMeshes.forEach(m => sc.remove(m));
    window._corePlanet = null;
  }
  sc.children.filter(c =>
    (c.type==='Mesh' && c.geometry?.type==='SphereGeometry' && !c.userData.isHub && !c.userData.isCard) ||
    (c.type==='Group' && !c.userData.isCard && c.userData.id!==undefined)
  ).forEach(m => sc.remove(m));
}

// ─── 연결선 (renderOrder=0 → 카드 뒤에 그려짐) ───────────────────────────────
function drawLine(from, to, colorHex) {
  const mat = new THREE.LineBasicMaterial({
    color: colorHex || 0x06b6d4,
    transparent: true, opacity: 0.45,
    depthTest: true, depthWrite: false,
  });
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(from.x, from.y, from.z),
    new THREE.Vector3(to.x,   to.y,   to.z),
  ]);
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 0;   // ← 카드보다 먼저 렌더 → 카드 뒤에 보임
  MW.scene.add(line);
  MW.lineMeshes.push(line);
}

// ─── 카드 메시 (renderOrder=1 → 연결선 위에 그려짐) ─────────────────────────
function createCard(node, pos) {
  const color = _mwExtractColor(node.color);
  const count = (node.children || []).length;
  const sub   = node.latestActivity
    || (count > 0 ? `${count}개 항목` : (node.domain || node.type || ''));
  const tex = makeCardTexture(node.topic || node.name || '작업', sub, color);
  const geo = new THREE.PlaneGeometry(5.0, 1.92);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true,
    side: THREE.DoubleSide,
    depthTest: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y + 0.96, pos.z);
  mesh.renderOrder = 1;   // ← 연결선보다 나중에 렌더 → 선이 카드 뒤로 가려짐
  mesh.userData = { nodeData: node, isCard: true };
  MW.scene.add(mesh);
  MW.cardMeshes.push(mesh);
  return mesh;
}

// ─── 허브 메시 ────────────────────────────────────────────────────────────────
function createHub(label, pos) {
  const tex = makeHubTexture(label);
  const geo = new THREE.PlaneGeometry(3.2, 3.2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true,
    side: THREE.DoubleSide,
    depthTest: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y + 1.6, pos.z);
  mesh.renderOrder = 1;
  mesh.userData = { isHub: true };
  MW.scene.add(mesh);
  MW.hubMesh = mesh;
  return mesh;
}

// ─── 카메라 중앙 이동 ─────────────────────────────────────────────────────────
function _mwFocusCamera(hubPos, radius) {
  const r = Math.max(18, (radius || 22) * 2.1);
  if (typeof lerpCameraTo === 'function') {
    lerpCameraTo(r, hubPos.x, hubPos.y, hubPos.z, 350);
  } else if (typeof controls !== 'undefined' && controls.tgt && controls.sph) {
    controls.tgt.set(hubPos.x, hubPos.y, hubPos.z);
    controls.sph.r = r;
    if (typeof controls._apply === 'function') controls._apply();
  } else if (window.camera) {
    window.camera.position.set(hubPos.x, r*0.3, hubPos.z + r*0.95);
    window.camera.lookAt(hubPos.x, hubPos.y, hubPos.z);
  }
}

// ─── 뷰 렌더링 ────────────────────────────────────────────────────────────────
function renderView(nodes, hubLabel, positions, hubPos) {
  const hp = hubPos || { x:0, y:0, z:0 };
  clearAllPlanets();
  clearMyWork();

  createHub(hubLabel, hp);

  const count = Math.min(nodes.length, positions.length);
  for (let i = 0; i < count; i++) {
    const pos = { x: hp.x+positions[i].x, y: hp.y+positions[i].y, z: hp.z+positions[i].z };
    createCard(nodes[i], pos);
    const hexStr = _mwExtractColor(nodes[i].color,'#334155').replace('#','');
    drawLine(
      { x:hp.x, y:hp.y+0.5, z:hp.z },        // 허브 중심 (낮은 y)
      { x:pos.x, y:pos.y+0.96, z:pos.z },     // 카드 중심
      parseInt(hexStr, 16)
    );
  }

  MW.currentNodes     = nodes;
  MW.currentHubLabel  = hubLabel;
  MW.currentPositions = positions;

  // 카드 분포 반경 → 적정 카메라 거리
  const farthest = positions.slice(0, count).reduce((mx,p) =>
    Math.max(mx, Math.hypot(p.x, p.z)), 0);
  _mwFocusCamera(hp, farthest);
}

// ─── 카드 클릭 핸들러 ─────────────────────────────────────────────────────────
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
  if (hit.userData.isHub && MW.viewStack.length > 0) {
    const prev = MW.viewStack.pop();
    renderView(prev.nodes, prev.hubLabel, prev.positions);
    return;
  }

  // 카드 클릭 → 드릴다운
  if (hit.userData.isCard) {
    const node     = hit.userData.nodeData;
    const children = (node.children || node.subtopics || node.events || []).slice();

    if (children.length === 0) {
      if (typeof showToast === 'function')
        showToast(`${node.topic||node.name} — 더 이상 하위 항목이 없습니다`, 2000);
      return;
    }

    // 스택에 현재 상태 저장 (돌아올 때 사용)
    MW.viewStack.push({
      nodes:     MW.currentNodes.slice(),
      hubLabel:  MW.currentHubLabel,
      positions: MW.currentPositions || CARD_POSITIONS,
    });

    // 레벨에 따라 다음 위치 배열 결정
    const depth       = MW.viewStack.length; // 방금 push했으므로 이미 +1
    const nextPos     = depth === 1 ? CHILD_POSITIONS : GRAND_POSITIONS;
    const maxCards    = nextPos.length;

    const childNodes  = children.slice(0, maxCards).map(c =>
      typeof c === 'string'
        ? { topic: c, name: c, color: node.color || '#06b6d4', children: [] }
        : { ...c, color: c.color || node.color || '#06b6d4' }
    );

    renderView(childNodes, node.topic || node.name, nextPos);
  }
}

// ─── 스프라이트 빌보드 (camera.quaternion 복사 → 텍스트 완전 수평) ────────────
// lookAt/atan2보다 정확: 카메라 기울어진 각도까지 반영해 텍스트가 항상 정면
function updateBillboard() {
  if (!window.camera) return;
  const q = window.camera.quaternion;
  const items = [...MW.cardMeshes];
  if (MW.hubMesh) items.push(MW.hubMesh);
  items.forEach(m => m.quaternion.copy(q));
}

// ─── buildPlanetSystem 오버라이드 ────────────────────────────────────────────
window._origBuildPlanetSystem = window.buildPlanetSystem;

window.buildPlanetSystem = function(nodeList) {
  // 팀/전사/병렬 모드는 원본 위임
  const inTeam =
    (typeof _teamMode     !== 'undefined' && _teamMode) ||
    (typeof _companyMode  !== 'undefined' && _companyMode) ||
    (typeof _parallelMode !== 'undefined' && _parallelMode);
  if (inTeam) {
    return typeof window._origBuildPlanetSystem === 'function'
      ? window._origBuildPlanetSystem(nodeList) : undefined;
  }

  if (!window.scene) {
    const w = setInterval(() => {
      if (window.scene) { clearInterval(w); window.buildPlanetSystem(nodeList); }
    }, 200);
    return;
  }

  // 드릴다운 중(viewStack > 0)이면 WS 실시간 데이터에도 뷰를 유지
  if (MW.viewStack.length > 0) return;

  MW.scene     = window.scene;
  MW.viewStack = [];

  // purposeLabel 기준 그룹화 → 0단계 카드
  const groupMap = {};
  (nodeList || []).forEach(n => {
    const key = n.purposeLabel || n.domain || n.type || '기타';
    if (!groupMap[key]) {
      groupMap[key] = {
        topic:          key,
        name:           key,
        color:          n.purposeColor || _mwExtractColor(n.color),
        children:       [],
        latestActivity: null,
      };
    }
    // 1단계 자식에 2단계 세부정보 심어 넣기
    const childColor = n.purposeColor || _mwExtractColor(n.color);
    groupMap[key].children.push({
      topic:          n.label || n.topic || n.name || '작업',
      name:           n.label || n.name  || '작업',
      color:          childColor,
      children:       _mwMakeDetailNodes(n, childColor),  // ← 2단계
      _raw:           n,
    });
    if (!groupMap[key].latestActivity)
      groupMap[key].latestActivity = n.label || n.topic || n.name || null;
  });

  const topNodes = Object.values(groupMap)
    .sort((a,b) => b.children.length - a.children.length)
    .slice(0, CARD_POSITIONS.length);

  renderView(topNodes, '내 작업', CARD_POSITIONS);

  // 클릭 이벤트 등록 (renderer.domElement 우선)
  const cvs = (typeof renderer !== 'undefined' && renderer.domElement)
    || document.getElementById('orbit-canvas')
    || document.querySelector('canvas');
  if (cvs && !cvs._mwClickBound) {
    cvs.addEventListener('click', onMyWorkClick);
    cvs._mwClickBound = true;
  }

  // 빌보드 RAF 루프 (한 번만 등록)
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
    if (typeof exitTeamMode === 'function' &&
        typeof _teamMode !== 'undefined' && (_teamMode || _companyMode))
      try { exitTeamMode(); } catch(e) {}
    if (typeof exitParallelMode === 'function' &&
        typeof _parallelMode !== 'undefined' && _parallelMode)
      try { exitParallelMode(); } catch(e) {}
    if (typeof _prev === 'function') try { _prev(...args); } catch(e) {}
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
