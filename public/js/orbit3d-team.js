// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Team/Company simulation, market effects, demo data
// ══════════════════════════════════════════════════════════════════════════════
// TODO: Remove "me" from personal view team members — the follower spheres
//       shown in personal view are handled in a separate file (likely orbit3d.js
//       or mywork-renderer.js via loadFollowingData). Needs separate fix there.
// ─── 팀 시뮬레이션 모드 ───────────────────────────────────────────────────────
// 핵심 레이아웃 원칙:
//   🌟 중심 (0,0,0)   = 팀 목표 (가장 크게)
//   🪐 오각형 링 R=40 = 팀원 행성 (72° 균등 배치)
//   🔵 내위성 R=16    = 개인 작업 (행성 주위 공전)
//   🔹 툴 라벨 R=8    = 사용 툴 (행성 가까이 고정)

let _teamMode  = false;
const _VIEW_MODE_KEY = 'orbitViewMode'; // 뷰 모드 저장 키
let _teamNodes = [];  // { type, pos, label, sublabel, color, size, emoji, progress, memberId, taskStatus, obj }
let _focusedMember = null;  // 현재 포커스된 팀원 노드
let _cameraLerp    = null;  // { startR, endR, startTx/y/z, endTx/y/z, startPhi, endPhi, duration, elapsed }
let _companyMode   = false;  // 회사 시뮬레이션 모드
let _activeSimData = null;   // 현재 활성 시뮬 데이터 (TEAM_DEMO or COMPANY_DEMO)
let _collabLines   = [];     // [{ line, mat, phase, fromNode, toNode }] — 협업 연결선
let _myMemberId    = localStorage.getItem('orbitMyMemberId') || null;  // 내 멤버 ID
let _parallelMode  = false;   // Claude 병렬 태스크 3D 뷰 모드
let _parallelDemoTimers = []; // 타이머 누수 방지용

// ─── 팀 거리 설정값 ──────────────────────────────────────────────────────────
// 간격 슬라이더 연동 (window._spacingScale)
function _teamScale() { return window._teamSpacingScale || window._spacingScale || 0.6; } // 기본 150%
const TEAM_CFG = { get MEMBER_R() { return 10 * _teamScale(); }, get TASK_R() { return 4 * _teamScale(); }, get TOOL_R() { return 2.5 * _teamScale(); } };

// ─── 글로벌 접근 (디버깅 & 외부 스크립트) ────────────────────────────────────
// 팀/회사 데이터와 노드 정보를 전역으로 노출 (직접 할당)
function exposeTeamDataToWindow() {
  window._teamNodes = _teamNodes;
  window._activeSimData = _activeSimData;
  window._teamMode = _teamMode;
}


// ─── 마켓 이펙트 프리셋 ──────────────────────────────────────────────────────
const MARKET_EFFECTS = [
  { id: 'neon',   name: '네온 글로우',   icon: '💡', color: '#58a6ff', desc: '밝게 빛나는 네온 다중 테두리' },
  { id: 'matrix', name: '매트릭스',      icon: '🟩', color: '#3fb950', desc: '초록 코드 문자가 떨어지는 효과' },
  { id: 'dna',    name: 'DNA 헬릭스',    icon: '🧬', color: '#bc8cff', desc: '이중 나선이 회전하며 감싸는 효과' },
  { id: 'beam',   name: '에너지 빔',     icon: '⚡', color: '#ffd700', desc: '중심을 향한 빛의 줄기 효과' },
  { id: 'holo',   name: '홀로그램',      icon: '🔷', color: '#39d2c0', desc: '스캔 라인이 훑어 내리는 효과' },
  { id: 'burst',  name: '파티클 버스트', icon: '✨', color: '#f0883e', desc: '방사형 입자 폭발 효과' },
];
const _nodeEffects = {};  // nodeLabel → effectId (노드별 선택 이펙트)

// 마켓 이펙트 드로잉 함수
function drawEffect_neon(ctx, cx, cy, r, color, now) {
  for (let i = 3; i >= 0; i--) {
    const pulse = (Math.sin(now * 2.8 + i * 0.7) + 1) * 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 3 - i * 0.5;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 12 + i * 8 + pulse * 10;
    ctx.globalAlpha = 0.55 + pulse * 0.35;
    ctx.beginPath(); ctx.arc(cx, cy, r + 6 + i * 7, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}
function drawEffect_matrix(ctx, cx, cy, r, color, now) {
  const chars = '01ABアイウエオ#$%';
  ctx.save();
  ctx.font = '600 10px monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const fall  = ((now * 40 + i * 30) % (r * 2.5));
    const bx    = cx + Math.cos(angle) * (r + 8);
    const by    = cy + Math.sin(angle) * (r + 8) + fall * 0.5 - r * 0.3;
    ctx.globalAlpha = Math.max(0, 1 - fall / (r * 2.5));
    ctx.fillStyle   = color;
    ctx.shadowColor = color; ctx.shadowBlur = 4;
    ctx.fillText(chars[Math.floor(now * 8 + i) % chars.length], bx, by);
  }
  ctx.restore();
}
function drawEffect_dna(ctx, cx, cy, r, color, now) {
  ctx.save();
  for (let strand = 0; strand < 2; strand++) {
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t  = (i / 24) * Math.PI * 2;
      const rr = r + 8;
      const ox = cx + Math.cos(t + now * 1.2 + strand * Math.PI) * rr;
      const oy = cy + Math.sin(t * 2) * (rr * 0.4) + Math.sin(t + now * 1.2) * (rr * 0.35);
      i === 0 ? ctx.moveTo(ox, oy) : ctx.lineTo(ox, oy);
    }
    ctx.strokeStyle = strand === 0 ? color : color + 'aa';
    ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const t  = (i / 6) * Math.PI * 2 + now * 1.2;
    const x1 = cx + Math.cos(t) * (r + 8);
    const x2 = cx + Math.cos(t + Math.PI) * (r + 8);
    const y  = cy + Math.sin(t * 2) * (r * 0.35);
    ctx.globalAlpha = 0.5; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  }
  ctx.restore();
}
function drawEffect_beam(ctx, cx, cy, r, color, now) {
  ctx.save();
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + now * 0.8;
    const blen  = r + 30 + Math.sin(now * 3 + i) * 12;
    const ex    = cx + Math.cos(angle) * blen;
    const ey    = cy + Math.sin(angle) * blen;
    const g     = ctx.createLinearGradient(cx, cy, ex, ey);
    g.addColorStop(0, color + 'cc'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.7 + Math.sin(now * 2.5 + i) * 0.2;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
  }
  ctx.restore();
}
function drawEffect_holo(ctx, cx, cy, r, color, now) {
  ctx.save();
  ctx.strokeStyle = color + '50'; ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.35 - i * 0.08;
    ctx.beginPath(); ctx.arc(cx, cy, r + 10 + i * 10, 0, Math.PI * 2); ctx.stroke();
  }
  const scanY = cy - r - 10 + ((now * 45) % ((r + 20) * 2));
  const g = ctx.createLinearGradient(cx, scanY - 12, cx, scanY + 4);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.6, color + '40');
  g.addColorStop(1, color + 'aa');
  ctx.fillStyle = g; ctx.globalAlpha = 0.7;
  ctx.fillRect(cx - r - 10, scanY - 12, (r + 10) * 2, 16);
  ctx.restore();
}
function drawEffect_burst(ctx, cx, cy, r, color, now) {
  ctx.save();
  for (let i = 0; i < 12; i++) {
    const baseAngle = (i / 12) * Math.PI * 2;
    const phase     = (now * 1.8 + i * 0.5) % 1;
    const dist      = r + 10 + phase * 36;
    const alpha     = (1 - phase) * 0.85;
    const sz        = 3 - phase * 2;
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(baseAngle) * dist, cy + Math.sin(baseAngle) * dist, sz, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
const EFFECT_FNS = { neon: drawEffect_neon, matrix: drawEffect_matrix, dna: drawEffect_dna, beam: drawEffect_beam, holo: drawEffect_holo, burst: drawEffect_burst };

let _nodeDensity  = 2;  // 1=멤버만 2=+태스크/프로젝트 3=+스킬/에이전트 4=모두
let _distDebounce = null;

function updateDist(key, input) {
  TEAM_CFG[key] = parseInt(input.value);
  const valMap = { MEMBER_R: 'v-member-r', TASK_R: 'v-task-r', TOOL_R: 'v-tool-r' };
  document.getElementById(valMap[key]).textContent = input.value;
  // 실시간 적용 (250ms 디바운스)
  clearTimeout(_distDebounce);
  _distDebounce = setTimeout(applyTeamCfg, 250);
}

function updateNodeLevel(input) {
  _nodeDensity = parseInt(input.value);
  const labels = ['멤버만', '멤버 + 태스크', '+ 스킬 / 에이전트', '모두 표시'];
  const hints  = [
    '팀원 + 목표만 표시',
    '태스크(작업) 추가 표시',
    '스킬 · 에이전트까지 표시',
    '툴 포함 모든 노드 표시',
  ];
  document.getElementById('v-node-level').textContent   = labels[_nodeDensity - 1];
  document.getElementById('node-level-hint').textContent = hints[_nodeDensity - 1];
}

function applyTeamCfg() {
  if (_companyMode && _activeSimData) buildCompanySystem(_activeSimData);
  else if (_teamMode && _activeSimData) buildTeamSystem(_activeSimData);
}
function toggleDistPanel() {
  // 통합 패널의 📐 노드 탭으로 이동
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    if (typeof switchUpTab === 'function') switchUpTab('node', document.querySelector('.up-tab[data-tab="node"]'));
  }
}
function closeDistPanel() {
  const panel = document.getElementById('unified-panel');
  if (panel) panel.classList.remove('open');
}

// ── 마켓 이펙트 패널 ─────────────────────────────────────────────────────────
let _selectedEffectId = null;

// 미니 프리뷰 캔버스 애니메이션 루프
let _previewRAF = null;
const _previewCtxMap = {};  // effectId → CanvasRenderingContext2D

function tickPreviewCanvases() {
  const now = performance.now() * 0.001;
  for (const [id, ctx] of Object.entries(_previewCtxMap)) {
    const fn = EFFECT_FNS[id];
    if (!fn) continue;
    const ef = MARKET_EFFECTS.find(e => e.id === id);
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, 64, 64);
    fn(ctx, 32, 32, 16, ef?.color || '#58a6ff', now);
  }
  _previewRAF = requestAnimationFrame(tickPreviewCanvases);
}

