/**
 * mywork-renderer.js — 행성 시스템 코어
 *
 * ─ 이 파일만 보면 렌더러/클릭/복귀 버그 해결 가능 ─
 *
 * 의존 (로드 순서):
 *   1. mw-label.js  → _mwNormCat, mwGroupLabel, mwGroupColor, mwChildTopic, mwLatestActivity
 *   2. mw-card.js   → CARD_W, CARD_H, LEVEL_CFG, _mwExtractColor, makeRingPositions,
 *                      makeCardTexture, makeHubTexture
 *   3. (이 파일)
 */

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const MW = {
  hubMesh:         null,
  cardMeshes:      [],
  lineMeshes:      [],
  currentNodes:    [],
  currentHubLabel: '내 작업',
  currentLevel:    0,
  viewStack:       [],
  scene:           null,
  raycaster:       new THREE.Raycaster(),
  mouse:           new THREE.Vector2(),
  animating:       false,
};

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
  const purposeOrDomain = rawNode.purposeLabel || rawNode.domain || rawNode.category;
  if (purposeOrDomain) out.push(mk('🎯 목적', purposeOrDomain, '#06b6d4'));
  const _typeLabels = {
    'tool.end':'도구 실행', 'tool.start':'도구 시작', 'tool.error':'도구 실패',
    'user.message':'사용자 메시지', 'assistant.message':'AI 응답',
    'file.read':'파일 읽기', 'file.write':'파일 수정', 'file.create':'파일 생성',
    'subagent.start':'하위 작업 시작', 'subagent.stop':'하위 작업 완료',
    'git.commit':'Git 커밋', 'session.start':'세션 시작', 'session.end':'세션 종료',
  };
  const evType = rawNode.type || rawNode.eventType;
  if (evType) out.push(mk('🏷️ 유형', _typeLabels[evType] || evType, '#f59e0b'));
  if (rawNode.projectName || rawNode.project || rawNode.repo)
    out.push(mk('📁 프로젝트', rawNode.projectName || rawNode.project || rawNode.repo, '#10b981'));
  const fcRaw = String(rawNode.fullContent || rawNode.detail || rawNode.description || rawNode.summary || '');
  if (fcRaw.length > 3) {
    const fcClean = fcRaw.replace(/[{}"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push(mk('📝 내용', fcClean, '#ec4899'));
  }
  if (out.length === 0)
    out.push(mk('📋 상세', rawNode.label || rawNode.name || rawNode.id || '없음', pc));
  return out.slice(0, LEVEL_CFG[2].maxCards);
}

// ─── 씬 정리 ──────────────────────────────────────────────────────────────────
function clearMyWork() {
  const sc = MW.scene; if (!sc) return;
  [...MW.cardMeshes, ...MW.lineMeshes].forEach(m => {
    if (window.unregisterInteractive) window.unregisterInteractive(m);
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

// ─── 카드 메시 (renderOrder=2 → 허브보다 항상 앞에) ──────────────────────────
function createCard(node, pos) {
  const color = _mwExtractColor(node.color);
  const count = (node.children || []).length;

  // sub1: 항목 수 or 유형/도메인 (mw-label.js _mwNormCat 사용)
  const sub1 = count > 0
    ? `하위 ${count}개 항목`
    : _mwNormCat(node.domain || node.type || node.eventType || '');

  // sub2: 최근 활동 (mw-label.js mwLatestActivity 사용)
  const sub2 = node.latestActivity
    ? mwLatestActivity(node.latestActivity)
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
  mesh.renderOrder = 2;
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

// ─── 뷰 렌더링 ────────────────────────────────────────────────────────────────
// 3D 카드 메시 비활성화 — 2D Canvas drawCompactProjectView()가 대체
function renderView(nodes, hubLabel, levelIdx, hubPos) {
  // 기존 MW 3D 카드만 제거 (clearAllPlanets 호출 금지 — _projectGroups 파괴 방지)
  clearMyWork();
  return; // 2D 카드 레이아웃 사용 (orbit3d-layout.js drawCompactProjectView)
  const li = Math.min(levelIdx || 0, LEVEL_CFG.length - 1);
  const hp = hubPos || { x: 0, y: 0, z: 0 };

  clearAllPlanets();
  clearMyWork();
  createHub(hubLabel, hp);

  const visNodes  = nodes.slice(0, LEVEL_CFG[li].maxCards);
  const positions = makeRingPositions(visNodes.length, li);

  for (let i = 0; i < visNodes.length; i++) {
    const p   = positions[i];
    const pos = { x: hp.x + p.x, y: hp.y + p.y, z: hp.z + p.z };
    const cardMesh = createCard(visNodes[i], pos);
    if (window.registerInteractive && cardMesh) {
      const raw = visNodes[i]._raw || visNodes[i];
      window.registerInteractive(cardMesh, {
        id:   raw.id || raw.eventId || visNodes[i].topic || `mw_${i}`,
        name: visNodes[i].topic || visNodes[i].name || raw.label || '작업',
        label: visNodes[i].topic || visNodes[i].name || '',
        type: raw.type || raw.eventType || 'category',
      });
    }
    const hexStr = _mwExtractColor(visNodes[i].color, '#334155').replace('#', '');
    drawLine(
      { x: hp.x,  y: hp.y + 0.5,        z: hp.z },
      { x: pos.x, y: pos.y + CARD_H * 0.5, z: pos.z },
      parseInt(hexStr, 16)
    );
  }

  MW.currentNodes    = nodes;
  MW.currentHubLabel = hubLabel;
  MW.currentLevel    = li;

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

  MW.cardMeshes.forEach(m => m.updateMatrixWorld(true));
  if (MW.hubMesh) MW.hubMesh.updateMatrixWorld(true);

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
      if (typeof showHistoryPopup === 'function') {
        const raw = node._raw || node;
        showHistoryPopup({
          id:   raw.id || raw.eventId || node.topic || 'node',
          name: node.topic || node.name || raw.label || '작업',
          type: raw.type || raw.eventType || node.type || 'event',
        });
      } else if (typeof showToast === 'function') {
        showToast(`${node.topic||node.name} — 더 이상 하위 항목이 없습니다`, 2000);
      }
      return;
    }

    MW.viewStack.push({
      nodes:    MW.currentNodes.slice(),
      hubLabel: MW.currentHubLabel,
      levelIdx: MW.currentLevel,
    });

    const nextLevel = MW.currentLevel + 1;
    const maxCards  = LEVEL_CFG[Math.min(nextLevel, LEVEL_CFG.length - 1)].maxCards;
    const childNodes = children.slice(0, maxCards).map(c =>
      typeof c === 'string'
        ? { topic: c, name: c, color: node.color || '#06b6d4', children: [] }
        : { ...c, color: c.color || node.color || '#06b6d4' }
    );
    renderView(childNodes, node.topic || node.name, nextLevel);
  }
}

// ─── 스프라이트 빌보드 + 크기 보정 ───────────────────────────────────────────
function updateBillboard() {
  if (!window.camera) return;
  const q   = window.camera.quaternion;
  const cam = window.camera;
  const items = [...MW.cardMeshes];
  if (MW.hubMesh) items.push(MW.hubMesh);
  items.forEach(m => {
    m.quaternion.copy(q);
    const dist = cam.position.distanceTo(m.position);
    const ref  = 14;
    const s    = Math.max(0.5, Math.min(2.0, dist / ref));
    m.scale.setScalar(s);
  });
}

// ─── buildPlanetSystem ────────────────────────────────────────────────────────
// 라벨 결정: mw-label.js 함수 사용 (mwGroupLabel, mwGroupColor, mwChildTopic, mwLatestActivity)
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

  const _rmMode = window.RendererManager?.currentMode;
  if (_rmMode && _rmMode !== 'personal') return;
  if (window.RendererManager) {
    window.RendererManager.cleanupMultilevel();
  } else if (window.multiLevelRenderer) {
    const mlr = window.multiLevelRenderer;
    Object.values(mlr.nodeMeshes || {}).forEach(m => window.scene.remove(m));
    mlr.nodeMeshes = {};
    (mlr.connectionLines || []).forEach(l => window.scene.remove(l));
    mlr.connectionLines = [];
    if (typeof closeDrillPanel === 'function') closeDrillPanel();
  }

  if (MW.viewStack.length > 0) return;

  MW.scene     = window.scene;
  MW.viewStack = [];

  // ── 세션(프로젝트) 기반 그룹화 ───────────────────────────────────────────
  // 라벨/색상 결정은 mw-label.js 함수에 위임 (컨텍스트 없이 수정 가능)
  const groupMap = {};
  (nodeList || []).forEach(n => {
    const sessionKey = n.sessionId || n.group || null;
    const groupLabel = mwGroupLabel(n);   // ← mw-label.js
    const key        = sessionKey || groupLabel;

    if (!groupMap[key]) {
      const catColor = mwGroupColor(n) || _mwExtractColor(n.color);  // ← mw-label.js / mw-card.js
      groupMap[key] = {
        topic:          groupLabel,
        name:           groupLabel,
        color:          catColor,
        children:       [],
        latestActivity: null,
      };
    }

    const childColor = n.purposeColor || _mwExtractColor(n.color);
    const childTopic = mwChildTopic(n);   // ← mw-label.js

    groupMap[key].children.push({
      topic:    childTopic,
      name:     childTopic,
      color:    childColor,
      children: _mwMakeDetailNodes(n, childColor),
      _raw:     n,
    });

    if (!groupMap[key].latestActivity) {
      const rawAct = n.label || n.topic || n.name || '';
      groupMap[key].latestActivity = mwLatestActivity(rawAct);  // ← mw-label.js
    }
  });

  const topNodes = Object.values(groupMap)
    .sort((a, b) => b.children.length - a.children.length)
    .slice(0, LEVEL_CFG[0].maxCards);

  renderView(topNodes, '내 작업', 0);

  const cvs = (typeof renderer !== 'undefined' && renderer.domElement)
    || document.getElementById('orbit-canvas')
    || document.querySelector('canvas');
  if (cvs && !cvs._mwClickBound) {
    cvs.addEventListener('click', onMyWorkClick);
    cvs._mwClickBound = true;
  }

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
