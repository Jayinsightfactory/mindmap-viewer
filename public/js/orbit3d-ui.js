// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — UI panels (alias, zoom, filters, minimap, login, profile, chat, follow, analytics)
// ══════════════════════════════════════════════════════════════════════════════
// ── 노드 별명 (공개명 / 내 표시명) 시스템 ──────────────────────────────────
// _nodeAliases: { originalLabel → displayAlias }  (사용자가 지정한 내 표시 이름)
const _nodeAliases = JSON.parse(localStorage.getItem('orbitNodeAliases') || '{}');

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

// ── 솔루션 제안 토스트 ──────────────────────────────────────────────────────
let _currentSuggestionId = null;

function showSuggestion(suggestion) {
  _currentSuggestionId = suggestion.id;
  document.getElementById('st-body').innerHTML = `
    <b style="color:#cdd9e5">${suggestion.pattern}</b><br>
    <span style="color:#58a6ff">💡 ${suggestion.suggestion}</span>
    ${suggestion.automatable ? '<br><span style="color:#3fb950;font-size:10px">⚡ 자동화 가능</span>' : ''}
  `;
  document.getElementById('suggestion-toast').classList.add('visible');
}

function dismissSuggestion() {
  document.getElementById('suggestion-toast').classList.remove('visible');
  if (_currentSuggestionId) {
    fetch(`/api/learn/seen/${_currentSuggestionId}`, { method: 'POST' }).catch(() => {});
  }
}

function acceptSuggestion() {
  dismissSuggestion();
  // 기능 패널 열기 (솔루션 마켓으로 연결)
  document.getElementById('feat-btn')?.click();
}

window.dismissSuggestion = dismissSuggestion;
window.acceptSuggestion  = acceptSuggestion;

// 주기적으로 새 제안 확인 (30초마다)
setInterval(async () => {
  try {
    const res = await fetch('/api/learn/suggestions');
    if (!res.ok) return;
    const list = await res.json();
    const unseen = list.find(s => !s.seen);
    if (unseen && !document.getElementById('suggestion-toast').classList.contains('visible')) {
      showSuggestion(unseen);
    }
  } catch {}
}, 30000);

// ── 동의 모달 ────────────────────────────────────────────────────────────────
function consentDecide(allow) {
  localStorage.setItem('orbitConsentDecided', '1');
  localStorage.setItem('orbitTrackingAllowed', allow ? '1' : '0');
  document.getElementById('consent-modal').classList.remove('visible');
  if (allow) {
    console.log('[Orbit] 자동 트래킹 허용됨');
  }
}
window.consentDecide = consentDecide;

// 첫 방문 시 동의 모달 표시 (3초 후)
if (!localStorage.getItem('orbitConsentDecided')) {
  setTimeout(() => {
    document.getElementById('consent-modal').classList.add('visible');
  }, 3000);
}

// ── 줌 버튼 ──────────────────────────────────────────────────────────────────
function zoomStep(dir) {
  // dir: -1 = 줌인(r 감소), +1 = 줌아웃(r 증가)
  const cur  = controls.sph.r;
  const step = cur < 40 ? 5 : cur < 100 ? 10 : 20;
  const next = Math.max(8, Math.min(300, cur + dir * step));
  // controls.tgt 가 실제 look-at 타겟 오브젝트
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
const _viewPrefs = JSON.parse(localStorage.getItem(_VP_KEY) || 'null') || {
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

// ── 로그인 모달 ──────────────────────────────────────────────────────────────
let _orbitUser = JSON.parse(localStorage.getItem('orbitUser') || 'null');

function openLoginModal() {
  document.getElementById('login-modal-overlay').classList.add('open');
  renderLoginState();
}
window.openLoginModal = openLoginModal;

function closeLoginModal() {
  document.getElementById('login-modal-overlay').classList.remove('open');
}
window.closeLoginModal = closeLoginModal;

function handleOverlayClick(e) {
  if (e.target === document.getElementById('login-modal-overlay')) closeLoginModal();
}
window.handleOverlayClick = handleOverlayClick;

function renderLoginState() {
  const authView    = document.getElementById('lm-auth-view');
  const profileView = document.getElementById('lm-profile-view');
  const btn         = document.getElementById('login-btn');
  if (_orbitUser) {
    authView.style.display    = 'none';
    profileView.style.display = 'flex';
    profileView.style.flexDirection = 'column';
    profileView.style.gap = '14px';
    document.getElementById('lm-name').textContent       = _orbitUser.name || '사용자';
    document.getElementById('lm-email-disp').textContent = _orbitUser.email || '';
    const av = document.getElementById('lm-av');
    if (_orbitUser.avatar) {
      av.innerHTML = `<img src="${_orbitUser.avatar}" alt="">`;
    } else {
      av.textContent = (_orbitUser.name || '?')[0].toUpperCase();
    }
    btn.textContent = `👤 ${_orbitUser.name || '내 계정'}`;
    btn.classList.add('logged-in');
    // 사이드바 프로필 업데이트
    const lnAv = document.getElementById('ln-avatar-box');
    const lnName = document.getElementById('ln-username');
    const lnEmail = document.getElementById('ln-useremail');
    const lnAuthBtn = document.getElementById('ln-auth-btn');
    const lnLogout = document.getElementById('ln-logout-btn');
    if (lnAv) {
      if (_orbitUser.avatar) lnAv.innerHTML = `<img src="${_orbitUser.avatar}" alt="">`;
      else lnAv.textContent = (_orbitUser.name || '?')[0].toUpperCase();
    }
    if (lnName) lnName.textContent = _orbitUser.name || '사용자';
    if (lnEmail) lnEmail.textContent = _orbitUser.email || '';
    if (lnAuthBtn) lnAuthBtn.style.display = 'none';
    if (lnLogout) lnLogout.style.display = 'flex';
    // 팔로잉 버튼 표시
    const lnFollowingBtn = document.getElementById('ln-following-btn');
    if (lnFollowingBtn) lnFollowingBtn.style.display = 'flex';
    // 프로필 체크 (비동기)
    setTimeout(checkAndPromptProfile, 800);
    // DM 미읽음 폴링 즉시 시작
    setTimeout(_pollUnreadDMs, 500);
  } else {
    // 로그아웃 시 프로필 카드 + 팔로잉 버튼 숨기기
    const pCard = document.getElementById('ln-profile-card');
    if (pCard) pCard.classList.remove('show');
    const lnFollowingBtn = document.getElementById('ln-following-btn');
    if (lnFollowingBtn) lnFollowingBtn.style.display = 'none';
    authView.style.display = 'flex';
    authView.style.flexDirection = 'column';
    authView.style.gap = '10px';
    profileView.style.display = 'none';
    btn.textContent = '🔑 로그인';
    btn.classList.remove('logged-in');
    // 사이드바 프로필 초기화
    const lnAv2 = document.getElementById('ln-avatar-box');
    const lnName2 = document.getElementById('ln-username');
    const lnEmail2 = document.getElementById('ln-useremail');
    const lnAuthBtn2 = document.getElementById('ln-auth-btn');
    const lnLogout2 = document.getElementById('ln-logout-btn');
    if (lnAv2) lnAv2.textContent = '?';
    if (lnName2) lnName2.textContent = '게스트';
    if (lnEmail2) lnEmail2.textContent = '';
    if (lnAuthBtn2) lnAuthBtn2.style.display = 'block';
    if (lnLogout2) lnLogout2.style.display = 'none';
  }
  // Google OAuth 버튼 활성/비활성
  fetch('/api/auth/oauth/status').then(r => r.json()).then(data => {
    const gBtn = document.getElementById('lm-google-btn');
    if (gBtn && !data.google) {
      gBtn.classList.add('disabled');
      gBtn.title = 'Google OAuth 환경변수 미설정 (관리자 문의)';
      gBtn.onclick = null;
    }
  }).catch(() => {});
}

function oauthLogin(provider) {
  if (typeof track === 'function') track('auth.login', { provider });
  window.location.href = `/api/auth/${provider}`;
}
window.oauthLogin = oauthLogin;

function showLoginError(msg) {
  const el = document.getElementById('lm-error');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function doEmailLogin() {
  const email = document.getElementById('lm-email').value.trim();
  const pw    = document.getElementById('lm-pw').value;
  if (!email || !pw) { showLoginError('이메일과 비밀번호를 입력하세요'); return; }
  try {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password: pw })
    });
    const d = await r.json();
    if (!r.ok) { showLoginError(d.error || '로그인 실패'); return; }
    const u = d.user || d;                                                       // auth API 응답 형식 호환 (user 객체 또는 플랫)
    _orbitUser = { id: u.id || d.id, name: u.name || d.name, email: u.email || d.email, avatar: u.avatar || d.avatar || null, plan: u.plan || 'free', token: d.token }; // id·plan 포함
    localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
    localStorage.setItem('orbit_token', d.token);                              // 토큰 저장 (API 인증용)
    // claim + Drive 동기화 + 데이터 새로고침 (OAuth 로그인과 동일 흐름)
    if (typeof _postLoginSync === 'function') _postLoginSync(d.token);
    if (typeof track === 'function') track('auth.login', { provider: 'email' });
    renderLoginState();
    setTimeout(closeLoginModal, 800);
  } catch { showLoginError('서버 연결 오류'); }
}
window.doEmailLogin = doEmailLogin;

async function doRegister() {
  const name  = document.getElementById('lm-reg-name').value.trim();
  const email = document.getElementById('lm-reg-email').value.trim();
  const pw    = document.getElementById('lm-reg-pw').value;
  if (!name || !email || !pw) { showLoginError('모든 항목을 입력하세요'); return; }
  try {
    const r = await fetch('/api/auth/register', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, email, password: pw })
    });
    const d = await r.json();
    if (!r.ok) { showLoginError(d.error || '회원가입 실패'); return; }
    const ru = d.user || d;                                                      // auth API 응답 형식 호환
    _orbitUser = { id: ru.id || d.id, name: ru.name || name, email, avatar: null, plan: ru.plan || 'free', token: d.token }; // id·plan 포함
    localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
    localStorage.setItem('orbit_token', d.token);                              // 토큰 저장 (API 인증용)
    if (typeof _postLoginSync === 'function') _postLoginSync(d.token);         // claim + Drive 동기화
    if (typeof track === 'function') track('auth.register', { provider: 'email' });
    renderLoginState();
    setTimeout(closeLoginModal, 800);
  } catch { showLoginError('서버 연결 오류'); }
}
window.doRegister = doRegister;

function toggleRegister() {
  const emailForm    = document.getElementById('lm-email-form');
  const registerForm = document.getElementById('lm-register-form');
  const isEmail      = emailForm.style.display !== 'none';
  emailForm.style.display    = isEmail ? 'none' : 'flex';
  registerForm.style.display = isEmail ? 'flex' : 'none';
  document.getElementById('lm-error').style.display = 'none';
}
window.toggleRegister = toggleRegister;

