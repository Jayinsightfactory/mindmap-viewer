import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// ═══════════════════════════════════════════════════
// ORBIT 3D ENGINE — Three.js WebGL
// ═══════════════════════════════════════════════════

// ── Three.js 씬 초기화 ──
const container = document.getElementById('three-container');
const scene     = new THREE.Scene();
scene.background = new THREE.Color(0x060a10);
scene.fog        = new THREE.FogExp2(0x060a10, 0.00025);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 10000);
camera.position.set(0, 0, 800);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
container.appendChild(renderer.domElement);

// CSS2DRenderer — 노드 라벨 오버레이
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(innerWidth, innerHeight);
labelRenderer.domElement.style.position = 'absolute';
labelRenderer.domElement.style.top = '0';
labelRenderer.domElement.style.pointerEvents = 'none';
labelRenderer.domElement.style.zIndex = '5';
container.appendChild(labelRenderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping   = true;
controls.dampingFactor   = 0.08;
controls.enableRotate    = false;
controls.zoomSpeed       = 1.2;
controls.minDistance     = 50;
controls.maxDistance     = 5000;
controls.mouseButtons    = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

// ── 조명 ──
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(200, 400, 300);
scene.add(dirLight);
const pointLight = new THREE.PointLight(0x58a6ff, 0.6, 2000);
pointLight.position.set(0, 0, 500);
scene.add(pointLight);

// ── 배경 별 (Points) ──
const STAR_COUNT = 400;
const starPositions = new Float32Array(STAR_COUNT * 3);
for (let i = 0; i < STAR_COUNT; i++) {
  starPositions[i * 3]     = (Math.random() - 0.5) * 8000;
  starPositions[i * 3 + 1] = (Math.random() - 0.5) * 8000;
  starPositions[i * 3 + 2] = (Math.random() - 0.5) * 2000 - 1000;
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
const starMat = new THREE.PointsMaterial({ color: 0xc8dcff, size: 1.5, sizeAttenuation: true, transparent: true, opacity: 0.6 });
scene.add(new THREE.Points(starGeo, starMat));

// ── InstancedMesh 노드 ──
const MAX_NODES = 600;
const nodeGeoHigh = new THREE.SphereGeometry(1, 16, 12);
const nodeGeoLow  = new THREE.SphereGeometry(1, 8, 6);
const nodeMat = new THREE.MeshPhongMaterial({ shininess: 80 });
const instancedMesh = new THREE.InstancedMesh(nodeGeoHigh, nodeMat, MAX_NODES);
instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
instancedMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 3), 3);
instancedMesh.count = 0;
scene.add(instancedMesh);

// 호버 하이라이트 구체
const hoverMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false })
);
hoverMesh.visible = false;
scene.add(hoverMesh);

// ── LineSegments 엣지 ──
const MAX_EDGES = 2000;
const edgePosAttr = new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 6), 3);
const edgeColAttr = new THREE.BufferAttribute(new Float32Array(MAX_EDGES * 6), 3);
edgePosAttr.setUsage(THREE.DynamicDrawUsage);
edgeColAttr.setUsage(THREE.DynamicDrawUsage);
const edgeGeo = new THREE.BufferGeometry();
edgeGeo.setAttribute('position', edgePosAttr);
edgeGeo.setAttribute('color',    edgeColAttr);
const edgeMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.35 });
const lineSegments = new THREE.LineSegments(edgeGeo, edgeMat);
scene.add(lineSegments);

// ── 데이터 상태 ──
let nodes   = [];
let edgeList = [];
let orbitOn  = true;
let raf      = null;
let hoverId  = null;
let t        = 0;
let currentVisibleNodes = [];
let MAX_VISIBLE_NODES = 300;

// ── 멀티 선택 상태 (F4: 노드 소프트 삭제) ──
const selectedNodes = new Set();   // 선택된 node id
let _dragSelecting = false;
let _dragSelStart  = null;         // {x, y} screen coords
let _dragSelBox    = null;         // DOM element

// ── CSS2D 노드 라벨 풀 ──
// 라벨은 MAX_LABELS개까지 재사용 (성능 최적화)
const MAX_LABELS = 80;
const labelPool  = [];  // CSS2DObject 풀
for (let i = 0; i < MAX_LABELS; i++) {
  const div = document.createElement('div');
  div.className = 'node-label';
  const obj = new CSS2DObject(div);
  obj.visible = false;
  scene.add(obj);
  labelPool.push({ obj, div });
}

function updateNodeLabels(visibleNodes) {
  const z = camera.position.z;
  // 줌 레벨에 따라 라벨 표시 범위 결정
  // z < 300: 모든 visible 노드 / z < 600: 세션+센터만 / z >= 600: 숨김
  const showAll     = z < 300;
  const showSession = z < 700;

  let labelIdx = 0;

  for (const n of visibleNodes) {
    if (labelIdx >= MAX_LABELS) break;

    const shouldShow =
      showAll ||
      (showSession && (n.level >= 1)) ||
      n.id === 'center';

    if (!shouldShow) continue;

    const { obj, div } = labelPool[labelIdx++];
    const text = n.label || n.type || n.id;
    div.textContent = text.length > 18 ? text.slice(0, 17) + '…' : text;

    // 노드 타입별 CSS 클래스
    div.className = 'node-label' +
      (n.id === 'center' ? ' center' : '') +
      (n.level >= 1 ? ' session' : '');

    obj.position.set(n.x, n.y + nodeRadius(n) * 1.15, n.z || 0);
    obj.visible = true;
  }

  // 나머지 라벨 숨김
  for (let i = labelIdx; i < MAX_LABELS; i++) {
    labelPool[i].obj.visible = false;
  }
}

// ── VFX 상태 ──
const VFX = {
  pulses: {},       // nodeId → { time, color }
  dataFlows: [],    // { fromId, toId, progress, color, speed, mesh }
  supportBeams: {}, // nodeId → { color, phase }
};

// 노드 펄스 등록
function pulseNode(nodeId, color) {
  VFX.pulses[nodeId] = { time: performance.now(), color: color || '#58a6ff' };
}

// 데이터 흐름 스폰
function spawnDataFlow(fromId, toId, color) {
  VFX.dataFlows.push({ fromId, toId, progress: 0, color: color || '#39d2c0', speed: 0.008 });
}

// 서포트 빔
function attachSupportBeam(nodeId, color, phase) {
  VFX.supportBeams[nodeId] = { color: color || '#8957e5', phase: phase || Math.random() * Math.PI * 2 };
}

// ── 레벨 정의 ──
const LEVELS = [
  { id: 0, name: '개인 작업', emoji: '🌍', color: '#39d2c0', zMin: 600 },
  { id: 1, name: '세션',     emoji: '💬', color: '#58a6ff', zMin: 400 },
  { id: 2, name: '프로젝트', emoji: '📁', color: '#3fb950', zMin: 200 },
  { id: 3, name: '멤버',     emoji: '🧑', color: '#bc8cff', zMin: 100 },
  { id: 4, name: '팀',       emoji: '👥', color: '#ffa657', zMin: 50 },
  { id: 5, name: '조직',     emoji: '🏢', color: '#f778ba', zMin: 20 },
  { id: 6, name: '연합',     emoji: '🌌', color: '#8957e5', zMin: 0 },
];

function getCurrentLevel() {
  const z = camera.position.z;
  for (let i = 0; i < LEVELS.length; i++) {
    if (z >= LEVELS[i].zMin) return LEVELS[i];
  }
  return LEVELS[LEVELS.length - 1];
}

// ── 노드 색상/반지름 ──
const TYPE_COLORS = {
  'user.message':      '#58a6ff',
  'assistant.message': '#3fb950',
  'tool.end':          '#bc8cff',
  'tool.start':        '#8957e5',
  'session.start':     '#39d2c0',
  'session.end':       '#6b7280',
  'file.read':         '#ffa657',
  'file.write':        '#f778ba',
  'file.create':       '#f778ba',
  'task.complete':     '#3fb950',
  'annotation.add':    '#e3b341',
  'default':           '#8b949e',
};

const AI_COLORS = {
  claude:'#3fb950', openai:'#8b949e', n8n:'#ea4b71',
  vscode:'#f85149', perplexity:'#bc8cff', gemini:'#4285f4',
  notion:'#e8e8e8', calendar:'#4285f4', slack:'#e8a0ff',
  discord:'#5865f2', zoom:'#2d8cff',
};

let purposeMode = false;
let currentPurposeFilter = '';
let purposeCategories = {};

function nodeColor(n) {
  if (purposeMode && n.purposeColor) return n.purposeColor;
  if (n.color && typeof n.color === 'object' && n.color.background) return n.color.background;
  if (n.aiSource && AI_COLORS[n.aiSource]) return AI_COLORS[n.aiSource];
  return TYPE_COLORS[n.type] || TYPE_COLORS.default;
}

function nodeRadius(n) {
  const base = n.level === 0 ? 18 : n.level === 1 ? 30 : n.level === 2 ? 50 : 70;
  return base * (n.weight || 1);
}

// ── 카메라 이동 (desiredLookAt + camTargetZ) ──
const desiredLookAt = new THREE.Vector3(0, 0, 0);
let camTargetZ = 800;

function animateCamera() {
  controls.target.lerp(desiredLookAt, 0.08);
  camera.position.z += (camTargetZ - camera.position.z) * 0.1;
  camera.position.x += (controls.target.x - camera.position.x) * 0.001;
  camera.position.y += (controls.target.y - camera.position.y) * 0.001;
  controls.update();
}

// ── InstancedMesh 업데이트 ──
const _dummy = new THREE.Object3D();
const _color = new THREE.Color();

function updateInstancedMesh(visibleNodes) {
  currentVisibleNodes = visibleNodes;
  visibleNodes.forEach((n, i) => {
    _dummy.position.set(n.x, n.y, n.z || 0);
    _dummy.scale.setScalar(nodeRadius(n));
    _dummy.updateMatrix();
    instancedMesh.setMatrixAt(i, _dummy.matrix);

    _color.set(nodeColor(n));
    const pulse = VFX.pulses[n.id];
    if (pulse) {
      const age = (performance.now() - pulse.time) / 2000;
      if (age < 1) {
        const boost = 1 + (1 - age) * 0.8;
        _color.r = Math.min(1, _color.r * boost);
        _color.g = Math.min(1, _color.g * boost);
        _color.b = Math.min(1, _color.b * boost);
      } else {
        delete VFX.pulses[n.id];
      }
    }
    if (n._dimmed) { _color.multiplyScalar(0.2); }
    // 선택된 노드 하이라이트
    if (selectedNodes.has(n.id)) {
      _color.r = Math.min(1, _color.r + 0.4);
      _color.g = Math.min(1, _color.g + 0.4);
      _color.b = Math.min(1, _color.b + 0.4);
    }
    instancedMesh.setColorAt(i, _color);
  });

  // 나머지 인스턴스 숨김
  for (let i = visibleNodes.length; i < instancedMesh.count; i++) {
    _dummy.scale.setScalar(0);
    _dummy.updateMatrix();
    instancedMesh.setMatrixAt(i, _dummy.matrix);
  }
  instancedMesh.count = visibleNodes.length;
  instancedMesh.instanceMatrix.needsUpdate = true;
  instancedMesh.instanceColor.needsUpdate  = true;
}