function initEffectsPanel() {
  const grid = document.getElementById('effects-grid');
  if (!grid) return;

  // 기존 프리뷰 루프 정리
  if (_previewRAF) { cancelAnimationFrame(_previewRAF); _previewRAF = null; }
  for (const k of Object.keys(_previewCtxMap)) delete _previewCtxMap[k];

  grid.innerHTML = MARKET_EFFECTS.map(e => `
    <div class="effect-card" id="ec-${e.id}" style="--ec:${e.color}" onclick="selectEffect('${e.id}')">
      <canvas id="ecv-${e.id}" width="64" height="64"></canvas>
      <div class="ec-name">${e.icon} ${e.name}</div>
      <div class="ec-desc">${e.desc}</div>
    </div>`).join('');

  // 각 카드에 캔버스 컨텍스트 등록
  MARKET_EFFECTS.forEach(e => {
    const cvs = document.getElementById('ecv-' + e.id);
    if (cvs) _previewCtxMap[e.id] = cvs.getContext('2d');
  });

  // 프리뷰 루프 시작
  tickPreviewCanvases();
}

function selectEffect(id) {
  _selectedEffectId = id;
  document.querySelectorAll('.effect-card').forEach(el => el.classList.remove('selected'));
  document.getElementById('ec-' + id)?.classList.add('selected');
}

function applySelectedEffect() {
  if (!_selectedEffectId) return;
  const node = _selectedHit?.data || _currentPanelData;
  if (!node) { alert('먼저 노드를 클릭하세요'); return; }
  _nodeEffects[node.label] = _selectedEffectId;
  if (typeof track === 'function') track('node.effect_apply', { effect: _selectedEffectId });
  showApplyEffect(`이펙트 적용: ✨ ${_selectedEffectId} → ${node.label || node.intent || '노드'}`);
}

function clearNodeEffect() {
  const node = _selectedHit?.data || _currentPanelData;
  if (!node) return;
  delete _nodeEffects[node.label];
}

function toggleEffectsPanel() {
  // 통합 패널의 ✨ 이펙트 탭으로 이동
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    if (typeof switchUpTab === 'function') switchUpTab('fx', document.querySelector('.up-tab[data-tab="fx"]'));
  }
  if (typeof track === 'function') track('view.panel_open', { panel: 'effects' });
  initEffectsPanel();
  updateEffectsPanelNode();
}

function closeEffectsPanel() {
  // 통합 패널 닫기
  const panel = document.getElementById('unified-panel');
  if (panel) panel.classList.remove('open');
}

function updateEffectsPanelNode() {
  const el = document.getElementById('effects-selected-node');
  if (!el) return;
  const node = _selectedHit?.data || _currentPanelData;
  el.textContent = node ? `선택: ${node.label}` : '(노드 미선택)';
}

window.updateDist = updateDist;
window.applyTeamCfg = applyTeamCfg;
window.toggleDistPanel = toggleDistPanel;
window.closeDistPanel = closeDistPanel;
window.toggleEffectsPanel = toggleEffectsPanel;
window.closeEffectsPanel = closeEffectsPanel;
window.selectEffect = selectEffect;
window.applySelectedEffect = applySelectedEffect;
window.clearNodeEffect = clearNodeEffect;

const STATUS_CFG = {
  done:    { emoji: '✅', color: '#3fb950' },
  active:  { emoji: '⚡', color: '#58a6ff' },
  blocked: { emoji: '🚧', color: '#f0883e' },
  pending: { emoji: '⏳', color: '#6e7681' },
};



