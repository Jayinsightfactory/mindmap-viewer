'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — 작업 우주 (Core: Three.js setup, mappings, clustering, controls)
// ══════════════════════════════════════════════════════════════════════════════
// ─── Three.js 기본 세팅 ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
// 사이드바 오프셋: 캔버스를 left-nav 오른쪽에서 시작
renderer.domElement.style.position = 'fixed';
renderer.domElement.style.top = '0';
document.body.appendChild(renderer.domElement);
document.body.appendChild(OrbitVRButton.createButton(renderer));

// ── 사이드바 너비 반영 렌더 영역 계산 ─────────────────────────────────────
function getNavWidth() {
  const nav = document.getElementById('left-nav');
  if (!nav) return 0;
  return nav.classList.contains('collapsed') ? (nav.offsetWidth || 36) : (nav.offsetWidth || 200);
}

function resizeRendererToSidebar() {
  const sw = getNavWidth();
  const w  = window.innerWidth - sw;
  const h  = window.innerHeight;
  renderer.setSize(w, h);
  renderer.domElement.style.left = sw + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Label canvas 동기화
  if (typeof _labelCanvas2d !== 'undefined') {
    _labelCanvas2d.width  = w;
    _labelCanvas2d.height = h;
    _labelCanvas2d.style.left = sw + 'px';
  }
}
window.resizeRendererToSidebar = resizeRendererToSidebar;

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x020617);
scene.fog = new THREE.FogExp2(0x020617, 0.0035);
window.scene = scene; // 전역 참조 할당

// [extracted to orbit3d-drilldown.js]: _drillStage, _drillProject, _drillCategory, _drillTimelineEvent

// ─── 2D 월드 네비게이션 (팀 탐색용) ─────────────────────────────────────────
// 좌클릭 드래그 → 시점 회전,  스크롤 → 줌 스케일,  팀원 클러스터 세계 좌표에 배치
let _worldPanX = 0, _worldPanY = 0, _worldScale = 1.0;
window._worldPanX = 0; window._worldPanY = 0; window._worldScale = 1.0;

// ── 시점 회전 (좌클릭 드래그 → 카메라 각도 변경) ────────────────────────────
// viewYaw: 수평 회전, viewPitch: 수직 틸트 (0=위에서, ±1.2=옆에서)
let _viewYaw = 0, _viewPitch = 0;
window._viewYaw = 0; window._viewPitch = 0;

// ── 자동 피트 줌: 부드러운 이징 애니메이션으로 목표 스케일로 이동 ────────────
let _worldLocked = false; // 줌/팬 잠금
window._worldLocked = false;

function _animateWorldScale(targetScale, durationMs) {
  const start = _worldScale;
  const diff  = targetScale - start;
  const t0    = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / durationMs);
    const eased = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
    _worldScale = start + diff * eased;
    window._worldScale = _worldScale;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// 팬 애니메이션 (세션 클릭 시 중심으로 이동)
function _animateWorldPan(targetX, targetY, durationMs) {
  const startX = _worldPanX, startY = _worldPanY;
  const dxT = targetX - startX, dyT = targetY - startY;
  const t0 = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / durationMs);
    const eased = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
    _worldPanX = startX + dxT * eased;
    _worldPanY = startY + dyT * eased;
    window._worldPanX = _worldPanX; window._worldPanY = _worldPanY;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
window._animateWorldPan = _animateWorldPan;
window._animateWorldScale = _animateWorldScale;

// 세션 클릭 → 해당 위치로 줌인 + 팬
window.zoomToScreenPos = function(screenX, screenY, targetScale, duration) {
  const W = innerWidth, H = innerHeight;
  // 스크린 좌표 → 월드 좌표
  const worldX = (screenX - W/2 - _worldPanX) / _worldScale;
  const worldY = (screenY - H/2 - _worldPanY) / _worldScale;
  // 새 팬: 월드 포인트가 화면 중심에 오도록
  const newPanX = -worldX * targetScale;
  const newPanY = -worldY * targetScale;
  _animateWorldPan(newPanX, newPanY, duration || 500);
  _animateWorldScale(targetScale, duration || 500);
};

// 노드 수 기반 자동 피트 (로드 시 1회만)
let _autoFitDone = false;
window.autoFitZoom = function(nodeCount) {
  if (!nodeCount || _autoFitDone) return;
  _autoFitDone = true;
  const target = nodeCount <= 3  ? 1.1  :
                 nodeCount <= 6  ? 0.95 :
                 nodeCount <= 12 ? 0.80 :
                 nodeCount <= 20 ? 0.65 : 0.50;
  if (target < _worldScale) _animateWorldScale(target, 500);
};

