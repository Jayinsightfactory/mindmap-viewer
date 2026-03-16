// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — 3D viewport controls (zoom, filters, minimap, alias, coreSkin, taskSidebar)
// ══════════════════════════════════════════════════════════════════════════════
// ── 노드 별명 (공개명 / 내 표시명) 시스템 ──────────────────────────────────
// _nodeAliases: { originalLabel → displayAlias }  (사용자가 지정한 내 표시 이름)
const _nodeAliases = (() => { try { return JSON.parse(localStorage.getItem('orbitNodeAliases') || '{}'); } catch { return {}; } })();

function saveAliases() {
  localStorage.setItem('orbitNodeAliases', JSON.stringify(_nodeAliases));
}

function getDisplayLabel(node) {
  return _nodeAliases[node.label] || node.label;
}

function showAliasEditBar(node) {
  // info-panel 요약 탭 끝에 별명 편집 바 추가
  let bar = document.getElementById('alias-edit-bar');
  if (!bar) {
    const tpl = document.getElementById('alias-edit-tpl');
    const clone = tpl.content.cloneNode(true);
    document.getElementById('ip-pane-summary').appendChild(clone);
    bar = document.getElementById('alias-edit-bar');
  }
  bar.dataset.originalLabel = node.label;
  const input = document.getElementById('alias-input');
  input.value = _nodeAliases[node.label] || '';
  input.placeholder = `기본: "${node.label}"`;
  bar.classList.add('visible');
}

function saveAlias() {
  const bar = document.getElementById('alias-edit-bar');
  if (!bar) return;
  const original = bar.dataset.originalLabel;
  const val = document.getElementById('alias-input').value.trim();
  if (val && val !== original) {
    _nodeAliases[original] = val;
  } else if (!val) {
    delete _nodeAliases[original];
  }
  saveAliases();
  // 3D 뷰의 pill 텍스트 즉시 반영 — _teamNodes의 label 변경
  const node = _teamNodes.find(n => n.label === original);
  if (node) node.displayLabel = _nodeAliases[original] || null;
  bar.classList.remove('visible');
}
window.saveAlias = saveAlias;


// ── 줌 버튼 (뷰 전환 포함) ───────────────────────────────────────────────────
function zoomStep(dir) {
  // dir: -1 = 줌인(r 감소), +1 = 줌아웃(r 증가)
  const cur  = controls.sph.r;
  const inTeam    = typeof _teamMode    !== 'undefined' && _teamMode && !(typeof _companyMode !== 'undefined' && _companyMode);
  const inCompany = typeof _companyMode !== 'undefined' && _companyMode;
  const inPersonal= !inTeam && !inCompany && !(typeof _parallelMode !== 'undefined' && _parallelMode);

  // 줌아웃 시 뷰 전환 임계값 체크
  if (dir > 0) {
    if (inPersonal && cur > 100 && typeof loadTeamDemo === 'function') {
      loadTeamDemo(); return;
    }
    if (inTeam && cur > 85 && typeof loadCompanyDemo === 'function') {
      loadCompanyDemo(); return;
    }
  }
  // 줌인 시 역방향 전환
  if (dir < 0) {
    if (inCompany && cur < 95 && typeof exitTeamMode === 'function') {
      exitTeamMode(); setTimeout(() => loadTeamDemo(), 100); return;
    }
    if (inTeam && cur < 45 && typeof exitTeamMode === 'function') {
      exitTeamMode(); return;
    }
  }

  const step = cur < 40 ? 5 : cur < 100 ? 10 : 20;
  const next = Math.max(8, Math.min(300, cur + dir * step));
  const tx = controls.tgt?.x || 0;
  const ty = controls.tgt?.y || 0;
  const tz = controls.tgt?.z || 0;
  lerpCameraTo(next, tx, ty, tz, 300);
}
window.zoomStep = zoomStep;

// 줌 레벨 표시 업데이트 (렌더 루프에서 호출) — ctrl-hub 내부 표시
function updateZoomDisplay() {
  const el = document.getElementById('up-zoom-level');
  if (el && controls?.sph) el.textContent = `r:${Math.round(controls.sph.r)}`;
}

// ── 미니맵 / 줌 (ctrl-hub 내에서 처리, 하단 별도 함수로 재정의됨) ──────────

// ── 뷰 설정 패널 (view-panel) ────────────────────────────────────────────────
const _VP_KEY = 'orbitViewPrefs';
const _viewPrefs = (() => { try { return JSON.parse(localStorage.getItem(_VP_KEY) || 'null'); } catch { return null; } })() || {
  zoom: { personal: 22, team: 70, company: 100 },
  filter: { type: 'all' },
  customGroups: [],
  activeGroupId: null,
};
let _nodeFilter = _viewPrefs.filter || { type: 'all' };

function saveViewPrefs() {
  localStorage.setItem(_VP_KEY, JSON.stringify(_viewPrefs));
}

// 슬라이더 초기화
(function initViewSliders() {
  const pEl = document.getElementById('zoom-personal');
  const tEl = document.getElementById('zoom-team');
  const cEl = document.getElementById('zoom-company');
  if (pEl) { pEl.value = _viewPrefs.zoom.personal; document.getElementById('zoom-personal-val').textContent = _viewPrefs.zoom.personal; }
  if (tEl) { tEl.value = _viewPrefs.zoom.team;     document.getElementById('zoom-team-val').textContent = _viewPrefs.zoom.team; }
  if (cEl) { cEl.value = _viewPrefs.zoom.company;  document.getElementById('zoom-company-val').textContent = _viewPrefs.zoom.company; }
})();

function saveZoomPref(mode, val) {
  _viewPrefs.zoom[mode] = parseInt(val);
  saveViewPrefs();
}

function applyModeZoom(mode) {
  const r = _viewPrefs.zoom[mode] || { personal: 22, team: 70, company: 100 }[mode];
  if (typeof lerpCameraTo === 'function') lerpCameraTo(r, 0, 0, 0, 800);
  const labels = { personal: '내 화면', team: '팀', company: '전사' };
  showApplyEffect(`배율 적용: ${labels[mode] || mode} r=${r}`);
}