// ══════════════════════════════════════════════════════════════════════════════
// buildMultiHubSystem — 두 리더 허브 + 공동 프로젝트 렌더
// ══════════════════════════════════════════════════════════════════════════════
function buildMultiHubSystem(data) {
  clearScene();
  _teamNodes   = [];
  _teamMode    = true;
  _companyMode = false;
  _activeSimData = data;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const HUB_X  = 50;  // ±X 위치 (리더 간 거리)
  const PROJ_R = 20;  // 리더 주위 프로젝트 궤도 반경

  // ── 공통 헬퍼 ────────────────────────────────────────────────────────────
  function addLine(from, to, hex, alpha) {
    const ln = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]),
      new THREE.LineBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: alpha ?? 0.32 })
    );
    connections.push(ln); scene.add(ln);
  }

  function addLeader(pos, hex, name, role) {
    const col = new THREE.Color(hex);
    const sp  = createWireNode(4.5, col, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
    sp.position.copy(pos); scene.add(sp);
    const hl  = createWireNode(9, col, { visible: true, wireOpacity: 0.07, glow: false, detail: 0 });
    hl.position.copy(pos); scene.add(hl);
    const obj = new THREE.Object3D(); obj.position.copy(pos);
    obj.userData = { isHubLeader: true, name, color: hex };
    scene.add(obj); planetMeshes.push(obj);
    _teamNodes.push({ type: 'leader', pos: pos.clone(), obj, label: name, sublabel: role, color: hex, size: 'xl' });
    // 궤도 링
    const ring = new THREE.Mesh(new THREE.RingGeometry(PROJ_R - 0.1, PROJ_R + 0.1, 64),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.09, side: THREE.DoubleSide }));
    ring.position.copy(pos); ring.rotation.x = Math.PI / 2;
    orbitRings.push(ring); scene.add(ring);
  }

  function addHubProject(proj, hubPos, hex, ang) {
    const pPos = new THREE.Vector3(
      hubPos.x + PROJ_R * Math.cos(ang),
      hubPos.y + (Math.floor(ang * 10) % 2 === 0 ? 3 : -3),
      hubPos.z + PROJ_R * Math.sin(ang)
    );
    const col = new THREE.Color(hex);
    const sp  = createWireNode(1.8, col, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
    sp.position.copy(pPos); scene.add(sp);
    const obj = new THREE.Object3D(); obj.position.copy(pPos);
    obj.userData = { isHubProject: true, name: proj.name, color: hex,
      orbitR: PROJ_R, orbitAngle: ang, orbitSpeed: 0.012, orbitCenter: hubPos.clone() };
    scene.add(obj); satelliteMeshes.push(obj);
    _teamNodes.push({ type: 'hubProject', pos: pPos.clone(), obj, label: proj.name,
      sublabel: `${proj.sessionCount}세션`, color: hex, size: 'md' });
    addLine(hubPos, pPos, hex, 0.27);
    // 팔로워 파티클
    for (let f = 0; f < (proj.followerCount || 1); f++) {
      const fa = ang + 1.5 + f * 1.8;
      const fp = new THREE.Vector3(pPos.x + 4.5 * Math.cos(fa), pPos.y, pPos.z + 4.5 * Math.sin(fa));
      const fs = createWireNode(0.33, 0xffffff, { visible: true, wireOpacity: 0.44, glowOpacity: 0.08, detail: 0 });
      fs.position.copy(fp); scene.add(fs);
      const fo = new THREE.Object3D(); fo.position.copy(fp);
      fo.userData = { isFollower: true, orbitR: 4.5, orbitAngle: fa,
        orbitSpeed: 0.04 + f * 0.01, orbitCenter: pPos.clone() };
      scene.add(fo); satelliteMeshes.push(fo);
    }
  }

  // ── Leader A (좌) ─────────────────────────────────────────────────────────
  const laPos = new THREE.Vector3(-HUB_X, 0, 0);
  addLeader(laPos, data.leaderA.color, data.leaderA.name, data.leaderA.role);
  data.leaderA.projects.forEach((p, i) => {
    addHubProject(p, laPos, data.leaderA.color, (i / data.leaderA.projects.length) * Math.PI * 2 - Math.PI / 2);
  });

  // ── Leader B (우) ─────────────────────────────────────────────────────────
  const lbPos = new THREE.Vector3(HUB_X, 0, 0);
  addLeader(lbPos, data.leaderB.color, data.leaderB.name, data.leaderB.role);
  data.leaderB.projects.forEach((p, i) => {
    addHubProject(p, lbPos, data.leaderB.color, (i / data.leaderB.projects.length) * Math.PI * 2 - Math.PI / 2);
  });

  // ── 공동 프로젝트 (상단 중앙) ──────────────────────────────────────────────
  data.sharedProjects.forEach((sp, si) => {
    const spPos = new THREE.Vector3(0, 28 + si * 16, 0);
    const spCol = new THREE.Color(sp.color);
    const spSp  = createWireNode(3, spCol, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
    spSp.position.copy(spPos); scene.add(spSp);
    const spHl = createWireNode(6, spCol, { visible: true, wireOpacity: 0.08, glow: false, detail: 0 });
    spHl.position.copy(spPos); scene.add(spHl);
    const spObj = new THREE.Object3D(); spObj.position.copy(spPos);
    spObj.userData = { isSharedProject: true, name: sp.name, color: sp.color };
    scene.add(spObj); planetMeshes.push(spObj);
    _teamNodes.push({ type: 'sharedProject', pos: spPos.clone(), obj: spObj,
      label: sp.name, sublabel: `${sp.sessionCount}개 세션`, color: sp.color, size: 'lg' });
    addLine(laPos, spPos, sp.color, 0.30);
    addLine(lbPos, spPos, sp.color, 0.30);
  });

  // HUD
  const total = data.leaderA.projects.length + data.leaderB.projects.length + data.sharedProjects.length;
  document.getElementById('h-sessions').textContent = total;
  document.getElementById('h-tasks').textContent    = data.sharedProjects.length;
  document.getElementById('h-hours').textContent    = '멀티허브';
  document.getElementById('team-mode-badge').style.display = 'flex';
  autoFitView(_teamNodes);
  updateMyTaskSidebar();
}
window.buildMultiHubSystem = buildMultiHubSystem;

// ══════════════════════════════════════════════════════════════════════════════
// buildEnterpriseSystem — 전사 생태계 렌더 (하이브리드 외주 파트너 포함)
// ══════════════════════════════════════════════════════════════════════════════
function buildEnterpriseSystem(data, opts = {}) {
  clearScene();
  _teamNodes   = [];
  _teamMode    = true;
  _companyMode = true;
  _activeSimData = data;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const withExternal = opts.hybrid ?? true;
  const LEADER_X = 42;
  const PROJ_R   = 17;
  const INFRA_Y  = -52;

  function addLine(from, to, hex, alpha) {
    const ln = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([from.clone(), to.clone()]),
      new THREE.LineBasicMaterial({ color: new THREE.Color(hex), transparent: true, opacity: alpha ?? 0.28 })
    );
    connections.push(ln); scene.add(ln);
  }

  // ── TFT 코어 ───────────────────────────────────────────────────────────────
  const tftPos = new THREE.Vector3(0, 0, 0);
  const tftCol = new THREE.Color(data.tft.color);
  const tftSp  = createWireNode(3.5, tftCol, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
  tftSp.userData.isCore = true; scene.add(tftSp);
  const tftHl = createWireNode(7, tftCol, { visible: true, wireOpacity: 0.06, glow: false, detail: 0 });
  tftHl.position.copy(tftPos); scene.add(tftHl);
  _teamNodes.push({ type: 'goal', pos: tftPos.clone(),
    label: data.tft.name, sublabel: data.tft.sublabel, color: data.tft.color, size: 'xl' });

  // ── 리더 빌더 ─────────────────────────────────────────────────────────────
  function buildLeader(ld, pos) {
    const col = new THREE.Color(ld.color);
    const sp  = createWireNode(3.8, col, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
    sp.position.copy(pos); scene.add(sp);
    const hl  = createWireNode(7.5, col, { visible: true, wireOpacity: 0.06, glow: false, detail: 0 });
    hl.position.copy(pos); scene.add(hl);
    const obj = new THREE.Object3D(); obj.position.copy(pos);
    obj.userData = { isHubLeader: true, name: ld.name, color: ld.color };
    scene.add(obj); planetMeshes.push(obj);
    _teamNodes.push({ type: 'leader', pos: pos.clone(), obj,
      label: ld.name, sublabel: ld.role, color: ld.color, size: 'xl' });
    addLine(tftPos, pos, data.tft.color, 0.28);

    // 궤도 링
    const ring = new THREE.Mesh(new THREE.RingGeometry(PROJ_R - 0.08, PROJ_R + 0.08, 64),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.08, side: THREE.DoubleSide }));
    ring.position.copy(pos); ring.rotation.x = Math.PI / 2;
    orbitRings.push(ring); scene.add(ring);

    // 프로젝트 위성
    ld.projects.forEach((proj, pi) => {
      const ang  = (pi / ld.projects.length) * Math.PI * 2 - Math.PI / 2;
      const pPos = new THREE.Vector3(
        pos.x + PROJ_R * Math.cos(ang), pos.y + (pi % 2 === 0 ? 2 : -2), pos.z + PROJ_R * Math.sin(ang));
      const pSp = createWireNode(1.5, col, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
      pSp.position.copy(pPos); scene.add(pSp);
      const pObj = new THREE.Object3D(); pObj.position.copy(pPos);
      pObj.userData = { isHubProject: true, name: proj.name, color: ld.color,
        orbitR: PROJ_R, orbitAngle: ang, orbitSpeed: 0.013 + pi * 0.002, orbitCenter: pos.clone() };
      scene.add(pObj); satelliteMeshes.push(pObj);
      _teamNodes.push({ type: 'hubProject', pos: pPos.clone(), obj: pObj,
        label: proj.name, sublabel: `${proj.sessions}세션`, color: ld.color, size: 'md' });
      addLine(pos, pPos, ld.color, 0.24);
    });

    // 부서 노드
    if (ld.dept) {
      const sign = pos.x < 0 ? -1 : 1;
      const dPos = new THREE.Vector3(pos.x + sign * 4, pos.y - 22, pos.z);
      const dObj = new THREE.Object3D(); dObj.position.copy(dPos); scene.add(dObj);
      _teamNodes.push({ type: 'dept', pos: dPos.clone(), obj: dObj,
        label: ld.dept.name, color: ld.dept.color, size: 'sm' });
      addLine(pos, dPos, ld.dept.color, 0.22);
    }
  }

  const laPos = new THREE.Vector3(-LEADER_X, 0, 0);
  buildLeader(data.leaderA, laPos);
  const lbPos = new THREE.Vector3(LEADER_X, 0, 0);
  buildLeader(data.leaderB, lbPos);

  // ── HQ ────────────────────────────────────────────────────────────────────
  if (data.hq) {
    const hqPos = new THREE.Vector3(-14, -32, 0);
    const hqObj = new THREE.Object3D(); hqObj.position.copy(hqPos); scene.add(hqObj);
    _teamNodes.push({ type: 'hq', pos: hqPos.clone(), obj: hqObj,
      label: data.hq.name, color: data.hq.color, size: 'md' });
    addLine(tftPos, hqPos, data.hq.color, 0.22);
  }

  // ── 인프라 (하단 대형 구체) ────────────────────────────────────────────────
  if (data.infra) {
    const iPos = new THREE.Vector3(0, INFRA_Y, 0);
    const iCol = new THREE.Color(data.infra.color);
    const iSp  = createWireNode(5, iCol, { visible: true, wireOpacity: 0.35, glowOpacity: 0.15 });
    iSp.position.copy(iPos); scene.add(iSp);
    const iHl  = createWireNode(10, iCol, { visible: true, wireOpacity: 0.05, glow: false, detail: 0 });
    iHl.position.copy(iPos); scene.add(iHl);
    const iObj = new THREE.Object3D(); iObj.position.copy(iPos); scene.add(iObj); planetMeshes.push(iObj);
    _teamNodes.push({ type: 'infra', pos: iPos.clone(), obj: iObj,
      label: data.infra.name, color: data.infra.color, size: 'xl' });
    addLine(tftPos, iPos, data.infra.color, 0.15);
    addLine(laPos,  iPos, data.infra.color, 0.10);
    addLine(lbPos,  iPos, data.infra.color, 0.10);
  }

  // ── 외주 파트너 — angular box node ────────────────────────────────────────
  if (withExternal) {
    (data.externalPartners || []).forEach(ep => {
      const epPos = new THREE.Vector3(...ep.pos);
      const epCol = new THREE.Color(ep.color);
      // 45° 회전 다이아몬드 박스
      const bm = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 1.2),
        new THREE.MeshPhongMaterial({ color: epCol, emissive: epCol.clone().multiplyScalar(0.22),
          transparent: true, opacity: 0.88 }));
      bm.position.copy(epPos); bm.rotation.z = Math.PI / 4; scene.add(bm);
      // 와이어프레임 오버레이
      const wm = new THREE.Mesh(new THREE.BoxGeometry(5.3, 5.3, 1.4),
        new THREE.MeshBasicMaterial({ color: epCol, wireframe: true, transparent: true, opacity: 0.35 }));
      wm.position.copy(epPos); wm.rotation.z = Math.PI / 4; scene.add(wm);
      const epObj = new THREE.Object3D(); epObj.position.copy(epPos);
      epObj.userData = { isExternal: true, name: ep.name, color: ep.color };
      scene.add(epObj); planetMeshes.push(epObj);
      _teamNodes.push({ type: 'external', pos: epPos.clone(), obj: epObj,
        label: ep.name, color: ep.color, size: 'md' });
      const nearest = Math.abs(epPos.x) < 20 ? tftPos : (epPos.x < 0 ? laPos : lbPos);
      addLine(nearest, epPos, ep.color, 0.20);
    });
  }

  // HUD
  const total = data.leaderA.projects.length + data.leaderB.projects.length;
  document.getElementById('h-sessions').textContent = total;
  document.getElementById('h-tasks').textContent    = (withExternal ? (data.externalPartners?.length ?? 0) : 0);
  document.getElementById('h-hours').textContent    = withExternal ? '하이브리드' : '전사';
  document.getElementById('team-mode-badge').style.display = 'flex';
  autoFitView(_teamNodes);
  updateMyTaskSidebar();
}
window.buildEnterpriseSystem = buildEnterpriseSystem;