// ── LineSegments 업데이트 ──
function updateEdges(visibleSet) {
  let edgeCount = 0;
  const pos = edgePosAttr.array;
  const col = edgeColAttr.array;

  for (const [fromId, toId] of edgeList) {
    if (edgeCount >= MAX_EDGES) break;
    if (!visibleSet.has(fromId) || !visibleSet.has(toId)) continue;
    const from = nodes.find(n => n.id === fromId);
    const to   = nodes.find(n => n.id === toId);
    if (!from || !to) continue;

    const i6 = edgeCount * 6;
    pos[i6]   = from.x; pos[i6+1] = from.y; pos[i6+2] = from.z || 0;
    pos[i6+3] = to.x;   pos[i6+4] = to.y;   pos[i6+5] = to.z   || 0;

    const fc = new THREE.Color(nodeColor(from));
    const tc = new THREE.Color(nodeColor(to));
    col[i6]   = fc.r; col[i6+1] = fc.g; col[i6+2] = fc.b;
    col[i6+3] = tc.r; col[i6+4] = tc.g; col[i6+5] = tc.b;

    edgeCount++;
  }

  edgePosAttr.needsUpdate = true;
  edgeColAttr.needsUpdate = true;
  edgeGeo.setDrawRange(0, edgeCount * 2);
}

// ── 공전 업데이트 ──
function updateOrbits(dt) {
  if (!orbitOn) return;
  t += dt * 0.0003;
  const sorted = [...nodes].sort((a, b) => (b.level || 0) - (a.level || 0));
  for (const n of sorted) {
    if (n.orbitRadius && n.orbitParent === 'center') {
      const angle = n.orbitAngle + t * n.orbitSpeed;
      n.x = Math.cos(angle) * n.orbitRadius;
      n.y = Math.sin(angle) * n.orbitRadius;
    } else if (n.orbitRadius && n.orbitParent) {
      const parent = nodes.find(p => p.id === n.orbitParent);
      if (parent) {
        const angle = n.orbitAngle + t * n.orbitSpeed;
        n.x = parent.x + Math.cos(angle) * n.orbitRadius;
        n.y = parent.y + Math.sin(angle) * n.orbitRadius;
      }
    }
  }
}

// ── 가시성 ──
function isVisible(n) {
  if (n._hidden) return false;
  const level = getCurrentLevel();
  return (n.level === undefined || n.level <= level.id + 1);
}

// ── Raycaster 인터랙션 ──
const raycaster = new THREE.Raycaster();
const pointer   = new THREE.Vector2();
let _clickStart = { x: 0, y: 0 };

renderer.domElement.addEventListener('mousedown', e => {
  _clickStart = { x: e.clientX, y: e.clientY };
  // Shift+드래그: 선택 박스 시작
  if (e.shiftKey && e.button === 0) {
    _dragSelecting = true;
    _dragSelStart = { x: e.clientX, y: e.clientY };
    if (!_dragSelBox) {
      _dragSelBox = document.createElement('div');
      _dragSelBox.style.cssText = 'position:fixed;border:1px solid #58a6ff;background:rgba(88,166,255,0.1);pointer-events:none;z-index:999;display:none;';
      document.body.appendChild(_dragSelBox);
    }
    _dragSelBox.style.display = 'block';
    _dragSelBox.style.left = e.clientX + 'px';
    _dragSelBox.style.top = e.clientY + 'px';
    _dragSelBox.style.width = '0';
    _dragSelBox.style.height = '0';
  }
});

renderer.domElement.addEventListener('click', e => {
  if (Math.hypot(e.clientX - _clickStart.x, e.clientY - _clickStart.y) > 4) return;
  const H = tlOpen ? innerHeight - 48 - 220 : innerHeight;
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -((e.clientY - 48) / H) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(instancedMesh);
  if (hits.length) {
    const n = currentVisibleNodes[hits[0].instanceId];
    if (n) {
      // Shift/Ctrl+Click: 멀티 선택 토글
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selectedNodes.has(n.id)) selectedNodes.delete(n.id);
        else selectedNodes.add(n.id);
        _updateSelectionBar();
        return;
      }
      // 일반 클릭: 선택 해제 후 원래 동작
      if (selectedNodes.size > 0) { selectedNodes.clear(); _updateSelectionBar(); }
      if (n.level >= 1) zoomIntoNode(n);
      else openSidePanel(n);
    }
  } else {
    if (selectedNodes.size > 0) { selectedNodes.clear(); _updateSelectionBar(); }
    closeSidePanel();
  }
});

renderer.domElement.addEventListener('dblclick', e => {
  const H = tlOpen ? innerHeight - 48 - 220 : innerHeight;
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -((e.clientY - 48) / H) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(instancedMesh);
  if (hits.length) {
    const n = currentVisibleNodes[hits[0].instanceId];
    if (n) zoomIntoNode(n);
  } else {
    autoFit();
  }
});

renderer.domElement.addEventListener('mousemove', e => {
  // 드래그 선택 박스 업데이트
  if (_dragSelecting && _dragSelStart && _dragSelBox) {
    const x = Math.min(e.clientX, _dragSelStart.x);
    const y = Math.min(e.clientY, _dragSelStart.y);
    const w = Math.abs(e.clientX - _dragSelStart.x);
    const h = Math.abs(e.clientY - _dragSelStart.y);
    _dragSelBox.style.left = x + 'px';
    _dragSelBox.style.top = y + 'px';
    _dragSelBox.style.width = w + 'px';
    _dragSelBox.style.height = h + 'px';
    return;
  }

  const H = tlOpen ? innerHeight - 48 - 220 : innerHeight;
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -((e.clientY - 48) / H) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(instancedMesh);
  if (hits.length) {
    const n = currentVisibleNodes[hits[0].instanceId];
    if (n && n.id !== hoverId) {
      hoverId = n.id;
      showTooltip(n, e.clientX, e.clientY);
      hoverMesh.visible = true;
      hoverMesh.position.set(n.x, n.y, (n.z || 0) + 1);
      hoverMesh.scale.setScalar(nodeRadius(n) * 1.35);
    }
  } else {
    hoverId = null;
    hideTooltip();
    hoverMesh.visible = false;
  }
});

// ── 리사이즈 ──
window.addEventListener('resize', () => {
  const H = tlOpen ? innerHeight - 48 - 220 : innerHeight;
  camera.aspect = innerWidth / H;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, H);
  labelRenderer.setSize(innerWidth, H);
});

// ── 줌 컨트롤 ──
function zcZoomIn()  { camTargetZ = Math.max(50, camTargetZ * 0.8); }
function zcZoomOut() { camTargetZ = Math.min(5000, camTargetZ * 1.25); }
function zcReset()   { camTargetZ = 800; desiredLookAt.set(0, 0, 0); }

function updateZoomControls() {
  const el = document.getElementById('zc-level');
  if (el) el.textContent = Math.round(800 / camera.position.z * 100) + '%';
  document.getElementById('scale-val').textContent = Math.round(camera.position.z);
}

// ── autoFit / focusNode / zoomIntoNode ──
function autoFit() {
  if (nodes.length === 0) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rangeX = maxX - minX + 200, rangeY = maxY - minY + 200;
  const aspect = innerWidth / innerHeight;
  const fovRad = camera.fov * Math.PI / 180;
  const zForX = (rangeX / 2) / (Math.tan(fovRad / 2) * aspect);
  const zForY = (rangeY / 2) / Math.tan(fovRad / 2);
  desiredLookAt.set(cx, cy, 0);
  camTargetZ = Math.min(Math.max(zForX, zForY) * 1.1, 5000);
}

function zoomIntoNode(n) {
  desiredLookAt.set(n.x, n.y, 0);
  camTargetZ = Math.max(50, camera.position.z * 0.35);
}

function zoomOut() {
  camTargetZ = Math.min(5000, camera.position.z * 2.5);
}

function focusNode(nodeIdOrObj) {
  const n = typeof nodeIdOrObj === 'string'
    ? nodes.find(x => x.id === nodeIdOrObj)
    : nodeIdOrObj;
  if (!n) return;
  desiredLookAt.set(n.x, n.y, 0);
  camTargetZ = Math.max(100, Math.min(camera.position.z, 400));
  closeNodeSearch();
  openSidePanel(n);
}

// ── 밀도 슬라이더 ──
function setMaxVisibleNodes(val) {
  MAX_VISIBLE_NODES = val;
  const label = document.getElementById('density-val');
  if (label) label.textContent = val;
}

// ── 줌아웃 집계 HUD ──
let _zohThrottle = 0;
function updateZoomoutHud(visibleNodes) {
  const z = camera.position.z;
  const hud = document.getElementById('zoomout-hud');
  // z > 600 이면 집계 HUD 표시
  if (z > 600) {
    hud.classList.add('show');
    // 1초마다 업데이트 (매 프레임 계산 방지)
    const now = performance.now();
    if (now - _zohThrottle < 1000) return;
    _zohThrottle = now;

    const allNodes = nodes.filter(n => isVisible(n));
    const sessions = allNodes.filter(n => n.level === 1).length;
    const events   = allNodes.filter(n => n.level === 0).length;
    const tools    = allNodes.filter(n => n.type?.startsWith('tool.')).length;
    const files    = allNodes.filter(n => n.type?.startsWith('file.')).length;

    document.getElementById('zoh-sessions').textContent = sessions;
    document.getElementById('zoh-events').textContent   = events;
    document.getElementById('zoh-tools').textContent    = tools;
    document.getElementById('zoh-files').textContent    = files;

    // AI 패턴 — 가장 많이 사용된 AI 소스
    const aiCounts = {};
    allNodes.forEach(n => { if (n.aiSource) aiCounts[n.aiSource] = (aiCounts[n.aiSource] || 0) + 1; });
    const topAi = Object.entries(aiCounts).sort((a, b) => b[1] - a[1])[0];
    if (topAi) {
      document.getElementById('zoh-ai').textContent      = topAi[0];
      document.getElementById('zoh-ai-label').textContent = `${topAi[1]}회 사용`;
    } else {
      document.getElementById('zoh-ai').textContent      = sessions > 0 ? '분석중' : '—';
      document.getElementById('zoh-ai-label').textContent = 'AI 패턴';
    }
  } else {
    hud.classList.remove('show');
  }
}