function doLogoutMain() {
  if (typeof track === 'function') track('auth.logout');
  _orbitUser = null;
  localStorage.removeItem('orbitUser');
  localStorage.removeItem('orbit_token');                                      // 토큰 제거
  renderLoginState();
  closeLoginModal();
  if (typeof loadData === 'function') loadData();                              // 빈 화면으로 새로고침
}
window.doLogoutMain = doLogoutMain;

// OAuth 콜백: Google/GitHub 리디렉션 후 URL 파라미터로 토큰 전달
(function handleOAuthCallback() {
  const params     = new URLSearchParams(window.location.search);
  const oauthToken = params.get('oauth_token');
  const provider   = params.get('provider');
  const oauthError = params.get('oauth_error');
  if (oauthError) {
    window.history.replaceState({}, '', window.location.pathname);
    // 모달 열고 에러 표시
    setTimeout(() => { openLoginModal(); showLoginError(`${provider || 'OAuth'} 로그인 실패`); }, 300);
    renderLoginState();
    return;
  }
  if (oauthToken) {
    // 토큰으로 내 정보 가져오기
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${oauthToken}` } })
      .then(r => r.json())
      .then(d => {
        _orbitUser = { id: d.id || d.user?.id, name: d.name || d.user?.name || '사용자', email: d.email || d.user?.email || '', avatar: d.avatar || d.user?.avatar || null, plan: d.plan || d.user?.plan || 'free', token: oauthToken }; // OAuth 로그인 시 id·plan 포함
        localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
        window.history.replaceState({}, '', window.location.pathname);
        renderLoginState();
        // ★ 기존 local 이벤트를 내 계정으로 자동 귀속 + 토큰 저장
        _postLoginSync(oauthToken);
      })
      .catch(() => {
        _orbitUser = { id: null, name: provider || '사용자', email: '', avatar: null, plan: 'free', token: oauthToken }; // 폴백: id 없이 기본 free 플랜
        localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
        window.history.replaceState({}, '', window.location.pathname);
        renderLoginState();
        _postLoginSync(oauthToken);
      });
    return;
  }
  renderLoginState();
  // 로그인 안 된 상태로 진입 시 모달 자동 오픈 (1.2초 후 — 3D 씬 로드 이후)
  if (!_orbitUser) {
    setTimeout(() => {
      if (!_orbitUser) openLoginModal();
    }, 1200);
  }
})();

// ── URL ?demo=team|company|parallel 자동 로드 ─────────────────────────────
(function handleDemoParam() {
  const demo = new URLSearchParams(window.location.search).get('demo');
  if (!demo) return;
  // URL에서 파라미터 제거 (히스토리 오염 방지)
  window.history.replaceState({}, '', window.location.pathname);
  const delay = 1800; // 3D 씬 초기화 이후 실행
  if (demo === 'team')     setTimeout(() => { if (typeof loadTeamDemo    === 'function') loadTeamDemo(); },    delay);
  if (demo === 'company')  setTimeout(() => { if (typeof loadCompanyDemo  === 'function') loadCompanyDemo(); },  delay);
  if (demo === 'parallel') setTimeout(() => { if (typeof loadParallelDemo === 'function') loadParallelDemo(); }, delay);
})();

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
  if (typeof _teamMode !== 'undefined' && (_teamMode || _companyMode)) exitTeamMode();
  if (typeof _parallelMode !== 'undefined' && _parallelMode) exitParallelMode();
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

    // ── 자동 뷰 전환 → 취소 가능 확인 토스트로 교체 ──
    const prevR = _lastLodR;
    _lastLodR = r;

    if (inPersonal && r > 155 && prevR <= 155) {
      clearTimeout(_zoomLodTimer);
      _zoomLodTimer = setTimeout(() => {
        if (controls.sph.r > 145 && !(typeof _teamMode !== 'undefined' && _teamMode)) {
          showSwitchToast('👥 팀 화면으로 전환할까요?', () => loadTeamDemo());
        }
      }, 1800);
    } else if (inPersonal && r <= 145) {
      clearTimeout(_zoomLodTimer);
      dismissSwitchToast();
    }
    if (inTeam && r > 100 && prevR <= 100) {
      clearTimeout(_zoomLodTimer);
      _zoomLodTimer = setTimeout(() => {
        if (controls.sph.r > 95 && (typeof _teamMode !== 'undefined' && _teamMode)) {
          showSwitchToast('🏢 전사 화면으로 전환할까요?', () => loadCompanyDemo());
        }
      }, 1800);
    } else if (inTeam && r <= 90) {
      clearTimeout(_zoomLodTimer);
      dismissSwitchToast();
    }
    if (inCompany && r < 75 && prevR >= 75) {
      clearTimeout(_zoomLodTimer);
      _zoomLodTimer = setTimeout(() => {
        if (controls.sph.r < 80 && (typeof _companyMode !== 'undefined' && _companyMode)) {
          showSwitchToast('👥 팀 화면으로 돌아갈까요?', () => { exitTeamMode(); setTimeout(loadTeamDemo, 100); });
        }
      }, 1800);
    } else if (inCompany && r >= 80) {
      clearTimeout(_zoomLodTimer);
      dismissSwitchToast();
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
  _coreMeshRef = null;
  _coreGlowRef = null;

  if (typeof _teamMode !== 'undefined' && (_teamMode || _companyMode || _parallelMode)) return;
  if (!_coreVisible) return;

  // ── 고화질 태양 셰이더 (텍스처 + FBM 오버레이) ──────────────────────
  const sunTex = new THREE.TextureLoader().load('/textures/sun_2k.jpg');
  sunTex.wrapS = sunTex.wrapT = THREE.RepeatWrapping;

  const sunVertexShader = `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec3 vWorldPos;
    void main() {
      vUv = uv;
      vNormal = normalize(normalMatrix * normal);
      vPosition = position;
      vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  const sunFragmentShader = `
    uniform float uTime;
    uniform sampler2D uSunTexture;
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec3 vWorldPos;

    // simplex noise helpers
    vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
    vec4 mod289(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
    vec4 perm(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
    float noise(vec3 p){
      vec3 a = floor(p);
      vec3 d = p - a;
      d = d*d*(3.0-2.0*d);
      vec4 b = a.xxyy + vec4(0.0,1.0,0.0,1.0);
      vec4 k1 = perm(b.xyxy);
      vec4 k2 = perm(k1.xyxy + b.zzww);
      vec4 c = k2 + a.zzzz;
      vec4 k3 = perm(c);
      vec4 k4 = perm(c + 1.0);
      vec4 o1 = fract(k3*(1.0/41.0));
      vec4 o2 = fract(k4*(1.0/41.0));
      vec4 o3 = o2*d.z + o1*(1.0-d.z);
      vec2 o4 = o3.yw*d.x + o3.xz*(1.0-d.x);
      return o4.y*d.y + o4.x*(1.0-d.y);
    }

    float fbm(vec3 p) {
      float f = 0.0;
      f += 0.5000 * noise(p); p *= 2.02;
      f += 0.2500 * noise(p); p *= 2.03;
      f += 0.1250 * noise(p); p *= 2.01;
      f += 0.0625 * noise(p);
      return f / 0.9375;
    }

    void main() {
      // UV 천천히 회전 (태양 자전 효과)
      float rot = uTime * 0.02;
      vec2 rotUv = vec2(
        vUv.x + rot,
        vUv.y
      );
      vec3 texCol = texture2D(uSunTexture, rotUv).rgb;

      // FBM 노이즈 오버레이 (발광 강조)
      vec3 pos = vPosition * 0.8;
      float t = uTime * 0.4;
      float n1 = fbm(pos + vec3(t * 0.3, t * 0.1, t * 0.2));
      float n2 = fbm(pos * 2.0 + vec3(t * 0.5, -t * 0.3, t * 0.1));
      float fire = n1 * 0.6 + n2 * 0.4;

      // 태양 색상 — 밝고 깨끗한 골드/화이트 (마그마 X)
      vec3 gold  = vec3(1.0, 0.85, 0.4);
      vec3 white = vec3(1.0, 0.95, 0.85);
      vec3 fbmCol = mix(gold, white, fire);

      // 텍스처 + FBM 블렌딩 (텍스처 50% + FBM 50% — 깔끔한 발광)
      vec3 col = texCol * 0.4 + fbmCol * 0.6;

      // 가장자리 림 — 부드럽고 밝은 글로우
      vec3 viewDir = normalize(cameraPosition - vWorldPos);
      float rim = 1.0 - max(dot(vNormal, viewDir), 0.0);
      rim = pow(rim, 3.0);
      col += vec3(1.0, 0.9, 0.6) * rim * 0.5;

      // 밝기 — 전체적으로 밝고 균일
      float brightness = 1.5 + fire * 0.2;
      col *= brightness;

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const sunUniforms = { uTime: { value: 0 }, uSunTexture: { value: sunTex } };
  const sunMat = new THREE.ShaderMaterial({
    vertexShader: sunVertexShader,
    fragmentShader: sunFragmentShader,
    uniforms: sunUniforms,
  });

  _coreMeshRef = new THREE.Mesh(new THREE.SphereGeometry(3.5, 64, 64), sunMat);
  _coreMeshRef.userData.isCore = true;
  _coreMeshRef.userData.sunUniforms = sunUniforms;
  scene.add(_coreMeshRef);

  // 외곽 글로우 — 아주 미세한 소프트 글로우만 (큰 노란 코로나 제거)
  const coronaMat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        float intensity = pow(0.55 - dot(vNormal, viewDir), 4.0);
        vec3 col = vec3(1.0, 0.92, 0.7) * intensity * 1.2;
        gl_FragColor = vec4(col, intensity * 0.3);
      }
    `,
    uniforms: {},
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  _coreGlowRef = new THREE.Mesh(new THREE.SphereGeometry(4.5, 32, 32), coronaMat);
  _coreGlowRef.userData.isCore = true;
  scene.add(_coreGlowRef);
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

/* ══════════════════════════════════════════════════════════════════════════
 * PROFILE SYSTEM — LinkedIn 수준 프로필 등록/편집
 * ══════════════════════════════════════════════════════════════════════════ */

let _profileData     = null;   // 현재 로드된 프로필
let _profileSkills   = [];
let _profileExps     = [];
let _profileEdus     = [];

// ── 로그인 후 프로필 체크 ────────────────────────────────────────────────
async function checkAndPromptProfile() {
  if (!_orbitUser) return;
  const token = _orbitUser.token || localStorage.getItem('orbitToken');
  if (!token) return;

  // 7일 내 이미 스킵했으면 표시 안 함
  const skipped = parseInt(localStorage.getItem('profileSkippedAt') || '0');
  if (Date.now() - skipped < 7 * 24 * 3600 * 1000) return;

  try {
    const res  = await fetch('/api/profile/check', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.exists) {
      setTimeout(() => {
        document.getElementById('profile-prompt-modal').classList.add('open');
      }, 1500);
    } else {
      // 프로필 있으면 사이드바 카드 업데이트
      loadProfileForSidebar(token);
    }
  } catch (_) {}
}
window.checkAndPromptProfile = checkAndPromptProfile;

async function loadProfileForSidebar(token) {
  try {
    const res  = await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    _profileData = data;
    const card    = document.getElementById('ln-profile-card');
    const hl      = document.getElementById('ln-pc-headline');
    const company = document.getElementById('ln-pc-company');
    if (card) {
      if (hl) hl.textContent     = data.headline || '';
      if (company) company.textContent = data.company ? `🏢 ${data.company}` : '';
      if (data.headline || data.company) card.classList.add('show');
    }
  } catch (_) {}
}

function skipProfilePrompt() {
  localStorage.setItem('profileSkippedAt', Date.now().toString());
  document.getElementById('profile-prompt-modal').classList.remove('open');
}
window.skipProfilePrompt = skipProfilePrompt;

// ── 프로필 편집 모달 열기/닫기 ──────────────────────────────────────────
async function openProfileEditModal() {
  // 먼저 유도 모달 닫기
  document.getElementById('profile-prompt-modal').classList.remove('open');
  document.getElementById('profile-edit-modal').classList.add('open');

  // 기존 프로필 로드
  const token = _orbitUser?.token || localStorage.getItem('orbitToken');
  if (token) {
    try {
      const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        if (data) populateProfileForm(data);
      }
    } catch (_) {}
  }

  // 아바타 표시
  const av = document.getElementById('pem-avatar');
  if (av && _orbitUser) {
    if (_orbitUser.avatar) av.innerHTML = `<img src="${_orbitUser.avatar}" alt="">`;
    else av.textContent = (_orbitUser.name || '?')[0].toUpperCase();
  }
  // 이름 기본값
  const nameInput = document.getElementById('pem-name');
  if (nameInput && !nameInput.value && _orbitUser?.name) nameInput.value = _orbitUser.name;
}
window.openProfileEditModal = openProfileEditModal;

// ── 프로필 영역 클릭 핸들러 (좌측 네비) ────────────
function handleProfileAreaClick() {
  if (typeof _orbitUser !== 'undefined' && _orbitUser) {
    openProfileEditModal();
  } else {
    if (typeof openLoginModal === 'function') openLoginModal();
  }
}
window.handleProfileAreaClick = handleProfileAreaClick;

// ── 필터칩 표시 조건 (별자리 뷰에서는 숨김) ────────
function updateFilterBarVisibility() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  // focusedProject가 있을 때만 표시, 그 외 숨김
  const hasFocus = typeof _focusedProject !== 'undefined' && _focusedProject;
  bar.style.display = hasFocus ? 'flex' : 'none';
}
window.updateFilterBarVisibility = updateFilterBarVisibility;
// 초기에는 숨김
document.addEventListener('DOMContentLoaded', () => updateFilterBarVisibility());

function closeProfileEditModal() {
  document.getElementById('profile-edit-modal').classList.remove('open');
}
window.closeProfileEditModal = closeProfileEditModal;

function populateProfileForm(data) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('pem-name',     data.name);
  set('pem-headline', data.headline);
  set('pem-company',  data.company);
  set('pem-location', data.location);
  set('pem-bio',      data.bio);
  const links = typeof data.links === 'object' ? data.links : {};
  set('pem-github',   links.github);
  set('pem-linkedin', links.linkedin);
  set('pem-website',  links.website);
  set('pem-twitter',  links.twitter);
  const pub = document.getElementById('pem-public');
  if (pub) pub.checked = data.is_public !== 0;

  // 스킬
  _profileSkills = Array.isArray(data.skills) ? [...data.skills] : [];
  renderSkillTags();

  // 경력
  _profileExps = Array.isArray(data.experiences) ? [...data.experiences] : [];
  renderExpCards();

  // 학력
  _profileEdus = Array.isArray(data.education) ? [...data.education] : [];
  renderEduCards();
}

// ── 스킬 태그 ────────────────────────────────────────────────────────────
function renderSkillTags() {
  const box = document.getElementById('pem-skills-tags');
  if (!box) return;
  box.innerHTML = _profileSkills.map((s, i) => `
    <span class="pem-tag">${s}<span class="pem-tag-x" onclick="removeSkillTag(${i})">✕</span></span>
  `).join('');
}

function addSkillTag() {
  const inp = document.getElementById('pem-skill-input');
  if (!inp) return;
  const val = inp.value.trim();
  if (val && !_profileSkills.includes(val) && _profileSkills.length < 50) {
    _profileSkills.push(val);
    renderSkillTags();
    inp.value = '';
  }
  inp.focus();
}
window.addSkillTag = addSkillTag;

function removeSkillTag(idx) {
  _profileSkills.splice(idx, 1);
  renderSkillTags();
}
window.removeSkillTag = removeSkillTag;

// ── 경력 카드 ────────────────────────────────────────────────────────────
function renderExpCards() {
  const list = document.getElementById('pem-exp-list');
  if (!list) return;
  list.innerHTML = _profileExps.map((e, i) => `
    <div class="pem-card">
      <div class="pem-card-header">
        <span style="font-size:12px;color:#58a6ff;font-weight:600">💼 경력 ${i + 1}</span>
        <button class="pem-card-del" onclick="removeExpCard(${i})">🗑</button>
      </div>
      <div class="pem-row-2">
        <input class="pem-input" placeholder="회사명" value="${e.company||''}"
          oninput="_profileExps[${i}].company=this.value" />
        <input class="pem-input" placeholder="직책/역할" value="${e.role||''}"
          oninput="_profileExps[${i}].role=this.value" />
      </div>
      <input class="pem-input" placeholder="기간  예: 2022.03 – 현재" value="${e.period||''}"
        oninput="_profileExps[${i}].period=this.value" />
      <textarea class="pem-textarea" placeholder="주요 업무/성과" style="min-height:60px"
        oninput="_profileExps[${i}].desc=this.value">${e.desc||''}</textarea>
    </div>
  `).join('');
}

function addExpCard() {
  _profileExps.push({ company: '', role: '', period: '', desc: '' });
  renderExpCards();
}
window.addExpCard = addExpCard;

function removeExpCard(idx) {
  _profileExps.splice(idx, 1);
  renderExpCards();
}
window.removeExpCard = removeExpCard;

// ── 학력 카드 ────────────────────────────────────────────────────────────
function renderEduCards() {
  const list = document.getElementById('pem-edu-list');
  if (!list) return;
  list.innerHTML = _profileEdus.map((e, i) => `
    <div class="pem-card">
      <div class="pem-card-header">
        <span style="font-size:12px;color:#3fb950;font-weight:600">🎓 학력 ${i + 1}</span>
        <button class="pem-card-del" onclick="removeEduCard(${i})">🗑</button>
      </div>
      <div class="pem-row-2">
        <input class="pem-input" placeholder="학교명" value="${e.school||''}"
          oninput="_profileEdus[${i}].school=this.value" />
        <input class="pem-input" placeholder="학위/전공" value="${e.degree||''}"
          oninput="_profileEdus[${i}].degree=this.value" />
      </div>
      <input class="pem-input" placeholder="기간  예: 2018 – 2022" value="${e.period||''}"
        oninput="_profileEdus[${i}].period=this.value" />
    </div>
  `).join('');
}

function addEduCard() {
  _profileEdus.push({ school: '', degree: '', period: '' });
  renderEduCards();
}
window.addEduCard = addEduCard;

function removeEduCard(idx) {
  _profileEdus.splice(idx, 1);
  renderEduCards();
}
window.removeEduCard = removeEduCard;

// ── 프로필 저장 ──────────────────────────────────────────────────────────
async function saveProfile() {
  const token = _orbitUser?.token || localStorage.getItem('orbitToken');
  if (!token) { alert('로그인이 필요합니다.'); return; }

  const get  = id => document.getElementById(id)?.value?.trim() || '';
  const name = get('pem-name');
  if (!name) { document.getElementById('pem-name').focus(); alert('이름을 입력해주세요.'); return; }

  const btn = document.querySelector('.pem-btn-save');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name,
        headline:    get('pem-headline'),
        company:     get('pem-company'),
        location:    get('pem-location'),
        bio:         get('pem-bio'),
        skills:      _profileSkills,
        experiences: _profileExps,
        education:   _profileEdus,
        links: {
          github:   get('pem-github'),
          linkedin: get('pem-linkedin'),
          website:  get('pem-website'),
          twitter:  get('pem-twitter'),
        },
        is_public: document.getElementById('pem-public')?.checked !== false,
      }),
    });

    if (res.ok) {
      closeProfileEditModal();
      // 사이드바 프로필 카드 업데이트
      const card    = document.getElementById('ln-profile-card');
      const hl      = document.getElementById('ln-pc-headline');
      const company = document.getElementById('ln-pc-company');
      if (hl)      hl.textContent      = get('pem-headline') || name;
      if (company) company.textContent = get('pem-company') ? `🏢 ${get('pem-company')}` : '';
      if (card && (get('pem-headline') || get('pem-company'))) card.classList.add('show');
      if (typeof track === 'function') track('node.edit', { type: 'profile' });
    } else {
      const err = await res.json().catch(() => ({}));
      alert('저장 실패: ' + (err.error || res.status));
    }
  } catch (e) {
    alert('저장 중 오류: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 프로필 저장'; }
  }
}
window.saveProfile = saveProfile;