function applyCurrentModeZoom() {
  if (_companyMode) applyModeZoom('company');
  else if (_teamMode) applyModeZoom('team');
  else applyModeZoom('personal');
}

function toggleViewPanel() {
  // 통합 패널의 📐 노드 탭으로 이동
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    switchUpTab('node', document.querySelector('.up-tab[data-tab="node"]'));
  }
}
window.toggleViewPanel = toggleViewPanel;

// ═══ 통합 제어판 ══════════════════════════════════════════════════════════

function toggleUnifiedPanel() {
  const panel = document.getElementById('unified-panel');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (isOpen) {
    // 이펙트 탭이 열려있으면 초기화
    const fxPane = document.getElementById('up-pane-fx');
    if (fxPane && fxPane.classList.contains('active')) {
      if (typeof initEffectsPanel === 'function') initEffectsPanel();
      if (typeof updateEffectsPanelNode === 'function') updateEffectsPanelNode();
    }
    // 스킨 탭이 열려있으면 초기화
    const skinPane = document.getElementById('up-pane-skin');
    if (skinPane && skinPane.classList.contains('active')) {
      if (typeof renderCoreSkinGrid === 'function') renderCoreSkinGrid();
    }
    // 즐겨찾기 탭이 열려있으면 새로고침
    const bmPane = document.getElementById('up-pane-bm');
    if (bmPane && bmPane.classList.contains('active')) {
      renderBookmarkList();
    }
  }
}
window.toggleUnifiedPanel = toggleUnifiedPanel;