// ══════════════════════════════════════════════════════════
// AI 인사이트 시스템
// ══════════════════════════════════════════════════════════
let insightPanelOpen = false;
let _insightCache    = [];
let _insightLoading  = false;

function toggleInsightPanel() {
  insightPanelOpen = !insightPanelOpen;
  const panel = document.getElementById('insight-panel');
  const btn   = document.getElementById('insight-toggle');
  panel.classList.toggle('open', insightPanelOpen);
  btn.classList.toggle('active', insightPanelOpen);
  if (insightPanelOpen && _insightCache.length === 0) {
    loadInsights();
  }
}

async function loadInsights() {
  if (_insightLoading) return;
  _insightLoading = true;
  const listEl = document.getElementById('insight-list');
  listEl.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:11px;padding:24px 0">🔍 AI가 분석 중...</div>';

  try {
    // 서버 인사이트 엔진 호출
    const [insRes, graphRes] = await Promise.all([
      fetch('/api/insights?limit=20').then(r => r.json()).catch(() => []),
      fetch('/api/graph').then(r => r.json()).catch(() => ({ nodes: [] })),
    ]);

    const serverInsights = Array.isArray(insRes) ? insRes : [];
    const graphNodes     = graphRes.nodes || [];

    // 클라이언트 측 즉석 분석
    const localInsights = analyzeLocal(graphNodes);

    _insightCache = [...localInsights, ...serverInsights.slice(0, 8)];
    renderInsights(_insightCache);
  } catch (e) {
    // 오프라인 → 로컬 분석만
    const graphNodes = nodes.filter(n => n.raw).map(n => n.raw);
    _insightCache = analyzeLocal(graphNodes.length > 0 ? graphNodes : nodes);
    renderInsights(_insightCache);
  }
  _insightLoading = false;
}

function analyzeLocal(rawNodes) {
  const insights = [];
  const now = Date.now();

  // ── 1. 전체 프로젝트 요약 ──
  const totalNodes   = rawNodes.length;
  const sessions     = nodes.filter(n => n.level === 1).length;
  const toolCalls    = rawNodes.filter(n => n.type?.startsWith('tool.')).length;
  const fileEdits    = rawNodes.filter(n => n.type === 'file.write' || n.type === 'file.create').length;
  const errors       = rawNodes.filter(n => n.type?.includes('error')).length;
  const aiNodes      = rawNodes.filter(n => n.aiSource);

  insights.push({
    icon: '🌌', type: 'summary', severity: 'info',
    title: '프로젝트 전체 요약',
    body: `총 ${sessions}개 세션에서 ${totalNodes}개 이벤트가 기록됐습니다.`,
    stats: [
      { icon: '🔧', label: '도구 호출', val: toolCalls },
      { icon: '📝', label: '파일 수정', val: fileEdits },
      { icon: '⚠️', label: '에러',     val: errors, warn: errors > 0 },
    ]
  });

  // ── 2. 가장 활발한 세션 ──
  const sessionMap = {};
  rawNodes.forEach(n => {
    const sid = n.sessionId || n.raw?.sessionId || 'default';
    sessionMap[sid] = (sessionMap[sid] || 0) + 1;
  });
  const topSession = Object.entries(sessionMap).sort((a,b) => b[1]-a[1])[0];
  if (topSession && sessions > 1) {
    insights.push({
      icon: '🔥', type: 'hotspot', severity: 'info',
      title: '가장 활발한 세션',
      body: `세션 "${topSession[0].slice(0,12)}..."에 ${topSession[1]}개 이벤트가 집중됩니다. 이 세션을 핵심 작업 패턴으로 참고하세요.`,
      stats: [{ icon: '📊', label: '이벤트', val: topSession[1] }]
    });
  }

  // ── 3. AI 소스 다양성 분석 ──
  const aiCounts = {};
  aiNodes.forEach(n => { aiCounts[n.aiSource] = (aiCounts[n.aiSource] || 0) + 1; });
  const aiEntries = Object.entries(aiCounts).sort((a,b) => b[1]-a[1]);
  if (aiEntries.length > 0) {
    const dominant = aiEntries[0];
    const ratio    = Math.round(dominant[1] / Math.max(aiNodes.length, 1) * 100);
    insights.push({
      icon: '🤖', type: 'ai_pattern', severity: ratio > 90 ? 'warn' : 'info',
      title: 'AI 사용 패턴',
      body: ratio > 90
        ? `${dominant[0]}에 집중(${ratio}%)됩니다. 다른 AI 도구와 병행하면 관점이 다양해집니다.`
        : `${aiEntries.length}개 AI 도구를 고르게 활용 중입니다. 균형 잡힌 워크플로우입니다.`,
      stats: aiEntries.slice(0,3).map(([src, cnt]) => ({ icon: '●', label: src, val: cnt }))
    });
  }

  // ── 4. 도구 호출 패턴 ──
  const toolTypes = {};
  rawNodes.filter(n => n.type === 'tool.end' || n.type === 'tool.start').forEach(n => {
    const tool = (n.data?.toolName || n.label || '').split('(')[0].trim();
    if (tool) toolTypes[tool] = (toolTypes[tool] || 0) + 1;
  });
  const topTools = Object.entries(toolTypes).sort((a,b)=>b[1]-a[1]).slice(0,4);
  if (topTools.length > 0) {
    insights.push({
      icon: '⚙️', type: 'tools', severity: 'info',
      title: '자주 사용한 도구',
      body: `"${topTools[0][0]}" 도구가 ${topTools[0][1]}회로 가장 많이 호출됐습니다. 자동화 스크립트 검토를 권장합니다.`,
      stats: topTools.map(([t, c]) => ({ icon: '🔧', label: t.slice(0,12), val: c }))
    });
  }

  // ── 5. 에러 패턴 ──
  if (errors > 0) {
    const errorRate = Math.round(errors / Math.max(totalNodes, 1) * 100);
    insights.push({
      icon: '⚠️', type: 'errors', severity: errorRate > 10 ? 'high' : 'warn',
      title: `에러 감지 (${errors}건, ${errorRate}%)`,
      body: errorRate > 10
        ? '에러 비율이 높습니다. 오류가 잦은 작업 패턴을 점검하세요.'
        : '소수의 에러가 있습니다. 개별 확인을 권장합니다.',
      stats: [
        { icon: '🔴', label: '에러 건수', val: errors },
        { icon: '📊', label: '에러율', val: `${errorRate}%`, warn: errorRate > 5 },
      ]
    });
  }

  // ── 6. 파일 집중 수정 ──
  const fileCounts = {};
  rawNodes.filter(n => n.type === 'file.write').forEach(n => {
    const f = (n.data?.filePath || n.data?.path || n.label || '').split('/').pop();
    if (f && f.length > 0) fileCounts[f] = (fileCounts[f] || 0) + 1;
  });
  const hotFiles = Object.entries(fileCounts).filter(([,c]) => c >= 2).sort((a,b)=>b[1]-a[1]).slice(0,4);
  if (hotFiles.length > 0) {
    insights.push({
      icon: '📁', type: 'hot_files', severity: 'info',
      title: `반복 수정 파일 ${hotFiles.length}개`,
      body: `"${hotFiles[0][0]}"이(가) ${hotFiles[0][1]}회 수정됐습니다. 잦은 수정은 리팩토링 또는 자동화 기회를 의미합니다.`,
      stats: hotFiles.map(([f, c]) => ({ icon: '📝', label: f.slice(0,14), val: c }))
    });
  }

  // ── 7. 시간대 패턴 ──
  const hourCounts = new Array(24).fill(0);
  rawNodes.forEach(n => {
    const ts = n.timestamp || n.raw?.timestamp;
    if (ts) { const h = new Date(ts).getHours(); if (!isNaN(h)) hourCounts[h]++; }
  });
  const peak = hourCounts.indexOf(Math.max(...hourCounts));
  if (hourCounts[peak] > 3) {
    const period = peak < 12 ? '오전' : peak < 18 ? '오후' : '저녁';
    insights.push({
      icon: '⏰', type: 'time_pattern', severity: 'info',
      title: `주요 작업 시간: ${period} ${peak}시`,
      body: `${period} ${peak}시~${peak+1}시에 활동이 집중됩니다. 이 시간대에 중요한 작업을 집중 배치하면 생산성이 높아집니다.`,
      stats: [{ icon: '📈', label: '피크 이벤트', val: hourCounts[peak] }]
    });
  }

  return insights;
}

function renderInsights(insights) {
  const listEl = document.getElementById('insight-list');
  if (!insights || insights.length === 0) {
    listEl.innerHTML = '<div style="text-align:center;color:var(--text3);font-size:11px;padding:24px 0">데이터가 부족합니다. 작업을 더 진행하면 인사이트가 생성됩니다.</div>';
    return;
  }

  const severityColors = { high: '#f85149', warn: '#d29922', info: '#58a6ff', success: '#3fb950' };
  const severityLabels = { high: '주의', warn: '경고', info: '정보', success: '좋음' };

  listEl.innerHTML = insights.map((ins, i) => {
    const sev   = ins.severity || 'info';
    const color = severityColors[sev] || '#58a6ff';
    const label = severityLabels[sev] || '정보';
    const statsHtml = (ins.stats || []).map(s =>
      `<div class="ic-stat" style="${s.warn ? 'color:#f85149' : ''}">
        <span>${s.icon || '●'}</span>
        <span>${s.label}</span>
        <b>${s.val}</b>
      </div>`
    ).join('');

    return `
      <div class="insight-card" style="animation-delay:${i * 0.06}s">
        <div class="ic-header">
          <span class="ic-icon">${ins.icon || '💡'}</span>
          <span class="ic-title">${ins.title}</span>
          <span class="ic-badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${label}</span>
        </div>
        <div class="ic-body">${ins.body || ''}</div>
        ${statsHtml ? `<div class="ic-stats">${statsHtml}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function refreshInsights() {
  _insightCache = [];
  await loadInsights();
  // 서버 측 즉시 분석 트리거
  fetch('/api/insights/run', { method: 'POST' }).catch(() => {});
}

// ══════════════════════════════════════════════════════════
// HUD 버튼 커스텀 툴팁 시스템
// ══════════════════════════════════════════════════════════
(function initHudTooltips() {
  const tip     = document.getElementById('hud-tip');
  const tipTitle = document.getElementById('tip-title');
  const tipDesc  = document.getElementById('tip-desc');
  let _tipTimer  = null;

  function showTip(el, e) {
    const title = el.dataset.tipTitle;
    const desc  = el.dataset.tipDesc;
    if (!title) return;

    tipTitle.textContent = title;
    tipDesc.textContent  = desc || '';

    // 위치 계산 (버튼 아래 중앙)
    const rect = el.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - 110;
    left = Math.max(8, Math.min(left, innerWidth - 240));
    tip.style.left = left + 'px';
    tip.style.top  = (rect.bottom + 8) + 'px';
    tip.classList.add('show');
  }

  function hideTip() {
    tip.classList.remove('show');
    clearTimeout(_tipTimer);
  }

  // HUD 영역 전체에 이벤트 위임
  document.getElementById('hud').addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip-title]');
    if (el) {
      clearTimeout(_tipTimer);
      _tipTimer = setTimeout(() => showTip(el, e), 400); // 0.4초 딜레이
    }
  });

  document.getElementById('hud').addEventListener('mouseout', e => {
    const el = e.target.closest('[data-tip-title]');
    if (el) hideTip();
  });

  // 클릭 시 툴팁 즉시 숨김
  document.getElementById('hud').addEventListener('click', hideTip);
})();