/* ── 뷰 전환 확인 토스트 ────────────────────────────────────────────────────
 * showSwitchToast(msg, onConfirm) — 줌 LOD 임계값 도달 시 자동 전환 대신 사용자에게 물어봄
 * ─────────────────────────────────────────────────────────────────────────── */
let _switchToastCb = null;
let _switchToastTimer = null;

function showSwitchToast(msg, onConfirm) {
  _switchToastCb = onConfirm;
  const toast = document.getElementById('switch-toast');
  const msgEl = document.getElementById('sw-toast-msg');
  const yesBtn = document.getElementById('sw-toast-yes');
  if (!toast || !msgEl) return;
  msgEl.textContent = msg;
  yesBtn.onclick = () => { dismissSwitchToast(); if (_switchToastCb) _switchToastCb(); };
  toast.classList.add('show');
  // 8초 후 자동 닫기 (무시하면 사라짐)
  clearTimeout(_switchToastTimer);
  _switchToastTimer = setTimeout(dismissSwitchToast, 8000);
}
window.showSwitchToast = showSwitchToast;

function dismissSwitchToast() {
  clearTimeout(_switchToastTimer);
  _switchToastCb = null;
  document.getElementById('switch-toast')?.classList.remove('show');
}
window.dismissSwitchToast = dismissSwitchToast;

/* ══ MESSENGER ════════════════════════════════════════════════════════════════
 * 개인(DM) / 팀 / 회사 채팅 + @orbit AI 봇
 * ─────────────────────────────────────────────────────────────────────────── */