// ── buildTeamSystem ──────────────────────────────────────────────────────────
function buildTeamSystem(teamData) {
  try { return _buildTeamSystemInner(teamData); }
  catch(e) { console.error('[buildTeamSystem] CRASH:', e.message, e.stack?.split('\n')[1]); }
}
function _buildTeamSystemInner(teamData) {
  console.log('[orbit3d-team] buildTeamSystem called with team:', teamData?.name);
  clearScene();
  _teamNodes = [];
  _teamMode  = true;
  _companyMode = false;
  _activeSimData = teamData;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const { name, goal, goalColor, members } = teamData;

  const BASE_R = TEAM_CFG.MEMBER_R;
  const TASK_R = TEAM_CFG.TASK_R;
  const TOOL_R = TEAM_CFG.TOOL_R;
  const MEMBER_ORBIT = Math.max(BASE_R * 0.8, 5); // 멤버 궤도 (팀 구체 밀착)

  // ── 가운데 (위치만, 구체 없음) ──────────────────────────────────
  const core = new THREE.Object3D();
  core.userData.isCore = true;
  scene.add(core);

  // 팀 구체 라벨
  const teamName = members[0]?.teamName || members[0]?.role || name || '팀';
  _teamNodes.push({ type: 'goal', pos: new THREE.Vector3(0, 2, 0),
    label: teamName, sublabel: `${members.length}명`, color: goalColor || '#ffd700', size: 'md' });

  // 멤버 궤도 링
  {
    const ring = new THREE.RingGeometry(MEMBER_ORBIT - 0.06, MEMBER_ORBIT + 0.06, 96);
    const ringM = new THREE.MeshBasicMaterial({ color: 0x3fb950, transparent: true, opacity: 0.10, side: THREE.DoubleSide });
    const rm = new THREE.Mesh(ring, ringM);
    rm.rotation.x = Math.PI / 2;
    orbitRings.push(rm); scene.add(rm);
  }

  // 팀 = 1개 (소속 팀만 표시), 멤버들이 가운데 팀 구체 주위에 배치
  const teamCenter = new THREE.Vector3(0, 0, 0);
  const teamColor = '#3fb950';
  const CLUSTER_R = MEMBER_ORBIT;
  const teamMembers = members;

    // ── 팀 공동 프로젝트 표시 (겹치는 앱 → 가운데 팀 구체 주위 위성) ──
    const _teamCenter = new THREE.Vector3(0, 0, 0);
    const _teamColor = teamColor;
    const _token2 = (typeof _orbitUser !== 'undefined' && _orbitUser?.token) || localStorage.getItem('orbit_token') || '';
    // 팀원 전체 데이터를 모아서 겹치는 앱 찾기
    Promise.all(teamMembers.filter(m => m.userId).map(m =>
      fetch(`/api/graph?memberId=${encodeURIComponent(m.userId)}`, {
        headers: _token2 ? { Authorization: `Bearer ${_token2}` } : {},
      }).then(r => r.json()).then(d => ({ name: m.name, nodes: d.nodes || [] })).catch(() => ({ name: m.name, nodes: [] }))
    )).then(results => {
      // 멤버별 앱 사용
      const memberApps = {};
      results.forEach(r => {
        const apps = {};
        r.nodes.forEach(n => {
          if (n.type === 'idle') return;
          let fc = {};
          try { if (n.fullContent && n.fullContent.startsWith('{')) fc = JSON.parse(n.fullContent); } catch {}
          const app = fc.app || n.projectName || (fc.windowTitle ? fc.windowTitle.split(' - ').pop().trim() : '') || '';
          if (app) apps[app] = (apps[app] || 0) + 1;
        });
        memberApps[r.name] = apps;
      });
      // 겹치는 앱 (2명 이상 사용)
      const allApps = {};
      Object.entries(memberApps).forEach(([name, apps]) => {
        Object.keys(apps).forEach(app => {
          if (!allApps[app]) allApps[app] = [];
          allApps[app].push(name);
        });
      });
      const shared = Object.entries(allApps).filter(([_, users]) => users.length >= 2)
        .sort((a, b) => b[1].length - a[1].length).slice(0, 3);

      // 팀 구체 주위에 공동 프로젝트 위성 배치
      const SHARED_R = 2;
      shared.forEach(([app, users], si) => {
        const sAngle = (si / Math.max(shared.length, 3)) * Math.PI * 2;
        const sPos = new THREE.Vector3(
          _teamCenter.x + SHARED_R * Math.cos(sAngle),
          _teamCenter.y + 1.5,
          _teamCenter.z + SHARED_R * Math.sin(sAngle)
        );
        const sObj = new THREE.Object3D();
        sObj.position.copy(sPos);
        sObj.userData = { isTeamTask: true, orbitR: SHARED_R, orbitAngle: sAngle, orbitSpeed: 0.015 + si * 0.005, orbitCenter: _teamCenter.clone() };
        scene.add(sObj); satelliteMeshes.push(sObj);
        _teamNodes.push({
          type: 'task', pos: sPos.clone(), obj: sObj,
          label: `🤝 ${app}`, sublabel: users.join('+'),
          color: _teamColor, size: 'sm', taskStatus: 'active',
        });
      });
    }).catch(() => {});

    // 현재 로그인 사용자 ID (me 표시용)
    const _myUserId = (typeof _orbitUser !== 'undefined' && _orbitUser?.id) || '';

    // 팀 멤버: 팀 중심 주위에 클러스터링
    teamMembers.forEach((member, mi) => {
      const memberAngle = (mi / teamMembers.length) * Math.PI * 2;
      const mx = teamCenter.x + CLUSTER_R * Math.cos(memberAngle);
      const my = 0;
      const mz = teamCenter.z + CLUSTER_R * Math.sin(memberAngle);
      const mPos = new THREE.Vector3(mx, my, mz);

      const mObj = createWireNode(0.15, new THREE.Color(member.color || '#58a6ff').getHex(), { visible: true, wireOpacity: 0.5, glowOpacity: 0.2 });
      mObj.position.copy(mPos);
      mObj.userData = {
        isTeamMember: true, memberId: member.id,
        name: member.name, role: member.role, color: member.color,
        // 멤버는 가운데 팀 구체 주위를 공전
        orbitR: CLUSTER_R, orbitAngle: memberAngle, orbitSpeed: 0.02 + mi * 0.005,
        orbitCenter: new THREE.Vector3(0, 0, 0),
      };
      scene.add(mObj);
      planetMeshes.push(mObj);

      const isMe = member.userId === _myUserId;
      _teamNodes.push({
        type: 'member', pos: mPos.clone(), obj: mObj,
        label: isMe ? `${member.name} (me)` : member.name,
        sublabel: teamName, color: member.color, size: isMe ? 'xl' : 'lg',
        memberId: member.id,
      });

    // ── 작업 위성 ─────────────────────────────────────────────────────────
    member.tasks.forEach((task, taskIdx) => {
      const tAngle = (taskIdx / member.tasks.length) * Math.PI * 2 + (mi * 1.26);
      const tx = mPos.x + TASK_R * Math.cos(tAngle);
      const ty = mPos.y + TASK_R * 0.25 * Math.sin(tAngle + 1.0);
      const tz = mPos.z + TASK_R * Math.sin(tAngle);
      const tPos = new THREE.Vector3(tx, ty, tz);

      const _taskColor = STATUS_CFG[task.status]?.color || '#6e7681';
      const tObj = new THREE.Object3D();
      tObj.position.copy(tPos);
      tObj.userData = {
        isTeamTask: true, memberId: member.id,
        taskName: task.name, taskStatus: task.status, taskProgress: task.progress,
        color: _taskColor,
        orbitR: TASK_R, orbitAngle: tAngle, orbitSpeed: 0.038 + mi * 0.004 + taskIdx * 0.003,
        orbitCenter: mPos.clone(),
      };
      scene.add(tObj);
      satelliteMeshes.push(tObj);

      const sc = STATUS_CFG[task.status] || STATUS_CFG.pending;
      _teamNodes.push({
        type: 'task', pos: tPos.clone(), obj: tObj,
        label: task.name, emoji: sc.emoji, color: sc.color,
        progress: task.progress, size: 'sm',
        memberId: member.id, taskStatus: task.status,
      });

      // 팀원 → 작업 연결선 (제거 — 협업만 표시)
    });

    // ── 프로젝트 세션 위성 (비동기 로드) ────────────────────────────────────
    if (member.userId) {
      const _mPos = mPos.clone();
      const _color = member.color;
      const _mid = member.id;
      const _token = (typeof _orbitUser !== 'undefined' && _orbitUser?.token) || localStorage.getItem('orbit_token') || '';
      fetch(`/api/graph?memberId=${encodeURIComponent(member.userId)}`, {
        headers: _token ? { Authorization: `Bearer ${_token}` } : {},
      }).then(r => r.json()).then(data => {
        const nodes = data.nodes || [];
        if (nodes.length === 0) return;
        // 앱별 활동 그룹 (fullContent에서 app 파싱)
        const projects = {};
        nodes.forEach(n => {
          // 캡처/Vision만 프로젝트로 (키보드/파일/클립보드 제외)
          if (n.type !== 'screen.capture' && n.type !== 'screen.analyzed') return;
          let fc = {};
          try { if (n.fullContent && n.fullContent.startsWith('{')) fc = JSON.parse(n.fullContent); } catch {}
          const app = fc.app || n.projectName || n.autoTitle || (fc.windowTitle ? fc.windowTitle.split(' - ').pop().trim() : '') || '';
          const title = fc.windowTitle || '';
          const activity = fc.activity || n.whatSummary || '';
          if (!app) return;
          if (!projects[app]) projects[app] = { count: 0, whatSummary: '', techStack: '' };
          projects[app].count++;
          if (activity && !projects[app].whatSummary) projects[app].whatSummary = activity;
          if (title && !projects[app].techStack) projects[app].techStack = title;
        });
        // 상위 5개 앱/프로젝트를 위성으로 표시
        const topProjects = Object.entries(projects)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5);
        const PROJ_R = 1.5; // 멤버 주위 고정 거리
        console.log(`[team-project] ${_mid}: ${topProjects.length}개 프로젝트 위성 생성`);
        topProjects.forEach(([projName, proj], si) => {
          const sAngle = (si / Math.max(topProjects.length, 3)) * Math.PI * 2;
          const sPos = new THREE.Vector3(
            _mPos.x + PROJ_R * Math.cos(sAngle),
            _mPos.y + 0.5 + si * 0.3, // Y축으로 펼쳐서 겹침 방지
            _mPos.z + PROJ_R * Math.sin(sAngle)
          );
          const sObj = new THREE.Object3D();
          sObj.position.copy(sPos);
          sObj.userData = { isTeamTask: true, memberId: _mid, orbitR: PROJ_R, orbitAngle: sAngle, orbitSpeed: 0, orbitCenter: _mPos.clone() };
          scene.add(sObj);
          satelliteMeshes.push(sObj);
          _teamNodes.push({
            type: 'task', pos: sPos.clone(), obj: sObj,
            label: projName.slice(0, 18), sublabel: proj.whatSummary?.slice(0, 25) || proj.techStack?.slice(0, 25) || `${proj.count}건`,
            color: _color, size: 'sm',
            memberId: _mid, taskStatus: 'active',
          });
          // 연결선 제거 — 협업만 표시
        });
      }).catch(() => {});
    }

    // ── 툴 라벨 ───────────────────────────────────────────────────────────
    member.tools.forEach((tool, tli) => {
      const tlAngle = memberAngle + Math.PI + (tli - 1) * 0.55;
      const tx = mPos.x + TOOL_R * Math.cos(tlAngle);
      const ty = mPos.y + 3.5 + tli * 2.2;
      const tz = mPos.z + TOOL_R * Math.sin(tlAngle);
      const tlPos = new THREE.Vector3(tx, ty, tz);

      const tlObj = new THREE.Object3D();
      tlObj.position.copy(tlPos);
      tlObj.userData = {
        isTeamTool: true, memberId: member.id, toolName: tool,
        color: member.color, relAngle: tlAngle, relY: 3.5 + tli * 2.2, relR: TOOL_R,
      };
      scene.add(tlObj);
      satelliteMeshes.push(tlObj);

      _teamNodes.push({
        type: 'tool', pos: tlPos.clone(), obj: tlObj,
        label: tool, color: member.color, size: 'xs',
      });
    });

    // ── 스킬 노드 ───────────────────────────────────────────────────────────
    const SKILL_R = TOOL_R * 0.65;
    (member.skills || []).forEach((sk, ski) => {
      const skAngle = memberAngle - Math.PI * 0.6 + ski * 0.8;
      const skPos   = new THREE.Vector3(
        mPos.x + SKILL_R * Math.cos(skAngle),
        mPos.y - 4 - ski * 2.5,
        mPos.z + SKILL_R * Math.sin(skAngle),
      );
      const skObj = new THREE.Object3D();
      skObj.position.copy(skPos);
      skObj.userData = { isTeamSkill: true, memberId: member.id, alias: sk.alias, skillType: sk.type, config: sk.config, color: '#d2a8ff', relAngle: skAngle, relY: -4 - ski * 2.5, relR: SKILL_R };
      scene.add(skObj); satelliteMeshes.push(skObj);
      _teamNodes.push({ type: 'skill', pos: skPos.clone(), obj: skObj, label: sk.alias, color: '#d2a8ff', size: 'xs', memberId: member.id, config: sk.config, skillType: sk.type });
    });

    // ── 에이전트 노드 ────────────────────────────────────────────────────────
    const AGENT_R = TOOL_R * 0.8;
    (member.agents || []).forEach((ag, agi) => {
      const agAngle = memberAngle + Math.PI * 0.6 + agi * 0.9;
      const agPos   = new THREE.Vector3(
        mPos.x + AGENT_R * Math.cos(agAngle),
        mPos.y - 5 - agi * 2.8,
        mPos.z + AGENT_R * Math.sin(agAngle),
      );
      const agObj = new THREE.Object3D();
      agObj.position.copy(agPos);
      agObj.userData = { isTeamAgent: true, memberId: member.id, alias: ag.alias, agentType: ag.type, config: ag.config, color: '#39d2c0', relAngle: agAngle, relY: -5 - agi * 2.8, relR: AGENT_R };
      scene.add(agObj); satelliteMeshes.push(agObj);
      _teamNodes.push({ type: 'agent', pos: agPos.clone(), obj: agObj, label: ag.alias, color: '#39d2c0', size: 'xs', memberId: member.id, config: ag.config, agentType: ag.type, autoRun: ag.config?.autoRun });
    });
    }); // teamMembers.forEach

  // ── 협업 라인 생성 ─────────────────────────────────────────────────────────
  // collab 필드에 명시된 멤버 쌍 사이에 애니메이션 선 그리기 (중복 방지)
  _collabLines.forEach(l => { scene.remove(l.line); });
  _collabLines = [];
  const drawnPairs = new Set();

  members.forEach((member, mi) => {
    const mNode = _teamNodes.find(n => n.type === 'member' && n.memberId === member.id);
    if (!mNode) return;
    (member.collab || []).forEach(targetId => {
      const pairKey = [member.id, targetId].sort().join('-');
      if (drawnPairs.has(pairKey)) return;
      drawnPairs.add(pairKey);

      const targetNode = _teamNodes.find(n => n.type === 'member' && n.memberId === targetId);
      if (!targetNode) return;

      // 협업 라인 (청록색, 반짝임 애니메이션)
      const lg = new THREE.BufferGeometry().setFromPoints([mNode.pos.clone(), targetNode.pos.clone()]);
      const lm = new THREE.LineBasicMaterial({ color: 0x39d2c0, transparent: true, opacity: 0.55 });
      const ln = new THREE.Line(lg, lm);
      scene.add(ln);
      _collabLines.push({ line: ln, mat: lm, phase: Math.random() * Math.PI * 2, fromNode: mNode, toNode: targetNode });
    });
  });

  // HUD 업데이트
  document.getElementById('h-sessions').textContent = members.length;
  document.getElementById('h-tasks').textContent    = members.reduce((s, m) => s + m.tasks.length, 0);
  document.getElementById('h-hours').textContent    = '팀';
  document.getElementById('team-mode-badge').style.display = 'flex';

  // 모든 노드를 선택 가능하게 등록
  registerTeamNodesAsInteractive(_teamNodes, members, teamData);

  // 뷰 자동 맞춤
  autoFitView(_teamNodes);

  // 사이드바 업데이트
  updateMyTaskSidebar();

  // 글로벌 접근 활성화 (모든 노드 추가 후 호출)
  exposeTeamDataToWindow();
  console.log('[orbit3d-team] buildTeamSystem completed with', _teamNodes.length, 'nodes exposed to window');
}