// ── HUD 업데이트 ──
function updateHUD() {
  updateZoomControls();

  const level = getCurrentLevel();
  const badge = document.getElementById('level-badge');
  if (badge) {
    badge.textContent = `${level.emoji} ${level.name}`;
    badge.style.color = level.color;
    badge.style.borderColor = level.color;
  }

  for (const l of LEVELS) {
    const el = document.getElementById(`hint-${l.id}`);
    if (el) el.className = l.id === level.id ? 'active' : '';
  }

  document.getElementById('back-btn').style.display = camera.position.z > 1500 ? 'block' : 'none';

  const total   = nodes.filter(n => isVisible(n)).length;
  const showing = Math.min(total, MAX_VISIBLE_NODES);
  const lodEl   = document.getElementById('lod-badge');
  if (lodEl) {
    if (total > MAX_VISIBLE_NODES) {
      lodEl.textContent = `⚡ LOD ${showing}/${total}`;
    } else {
      lodEl.textContent = `● ${total} 노드`;
    }
    lodEl.style.display = 'block';
    const z = camera.position.z;
    if (z > 1500) lodEl.style.color = '#f85149';
    else if (z > 500) lodEl.style.color = '#ffa657';
    else if (z > 200) lodEl.style.color = '#3fb950';
    else lodEl.style.color = '#58a6ff';
  }
}

// ── 미니맵 (2D Canvas) ──
function drawMinimap() {
  const mc   = document.getElementById('mini-canvas');
  const mctx = mc.getContext('2d');
  mc.width  = 140; mc.height = 90;

  mctx.fillStyle = '#060a10';
  mctx.fillRect(0, 0, 140, 90);

  if (nodes.length === 0) return;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;

  for (const n of nodes) {
    const mx = ((n.x - minX) / rangeX) * 130 + 5;
    const my = ((n.y - minY) / rangeY) * 80 + 5;
    mctx.beginPath();
    mctx.arc(mx, my, 1.5, 0, Math.PI * 2);
    mctx.fillStyle = nodeColor(n);
    mctx.fill();
  }

  // 뷰포트 사각형 (camera frustum 기반)
  const cx = controls.target.x, cy = controls.target.y;
  const viewH = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * Math.abs(camera.position.z);
  const viewW = viewH * camera.aspect;
  const vpW = Math.min((viewW / rangeX) * 130, 130);
  const vpH = Math.min((viewH / rangeY) * 80, 80);
  const vpX = ((cx - viewW / 2 - minX) / rangeX) * 130 + 5;
  const vpY = ((cy - viewH / 2 - minY) / rangeY) * 80 + 5;
  mctx.strokeStyle = 'rgba(137,87,229,0.7)';
  mctx.lineWidth = 1;
  mctx.strokeRect(vpX, vpY, vpW, vpH);
}

// ── 미니맵 클릭/드래그 ──
const minimap = document.getElementById('minimap');
let minimapDragging = false;

function minimapMoveTo(clientX, clientY) {
  if (nodes.length === 0) return;
  const rect   = minimap.getBoundingClientRect();
  const PAD    = 5;
  const drawW  = 130, drawH = 80;
  const rx     = Math.max(0, Math.min(1, (clientX - rect.left - PAD) / drawW));
  const ry     = Math.max(0, Math.min(1, (clientY - rect.top  - PAD) / drawH));
  const xs     = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const minX   = Math.min(...xs), maxX = Math.max(...xs);
  const minY   = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1, rangeY = maxY - minY || 1;
  desiredLookAt.set(minX + rx * rangeX, minY + ry * rangeY, 0);
}

minimap.addEventListener('mousedown', e => {
  e.preventDefault();
  minimapDragging = true;
  minimapMoveTo(e.clientX, e.clientY);
});
minimap.addEventListener('mousemove', e => {
  if (!minimapDragging) return;
  minimapMoveTo(e.clientX, e.clientY);
});
document.addEventListener('mouseup', (e) => {
  minimapDragging = false;
  // 드래그 선택 완료
  if (_dragSelecting && _dragSelStart) {
    _dragSelecting = false;
    if (_dragSelBox) _dragSelBox.style.display = 'none';
    const x1 = Math.min(e.clientX, _dragSelStart.x);
    const y1 = Math.min(e.clientY, _dragSelStart.y);
    const x2 = Math.max(e.clientX, _dragSelStart.x);
    const y2 = Math.max(e.clientY, _dragSelStart.y);
    if (x2 - x1 > 5 && y2 - y1 > 5) {
      // 스크린 영역 안에 있는 노드 선택
      const H = typeof tlOpen !== 'undefined' && tlOpen ? innerHeight - 48 - 220 : innerHeight;
      for (const n of currentVisibleNodes) {
        const v = new THREE.Vector3(n.x, n.y, n.z || 0).project(camera);
        const sx = (v.x + 1) / 2 * innerWidth;
        const sy = -(v.y - 1) / 2 * H + 48;
        if (sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2) {
          selectedNodes.add(n.id);
        }
      }
      _updateSelectionBar();
    }
    _dragSelStart = null;
  }
});

// ── 메인 렌더 루프 ──
let lastTime = 0;
function frame(time) {
  const dt = time - lastTime;
  lastTime = time;

  animateCamera();
  updateOrbits(dt);

  // LOD 기반 가시 노드
  let visibleNodes = nodes.filter(n => isVisible(n));
  if (visibleNodes.length > MAX_VISIBLE_NODES) {
    const hoverNode = hoverId ? visibleNodes.find(n => n.id === hoverId) : null;
    visibleNodes = visibleNodes
      .sort((a, b) => (b.activityScore || 0) - (a.activityScore || 0))
      .slice(0, MAX_VISIBLE_NODES);
    if (hoverNode && !visibleNodes.includes(hoverNode)) {
      visibleNodes[visibleNodes.length - 1] = hoverNode;
    }
  }

  updateInstancedMesh(visibleNodes);
  updateEdges(new Set(visibleNodes.map(n => n.id)));
  updateNodeLabels(visibleNodes);

  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  drawMinimap();
  updateHUD();
  updateZoomoutHud(visibleNodes);

  raf = requestAnimationFrame(frame);
}

// ═══════════════════════════════════════════════════
// 데이터 로드 및 레이아웃
// ═══════════════════════════════════════════════════
function layoutPlanetSystem(graph) {
  nodes    = [];
  edgeList = [];

  const sessionMap = {};
  for (const e of graph.nodes) {
    const sid = e.sessionId || 'default';
    if (!sessionMap[sid]) sessionMap[sid] = [];
    sessionMap[sid].push(e);
  }

  const sessionIds = Object.keys(sessionMap);
  const SESSION_ORBIT_R = 300;

  sessionIds.forEach((sid, si) => {
    const sessionAngle = (si / sessionIds.length) * Math.PI * 2;
    const sx = Math.cos(sessionAngle) * SESSION_ORBIT_R;
    const sy = Math.sin(sessionAngle) * SESSION_ORBIT_R;
    // Z 깊이: 세션별로 앞뒤로 분산
    const sz = (si - Math.floor(sessionIds.length / 2)) * 80;

    const evts = sessionMap[sid];
    const sessionStartEvt = evts.find(e => e.type === 'session.start') || evts[0];
    const sessionLabel = sessionStartEvt ? (sessionStartEvt.label || `세션 ${si + 1}`) : `세션 ${si + 1}`;

    const sessionNode = {
      id: 'session_' + sid,
      x: sx, y: sy, z: sz,
      type: 'session.start',
      label: sessionLabel,
      aiSource: sessionStartEvt?.aiSource || null,
      level: 1, weight: 1.2,
      orbitRadius: SESSION_ORBIT_R,
      orbitAngle: sessionAngle,
      orbitParent: 'center',
      orbitSpeed: 0.05 + si * 0.01,
    };
    nodes.push(sessionNode);

    const CHILD_ORBIT_R = 80 + evts.length * 5;
    evts.forEach((evt, ei) => {
      const childAngle = (ei / evts.length) * Math.PI * 2;
      nodes.push({
        id: evt.id || evt.eventId || `node-${si}-${ei}`,
        x: sx + Math.cos(childAngle) * CHILD_ORBIT_R,
        y: sy + Math.sin(childAngle) * CHILD_ORBIT_R,
        z: sz + Math.sin(childAngle * 2) * 20,
        type: evt.type,
        label: evt.label || getFallbackLabel(evt),
        aiSource: evt.aiSource || sessionStartEvt?.aiSource || null,
        color: evt.color || null,
        level: 0, weight: getWeight(evt),
        orbitRadius: CHILD_ORBIT_R,
        orbitAngle: childAngle,
        orbitParent: sessionNode.id,
        orbitSpeed: 0.1 + ei * 0.005,
        raw: evt,
      });
      edgeList.push([sessionNode.id, evt.id || `node-${si}-${ei}`]);
    });
  });

  // 중심 노드
  const channelName = new URLSearchParams(location.search).get('channel') || '전체';
  nodes.unshift({ id: 'center', x: 0, y: 0, z: 0, type: 'system', label: `🌌 ${channelName}`, level: 2, weight: 1.5 });
}

function getFallbackLabel(evt) {
  if (!evt.data) return evt.type;
  if (evt.data.toolName) return evt.data.toolName;
  if (evt.data.contentPreview) return evt.data.contentPreview.slice(0, 22);
  return evt.type.split('.').pop();
}

function getWeight(evt) {
  const weights = { 'tool.end':1.0, 'user.message':0.8, 'assistant.message':0.9, 'session.start':1.2, 'task.complete':1.1, 'file.write':0.85 };
  return weights[evt.type] || 0.6;
}

// ── 채널 관리 ──
let currentChannel = new URLSearchParams(location.search).get('channel') || '';