function switchUpTab(tabId, btn) {
  document.querySelectorAll('.up-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.up-pane').forEach(p => p.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else {
    const tb = document.querySelector(`.up-tab[data-tab="${tabId}"]`);
    if (tb) tb.classList.add('active');
  }
  const pane = document.getElementById('up-pane-' + tabId);
  if (pane) pane.classList.add('active');

  // 탭 전환 시 초기화
  if (tabId === 'fx') {
    if (typeof initEffectsPanel === 'function') initEffectsPanel();
    if (typeof updateEffectsPanelNode === 'function') updateEffectsPanelNode();
  } else if (tabId === 'skin') {
    if (typeof renderCoreSkinGrid === 'function') renderCoreSkinGrid();
  } else if (tabId === 'bm') {
    renderBookmarkList();
  } else if (tabId === 'ctrl') {
    // 공전 버튼 상태 동기화
    const ob = document.getElementById('up-orbit-btn');
    if (ob) ob.textContent = (typeof orbitAnimOn !== 'undefined' && orbitAnimOn) ? '⏸ 공전 중지' : '▶ 공전 시작';
  }
}
window.switchUpTab = switchUpTab;

// ── 즐겨찾기 목록 렌더링 ─────────────────────────────────────────────────
let _bookmarksCache = [];

async function loadBookmarks() {
  try {
    const res = await fetch('/api/bookmarks');
    _bookmarksCache = await res.json();
  } catch { _bookmarksCache = []; }
}

function renderBookmarkList() {
  const list = document.getElementById('bm-list');
  if (!list) return;
  if (!_bookmarksCache.length) {
    list.innerHTML = '<div style="font-size:11px;color:#6e7681;padding:20px 0;text-align:center">즐겨찾기가 없습니다</div>';
    return;
  }
  list.innerHTML = _bookmarksCache.map(bm => {
    const label = bm.label || bm.event_id.slice(-8);
    return `<div class="bm-item" onclick="flyToBookmark('${bm.event_id}')">
      <div class="bm-item-dot" style="background:#ffd700"></div>
      <div class="bm-item-label">${label}</div>
      <button class="bm-item-del" onclick="event.stopPropagation();removeBookmarkById('${bm.id}')" title="제거">✕</button>
    </div>`;
  }).join('');
}

async function removeBookmarkById(id) {
  await fetch('/api/bookmarks/' + id, { method: 'DELETE' });
  await loadBookmarks();
  renderBookmarkList();
}

function flyToBookmark(eventId) {
  // 노드 찾아서 카메라 이동
  const all = [...(planetMeshes || []), ...(satelliteMeshes || [])];
  const target = all.find(m => m.userData?.clusterId === eventId || m.userData?.eventId === eventId || m.userData?.sessionId === eventId);
  if (target && typeof controls !== 'undefined') {
    controls.target.copy(target.position);
    camera.position.set(target.position.x, target.position.y + 15, target.position.z + 20);
  }
}
window.flyToBookmark = flyToBookmark;
window.removeBookmarkById = removeBookmarkById;

// 초기 로드
loadBookmarks();

// ── 필터 ──────────────────────────────────────────────────────────────────
function nodeMatchesFilter(node) {
  const f = _nodeFilter;
  if (!f || f.type === 'all') return true;
  const t = node.type;
  // 구조 노드는 항상 표시
  if (t === 'goal' || t === 'department') return true;
  if (f.type === 'mine') {
    return node.memberId === _myMemberId || t === 'goal';
  }
  if (f.type === 'team') {
    return !node.deptId || true; // 팀 모드: 전체
  }
  if (f.type === 'company') {
    return true; // 회사 모드: 전체
  }
  if (f.type === 'depts' && f.deptIds) {
    if (!node.deptId) return true;
    return f.deptIds.includes(node.deptId);
  }
  if (f.type === 'members' && f.memberIds) {
    if (!node.memberId) return true;
    return f.memberIds.includes(node.memberId);
  }
  return true;
}
window.nodeMatchesFilter = nodeMatchesFilter;

function setNodeFilter(type, btnEl) {
  if (typeof track === 'function') track('view.filter_change', { filter_type: 'view', value: type });
  _nodeFilter = { type };
  _viewPrefs.filter = _nodeFilter;
  saveViewPrefs();
  // 버튼 active 상태 갱신
  document.querySelectorAll('#vp-presets .vp-preset').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');
  renderActiveFilter();
  rebuildScene();
}
window.setNodeFilter = setNodeFilter;

function rebuildScene() {
  if (_companyMode) buildCompanySystem(_activeSimData);
  else if (_teamMode) buildTeamSystem(_activeSimData);
}

function renderActiveFilter() {
  const el = document.getElementById('vp-active-filter');
  if (!el) return;
  const f = _nodeFilter;
  if (f.type === 'all') { el.innerHTML = ''; return; }
  const labels = { mine: '내 할 일만', team: '팀 전체', company: '회사 전체',
    depts: `부서: ${(f.deptIds||[]).join(', ')}`, members: `멤버: ${(f.memberIds||[]).join(', ')}` };
  el.innerHTML = `<span class="vp-filter-tag">${labels[f.type] || f.type} <button onclick="clearNodeFilter()" style="background:none;border:none;color:#ef4444;cursor:pointer;padding:0 2px;">✕</button></span>`;
}

function clearNodeFilter() {
  _nodeFilter = { type: 'all' };
  _viewPrefs.filter = _nodeFilter;
  saveViewPrefs();
  document.querySelectorAll('#vp-presets .vp-preset').forEach((b,i) => b.classList.toggle('active', i===0));
  renderActiveFilter();
  rebuildScene();
}
window.clearNodeFilter = clearNodeFilter;

// ── AI 필터 ────────────────────────────────────────────────────────────────
function parseFilterText(text) {
  const t = text.trim();
  if (!t) return { type: 'all' };
  if (/전체|모두|all/i.test(t)) return { type: 'all' };
  if (/내.?작업|내.?것|mine/i.test(t)) return { type: 'mine' };

  const depts = (_activeSimData && _activeSimData.departments) ? _activeSimData.departments : [];
  const matchedDeptIds = [];
  depts.forEach(d => {
    if (t.includes(d.name) || (d.icon && t.includes(d.icon))) matchedDeptIds.push(d.id);
  });
  if (matchedDeptIds.length > 0) return { type: 'depts', deptIds: matchedDeptIds };

  const members = depts.flatMap(d => d.members || []).concat(
    (_activeSimData && _activeSimData.members) ? _activeSimData.members : []
  );
  const matchedMemberIds = [];
  members.forEach(m => {
    if (m.name && t.includes(m.name)) matchedMemberIds.push(m.id);
  });
  if (matchedMemberIds.length > 0) return { type: 'members', memberIds: matchedMemberIds };

  return { type: 'all' };
}

function applyAIFilter() {
  const input = document.getElementById('ai-filter-input');
  if (!input) return;
  const text = input.value;
  if (typeof track === 'function') track('ai.filter_query', { query: text.slice(0, 100) });
  const filter = parseFilterText(text);
  _nodeFilter = filter;
  _viewPrefs.filter = filter;
  saveViewPrefs();
  // 프리셋 버튼 active 해제
  document.querySelectorAll('#vp-presets .vp-preset').forEach(b => b.classList.remove('active'));
  renderActiveFilter();
  rebuildScene();
  const filterDesc = filter.type === 'all' ? '전체 보기'
    : filter.type === 'mine' ? '내 할 일만'
    : filter.type === 'depts' ? `부서 필터 (${filter.deptIds?.length || 0}개)`
    : filter.type === 'members' ? `멤버 필터 (${filter.memberIds?.length || 0}명)`
    : filter.type;
  showApplyEffect(`🤖 AI 필터 적용: ${filterDesc}`);
  if (filter.type !== 'all') input.value = '';
}
window.applyAIFilter = applyAIFilter;

// ── 커스텀 그룹 ────────────────────────────────────────────────────────────
function openGroupCreator() {
  const nameEl = document.getElementById('vp-new-group-name');
  const name = nameEl ? nameEl.value.trim() : '';
  if (!name) { if (nameEl) nameEl.focus(); return; }
  // 현재 시뮬 데이터의 모든 부서 ID를 기본값으로
  const depts = (_activeSimData && _activeSimData.departments) ? _activeSimData.departments : [];
  const deptIds = depts.map(d => d.id);
  saveCustomGroup(name, deptIds, []);
  if (nameEl) nameEl.value = '';
}
window.openGroupCreator = openGroupCreator;

function saveCustomGroup(name, deptIds, memberIds) {
  const group = { id: `g${Date.now()}`, name, deptIds: deptIds||[], memberIds: memberIds||[] };
  _viewPrefs.customGroups.push(group);
  saveViewPrefs();
  renderGroupList();
}

function loadCustomGroup(id) {
  const g = _viewPrefs.customGroups.find(g => g.id === id);
  if (!g) return;
  _viewPrefs.activeGroupId = id;
  _nodeFilter = { type: 'depts', deptIds: g.deptIds, memberIds: g.memberIds };
  _viewPrefs.filter = _nodeFilter;
  saveViewPrefs();
  document.querySelectorAll('#vp-presets .vp-preset').forEach(b => b.classList.remove('active'));
  renderActiveFilter();
  rebuildScene();
}
window.loadCustomGroup = loadCustomGroup;

function deleteCustomGroup(id, e) {
  e && e.stopPropagation();
  _viewPrefs.customGroups = _viewPrefs.customGroups.filter(g => g.id !== id);
  if (_viewPrefs.activeGroupId === id) {
    _viewPrefs.activeGroupId = null;
    _nodeFilter = { type: 'all' };
    _viewPrefs.filter = _nodeFilter;
    rebuildScene();
  }
  saveViewPrefs();
  renderGroupList();
  renderActiveFilter();
}
window.deleteCustomGroup = deleteCustomGroup;

function renderGroupList() {
  const el = document.getElementById('vp-group-list');
  if (!el) return;
  const groups = _viewPrefs.customGroups || [];
  if (groups.length === 0) { el.innerHTML = '<div style="font-size:10px;opacity:.4;padding:4px 0;">저장된 그룹 없음</div>'; return; }
  el.innerHTML = groups.map(g => `
    <div class="vp-group-item${_viewPrefs.activeGroupId===g.id?' active':''}" onclick="loadCustomGroup('${g.id}')">
      <span style="flex:1;font-size:11px;">${g.name}</span>
      <button onclick="deleteCustomGroup('${g.id}',event)" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:11px;padding:0 2px;">✕</button>
    </div>`).join('');
}

// 앱 부팅 시 저장된 필터 복원
(function restoreFilter() {
  const f = _viewPrefs.filter;
  if (!f || f.type === 'all') return;
  // 프리셋 버튼 매핑
  const presetMap = { all:0, mine:1, team:2, company:3 };
  const idx = presetMap[f.type];
  if (idx !== undefined) {
    document.querySelectorAll('#vp-presets .vp-preset').forEach((b,i) => b.classList.toggle('active', i===idx));
  }
})();

// ── 전체 뷰 자동 맞춤 ─────────────────────────────────────────────────────────
function autoFitView(nodes, padding = 1.35) {
  const positions = (nodes || _teamNodes).filter(n => n.pos).map(n => n.pos);
  if (positions.length === 0) { lerpCameraTo(60, 0, 0, 0, 700); return; }
  let maxDist = 0;
  for (const p of positions) {
    const d = Math.sqrt(p.x * p.x + p.z * p.z);
    if (d > maxDist) maxDist = d;
  }
  const fitR = Math.max(30, maxDist * padding);
  lerpCameraTo(fitR, 0, 0, 0, 800);
}
window.autoFitView = autoFitView;

// ── 컨트롤 허브 → 통합 패널의 🎮 탭으로 이동 ─────────────────────────────────
function toggleCtrlHub() {
  // 통합 패널의 🎮 조작 탭 열기
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    if (typeof switchUpTab === 'function') switchUpTab('ctrl', document.querySelector('.up-tab[data-tab="ctrl"]'));
  }
}
function closeCtrlHub() {
  const panel = document.getElementById('unified-panel');
  if (panel) panel.classList.remove('open');
}
window.toggleCtrlHub = toggleCtrlHub;
window.closeCtrlHub  = closeCtrlHub;