// ── 팀 노드를 선택 시스템에 등록 ─────────────────────────────────────────
function registerTeamNodesAsInteractive(teamNodes, members, teamData) {
  if (!window.registerInteractive) {
    console.warn('[orbit3d-team] registerInteractive 함수를 찾을 수 없음');
    return;
  }

  // 비즈니스 도메인 분석 (회원 역할 기반)
  const businessDomain = analyzeBusinessDomain(members, teamData);

  teamNodes.forEach(node => {
    if (!node.obj) return; // Three.js 객체가 없으면 스킵

    let nodeData = {
      id: node.label + '_' + Math.random().toString(36).substr(2, 9),
      name: node.label,
      type: node.type,
      role: node.sublabel || node.type,
      icon: getNodeIcon(node.type),
      avatar: getNodeAvatar(node.type, node.color),
      color: node.color,
      progress: node.progress || 0,
      status: node.taskStatus || 'active',
      reliability: 85,
    };

    // 노드 타입별 추가 정보
    if (node.type === 'member') {
      const member = members.find(m => m.id === node.memberId);
      if (member) {
        nodeData.department = businessDomain.departments[node.memberId] || businessDomain.category;
        nodeData.team = businessDomain.category;
        nodeData.children = (member.tasks || []).slice(0, 9).map(task => ({
          id: 'task_' + task.name,
          name: task.name,
          subtitle: task.status,
          icon: getStatusEmoji(task.status),
          type: 'task'
        }));
        // 같은 팀의 협업자
        nodeData.collaborators = {
          sameTeam: members
            .filter(m => m.id !== node.memberId && businessDomain.departments[m.id] === businessDomain.departments[node.memberId])
            .map(m => ({ id: m.id, name: m.name, avatar: m.name[0], role: m.role })),
          otherTeam: members
            .filter(m => m.id !== node.memberId && businessDomain.departments[m.id] !== businessDomain.departments[node.memberId])
            .map(m => ({ id: m.id, name: m.name, avatar: m.name[0], role: m.role }))
        };
      }
    } else if (node.type === 'task') {
      const member = members.find(m => m.id === node.memberId);
      if (member) {
        nodeData.department = businessDomain.departments[node.memberId] || businessDomain.category;
        nodeData.team = member.name;
      }
    } else if (node.type === 'goal') {
      nodeData.department = businessDomain.category;
      nodeData.team = teamData.name;
      nodeData.children = members.map(m => ({
        id: m.id,
        name: m.name,
        subtitle: m.role,
        icon: '👤',
        type: 'member'
      }));
    }

    window.registerInteractive(node.obj, nodeData);
  });

  console.log('[orbit3d-team] 팀 노드 등록 완료:', teamNodes.length + '개 노드');
}