async function loadChannels() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    const channels = [...new Set(sessions.map(s => s.channelId).filter(Boolean))];
    const sel = document.getElementById('channel-select');
    channels.forEach(ch => {
      const opt = document.createElement('option');
      opt.value = ch; opt.textContent = ch;
      if (ch === currentChannel) opt.selected = true;
      sel.appendChild(opt);
    });
  } catch {}
}

function changeChannel(ch) {
  currentChannel = ch;
  const url = new URL(location.href);
  if (ch) url.searchParams.set('channel', ch);
  else url.searchParams.delete('channel');
  history.replaceState(null, '', url);
  loadData();
}

async function loadData() {
  try {
    const url = currentChannel
      ? `/api/graph?channel=${encodeURIComponent(currentChannel)}`
      : '/api/graph';
    const res = await fetch(url);
    const graph = await res.json();
    layoutPlanetSystem(graph);
    document.getElementById('live-dot').style.background = 'var(--green)';
  } catch (e) {
    console.warn('API 연결 실패, 데모 데이터 사용:', e.message);
    loadDemoData();
  }
}

function loadDemoData() {
  const demoGraph = { nodes: [] };
  const sessions  = ['s1', 's2', 's3'];
  const types = ['user.message', 'assistant.message', 'tool.end', 'file.write', 'file.read'];
  let id = 1;
  for (const s of sessions) {
    const count = 5 + Math.floor(Math.random() * 8);
    for (let i = 0; i < count; i++) {
      demoGraph.nodes.push({
        id: `node-${id++}`, sessionId: s,
        type: types[Math.floor(Math.random() * types.length)],
        label: ['파일 작성', '코드 검색', '답변 생성', 'API 호출'][Math.floor(Math.random() * 4)],
      });
    }
  }
  layoutPlanetSystem(demoGraph);
}

// ── WebSocket ──
let ws = null;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen    = () => console.log('[Orbit] WS 연결');
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'graph_update' || msg.type === 'full_graph' || msg.type === 'update') {
      const prevNodeIds = new Set(nodes.map(n => n.id));
      await loadData();
      for (const n of nodes) {
        if (!prevNodeIds.has(n.id)) {
          const color = n.purposeColor || '#58a6ff';
          pulseNode(n.id, color);
          if (n.type === 'tool.end' || n.type === 'file.write') {
            attachSupportBeam(n.id, color, Math.random() * Math.PI * 2);
            setTimeout(() => { delete VFX.supportBeams[n.id]; }, 3000);
          }
        }
      }
      const newFlowNodes = nodes.filter(n => !prevNodeIds.has(n.id));
      if (newFlowNodes.length) {
        newFlowNodes.slice(0, 3).forEach(n => {
          const parent = nodes.find(p => p.id === n.orbitParent || p.id === n.parentEventId);
          if (parent) spawnDataFlow(parent.id, n.id, n.purposeColor || '#39d2c0');
        });
        if (tlOpen) { tlOnNewEvent(); newFlowNodes.forEach(n => tlFlashNewEvent(n.id)); }
      }
      if (msg.conflicts?.length)     msg.conflicts.forEach(c => pushAlert('conflict', c));
      if (msg.shadowAI?.length)      msg.shadowAI.forEach(c => pushAlert('shadow', c));
      if (msg.securityLeaks?.length) msg.securityLeaks.forEach(c => pushAlert('security', c));
    }
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

// ── 키보드 ──
document.addEventListener('keydown', e => {
  if (document.activeElement === document.getElementById('node-search')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case 'f': case 'F': if (!e.ctrlKey && !e.metaKey) { autoFit(); e.preventDefault(); } break;
    case '0': zcReset(); e.preventDefault(); break;
    case '+': case '=': zcZoomIn(); e.preventDefault(); break;
    case '-': zcZoomOut(); e.preventDefault(); break;
    case '?': toggleShortcutHint(); e.preventDefault(); break;
    case 'Escape':
      if (selectedNodes.size > 0) { selectedNodes.clear(); _updateSelectionBar(); }
      closeNodeSearch(); closeSidePanel(); hideShortcutHint(); e.preventDefault(); break;
    case 'Delete': case 'Backspace':
      if (selectedNodes.size > 0) { _hideSelectedNodes(); e.preventDefault(); }
      break;
    case 'k': if (e.ctrlKey || e.metaKey) { openNodeSearch(); e.preventDefault(); } break;
    case '1': if (e.shiftKey) { autoFit(); e.preventDefault(); } break;
    case 'a': case 'A': if (!e.ctrlKey && !e.metaKey) { toggleAlertPanel(); e.preventDefault(); } break;
    case 'p': case 'P': if (!e.ctrlKey && !e.metaKey) { togglePurposeMode(); e.preventDefault(); } break;
    case 'm': case 'M': if (!e.ctrlKey && !e.metaKey) { toggleMemberOverlay(); e.preventDefault(); } break;
    case 'o': case 'O': if (!e.ctrlKey && !e.metaKey) { toggleOrbit(); e.preventDefault(); } break;
    case 'r': case 'R': if (!e.ctrlKey && !e.metaKey) { loadData(); e.preventDefault(); } break;
    case 'g': case 'G': if (!e.ctrlKey && !e.metaKey) { window.open('/team-dashboard.html','_blank'); e.preventDefault(); } break;
    case 't': case 'T': if (!e.ctrlKey && !e.metaKey) { window.open('/theme-market.html','_blank'); e.preventDefault(); } break;
    case 'w': case 'W': if (!e.ctrlKey && !e.metaKey) { window.open('/contributor-dashboard.html','_blank'); e.preventDefault(); } break;
    case 'h': case 'H': if (!e.ctrlKey && !e.metaKey) { toggleOrbitalHud(); e.preventDefault(); } break;
    case 'l': case 'L': toggleTimeline(); break;
    case 'ArrowUp':    desiredLookAt.y -= 40 / (800 / camera.position.z); e.preventDefault(); break;
    case 'ArrowDown':  desiredLookAt.y += 40 / (800 / camera.position.z); e.preventDefault(); break;
    case 'ArrowLeft':  desiredLookAt.x -= 40 / (800 / camera.position.z); e.preventDefault(); break;
    case 'ArrowRight': desiredLookAt.x += 40 / (800 / camera.position.z); e.preventDefault(); break;
    case 'Tab': {
      if (nodes.length === 0) break;
      e.preventDefault();
      const visibleNodes = nodes.filter(n => !n._hidden && !n._dimmed);
      if (!visibleNodes.length) break;
      if (typeof window._focusedNodeIdx === 'undefined') window._focusedNodeIdx = -1;
      window._focusedNodeIdx = e.shiftKey
        ? (window._focusedNodeIdx - 1 + visibleNodes.length) % visibleNodes.length
        : (window._focusedNodeIdx + 1) % visibleNodes.length;
      const target = visibleNodes[window._focusedNodeIdx];
      desiredLookAt.set(target.x, target.y, 0);
      showSidePanel(target);
      break;
    }
    case 'Enter': {
      if (typeof window._focusedNodeIdx !== 'undefined' && nodes.length > 0) {
        const visibleNodes = nodes.filter(n => !n._hidden && !n._dimmed);
        const target = visibleNodes[window._focusedNodeIdx];
        if (target) { zoomIntoNode(target); e.preventDefault(); }
      }
      break;
    }
  }
});

// ── Orbit 토글 ──
function toggleOrbit() {
  orbitOn = !orbitOn;
  const btn = document.getElementById('orbit-toggle');
  btn.textContent = orbitOn ? '⏸ 정지' : '▶ 공전';
  btn.className   = orbitOn ? 'hud-btn active' : 'hud-btn';
}

// ── 단축키 힌트 ──
let shortcutHintVisible = false;
let shortcutHintTimer   = null;
function toggleShortcutHint() {
  shortcutHintVisible = !shortcutHintVisible;
  const el = document.getElementById('shortcut-hint');
  if (shortcutHintVisible) {
    el.classList.add('show');
    clearTimeout(shortcutHintTimer);
    shortcutHintTimer = setTimeout(() => { shortcutHintVisible = false; el.classList.remove('show'); }, 6000);
  } else {
    el.classList.remove('show');
  }
}
function hideShortcutHint() { shortcutHintVisible = false; document.getElementById('shortcut-hint').classList.remove('show'); }

// ── 노드 검색 ──
function openNodeSearch() {
  const input = document.getElementById('node-search');
  input.classList.add('show'); input.value = ''; input.focus();
  document.getElementById('search-results').classList.remove('show');
}
function closeNodeSearch() {
  document.getElementById('node-search').classList.remove('show');
  document.getElementById('search-results').classList.remove('show');
}
document.getElementById('node-search').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  const container = document.getElementById('search-results');
  if (!q) { container.classList.remove('show'); return; }
  const matches = nodes.filter(n =>
    (n.label || '').toLowerCase().includes(q) ||
    (n.type  || '').toLowerCase().includes(q) ||
    (n.purposeLabel || '').toLowerCase().includes(q)
  ).slice(0, 8);
  if (matches.length === 0) { container.classList.remove('show'); return; }
  container.innerHTML = matches.map(n => `
    <div class="sr-item" onclick="focusNode('${n.id}')">
      <span class="sr-type">${n.purposeIcon || ''} ${n.type || ''}</span>
      <span>${n.label || n.id}</span>
    </div>
  `).join('');
  container.classList.add('show');
});
document.getElementById('node-search').addEventListener('keydown', e => { if (e.key === 'Escape') closeNodeSearch(); });

// ── 목적 분류 뷰 ──
async function loadPurposeCategories() {
  try {
    const res = await fetch('/api/purposes/categories');
    const cats = await res.json();
    const sel = document.getElementById('purpose-filter');
    while (sel.options.length > 1) sel.remove(1);
    cats.forEach(cat => {
      purposeCategories[cat.id] = cat;
      const opt = document.createElement('option');
      opt.value = cat.id; opt.textContent = `${cat.icon} ${cat.label}`;
      sel.appendChild(opt);
    });
  } catch {}
}

function togglePurposeMode() {
  purposeMode = !purposeMode;
  const btn = document.getElementById('purpose-mode-btn');
  btn.textContent = purposeMode ? '🎯 목적 뷰 ON' : '🎯 목적 뷰';
  btn.className   = purposeMode ? 'hud-btn active' : 'hud-btn';
  document.getElementById('purpose-filter').style.display = purposeMode ? '' : 'none';
  if (!purposeMode) { currentPurposeFilter = ''; document.getElementById('purpose-filter').value = ''; }
  updatePurposeLegend();
}

function filterByPurpose(purposeId) {
  currentPurposeFilter = purposeId;
  nodes.forEach(n => { n._dimmed = (purposeId && n.purposeId !== purposeId); });
  updatePurposeLegend();
}