// ── 줌 표시 (ctrl-hub 캔버스용 — updateZoomDisplay는 위에서 재정의됨) ────────

// ── 미니맵: ctrl-hub 내부 캔버스 사용 ────────────────────────────────────────
function drawMinimap3d() {
  // ctrl-hub 내부 캔버스
  const mc = document.getElementById('up-minimap-canvas');
  if (!mc) return;
  const mctx = mc.getContext('2d');
  const W = 156, H = 100, PAD = 5;

  mctx.fillStyle = '#060a10';
  mctx.fillRect(0, 0, W, H);

  const pts = [];
  if (typeof planetMeshes !== 'undefined') {
    planetMeshes.forEach(p => pts.push({ x: p.position.x, z: p.position.z, c: '#58a6ff', r: 3 }));
  }
  if (typeof satelliteMeshes !== 'undefined') {
    satelliteMeshes.forEach(s => pts.push({ x: s.position.x, z: s.position.z, c: '#8b949e', r: 1.5 }));
  }
  if (typeof _teamNodes !== 'undefined' && _teamNodes.length > 0) {
    const typeColor = { goal:'#ffd700', member:'#79c0ff', department:'#d2a8ff',
                        task:'#8b949e', skill:'#bc8cff', agent:'#3fb950', tool:'#f0883e' };
    _teamNodes.forEach(n => {
      if (!n.pos) return;
      const isMine = _myMemberId && n.memberId === _myMemberId;
      pts.push({ x: n.pos.x, z: n.pos.z,
        c: isMine ? '#3fb950' : (typeColor[n.type] || '#6e7681'),
        r: n.type === 'goal' ? 4 : isMine ? 4 : n.type === 'member' ? 3 : 1.5 });
    });
  }

  if (pts.length === 0) {
    mctx.fillStyle = '#6e7681'; mctx.font = '9px sans-serif'; mctx.textAlign = 'center';
    mctx.fillText('데이터 없음', W / 2, H / 2); return;
  }

  const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minZ = Math.min(...zs), maxZ = Math.max(...zs);
  const rangeX = (maxX - minX) || 1, rangeZ = (maxZ - minZ) || 1;
  const toMX = x => PAD + ((x - minX) / rangeX) * (W - PAD * 2);
  const toMY = z => PAD + ((z - minZ) / rangeZ) * (H - PAD * 2);

  // 협업 라인도 미니맵에 표시
  if (typeof _collabLines !== 'undefined') {
    mctx.strokeStyle = 'rgba(57,210,192,0.4)'; mctx.lineWidth = 1;
    _collabLines.forEach(cl => {
      if (!cl.fromNode?.pos || !cl.toNode?.pos) return;
      mctx.beginPath();
      mctx.moveTo(toMX(cl.fromNode.pos.x), toMY(cl.fromNode.pos.z));
      mctx.lineTo(toMX(cl.toNode.pos.x), toMY(cl.toNode.pos.z));
      mctx.stroke();
    });
  }

  for (const p of pts) {
    mctx.beginPath(); mctx.arc(toMX(p.x), toMY(p.z), p.r, 0, Math.PI * 2);
    mctx.fillStyle = p.c; mctx.globalAlpha = 0.85; mctx.fill();
  }
  mctx.globalAlpha = 1;

  if (controls?.tgt) {
    const cx = toMX(controls.tgt.x), cy = toMY(controls.tgt.z);
    mctx.strokeStyle = 'rgba(88,166,255,0.9)'; mctx.lineWidth = 1;
    mctx.beginPath(); mctx.moveTo(cx-5,cy); mctx.lineTo(cx+5,cy); mctx.stroke();
    mctx.beginPath(); mctx.moveTo(cx,cy-5); mctx.lineTo(cx,cy+5); mctx.stroke();
    const rScale = Math.min((W-PAD*2)/rangeX, (H-PAD*2)/rangeZ);
    const rPx = Math.min((controls.sph.r/Math.max(rangeX,rangeZ))*rScale*12, 40);
    mctx.beginPath(); mctx.arc(cx,cy,Math.max(4,rPx),0,Math.PI*2);
    mctx.strokeStyle = 'rgba(88,166,255,0.3)'; mctx.stroke();
  }
}