// 회원 역할 기반 비즈니스 도메인 분석
function analyzeBusinessDomain(members, teamData) {
  // 역할 키워드로 부서 분류
  const roleToCategory = {
    '영업': 'Sales',
    '판매': 'Sales',
    '수출': 'Export',
    '수입': 'Import',
    '물류': 'Logistics',
    '배송': 'Logistics',
    '생산': 'Production',
    '품질': 'Quality',
    '회계': 'Finance',
    '재무': 'Finance',
    '개발': 'Engineering',
    '설계': 'Engineering',
    '디자인': 'Design',
    '마케팅': 'Marketing',
    '기획': 'Strategy',
    '전략': 'Strategy',
    '운영': 'Operations',
  };

  const departments = {};
  let categoryCount = {};

  members.forEach(member => {
    let category = 'Operations'; // 기본값
    const role = member.role || '';

    // 역할에서 가장 가까운 카테고리 찾기
    for (const [keyword, dept] of Object.entries(roleToCategory)) {
      if (role.includes(keyword)) {
        category = dept;
        break;
      }
    }

    departments[member.id] = category;
    categoryCount[category] = (categoryCount[category] || 0) + 1;
  });

  // 가장 많은 부서를 카테고리로 선정
  const topCategory = Object.keys(categoryCount).reduce((a, b) =>
    categoryCount[a] > categoryCount[b] ? a : b, 'Operations');

  return {
    category: topCategory,
    departments,
    counts: categoryCount
  };
}

// 노드 타입별 아이콘
function getNodeIcon(type) {
  const iconMap = {
    'goal': '🎯',
    'member': '👤',
    'task': '✓',
    'tool': '🔧',
    'skill': '⚡',
    'agent': '🤖',
  };
  return iconMap[type] || '◆';
}

// 노드 타입별 아바타
function getNodeAvatar(type, color) {
  const iconMap = {
    'goal': '🎯',
    'member': '👤',
    'task': '✓',
    'tool': '🔧',
    'skill': '⚡',
    'agent': '🤖',
  };
  return iconMap[type] || '◆';
}

// 작업 상태별 이모지
function getStatusEmoji(status) {
  const statusMap = {
    'todo': '⭕',
    'wip': '🟡',
    'done': '✅',
    'pending': '⏳',
  };
  return statusMap[status] || '◆';
}

