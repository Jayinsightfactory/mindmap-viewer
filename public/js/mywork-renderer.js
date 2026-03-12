/**
 * mywork-renderer.js  v5
 * - renderOrder: 연결선(0) < 허브(1) < 카드(2) → 카드가 항상 허브 앞에
 * - 동적 링 배치: 360°/N 균등 분할, CARD_W/H 비율 감안한 반지름
 * - 카드 텍스트 2줄 표시 (제목 + 항목수/최근활동)
 * - 카테고리 정규화 (file/idle 등 → 한국어)
 * - 3단계 드릴다운 / 스프라이트 빌보드
 */

// ─── 카드 물리 크기 (Three.js 단위) ──────────────────────────────────────────
const CARD_W  = 4.5;  // PlaneGeometry 가로
const CARD_H  = 2.1;  // 세로 (텍스트 2줄 공간 확보, 캔버스 512×240 비율)

// 레벨별 최소 반지름·최대 카드 수
// minR: 허브(3.2 크기) 클리어런스 최소값, gap: 카드 간 여유 (1.0=완전 밀착)
const LEVEL_CFG = [
  { minR: 4,   maxCards: 13, gap: 1.08 },  // 0단계: 카테고리
  { minR: 4,   maxCards: 10, gap: 1.08 },  // 1단계: 이벤트
  { minR: 3.5, maxCards:  6, gap: 1.08 },  // 2단계: 세부정보
];

/**
 * 동적 원형 위치 계산
 * 이웃 카드 사이 호(arc) ≥ CARD_W × gap 이 되도록 반지름 결정
 */
function makeRingPositions(count, levelIdx) {
  if (count === 0) return [];
  const li  = Math.min(levelIdx || 0, LEVEL_CFG.length - 1);
  const cfg = LEVEL_CFG[li];
  const r   = Math.max(cfg.minR, (count * CARD_W * cfg.gap) / (Math.PI * 2));
  const ang = -Math.PI / 2; // 12시 방향 시작
  return Array.from({ length: count }, (_, i) => {
    const a = ang + (i / count) * Math.PI * 2;
    return { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r };
  });
}

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const MW = {
  hubMesh:         null,
  cardMeshes:      [],
  lineMeshes:      [],
  currentNodes:    [],
  currentHubLabel: '내 작업',
  currentLevel:    0,     // 현재 드릴 단계 (0/1/2)
  viewStack:       [],    // [{nodes, hubLabel, levelIdx}]
  scene:           null,
  raycaster:       new THREE.Raycaster(),
  mouse:           new THREE.Vector2(),
  animating:       false,
};

// ─── 색상 유틸 ────────────────────────────────────────────────────────────────
function _mwExtractColor(color, fallback) {
  const fb = fallback || '#06b6d4';
  if (!color) return fb;
  if (typeof color === 'string') return color;
  if (typeof color === 'number') return '#' + color.toString(16).padStart(6, '0');
  if (typeof color === 'object') return color.background || color.border || color.hex || fb;
  return fb;
}
function _mwHex2rgb(hex) {
  const h = (hex || '#06b6d4').replace('#', '');
  return {
    r: parseInt(h.slice(0,2),16)||6,
    g: parseInt(h.slice(2,4),16)||182,
    b: parseInt(h.slice(4,6),16)||212,
  };
}

// ─── 카테고리 정규화 ──────────────────────────────────────────────────────────
const _MW_CAT_MAP = {
  // 영문 raw → 한국어
  'file':          '📁 파일 작업',
  'idle':          '⏸ 대기',
  'code':          '💻 코딩',
  'coding':        '💻 코딩',
  'browser':       '🌐 웹 작업',
  'terminal':      '⚡ 터미널',
  'design':        '🎨 디자인',
  'document':      '📄 문서 작업',
  'meeting':       '💬 미팅/소통',
  'test':          '🧪 테스트',
  'deploy':        '🚀 배포/운영',
  'research':      '🔍 조사/분석',
  'planning':      '📋 기획/설계',
  'feature':       '⚙️ 기능 개발',
  'bugfix':        '🐛 버그 수정',
  'review':        '👀 코드 리뷰',
  'communication': '💬 소통',
  'etc':           '📌 기타',
  'other':         '📌 기타',
};
// 카테고리별 강조색
const _MW_CAT_COLOR = {
  '📁 파일 작업':  '#64748b',
  '⏸ 대기':       '#475569',
  '💻 코딩':       '#3b82f6',
  '🌐 웹 작업':    '#0ea5e9',
  '⚡ 터미널':     '#22c55e',
  '🎨 디자인':     '#ec4899',
  '📄 문서 작업':  '#a78bfa',
  '💬 미팅/소통':  '#f97316',
  '🧪 테스트':     '#06b6d4',
  '🚀 배포/운영':  '#10b981',
  '🔍 조사/분석':  '#f59e0b',
  '📋 기획/설계':  '#8b5cf6',
  '⚙️ 기능 개발':  '#3b82f6',
  '🐛 버그 수정':  '#ef4444',
  '👀 코드 리뷰':  '#14b8a6',
  '💬 소통':       '#f97316',
  '📌 기타':       '#94a3b8',
};
function _mwNormCat(raw) {
  if (!raw) return '📌 기타';
  const k = raw.toLowerCase().trim();
  return _MW_CAT_MAP[k] || raw;
}