// 미니맵 클릭 → 카메라 이동 (ctrl-hub 캔버스)
(function initCtrlHubMinimap() {
  let dragging = false;
  function moveTo(e) {
    const mc = document.getElementById('up-minimap-canvas');
    if (!mc) return;
    const rect = mc.getBoundingClientRect();
    const PAD = 5, W = 156, H = 100;
    const rx = Math.max(0, Math.min(1, (e.clientX - rect.left  - PAD) / (W - PAD * 2)));
    const ry = Math.max(0, Math.min(1, (e.clientY - rect.top   - PAD) / (H - PAD * 2)));
    const pts = typeof _teamNodes !== 'undefined' ? _teamNodes.filter(n => n.pos).map(n => ({ x: n.pos.x, z: n.pos.z }))
      : (typeof planetMeshes !== 'undefined' ? planetMeshes.map(p => ({ x: p.position.x, z: p.position.z })) : []);
    if (pts.length === 0) return;
    const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const tx = minX + rx * (maxX - minX);
    const tz = minZ + ry * (maxZ - minZ);
    lerpCameraTo(controls.sph.r, tx, controls.tgt?.y || 0, tz, 300);
  }
  document.addEventListener('mousedown', e => {
    const mc = document.getElementById('up-minimap-canvas');
    if (mc && mc.contains(e.target)) { dragging = true; moveTo(e); }
  });
  document.addEventListener('mousemove', e => { if (dragging) moveTo(e); });
  document.addEventListener('mouseup', () => { dragging = false; });
})();

// ── 내 작업 사이드바 ──────────────────────────────────────────────────────────
function toggleTaskSidebar() {
  const sidebar = document.getElementById('my-task-sidebar');
  const btn     = document.getElementById('task-sidebar-btn');
  const open = sidebar.classList.toggle('open');
  btn.classList.toggle('open', open);
  if (open) updateMyTaskSidebar();
}
window.toggleTaskSidebar = toggleTaskSidebar;

function setMyMember(id) {
  _myMemberId = id || null;
  if (_myMemberId) localStorage.setItem('orbitMyMemberId', _myMemberId);
  else localStorage.removeItem('orbitMyMemberId');
  updateMyTaskSidebar();
}
window.setMyMember = setMyMember;

function updateMyTaskSidebar() {
  const sel   = document.getElementById('mts-member-sel');
  const body  = document.getElementById('mts-body');
  if (!sel || !body) return;

  // 멤버 목록 빌드
  let allMembers = [];
  if (_activeSimData) {
    if (_companyMode) {
      allMembers = (_activeSimData.departments || []).flatMap(d => d.members || []);
    } else {
      allMembers = _activeSimData.members || [];
    }
  }

  // select 옵션 업데이트
  const currentVal = _myMemberId || '';
  sel.innerHTML = '<option value="">-- 나는 누구? 선택 --</option>' +
    allMembers.map(m => `<option value="${m.id}"${m.id === currentVal ? ' selected' : ''}>${m.name} (${m.role})</option>`).join('');

  // 내용 렌더
  if (!_myMemberId || allMembers.length === 0) {
    body.innerHTML = '<div class="mts-empty">팀원을 선택하면<br>작업 목록이 표시됩니다</div>';
    return;
  }
  const me = allMembers.find(m => m.id === _myMemberId);
  if (!me) { body.innerHTML = '<div class="mts-empty">멤버를 찾을 수 없습니다</div>'; return; }

  const STATUS_META = {
    active:  { emoji: '🟢', label: '진행 중', color: '#3fb950' },
    done:    { emoji: '✅', label: '완료',     color: '#58a6ff' },
    blocked: { emoji: '🔴', label: '블록됨',   color: '#f85149' },
    pending: { emoji: '⏳', label: '대기',     color: '#8b949e' },
  };

  const collabTaskNames = new Set(
    (me.tasks || []).filter(t => t.collab).map(t => t.name)
  );

  // 내 협업 파트너
  const myNode = _teamNodes.find(n => n.type === 'member' && n.memberId === _myMemberId);
  const collabPartners = _collabLines
    .filter(cl => cl.fromNode?.memberId === _myMemberId || cl.toNode?.memberId === _myMemberId)
    .map(cl => cl.fromNode?.memberId === _myMemberId ? cl.toNode : cl.fromNode)
    .filter(n => n)
    .map(n => n.label)
    .join(', ');

  const tasksHtml = (me.tasks || []).map(task => {
    const sm = STATUS_META[task.status] || STATUS_META.pending;
    const pct = Math.round((task.progress || 0) * 100);
    const isCollab = task.collab;
    const subsHtml = (task.subtasks || []).slice(0, 4).map((s, i) => {
      const done = i < (task.completedSubtasks || 0);
      return `<div class="mts-sub-item">${done ? '✓' : '○'} <span style="color:${done?'#3fb950':'#6e7681'}">${s}</span></div>`;
    }).join('');
    return `
      <div class="mts-task${isCollab ? ' my-node' : ''}">
        <div class="mts-task-name">${task.name}${isCollab ? ' <span style="font-size:9px;color:#39d2c0;font-weight:400">🤝 협업</span>' : ''}</div>
        <div class="mts-task-bar"><div class="mts-task-fill" style="width:${pct}%;background:${sm.color}"></div></div>
        <div class="mts-task-meta">
          <span>${sm.emoji} ${sm.label}</span>
          <span style="margin-left:auto;color:${sm.color};font-weight:600">${pct}%</span>
        </div>
        ${subsHtml ? `<div class="mts-sub-list">${subsHtml}</div>` : ''}
      </div>`;
  }).join('');

  body.innerHTML = `
    <div style="font-size:11px;color:#cdd9e5;font-weight:700;margin-bottom:2px">${me.name}</div>
    <div style="font-size:10px;color:#6e7681;margin-bottom:10px">${me.role}</div>
    ${collabPartners ? `<div class="mts-collab-hint">🤝 협업 중: ${collabPartners}</div>` : ''}
    <div class="mts-section-lbl">작업 목록</div>
    ${tasksHtml || '<div class="mts-empty">작업 없음</div>'}
  `;
}
window.updateMyTaskSidebar = updateMyTaskSidebar;