let _msgTab        = 'dm';       // 현재 탭
let _msgRoomId     = null;       // 현재 열린 방 ID
let _msgRoomName   = '';         // 현재 방 이름
let _msgWs         = null;       // WebSocket 참조 (전역 ws 재사용)
let _msgQuota      = null;       // 쿼터 캐시

function _msgToken() {
  return _orbitUser?.token || localStorage.getItem('orbitToken') || '';
}

// ── 패널 열기/닫기 ───────────────────────────────────────────────────────────
function toggleMessenger() {
  const panel = document.getElementById('messenger-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) {
    if (!_orbitUser) {
      document.getElementById('msg-rooms-list').innerHTML =
        '<div class="msg-empty-chat" style="font-size:11px;padding:16px">로그인이 필요합니다</div>';
      return;
    }
    loadMsgRooms(_msgTab);
    loadMsgQuota();
  }
}
window.toggleMessenger = toggleMessenger;

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

// ══ 가이드 팝업 ══════════════════════════════════════════════════════════════
function openGuidePopup() {
  document.getElementById('guide-popup').style.display = 'flex';

  // 로그인 상태에 따라 샘플 섹션 / 로그인 버튼 표시 제어
  const isLoggedIn = !!localStorage.getItem('orbit_token');
  const sampleSec = document.getElementById('guide-sample-section');
  const loginBtn  = document.getElementById('guide-login-btn');
  if (sampleSec) sampleSec.style.display = isLoggedIn ? 'none' : '';
  if (loginBtn)  loginBtn.style.display  = isLoggedIn ? 'none' : '';
}
window.openGuidePopup = openGuidePopup;

// ══ 통계 팝업 ═══════════════════════════════════════════════════════════════
async function openStatsPopup() {
  const popup = document.getElementById('stats-popup');
  popup.style.display = 'flex';
  // 서버에서 통계 가져오기
  try {
    const r = await fetch('/api/analysis/summary');
    const data = r.ok ? await r.json() : null;
    if (data) {
      document.getElementById('sc-sessions').textContent = data.totalSessions ?? '-';
      document.getElementById('sc-events').textContent   = data.totalEvents   ?? '-';
      document.getElementById('sc-today').textContent    = data.todaySessions ?? '-';
      // 작업 유형 분포
      const dist = data.distribution || [];
      const maxV = Math.max(...dist.map(d => d.count), 1);
      document.getElementById('stats-bar-list').innerHTML = dist.slice(0, 6).map(d => `
        <div class="stat-bar-row">
          <div class="stat-bar-label">${d.type || '기타'}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${Math.round(d.count/maxV*100)}%;background:${d.color||'#1f6feb'}"></div></div>
          <div style="font-size:11px;color:#8b949e;width:30px;text-align:right">${d.count}</div>
        </div>`).join('');
      // 최근 세션
      const sess = data.recentSessions || [];
      document.getElementById('stats-recent-sessions').innerHTML = sess.slice(0, 5).map(s =>
        `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d">
          <span style="color:#cdd9e5">${s.label || s.title || '세션'}</span>
          <span style="color:#484f58;font-size:10px">${s.ago || ''}</span>
        </div>`).join('');
    }
  } catch (e) {
    // 로컬 데이터로 폴백
    const planets = _planets || [];
    document.getElementById('sc-sessions').textContent = planets.length;
    document.getElementById('sc-events').textContent   = _allNodes?.length || 0;
    document.getElementById('sc-today').textContent    = planets.filter(p => {
      const ts = p.userData?.lastTs;
      return ts && (Date.now() - ts) < 86400000;
    }).length;
    document.getElementById('stats-bar-list').innerHTML =
      '<div style="font-size:11px;color:#6e7681;padding:8px 0">로컬 데이터 기준 (서버 연결 필요)</div>';
    document.getElementById('stats-recent-sessions').innerHTML = planets.slice(0, 5).map(p =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d">
        <span style="color:#cdd9e5">${p.userData?.intent || '세션'}</span>
        <span style="color:#58a6ff;font-size:10px">${p.userData?.satellites || 0}개 작업</span>
      </div>`).join('');
  }
}
window.openStatsPopup = openStatsPopup;

// ══ 워크스페이스 팝업 ════════════════════════════════════════════════════════
async function openWorkspacePopup() {
  if (!_orbitUser) { openLoginModal(); return; }
  const popup = document.getElementById('workspace-popup');
  popup.style.display = 'flex';
  document.getElementById('ws-create-result').style.display = 'none';
  await _loadMyWorkspaces();
}
window.openWorkspacePopup = openWorkspacePopup;

async function _loadMyWorkspaces() {
  const listEl = document.getElementById('ws-my-list');
  if (!listEl) return;
  const token = _orbitUser?.token || '';
  if (!token) { listEl.innerHTML = '<div style="font-size:12px;color:#6e7681">로그인이 필요합니다</div>'; return; }
  try {
    const res  = await fetch('/api/workspace/my', { headers: { Authorization: `Bearer ${token}` } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      listEl.innerHTML = '<div style="font-size:12px;color:#6e7681;padding:8px 0">참여한 워크스페이스가 없습니다.<br>아래에서 만들거나 초대코드로 참여하세요.</div>';
      return;
    }
    listEl.innerHTML = rows.map(ws => `
      <div class="ws-card" onclick="_selectWorkspace('${ws.id}','${(ws.name||'').replace(/'/g,"\\'")}')">
        <div class="ws-card-icon">${ws.role==='owner' ? '👑' : '👤'}</div>
        <div class="ws-card-info">
          <div class="ws-card-name">${escHtml(ws.name)}</div>
          <div class="ws-card-meta">${escHtml(ws.company_name||'')} · 멤버 ${ws.member_count||0}명</div>
          <div class="ws-card-role">${ws.role==='owner' ? '관리자' : '멤버 · '+escHtml(ws.team_name||'')}</div>
        </div>
        <div style="font-size:11px;color:#3fb950;cursor:pointer" onclick="event.stopPropagation();_copyCode('${ws.invite_code||''}')">
          ${ws.invite_code ? `초대코드<br><b style="font-size:14px;letter-spacing:2px">${ws.invite_code}</b>` : ''}
        </div>
      </div>`).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="font-size:11px;color:#f85149">오류: ${e.message}</div>`;
  }
}

function _copyCode(code) {
  navigator.clipboard.writeText(code).then(() => showToast(`초대코드 복사됨: ${code}`)).catch(() => {});
}

function _selectWorkspace(id, name) {
  // 팀뷰로 전환 + 워크스페이스 팝업 닫기
  closePopup('workspace-popup');
  _currentWorkspaceId = id;
  showToast(`'${name}' 워크스페이스 선택됨`);
  loadTeamDemo();
}