// ── 시점 각도 애니메이션 ─────────────────────────────────────────────────────
function _animateViewAngle(targetYaw, targetPitch, durationMs) {
  const startY = _viewYaw, startP = _viewPitch;
  const dY = targetYaw - startY, dP = targetPitch - startP;
  const t0 = performance.now();
  function step(now) {
    const p = Math.min(1, (now - t0) / durationMs);
    const eased = p < 0.5 ? 2*p*p : -1+(4-2*p)*p;
    _viewYaw = startY + dY * eased;
    _viewPitch = startP + dP * eased;
    window._viewYaw = _viewYaw; window._viewPitch = _viewPitch;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── 뷰 상태 스택 (단계별 뒤로가기) ─────────────────────────────────────────
let _viewStateStack = [];

window.pushViewState = function() {
  _viewStateStack.push({
    panX: _worldPanX, panY: _worldPanY,
    scale: _worldScale,
    yaw: _viewYaw, pitch: _viewPitch,
  });
};

window.popViewState = function(animate) {
  if (_viewStateStack.length === 0) return false;
  const state = _viewStateStack.pop();
  const dur = animate ? 400 : 0;
  if (animate) {
    _animateWorldPan(state.panX, state.panY, dur);
    _animateWorldScale(state.scale, dur);
    _animateViewAngle(state.yaw, state.pitch, dur);
  } else {
    _worldPanX = state.panX; _worldPanY = state.panY;
    _worldScale = state.scale;
    _viewYaw = state.yaw; _viewPitch = state.pitch;
    window._worldPanX = _worldPanX; window._worldPanY = _worldPanY;
    window._worldScale = _worldScale;
    window._viewYaw = _viewYaw; window._viewPitch = _viewPitch;
  }
  return true;
};

window.clearViewStateStack = function() { _viewStateStack = []; };

// [extracted to orbit3d-drilldown.js]: autoFitDrilldown

const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 2000);
camera.position.set(0, 25, 55);                       // 컴팩트 뷰에 맞는 초기 거리
camera.lookAt(0,0,0);
window.camera = camera; // 전역 참조 할당

// ─── 조명 (Futuristic Space Dashboard) ──────────────────────────────────────
scene.add(new THREE.AmbientLight(0x060c1e, 0.6));
const sun = new THREE.PointLight(0x06b6d4, 1.4, 700);     // Neon Cyan 키 라이트
sun.position.set(0, 60, 30);
scene.add(sun);
const rimLight = new THREE.PointLight(0xa855f7, 0.7, 400);  // Purple 림 라이트
rimLight.position.set(-140, 80, -100);
scene.add(rimLight);
const rimLight2 = new THREE.PointLight(0x34d399, 0.4, 300); // Green 필 라이트
rimLight2.position.set(120, -50, 90);
scene.add(rimLight2);
const bottomLight = new THREE.PointLight(0x06b6d4, 0.3, 200); // 하단 반사
bottomLight.position.set(0, -60, 0);
scene.add(bottomLight);

// ─── 별 배경 (다층 파티클 필드) ────────────────────────────────────────────
(function addStarField() {
  const starCount = 2400;
  const positions = new Float32Array(starCount * 3);
  const colors    = new Float32Array(starCount * 3);
  const sizes     = new Float32Array(starCount);
  const starColors = [
    [0.024, 0.714, 0.831],  // #06b6d4 — neon cyan
    [0.659, 0.333, 0.969],  // #a855f7 — purple
    [0.204, 0.827, 0.600],  // #34d399 — green
    [0.85,  0.90,  1.0],    // white-blue
    [1.0,   1.0,   1.0],    // pure white
  ];
  for (let i = 0; i < starCount; i++) {
    const r     = 500 + Math.random() * 700;
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    positions[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    positions[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i*3+2] = r * Math.cos(phi);
    const c      = starColors[Math.floor(Math.random() * starColors.length)];
    const bright = 0.25 + Math.random() * 0.75;
    colors[i*3]   = c[0] * bright;
    colors[i*3+1] = c[1] * bright;
    colors[i*3+2] = c[2] * bright;
    sizes[i] = 0.3 + Math.random() * 0.8;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors,    3));
  const mat = new THREE.PointsMaterial({
    size: 0.6, vertexColors: true, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const stars = new THREE.Points(geo, mat);
  scene.add(stars);
  // 별 회전 (애니메이션 루프에서 참조)
  window._starField = stars;
})();

// ─── 와이어프레임 노드 헬퍼 (전역) ──────────────────────────────────────────
function createWireNode(radius, color, opts = {}) {
  const group = new THREE.Group();
  const detail = opts.detail ?? 1;
  const geo = new THREE.IcosahedronGeometry(radius, detail);

  // 와이어프레임 라인
  const wireGeo = new THREE.WireframeGeometry(geo);
  const wireMat = new THREE.LineBasicMaterial({
    color: color, transparent: true, opacity: opts.wireOpacity ?? 0.3,
    blending: THREE.AdditiveBlending,
  });
  const wire = new THREE.LineSegments(wireGeo, wireMat);
  group.add(wire);

  // 반투명 글로우 쉘
  if (opts.glow !== false) {
    const glowGeo = new THREE.SphereGeometry(radius * (opts.glowScale ?? 1.15), 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: opts.glowOpacity ?? 0.05,
      blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
    });
    group.add(new THREE.Mesh(glowGeo, glowMat));
  }

  group.userData._wireNode = true;
  // 기본적으로 숨김 — 2D 카드가 시각적 표현을 담당하므로 3D 노드는 위치 마커로만 사용
  group.visible = !!opts.visible;
  return group;
}

// ─── 중앙 와이어프레임 행성 + 궤도 링 ─────────────────────────────────────────
(function addWireframePlanet() {
  // ── 와이어프레임 구 ────────────────────────────────────────────────────────
  const sphereGeo = new THREE.IcosahedronGeometry(4.5, 1);
  const wireframe = new THREE.WireframeGeometry(sphereGeo);
  const wireMat   = new THREE.LineBasicMaterial({
    color: 0x06b6d4, transparent: true, opacity: 0.25,
    blending: THREE.AdditiveBlending,
  });
  const wireMesh = new THREE.LineSegments(wireframe, wireMat);
  wireMesh.userData._isCorePlanet = true;
  scene.add(wireMesh);

  // ── 외곽 글로우 (와이어프레임) ──────────────────────────────────────────────
  const glowMesh = createWireNode(5.2, 0x06b6d4, { wireOpacity: 0.04, glow: false, detail: 0 });
  scene.add(glowMesh);

  // ── 궤도 링 3개 ───────────────────────────────────────────────────────────
  const orbitConfigs = [
    { r: 12,  color: 0x06b6d4, opacity: 0.12, tiltX: 0.3,  tiltZ: 0    },
    { r: 20,  color: 0xa855f7, opacity: 0.08, tiltX: -0.2, tiltZ: 0.4  },
    { r: 30,  color: 0x34d399, opacity: 0.06, tiltX: 0.15, tiltZ: -0.3 },
  ];
  const orbitMeshes = [];
  orbitConfigs.forEach(cfg => {
    const curve = new THREE.EllipseCurve(0, 0, cfg.r, cfg.r, 0, Math.PI * 2, false, 0);
    const pts   = curve.getPoints(120);
    const geo   = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, 0, p.y)));
    const mat   = new THREE.LineBasicMaterial({
      color: cfg.color, transparent: true, opacity: cfg.opacity,
      blending: THREE.AdditiveBlending,
    });
    const ring  = new THREE.Line(geo, mat);
    ring.rotation.x = cfg.tiltX;
    ring.rotation.z = cfg.tiltZ;
    scene.add(ring);
    orbitMeshes.push(ring);
  });

  // ── 궤도 위 작은 파티클 (도는 미세 먼지) ─────────────────────────────────
  const dustCount = 200;
  const dustPos   = new Float32Array(dustCount * 3);
  const dustCol   = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const angle = Math.random() * Math.PI * 2;
    const r     = 8 + Math.random() * 26;
    const y     = (Math.random() - 0.5) * 6;
    dustPos[i*3]   = Math.cos(angle) * r;
    dustPos[i*3+1] = y;
    dustPos[i*3+2] = Math.sin(angle) * r;
    const c = Math.random() < 0.5 ? [0.024, 0.714, 0.831] : [0.659, 0.333, 0.969];
    const b = 0.3 + Math.random() * 0.5;
    dustCol[i*3]   = c[0] * b;
    dustCol[i*3+1] = c[1] * b;
    dustCol[i*3+2] = c[2] * b;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('color',    new THREE.BufferAttribute(dustCol, 3));
  const dustMat = new THREE.PointsMaterial({
    size: 0.25, vertexColors: true, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const dustCloud = new THREE.Points(dustGeo, dustMat);
  scene.add(dustCloud);

  // 애니메이션 참조
  window._corePlanet = { wireMesh, glowMesh, orbitMeshes, dustCloud };
})();

// ─── 타입 → 색상 / 의미 매핑 ─────────────────────────────────────────────────
const TYPE_CFG = {
  'user.message':       { color:0x58a6ff, cat:'chat',  label:'질문',     icon:'💬' },
  'assistant.message':  { color:0xbc8cff, cat:'chat',  label:'AI 답변',  icon:'🤖' },
  'assistant.response': { color:0xbc8cff, cat:'chat',  label:'AI 답변',  icon:'🤖' },
  'app.activity':       { color:0x39d2c0, cat:'code',  label:'앱 활동',  icon:'📱' },
  'app_switch':         { color:0x39d2c0, cat:'code',  label:'앱 전환',  icon:'🔄' },
  'browse':             { color:0x58a6ff, cat:'code',  label:'브라우저',  icon:'🌐' },
  'browser_activity':   { color:0x58a6ff, cat:'code',  label:'브라우저',  icon:'🌐' },
  'tool.start':         { color:0x3fb950, cat:'code',  label:'실행 시작', icon:'⚡' },
  'tool.end':           { color:0x3fb950, cat:'code',  label:'실행 완료', icon:'✅' },
  'tool.error':         { color:0xf85149, cat:'error', label:'실행 오류', icon:'❌' },
  'file.read':          { color:0xffa657, cat:'file',  label:'파일 읽기', icon:'📄' },
  'file.write':         { color:0xffa657, cat:'file',  label:'파일 수정', icon:'✏️' },
  'file.create':        { color:0xffa657, cat:'file',  label:'파일 생성', icon:'🆕' },
  'git.commit':         { color:0x39d2c0, cat:'git',   label:'Git 커밋',  icon:'🌿' },
  'git.push':           { color:0x79c0ff, cat:'git',   label:'Git 푸시',  icon:'🚀' },
  'session.start':      { color:0xffd700, cat:'chat',  label:'세션 시작', icon:'🌟' },
  'task.complete':      { color:0x3fb950, cat:'code',  label:'작업 완료', icon:'🏁' },
  'default':            { color:0x3d444d, cat:'chat',  label:'기타',      icon:'·'  },
};
function typeCfg(t) { return TYPE_CFG[t] || TYPE_CFG.default; }

// ─── 파일 용도 추론 (파일명 → 역할 설명) ─────────────────────────────────────
function inferFileRole(filename) {
  if (!filename) return null;
  const f = filename.toLowerCase();
  const name = f.replace(/\.[^.]+$/, ''); // 확장자 제거

  // 인프라 / 설정
  if (/docker|compose/.test(name))          return '🐳 컨테이너';
  if (/\.env|config|setting|conf/.test(f))  return '⚙️ 설정';
  if (/package\.json/.test(f))              return '📦 의존성';
  if (/tsconfig|jsconfig/.test(f))          return '🔧 TS 설정';
  if (/eslint|prettier|lint/.test(f))       return '✨ 코드 품질';
  if (/webpack|vite|rollup|babel/.test(f))  return '⚡ 빌드';

  // 인증 / 보안
  if (/auth|login|oauth|jwt|token|session|password/.test(name)) return '🔐 인증';
  if (/security|cors|helmet|csrf/.test(name))                   return '🛡️ 보안';

  // DB / 스토어
  if (/db|database|schema|migration|model|store|entity/.test(name)) return '🗄️ 데이터';
  if (/redis|mongo|postgres|sqlite|mysql/.test(name))               return '🗄️ DB';

  // API / 라우터
  if (/route|router|api|endpoint|controller/.test(name)) return '🌐 API';
  if (/middleware|interceptor/.test(name))                return '🔀 미들웨어';
  if (/server|app\.js|main|index/.test(f))               return '🚀 서버';

  // UI
  if (/component|widget|ui|view|page|screen/.test(name)) return '🎨 UI';
  if (/style|css|scss|tailwind/.test(f))                 return '🎨 스타일';
  if (/layout|template/.test(name))                      return '📐 레이아웃';

  // 유틸 / 서비스
  if (/util|helper|lib|tool|service/.test(name)) return '🔩 유틸';
  if (/hook|context|store|state/.test(name))     return '🔄 상태';

  // 테스트
  if (/test|spec|e2e|jest|vitest/.test(f)) return '🧪 테스트';

  // 문서
  if (/readme|doc|md$/.test(f)) return '📝 문서';

  // 확장자 기반 fallback
  if (f.endsWith('.ts') || f.endsWith('.js')) return '📜 스크립트';
  if (f.endsWith('.tsx') || f.endsWith('.jsx')) return '⚛️ 컴포넌트';
  if (f.endsWith('.html')) return '🌐 페이지';
  if (f.endsWith('.json')) return '📋 데이터';
  if (f.endsWith('.sh'))   return '⚡ 스크립트';
  if (f.endsWith('.sql'))  return '🗄️ SQL';

  return null; // 추론 불가 → 파일명 그대로 사용
}

// ─── 의도(Intent) 추출 ────────────────────────────────────────────────────────
function extractIntent(node) {
  // 이미 label이 있으면 우선 사용 (API 반환 데이터)
  if (node.label && node.label !== node.type) return node.label;
  const t = node.type || '';

  // fullContent에서 data 파싱
  let d = node.data || {};
  const fc = node.fullContent;
  if (fc && typeof fc === 'string' && fc.startsWith('{')) {
    try { d = { ...d, ...JSON.parse(fc) }; } catch {}
  }

  if (t === 'user.message') {
    const txt = d.contentPreview || d.content || '';
    return txt ? txt.slice(0,38) : '질문';
  }
  if (t === 'assistant.message' || t === 'assistant.response') {
    const txt = d.contentPreview || d.content || '';
    return txt ? txt.slice(0,38) : 'AI 답변';
  }
  if (t === 'tool.end' || t === 'tool.start') {
    const tool = d.toolName || '';
    const file = (d.filePath||'').replace(/\\/g,'/').split('/').pop();
    const role = file ? inferFileRole(file) : null;
    const TOOLS = {
      'Write':'작성', 'Edit':'수정', 'Read':'읽기',
      'Bash':'실행', 'Grep':'검색', 'Glob':'탐색',
      'Task':'에이전트', 'WebFetch':'웹 조회',
    };
    const tl = TOOLS[tool] || tool;
    if (role && file) return `${role} ${tl}`;
    return file ? `${tl}: ${file}` : (tl || t);
  }
  if (t === 'file.write' || t === 'file.create') {
    const f = (d.filePath||d.fileName||'').replace(/\\/g,'/').split('/').pop();
    const role = inferFileRole(f);
    return role ? `${role} 수정` : (f ? `✏️ ${f}` : '파일 수정');
  }
  if (t === 'file.read') {
    const f = (d.filePath||d.fileName||'').replace(/\\/g,'/').split('/').pop();
    const role = inferFileRole(f);
    return role ? `${role} 읽기` : (f ? `📄 ${f}` : '파일 읽기');
  }
  if (t === 'git.commit') return d.message ? d.message.slice(0,36) : 'Git 커밋';
  if (t === 'task.complete') return d.taskName || '작업 완료';
  if (t === 'session.start') return '세션 시작';

  // ── 외부 활동 이벤트 → 작업 설명 변환 ─────────────────────────────────────
  if (t === 'terminal.command') {
    const cmd = (d.command || '').trim();
    if (!cmd) return '⚡ 터미널';
    // 명령어 → 작업 의미 변환
    if (/^(git\s+(push|pull|merge|rebase))/.test(cmd)) return '🌿 ' + cmd.slice(0,30);
    if (/^git\s+commit/.test(cmd))  return '📦 커밋: ' + (cmd.match(/-m\s+["']?(.+?)["']?$/)?.[1] || '').slice(0,24);
    if (/^(npm|yarn|pnpm)\s+(install|add)/.test(cmd)) return '📥 패키지 설치';
    if (/^(npm|yarn)\s+(run\s+)?(test|jest|vitest)/.test(cmd)) return '🧪 테스트 실행';
    if (/^(npm|yarn)\s+(run\s+)?(build|compile)/.test(cmd)) return '🏗️ 빌드';
    if (/^(npm|yarn)\s+(run\s+)?(dev|start)/.test(cmd)) return '🚀 서버 시작';
    if (/^(docker|docker-compose)/.test(cmd)) return '🐳 Docker: ' + cmd.slice(0,24);
    if (/^(cd|ls|dir|cat|echo)/.test(cmd)) return '📂 탐색: ' + cmd.slice(0,24);
    if (/^(curl|wget|fetch)/.test(cmd)) return '🌐 HTTP 요청';
    if (/^(ssh|scp|rsync)/.test(cmd)) return '🔗 원격 접속';
    return '⚡ ' + cmd.slice(0,30);
  }
  if (t.startsWith('vscode.')) {
    const sub = t.replace('vscode.', '');
    const file = (d.fileName || d.filePath || '').replace(/\\/g,'/').split('/').pop();
    if (sub === 'file.open' || sub === 'activeEditor')  return file ? `📝 편집: ${file}` : '📝 VS Code 편집';
    if (sub === 'file.save')     return file ? `💾 저장: ${file}` : '💾 파일 저장';
    if (sub === 'debug.start')   return '🐛 디버깅 시작';
    if (sub === 'terminal')      return '⚡ VS Code 터미널';
    if (sub === 'extension')     return '🧩 확장 사용: ' + (d.extensionId || '').slice(0,20);
    return '💻 VS Code: ' + sub;
  }
  if (t === 'browser_activity' || t === 'browse') {
    const title = (d.title || '').slice(0,30);
    const url   = d.url || '';
    if (/stackoverflow|github.*issue|reddit/.test(url))    return '🔍 문제 해결: ' + title;
    if (/github\.com.*\/pull/.test(url))                   return '🔀 PR 리뷰: ' + title;
    if (/github\.com/.test(url))                           return '🐙 GitHub: ' + title;
    if (/docs\.|documentation|mdn|devdocs/.test(url))      return '📚 문서 참조: ' + title;
    if (/chatgpt|claude|bard|gemini|perplexity/.test(url)) return '🤖 AI 대화: ' + title;
    if (/youtube|udemy|coursera/.test(url))                return '🎓 학습: ' + title;
    if (/figma|canva|design/.test(url))                    return '🎨 디자인: ' + title;
    if (/jira|linear|notion|trello/.test(url))             return '📋 프로젝트 관리: ' + title;
    if (/slack|discord|teams/.test(url))                   return '💬 소통: ' + title;
    if (/mail\.|gmail|outlook/.test(url))                  return '📧 이메일: ' + title;
    if (/google\.(com|co).*\/search/.test(url))            return '🔍 검색: ' + title;
    return title ? '🌐 ' + title : '🌐 브라우저';
  }
  // ── 시스템 모니터: 앱 전환 이벤트 → 작업 설명 ────────────────────────────
  if (t === 'app_switch') {
    const app   = (d.app || '').toLowerCase();
    const title = (d.title || '').slice(0,30);
    const cat   = d.category || '';
    if (/chrome|edge|firefox|safari|brave/i.test(app))     return title ? '🌐 ' + title : '🌐 브라우저';
    if (/vscode|cursor|zed|sublime|idea/i.test(app))       return title ? '💻 ' + title : '💻 코드 편집';
    if (/word|한글|hwp|pages|docs/i.test(app))             return title ? '📝 ' + title : '📝 문서 작성';
    if (/excel|numbers|sheets|calc/i.test(app))            return title ? '📊 ' + title : '📊 스프레드시트';
    if (/powerpoint|keynote|impress/i.test(app))           return title ? '📊 ' + title : '📊 프레젠테이션';
    if (/zoom|teams|meet|webex|slack|discord/i.test(app))  return title ? '💬 ' + title : '💬 미팅/소통';
    if (/notion|obsidian|bear|evernote/i.test(app))        return title ? '📝 ' + title : '📝 노트 작성';
    if (/terminal|iterm|warp|hyper|powershell|cmd/i.test(app)) return title ? '⚡ ' + title : '⚡ 터미널';
    if (/figma|sketch|xd|illustrator|photoshop/i.test(app)) return title ? '🎨 ' + title : '🎨 디자인';
    if (/mail|outlook|thunderbird/i.test(app))             return title ? '📧 ' + title : '📧 이메일';
    return title ? `📱 ${app}: ${title}` : `📱 ${app || '앱 전환'}`;
  }
  // ── app.activity (DB에 저장된 시스템 모니터 이벤트) ───────────────────
  if (t === 'app.activity') {
    const app   = (d.app || '').toLowerCase();
    const title = (d.title || '').slice(0,30);
    const url   = d.url || '';
    if (url) {
      // URL 기반 분류 (browse 타입과 동일)
      if (/stackoverflow|github.*issue|reddit/.test(url))    return '🔍 문제 해결: ' + title;
      if (/github\.com.*\/pull/.test(url))                   return '🔀 PR 리뷰: ' + title;
      if (/github\.com/.test(url))                           return '🐙 GitHub: ' + title;
      if (/docs\.|documentation|mdn|devdocs/.test(url))      return '📚 문서 참조: ' + title;
      if (/chatgpt|claude|bard|gemini|perplexity/.test(url)) return '🤖 AI 대화: ' + title;
      return title ? '🌐 ' + title : '🌐 브라우저';
    }
    if (/vscode|cursor|zed|sublime|idea/i.test(app))       return title ? '💻 ' + title : '💻 코드 편집';
    if (/chrome|edge|firefox|safari|brave/i.test(app))     return title ? '🌐 ' + title : '🌐 브라우저';
    if (/zoom|teams|meet|slack|discord/i.test(app))        return title ? '💬 ' + title : '💬 소통';
    if (/terminal|iterm|warp|powershell|cmd/i.test(app))   return title ? '⚡ ' + title : '⚡ 터미널';
    return title ? `📱 ${title}` : (app ? `📱 ${app}` : '📱 앱 활동');
  }
  if (t === 'keylog_insight') {
    const topic = d.topic || d.activity || '';
    if (topic) return '⌨️ ' + topic.slice(0,30);
    return '⌨️ 키 입력 분석';
  }
  if (t === 'ai_tool_event') {
    const tool = d.tool || '';
    const topic = (d.topic || '').slice(0,24);
    return topic ? `🤖 ${tool}: ${topic}` : `🤖 ${tool || 'AI'} 사용`;
  }

  return d.toolName || d.contentPreview || t;
}

// ─── 파일 위성 집계 (세션별 편집 파일 → 용도 태그 목록) ─────────────────────
function buildFileSatellites(events) {
  const fileCounts = {};
  for (const e of events) {
    // data 또는 fullContent에서 filePath 추출
    let d = e.data || {};
    const fc = e.fullContent;
    if (fc && typeof fc === 'string' && fc.startsWith('{')) {
      try { d = { ...d, ...JSON.parse(fc) }; } catch {}
    } else if (fc && typeof fc === 'string' && fc.includes('/')) {
      d = { ...d, filePath: fc };
    }
    const rawPath = d.filePath || d.fileName || '';
    if (!rawPath) continue;
    const fname = rawPath.replace(/\\/g, '/').split('/').pop();
    if (!fname || fname.length < 2) continue;
    if (!fileCounts[fname]) fileCounts[fname] = { count:0, types: new Set() };
    fileCounts[fname].count++;
    fileCounts[fname].types.add(e.type);
  }
  // 상위 12개, 용도 추론
  return Object.entries(fileCounts)
    .sort((a,b) => b[1].count - a[1].count)
    .slice(0, 12)
    .map(([fname, info]) => {
      const role = inferFileRole(fname);
      // 실제 파일명(확장자 포함) 우선 표시, 역할 아이콘은 앞에 prefix
      const shortName = fname.split('/').pop(); // 경로 제거, 파일명만
      const roleIcon  = role ? role.split(' ')[0] : '📄'; // 이모지만 추출
      return {
        label:    `${roleIcon} ${shortName}`,  // "📋 server.js" 형식
        roleDesc: role || '파일',              // 역할 설명 (툴팁용)
        filename: fname,
        count:    info.count,
        isWrite:  info.types.has('file.write') || info.types.has('tool.end'),
      };
    });
}

// ─── 목적 기반 클러스터링 ─────────────────────────────────────────────────────
// 세션이 1개여도 이벤트를 "목적/의도 도메인"으로 묶어 복수 행성으로 표시
function clusterByIntent(sessionId, events) {
  // ── 1. purposeLabel이 있으면 최우선 활용 ──────────────────────────────────
  const hasPurpose = events.some(e => e.purposeLabel);

  if (hasPurpose) {
    const purposeMap = {};
    for (const ev of events) {
      const key = ev.purposeLabel || '⚙️ 기타';
      if (!purposeMap[key]) {
        purposeMap[key] = {
          clusterId:  `${sessionId}__${key}`,
          sessionId,
          domain:     'purpose',
          label:      key,
          icon:       ev.purposeIcon || '⚙️',
          color:      ev.purposeColor || '#8b949e',
          msgPreview: '',
          events:     [],
        };
      }
      purposeMap[key].events.push(ev);
    }

    // 첫 user.message 프리뷰 보강
    for (const cluster of Object.values(purposeMap)) {
      const msg = cluster.events.find(e => e.type === 'user.message');
      cluster.msgPreview = (msg?.label || '').slice(0, 26);
    }

    return Object.values(purposeMap).sort((a, b) => b.events.length - a.events.length);
  }

  // ── 2. purposeLabel 없으면 파일경로/라벨/타입 기반 도메인 분류 ────────────
  function getDomain(ev) {
    const t = ev.type || '';

    // fullContent JSON에서 filePath 추출
    let fp = '';
    const fc = ev.fullContent || ev.label || '';
    if (typeof fc === 'string' && fc.startsWith('{')) {
      try { fp = JSON.parse(fc).filePath || ''; } catch {}
    } else if (typeof fc === 'string' && fc.includes('/')) {
      fp = fc;
    }
    // label에서 파일명 추출 ("파일 작성: auth.js" 형태)
    const labelFile = (ev.label || '').match(/[:\s]+([^\s:]+\.[a-z]+)/i)?.[1] || '';
    const fname = (fp || labelFile).replace(/\\/g, '/').split('/').pop().toLowerCase();

    if (/auth|login|oauth|jwt|token|session|password/.test(fname)) return 'auth';
    if (/route|router|api|endpoint|controller/.test(fname))        return 'api';
    if (/db|database|schema|migration|model|store|entity/.test(fname)) return 'data';
    if (/component|widget|ui|view|page|screen|style|css/.test(fname))  return 'ui';
    if (/test|spec|e2e|jest|vitest/.test(fname))                        return 'test';
    if (/server|app\.js|main|index/.test(fname))                        return 'server';
    if (/docker|compose|deploy|ci|cd|yml|yaml/.test(fname))            return 'infra';
    if (/doc|readme|md$/.test(fname))                                   return 'docs';

    // label/대화 기반
    const txt = (ev.label || '').toLowerCase();
    if (/버그|오류|에러|fix|bug|error/.test(txt))      return 'fix';
    if (/설계|구조|아키텍|design|architect/.test(txt)) return 'design';
    if (/배포|deploy|release|publish/.test(txt))        return 'infra';
    if (/테스트|test|spec/.test(txt))                   return 'test';

    if (t === 'user.message' || t === 'assistant.message' || t === 'assistant.response') return 'chat';
    if (t === 'git.commit' || t === 'git.push') return 'git';
    if (t === 'tool.error') return 'fix';
    if (t === 'terminal.command') return 'server';
    if (t.startsWith('vscode.')) return 'ui';
    if (t === 'browser_activity' || t === 'browse') {
      const url = (ev.data?.url || '').toLowerCase();
      if (/docs\.|mdn|devdocs|stackoverflow/.test(url)) return 'docs';
      if (/chatgpt|claude|bard|gemini/.test(url)) return 'chat';
      if (/figma|canva/.test(url)) return 'ui';
      if (/github\.com|gitlab|bitbucket/.test(url)) return 'api';
      if (/jira|linear|asana|trello|notion/.test(url)) return 'design';
      if (/mail\.|gmail|outlook/.test(url)) return 'docs';
      return 'general';
    }
    if (t === 'app_switch') {
      const app = (ev.data?.app || '').toLowerCase();
      if (/vscode|cursor|zed|sublime|idea/i.test(app)) return 'ui';
      if (/terminal|iterm|warp|powershell|cmd/i.test(app)) return 'server';
      if (/chrome|edge|firefox|safari|brave/i.test(app)) return 'general';
      if (/zoom|teams|meet|slack|discord/i.test(app)) return 'docs';
      if (/figma|sketch|xd|photoshop|illustrator/i.test(app)) return 'ui';
      if (/word|한글|hwp|pages|notion|obsidian/i.test(app)) return 'docs';
      return 'general';
    }
    if (t === 'app.activity') {
      const app2 = (ev.data?.app || '').toLowerCase();
      const url2 = (ev.data?.url || '').toLowerCase();
      if (url2) {
        if (/docs\.|mdn|devdocs|stackoverflow/.test(url2)) return 'docs';
        if (/github\.com|gitlab|bitbucket/.test(url2)) return 'api';
        if (/chatgpt|claude|bard|gemini/.test(url2)) return 'chat';
        if (/figma|canva/.test(url2)) return 'ui';
        return 'general';
      }
      if (/vscode|cursor|zed|sublime|idea/i.test(app2)) return 'ui';
      if (/terminal|iterm|warp|powershell|cmd/i.test(app2)) return 'server';
      return 'general';
    }
    if (t === 'keylog_insight' || t === 'ai_tool_event') return 'chat';

    return 'general';
  }

  const DOMAIN_LABELS = {
    auth:     '🔐 인증 구현',  api:   '🌐 API 개발',
    data:     '🗄️ 데이터',    ui:    '🎨 UI 작업',
    test:     '🧪 테스트',     server:'🚀 서버 개발',
    infra:    '🐳 인프라',     docs:  '📝 문서화',
    design:   '📐 설계 논의',  fix:   '🔧 버그 수정',
    git:      '🌿 Git 관리',   chat:  '💬 대화',
    general:  '⚙️ 일반 작업',
  };

  const domainMap = {};
  for (const ev of events) {
    const domain = getDomain(ev);
    if (!domainMap[domain]) domainMap[domain] = [];
    domainMap[domain].push(ev);
  }

  // 너무 작은 클러스터는 general로 병합
  const minSize = Math.max(2, Math.floor(events.length * 0.04));
  const merged = {};
  for (const [domain, evs] of Object.entries(domainMap)) {
    const target = (evs.length <= minSize && domain !== 'general') ? 'general' : domain;
    if (!merged[target]) merged[target] = [];
    merged[target].push(...evs);
  }

  const clusters = [];
  for (const [domain, evs] of Object.entries(merged)) {
    // 첫 user.message에서 실제 작업 내용 추출
    const msg = evs.find(e => e.type === 'user.message');
    let msgText = '';
    if (msg) {
      const d = msg.data || {};
      msgText = (d.contentPreview || d.content || msg.label || '').slice(0, 30);
    }
    // git commit 메시지도 후보로 활용
    if (!msgText) {
      const gitEv = evs.find(e => e.type === 'git.commit');
      msgText = (gitEv?.data?.message || '').slice(0, 30);
    }
    // 라벨: 작업 설명이 있으면 도메인 라벨 + 설명 조합
    const domainLabel = DOMAIN_LABELS[domain] || '⚙️ 작업';
    const label = msgText ? `${domainLabel}  ${msgText}` : domainLabel;

    clusters.push({
      clusterId:  `${sessionId}__${domain}`,
      sessionId,
      domain,
      label,
      msgPreview: msgText,
      events:     evs,
    });
  }

  clusters.sort((a, b) => b.events.length - a.events.length);
  return clusters;
}

// ─── 세션 컨텍스트 캐시 (비동기 로드) ────────────────────────────────────────
const _sessionContextCache = {};   // sessionId → { autoTitle, projectName, firstMsg, topFile }

async function loadSessionContext(sessionId) {
  if (_sessionContextCache[sessionId]) return _sessionContextCache[sessionId];
  try {
    const r = await fetch(`/api/sessions/${sessionId}/context`);
    if (!r.ok) return null;
    const ctx = await r.json();
    _sessionContextCache[sessionId] = ctx;
    // 행성 라벨 즉시 업데이트 — label-rules.js (single source of truth)
    const planet = _sessionMap[sessionId]?.planet;
    if (planet) {
      // firstMsg를 항상 저장해둠 (drawLabels fallback용)
      if (ctx.firstMsg) planet.userData.firstMsg = ctx.firstMsg;

      // deriveContextLabel: firstMsg > autoTitle(meaningful+non-abstract) > null
      const specificLabel = deriveContextLabel(ctx);

      if (specificLabel) {
        planet.userData.intent = specificLabel;
      } else if (ctx.aiLabel && isMeaningfulLabel(ctx.aiLabel)) {
        planet.userData.intent = ctx.aiLabel;   // 추상 카테고리지만 없는 것보다 낫다
      } else if (isMeaningfulLabel(ctx.autoTitle)) {
        planet.userData.intent = ctx.autoTitle;
      }
      // AI 프로젝트 타입 업데이트 (새 타입 + 레거시 dev/research/ops 모두 허용)
      if (ctx.aiCat && (PROJECT_TYPES[ctx.aiCat] || ['dev', 'research', 'ops'].includes(ctx.aiCat))) {
        // 레거시 값 → 새 타입 매핑
        const legacyMap = { dev: 'development', research: 'web_research', ops: 'development' };
        planet.userData.macroCat = legacyMap[ctx.aiCat] || ctx.aiCat;
      }
      if (ctx.projectName) {
        const oldProj = planet.userData.projectName;
        const newProj = ctx.projectName;
        if (oldProj !== newProj) {
          planet.userData.projectName = newProj;
          // _projectGroups 재구성
          _projectGroups = {};
          planetMeshes.forEach(p => {
            const proj = p.userData.projectName || '기타';
            if (!_projectGroups[proj]) _projectGroups[proj] = { planetMeshes: [], color: p.userData.hueHex || '#58a6ff' };
            _projectGroups[proj].planetMeshes.push(p);
          });
        }
      }
    }
    return ctx;
  } catch { return null; }
}

// 세션의 대표 의도 (로컬 이벤트 기반 — 비동기 컨텍스트 로드 전 임시값)
function sessionIntent(events) {
  const sid = events[0]?.sessionId;

  // 이미 캐시됐으면 사용
  if (sid && _sessionContextCache[sid]) return _sessionContextCache[sid].autoTitle;

  // session.start의 data.title (수동 설정 우선)
  const sessStart = events.find(e => e.type === 'session.start');
  if (sessStart?.data?.title) return sessStart.data.title;

  // projectDir 폴더명
  const pd = sessStart?.data?.projectDir;
  const projectName = pd ? pd.replace(/\\/g,'/').split('/').filter(Boolean).pop() : null;

  // 파일 편집 횟수 집계
  const fileCounts = {};
  for (const e of events) {
    const d = e.data || {};
    const f = (d.filePath||d.fileName||'').replace(/\\/g,'/').split('/').pop();
    if (f) fileCounts[f] = (fileCounts[f]||0) + 1;
  }
  const topFile = Object.entries(fileCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

  // 첫 user.message — fullContent JSON에서도 content 추출 시도
  const msg = events.find(e => e.type === 'user.message');
  let firstMsg = null;
  if (msg) {
    let md = msg.data || {};
    const mfc = msg.fullContent;
    if (mfc && typeof mfc === 'string' && mfc.startsWith('{')) {
      try { md = { ...md, ...JSON.parse(mfc) }; } catch {}
    }
    firstMsg = (md.contentPreview || md.content || msg.label || '').slice(0, 36) || null;
  }
  // git commit 메시지도 후보
  if (!firstMsg) {
    const gitMsg = events.find(e => e.type === 'git.commit');
    firstMsg = (gitMsg?.data?.message || '').slice(0, 36) || null;
  }

  // ── 브라우저/앱 활동 세션 → 도메인 라벨 (작업 설명 우선) ─────────────────
  const browseEvs = events.filter(e => e.type === 'browser_activity' || e.type === 'browse' || e.type === 'app_switch');
  let domainLabel = null;
  if (browseEvs.length > 0) {
    const latest = browseEvs[browseEvs.length - 1];
    const latentLabel = extractIntent(latest);
    if (latentLabel && latentLabel !== '🌐 브라우저') {
      const uniqueApps = new Set(browseEvs.map(e => (e.data?.app || e.data?.title || '').slice(0,20)));
      const appCount = uniqueApps.size;
      domainLabel = appCount > 1 ? `${latentLabel} (+${appCount - 1}개 작업)` : latentLabel;
    }
  }
  if (!domainLabel && sid) {
    const cls = clusterByIntent(sid, events);
    const best = cls.find(c => c.domain !== 'general') || cls[0];
    if (best?.label) domainLabel = best.label;
  }

  // 조합 우선순위: firstMsg → domainLabel → topFile
  if (projectName && firstMsg)    return `[${projectName}] ${firstMsg}`;
  if (projectName && domainLabel) return `[${projectName}] ${domainLabel}`;
  if (projectName && topFile)     return `[${projectName}] ${topFile}`;
  if (projectName)                return projectName;
  if (firstMsg)                   return firstMsg;
  if (domainLabel)                return domainLabel;
  if (topFile)                    return topFile;

  // 도메인 라벨 폴백
  if (sid) {
    // 세션명 readable 변환 (UUID가 아닌 경우, 'session' prefix 제거)
    if (!/^[0-9a-f]{8}-/.test(sid) && sid.length <= 30) {
      const parts = sid.split(/[-_]/).filter(s => s && s !== 'session' && s !== 'wf');
      if (parts.length > 0) {
        return parts.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ').slice(0, 30);
      }
    }
  }
  return '⚙️ 작업 중';
}

// ─── OrbitControls 인라인 ─────────────────────────────────────────────────────
class OrbitCam {
  constructor(cam, el) {
    this.cam = cam; this.el = el;
    this.tgt = new THREE.Vector3();
    this.sph = { r:55, θ:0.3, φ:1.1 };                  // 컴팩트 뷰 기본 거리
    this._d = false; this._r = false; this._lx=0; this._ly=0;
    this._dragging = false; // 드래그 중 플래그 (자동전환 방지)
    this._dragStartX = 0; this._dragStartY = 0;
    this._dragThresholdMet = false;
    this._mouseOnHit = false; // 히트 영역 위에서 마우스다운 → 패닝 차단
    const DRAG_THRESH = 6;
    el.addEventListener('mousedown',  e => {
      this._lx=e.clientX; this._ly=e.clientY;
      this._dragStartX = e.clientX; this._dragStartY = e.clientY;
      this._dragThresholdMet = false;
      // 히트 영역 위 클릭이면 패닝 차단 (_hoveredHit은 매 프레임 갱신되어 정확)
      this._mouseOnHit = !!(typeof _hoveredHit !== 'undefined' && _hoveredHit);
      if (e.button===2 || e.button===1 || (e.button===0 && e.shiftKey)) this._r=true;
      else if (e.button===0) this._d=true;
      this._dragging=true;
    });
    el.addEventListener('mousemove',  e => this._move(e, DRAG_THRESH));
    el.addEventListener('mouseup',    () => { this._d=this._r=false; this._dragging=false; this._dragThresholdMet=false; this._mouseOnHit=false; });
    el.addEventListener('wheel', e => {
      if (typeof _selectedHit !== 'undefined' && _selectedHit) return;
      if (_worldLocked) return; // 잠금 시 줌 차단
      const factor = e.deltaY > 0 ? 0.92 : 1.085;
      _worldScale = Math.max(0.08, Math.min(3.0, _worldScale * factor));
      window._worldScale = _worldScale;
    }, {passive:true});
    el.addEventListener('dblclick',   e => this._dbl(e));
    el.addEventListener('contextmenu',e => e.preventDefault());
    this._apply();
  }
  _move(e, DRAG_THRESH) {
    const dx=e.clientX-this._lx, dy=e.clientY-this._ly;
    this._lx=e.clientX; this._ly=e.clientY;
    // 드래그 threshold: 마우스다운 지점에서 6px 이상 움직여야 패닝 시작
    if (this._d && !this._dragThresholdMet) {
      const totalDx = e.clientX - this._dragStartX;
      const totalDy = e.clientY - this._dragStartY;
      if (Math.sqrt(totalDx*totalDx + totalDy*totalDy) < DRAG_THRESH) return;
      this._dragThresholdMet = true;
    }
    // 히트 영역 위에서 시작한 드래그 또는 잠금 상태 → 차단
    if (this._d && this._dragThresholdMet && !this._mouseOnHit && !_worldLocked) {
      // 좌클릭 드래그 → 시점 회전 (중심 고정, 보는 각도 변경)
      _viewYaw += dx * 0.004;
      _viewPitch = Math.max(-1.2, Math.min(1.2, _viewPitch - dy * 0.004));
      window._viewYaw = _viewYaw; window._viewPitch = _viewPitch;
    } else if (this._r) {
      // 우클릭/Shift → 3D 배경 회전
      this.sph.θ -= dx*.003;
      this.sph.φ = Math.max(.05, Math.min(Math.PI-.05, this.sph.φ+dy*.003));
      this._apply();
    }
  }
  _dbl(e) {
    // 더블클릭: hitTest 기반으로 선택 노드에 줌인
    const hit = hitTest(e.clientX, e.clientY);
    if (hit && hit.obj?.position) {
      this.tgt.copy(hit.obj.position);
      this.sph.r = 40; this._apply();
    }
  }
  _apply() {
    const {r,θ,φ}=this.sph;
    this.cam.position.set(
      this.tgt.x + r*Math.sin(φ)*Math.sin(θ),
      this.tgt.y + r*Math.cos(φ),
      this.tgt.z + r*Math.sin(φ)*Math.cos(θ),
    );
    this.cam.lookAt(this.tgt);
  }
}

const _raycaster = new THREE.Raycaster();
const controls   = new OrbitCam(camera, renderer.domElement);

// ─── 줌 컨트롤 UI (DOM) ─────────────────────────────────────────────────────
(function createZoomControls() {
  const container = document.createElement('div');
  container.id = 'zoom-controls';
  Object.assign(container.style, {
    position: 'fixed', right: '16px', bottom: '80px', zIndex: '500',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px',
    background: 'rgba(2,6,23,0.8)', borderRadius: '12px', padding: '8px 6px',
    border: '1px solid rgba(100,116,139,0.25)', backdropFilter: 'blur(8px)',
  });

  function mkBtn(label, title, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label; btn.title = title;
    Object.assign(btn.style, {
      width: '32px', height: '32px', border: 'none', borderRadius: '8px',
      background: 'rgba(100,116,139,0.15)', color: '#cbd5e1', fontSize: '16px',
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'background .15s',
    });
    btn.onmouseenter = () => btn.style.background = 'rgba(6,182,212,0.25)';
    btn.onmouseleave = () => btn.style.background = _worldLocked && label === '🔒' ? 'rgba(6,182,212,0.3)' : 'rgba(100,116,139,0.15)';
    btn.onclick = onClick;
    return btn;
  }

  // 줌인
  const zoomInBtn = mkBtn('+', '줌인', () => {
    if (_worldLocked) return;
    _animateWorldScale(Math.min(3.0, _worldScale * 1.3), 200);
  });

  // 줌아웃
  const zoomOutBtn = mkBtn('−', '줌아웃', () => {
    if (_worldLocked) return;
    _animateWorldScale(Math.max(0.08, _worldScale * 0.7), 200);
  });

  // 슬라이더 (세로)
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = '8'; slider.max = '300'; slider.value = '100';
  slider.title = '줌 레벨';
  Object.assign(slider.style, {
    width: '80px', height: '4px', margin: '4px 0',
    transform: 'rotate(-90deg)', transformOrigin: 'center',
    accentColor: '#06b6d4', cursor: 'pointer',
  });
  slider.oninput = () => {
    if (_worldLocked) { slider.value = Math.round(_worldScale * 100); return; }
    _worldScale = parseInt(slider.value) / 100;
    window._worldScale = _worldScale;
  };
  // 슬라이더 업데이트 (매 프레임)
  setInterval(() => { slider.value = Math.round(_worldScale * 100); }, 200);

  // 슬라이더 컨테이너 (세로 공간 확보)
  const sliderWrap = document.createElement('div');
  Object.assign(sliderWrap.style, { width: '32px', height: '80px', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  sliderWrap.appendChild(slider);

  // 잠금 버튼
  const lockBtn = mkBtn('🔓', '줌/팬 잠금', () => {
    _worldLocked = !_worldLocked;
    window._worldLocked = _worldLocked;
    lockBtn.textContent = _worldLocked ? '🔒' : '🔓';
    lockBtn.title = _worldLocked ? '잠금 해제' : '줌/팬 잠금';
    lockBtn.style.background = _worldLocked ? 'rgba(6,182,212,0.3)' : 'rgba(100,116,139,0.15)';
  });

  // 홈 (리셋)
  const homeBtn = mkBtn('⌂', '초기 뷰', () => {
    _worldLocked = false; window._worldLocked = false;
    lockBtn.textContent = '🔓';
    lockBtn.style.background = 'rgba(100,116,139,0.15)';
    _animateWorldPan(0, 0, 400);
    _animateWorldScale(1.0, 400);
    _animateViewAngle(0, 0, 400);
    if (typeof window.clearViewStateStack === 'function') window.clearViewStateStack();
  });

  container.appendChild(zoomInBtn);
  container.appendChild(sliderWrap);
  container.appendChild(zoomOutBtn);
  container.appendChild(lockBtn);
  container.appendChild(homeBtn);
  document.body.appendChild(container);
})();

// ─── 씬 오브젝트 ──────────────────────────────────────────────────────────────
// 행성/위성은 "보이지 않는 Three.js Object3D"로 위치만 관리
// 실제 렌더링은 Canvas2D drawLabels()가 담당
let planetMeshes    = [];   // Object3D (invisible) — 위치 추적용
let satelliteMeshes = [];   // Object3D (invisible) — 위치 추적용
let orbitRings      = [];   // Mesh — 궤도 링 (Three.js)
let connections     = [];   // Line — 연결선 (Three.js, 희미하게)
let labelSprites    = [];   // unused legacy

let _allNodes   = [];
let _sessionMap = {};   // sessionId → { planet:Object3D, fileSats:[], events:[] }
let _nodeDataMap = {};  // uuid → data for interaction

let orbitAnimOn = true;
let _clock = 0;

// 호버/클릭을 위한 2D 히트 영역 — orbit3d-canvas2d-hit.js 로 이동
// _hitAreas, _hoveredHit, _selectedHit, hitTest(), updateRaycast() → canvas2d-hit.js

// ── 프로젝트별 별자리 클러스터링 ─────────────────────────────────────────────
let _projectGroups  = {};   // projectName → { planetMeshes:[], color:string }
let _focusedProject = null; // null=별자리 전체 뷰, 'name'=특정 프로젝트 집중

// ── 스마트 프로젝트 타입 시스템 (활동 패턴 기반 자동 감지) ────────────────────
// 고정 3카테고리(dev/research/ops) 대신, 실제 활동에서 프로젝트 유형을 감지
const PROJECT_TYPES = {
  content:       { label: '콘텐츠 제작',   icon: '🎬', color: '#ff6b6b' },
  web_research:  { label: '웹 리서치',     icon: '🔍', color: '#d2a8ff' },
  data:          { label: '데이터 분석',   icon: '📊', color: '#3fb950' },
  development:   { label: '개발',         icon: '💻', color: '#58a6ff' },
  design:        { label: '디자인',       icon: '🎨', color: '#f778ba' },
  writing:       { label: '문서 작성',    icon: '📝', color: '#e3b341' },
  communication: { label: '커뮤니케이션',  icon: '💬', color: '#39d2c0' },
  general:       { label: '일반 작업',    icon: '⚙️', color: '#8b949e' },
};

// 하위호환: 기존 코드가 MACRO_CATS를 참조하는 곳 대비
const MACRO_CATS = PROJECT_TYPES;

let _categoryGroups = {};   // projectType → { projects:{}, planets:[], color }
let _focusedCategory = null; // null=전체뷰, 'development'|'web_research'|...=타입 집중
// 현재 데이터에서 감지된 활성 프로젝트 타입 목록 (동적)
let _activeProjectTypes = [];

// ── 스마트 프로젝트 타입 감지 ────────────────────────────────────────────────
// 이벤트 패턴을 분석해서 어떤 종류의 프로젝트인지 자동 판별
// PPT+영상AI+이미지AI → 콘텐츠 제작, 크롬+YouTube → 웹 리서치, Excel → 데이터 분석 등
function detectProjectType(events) {
  const scores = {};
  for (const type of Object.keys(PROJECT_TYPES)) scores[type] = 0;

  for (const e of events) {
    const t = e.type || '';
    const d = e.data || {};
    const tool = (d.toolName || '').toLowerCase();
    const app  = (d.app || '').toLowerCase();
    const url  = (d.url || '').toLowerCase();
    const file = (d.filePath || d.fileName || '').toLowerCase();
    const title = (d.title || e.label || '').toLowerCase();
    const combined = `${app} ${title} ${url}`;

    // ── 콘텐츠 제작: 영상 편집, 이미지 생성 AI, PPT ──────────────────────
    if (/premiere|aftereffects|davinci|final.cut|capcut|filmora|imovie|openshot/i.test(combined)) scores.content += 4;
    if (/midjourney|dall-e|stable.diffusion|runway|gen-2|suno|kling|pika|luma/i.test(combined)) scores.content += 4;
    if (/gamma\.app|beautiful\.ai|slidesgo|pitch\.com/i.test(combined)) scores.content += 3;
    if (/powerpoint|keynote/i.test(app)) scores.content += 2;
    if (/\.(mp4|mov|avi|mkv|psd|ai|pptx?|prproj|aep)$/i.test(file)) scores.content += 3;
    if (/canva/i.test(combined)) scores.content += 2;
    if (/youtube.*upload|영상.*편집|thumbnail|render/i.test(combined)) scores.content += 2;

    // ── 웹 리서치: 브라우저 검색, YouTube 시청, 조사 ──────────────────────
    if ((t === 'browse' || t === 'browser_activity') && url) {
      scores.web_research += 1;  // 모든 브라우징에 기본 점수
      if (/youtube\.com\/watch|youtube\.com\/results/i.test(url)) scores.web_research += 3;
      if (/google\.com\/search|naver\.com\/search|bing\.com\/search/i.test(url)) scores.web_research += 3;
      if (/arxiv|scholar\.google|wikipedia|stackoverflow|reddit/i.test(url)) scores.web_research += 3;
      if (/medium\.com|dev\.to|velog\.io|tistory/i.test(url)) scores.web_research += 2;
    }
    if (t === 'app_switch' && /chrome|safari|firefox|edge|brave|arc/i.test(app) && !url) scores.web_research += 1;
    if (t === 'tool.end' && /^(WebFetch|WebSearch)$/.test(d.toolName)) scores.web_research += 2;

    // ── 데이터 분석: 스프레드시트, BI 도구, 데이터 파일 ───────────────────
    if (/excel|numbers|sheets|libreoffice.calc/i.test(app)) scores.data += 4;
    if (/tableau|power.bi|metabase|looker|grafana|jupyter|rstudio|pandas/i.test(combined)) scores.data += 4;
    if (/\.(xlsx?|csv|tsv|json|parquet|sql|sqlite|db)$/i.test(file)) scores.data += 3;
    if (/analytics|dashboard|통계|분석|pivot|차트/i.test(combined)) scores.data += 2;

    // ── 개발: 코드 편집, 터미널, Git, AI 코딩 ────────────────────────────
    if (t === 'file.write' || t === 'file.create') scores.development += 3;
    if (t === 'git.commit' || t === 'git.push') scores.development += 4;
    if (t === 'terminal.command') scores.development += 2;
    if (t === 'tool.end' && /^(Write|Edit|Bash)$/.test(d.toolName)) scores.development += 3;
    if (t === 'tool.end' && /^(Read|Grep|Glob)$/.test(d.toolName)) scores.development += 1;
    if (/vscode|cursor|zed|sublime|vim|emacs|idea|xcode|webstorm|neovim/i.test(app)) scores.development += 3;
    if (/terminal|iterm|warp|hyper|powershell|cmd\.exe/i.test(app)) scores.development += 2;
    if (/\.(js|ts|jsx|tsx|py|java|go|rs|rb|php|c|cpp|h|swift|kt|vue|svelte|html|css|scss)$/i.test(file)) scores.development += 2;
    if (/github\.com|gitlab\.com|bitbucket/i.test(url)) scores.development += 2;

    // ── 디자인: 디자인 도구, UI 프로토타이핑 ──────────────────────────────
    if (/figma|sketch|xd|illustrator|photoshop|affinity|framer|zeplin|invision/i.test(combined)) scores.design += 4;
    if (/figma\.com|sketch\.cloud/i.test(url)) scores.design += 3;
    if (/\.(fig|sketch|xd|psd|ai|svg|eps)$/i.test(file)) scores.design += 3;
    if (/ui|ux|wireframe|prototype|목업|mockup|디자인/i.test(combined)) scores.design += 2;

    // ── 문서 작성: 워드, 노트, 마크다운 ──────────────────────────────────
    if (/word|한글|hwp|pages|google.docs/i.test(app)) scores.writing += 4;
    if (/notion|obsidian|bear|typora|roam|logseq|coda/i.test(combined)) scores.writing += 3;
    if (/\.(doc|docx|md|txt|hwp|rtf|pdf|odt)$/i.test(file)) scores.writing += 2;
    if (t === 'user.message' || t === 'assistant.message' || t === 'assistant.response') scores.writing += 1;

    // ── 커뮤니케이션: 채팅, 화상회의, 이메일 ─────────────────────────────
    if (/slack|discord|teams|zoom|meet|webex|kakao|line|telegram|whatsapp/i.test(combined)) scores.communication += 4;
    if (/mail|gmail|outlook|thunderbird|spark/i.test(combined)) scores.communication += 3;
    if (/jira|linear|asana|trello|basecamp|monday/i.test(combined)) scores.communication += 2;
  }

  // 최고 점수 타입 반환 (0점이면 general)
  let bestType = 'general', bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) { bestScore = score; bestType = type; }
  }
  return bestType;
}
// 하위호환: 기존 classifyMacroCategory 호출하는 코드 대비
function classifyMacroCategory(events) { return detectProjectType(events); }

let _activeFilter = 'all';
const FILTER_CATS = {
  all:  null,
  code: ['code'],
  file: ['file'],
  chat: ['chat'],
  git:  ['git'],
};

function setFilter(f, btn) {
  if (typeof track === 'function') track('view.filter_change', { filter_type: 'node', value: f });
  _activeFilter = f;
  document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  buildPlanetSystem(_allNodes);
}
window.setFilter = setFilter;

function toggleOrbitAnim() {
  orbitAnimOn = !orbitAnimOn;
  const oldBtn = document.getElementById('orbit-toggle-btn');
  if (oldBtn) oldBtn.textContent = orbitAnimOn ? '⏸ 애니 중지' : '▶ 애니 시작';
  const upBtn = document.getElementById('up-orbit-btn');
  if (upBtn) upBtn.textContent = orbitAnimOn ? '⏸ 애니 중지' : '▶ 애니 시작';
}
window.toggleOrbitAnim = toggleOrbitAnim;

// ─── 휠 줌 기반 뷰 자동 전환 ─────────────────────────────────────────────────
// 비활성화: 자동 전환이 마우스 조작 중 예기치 않은 점프를 유발함
// 뷰 전환은 UI 버튼(팀뷰/전사뷰)으로만 수동 전환
function _autoSwitchViewByZoom() {
  // 의도적으로 비활성화 — 사용자가 직접 뷰 버튼으로 전환
}