// ── 자신(me) 노드 강조 (Canvas2D 레이블에서 "나" 배지 추가) ─────────────────
// drawTeamLabels의 Draw pass에서 myMember 노드 감지 후 왕관 배지 렌더링은
// drawTeamLabels 내부에서 직접 처리하여 위치 추적이 가능하게 함

// ── showPanel에서 별명 편집 바 연동 ─────────────────────────────────────────
const _origShowPanel = showPanel;
window.showPanel = function(data, obj) {
  _origShowPanel(data, obj);
  // skill, agent, member, department 노드에만 별명 편집 바 표시
  const editableTypes = ['skill', 'agent', 'member', 'department', 'goal', 'task'];
  if (editableTypes.includes(data.type)) {
    showAliasEditBar(data);
  } else {
    const bar = document.getElementById('alias-edit-bar');
    if (bar) bar.classList.remove('visible');
  }
  // member 노드: DM 버튼 삽입
  if (data.type === 'member' && data.memberId) {
    const panel = document.getElementById('info-panel');
    let dmRow = panel?.querySelector('.ip-dm-row');
    if (!dmRow && panel) {
      dmRow = document.createElement('div');
      dmRow.className = 'ip-dm-row';
      dmRow.style.cssText = 'padding:8px 14px;display:flex;gap:8px;border-top:1px solid #21262d;flex-shrink:0;';
      panel.appendChild(dmRow);
    }
    if (dmRow) {
      dmRow.innerHTML = `
        <button onclick="openDmPanel('${data.memberId}','${(data.label||'').replace(/'/g,'\\\'').replace(/"/g,'&quot;')}','${data.color||'#58a6ff'}')"
          style="flex:1;padding:7px;background:#1f6feb;border:none;color:#fff;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;font-weight:600;">
          💬 DM 보내기
        </button>
        <button onclick="openMyTalentPanel()"
          style="padding:7px 12px;background:#21262d;border:1px solid #3fb95060;color:#3fb950;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;"
          title="내 능력을 인재 보드에 공개">
          📡 공개
        </button>
      `;
    }
  }
};


/* ── LEFT NAV + ZOOM LOD + MEMBER DETAIL ────────────────────────────────────
 * 사이드바 토글, 줌 기반 뷰 자동전환, 멤버 작업 상세
 * ─────────────────────────────────────────────────────────────────────────── */
let _lnCollapsed = false;
let _lastLodR = 75;
let _zoomLodTimer = null;
let _memberDetailOpen = false;

function toggleLeftNav() {
  _lnCollapsed = !_lnCollapsed;
  document.getElementById('left-nav').classList.toggle('collapsed', _lnCollapsed);
  // HUD / 범례 위치 조정 (nav 너비에 맞게 이동)
  const offset = _lnCollapsed ? '58px' : '214px';
  const hudEl    = document.getElementById('hud');
  const legendEl = document.getElementById('legend');
  if (hudEl)    hudEl.style.left    = offset;
  if (legendEl) legendEl.style.left = offset;
  // 사이드바 너비 변경 → 렌더 영역 재계산
  requestAnimationFrame(() => {
    resizeRendererToSidebar();
    resizeLabelCanvas();
  });
}
window.toggleLeftNav = toggleLeftNav;

function setViewPersonal() {
  // workspace → personal 전환 시 multilevel scene 정리
  if (window.RendererManager) {
    window.RendererManager.switchTo('personal');
  } else if (window.multiLevelRenderer) {
    // RendererManager 미로드 폴백
    if (typeof closeDrillPanel === 'function') closeDrillPanel();
  }

  // 강제 multilevel 잔여 오브젝트 정리 (RendererManager 경유 후에도 보험)
  if (window.RendererManager && window.RendererManager.cleanupMultilevel) {
    window.RendererManager.cleanupMultilevel();
  }

  if (typeof _teamMode !== 'undefined' && (_teamMode || _companyMode)) exitTeamMode();
  if (typeof _parallelMode !== 'undefined' && _parallelMode) exitParallelMode();
  localStorage.setItem('orbitViewMode', 'personal');
  updateNavActiveState();
}
window.setViewPersonal = setViewPersonal;

function updateNavActiveState() {
  ['lni-personal','lni-team','lni-company','lni-parallel'].forEach(id => {
    document.getElementById(id)?.classList.remove('active');
  });
  if (typeof _parallelMode !== 'undefined' && _parallelMode)
    document.getElementById('lni-parallel')?.classList.add('active');
  else if (typeof _companyMode !== 'undefined' && _companyMode)
    document.getElementById('lni-company')?.classList.add('active');
  else if (typeof _teamMode !== 'undefined' && _teamMode)
    document.getElementById('lni-team')?.classList.add('active');
  else
    document.getElementById('lni-personal')?.classList.add('active');
}