// ─── 2단계용 세부 노드 생성 ───────────────────────────────────────────────────
function _mwMakeDetailNodes(rawNode, parentColor) {
  const pc = parentColor || '#06b6d4';
  const mk = (topic, name, color) => ({
    topic, name: String(name || '').slice(0, 40),
    color, children: [],
  });
  const out = [];
  const ts = rawNode.timestamp || rawNode.createdAt || rawNode.time;
  if (ts) {
    const dt = new Date(ts);
    const label = isNaN(dt.getTime()) ? String(ts).slice(0,20)
      : dt.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
    out.push(mk('🕐 시간', label, '#64748b'));
  }
  const sid = rawNode.session || rawNode.sessionId || rawNode.session_id;
  if (sid) out.push(mk('🔗 세션', String(sid).slice(0,20), '#8b5cf6'));
  if (rawNode.domain || rawNode.category)
    out.push(mk('🌐 도메인', rawNode.domain || rawNode.category, '#06b6d4'));
  if (rawNode.type || rawNode.eventType || rawNode.purposeLabel)
    out.push(mk('🏷️ 유형', rawNode.type || rawNode.eventType || rawNode.purposeLabel, '#f59e0b'));
  if (rawNode.projectName || rawNode.project || rawNode.repo)
    out.push(mk('📁 프로젝트', rawNode.projectName || rawNode.project || rawNode.repo, '#10b981'));
  if (rawNode.detail || rawNode.description || rawNode.summary)
    out.push(mk('📝 요약', rawNode.detail || rawNode.description || rawNode.summary, '#ec4899'));
  if (out.length === 0)
    out.push(mk('📋 상세', rawNode.label || rawNode.name || rawNode.id || '없음', pc));
  return out.slice(0, LEVEL_CFG[2].maxCards);
}