function updatePurposeLegend() {
  const el = document.getElementById('purpose-legend');
  if (!purposeMode || Object.keys(purposeCategories).length === 0) { el.style.display = 'none'; return; }
  const activePurposes = new Set(nodes.filter(n => n.purposeId).map(n => n.purposeId));
  const items = [...activePurposes].map(id => purposeCategories[id]).filter(Boolean);
  if (items.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = items.map(cat => `
    <div class="legend-row">
      <div class="legend-dot" style="background:${cat.color}"></div>
      <span style="color:${currentPurposeFilter === cat.id ? '#fff' : '#c9d1d9'};font-size:11px">${cat.icon} ${cat.label}</span>
    </div>
  `).join('');
}

// ── 팀 멤버 오버레이 ──
let memberOverlayMode  = false;
let memberList         = [];
const MEMBER_OVERLAY_COLORS = ['#ff9500','#f778ba','#79c0ff','#ffa657','#39d2c0','#8957e5','#f85149','#3fb950'];

async function toggleMemberOverlay() {
  memberOverlayMode = !memberOverlayMode;
  const btn = document.getElementById('member-overlay-btn');
  btn.textContent = memberOverlayMode ? '👥 오버레이 ON' : '👥 팀 오버레이';
  btn.className   = memberOverlayMode ? 'hud-btn active' : 'hud-btn';
  if (memberOverlayMode) {
    try {
      const res = await fetch('/api/members');
      memberList = await res.json();
      updateMemberLegend();
    } catch {}
  } else {
    memberList = [];
    document.getElementById('member-legend').style.display = 'none';
  }
}

function updateMemberLegend() {
  const el = document.getElementById('member-legend');
  if (!memberOverlayMode || memberList.length === 0) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = memberList.slice(0, 8).map((m, i) => `
    <div class="legend-row">
      <div class="legend-dot" style="background:${MEMBER_OVERLAY_COLORS[i % MEMBER_OVERLAY_COLORS.length]}"></div>
      <span style="color:#c9d1d9;font-size:11px">${m.name}</span>
    </div>
  `).join('');
}

// ── 툴팁 ──
function showTooltip(n, mx, my) {
  const tt = document.getElementById('tooltip');
  const aiTag = n.aiSource ? ` · ${n.aiSource}` : '';
  document.getElementById('tt-type').textContent  = (n.type || '') + aiTag;
  document.getElementById('tt-label').textContent = n.label || n.id;
  document.getElementById('tt-meta').textContent  = n.raw?.timestamp
    ? new Date(n.raw.timestamp).toLocaleString('ko-KR')
    : (n.orbitRadius ? `궤도 반경: ${Math.round(n.orbitRadius)}` : '');
  tt.style.left = (mx + 14) + 'px';
  tt.style.top  = (my - 10) + 'px';
  tt.className  = 'show';
}
function hideTooltip() { document.getElementById('tooltip').className = ''; }

// ── 사이드 패널 ──
const AI_SOURCE_LABELS = {
  claude:{label:'Claude',color:'#3fb950'}, openai:{label:'GPT',color:'#8b949e'},
  n8n:{label:'n8n',color:'#ea4b71'}, vscode:{label:'VS Code',color:'#f85149'},
  perplexity:{label:'Perplexity',color:'#bc8cff'}, gemini:{label:'Gemini',color:'#4285f4'},
};

function openSidePanel(n) {
  const panel = document.getElementById('side-panel');
  const raw   = n.raw || {};
  const data  = raw.data || raw.fullContent || {};

  document.getElementById('sp-type').textContent  = n.type || '';
  document.getElementById('sp-label').textContent = n.label || n.id;

  const badgesEl = document.getElementById('sp-badges');
  badgesEl.innerHTML = '';
  if (n.aiSource && AI_SOURCE_LABELS[n.aiSource]) {
    const ai = AI_SOURCE_LABELS[n.aiSource];
    const badge = document.createElement('span');
    badge.className = 'sp-badge';
    badge.style.cssText = `background:${ai.color}22;color:${ai.color};border:1px solid ${ai.color}55`;
    badge.textContent = ai.label;
    badgesEl.appendChild(badge);
  }
  if (raw.sessionId) {
    const badge = document.createElement('span');
    badge.className = 'sp-badge';
    badge.style.cssText = 'background:rgba(88,166,255,0.1);color:#58a6ff;border:1px solid rgba(88,166,255,0.3)';
    badge.textContent = '세션';
    badgesEl.appendChild(badge);
  }

  const rowsEl = document.getElementById('sp-rows');
  rowsEl.innerHTML = '';
  const addRow = (key, val) => {
    if (!val) return;
    const row = document.createElement('div');
    row.className = 'sp-row';
    row.innerHTML = `<span>${key}</span><span>${val}</span>`;
    rowsEl.appendChild(row);
  };
  if (raw.timestamp) addRow('시간', new Date(raw.timestamp).toLocaleString('ko-KR'));
  if (raw.aiSource)  addRow('AI 소스', raw.aiSource);
  if (typeof data.success === 'boolean') addRow('결과', data.success ? '✅ 성공' : '❌ 실패');
  if (data.toolName) addRow('도구', data.toolName);
  if (data.filePath || data.fileName) addRow('파일', data.fileName || data.filePath?.split('/').pop());

  const content = data.content || data.contentPreview || data.message || data.inputPreview || '';
  const divEl   = document.getElementById('sp-div');
  const contEl  = document.getElementById('sp-content');
  if (content) {
    divEl.style.display = '';
    contEl.style.display = '';
    contEl.textContent = content.slice(0, 500) + (content.length > 500 ? '…' : '');
  } else {
    divEl.style.display = 'none';
    contEl.style.display = 'none';
  }

  panel.classList.add('open');

  // 타임라인 동기화
  if (tlOpen && n?.id) { tlSelectedId = n.id; tlRender(); }
}

function showSidePanel(n) { openSidePanel(n); }

function closeSidePanel() {
  document.getElementById('side-panel').classList.remove('open');
}

// ── 경보 시스템 ──
const alertHistory = [];
let alertPanelOpen = false;

function pushAlert(kind, data) {
  const id = kind + '-' + Date.now() + '-' + Math.random().toString(36).slice(2,6);
  const severity = data.severity || (kind === 'security' ? 'high' : 'medium');
  const icons   = { conflict:'⚠️', shadow:'🚫', security:'🚨' };
  const titles  = { conflict:'충돌 감지', shadow:'Shadow AI', security:'보안 유출' };
  const entry = { id, kind, severity, message: data.message || JSON.stringify(data).slice(0,80), ts: new Date() };
  alertHistory.unshift(entry);
  const badge = document.getElementById('alert-badge');
  badge.style.display = 'inline';
  badge.textContent = Math.min(alertHistory.length, 99);
  renderAlertPanel();
  if (!alertPanelOpen) showToast(entry, icons[kind] || '🔔', titles[kind] || '경보');
}

function showToast(entry, icon, title) {
  const container = document.getElementById('alert-container');
  const el = document.createElement('div');
  el.className = `alert-toast toast-${entry.severity}`;
  el.id = 'toast-' + entry.id;
  el.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body"><div class="toast-title">${title}</div><div class="toast-msg">${entry.message.slice(0,80)}</div></div>
    <button class="toast-close" onclick="dismissToast('${entry.id}')">✕</button>
  `;
  el.onclick = (e) => { if (!e.target.classList.contains('toast-close')) { openAlertPanel(); dismissToast(entry.id); } };
  container.appendChild(el);
  setTimeout(() => dismissToast(entry.id), 5000);
}

function dismissToast(id) {
  const el = document.getElementById('toast-' + id);
  if (!el) return;
  el.classList.add('removing');
  setTimeout(() => el.remove(), 200);
}

function renderAlertPanel() {
  const list = document.getElementById('alert-panel-list');
  if (!alertHistory.length) {
    list.innerHTML = '<div style="text-align:center;color:#8b949e;font-size:12px;padding:24px 0">경보 없음 ✓</div>';
    return;
  }
  const kindIcons = { conflict:'⚠️', shadow:'🚫', security:'🚨' };
  list.innerHTML = alertHistory.slice(0,50).map(a => `
    <div style="border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.4;
      border-left:3px solid ${a.severity==='high'?'#f85149':a.severity==='medium'?'#d29922':'#58a6ff'};
      background:rgba(255,255,255,.03);margin-bottom:2px">
      <div style="font-weight:600;color:#e6edf3;margin-bottom:2px">${kindIcons[a.kind]||'🔔'} ${a.message.slice(0,100)}</div>
      <div style="color:#8b949e;font-size:10px">${a.ts.toLocaleTimeString('ko-KR')}</div>
    </div>`).join('');
}

function toggleAlertPanel() {
  alertPanelOpen = !alertPanelOpen;
  const panel = document.getElementById('alert-panel');
  panel.style.transform = alertPanelOpen ? 'translateX(0)' : 'translateX(100%)';
  if (alertPanelOpen) {
    document.getElementById('alert-badge').style.display = 'none';
    document.getElementById('alert-badge').textContent = '0';
    renderAlertPanel();
  }
}
function openAlertPanel() { alertPanelOpen = false; toggleAlertPanel(); }

// ── Orbital HUD ──
let orbitalHudVisible = localStorage.getItem('orbit_hud') !== 'false';
let orbitalHudNode    = null;
let orbitalAnimFrame  = 0;

const GLOBAL_CHIPS = [
  { id:'search',  label:'노드 검색',   key:'K', icon:'🔍', color:'#58a6ff', action: () => openNodeSearch() },
  { id:'fit',     label:'전체 맞춤',   key:'F', icon:'⊡',  color:'#3fb950', action: () => autoFit() },
  { id:'purpose', label:'목적 뷰',     key:'P', icon:'🎯', color:'#bc8cff', action: () => togglePurposeMode() },
  { id:'team',    label:'팀 오버레이', key:'M', icon:'👥', color:'#ffa657', action: () => toggleMemberOverlay() },
  { id:'alert',   label:'경보',        key:'A', icon:'🔔', color:'#f85149', action: () => toggleAlertPanel() },
  { id:'theme',   label:'테마 마켓',   key:'T', icon:'🎨', color:'#39d2c0', action: () => window.open('/theme-market.html','_blank') },
  { id:'market',  label:'마켓 2.0',   key:'W', icon:'💰', color:'#ffa657', action: () => window.open('/contributor-dashboard.html','_blank') },
  { id:'refresh', label:'새로고침',    key:'R', icon:'↻',  color:'#8b949e', action: () => loadData() },
  { id:'orbit',   label:'Orbit 모드',  key:'O', icon:'🌌', color:'#8957e5', action: () => toggleOrbit() },
];

const NODE_CHIPS = [
  { id:'focus', label:'포커스',   key:'Enter', icon:'⊙', color:'#58a6ff', action: (n) => zoomIntoNode(n) },
  { id:'panel', label:'상세보기', key:'I',     icon:'📋', color:'#bc8cff', action: (n) => showSidePanel(n) },
  { id:'copy',  label:'ID 복사',  key:'C',     icon:'⎘', color:'#3fb950', action: (n) => { navigator.clipboard?.writeText(n.id || n.label || ''); } },
];

function initOrbitalHud() {
  const hud = document.getElementById('orbital-hud');
  GLOBAL_CHIPS.forEach((chip, i) => {
    const el = document.createElement('div');
    el.className  = 'orbital-chip';
    el.id         = 'chip-' + chip.id;
    el.innerHTML  = `<span class="chip-dot" style="background:${chip.color}"></span>${chip.icon} ${chip.label}<span class="chip-key">⌘${chip.key}</span>`;
    el.onclick    = chip.action;
    el.title      = `${chip.label} (${chip.key})`;
    el.style.cssText = `left: 12px; top: ${70 + i * 38}px;`;
    hud.appendChild(el);
  });
  applyOrbitalHudState();
  startOrbitalFloat();
  setInterval(updateNodeChips, 200);
}

function startOrbitalFloat() {
  let ft = 0;
  function floatLoop() {
    ft += 0.012;
    GLOBAL_CHIPS.forEach((chip, i) => {
      const el = document.getElementById('chip-' + chip.id);
      if (!el || !orbitalHudVisible) return;
      const offset = Math.sin(ft + i * 0.7) * 3;
      el.style.top = (70 + i * 38 + offset) + 'px';
    });
    orbitalAnimFrame = requestAnimationFrame(floatLoop);
  }
  floatLoop();
}

function updateNodeChips() {
  if (!orbitalHudVisible) return;
  const hud = document.getElementById('orbital-hud');
  hud.querySelectorAll('.node-chip').forEach(el => el.remove());
  if (!hoverId) return;
  const n = nodes.find(x => x.id === hoverId);
  if (!n) return;

  // 3D 좌표 → 화면 좌표
  const vec = new THREE.Vector3(n.x, n.y, n.z || 0);
  vec.project(camera);
  const sx = (vec.x + 1) / 2 * innerWidth;
  const sy = (1 - vec.y) / 2 * innerHeight;
  const r  = Math.max(20, nodeRadius(n) / (camera.position.z / 800) * 0.5);

  NODE_CHIPS.forEach((chip, i) => {
    const angle = -Math.PI / 2 + (i / NODE_CHIPS.length) * Math.PI * 2;
    const dist  = r + 44;
    const cx    = sx + Math.cos(angle) * dist;
    const cy    = sy + Math.sin(angle) * dist;

    const el = document.createElement('div');
    el.className = 'orbital-chip node-chip';
    el.innerHTML = `<span class="chip-dot" style="background:${chip.color}"></span>${chip.icon} ${chip.label}`;
    el.style.cssText = `left:${cx - 40}px; top:${cy - 14}px; transform: scale(0.9); opacity:0; transition: opacity .2s, transform .2s;`;
    el.onclick = (e) => { e.stopPropagation(); chip.action(n); };
    setTimeout(() => { el.style.transform = 'scale(1)'; el.style.opacity = '1'; }, i * 40);
    hud.appendChild(el);
  });
}

function applyOrbitalHudState() {
  const hud = document.getElementById('orbital-hud');
  const btn = document.getElementById('orbital-toggle');
  hud.classList.toggle('hidden', !orbitalHudVisible);
  btn.classList.toggle('collapsed', !orbitalHudVisible);
  btn.title       = orbitalHudVisible ? 'HUD 숨기기 (H)' : 'HUD 보이기 (H)';
  btn.textContent = orbitalHudVisible ? '◉' : '◎';
  localStorage.setItem('orbit_hud', orbitalHudVisible);
}

function toggleOrbitalHud() { orbitalHudVisible = !orbitalHudVisible; applyOrbitalHudState(); }

// ── 테마 시스템 ──
function applyThemeVars(vars) {
  if (!vars) return;
  const root = document.documentElement;
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
  if (vars['--bg']) scene.background.set(vars['--bg']);
}
function loadSavedTheme() {
  try { const saved = localStorage.getItem('orbit_theme_vars'); if (saved) applyThemeVars(JSON.parse(saved)); } catch {}
}
window.addEventListener('message', e => { if (e.data?.type === 'orbit_theme') applyThemeVars(e.data.vars); });

// ═══════════════════════════════════════════════════
// TIMELINE ENGINE
// ═══════════════════════════════════════════════════
let tlOpen           = false;
let tlAllEvents      = [];
let tlFilteredEvents = [];
let tlSelectedId     = null;
const TL_PX_PER_MIN  = 4;

const TL_TYPE_COLORS = {
  'tool.start':'#39d2c0', 'tool.end':'#3fb950', 'file.write':'#58a6ff',
  'file.read':'#79c0ff', 'user.message':'#bc8cff', 'assistant.message':'#e6edf3',
  'error':'#f85149', 'git.commit':'#ffa657', 'git.push':'#ff7b72', 'git.merge':'#d2a8ff',
};

function tlTypeColor(type) {
  if (!type) return '#8b949e';
  const exact = TL_TYPE_COLORS[type];
  if (exact) return exact;
  const prefixMap = { tool:'#39d2c0', file:'#58a6ff', user:'#bc8cff', git:'#ffa657', error:'#f85149' };
  return prefixMap[type.split('.')[0]] || '#8b949e';
}

async function tlLoadEvents() {
  try {
    const r = await fetch('/api/graph');
    const d = await r.json();
    tlAllEvents = (d.nodes || [])
      .filter(n => n.raw?.timestamp || n.timestamp)
      .map(n => ({
        id: n.id, type: n.type, label: n.label || n.type,
        ts: new Date(n.raw?.timestamp || n.timestamp),
        color: n.purposeColor || tlTypeColor(n.type),
        size: n.size || 20, sessionId: n.raw?.sessionId || n.sessionId,
        aiSource: n.raw?.aiSource || n.aiSource, _node: n,
      }))
      .sort((a, b) => a.ts - b.ts);
    tlApplyFilter();
  } catch {}
}

function tlApplyFilter() {
  const typeF   = document.getElementById('tl-type-filter')?.value || '';
  const rangeF  = parseInt(document.getElementById('tl-range-filter')?.value || '60');
  const searchF = (document.getElementById('tl-search')?.value || '').toLowerCase().trim();
  const now     = Date.now();
  const cutoff  = rangeF > 0 ? now - rangeF * 60 * 1000 : 0;
  tlFilteredEvents = tlAllEvents.filter(ev => {
    if (rangeF > 0 && ev.ts.getTime() < cutoff) return false;
    if (typeF && !ev.type.startsWith(typeF)) return false;
    if (searchF && !ev.label.toLowerCase().includes(searchF) && !ev.type.toLowerCase().includes(searchF)) return false;
    return true;
  });
  document.getElementById('tl-count').textContent = `${tlFilteredEvents.length} 이벤트`;
  tlRender();
}

function tlRender() {
  const track  = document.getElementById('timeline-track');
  const scroll = document.getElementById('timeline-scroll');
  if (!track) return;
  [...track.querySelectorAll('.tl-event, .tl-tick')].forEach(el => el.remove());
  const events = tlFilteredEvents;
  if (events.length === 0) return;
  const minTs  = events[0].ts.getTime();
  const maxTs  = events[events.length - 1].ts.getTime();
  const spanMs = Math.max(maxTs - minTs, 60 * 1000);
  const scrollW = scroll.clientWidth;
  const trackW  = Math.max(scrollW, (spanMs / 60000) * TL_PX_PER_MIN + 120);
  track.style.width = trackW + 'px';
  const msPerPx = spanMs / (trackW - 120);
  const tickIntervalMs = tlPickTickInterval(spanMs, trackW);
  const firstTick = Math.ceil(minTs / tickIntervalMs) * tickIntervalMs;
  for (let tt = firstTick; tt <= maxTs; tt += tickIntervalMs) {
    const x = 60 + (tt - minTs) / msPerPx;
    const tick = document.createElement('div');
    tick.className = 'tl-tick'; tick.style.left = x + 'px';
    tick.innerHTML = `<div class="tl-tick-line"></div><div class="tl-tick-label">${tlFormatTime(new Date(tt), tickIntervalMs)}</div>`;
    track.appendChild(tick);
  }
  const sessionLanes = {};
  let laneCounter = 0;
  events.forEach(ev => {
    const x = 60 + (ev.ts.getTime() - minTs) / msPerPx;
    const sid = ev.sessionId || 'default';
    if (!(sid in sessionLanes)) { sessionLanes[sid] = laneCounter % 3; laneCounter++; }
    const laneClass = ['tl-lane-top','tl-lane-mid','tl-lane-bottom'][sessionLanes[sid]];
    const isSelected = ev.id === tlSelectedId;
    const isLarge = ev.type === 'user.message' || ev.type === 'git.commit';
    const el = document.createElement('div');
    el.className = `tl-event ${laneClass}`; el.style.left = x + 'px'; el.dataset.id = ev.id;
    el.innerHTML = `
      <div class="tl-dot ${isSelected?'tl-dot-active':''} ${isLarge?'tl-dot-large':''}" style="background:${ev.color}; color:${ev.color}"></div>
      <div class="tl-event-label">${ev.label}</div>
    `;
    el.addEventListener('click', () => tlSelectEvent(ev.id));
    track.appendChild(el);
  });
  tlDrawSessionLines(events, minTs, msPerPx, trackW);
  if (tlSelectedId) {
    const selEv = events.find(e => e.id === tlSelectedId);
    if (selEv) { const x = 60 + (selEv.ts.getTime() - minTs) / msPerPx; scroll.scrollLeft = Math.max(0, x - scrollW / 2); }
  } else {
    scroll.scrollLeft = Math.max(0, trackW - scrollW - 40);
  }
}

function tlDrawSessionLines(events, minTs, msPerPx, trackW) {
  const svg = document.getElementById('tl-svg');
  if (!svg) return;
  svg.innerHTML = ''; svg.setAttribute('width', trackW); svg.setAttribute('height', '184');
  const laneY = { 0: 64, 1: 92, 2: 120 };
  const sessionLanes = {}; let laneCounter = 0; const sessionGroups = {};
  events.forEach(ev => {
    const sid = ev.sessionId || 'default';
    if (!(sid in sessionLanes)) { sessionLanes[sid] = laneCounter % 3; laneCounter++; }
    if (!sessionGroups[sid]) sessionGroups[sid] = [];
    sessionGroups[sid].push({ ev, x: 60 + (ev.ts.getTime() - minTs) / msPerPx, lane: sessionLanes[sid] });
  });
  Object.entries(sessionGroups).forEach(([sid, pts]) => {
    if (pts.length < 2) return;
    const y = laneY[pts[0].lane];
    for (let i = 0; i < pts.length - 1; i++) {
      const x1 = pts[i].x, x2 = pts[i+1].x, mx = (x1 + x2) / 2;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y} C${mx},${y} ${mx},${y} ${x2},${y}`);
      path.setAttribute('stroke', pts[i].ev.color); path.setAttribute('stroke-width', '1');
      path.setAttribute('stroke-opacity', '0.25'); path.setAttribute('fill', 'none');
      svg.appendChild(path);
    }
  });
}