function updateZoomLOD() {
  const r = controls?.sph?.r;
  if (!r) return;

  // 뷰 모드 라벨
  const modeLabel = (typeof _parallelMode !== 'undefined' && _parallelMode) ? '⚡ AI 멀티뷰' :
                    (typeof _companyMode  !== 'undefined' && _companyMode)  ? '🏢 전사' :
                    (typeof _teamMode     !== 'undefined' && _teamMode)     ? '👥 팀'   : '👤 내 화면';

  const ztEl = document.getElementById('ln-zoom-text');
  const zhEl = document.getElementById('ln-zoom-hint');
  if (ztEl) ztEl.textContent = `${modeLabel}  ·  r:${Math.round(r)}`;

  // 줌 힌트 & 자동전환
  if (zhEl) {
    const inTeam    = typeof _teamMode    !== 'undefined' && _teamMode    && !(typeof _companyMode !== 'undefined' && _companyMode);
    const inCompany = typeof _companyMode !== 'undefined' && _companyMode;
    const inPersonal= !(typeof _teamMode !== 'undefined' && _teamMode) &&
                      !(typeof _companyMode !== 'undefined' && _companyMode) &&
                      !(typeof _parallelMode !== 'undefined' && _parallelMode);

    // ── 카메라 거리 → 행성 레벨 자동 전환 (개인 모드만) ──
    if (typeof planetMeshes !== 'undefined' && planetMeshes.length > 0) {
      if (inPersonal) {
        let targetLevel = 0;
        if (r < 50)       targetLevel = 0;  // compact
        else if (r < 120) targetLevel = 1;  // personal work
        else              targetLevel = 2;  // wider view
        for (let i = 0; i < planetMeshes.length; i++) {
          planetMeshes[i].userData._currentLevel = targetLevel;
        }
      } else {
        // 팀/전사 모드 진입 시 레벨 리셋 (잔류값 방지)
        for (let i = 0; i < planetMeshes.length; i++) {
          if (planetMeshes[i].userData._currentLevel !== 0) {
            planetMeshes[i].userData._currentLevel = 0;
          }
        }
      }
    }

    if (inPersonal && r > 120) {
      zhEl.textContent = '🔍 줌아웃 → 팀 전환';
      zhEl.onclick = () => loadTeamDemo();
    } else if (inTeam && r > 90) {
      zhEl.textContent = '🔍 줌아웃 → 전사 전환';
      zhEl.onclick = () => loadCompanyDemo();
    } else if (inTeam && (typeof _focusedMember !== 'undefined') && _focusedMember && r < 8) {
      zhEl.textContent = '🔎 작업 상세 표시 중';
      zhEl.onclick = null;
    } else {
      zhEl.textContent = '';
      zhEl.onclick = null;
    }

    // ── 자동 뷰 전환: 줌 임계값 초과 시 즉시 전환 ──
    const prevR = _lastLodR;
    _lastLodR = r;

    if (inPersonal && r > 140 && prevR <= 140) {
      clearTimeout(_zoomLodTimer);
      _zoomLodTimer = setTimeout(() => {
        if (controls.sph.r > 130 && !(typeof _teamMode !== 'undefined' && _teamMode)) {
          if (typeof loadTeamDemo === 'function') loadTeamDemo();
        }
      }, 500);
    } else if (inPersonal && r <= 130) {
      clearTimeout(_zoomLodTimer);
    }
    if (inTeam && r > 100 && prevR <= 100) {
      clearTimeout(_zoomLodTimer);
      _zoomLodTimer = setTimeout(() => {
        if (controls.sph.r > 95 && (typeof _teamMode !== 'undefined' && _teamMode)) {
          if (typeof loadCompanyDemo === 'function') loadCompanyDemo();
        }
      }, 500);
    } else if (inTeam && r <= 90) {
      clearTimeout(_zoomLodTimer);
    }
    if (inCompany && r < 75 && prevR >= 75) {
      clearTimeout(_zoomLodTimer);
      _zoomLodTimer = setTimeout(() => {
        if (controls.sph.r < 80 && (typeof _companyMode !== 'undefined' && _companyMode)) {
          if (typeof exitTeamMode === 'function') { exitTeamMode(); setTimeout(() => loadTeamDemo(), 100); }
        }
      }, 500);
    } else if (inCompany && r >= 80) {
      clearTimeout(_zoomLodTimer);
    }
  }

  // ── 멤버 상세 패널 (팀 뷰 + 멤버 포커스 + 아주 가까이 줌인) ──
  const fm = typeof _focusedMember !== 'undefined' ? _focusedMember : null;
  if (fm && (typeof _teamMode !== 'undefined' && _teamMode) && r < 9) {
    showMemberDetail(fm);
  } else if (r >= 11) {
    hideMemberDetail();
  }

  updateNavActiveState();
}
window.updateZoomLOD = updateZoomLOD;

function showMemberDetail(member) {
  const panel = document.getElementById('member-detail-panel');
  if (!panel || !member) return;
  if (_memberDetailOpen && panel.dataset.memberId === (member.memberId || '')) return;
  _memberDetailOpen = true;
  panel.dataset.memberId = member.memberId || '';

  const tasks = member.tasks ||
    ((typeof _teamNodes !== 'undefined' ? _teamNodes : [])
      .filter(n => n.type === 'task' && n.memberId === member.memberId));

  const taskHtml = tasks.length ? tasks.map(t => {
    const pct = t.progress != null ? Math.round(t.progress) : 0;
    const col = pct >= 75 ? '#3fb950' : pct >= 40 ? '#58a6ff' : '#f0883e';
    return `<div class="mdp-task">
      <div class="mdp-task-label">
        <span>${t.label || t.sublabel || '작업'}</span>
        <span class="mdp-task-pct">${pct}%</span>
      </div>
      <div class="mdp-bar"><div class="mdp-bar-fill" style="width:${pct}%;background:${col}"></div></div>
    </div>`;
  }).join('') : '<div style="color:#8b949e;font-size:12px;text-align:center;padding:8px">등록된 작업 없음</div>';

  panel.innerHTML = `
    <div class="mdp-header">
      <div class="mdp-avatar" style="background:${member.color || '#58a6ff'}22">${member.emoji || (member.label||'👤')[0]}</div>
      <div>
        <div class="mdp-name">${member.label || '팀원'}</div>
        <div class="mdp-role">${member.role || ''} · ${tasks.length}개 작업</div>
      </div>
      <button class="mdp-close" onclick="hideMemberDetail()">✕</button>
    </div>
    ${taskHtml}
    <div class="mdp-hint">줌아웃하면 팀 화면으로 돌아갑니다</div>
  `;
  panel.classList.add('open');
}
window.showMemberDetail = showMemberDetail;

function hideMemberDetail() {
  _memberDetailOpen = false;
  document.getElementById('member-detail-panel')?.classList.remove('open');
}
window.hideMemberDetail = hideMemberDetail;