// ─── 카드 텍스처 (3D 그리드 행성 스타일, 텍스트 2줄) ─────────────────────────
// sub1: 항목 수 / 유형   sub2: 최근 활동 / 세부
function makeCardTexture(title, sub1, sub2, accentColor) {
  const W = 1024, H = 480;  // 2× 해상도로 선명한 텍스트
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);           // 모든 좌표를 절반으로 — 실제 렌더 영역 512×240 유지
  const ac  = accentColor || '#06b6d4';
  const rgb = _mwHex2rgb(ac);

  // 배경 딥우주 그라디언트
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0,   `rgba(4,10,24,0.98)`);
  bg.addColorStop(0.7, `rgba(8,18,40,0.97)`);
  bg.addColorStop(1,   `rgba(${rgb.r*0.12|0},${rgb.g*0.12|0},${rgb.b*0.12|0},0.97)`);
  const Rv = 16;
  ctx.beginPath();
  ctx.moveTo(Rv,0); ctx.lineTo(W-Rv,0);
  ctx.quadraticCurveTo(W,0,W,Rv); ctx.lineTo(W,H-Rv);
  ctx.quadraticCurveTo(W,H,W-Rv,H); ctx.lineTo(Rv,H);
  ctx.quadraticCurveTo(0,H,0,H-Rv); ctx.lineTo(0,Rv);
  ctx.quadraticCurveTo(0,0,Rv,0); ctx.closePath();
  ctx.fillStyle = bg; ctx.fill();

  // 그리드 라인
  ctx.save(); ctx.clip();
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.08)`;
  ctx.lineWidth = 0.7;
  for (let y = 0; y < H; y += 20) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  for (let x = 0; x < W; x += 20) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  ctx.restore();

  // 왼쪽 액센트 바
  const bar = ctx.createLinearGradient(0,0,0,H);
  bar.addColorStop(0,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  bar.addColorStop(0.5, `rgba(${rgb.r},${rgb.g},${rgb.b},1.0)`);
  bar.addColorStop(1,   `rgba(${rgb.r},${rgb.g},${rgb.b},0.0)`);
  ctx.fillStyle = bar; ctx.fillRect(0,0,5,H);

  // 글로우 테두리
  ctx.shadowColor = ac; ctx.shadowBlur = 12;
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.55)`;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(Rv,0); ctx.lineTo(W-Rv,0);
  ctx.quadraticCurveTo(W,0,W,Rv); ctx.lineTo(W,H-Rv);
  ctx.quadraticCurveTo(W,H,W-Rv,H); ctx.lineTo(Rv,H);
  ctx.quadraticCurveTo(0,H,0,H-Rv); ctx.lineTo(0,Rv);
  ctx.quadraticCurveTo(0,0,Rv,0); ctx.closePath();
  ctx.stroke(); ctx.shadowBlur = 0;

  const maxW = W - 28;
  function drawLine(text, y, font, color, glow) {
    if (!text) return;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    if (glow) { ctx.shadowColor = ac; ctx.shadowBlur = 5; }
    let s = String(text);
    while (ctx.measureText(s).width > maxW && s.length > 1) s = s.slice(0,-1);
    if (s !== String(text)) s += '…';
    ctx.fillText(s, 16, y);
    ctx.shadowBlur = 0;
  }

  // 제목 (굵고 크게 — 상단 30%)
  drawLine(
    title || '작업',
    H * 0.26,  // y ≈ 62px
    'bold 34px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif',
    '#e8f4ff', true
  );

  // 구분선
  ctx.strokeStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.2)`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(16, H*0.46); ctx.lineTo(W-16, H*0.46); ctx.stroke();

  // 서브1 (액센트 색 — 중간)
  drawLine(
    sub1 || '',
    H * 0.62,  // y ≈ 149px
    '21px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif',
    `rgba(${rgb.r},${rgb.g},${rgb.b},0.95)`, false
  );

  // 서브2 (흐린 색 — 하단)
  drawLine(
    sub2 || '',
    H * 0.82,  // y ≈ 197px
    '18px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif',
    'rgba(148,163,184,0.85)', false
  );

  // 우측 상단 펄스 점
  ctx.beginPath(); ctx.arc(W-18, 18, 5, 0, Math.PI*2);
  ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.9)`;
  ctx.shadowColor = ac; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;

  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 16;   // 각도 블러 방지
  tex.needsUpdate = true;
  return tex;
}