function tlSelectEvent(id) {
  tlSelectedId = id;
  const ev = tlFilteredEvents.find(e => e.id === id);
  if (ev?._node) { focusNode(id); pulseNode(id, ev.color); }
  document.getElementById('tl-selected-bar').classList.add('visible');
  setTimeout(() => document.getElementById('tl-selected-bar').classList.remove('visible'), 1500);
  document.querySelectorAll('.tl-dot').forEach(d => d.classList.remove('tl-dot-active'));
  const selDot = document.querySelector(`.tl-event[data-id="${id}"] .tl-dot`);
  if (selDot) selDot.classList.add('tl-dot-active');
}

function toggleTimeline() {
  tlOpen = !tlOpen;
  const panel = document.getElementById('timeline-panel');
  const btn   = document.getElementById('timeline-toggle');
  if (tlOpen) {
    panel.classList.add('open'); btn.classList.add('active'); btn.textContent = '⏱ 타임라인 ✓';
    const H = innerHeight - 48 - 220;
    camera.aspect = innerWidth / H;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, H);
    labelRenderer.setSize(innerWidth, H);
    container.style.height = H + 'px';
    setTimeout(() => tlLoadEvents(), 30);
  } else {
    closeTimeline();
  }
}

function closeTimeline() {
  tlOpen = false;
  document.getElementById('timeline-panel').classList.remove('open');
  const btn = document.getElementById('timeline-toggle');
  if (btn) { btn.classList.remove('active'); btn.textContent = '⏱ 타임라인'; }
  tlSelectedId = null;
  setTimeout(() => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    labelRenderer.setSize(innerWidth, innerHeight);
    container.style.height = '';
  }, 300);
}