/* ══════════════════════════════════════════════════════════════════════════
 * CORE SKIN SYSTEM — 중앙 행성 모양 선택
 * ══════════════════════════════════════════════════════════════════════════ */
const CORE_SKINS = [
  { id: 'sphere',       name: '구체',      icon: '🌕', geo: () => new THREE.SphereGeometry(2.5, 32, 32) },
  { id: 'icosahedron',  name: '크리스탈',  icon: '💎', geo: () => new THREE.IcosahedronGeometry(2.8, 1) },
  { id: 'dodecahedron', name: '다각형',    icon: '⬡',  geo: () => new THREE.DodecahedronGeometry(2.6, 0) },
  { id: 'octahedron',   name: '팔면체',    icon: '🔷', geo: () => new THREE.OctahedronGeometry(2.8, 0) },
  { id: 'torus',        name: '링',        icon: '⭕', geo: () => new THREE.TorusGeometry(2.0, 0.75, 16, 50) },
  { id: 'cone',         name: '피라미드',  icon: '🔺', geo: () => new THREE.ConeGeometry(2.2, 4, 5) },
  { id: 'box',          name: '큐브',      icon: '🔲', geo: () => new THREE.BoxGeometry(3.5, 3.5, 3.5) },
  { id: 'text',         name: '텍스트',    icon: '✨', geo: null },
];

let _selectedCoreSkin = localStorage.getItem('orbitCoreSkin') || 'sphere';
let _coreVisible       = localStorage.getItem('orbitCoreVisible') !== '0';
let _coreMeshRef       = null;
let _coreGlowRef       = null;

function buildCoreMesh() {
  // 씬에서 isCore 플래그가 있는 모든 기존 코어 제거
  scene.children.filter(c => c.userData && c.userData.isCore).forEach(c => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) { if (c.material.dispose) c.material.dispose(); }
    scene.remove(c);
  });
  // 원점 근처(거리 10 이내)의 모든 Mesh도 강제 제거 (캐시된 태양 잔재물)
  scene.children.filter(c => c.isMesh && c.position.length() < 10).forEach(c => {
    if (c.geometry) c.geometry.dispose();
    if (c.material) { if (c.material.dispose) c.material.dispose(); }
    scene.remove(c);
  });
  _coreMeshRef = null;
  _coreGlowRef = null;
}
window.buildCoreMesh = buildCoreMesh;

function toggleCoreSkinPanel() {
  // 통합 패널의 🌍 스킨 탭으로 이동
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    switchUpTab('skin', document.querySelector('.up-tab[data-tab="skin"]'));
  }
  renderCoreSkinGrid();
}
window.toggleCoreSkinPanel = toggleCoreSkinPanel;

function renderCoreSkinGrid() {
  const grid = document.getElementById('csp-grid');
  if (!grid) return;
  grid.innerHTML = CORE_SKINS.map(s => `
    <div class="csp-item ${s.id === _selectedCoreSkin ? 'active' : ''}" onclick="applyCoreSkin('${s.id}')">
      <div class="csp-icon">${s.icon}</div>
      <div class="csp-name">${s.name}</div>
    </div>
  `).join('');

  const btn = document.getElementById('csp-visibility-btn');
  if (btn) {
    btn.textContent = _coreVisible ? '숨기기' : '표시하기';
    btn.classList.toggle('hide', _coreVisible);
  }
}

function applyCoreSkin(skinId) {
  _selectedCoreSkin = skinId;
  localStorage.setItem('orbitCoreSkin', skinId);
  buildCoreMesh();
  renderCoreSkinGrid();
  if (typeof track === 'function') track('node.effect_apply', { effect: 'skin_' + skinId });
  const skin = CORE_SKINS.find(s => s.id === skinId);
  showApplyEffect(`행성 스킨 적용: ${skin?.icon || ''} ${skin?.name || skinId}`);
}
window.applyCoreSkin = applyCoreSkin;

function toggleCoreVisibility() {
  _coreVisible = !_coreVisible;
  localStorage.setItem('orbitCoreVisible', _coreVisible ? '1' : '0');
  buildCoreMesh();
  renderCoreSkinGrid();
}
window.toggleCoreVisibility = toggleCoreVisibility;

// ══ 간단 토스트 (범용) ═══════════════════════════════════════════════════════
let _toastTimer = null;
function showToast(msg, duration = 3000) {
  let el = document.getElementById('_simple-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '_simple-toast';
    el.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:rgba(13,17,23,.97);border:1px solid #30363d;border-radius:10px;
      padding:10px 18px;font-size:13px;color:#cdd9e5;z-index:9999;
      pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap;
      box-shadow:0 8px 24px rgba(0,0,0,.5);
    `;
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, duration);
}
window.showToast = showToast;

// ══ 팝업 공통 헬퍼 ═══════════════════════════════════════════════════════════
function closePopup(id) { const el = document.getElementById(id); if (el) el.style.display = 'none'; }
window.closePopup = closePopup;
/* ── 적용 시각 피드백 ────────────────────────────────────────────────────────
 * showApplyEffect(msg, color?)
 *   - 캔버스 플래시 (파란 rimlight)
 *   - 하단 토스트 메시지 (무엇이 적용됐는지)
 * ─────────────────────────────────────────────────────────────────────────── */
let _applyToastTimer = null;

function showApplyEffect(msg, color) {
  // 1. 캔버스 플래시
  const flash = document.getElementById('apply-flash');
  if (flash) {
    flash.classList.remove('flash');
    void flash.offsetWidth; // reflow
    if (color) flash.style.setProperty('--flash-color', color);
    flash.classList.add('flash');
    setTimeout(() => flash.classList.remove('flash'), 600);
  }

  // 2. 토스트
  const toast   = document.getElementById('apply-toast');
  const toastMsg = document.getElementById('apply-toast-msg');
  if (toast && toastMsg) {
    toastMsg.textContent = msg;
    toast.classList.add('show');
    clearTimeout(_applyToastTimer);
    _applyToastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }
}
window.showApplyEffect = showApplyEffect;