// ─── 허브 텍스처 (행성 구체) ──────────────────────────────────────────────────
function makeHubTexture(label) {
  const S=320, cx=S/2, cy=S/2, R=S*0.44;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');

  let glow = ctx.createRadialGradient(cx,cy,R*0.4,cx,cy,R*1.15);
  glow.addColorStop(0,'rgba(6,182,212,0.3)'); glow.addColorStop(1,'rgba(6,182,212,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(cx,cy,R*1.15,0,Math.PI*2); ctx.fill();

  let sp = ctx.createRadialGradient(cx-R*0.28,cy-R*0.22,R*0.04,cx,cy,R);
  sp.addColorStop(0,'rgba(22,55,88,0.99)');
  sp.addColorStop(0.5,'rgba(8,26,54,0.99)');
  sp.addColorStop(1,'rgba(4,12,30,0.99)');
  ctx.fillStyle = sp;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();

  ctx.save(); ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.clip();
  ctx.strokeStyle='rgba(6,182,212,0.2)'; ctx.lineWidth=1;
  for (let lat=-60; lat<=60; lat+=30) {
    const ry=R*Math.cos(lat*Math.PI/180), rz=R*Math.sin(lat*Math.PI/180);
    ctx.beginPath(); ctx.ellipse(cx,cy+rz,ry,ry*0.22,0,0,Math.PI*2); ctx.stroke();
  }
  for (let lon=0; lon<180; lon+=36) {
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(lon*Math.PI/180);
    ctx.beginPath(); ctx.ellipse(0,0,R*0.22,R,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  ctx.strokeStyle='#06b6d4'; ctx.lineWidth=3;
  ctx.shadowColor='#06b6d4'; ctx.shadowBlur=20;
  ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.stroke(); ctx.shadowBlur=0;

  ctx.fillStyle='#e8f4ff'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.shadowColor='#06b6d4'; ctx.shadowBlur=10;
  ctx.font='bold 32px "Apple SD Gothic Neo","Malgun Gothic","NanumGothic",sans-serif';
  // 허브 텍스트 길이 제한
  let hl = String(label || '내 작업');
  if (hl.length > 10) hl = hl.slice(0, 9) + '…';
  ctx.fillText(hl, cx, cy); ctx.shadowBlur=0;

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

// ─── 연결선 (renderOrder=0 → 카드 뒤에) ──────────────────────────────────────
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
  line.renderOrder = 0;
  MW.scene.add(line);
  MW.lineMeshes.push(line);
}

// ─── 카드 메시 (renderOrder=2 → 허브(1)보다 항상 앞에 렌더) ─────────────────
function createCard(node, pos) {
  const color = _mwExtractColor(node.color);
  const count = (node.children || []).length;

  // 서브1: 항목 수 or 유형/도메인
  const sub1 = count > 0
    ? `하위 ${count}개 항목`
    : (node.domain || node.type || node.eventType || '');

  // 서브2: 최근 활동명 (있을 때만)
  const sub2 = node.latestActivity
    ? String(node.latestActivity).slice(0, 38)
    : (node.name && node.name !== node.topic ? String(node.name).slice(0, 38) : '');

  const tex = makeCardTexture(node.topic || node.name || '작업', sub1, sub2, color);
  const geo = new THREE.PlaneGeometry(CARD_W, CARD_H);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true,
    side: THREE.DoubleSide,
    depthTest: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(pos.x, pos.y + CARD_H * 0.5, pos.z);
  mesh.renderOrder = 2;   // 허브(1)보다 나중에 렌더 → 허브 뒤로 숨지 않음
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

// ─── 카메라 포커스 ────────────────────────────────────────────────────────────
function _mwFocusCamera(hubPos, ringRadius) {
  // 링 반지름에 비례해 카메라 거리 결정 (카드가 모두 시야에 들어오도록)
  const dist = Math.max(14, ringRadius * 2.4 + 4);
  if (typeof lerpCameraTo === 'function') {
    lerpCameraTo(dist, hubPos.x, hubPos.y, hubPos.z, 350);
  } else if (typeof controls !== 'undefined' && controls.tgt && controls.sph) {
    controls.tgt.set(hubPos.x, hubPos.y, hubPos.z);
    controls.sph.r = dist;
    if (typeof controls._apply === 'function') controls._apply();
  } else if (window.camera) {
    window.camera.position.set(hubPos.x, dist * 0.3, hubPos.z + dist * 0.95);
    window.camera.lookAt(hubPos.x, hubPos.y, hubPos.z);
  }
}

// ─── 뷰 렌더링 (levelIdx 기반 동적 포지션) ────────────────────────────────────
function renderView(nodes, hubLabel, levelIdx, hubPos) {
  const li = Math.min(levelIdx || 0, LEVEL_CFG.length - 1);
  const hp = hubPos || { x: 0, y: 0, z: 0 };

  clearAllPlanets();
  clearMyWork();

  createHub(hubLabel, hp);

  const maxCards = LEVEL_CFG[li].maxCards;
  const visNodes = nodes.slice(0, maxCards);
  const positions = makeRingPositions(visNodes.length, li);

  for (let i = 0; i < visNodes.length; i++) {
    const p   = positions[i];
    const pos = { x: hp.x + p.x, y: hp.y + p.y, z: hp.z + p.z };
    createCard(visNodes[i], pos);
    const hexStr = _mwExtractColor(visNodes[i].color, '#334155').replace('#', '');
    drawLine(
      { x: hp.x,   y: hp.y + 0.5,        z: hp.z },
      { x: pos.x,  y: pos.y + CARD_H * 0.5, z: pos.z },
      parseInt(hexStr, 16)
    );
  }

  MW.currentNodes    = nodes;
  MW.currentHubLabel = hubLabel;
  MW.currentLevel    = li;

  // 실제 링 반지름 계산해 카메라 맞춤
  const ringR = positions.length > 0
    ? Math.max(...positions.map(p => Math.hypot(p.x, p.z)))
    : LEVEL_CFG[li].minR;
  _mwFocusCamera(hp, ringR);
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
    renderView(prev.nodes, prev.hubLabel, prev.levelIdx);
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

    // 현재 상태 스택에 저장
    MW.viewStack.push({
      nodes:    MW.currentNodes.slice(),
      hubLabel: MW.currentHubLabel,
      levelIdx: MW.currentLevel,
    });

    const nextLevel  = MW.currentLevel + 1;
    const maxCards   = LEVEL_CFG[Math.min(nextLevel, LEVEL_CFG.length - 1)].maxCards;

    const childNodes = children.slice(0, maxCards).map(c =>
      typeof c === 'string'
        ? { topic: c, name: c, color: node.color || '#06b6d4', children: [] }
        : { ...c, color: c.color || node.color || '#06b6d4' }
    );

    renderView(childNodes, node.topic || node.name, nextLevel);
  }
}

// ─── 스프라이트 빌보드 ────────────────────────────────────────────────────────
function updateBillboard() {
  if (!window.camera) return;
  const q     = window.camera.quaternion;
  const items = [...MW.cardMeshes];
  if (MW.hubMesh) items.push(MW.hubMesh);
  items.forEach(m => m.quaternion.copy(q));
}

// ─── buildPlanetSystem 오버라이드 ────────────────────────────────────────────
window._origBuildPlanetSystem = window.buildPlanetSystem;

window.buildPlanetSystem = function(nodeList) {
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

  // ── workspace → personal 전환 시 multilevel scene 완전 정리 ─────────────
  // ⚠️ workspace/team/company 모드에서 WS 이벤트로 buildPlanetSystem이 호출되면
  //    cleanupMultilevel() 실행 → 워크스페이스 뷰 파괴되므로 모드 확인 필수
  const _rmMode = window.RendererManager?.currentMode;
  if (_rmMode && _rmMode !== 'personal') {
    // 비-personal 모드: 행성 재빌드 자체를 중단 (workspace/team 뷰 보호)
    return;
  }
  if (window.RendererManager) {
    window.RendererManager.cleanupMultilevel();
  } else if (window.multiLevelRenderer) {
    // 폴백: 직접 정리
    const mlr = window.multiLevelRenderer;
    Object.values(mlr.nodeMeshes || {}).forEach(m => window.scene.remove(m));
    mlr.nodeMeshes = {};
    (mlr.connectionLines || []).forEach(l => window.scene.remove(l));
    mlr.connectionLines = [];
    if (typeof closeDrillPanel === 'function') closeDrillPanel();
  }

  // 드릴다운 중이면 WS 실시간 데이터로 뷰 리셋 방지
  if (MW.viewStack.length > 0) return;

  MW.scene     = window.scene;
  MW.viewStack = [];

  // purposeLabel 기준 그룹화 → 0단계 카드 (카테고리 정규화 적용)
  const groupMap = {};
  (nodeList || []).forEach(n => {
    const rawKey = n.purposeLabel || n.domain || n.type || '기타';
    const key    = _mwNormCat(rawKey);  // 영문 → 한국어 정규화
    if (!groupMap[key]) {
      // 카테고리 색: purposeColor → CAT_COLOR → 랜덤 액센트
      const catColor = n.purposeColor
        || _MW_CAT_COLOR[key]
        || _mwExtractColor(n.color);
      groupMap[key] = {
        topic:          key,
        name:           key,
        color:          catColor,
        children:       [],
        latestActivity: null,
      };
    }
    const childColor = n.purposeColor || _mwExtractColor(n.color);
    groupMap[key].children.push({
      topic:    n.label || n.topic || n.name || '작업',
      name:     n.label || n.name  || '작업',
      color:    childColor,
      children: _mwMakeDetailNodes(n, childColor),
      _raw:     n,
    });
    if (!groupMap[key].latestActivity)
      groupMap[key].latestActivity = n.label || n.topic || n.name || null;
  });

  const topNodes = Object.values(groupMap)
    .sort((a, b) => b.children.length - a.children.length)
    .slice(0, LEVEL_CFG[0].maxCards);

  renderView(topNodes, '내 작업', 0);

  // 클릭 이벤트 (renderer.domElement 우선)
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
      else renderView([], '내 작업', 0);
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