function tlOnNewEvent() { if (!tlOpen) return; tlLoadEvents(); }
function tlFlashNewEvent(nodeId) {
  if (!tlOpen) return;
  const el = document.querySelector(`.tl-event[data-id="${nodeId}"] .tl-dot`);
  if (el) { el.classList.add('tl-dot-new'); setTimeout(() => el.classList.remove('tl-dot-new'), 1500); }
}

function tlPickTickInterval(spanMs, trackW) {
  const candidates = [60000, 300000, 900000, 1800000, 3600000, 21600000, 86400000];
  const targetTicks = trackW / 80;
  for (const c of candidates) { if (spanMs / c <= targetTicks) return c; }
  return candidates[candidates.length - 1];
}

function tlFormatTime(d, intervalMs) {
  if (intervalMs < 3600000) return d.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
  if (intervalMs < 86400000) return d.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit' });
  return d.toLocaleDateString('ko-KR', { month:'numeric', day:'numeric' });
}

// ── window.* 전역 함수 노출 (HTML onclick 호환) ──
window.changeChannel     = changeChannel;
window.filterByPurpose   = filterByPurpose;
window.togglePurposeMode = togglePurposeMode;
window.toggleMemberOverlay = toggleMemberOverlay;
window.autoFit           = autoFit;
window.toggleOrbit       = toggleOrbit;
window.toggleTimeline    = toggleTimeline;
window.closeTimeline     = closeTimeline;
window.setMaxVisibleNodes = setMaxVisibleNodes;
window.toggleAlertPanel  = toggleAlertPanel;
window.closeSidePanel    = closeSidePanel;
window.zcZoomIn          = zcZoomIn;
window.zcZoomOut         = zcZoomOut;
window.zcReset           = zcReset;
window.toggleShortcutHint = toggleShortcutHint;
window.toggleOrbitalHud  = toggleOrbitalHud;
window.focusNode         = focusNode;
window.zoomOut           = zoomOut;
window.tlApplyFilter     = tlApplyFilter;
window.dismissToast       = dismissToast;
window.loadData           = loadData;
window.toggleInsightPanel = toggleInsightPanel;
window.refreshInsights    = refreshInsights;

// ── OAuth 토큰 수신 처리 ──
(function handleOAuthCallback() {
  const params = new URLSearchParams(location.search);
  const token  = params.get('oauth_token');
  if (token) {
    localStorage.setItem('orbit_token', token);
    history.replaceState({}, '', location.pathname);
  }
})();

// ── 로그인 사용자 정보 로드 + HUD 사용자칩 업데이트 ──
async function loadCurrentUser() {
  const token = localStorage.getItem('orbit_token');
  const chip  = document.getElementById('user-chip');
  const avatar = document.getElementById('user-avatar');
  const name   = document.getElementById('user-name');
  if (!token) {
    name.textContent = '로그인';
    avatar.textContent = '👤';
    return null;
  }
  try {
    const res = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) {
      localStorage.removeItem('orbit_token');
      name.textContent = '로그인';
      avatar.textContent = '👤';
      return null;
    }
    const user = await res.json();
    name.textContent = (user.name || user.email || '').slice(0, 10);
    if (user.avatar) {
      avatar.innerHTML = `<img src="${user.avatar}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatar.textContent = (user.name || '?')[0].toUpperCase();
    }
    return user;
  } catch {
    name.textContent = '로그인';
    avatar.textContent = '👤';
    return null;
  }
}

// ── 접근성: prefers-reduced-motion 감지 ──
if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  orbitEnabled = false;
}

// ── 접근성: 고대비 모드 자동 감지 ──
if (window.matchMedia('(prefers-contrast: high)').matches) {
  document.body.classList.add('high-contrast-mode');
}
window.matchMedia('(prefers-contrast: high)').addEventListener('change', e => {
  document.body.classList.toggle('high-contrast-mode', e.matches);
});

// ── 접근성: 색맹 모드 토글 ──
// localStorage에 'orbit_colorblind' = '1' 이면 활성화
(function initColorblindMode() {
  const cb = localStorage.getItem('orbit_colorblind') === '1';
  if (cb) document.body.classList.add('colorblind-mode');
})();

function toggleColorblindMode() {
  const active = document.body.classList.toggle('colorblind-mode');
  localStorage.setItem('orbit_colorblind', active ? '1' : '0');
  announceNode(active ? '색맹 지원 모드 활성화됨' : '색맹 지원 모드 비활성화됨');
  // Three.js 씬 재렌더링 트리거
  if (typeof loadData === 'function') loadData();
}

// ── 접근성: 스크린 리더 알림 ──
function announceNode(text) {
  const live = document.getElementById('a11y-live');
  if (!live) return;
  live.textContent = '';
  requestAnimationFrame(() => { live.textContent = text; });
}

// 노드 포커스 시 스크린 리더 알림 패치
const _origShowSidePanel = typeof showSidePanel === 'function' ? showSidePanel : null;
if (_origShowSidePanel) {
  window.showSidePanel = function(node) {
    _origShowSidePanel(node);
    if (node) {
      const label = node.label || node.id || '노드';
      const type  = node.eventType || node.type || '';
      announceNode(`선택됨: ${label} (${type})`);
    }
  };
}

// ── 노드 멀티 선택 + 숨기기 (F4) ─────────────────────────────────────────────

function _updateSelectionBar() {
  let bar = document.getElementById('orbit-sel-bar');
  if (selectedNodes.size === 0) {
    if (bar) bar.style.display = 'none';
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'orbit-sel-bar';
    bar.style.cssText = `
      position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:rgba(13,17,23,0.95);border:1px solid #58a6ff;
      border-radius:12px;padding:8px 16px;z-index:600;
      display:flex;align-items:center;gap:12px;
      backdrop-filter:blur(16px);box-shadow:0 8px 32px rgba(0,0,0,0.4);
      font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;color:#e6edf3;
      animation:fadeIn .3s ease;
    `;
    document.body.appendChild(bar);
  }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span style="color:#58a6ff;font-weight:600">${selectedNodes.size}개 선택됨</span>
    <span style="color:#30363d">|</span>
    <button onclick="_hideSelectedNodes()" style="background:#da3633;border:none;border-radius:6px;
      color:#fff;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600">숨기기</button>
    <button onclick="selectedNodes.clear();_updateSelectionBar()" style="background:#21262d;border:1px solid #30363d;
      border-radius:6px;color:#8b949e;padding:4px 12px;cursor:pointer;font-size:12px">선택 해제</button>
  `;
}

async function _hideSelectedNodes() {
  const ids = [...selectedNodes];
  if (ids.length === 0) return;
  try {
    const res = await _authFetch('/api/events/hide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventIds: ids }),
    });
    const data = await res.json();
    if (data.ok) {
      // 즉시 시각적 제거
      ids.forEach(id => {
        const n = nodes.find(nd => nd.id === id);
        if (n) n._hidden = true;
      });
      selectedNodes.clear();
      _updateSelectionBar();
      if (typeof showToast === 'function') showToast(`${ids.length}개 노드를 숨겼습니다`, 'success');
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('숨기기 실패: ' + e.message, 'error');
  }
}

async function _unhideAllNodes() {
  try {
    const res = await _authFetch('/api/events/unhide-all', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      nodes.forEach(n => { n._hidden = false; });
      if (typeof showToast === 'function') showToast(`${data.unhidden}개 노드를 복원했습니다`, 'success');
      loadData();
    }
  } catch (e) {
    if (typeof showToast === 'function') showToast('복원 실패: ' + e.message, 'error');
  }
}

// 전역 노출 (HTML onclick에서 접근)
window._hideSelectedNodes = _hideSelectedNodes;
window._unhideAllNodes    = _unhideAllNodes;
window._updateSelectionBar = _updateSelectionBar;
window.selectedNodes       = selectedNodes;

// ── initHudTooltips 내 aria-label 자동 설정 (패치) ──
const _origHudTooltips = window.initHudTooltips;

// ── 시작 ──
(async () => {
  loadSavedTheme();
  initOrbitalHud();
  document.getElementById('purpose-filter').style.display = 'none';
  await loadChannels();
  await loadPurposeCategories();
  await loadData();
  autoFit();
  connectWS();
  raf = requestAnimationFrame(frame);
  // HUD 버튼 aria-label 자동 설정
  document.querySelectorAll('[data-tip-title]').forEach(el => {
    if (!el.getAttribute('aria-label')) {
      el.setAttribute('aria-label', el.dataset.tipTitle.replace(/[🎯👥⊡🔄⏱🔔📊🎨⚡💰💬⚙️📄]/gu, '').trim());
    }
  });
  await loadCurrentUser();
})();