// ── buildCompanySystem ───────────────────────────────────────────────────────
function buildCompanySystem(companyData) {
  clearScene();
  _teamNodes = [];
  _teamMode  = true;
  _companyMode = true;
  _activeSimData = companyData;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const { name, goal, goalColor, departments } = companyData;
  const _s = window._companySpacingScale || _teamScale();
  const DEPT_R   = 22 * _s;
  const MBR_R    = 8 * _s;
  const CTASK_R  = 4 * _s;
  const SKILL_R  = 5;
  const AGENT_R  = 6;

  // 코어 (회사 목표 — 와이어프레임)
  const core = new THREE.Object3D();
  core.userData.isCore = true; scene.add(core);
  const coreHl = new THREE.Object3D();
  scene.add(coreHl);

  _teamNodes.push({ type: 'goal', pos: new THREE.Vector3(0, 0, 0), label: goal, sublabel: name, color: goalColor || '#ffd700', size: 'xl' });

  // 부서 궤도 링
  //   { const r = new THREE.Mesh(new THREE.RingGeometry(DEPT_R - 0.15, DEPT_R + 0.15, 128), new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.04, side: THREE.DoubleSide })); r.rotation.x = Math.PI / 2; orbitRings.push(r); scene.add(r); }

  departments.forEach((dept, di) => {
    const dAngle = (di / departments.length) * Math.PI * 2 - Math.PI / 2;
    const dy     = (di % 2 === 0 ? 1 : -1) * 4;
    const dPos   = new THREE.Vector3(DEPT_R * Math.cos(dAngle), dy, DEPT_R * Math.sin(dAngle));

    // 부서 와이어 구체 (작게)
    const dWire = new THREE.Object3D();
    dWire.position.copy(dPos);
    dWire.userData = { isDept: true, deptId: dept.id, deptName: dept.name, color: dept.color, icon: dept.icon, orbitR: DEPT_R, orbitAngle: dAngle, orbitSpeed: 0.010 + di * 0.002, orbitCenter: new THREE.Vector3(0,0,0) };
    scene.add(dWire); planetMeshes.push(dWire);
    const dObj = dWire;

    _teamNodes.push({ type: 'department', pos: dPos.clone(), obj: dObj, label: `${dept.icon} ${dept.name}`, sublabel: `${dept.members.length}명`, color: dept.color, size: 'xs', deptId: dept.id, deptData: dept });

    // 중심→부서 연결선 (제거)
  //     { const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), dPos.clone()]); const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(dept.color), transparent: true, opacity: 0.35 }); connections.push(new THREE.Line(lg, lm)); scene.add(connections[connections.length-1]); }

    // 부서 궤도 링 팀원 (제거)
  //     { const r = new THREE.Mesh(new THREE.RingGeometry(MBR_R - 0.06, MBR_R + 0.06, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(dept.color), transparent: true, opacity: 0.08, side: THREE.DoubleSide })); r.position.copy(dPos); r.rotation.x = Math.PI / 2; orbitRings.push(r); scene.add(r); }

    dept.members.forEach((member, mi) => {
      const mAng = (mi / dept.members.length) * Math.PI * 2 + (di * 1.1);
      const my   = (mi % 2 === 0 ? 1 : -1) * 1.2;
      const mPos = new THREE.Vector3(dPos.x + MBR_R * Math.cos(mAng), dPos.y + my, dPos.z + MBR_R * Math.sin(mAng));

      const mObj = new THREE.Object3D();
      mObj.position.copy(mPos);
      mObj.userData = { isTeamMember: true, isDeptMember: true, memberId: member.id, deptId: dept.id, name: member.name, role: member.role, color: member.color, orbitR: MBR_R, orbitAngle: mAng, orbitSpeed: 0.022 + mi * 0.005, orbitCenter: dPos.clone() };
      scene.add(mObj); satelliteMeshes.push(mObj);

      _teamNodes.push({ type: 'member', pos: mPos.clone(), obj: mObj, label: member.name, sublabel: member.role, color: member.color, size: 'md', memberId: member.id, deptId: dept.id });

      // 부서→팀원 연결선 (제거)
      //       { const lg = new THREE.BufferGeometry().setFromPoints([dPos.clone(), mPos.clone()]); const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.3 }); connections.push(new THREE.Line(lg, lm)); scene.add(connections[connections.length-1]); }

      // 작업 위성
      member.tasks.forEach((task, ti) => {
        const tAng = (ti / member.tasks.length) * Math.PI * 2 + (mi * 1.3 + di * 0.8);
        const tPos = new THREE.Vector3(mPos.x + CTASK_R * Math.cos(tAng), mPos.y + CTASK_R * 0.3 * Math.sin(tAng + 0.8), mPos.z + CTASK_R * Math.sin(tAng));
        const tObj = new THREE.Object3D(); tObj.position.copy(tPos);
        tObj.userData = { isTeamTask: true, memberId: member.id, deptId: dept.id, taskName: task.name, taskStatus: task.status, taskProgress: task.progress, color: STATUS_CFG[task.status]?.color || '#6e7681', orbitR: CTASK_R, orbitAngle: tAng, orbitSpeed: 0.05 + ti * 0.01, orbitCenter: mPos.clone() };
        scene.add(tObj); satelliteMeshes.push(tObj);
        const sc = STATUS_CFG[task.status] || STATUS_CFG.pending;
        _teamNodes.push({ type: 'task', pos: tPos.clone(), obj: tObj, label: task.name, emoji: sc.emoji, color: sc.color, progress: task.progress, size: 'xs', memberId: member.id, deptId: dept.id, taskStatus: task.status });
        //         { const lg = new THREE.BufferGeometry().setFromPoints([mPos.clone(), tPos.clone()]); const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.14 }); connections.push(new THREE.Line(lg, lm)); scene.add(connections[connections.length-1]); }
      });

      // 스킬 위성
      (member.skills || []).forEach((sk, ski) => {
        const skAng = mAng - 0.6 + ski * 0.7;
        const skPos = new THREE.Vector3(mPos.x + SKILL_R * Math.cos(skAng), mPos.y - 2.5 - ski * 2, mPos.z + SKILL_R * Math.sin(skAng));
        const skObj = new THREE.Object3D(); skObj.position.copy(skPos);
        skObj.userData = { isTeamSkill: true, memberId: member.id, alias: sk.alias, config: sk.config, color: '#d2a8ff', relAngle: skAng, relY: -2.5 - ski * 2, relR: SKILL_R };
        scene.add(skObj); satelliteMeshes.push(skObj);
        _teamNodes.push({ type: 'skill', pos: skPos.clone(), obj: skObj, label: sk.alias, color: '#d2a8ff', size: 'xs', memberId: member.id, config: sk.config });
      });

      // 에이전트 위성
      (member.agents || []).forEach((ag, agi) => {
        const agAng = mAng + 0.6 + agi * 0.7;
        const agPos = new THREE.Vector3(mPos.x + AGENT_R * Math.cos(agAng), mPos.y - 3 - agi * 2.2, mPos.z + AGENT_R * Math.sin(agAng));
        const agObj = new THREE.Object3D(); agObj.position.copy(agPos);
        agObj.userData = { isTeamAgent: true, memberId: member.id, alias: ag.alias, config: ag.config, color: '#39d2c0', relAngle: agAng, relY: -3 - agi * 2.2, relR: AGENT_R };
        scene.add(agObj); satelliteMeshes.push(agObj);
        _teamNodes.push({ type: 'agent', pos: agPos.clone(), obj: agObj, label: ag.alias, color: '#39d2c0', size: 'xs', memberId: member.id, config: ag.config, autoRun: ag.config?.autoRun });
      });
    });
  });

  // ── 크로스-부서 협업 라인 (불타오르는 이펙트) ───────────────────────────────
  _collabLines.forEach(l => { scene.remove(l.line); if(l.outerLine) scene.remove(l.outerLine); });
  _collabLines = [];
  const crossDrawn = new Set();
  departments.forEach(dept => {
    (dept.members || []).forEach(member => {
      const mNode = _teamNodes.find(n => n.type === 'member' && n.memberId === member.id);
      if (!mNode) return;
      (member.collab || []).forEach(targetId => {
        const pairKey = [member.id, targetId].sort().join('-');
        if (crossDrawn.has(pairKey)) return;
        crossDrawn.add(pairKey);
        const targetNode = _teamNodes.find(n => n.type === 'member' && n.memberId === targetId);
        if (!targetNode) return;
        const isCrossDept = mNode.deptId !== targetNode.deptId;

        // 외곽 글로우 (굵음, 낮은 투명도, 덧셈 블렌딩)
        const outerGeo = new THREE.BufferGeometry().setFromPoints([mNode.pos.clone(), targetNode.pos.clone()]);
        const outerMat = new THREE.LineBasicMaterial({
          color: isCrossDept ? 0xff6e00 : 0x39d2c0,
          transparent: true, opacity: isCrossDept ? 0.35 : 0.25,
          blending: isCrossDept ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const outerLine = new THREE.Line(outerGeo, outerMat);
        scene.add(outerLine);

        // 내부 코어 라인
        const lg = new THREE.BufferGeometry().setFromPoints([mNode.pos.clone(), targetNode.pos.clone()]);
        const lm = new THREE.LineBasicMaterial({
          color: isCrossDept ? 0xffcc44 : 0x39d2c0,
          transparent: true, opacity: isCrossDept ? 0.75 : 0.55,
          blending: isCrossDept ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const ln = new THREE.Line(lg, lm);
        scene.add(ln);
        _collabLines.push({
          line: ln, mat: lm, outerLine, outerMat,
          phase: Math.random() * Math.PI * 2,
          fromNode: mNode, toNode: targetNode, crossDept: isCrossDept,
        });
      });
    });
  });

  const totalMembers = departments.reduce((s, d) => s + d.members.length, 0);
  const totalTasks   = departments.reduce((s, d) => s + d.members.reduce((ss, m) => ss + m.tasks.length, 0), 0);
  document.getElementById('h-sessions').textContent = departments.length;
  document.getElementById('h-tasks').textContent    = totalTasks;
  document.getElementById('h-hours').textContent    = '회사';
  document.getElementById('team-mode-badge').style.display = 'flex';
  document.querySelector('.tm-label').textContent = '🏢 회사 시뮬레이션';

  // 뷰 자동 맞춤 + 사이드바
  autoFitView(_teamNodes);
  updateMyTaskSidebar();
}

async function loadTeamDemo() {
  // 뷰 전환 락 설정 (자동 줌 전환 + WebSocket loadData 방지)
  if (typeof _viewTransitionLock !== 'undefined') _viewTransitionLock = true;
  else window._viewTransitionLock = true;
  clearTimeout(window._zoomLodTimer);
  // workspace → team 전환 시 multilevel scene 정리
  if (window.RendererManager) window.RendererManager.switchTo('team');
  else if (window.RendererManager?.cleanupMultilevel) window.RendererManager.cleanupMultilevel();
  if (typeof track === 'function') track('view.mode_switch', { from: 'personal', to: 'team' });
  // 슬라이더 전환 (팀 전용) + 카메라 r=15
  document.getElementById('spacing-personal').style.display = 'none';
  document.getElementById('spacing-team').style.display = '';
  document.getElementById('spacing-company').style.display = 'none';
  if (typeof controls !== 'undefined' && controls.sph) controls.sph.r = 15;

  const _u = typeof _orbitUser !== 'undefined' ? _orbitUser : JSON.parse(localStorage.getItem('orbitUser') || 'null');
  const token = _u?.token;

  if (!token) {
    showToast('👥 팀 뷰는 로그인 후 사용 가능합니다', 3000);
    return;
  }

  try {
    const _wsId = window._currentWorkspaceId || '';
    const _tvUrl = _wsId ? `/api/workspace/team-view?workspaceId=${encodeURIComponent(_wsId)}` : '/api/workspace/team-view';
    const res = await fetch(_tvUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.leaderA && data.leaderB) {
        buildMultiHubSystem(data);
        updateBreadcrumb('team');
        document.querySelector('.tm-label').textContent = '👥 팀';
        localStorage.setItem(_VIEW_MODE_KEY, 'team');
        return;
      }
      if (data && data.members && data.members.length > 0) {
        // 내 팀만 필터링 (팀뷰 = 소속 팀만 보기)
        const _myId = _u?.id || '';
        const _myMember = data.members.find(m => m.userId === _myId);
        const _myTeam = _myMember?.teamName || _myMember?.role || '';
        if (_myTeam) {
          data.members = data.members.filter(m => (m.teamName || m.role || '') === _myTeam);
        }
        buildTeamSystem(data);
        updateBreadcrumb('team');
        document.querySelector('.tm-label').textContent = '👥 팀';
        localStorage.setItem(_VIEW_MODE_KEY, 'team');
        return;
      }
    }
  } catch {}

  // 워크스페이스가 없으면 팝업 직접 열어줌
  if (typeof openWorkspacePopup === 'function') openWorkspacePopup();
  showToast('👥 팀원과 함께하려면 워크스페이스를 만들거나 참여하세요 👇', 4000);
  // 뷰 전환 락 해제 (2초 후 — 애니메이션 완료 대기)
  setTimeout(() => { if (typeof _viewTransitionLock !== 'undefined') _viewTransitionLock = false; else window._viewTransitionLock = false; }, 2000);
}
window.loadTeamDemo = loadTeamDemo;

async function loadCompanyDemo() {
  // 뷰 전환 락 설정
  if (typeof _viewTransitionLock !== 'undefined') _viewTransitionLock = true;
  else window._viewTransitionLock = true;
  clearTimeout(window._zoomLodTimer);
  if (window.RendererManager) window.RendererManager.switchTo('company');
  if (typeof track === 'function') track('view.mode_switch', { from: 'team', to: 'company' });
  // 전사뷰 전용 슬라이더 + 카메라 기본값
  document.getElementById('spacing-personal').style.display = 'none';
  document.getElementById('spacing-team').style.display = 'none';
  document.getElementById('spacing-company').style.display = '';
  if (typeof controls !== 'undefined' && controls.sph) controls.sph.r = 15;
  const _u = typeof _orbitUser !== 'undefined' ? _orbitUser : JSON.parse(localStorage.getItem('orbitUser') || 'null');
  const token = _u?.token;

  if (!token) {
    showToast('🏢 전사 뷰는 로그인 후 사용 가능합니다', 3000);
    return;
  }

  try {
    const res = await fetch('/api/workspace/company-view', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) {
      const data = await res.json();
      if (data && data.tft && data.leaderA) {
        buildEnterpriseSystem(data);
        updateBreadcrumb('company');
        document.querySelector('.tm-label').textContent = '🏢 전사';
        localStorage.setItem(_VIEW_MODE_KEY, 'company');
        return;
      }
      if (data && data.departments && data.departments.length > 0) {
        buildCompanySystem(data);
        updateBreadcrumb('company');
        document.querySelector('.tm-label').textContent = '🏢 전사';
        localStorage.setItem(_VIEW_MODE_KEY, 'company');
        return;
      }
    }
  } catch {}

  // 워크스페이스가 없으면 팝업 직접 열어줌
  if (typeof openWorkspacePopup === 'function') openWorkspacePopup();
  showToast('🏢 전사 뷰는 워크스페이스 참여 후 사용 가능합니다 👇', 4000);
  // 뷰 전환 락 해제
  setTimeout(() => { if (typeof _viewTransitionLock !== 'undefined') _viewTransitionLock = false; else window._viewTransitionLock = false; }, 2000);
}
window.loadCompanyDemo = loadCompanyDemo;

// 로그인 상태에서 팀/회사 데이터 없을 때 안내
function _showNoTeamDataToast(type) {
  const msg = type === 'team'
    ? '👥 팀 데이터 없음 — 팀원을 초대하거나 팀에 합류하세요'
    : '🏢 회사 데이터 없음 — 팀장에게 초대를 요청하세요';
  // showToast 함수로 안내
  if (typeof showToast === 'function') showToast(msg, 4000);
  // 가이드 팝업 열기 유도 (샘플 체험 버튼 포함)
  setTimeout(() => openGuidePopup(), 500);
}

function _loadSampleTeam() {
  if (typeof showToast === 'function') showToast('팀원을 초대하면 실제 협업 구조가 표시됩니다', 3500);
  if (typeof loadTeamDemo === 'function') loadTeamDemo();
}
window._loadSampleTeam = _loadSampleTeam;

function _loadSampleCompany() {
  if (typeof showToast === 'function') showToast('팀장에게 초대를 요청하면 전사 구조가 표시됩니다', 3500);
  if (typeof loadCompanyDemo === 'function') loadCompanyDemo();
}
window._loadSampleCompany = _loadSampleCompany;

function loadParallelDemo() {
  if (typeof track === 'function') track('view.mode_switch', { from: 'personal', to: 'parallel' });
  if (typeof showToast === 'function') showToast('⚡ 병렬 에이전트 뷰 — 실제 작업 실행 시 자동 활성화됩니다', 3500);
}
window.loadParallelDemo = loadParallelDemo;

function loadHybridDemo() {
  if (typeof loadCompanyDemo === 'function') loadCompanyDemo();
}
window.loadHybridDemo = loadHybridDemo;