async function joinWorkspacePopup() {
  const code     = (document.getElementById('ws-join-code')?.value || '').trim().toUpperCase();
  const teamName = (document.getElementById('ws-join-team')?.value || '').trim() || '팀 1';
  if (!code) { showToast('초대코드를 입력하세요'); return; }
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _orbitUser.token;
  try {
    const res  = await fetch('/api/workspace/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inviteCode: code, teamName }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`✅ '${data.workspace?.name}' 참여 완료!`);
      document.getElementById('ws-join-code').value = '';
      document.getElementById('ws-join-team').value = '';
      await _loadMyWorkspaces();
    } else {
      showToast(`❌ ${data.error || '참여 실패'}`);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.joinWorkspacePopup = joinWorkspacePopup;

async function createWorkspacePopup() {
  const name    = (document.getElementById('ws-create-name')?.value || '').trim();
  const company = (document.getElementById('ws-create-company')?.value || '').trim();
  if (!name) { showToast('워크스페이스 이름을 입력하세요'); return; }
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _orbitUser.token;
  try {
    const res  = await fetch('/api/workspace/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, companyName: company }),
    });
    const data = await res.json();
    if (res.ok) {
      const resultEl = document.getElementById('ws-create-result');
      document.getElementById('ws-invite-code-display').textContent = data.invite_code;
      resultEl.style.display = 'block';
      document.getElementById('ws-create-name').value = '';
      document.getElementById('ws-create-company').value = '';
      await _loadMyWorkspaces();
    } else {
      showToast(`❌ ${data.error || '생성 실패'}`);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.createWorkspacePopup = createWorkspacePopup;

function copyInviteCode() {
  const code = document.getElementById('ws-invite-code-display')?.textContent?.trim();
  if (!code || code === '----') return;
  navigator.clipboard.writeText(code).then(() => showToast(`초대코드 복사됨: ${code}`)).catch(() => {});
}
window.copyInviteCode = copyInviteCode;

// ══ DM 미읽음 폴링 ═══════════════════════════════════════════════════════════
let _dmUnreadCount = 0;
async function _pollUnreadDMs() {
  if (!_orbitUser) return;
  const token = _orbitUser.token;
  if (!token) return;
  try {
    const res = await fetch('/api/chat/rooms', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const rooms = await res.json();
    if (!Array.isArray(rooms)) return;
    const total = rooms.reduce((s, r) => s + (r.unread || 0), 0);
    const btn   = document.getElementById('ln-messenger-btn');
    if (!btn) return;
    // 기존 배지 제거 후 새로 추가
    btn.querySelectorAll('.ln-badge').forEach(el => el.remove());
    if (total > 0) {
      const badge = document.createElement('span');
      badge.className = 'ln-badge';
      badge.textContent = total > 99 ? '99+' : total;
      btn.appendChild(badge);
      _dmUnreadCount = total;
    } else {
      _dmUnreadCount = 0;
    }
  } catch (_) {}
}

// 30초마다 폴링 (로그인 시 즉시 + 주기적으로)
setInterval(_pollUnreadDMs, 30000);

// ── 탭 전환 ──────────────────────────────────────────────────────────────────
function switchMsgTab(tab) {
  _msgTab = tab;
  _msgRoomId = null;
  ['dm','team','company'].forEach(t => {
    document.getElementById('mt-' + t)?.classList.toggle('active', t === tab);
  });
  resetChatView();
  loadMsgRooms(tab);
  toggleCreateModal(false);
}
window.switchMsgTab = switchMsgTab;

function resetChatView() {
  document.getElementById('msg-chat-name').textContent = '채팅방 선택';
  document.getElementById('msg-messages-area').innerHTML =
    '<div class="msg-empty-chat"><span style="font-size:28px">💬</span><span>채팅방을 선택하세요</span><span style="font-size:10px;color:#484f58">@orbit — AI에게 질문 가능</span></div>';
  document.getElementById('msg-input-wrap').style.display = 'none';
}

// ── 방 목록 로드 ─────────────────────────────────────────────────────────────
async function loadMsgRooms(tab) {
  const listEl = document.getElementById('msg-rooms-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="msg-empty-chat" style="font-size:11px">불러오는 중…</div>';
  const token = _msgToken();
  if (!token) return;
  try {
    const res   = await fetch('/api/chat/rooms', { headers: { Authorization: `Bearer ${token}` } });
    const rooms = await res.json();
    if (!Array.isArray(rooms)) { listEl.innerHTML = '<div class="msg-empty-chat" style="font-size:11px">오류</div>'; return; }

    const filtered = rooms.filter(r => r.type === tab || (tab === 'dm' && r.type === 'dm'));

    let html = '';
    if (tab !== 'dm') {
      html += `<button class="msg-new-room-btn" onclick="toggleCreateModal(true)">+ 채널 만들기</button>`;
    }
    if (filtered.length === 0) {
      html += `<div class="msg-empty-chat" style="font-size:10px;padding:10px">${tab === 'dm' ? '팔로잉한 사람에게<br>DM을 보내보세요' : '채널이 없습니다'}</div>`;
    } else {
      html += filtered.map(room => {
        const name    = room.type === 'dm' ? (room.peerName || room.id) : (room.name || room.id);
        const preview = room.last_msg ? room.last_msg.slice(0, 22) + (room.last_msg.length > 22 ? '…' : '') : '';
        const unread  = room.unread > 0 ? `<span class="msg-unread">${room.unread}</span>` : '';
        return `<div class="msg-room-item${room.id === _msgRoomId ? ' active' : ''}" onclick="openMsgRoom('${room.id}','${name.replace(/'/g,"\\'")}')">
          ${unread}
          <div class="msg-room-name">${name}</div>
          ${preview ? `<div class="msg-room-preview">${preview}</div>` : ''}
        </div>`;
      }).join('');
    }
    listEl.innerHTML = html;

    // DM 탭에서 팔로잉 목록도 표시 (방이 없는 사람들)
    if (tab === 'dm') appendFollowingDmList(listEl, filtered);
  } catch (e) {
    listEl.innerHTML = `<div class="msg-empty-chat" style="font-size:10px">불러오기 실패</div>`;
  }
}
window.loadMsgRooms = loadMsgRooms;

// ── 팔로잉 목록 → DM 시작 버튼 ──────────────────────────────────────────────
async function appendFollowingDmList(listEl, existingRooms) {
  const token = _msgToken();
  if (!token) return;
  try {
    const res  = await fetch('/api/follow/list', { headers: { Authorization: `Bearer ${token}` } });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return;
    const existingPeers = new Set(existingRooms.map(r => r.peerName));
    const newOnes = list.filter(u => !existingPeers.has(u.name));
    if (newOnes.length === 0) return;
    const sep = document.createElement('div');
    sep.style.cssText = 'font-size:10px;color:#6e7681;padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.4px';
    sep.textContent = '팔로잉';
    listEl.appendChild(sep);
    newOnes.forEach(u => {
      const btn = document.createElement('div');
      btn.className = 'msg-room-item';
      btn.innerHTML = `<div class="msg-room-name">${u.name || '?'}</div><div class="msg-room-preview">${u.headline || ''}</div>`;
      btn.onclick = () => startDmWithUser(u.user_id, u.name);
      listEl.appendChild(btn);
    });
  } catch (_) {}
}

async function startDmWithUser(userId, name) {
  const token = _msgToken();
  if (!token) return;
  try {
    const res  = await fetch(`/api/chat/dm/${userId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.roomId) {
      loadMsgRooms('dm');
      openMsgRoom(data.roomId, data.peerName || name);
    }
  } catch (_) {}
}
window.startDmWithUser = startDmWithUser;

// ── 방 열기 + 메시지 로드 ────────────────────────────────────────────────────
async function openMsgRoom(roomId, name) {
  _msgRoomId   = roomId;
  _msgRoomName = name;

  document.querySelectorAll('.msg-room-item').forEach(el => el.classList.remove('active'));
  event?.currentTarget?.classList.add('active');

  document.getElementById('msg-chat-name').textContent = name;
  document.getElementById('msg-input-wrap').style.display = 'flex';
  document.getElementById('msg-messages-area').innerHTML =
    '<div class="msg-empty-chat" style="font-size:11px">불러오는 중…</div>';

  // WS 채팅 방 구독
  _subscribeWsChatRoom(roomId);

  // 메시지 로드
  const token = _msgToken();
  try {
    const res  = await fetch(`/api/chat/${roomId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
    const msgs = await res.json();
    renderMsgBubbles(Array.isArray(msgs) ? msgs : []);
    // 읽음 처리
    fetch(`/api/chat/${roomId}/read`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    // 방 목록 unread 배지 업데이트
    loadMsgRooms(_msgTab);
  } catch (_) {
    document.getElementById('msg-messages-area').innerHTML =
      '<div class="msg-empty-chat" style="font-size:11px">메시지를 불러올 수 없습니다</div>';
  }

  document.getElementById('msg-input')?.focus();
}
window.openMsgRoom = openMsgRoom;

// ── 버블 렌더링 ───────────────────────────────────────────────────────────────
function renderMsgBubbles(msgs) {
  const area = document.getElementById('msg-messages-area');
  if (!area) return;
  if (!msgs.length) {
    area.innerHTML = '<div class="msg-empty-chat"><span>대화를 시작해보세요</span><span style="font-size:10px;color:#484f58">@orbit 으로 AI에게 질문할 수 있어요</span></div>';
    return;
  }
  const myId = _orbitUser?.id || '';
  area.innerHTML = msgs.map(m => {
    const isMine = m.sender_id === myId;
    const isBot  = m.sender_id === 'orbit-bot' || m.type === 'ai';
    const cls    = isBot ? 'ai-bot' : isMine ? 'mine' : 'theirs';
    const time   = m.created_at ? new Date(m.created_at).toLocaleTimeString('ko', { hour:'2-digit', minute:'2-digit' }) : '';
    const metaHtml = !isMine ? `<div class="msg-meta">${m.sender_name || '?'}</div>` : '';
    return `${metaHtml}<div class="msg-bubble ${cls}">${escapeHtml(m.content)}<div class="msg-time">${time}</div></div>`;
  }).join('');
  area.scrollTop = area.scrollHeight;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ── 메시지 전송 ───────────────────────────────────────────────────────────────
async function sendChatMsg() {
  if (!_msgRoomId) return;
  const input   = document.getElementById('msg-input');
  const content = (input?.value || '').trim();
  if (!content) return;
  input.value = '';

  const token = _msgToken();
  if (!token) { openLoginModal(); return; }

  // 낙관적 UI: 즉시 버블 추가
  const area = document.getElementById('msg-messages-area');
  const tmpId = 'tmp_' + Date.now();
  const time  = new Date().toLocaleTimeString('ko', { hour:'2-digit', minute:'2-digit' });
  const tmpEl = document.createElement('div');
  tmpEl.id = tmpId;
  tmpEl.innerHTML = `<div class="msg-bubble mine" style="opacity:.6">${escapeHtml(content)}<div class="msg-time">${time}</div></div>`;
  // AI 로딩 표시
  let aiLoadingEl = null;
  if (content.includes('@orbit') || content.startsWith('/ai ')) {
    aiLoadingEl = document.createElement('div');
    aiLoadingEl.id = 'ai-loading-msg';
    aiLoadingEl.innerHTML = `<div class="msg-bubble ai-bot" style="opacity:.7">🤖 Orbit AI 응답 중…</div>`;
  }

  // 빈 상태 제거
  const empty = area.querySelector('.msg-empty-chat');
  if (empty) empty.remove();
  area.appendChild(tmpEl);
  if (aiLoadingEl) area.appendChild(aiLoadingEl);
  area.scrollTop = area.scrollHeight;

  try {
    const res  = await fetch(`/api/chat/${_msgRoomId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();

    if (res.status === 402) {
      // 한도 초과
      tmpEl.remove();
      if (aiLoadingEl) aiLoadingEl.remove();
      showApplyEffect('⚠️ ' + (data.message || '메시지 한도 초과'));
      document.getElementById('msg-quota-wrap').style.display = 'block';
      return;
    }

    // 낙관적 버블 실제 버블로 교체
    if (tmpEl && data.id) {
      tmpEl.querySelector('.msg-bubble')?.style.removeProperty('opacity');
    }
    loadMsgQuota();
  } catch (e) {
    tmpEl.querySelector('.msg-bubble')?.setAttribute('style', 'opacity:.4;text-decoration:line-through');
  }
}
window.sendChatMsg = sendChatMsg;

// ── 쿼터 로드 ─────────────────────────────────────────────────────────────────
async function loadMsgQuota() {
  const token = _msgToken();
  if (!token) return;
  try {
    const res   = await fetch('/api/chat/quota', { headers: { Authorization: `Bearer ${token}` } });
    const quota = await res.json();
    _msgQuota = quota;
    const wrapEl = document.getElementById('msg-quota-wrap');
    if (!wrapEl || quota.limit === null) return; // unlimited plan

    if (quota.percent >= 70) { // 70% 이상이면 표시
      wrapEl.style.display = 'block';
      document.getElementById('msg-quota-text').textContent = `${quota.count} / ${quota.limit}개 (${quota.percent}%)`;
      const fillEl = document.getElementById('msg-quota-fill');
      fillEl.style.width = quota.percent + '%';
      fillEl.classList.toggle('warn', quota.percent >= 90);
    }
  } catch (_) {}
}

// ── 채널 생성 모달 토글 ───────────────────────────────────────────────────────
function toggleCreateModal(show) {
  document.getElementById('msg-create-modal')?.classList.toggle('open', show);
  if (show) document.getElementById('msg-create-name')?.focus();
}
window.toggleCreateModal = toggleCreateModal;

async function createChatChannel() {
  const name  = document.getElementById('msg-create-name')?.value.trim();
  if (!name) return;
  const token = _msgToken();
  if (!token) return;
  try {
    const res  = await fetch('/api/chat/channel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: _msgTab }),
    });
    const data = await res.json();
    if (data.roomId) {
      toggleCreateModal(false);
      document.getElementById('msg-create-name').value = '';
      loadMsgRooms(_msgTab);
      showApplyEffect(`채널 생성: #${name}`);
    }
  } catch (_) {}
}
window.createChatChannel = createChatChannel;

// ── WebSocket 채팅 방 구독 (실시간 수신) ─────────────────────────────────────
function _subscribeWsChatRoom(roomId) {
  // 전역 WebSocket이 있으면 재사용
  if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'chat.subscribe', roomId }));
    // 원래 onmessage 핸들러를 래핑
    const origOnMsg = ws.onmessage;
    ws.onmessage = function(e) {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'chat_message' && msg.message?.room_id === _msgRoomId) {
          _appendIncomingMsg(msg.message);
        } else if (msg.type === 'chat_delete' && msg.room_id === _msgRoomId) {
          // 삭제 처리
        } else if (origOnMsg) origOnMsg.call(this, e);
      } catch (_) { if (origOnMsg) origOnMsg.call(this, e); }
    };
  }
}

function _appendIncomingMsg(msg) {
  const area = document.getElementById('msg-messages-area');
  if (!area) return;
  const myId  = _orbitUser?.id || '';
  const isMine = msg.sender_id === myId;
  const isBot  = msg.sender_id === 'orbit-bot' || msg.type === 'ai';
  const cls    = isBot ? 'ai-bot' : isMine ? 'mine' : 'theirs';
  const time   = new Date(msg.created_at || Date.now()).toLocaleTimeString('ko', { hour:'2-digit', minute:'2-digit' });
  const metaHtml = !isMine ? `<div class="msg-meta">${msg.sender_name || '?'}</div>` : '';

  // AI 로딩 제거
  document.getElementById('ai-loading-msg')?.remove();
  // 빈 상태 제거
  area.querySelector('.msg-empty-chat')?.remove();

  const el = document.createElement('div');
  el.innerHTML = `${metaHtml}<div class="msg-bubble ${cls}">${escapeHtml(msg.content)}<div class="msg-time">${time}</div></div>`;
  area.appendChild(el);
  area.scrollTop = area.scrollHeight;
}

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

/* ── FOLLOW SYSTEM ───────────────────────────────────────────────────────────
 * 팔로우 / 언팔로우, 팔로잉 목록, 팔로워 목록
 * ─────────────────────────────────────────────────────────────────────────── */
let _followPanelTab = 'following'; // 'following' | 'followers'

async function toggleFollow(userId, btn) {
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _orbitUser.token || localStorage.getItem('orbitToken');
  const isFollowing = btn.classList.contains('following');
  btn.disabled = true;
  try {
    const res  = await fetch(`/api/follow/${userId}`, {
      method: isFollowing ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.ok !== undefined) {
      btn.classList.toggle('following', data.following);
      btn.textContent = data.following ? '✓ 팔로잉' : '+ 팔로우';
    }
  } catch (e) {
    console.warn('[follow] error:', e.message);
  } finally {
    btn.disabled = false;
  }
}
window.toggleFollow = toggleFollow;

async function checkFollowStatus(userId, btn) {
  if (!_orbitUser) return;
  const token = _orbitUser.token || localStorage.getItem('orbitToken');
  try {
    const res  = await fetch(`/api/follow/check/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    btn.classList.toggle('following', data.following);
    btn.textContent = data.following ? '✓ 팔로잉' : '+ 팔로우';
  } catch (_) {}
}
window.checkFollowStatus = checkFollowStatus;

function toggleFollowPanel() {
  const panel = document.getElementById('follow-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) loadFollowList(_followPanelTab);
}
window.toggleFollowPanel = toggleFollowPanel;

function switchFollowTab(tab) {
  _followPanelTab = tab;
  document.getElementById('fp-tab-ing').classList.toggle('active', tab === 'following');
  document.getElementById('fp-tab-ers').classList.toggle('active', tab === 'followers');
  loadFollowList(tab);
}
window.switchFollowTab = switchFollowTab;

async function loadFollowList(tab) {
  const listEl = document.getElementById('fp-list-area');
  if (!listEl) return;
  listEl.innerHTML = '<div class="fp-empty">불러오는 중…</div>';
  if (!_orbitUser) { listEl.innerHTML = '<div class="fp-empty">로그인 후 이용하세요</div>'; return; }
  const token = _orbitUser.token || localStorage.getItem('orbit_token') || localStorage.getItem('orbitToken');
  const url   = tab === 'followers' ? '/api/follow/followers' : '/api/follow/list';
  try {
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      const emptyMsg = tab === 'followers'
        ? '팔로워가 없습니다<br><span style="font-size:10px;color:#484f58">위 검색창에서 사람을 찾아 팔로우하면<br>상대방도 팔로우할 수 있습니다</span>'
        : '팔로잉하는 사람이 없습니다<br><span style="font-size:10px;color:#484f58">위 검색창에서 이름·이메일로 검색하세요</span>';
      listEl.innerHTML = `<div class="fp-empty" style="line-height:1.7">${emptyMsg}</div>`;
      return;
    }
    listEl.innerHTML = list.map(u => `
      <div class="fp-user">
        <div class="fp-avatar">${u.avatar_url
          ? `<img src="${u.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
          : (u.name || '?').charAt(0)}</div>
        <div class="fp-info">
          <div class="fp-name">${u.name || '익명'}</div>
          <div class="fp-sub">${u.headline || u.company || ''}</div>
        </div>
        <button onclick="fpStartDm('${u.user_id}','${(u.name||'').replace(/'/g,"\\'")}',event)"
          style="background:rgba(88,166,255,0.1);border:1px solid #1f6feb;color:#58a6ff;
                 border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;flex-shrink:0"
          title="DM 보내기">💬</button>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="fp-empty">불러오기 실패</div>';
  }
}
window.loadFollowList = loadFollowList;

// ── 팔로우 패널에서 DM 시작 ────────────────────────────────────────────────
async function fpStartDm(userId, name, e) {
  if (e) e.stopPropagation();
  if (!_orbitUser) { showToast('로그인이 필요합니다'); return; }
  // 메신저 열기 + DM 탭으로 이동
  const panel = document.getElementById('messenger-panel');
  if (!panel.classList.contains('open')) toggleMessenger();
  switchMsgTab('dm');
  // DM 방 생성 또는 기존 방 열기
  await startDmWithUser(userId, name);
  showToast(`💬 ${name}님과 DM 시작`);
}
window.fpStartDm = fpStartDm;

// ── 사용자 검색 (팔로우 패널) ─────────────────────────────────────────────
let _fpSearchTimer = null;
function fpSearchDebounce(q) {
  clearTimeout(_fpSearchTimer);
  const resultEl = document.getElementById('fp-search-results');
  if (!q.trim()) { resultEl.style.display = 'none'; return; }
  _fpSearchTimer = setTimeout(() => fpSearchUsers(q.trim()), 400);
}
window.fpSearchDebounce = fpSearchDebounce;

async function fpSearchUsers(q) {
  const resultEl = document.getElementById('fp-search-results');
  if (!_orbitUser) { resultEl.style.display = 'none'; return; }
  const token = _orbitUser.token || localStorage.getItem('orbit_token') || localStorage.getItem('orbitToken');
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="font-size:11px;color:#6e7681;padding:6px 0">검색 중…</div>';
  try {
    const res  = await fetch(`/api/follow/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      resultEl.innerHTML = '<div style="font-size:11px;color:#6e7681;padding:6px 0">검색 결과 없음</div>';
      return;
    }
    resultEl.innerHTML = list.map(u => {
      const isGoogle = u.provider === 'google';              // Google OAuth 계정 여부
      const provBadge = isGoogle                             // Google 배지 표시
        ? '<span style="font-size:9px;background:rgba(66,133,244,0.15);color:#4285f4;padding:1px 5px;border-radius:3px;margin-left:4px">G</span>'
        : '';
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #21262d">
        <div style="width:28px;height:28px;border-radius:50%;background:${isGoogle?'#4285f4':'#1f6feb'};display:flex;align-items:center;
                    justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">
          ${u.avatar_url ? `<img src="${u.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (u.name||'?').charAt(0)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:#e6edf3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.name||'익명'}${provBadge}</div>
          <div style="font-size:10px;color:#6e7681">${u.email||u.headline||''}</div>
        </div>
        <button onclick="fpFollowUser('${u.id}','${(u.name||'').replace(/'/g,"\\'")}',this)"
          style="background:${u.is_following?'rgba(63,185,80,0.1)':'rgba(31,111,235,0.1)'};
                 border:1px solid ${u.is_following?'#238636':'#1f6feb'};
                 color:${u.is_following?'#3fb950':'#58a6ff'};
                 border-radius:6px;padding:2px 8px;font-size:10px;cursor:pointer;flex-shrink:0">
          ${u.is_following?'✓ 팔로잉':'+ 팔로우'}
        </button>
      </div>`;
    }).join('');
  } catch(e) {
    resultEl.innerHTML = '<div style="font-size:11px;color:#f85149;padding:6px 0">검색 실패</div>';
  }
}
window.fpSearchUsers = fpSearchUsers;

// ── 팔로우/언팔로우 (검색 결과에서) ──────────────────────────────────────
async function fpFollowUser(userId, name, btn) {
  if (!_orbitUser) { showToast('로그인이 필요합니다'); return; }
  const token = _orbitUser.token || localStorage.getItem('orbit_token') || localStorage.getItem('orbitToken');
  const isFollowing = btn.textContent.includes('팔로잉');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/follow/${userId}`, {
      method: isFollowing ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      if (isFollowing) {
        btn.textContent = '+ 팔로우';
        btn.style.borderColor = '#1f6feb'; btn.style.color = '#58a6ff';
        btn.style.background = 'rgba(31,111,235,0.1)';
        showToast(`${name}님 언팔로우`);
      } else {
        btn.textContent = '✓ 팔로잉';
        btn.style.borderColor = '#238636'; btn.style.color = '#3fb950';
        btn.style.background = 'rgba(63,185,80,0.1)';
        showToast(`✓ ${name}님 팔로우 완료!`);
        loadFollowList(_followPanelTab); // 목록 새로고침
      }
    }
  } catch(e) { showToast('오류 발생'); }
  btn.disabled = false;
}
window.fpFollowUser = fpFollowUser;

/* ── ORBIT ANALYTICS ─────────────────────────────────────────────────────────
 * 사용자 행동 데이터 수집 모듈
 * 수집 이벤트: auth / view / node / ai / session
 * 서버: POST /api/analytics/batch (2초 디바운스 배치 전송)
 * ─────────────────────────────────────────────────────────────────────────── */
(function setupOrbitAnalytics() {
  'use strict';
  const SESSION_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const _queue = [];
  let _flushTimer = null;

  function track(event, meta) {
    // 트래킹 거부 시 스킵
    if (localStorage.getItem('orbitTrackingAllowed') === '0') return;
    const user = (() => { try { return JSON.parse(localStorage.getItem('orbitUser') || 'null'); } catch(_) { return null; } })();
    _queue.push({
      event:      String(event).slice(0, 100),
      meta:       meta || null,
      user_id:    user ? (user.email || null) : null,
      session_id: SESSION_ID,
    });
    if (!_flushTimer) _flushTimer = setTimeout(flush, 2000);
  }
  window.track = track;

  function flush() {
    _flushTimer = null;
    if (!_queue.length) return;
    const batch = _queue.splice(0, 50);
    fetch('/api/analytics/batch', {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify({ events: batch }),
      keepalive: true,
    }).catch(() => {});
  }

  // 페이지 언로드 시 잔여 이벤트 즉시 전송
  window.addEventListener('beforeunload', flush);

  // ── SESSION START ────────────────────────────────────────────────────────
  track('session.start', { referrer: document.referrer.slice(0, 100) });

  // ── SESSION HEARTBEAT (60초마다) ─────────────────────────────────────────
  setInterval(() => {
    const mode = typeof _parallelMode !== 'undefined' && _parallelMode ? 'parallel'
               : typeof _companyMode  !== 'undefined' && _companyMode  ? 'company'
               : typeof _teamMode     !== 'undefined' && _teamMode     ? 'team'
               : 'personal';
    track('session.heartbeat', { mode });
  }, 60000);
})();

// ══════════════════════════════════════════════════════════════════════════════
// 구독 플랜 모달
// ══════════════════════════════════════════════════════════════════════════════
let _pricePeriod = 'monthly';

function openPricing() {
  const overlay = document.getElementById('pricing-overlay');
  overlay.classList.add('open');
  renderPricingGrid();
}
window.openPricing = openPricing;

function closePricing() {
  document.getElementById('pricing-overlay').classList.remove('open');
}
window.closePricing = closePricing;

function setPricePeriod(period, btn) {
  _pricePeriod = period;
  document.querySelectorAll('.pm-period-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPricingGrid();
}
window.setPricePeriod = setPricePeriod;

async function renderPricingGrid() {
  const grid = document.getElementById('pm-grid');
  if (!grid) return;
  let plans;
  try {
    const res = await fetch('/api/payment/plans');
    const data = await res.json();
    plans = data.plans || [];
  } catch {
    plans = [
      { id:'free', name:'Free', badge:'', priceLabel:'₩0', period:'', description:'개인 개발자를 위한 무료 플랜',
        features:['개인 작업 추적','기본 3D 마인드맵','5개 세션 히스토리','기본 이펙트 2개','커뮤니티 지원'], cta:'현재 플랜', popular:false, price:0 },
      { id:'pro', name:'Pro', badge:'POPULAR', priceLabel:'₩9,900', period:'/월', description:'파워 유저를 위한 프로 플랜',
        features:['Free의 모든 기능','무제한 세션 히스토리','팀 대시보드 (10명)','AI 인사이트 분석','Shadow AI 감지','감사 로그','컨텍스트 브릿지','모든 이펙트 + 스킨','테마 마켓 판매 가능','이메일 지원'], cta:'프로 시작하기', popular:true, price:9900 },
      { id:'team', name:'Team', badge:'', priceLabel:'₩29,900', period:'/월/멤버', description:'팀 협업을 위한 비즈니스 플랜',
        features:['Pro의 모든 기능','무제한 채널 & 멤버','실시간 팀 협업','부서별 대시보드','관리자 뷰','PR 자동 태그','PDF 감사 리포트','작업 충돌 감지','팀 인사이트 분석','우선 지원 (SLA 24h)'], cta:'팀 시작하기', popular:false, price:29900 },
      { id:'enterprise', name:'Enterprise', badge:'', priceLabel:'문의', period:'', description:'대규모 조직을 위한 엔터프라이즈',
        features:['Team의 모든 기능','온프레미스 배포 지원','SSO / SAML 인증','커스텀 AI 모델 연동','전용 인프라 격리','SLA 99.9% 보장','전담 매니저 배정','API 무제한 호출','보안 감사 인증서','맞춤 교육 & 온보딩'], cta:'영업팀 문의', popular:false, price:-1 },
    ];
  }

  grid.innerHTML = plans.map(p => {
    const yearly = _pricePeriod === 'yearly';
    let priceLabel = p.priceLabel || '₩0';
    let period = p.period || '';
    if (yearly && p.price > 0) {
      const yp = Math.round(p.price * 12 * 0.8);
      priceLabel = '₩' + yp.toLocaleString();
      period = '/년' + (p.period?.includes('멤버') ? '/멤버' : '');
    }
    return `
      <div class="pm-card${p.popular ? ' popular' : ''}">
        ${p.badge ? `<div class="pm-badge">${p.badge}</div>` : ''}
        <div class="pm-plan-name">${p.name}</div>
        <div class="pm-plan-desc">${p.description || ''}</div>
        <div class="pm-price">
          <span class="pm-price-amount">${priceLabel}</span>
          <span class="pm-price-period">${period}</span>
        </div>
        <ul class="pm-features">
          ${(p.features || []).map(f => `<li>${f}</li>`).join('')}
        </ul>
        <button class="pm-cta" onclick="selectPlan('${p.id}')">${p.cta || '선택'}</button>
      </div>
    `;
  }).join('');
}

async function selectPlan(planId) {
  if (planId === 'free') { closePricing(); return; }                             // Free 플랜 → 모달 닫기
  if (planId === 'enterprise') { alert('enterprise@orbit-ai.dev 로 문의해주세요.'); return; } // 엔터프라이즈 → 문의 안내
  try {
    const userId = _orbitUser?.id || 'local';                                    // 현재 로그인 사용자 ID
    // 1단계: 결제 요청 생성
    const res = await fetch('/api/payment/create', {                             // 결제 초기화 API 호출
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId, userId, userEmail: _orbitUser?.email || '' })
    });
    const result = await res.json();                                             // 결제 생성 결과

    if (result.mock) {
      // 2단계: 결제 승인 (목 모드 — 즉시 승인)
      const confirmRes = await fetch('/api/payment/confirm', {                   // 결제 승인 API 호출
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentKey: 'mock-key-' + Date.now(),                                  // 목 결제 키
          orderId: result.orderId,                                               // 주문 ID
          amount: result.amount,                                                 // 결제 금액
          userId: userId,                                                        // 사용자 ID
          planId: planId,                                                        // 업그레이드할 플랜
        })
      });
      const confirmResult = await confirmRes.json();                             // 승인 결과

      if (confirmResult.success) {
        // 로컬 사용자 객체에 플랜 정보 반영
        if (_orbitUser) {
          _orbitUser.plan = planId;                                               // 로컬 플랜 업데이트
          localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));          // localStorage에 저장
        }
        alert(`${planId.toUpperCase()} 플랜으로 업그레이드 되었습니다!\n주문번호: ${result.orderId}\n금액: ₩${result.amount?.toLocaleString()}`);
      } else {
        alert('결제 승인 실패: ' + (confirmResult.error || '알 수 없는 오류'));     // 승인 실패 안내
      }
      closePricing();                                                            // 가격 모달 닫기
    } else if (result.clientKey) {
      // 실제 PG 결제 — Toss Payments SDK 연동 (추후 구현)
      alert('결제 페이지로 이동합니다...');                                        // 실결제 페이지 이동 안내
    }
  } catch (e) {
    alert('결제 오류: ' + e.message);                                             // 네트워크 등 오류 처리
  }
}
window.selectPlan = selectPlan;

// ══════════════════════════════════════════════════════════════════════════════
// 바탕화면 윈도우 시스템 — 3D 마인드맵 위에서 다중 창 열기/닫기
// ══════════════════════════════════════════════════════════════════════════════
const _openWindows = new Map(); // windowId → { el, data, minimized }
let _windowZIndex = 260;
let _taskbarVisible = false;

// 아이콘 매핑 (AI 도구 / 웹 사이트)
const TOOL_ICONS = {
  'chatgpt': '🤖', 'claude': '⬡', 'gemini': '✦', 'copilot': '🧑‍✈️',
  'cursor': '📝', 'windsurf': '🏄', 'perplexity': '🔍', 'midjourney': '🎨',
  'github': '🐙', 'vscode': '💻', 'terminal': '⌨️', 'browser': '🌐',
  'default': '📄',
};

function getToolIcon(source) {
  if (!source) return TOOL_ICONS.default;
  const s = source.toLowerCase();
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (s.includes(key)) return icon;
  }
  return TOOL_ICONS.default;
}

function showTaskbar() {
  if (_taskbarVisible) return;
  _taskbarVisible = true;
  document.getElementById('desktop-taskbar').classList.add('active');
  // 통합 패널 버튼 위치 조정
  const ucBtn = document.getElementById('unified-ctrl-btn');
  if (ucBtn) ucBtn.style.bottom = '56px';
  // 시계 업데이트
  updateTaskbarClock();
  setInterval(updateTaskbarClock, 30000);
}

function updateTaskbarClock() {
  const el = document.getElementById('taskbar-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
}

function openDesktopWindow(data) {
  const id = data.windowId || 'win-' + Date.now();
  if (_openWindows.has(id)) {
    // 이미 열린 창 → 포커스 + 복원
    const win = _openWindows.get(id);
    win.minimized = false;
    win.el.classList.remove('minimized');
    focusWindow(id);
    updateTaskbarItems();
    return id;
  }

  showTaskbar();

  const icon = getToolIcon(data.source || data.type || '');
  const title = data.title || data.label || data.intent || 'Window';

  // 새 창 위치 계산 (cascade)
  const offset = _openWindows.size * 30;
  const left = 100 + offset;
  const top = 60 + offset;

  const win = document.createElement('div');
  win.className = 'dw-window focused';
  win.id = id;
  win.style.cssText = `left:${left}px;top:${top}px;width:${data.width||480}px;height:${data.height||360}px;z-index:${++_windowZIndex}`;

  // 타이틀바
  const titlebar = document.createElement('div');
  titlebar.className = 'dw-titlebar';
  titlebar.innerHTML = `
    <span class="dw-title-icon">${icon}</span>
    <span class="dw-title-text">${escapeHtml(title)}</span>
    <button class="dw-btn" onclick="minimizeWindow('${id}')" title="최소화">─</button>
    <button class="dw-btn close" onclick="closeDesktopWindow('${id}')" title="닫기">✕</button>
  `;

  // 드래그 가능
  makeDraggable(win, titlebar);

  // 본문
  const body = document.createElement('div');
  body.className = 'dw-body';

  if (data.url) {
    body.innerHTML = `<iframe src="${escapeHtml(data.url)}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`;
    body.style.padding = '0';
  } else {
    body.innerHTML = buildWindowContent(data);
  }

  // 상태바
  const status = document.createElement('div');
  status.className = 'dw-status';
  const dotColor = data.active ? '#3fb950' : '#6e7681';
  status.innerHTML = `<div class="dw-status-dot" style="background:${dotColor}"></div>
    <span>${data.source || data.type || 'orbit'}</span>
    <span style="margin-left:auto">${data.timestamp ? relativeTime(data.timestamp) : ''}</span>`;

  win.appendChild(titlebar);
  win.appendChild(body);
  win.appendChild(status);

  // 클릭 시 포커스
  win.addEventListener('mousedown', () => focusWindow(id));

  document.getElementById('desktop-windows').appendChild(win);

  _openWindows.set(id, { el: win, data, minimized: false });
  updateTaskbarItems();
  return id;
}
window.openDesktopWindow = openDesktopWindow;

function buildWindowContent(data) {
  if (data.type === 'session') {
    const ctx = typeof _sessionContextCache !== 'undefined' ? _sessionContextCache[data.sessionId] : null;
    return `
      <div style="padding:4px">
        <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.intent || '작업 세션'}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
          <span style="color:#6e7681">세션</span><span>${data.sessionId?.slice(-8) || '-'}</span>
          <span style="color:#6e7681">작업수</span><span>${data.eventCount || 0}개</span>
          <span style="color:#6e7681">프로젝트</span><span>${ctx?.projectName || '-'}</span>
        </div>
        ${ctx?.firstMsg ? `<div style="margin-top:12px;padding:8px;background:#161b22;border-radius:8px;font-size:11px;color:#8b949e">${ctx.firstMsg.slice(0,300)}</div>` : ''}
      </div>
    `;
  }
  if (data.type === 'file') {
    return `
      <div style="padding:4px">
        <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.filename || data.fileLabel || '파일'}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
          <span style="color:#6e7681">접근</span><span>${data.count || 1}회</span>
          <span style="color:#6e7681">역할</span><span>${data.isWrite ? '✏️ 수정' : '📄 읽기'}</span>
        </div>
      </div>
    `;
  }
  if (data.type === 'ai_tool' || data.site) {
    return `
      <div style="padding:4px">
        <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.title || data.site || 'AI Tool'}</div>
        <div style="font-size:12px;color:#8b949e;margin-bottom:8px">${data.url || ''}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
          <span style="color:#6e7681">소스</span><span>${data.site || data.source || '-'}</span>
          <span style="color:#6e7681">메시지</span><span>${data.msgCount || data.msg_count || '-'}개</span>
        </div>
      </div>
    `;
  }
  // 기본
  return `
    <div style="padding:4px">
      <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.label || data.title || 'Window'}</div>
      <pre style="font-size:11px;color:#8b949e;white-space:pre-wrap;word-break:break-all">${JSON.stringify(data, null, 2).slice(0, 1000)}</pre>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return '방금';
  if (diff < 3600000) return Math.floor(diff/60000) + '분 전';
  if (diff < 86400000) return Math.floor(diff/3600000) + '시간 전';
  return Math.floor(diff/86400000) + '일 전';
}

function focusWindow(id) {
  document.querySelectorAll('.dw-window').forEach(w => w.classList.remove('focused'));
  const win = _openWindows.get(id);
  if (!win) return;
  win.el.style.zIndex = ++_windowZIndex;
  win.el.classList.add('focused');
  updateTaskbarItems();
}
window.focusWindow = focusWindow;

function minimizeWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  win.minimized = true;
  win.el.classList.add('minimized');
  updateTaskbarItems();
}
window.minimizeWindow = minimizeWindow;

function restoreWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  if (win.minimized) {
    win.minimized = false;
    win.el.classList.remove('minimized');
  }
  focusWindow(id);
  updateTaskbarItems();
}
window.restoreWindow = restoreWindow;

function closeDesktopWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  win.el.remove();
  _openWindows.delete(id);
  updateTaskbarItems();
  if (_openWindows.size === 0) {
    _taskbarVisible = false;
    document.getElementById('desktop-taskbar').classList.remove('active');
    const ucBtn = document.getElementById('unified-ctrl-btn');
    if (ucBtn) ucBtn.style.bottom = '16px';
  }
}
window.closeDesktopWindow = closeDesktopWindow;

function toggleDesktopWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  if (win.minimized) {
    restoreWindow(id);
  } else if (win.el.classList.contains('focused')) {
    minimizeWindow(id);
  } else {
    focusWindow(id);
  }
}

function updateTaskbarItems() {
  const container = document.getElementById('taskbar-items');
  if (!container) return;
  container.innerHTML = '';
  for (const [id, win] of _openWindows) {
    const icon = getToolIcon(win.data.source || win.data.type || '');
    const label = win.data.title || win.data.label || win.data.intent || 'Window';
    const isFocused = win.el.classList.contains('focused') && !win.minimized;
    const item = document.createElement('div');
    item.className = 'tb-item' + (isFocused ? ' active' : '');
    item.innerHTML = `
      <span class="tb-item-icon">${icon}</span>
      <span class="tb-item-label">${escapeHtml(label)}</span>
      <button class="tb-item-close" onclick="event.stopPropagation();closeDesktopWindow('${id}')">✕</button>
    `;
    item.onclick = () => toggleDesktopWindow(id);
    container.appendChild(item);
  }
}

function makeDraggable(el, handle) {
  let startX, startY, origX, origY;
  handle.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
    e.preventDefault();
    startX = e.clientX; startY = e.clientY;
    origX = el.offsetLeft; origY = el.offsetTop;
    const onMove = ev => {
      el.style.left = (origX + ev.clientX - startX) + 'px';
      el.style.top  = (origY + ev.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 성장 엔진 — 스트릭, 레벨업, 뱃지 시스템
// ══════════════════════════════════════════════════════════════════════════════

const _GROWTH_KEY = 'orbitGrowthData';
const _growthData = JSON.parse(localStorage.getItem(_GROWTH_KEY) || 'null') || {
  xp: 0, level: 1, streak: 0,
  lastActiveDate: null,
  badges: [],
  history: [],
};

function saveGrowthData() {
  localStorage.setItem(_GROWTH_KEY, JSON.stringify(_growthData));
}

// XP 요구량 계산 (레벨 * 100)
function xpForLevel(lvl) { return lvl * 100; }

// XP 추가
function addXP(amount, reason) {
  _growthData.xp += amount;
  _growthData.history.unshift({ text: `+${amount} XP — ${reason}`, ts: Date.now() });
  if (_growthData.history.length > 50) _growthData.history.length = 50;

  // 레벨업 체크
  while (_growthData.xp >= xpForLevel(_growthData.level)) {
    _growthData.xp -= xpForLevel(_growthData.level);
    _growthData.level++;
    _growthData.history.unshift({ text: `🎉 Level ${_growthData.level} 달성!`, ts: Date.now() });
    checkBadge('level10', _growthData.level >= 10);
  }

  saveGrowthData();
  renderGrowthPanel();
}

// 스트릭 업데이트 (매일 첫 작업 시 호출)
function updateStreak() {
  const today = new Date().toDateString();
  if (_growthData.lastActiveDate === today) return; // 이미 오늘 업데이트됨

  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (_growthData.lastActiveDate === yesterday) {
    _growthData.streak++;
  } else if (_growthData.lastActiveDate !== today) {
    _growthData.streak = 1; // 리셋
  }

  _growthData.lastActiveDate = today;
  addXP(10, '일일 로그인');

  // 스트릭 뱃지 체크
  checkBadge('streak3',  _growthData.streak >= 3);
  checkBadge('streak7',  _growthData.streak >= 7);
  checkBadge('streak30', _growthData.streak >= 30);

  saveGrowthData();
  renderGrowthPanel();
}

// 뱃지 체크 & 부여
const BADGE_DEFS = [
  { id:'firstWork',   label:'🌱 첫 작업',     condition:'first_work' },
  { id:'streak3',     label:'🔥 3일 연속',     condition:'streak3' },
  { id:'streak7',     label:'⚡ 7일 연속',     condition:'streak7' },
  { id:'streak30',    label:'🏆 30일 연속',    condition:'streak30' },
  { id:'files100',    label:'💯 100개 파일',   condition:'files100' },
  { id:'aiChat50',    label:'🤖 AI 대화 50회', condition:'aiChat50' },
  { id:'teamSim',     label:'👥 팀 시뮬 참여',  condition:'teamSim' },
  { id:'level10',     label:'🌟 레벨 10',      condition:'level10' },
];

function checkBadge(id, condition) {
  if (!condition) return;
  if (_growthData.badges.includes(id)) return;
  _growthData.badges.push(id);
  _growthData.history.unshift({ text: `🏅 뱃지 획득: ${BADGE_DEFS.find(b => b.id === id)?.label || id}`, ts: Date.now() });
  saveGrowthData();
  if (typeof showToast === 'function') showToast(`🏅 뱃지 획득!`, 3000);
}

// 이벤트 훅: 파일 작업 시 XP
function onFileEvent(isWrite) {
  addXP(isWrite ? 5 : 2, isWrite ? '파일 수정' : '파일 읽기');
  checkBadge('firstWork', true);
}
window.onFileEvent = onFileEvent;

// 이벤트 훅: AI 대화 시 XP
function onAIConversation() {
  addXP(8, 'AI 대화');
}
window.onAIConversation = onAIConversation;

// 이벤트 훅: 팀 시뮬 참여 시
function onTeamSimJoin() {
  checkBadge('teamSim', true);
  addXP(15, '팀 시뮬 참여');
}
window.onTeamSimJoin = onTeamSimJoin;

// ─── 성장 패널 렌더링 ────────────────────────────
function renderGrowthPanel() {
  const lvEl = document.getElementById('gp-level');
  const lvnEl = document.getElementById('gp-level-num');
  const xpEl = document.getElementById('gp-xp');
  const xpmEl = document.getElementById('gp-xp-max');
  const xpfEl = document.getElementById('gp-xp-fill');
  const skEl = document.getElementById('gp-streak');
  const shEl = document.getElementById('gp-streak-hint');
  const bdEl = document.getElementById('gp-badges');
  const hiEl = document.getElementById('gp-history');

  if (lvEl) lvEl.textContent = _growthData.level;
  if (lvnEl) lvnEl.textContent = _growthData.level;
  if (xpEl) xpEl.textContent = _growthData.xp;
  const maxXP = xpForLevel(_growthData.level);
  if (xpmEl) xpmEl.textContent = maxXP;
  if (xpfEl) xpfEl.style.width = Math.min(100, Math.round((_growthData.xp / maxXP) * 100)) + '%';
  if (skEl) skEl.textContent = _growthData.streak;
  if (shEl) {
    const today = new Date().toDateString();
    shEl.textContent = _growthData.lastActiveDate === today ? '오늘 활동 완료!' : '오늘 작업을 시작하세요!';
  }

  // Badges
  if (bdEl) {
    bdEl.innerHTML = BADGE_DEFS.map(b => {
      const earned = _growthData.badges.includes(b.id);
      return `<div class="gp-badge ${earned ? 'earned' : 'locked'}">${b.label}</div>`;
    }).join('');
  }

  // History
  if (hiEl) {
    const items = _growthData.history.slice(0, 10);
    if (items.length === 0) {
      hiEl.innerHTML = '<div style="color:#6e7681;font-size:11px;text-align:center;padding:10px">아직 활동이 없습니다</div>';
    } else {
      hiEl.innerHTML = items.map(h => {
        const ago = formatGrowthTimeAgo(h.ts);
        return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid #161b22"><span style="color:#cdd9e5">${h.text}</span><span style="color:#6e7681;flex-shrink:0;margin-left:8px">${ago}</span></div>`;
      }).join('');
    }
  }
}

function formatGrowthTimeAgo(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return '방금';
  if (sec < 3600) return Math.floor(sec / 60) + '분 전';
  if (sec < 86400) return Math.floor(sec / 3600) + '시간 전';
  return Math.floor(sec / 86400) + '일 전';
}

function toggleGrowthPanel() {
  const panel = document.getElementById('growth-panel');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (isOpen) renderGrowthPanel();
}
window.toggleGrowthPanel = toggleGrowthPanel;

// 초기 스트릭 체크
document.addEventListener('DOMContentLoaded', () => {
  updateStreak();
  renderGrowthPanel();
});
