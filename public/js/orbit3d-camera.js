// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Camera, breadcrumb, team orbit, labels
// ══════════════════════════════════════════════════════════════════════════════
// ── 브레드크럼 내비게이션 ─────────────────────────────────────────────────────
function updateBreadcrumb(level, deptName, memberName) {
  const bc = document.getElementById('nav-breadcrumb');
  const elTeam   = document.getElementById('bc-team');
  const elDept   = document.getElementById('bc-dept');
  const elMember = document.getElementById('bc-member');
  const arrow2   = document.querySelector('.bc-arrow2');
  const arrow3   = document.querySelector('.bc-arrow3');

  if (level === 'personal') {
    bc.classList.remove('visible');
    return;
  }

  bc.classList.add('visible');

  // 팀 레벨
  if (level === 'team') {
    elTeam.textContent = '👥 팀';
    elTeam.className = 'bc-crumb active';
    elTeam.style.display = '';
    if (arrow2) arrow2.style.display = 'none';
    elDept.style.display = 'none';
    if (arrow3) arrow3.style.display = 'none';
    elMember.style.display = 'none';
  } else if (level === 'company') {
    elTeam.textContent = '🏢 회사';
    elTeam.className = 'bc-crumb active';
    elTeam.style.display = '';
    if (arrow2) arrow2.style.display = 'none';
    elDept.style.display = 'none';
    if (arrow3) arrow3.style.display = 'none';
    elMember.style.display = 'none';
  } else if (level === 'dept') {
    const compMode = _companyMode;
    elTeam.textContent = compMode ? '🏢 회사' : '👥 팀';
    elTeam.className = 'bc-crumb clickable';
    elTeam.onclick = () => { unfocusDept(); updateBreadcrumb(compMode ? 'company' : 'team'); };
    elTeam.style.display = '';
    if (arrow2) arrow2.style.display = '';
    elDept.textContent = deptName || '부서';
    elDept.className = 'bc-crumb active';
    elDept.style.display = '';
    if (arrow3) arrow3.style.display = 'none';
    elMember.style.display = 'none';
  } else if (level === 'member') {
    const compMode = _companyMode;
    elTeam.textContent = compMode ? '🏢 회사' : '👥 팀';
    elTeam.className = 'bc-crumb clickable';
    elTeam.onclick = () => { unfocusMember(); if (_focusedDept) unfocusDept(); updateBreadcrumb(compMode ? 'company' : 'team'); };
    elTeam.style.display = '';
    if (_focusedDept) {
      if (arrow2) arrow2.style.display = '';
      elDept.textContent = deptName || '부서';
      elDept.className = 'bc-crumb clickable';
      elDept.onclick = () => { unfocusMember(); updateBreadcrumb('dept', deptName); };
      elDept.style.display = '';
      if (arrow3) arrow3.style.display = '';
    } else {
      if (arrow2) arrow2.style.display = 'none';
      elDept.style.display = 'none';
      if (arrow3) arrow3.style.display = '';
    }
    elMember.textContent = memberName || '팀원';
    elMember.className = 'bc-crumb active';
    elMember.style.display = '';
  } else if (level === 'parallel') {
    elTeam.textContent = '⚡ 병렬 작업';
    elTeam.className = 'bc-crumb active';
    elTeam.style.display = '';
    if (arrow2) arrow2.style.display = 'none';
    elDept.style.display = 'none';
    if (arrow3) arrow3.style.display = 'none';
    elMember.style.display = 'none';
  }
}

function bcGoPersonal() {
  if (_parallelMode) exitParallelMode();
  else if (_teamMode) exitTeamMode();
  else updateBreadcrumb('personal');
}

// ─── 카메라 부드러운 이동 ─────────────────────────────────────────────────────
function lerpCameraTo(r, tx, ty, tz, duration = 700) {
  _cameraLerp = {
    startR:   controls.sph.r,
    startTx:  controls.tgt.x,
    startTy:  controls.tgt.y,
    startTz:  controls.tgt.z,
    startPhi: controls.sph.φ,
    endR:     r,
    endTx:    tx,
    endTy:    ty,
    endTz:    tz,
    endPhi:   0.8,
    duration,
    elapsed:  0,
  };
}

function updateCameraLerp(dt) {
  if (!_cameraLerp) return;
  _cameraLerp.elapsed += dt;
  const raw = Math.min(_cameraLerp.elapsed / _cameraLerp.duration, 1);
  const t   = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw; // ease in-out
  controls.sph.r = _cameraLerp.startR  + (_cameraLerp.endR  - _cameraLerp.startR)  * t;
  controls.tgt.x = _cameraLerp.startTx + (_cameraLerp.endTx - _cameraLerp.startTx) * t;
  controls.tgt.y = _cameraLerp.startTy + (_cameraLerp.endTy - _cameraLerp.startTy) * t;
  controls.tgt.z = _cameraLerp.startTz + (_cameraLerp.endTz - _cameraLerp.startTz) * t;
  controls.sph.φ = _cameraLerp.startPhi + (_cameraLerp.endPhi - _cameraLerp.startPhi) * t;
  controls._apply();
  if (raw >= 1) _cameraLerp = null;
}

// ─── 레이블 겹침 해소 (AABB 스프링 시뮬레이션) ───────────────────────────────
// labels: [{ x, y, pw, ph, ax, ay, priority }]  x/y = 현재 top-left, ax/ay = 앵커 center
function resolveOverlaps(labels, iters = 30, gap = 8) {
  for (let it = 0; it < iters; it++) {
    // 1단계: 겹치는 쌍 찾아 최소 관통 축으로 밀어냄
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], b = labels[j];
        const acx = a.x + a.pw * 0.5, acy = a.y + a.ph * 0.5;
        const bcx = b.x + b.pw * 0.5, bcy = b.y + b.ph * 0.5;
        const ow = (a.pw + b.pw) * 0.5 + gap - Math.abs(acx - bcx);
        const oh = (a.ph + b.ph) * 0.5 + gap - Math.abs(acy - bcy);
        if (ow <= 0 || oh <= 0) continue; // 겹침 없음

        const pa = a.priority, pb = b.priority, ps = pa + pb;
        if (ow < oh) {
          // X축으로 밀어냄 (완전히 분리될 때까지)
          const push = ow * (acx < bcx ? 1 : -1);
          a.x -= push * (pb / ps);
          b.x += push * (pa / ps);
        } else {
          // Y축으로 밀어냄
          const push = oh * (acy < bcy ? 1 : -1);
          a.y -= push * (pb / ps);
          b.y += push * (pa / ps);
        }
      }
    }
    // 2단계: 앵커 방향 약한 스프링 복귀 (낮은 priority 노드만 적당히 복귀)
    for (const l of labels) {
      const k = Math.min(0.05 + l.priority * 0.02, 0.15); // 복귀력 약하게
      l.x += (l.ax - l.pw * 0.5 - l.x) * k;
      l.y += (l.ay - l.ph * 0.5 - l.y) * k;
      // 화면 경계 클램프
      l.x = Math.max(4, Math.min(innerWidth  - l.pw - 4, l.x));
      l.y = Math.max(54, Math.min(innerHeight - l.ph - 54, l.y));
    }
  }
}

// ─── 팀원 포커스 / 해제 ───────────────────────────────────────────────────────
function focusMember(memberNode) {
  _focusedMember = memberNode;
  const pos = memberNode.pos;
  lerpCameraTo(16, pos.x, pos.y, pos.z);
  const deptName = _focusedDept?.label || memberNode.deptId;
  updateBreadcrumb('member', deptName, memberNode.label);
}

// ─── 팀원 드릴다운: 개인 orbit 화면으로 전환 ────────────────────────────────
function memberTasksToFakeSessions(member) {
  const nodes = [];
  const now = Date.now();
  member.tasks.forEach((task, i) => {
    const sid = `${member.id}-task-${i}`;
    nodes.push({
      type: 'user.message',
      sessionId: sid,
      data: { contentPreview: task.name, content: task.name },
      ts: now - i * 120000,
    });
    (task.subtasks || []).forEach((sub, si) => {
      nodes.push({
        type: 'tool.end',
        sessionId: sid,
        data: { toolName: 'Write', filePath: sub, fileName: sub },
        ts: now - i * 120000 + (si + 1) * 8000,
      });
    });
  });
  return nodes;
}

async function drillDownToMember(memberNode) {
  // 실제 멤버 데이터 찾기
  const allMembers = (typeof _activeSimData !== 'undefined' && _activeSimData?.members)
    ? _activeSimData.members
    : (typeof _activeSimData !== 'undefined' && _activeSimData?.departments)
      ? _activeSimData.departments.flatMap(d => d.members || [])
      : (typeof TEAM_DEMO !== 'undefined' && TEAM_DEMO?.members)
        ? TEAM_DEMO.members : [];
  const memberData = allMembers.find(m => m.id === memberNode.memberId);

  _teamMode = false;
  _companyMode = false;
  _teamNodes = [];
  _focusedMember = null;
  _focusedDept = null;
  try { document.getElementById('team-mode-badge').style.display = 'none'; } catch {}
  try { document.querySelector('.tm-label').textContent = '👥 팀'; } catch {}

  // RendererManager 모드 라벨을 personal로 설정 (나중에 team 복귀 시 switchTo가 스킵되지 않도록)
  if (window.RendererManager?.setModeLabel) window.RendererManager.setModeLabel('personal');

  // 드릴다운 소스 먼저 설정 (breadcrumb에서 사용)
  window._drillDownSource = 'team';
  window._drillDownMemberId = memberNode.memberId;
  window._drillDownMemberName = memberNode.label;

  // 실제 유저 그래프 API 호출
  const realUserId = memberNode.userId || memberData?.userId || memberData?.originalUserId;
  if (realUserId) {
    try {
      const token = localStorage.getItem('orbit_token') || '';
      const res = await fetch(`/api/graph?memberId=${encodeURIComponent(realUserId)}`, {
        headers: token ? { 'Authorization': 'Bearer ' + token } : {},
      });
      if (res.ok) {
        const data = await res.json();
        if (data.nodes && data.nodes.length > 0) {
          buildPlanetSystem(data.nodes);
          document.getElementById('h-hours').textContent = memberNode.label || memberData?.name || '';
          _showDrillDownBreadcrumb(memberNode.label);
          lerpCameraTo(40, 0, 0, 0);
          return;
        }
      }
    } catch (e) { console.warn('[drillDown] graph 실패:', e.message); }
  }

  // 폴백: 멤버 tasks → 가짜 세션
  if (memberData) {
    const fakeNodes = memberTasksToFakeSessions(memberData);
    buildPlanetSystem(fakeNodes);
  }
  _showDrillDownBreadcrumb(memberNode.label);
  lerpCameraTo(40, 0, 0, 0);
}

// 드릴다운 시 "← 팀" 복귀 브레드크럼 표시
function _showDrillDownBreadcrumb(memberName) {
  const bc = document.getElementById('nav-breadcrumb');
  const elTeam   = document.getElementById('bc-team');
  const elMember = document.getElementById('bc-member');
  const arrow2   = document.querySelector('.bc-arrow2');
  const arrow3   = document.querySelector('.bc-arrow3');
  const elDept   = document.getElementById('bc-dept');

  if (!bc) return;
  bc.classList.add('visible');

  // "← 팀" 클릭 시 팀 뷰로 복귀
  elTeam.textContent = '← 팀';
  elTeam.className = 'bc-crumb clickable';
  elTeam.style.display = '';
  elTeam.onclick = () => {
    window._drillDownSource = null;
    window._drillDownMemberId = null;
    window._drillDownMemberName = null;
    loadTeamDemo();
  };

  if (arrow2) arrow2.style.display = 'none';
  if (elDept) elDept.style.display = 'none';
  if (arrow3) arrow3.style.display = '';
  if (elMember) {
    elMember.textContent = memberName || '팀원';
    elMember.className = 'bc-crumb active';
    elMember.style.display = '';
  }
}

function unfocusMember() {
  _focusedMember = null;
  if (_companyMode) {
    // 회사 모드: 포커스 해제 시 부서가 선택되어 있으면 부서 뷰로 복귀
    if (_focusedDept) {
      const dPos = _focusedDept.pos;
      lerpCameraTo(45, dPos.x, dPos.y, dPos.z);
    } else {
      lerpCameraTo(15, 0, 0, 0);
    }
  } else {
    lerpCameraTo(75, 0, 0, 0);
  }
}

// ── 부서 드릴다운 (회사 모드) ─────────────────────────────────────────────
let _focusedDept = null;

function focusDept(deptNode) {
  _focusedDept = deptNode;
  _focusedMember = null;
  const pos = deptNode.pos;
  lerpCameraTo(45, pos.x, pos.y, pos.z, 800);
  updateBreadcrumb('dept', deptNode.label);
}

function unfocusDept() {
  _focusedDept = null;
  _focusedMember = null;
  lerpCameraTo(15, 0, 0, 0, 800);
  updateBreadcrumb(_companyMode ? 'company' : 'team');
}

// ── 팀 모드 공전 ─────────────────────────────────────────────────────────────
function updateTeamOrbits(dt) {
  if (!orbitAnimOn) return;
  _clock += dt * 0.00025;

  if (_companyMode) {
    // ── 회사 모드: 부서 공전 ────────────────────────────────────────────────
    planetMeshes.forEach(p => {
      if (!p.userData.isDept) return;
      const { orbitR, orbitAngle, orbitSpeed } = p.userData;
      const a  = orbitAngle + _clock * orbitSpeed;
      const dz = (parseInt(p.userData.deptId.replace('d','')) % 2 === 0) ? 4 : -4;
      p.position.set(orbitR * Math.cos(a), orbitR * Math.sin(a), dz);
      const tn = _teamNodes.find(n => n.obj === p);
      if (tn) tn.pos.copy(p.position);
    });
    // 부서 내 팀원/작업 공전 (부서 위치 따라 이동)
    satelliteMeshes.forEach(s => {
      const deptP = planetMeshes.find(p => p.userData.isDept && p.userData.deptId === s.userData.deptId);
      const memberP = satelliteMeshes.find(m => m.userData.isDeptMember && m.userData.memberId === s.userData.memberId && m !== s);
      if (s.userData.isDeptMember && deptP) {
        const { orbitR, orbitAngle, orbitSpeed } = s.userData;
        const a = orbitAngle + _clock * orbitSpeed;
        const mi = parseInt((s.userData.memberId || 'c00').replace(/[^0-9]/g,'')) % 2;
        s.position.set(deptP.position.x + orbitR * Math.cos(a), deptP.position.y + orbitR * Math.sin(a), deptP.position.z + (mi ? 1.2 : -1.2));
      } else if ((s.userData.isTeamTask || s.userData.isTeamTool || s.userData.isTeamSkill || s.userData.isTeamAgent) && memberP) {
        const center = memberP.position;
        if (s.userData.isTeamTask) {
          const { orbitR, orbitAngle, orbitSpeed } = s.userData;
          const a = orbitAngle + _clock * orbitSpeed;
          s.position.set(center.x + orbitR * Math.cos(a), center.y + orbitR * Math.sin(a), center.z + orbitR * 0.3 * Math.sin(a + 0.8));
        } else {
          const { relAngle, relY, relR } = s.userData;
          s.position.set(center.x + relR * Math.cos(relAngle), center.y + relR * Math.sin(relAngle), center.z + relY);
        }
      }
      const tn = _teamNodes.find(n => n.obj === s);
      if (tn) tn.pos.copy(s.position);
    });
    // 연결선 업데이트 (userData 태그 방식)
    connections.forEach(ln => {
      if (!ln.userData) return;
      const src = ln.userData.srcObj, dst = ln.userData.dstObj;
      if (src && dst) {
        ln.geometry.setFromPoints([src.position.clone(), dst.position.clone()]);
        ln.geometry.attributes.position.needsUpdate = true;
      }
    });
    // 궤도 링: 부서 위치 따라 이동
    let ri = 1;
    planetMeshes.forEach(p => {
      if (!p.userData.isDept) return;
      if (orbitRings[ri]) orbitRings[ri].position.copy(p.position);
      ri++;
    });
    return;
  }

  // ── 팀 모드 공전 ─────────────────────────────────────────────────────────
  planetMeshes.forEach(p => {
    if (!p.userData.isTeamMember) return;
    const { orbitR, orbitAngle, orbitSpeed } = p.userData;
    const a  = orbitAngle + _clock * orbitSpeed;
    const mi = parseInt(p.userData.memberId.replace('m', '') || 0);
    p.position.set(orbitR * Math.cos(a), orbitR * Math.sin(a), 0);
    const tn = _teamNodes.find(n => n.obj === p);
    if (tn) tn.pos.copy(p.position);
  });

  // 작업/툴/스킬/에이전트 위성 공전
  satelliteMeshes.forEach(s => {
    const parent = planetMeshes.find(p => p.userData.memberId === s.userData.memberId);
    if (!parent) return;
    const center = parent.position;

    if (s.userData.isTeamTask) {
      const { orbitR, orbitAngle, orbitSpeed } = s.userData;
      const a = orbitAngle + _clock * orbitSpeed;
      s.position.set(center.x + orbitR * Math.cos(a), center.y + orbitR * Math.sin(a), center.z + orbitR * 0.3 * Math.sin(a + 0.8));
    } else if (s.userData.isTeamTool || s.userData.isTeamSkill || s.userData.isTeamAgent) {
      const { relAngle, relY, relR } = s.userData;
      s.position.set(center.x + relR * Math.cos(relAngle), center.y + relY, center.z + relR * Math.sin(relAngle));
    }
    const tn = _teamNodes.find(n => n.obj === s);
    if (tn) tn.pos.copy(s.position);
  });

  // 연결선 업데이트 (index 방식 — 팀 시뮬)
  let connIdx = 0;
  planetMeshes.forEach(p => {
    if (!p.userData.isTeamMember) return;
    if (connections[connIdx]) {
      connections[connIdx].geometry.setFromPoints([new THREE.Vector3(0, 0, 0), p.position.clone()]);
      connections[connIdx].geometry.attributes.position.needsUpdate = true;
    }
    connIdx++;
    satelliteMeshes.filter(s => s.userData.isTeamTask && s.userData.memberId === p.userData.memberId).forEach(s => {
      if (connections[connIdx]) {
        connections[connIdx].geometry.setFromPoints([p.position.clone(), s.position.clone()]);
        connections[connIdx].geometry.attributes.position.needsUpdate = true;
      }
      connIdx++;
    });
  });

  let ringIdx = 1;
  planetMeshes.forEach(p => {
    if (!p.userData.isTeamMember) return;
    if (orbitRings[ringIdx]) orbitRings[ringIdx].position.copy(p.position);
    ringIdx++;
  });
}

// ── 병렬 태스크 궤도 업데이트 ─────────────────────────────────────────────────
function updateParallelOrbits(dt) {
  if (!orbitAnimOn) return;
  _clock += dt * 0.00025;

  planetMeshes.forEach(p => {
    if (!p.userData.isParallelTask) return;
    const { orbitR, orbitAngle, orbitSpeed, orbitCenter } = p.userData;
    const a = orbitAngle + _clock * orbitSpeed;
    p.position.set(
      orbitCenter.x + orbitR * Math.cos(a),
      orbitCenter.y,
      orbitCenter.z + orbitR * Math.sin(a)
    );
    const tn = _teamNodes.find(n => n.obj === p);
    if (tn) tn.pos.copy(p.position);
  });
}

// ── 팀 모드 Canvas2D 라벨 (2-pass: 수집 → 겹침해소 → 드로우) ─────────────────
function drawTeamLabels() {
  _lctx.clearRect(0, 0, innerWidth, innerHeight);
  clearHitAreas();

  // 팀 노드 없으면 안전 종료
  if (!_teamNodes || _teamNodes.length === 0) return;

  const lod = getLOD();
  const now = Date.now() / 1000; // seconds

  // ── LOD 2+ : 계층 오버레이 (Company / Universe) ──────────────────────────
  if (lod >= 2 && _teamMode && typeof TEAM_DEMO !== 'undefined' && TEAM_DEMO?.universe) {
    // LOD 3: 유니버스 뷰
    if (lod >= 3) {
      const uv = TEAM_DEMO.universe;
      _lctx.save();
      _lctx.textAlign = 'center';
      _lctx.textBaseline = 'middle';

      // 우주 타이틀
      _lctx.font = '700 26px -apple-system,sans-serif';
      _lctx.fillStyle = '#ffd70088';
      _lctx.fillText(uv.name, innerWidth / 2, innerHeight / 2 - 36);

      _lctx.font = '400 14px -apple-system,sans-serif';
      _lctx.fillStyle = '#8b949e';
      _lctx.fillText(uv.desc, innerWidth / 2, innerHeight / 2 - 12);

      // 회사 칩
      const compName = TEAM_DEMO.company.name;
      _lctx.font = '600 13px -apple-system,sans-serif';
      const cw = _lctx.measureText(compName).width + 24;
      const cx = innerWidth / 2, cy = innerHeight / 2 + 16;
      roundRect(_lctx, cx - cw/2, cy - 12, cw, 24, 12);
      _lctx.fillStyle = 'rgba(88,166,255,0.12)';
      _lctx.fill();
      _lctx.strokeStyle = '#58a6ff50';
      _lctx.lineWidth = 1;
      _lctx.stroke();
      _lctx.fillStyle = '#79c0ff';
      _lctx.fillText(compName, cx, cy + 1);

      _lctx.font = '400 11px -apple-system,sans-serif';
      _lctx.fillStyle = '#6e7681';
      _lctx.fillText(TEAM_DEMO.company.desc, innerWidth / 2, innerHeight / 2 + 40);
      _lctx.restore();
    }
    // LOD 2: 회사 뷰 — 상단 브레드크럼
    else if (lod === 2) {
      _lctx.save();
      _lctx.textAlign = 'center';
      _lctx.textBaseline = 'middle';
      const breadcrumb = `${TEAM_DEMO.universe.name}  ›  ${TEAM_DEMO.company.name}  ›  ${TEAM_DEMO.name}`;
      _lctx.font = '400 12px -apple-system,sans-serif';
      const bw = _lctx.measureText(breadcrumb).width + 28;
      const bx = innerWidth / 2, by = 54;
      roundRect(_lctx, bx - bw/2, by - 12, bw, 24, 12);
      _lctx.fillStyle = 'rgba(13,17,23,0.85)';
      _lctx.fill();
      _lctx.strokeStyle = '#21262d';
      _lctx.lineWidth = 1;
      _lctx.stroke();
      _lctx.fillStyle = '#6e7681';
      _lctx.fillText(breadcrumb, bx, by + 1);
      _lctx.restore();
    }
  }

  // ── 숨긴 노드 필터 (개인뷰 _hiddenNodes 연동) ──
  const _hidden = (typeof _hiddenNodes !== 'undefined') ? _hiddenNodes : {};

  // ══ Pass 1: 모든 레이블 데이터 수집 (드로우 없음) ═══════════════════════
  const labels = [];
  for (const node of _teamNodes) {
    const sc = toScreen(node.pos);
    if (sc.z > 1) continue;
    if (node.hidden) continue;
    const { type, label, sublabel, color, emoji, progress, taskStatus, memberId } = node;
    // 개인뷰에서 숨긴 노드 → 팀뷰에서 task만 숨김 (member/goal/department는 유지)
    if (type === 'task' && (_hidden[node.label] || _hidden[node.sublabel])) continue;
    // 사용자 노드 밀도 설정 (_nodeDensity 슬라이더)
    if (type === 'tool'                          && _nodeDensity < 4) continue;
    if ((type === 'skill' || type === 'agent')   && _nodeDensity < 3) continue;
    if (type === 'task'                          && _nodeDensity < 2) continue;
    // LOD 기반 — 줌 레벨로 계층 구분 (밀도 설정과 무관)
    if (lod >= 2 && type === 'member')           continue;
    if (lod >= 3 && type === 'department')       continue;
    // 노드 필터 적용
    if (typeof nodeMatchesFilter === 'function' && !nodeMatchesFilter(node)) continue;

    const isActive   = taskStatus === 'active';
    const isSelected = _selectedHit?.data === node;
    const isFocused  = _focusedMember === node;

    let pxSize, pad;
    if      (type === 'goal')         { pxSize = lod >= 2 ? 22 : 28; pad = lod >= 2 ? 14 : 20; }
    else if (type === 'department')   { pxSize = lod >= 2 ? 14 : 16; pad = lod >= 2 ? 10 : 13; }
    else if (type === 'member')       { pxSize = lod >= 2 ? 14 : isFocused ? 22 : 18; pad = lod >= 2 ? 10 : isFocused ? 18 : 15; }
    else if (type === 'task')         { pxSize = lod >= 2 ? 9 : 12; pad = lod >= 2 ? 7 : 10; }
    else if (type === 'skill')        { pxSize = 9; pad = 7; }
    else if (type === 'agent')        { pxSize = 9; pad = 7; }
    else if (type === 'ptask')        { pxSize = 13; pad = 11; }
    else if (type === 'prequest')     { pxSize = 16; pad = 14; }
    else if (type === 'presult')      { pxSize = 15; pad = 13; }
    // ── Multi-hub / Enterprise new node types ──────────────────────────────
    else if (type === 'leader')       { pxSize = 20; pad = 16; }   // 리더 (대형)
    else if (type === 'sharedProject'){ pxSize = 16; pad = 13; }   // 공동 프로젝트
    else if (type === 'hubProject')   { pxSize = 13; pad = 10; }   // 허브 프로젝트
    else if (type === 'infra')        { pxSize = 18; pad = 14; }   // 인프라 (대형)
    else if (type === 'hq')           { pxSize = 14; pad = 11; }   // HQ
    else if (type === 'dept')         { pxSize = 12; pad = 9;  }   // 부서 라벨
    else if (type === 'external')     { pxSize = 13; pad = 10; }   // 외주 파트너
    else                              { pxSize = 10; pad = 7; }

    const weight = (type === 'goal' || type === 'leader' || type === 'infra' || type === 'member' || type === 'department' || type === 'sharedProject' || type === 'prequest' || type === 'presult') ? '700' : '500';
    _lctx.font = `${weight} ${pxSize}px -apple-system,'Segoe UI',sans-serif`;
    // skill: ⚡ 아이콘, agent: 🤖 아이콘 prefix
    const prefix = type === 'skill' ? '⚡ ' : type === 'agent' ? '🤖 ' : '';
    // 별명 우선 적용 (사용자 지정 표시명 — 3D 뷰 pill에 반영)
    const _alias = typeof _nodeAliases !== 'undefined' ? _nodeAliases[label] : null;
    const displayLabel = node.displayLabel || _alias || label;
    const txt = emoji ? `${emoji} ${displayLabel}` : `${prefix}${displayLabel}`;
    const _useUnified = ['goal','leader','infra','sharedProject','department',
      'member','hubProject','hq','external','prequest','presult'].includes(type);
    // 구체 노드: 지름 기반 크기, pill 노드: 텍스트 기반
    const _sphereR = type === 'goal' ? 22 : type === 'leader' || type === 'infra' ? 20
      : type === 'member' ? 16 : type === 'department' ? 18 : 14;
    const pw  = _useUnified ? _sphereR * 2 : Math.min(_lctx.measureText(txt).width + pad, 120);
    const ph  = _useUnified ? _sphereR * 2 : pxSize + pad * 0.65;
    // priority: prequest=7, goal/leader=6, presult/department/infra/sharedProject=5, member/ptask/hq=4, skill/agent/hubProject/external=3, task/dept=2, tool=1
    const priority = type === 'prequest' ? 7
      : (type === 'goal' || type === 'leader') ? 6
      : (type === 'presult' || type === 'department' || type === 'infra' || type === 'sharedProject') ? 5
      : (type === 'member' || type === 'ptask' || type === 'hq') ? 4
      : (type === 'skill' || type === 'agent' || type === 'hubProject' || type === 'external') ? 3
      : (type === 'task' || type === 'dept') ? 2 : 1;

    labels.push({
      node, sc, type, label, sublabel, color, emoji, progress,
      taskStatus, memberId, isActive, isSelected, isFocused, prefix,
      txt, pw, ph, pxSize, pad, weight, _useUnified,
      x:  sc.x - pw * 0.5,
      y:  sc.y - ph * 0.5,
      ax: sc.x,
      ay: sc.y,
      priority,
    });
  }

  // ══ Pass 2: 겹침 해소 (LOD3 유니버스 뷰 제외) ════════════════════════════
  if (lod < 3 && labels.length > 1) {
    resolveOverlaps(labels);
  }

  // ══ Pass 3: 활성 이펙트 먼저 그리기 (앵커 위치 기준) ════════════════════
  for (const lr of labels) {
    const { ax, ay, color, pw, ph, type, node } = lr;
    const hr = Math.max(pw, ph) * 0.5;

    // 마켓 이펙트 (모든 노드 타입 — _nodeEffects 기반)
    const nodeEffectId = _nodeEffects[node.label];
    if (nodeEffectId && EFFECT_FNS[nodeEffectId]) {
      EFFECT_FNS[nodeEffectId](_lctx, ax, ay, hr, color, now);
    }

    // 이펙트 제거됨 (회전링/펄스/파티클)
    if (!lr.isActive || type !== 'task') continue;
    // 외부 글로우
    const gr = _lctx.createRadialGradient(ax, ay, hr, ax, ay, hr + 28);
    gr.addColorStop(0, color + '44');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    _lctx.fillStyle = gr;
    _lctx.beginPath();
    _lctx.arc(ax, ay, hr + 28, 0, Math.PI * 2);
    _lctx.fill();
  }

  // ══ Pass 4: 리더 라인 (레이블이 앵커에서 멀어진 경우) ════════════════════
  for (const lr of labels) {
    if (lr.type === 'tool') continue;
    const cx = lr.x + lr.pw * 0.5;
    const cy = lr.y + lr.ph * 0.5;
    const dx = cx - lr.ax, dy = cy - lr.ay;
    const disp = Math.sqrt(dx * dx + dy * dy);
    if (disp > 14) {
      _lctx.save();
      _lctx.strokeStyle = lr.color + '55';
      _lctx.lineWidth   = 0.8;
      // _lctx.setLineDash([3, 4]);
      _lctx.globalAlpha = Math.min(disp / 40, 0.7);
      _lctx.beginPath();
      _lctx.moveTo(lr.ax, lr.ay);
      _lctx.lineTo(cx, cy);
      _lctx.stroke();
      // _lctx.setLineDash([]);
      _lctx.restore();
    }
  }

  // ══ Pass 5: 레이블 드로우 (해소된 위치 기준) ════════════════════════════
  for (const lr of labels) {
    const { x, y, pw, ph, type, color, txt, pxSize, pad, weight,
            sublabel, progress, isActive, isSelected, isFocused,
            node, memberId, ax, ay } = lr;
    const cx = x + pw * 0.5;  // 해소된 center x
    const cy = y + ph * 0.5;  // 해소된 center y
    const hr = Math.max(pw, ph) * 0.5;

    // ── 포커스 페이드: 포커스된 팀원과 관계없는 노드는 흐리게 ──────────────
    let nodeFade = 1.0;
    if (_focusedMember) {
      const focusId = _focusedMember.memberId;
      const isRelated =
        type === 'goal' ||                          // 목표 노드는 항상 표시
        memberId === focusId ||                     // 포커스된 팀원 본인
        (_collabLines || []).some(cl =>             // 협업 연결된 팀원
          (cl.fromNode?.memberId === focusId && cl.toNode?.memberId === memberId) ||
          (cl.toNode?.memberId   === focusId && cl.fromNode?.memberId === memberId)
        );
      nodeFade = isRelated ? 1.0 : 0.10;
    }
    if (nodeFade < 1.0) {
      _lctx.globalAlpha = nodeFade;
    }

    // 포커스 팀원 링
    if (isFocused && type === 'member') {
      const rp = (Math.sin(now * 3) + 1) * 0.5;
      _lctx.save();
      _lctx.globalAlpha = 0.35 + rp * 0.25;
      _lctx.strokeStyle = color;
      _lctx.lineWidth   = 3;
      _lctx.shadowColor = color;
      _lctx.shadowBlur  = 16;
      _lctx.beginPath();
      _lctx.arc(cx, cy, hr + 10, 0, Math.PI * 2);
      _lctx.stroke();
      _lctx.restore();
    }

    // "나" 배지 — 내 멤버 노드 강조
    const isMe = type === 'member' && _myMemberId && memberId === _myMemberId;
    if (isMe) {
      // 초록 글로우 링
      const mePulse = (Math.sin(now * 2.5) + 1) * 0.5;
      _lctx.save();
      _lctx.globalAlpha = 0.4 + mePulse * 0.3;
      _lctx.strokeStyle = '#3fb950';
      _lctx.lineWidth   = 2.5;
      _lctx.shadowColor = '#3fb950';
      _lctx.shadowBlur  = 14 + mePulse * 8;
      // _lctx.setLineDash([5, 4]);
      // _lctx.lineDashOffset = -now * 14;
      _lctx.beginPath();
      _lctx.arc(cx, cy, hr + 13, 0, Math.PI * 2);
      _lctx.stroke();
      // _lctx.setLineDash([]);
      _lctx.restore();
      // "나" 칩
      _lctx.save();
      _lctx.font = '700 9px -apple-system,sans-serif';
      _lctx.fillStyle = '#3fb950';
      _lctx.textAlign = 'center'; _lctx.textBaseline = 'middle';
      const chipW = 22, chipH = 14;
      roundRect(_lctx, cx - chipW/2, y - chipH - 2, chipW, chipH, 7);
      _lctx.fillStyle = 'rgba(63,185,80,0.2)'; _lctx.fill();
      _lctx.strokeStyle = '#3fb95080'; _lctx.lineWidth = 1;
      roundRect(_lctx, cx - chipW/2, y - chipH - 2, chipW, chipH, 7); _lctx.stroke();
      _lctx.fillStyle = '#3fb950';
      _lctx.fillText('나', cx, y - chipH/2 - 2);
      _lctx.restore();
    }

    // 포커스 부서 링 (회사 모드)
    if (_focusedDept && type === 'department' && node.deptId === _focusedDept.deptId) {
      const rp2 = (Math.sin(now * 2) + 1) * 0.5;
      _lctx.save();
      _lctx.globalAlpha = 0.30 + rp2 * 0.20;
      _lctx.strokeStyle = color;
      _lctx.lineWidth   = 2.5;
      _lctx.shadowColor = color;
      _lctx.shadowBlur  = 18;
      // _lctx.setLineDash([6, 4]);
      _lctx.beginPath();
      _lctx.arc(cx, cy, hr + 12, 0, Math.PI * 2);
      _lctx.stroke();
      // _lctx.setLineDash([]);
      _lctx.restore();
    }

    // ── external 파트너: 다이아몬드 테두리 오버레이 ───────────────────────
    if (type === 'external') {
      const dSize = Math.max(pw, ph) * 0.65 + 10;
      _lctx.save();
      _lctx.translate(cx, cy);
      _lctx.rotate(Math.PI / 4);
      _lctx.strokeStyle = color;
      _lctx.lineWidth = 1.5;
      _lctx.globalAlpha = 0.65;
      // _lctx.setLineDash([4, 3]);
      _lctx.strokeRect(-dSize / 2, -dSize / 2, dSize, dSize);
      // _lctx.setLineDash([]);
      _lctx.restore();
    }

    // ── 와이어프레임 구체 → 카드 렌더링 (글로우 구체 제거) ───────────────────
    if (lr._useUnified) {
      drawUnifiedCard(_lctx, cx, cy, color, txt, sublabel || '', isActive, isSelected, isFocused);
      // 활성 표시 (task일 때)
      if (isActive && type === 'task') {
        _lctx.save();
        _lctx.fillStyle = '#22c55e'; _lctx.shadowColor = '#22c55e'; _lctx.shadowBlur = 6;
        _lctx.beginPath(); _lctx.arc(cx + nodeR - 4, cy - nodeR + 4, 3.5, 0, Math.PI * 2); _lctx.fill();
        _lctx.restore();
      }
    } else {
      // pill 렌더링 — 배경/테두리 색상 제거, 그리드만 색상 유지
      roundRect(_lctx, x, y, pw, ph, ph * 0.5);
      _lctx.fillStyle = 'rgba(2,6,23,0.72)';
      _lctx.fill();
      drawWireframeGrid(_lctx, x, y, pw, ph, ph * 0.5, color, isActive ? 0.32 : 0.20);

      _lctx.strokeStyle = 'rgba(255,255,255,0.08)';
      _lctx.lineWidth = 0.8;
      roundRect(_lctx, x, y, pw, ph, ph * 0.5); _lctx.stroke();
      if (type === 'agent') {
        _lctx.globalAlpha = 0.4; _lctx.lineWidth = 0.8;
        roundRect(_lctx, x - 2, y - 2, pw + 4, ph + 4, (ph + 4) * 0.5); _lctx.stroke(); _lctx.globalAlpha = 1;
      }

      // pill 텍스트
      _lctx.font = `${weight} ${pxSize}px -apple-system,'Segoe UI',sans-serif`;
      _lctx.fillStyle = type === 'skill' ? '#e2c9ff' : type === 'agent' ? '#8ff0ea' : (isSelected ? '#ffffff' : '#c9d1d9');
      _lctx.textAlign = 'center'; _lctx.textBaseline = 'middle';
      if (isActive && type === 'task') { _lctx.shadowColor = color; _lctx.shadowBlur = 8; }
      if (type === 'skill') { _lctx.shadowColor = '#d2a8ff'; _lctx.shadowBlur = 4; }
      if (type === 'agent') { _lctx.shadowColor = '#39d2c0'; _lctx.shadowBlur = 4; }
      _lctx.fillText(txt, cx, cy);
      _lctx.shadowBlur = 0;
    }

    // 관리자 뱃지 (member 노드, LOD1 이하)
    if (type === 'member' && lod <= 1 && memberId) {
      renderMgrBadges(memberId, cx, y + ph);
    }

    // 진행률 바 (task, lod ≤ 1)
    if (type === 'task' && typeof progress === 'number' && lod <= 1) {
      const barW = pw - 6;
      const barY = y + ph + 6;
      _lctx.globalAlpha = 0.45;
      roundRect(_lctx, cx - barW * 0.5, barY, barW, 3, 1.5);
      _lctx.fillStyle = '#21262d'; _lctx.fill();
      if (progress > 0) {
        roundRect(_lctx, cx - barW * 0.5, barY, barW * progress, 3, 1.5);
        _lctx.fillStyle = color; _lctx.fill();
        if (isActive) {
          _lctx.globalAlpha = 0.6;
          _lctx.fillStyle   = '#ffffff';
          _lctx.fillRect(cx - barW * 0.5 + barW * progress - 2, barY, 2, 3);
        }
      }
      _lctx.globalAlpha = 1;
    }

    // 포커스 팀원 — 작업 미니 뱃지
    if (type === 'member' && isFocused && lod === 0) {
      const srcMembers = _companyMode
        ? (_activeSimData?.departments || []).flatMap(d => d.members || [])
        : (_activeSimData?.members || []);
      const member = srcMembers.find(m => m.id === memberId);
      if (member) {
        let bOff = ph * 0.5 + 14;
        member.tasks.slice(0, 3).forEach(t => {
          const sc2 = STATUS_CFG[t.status] || STATUS_CFG.pending;
          _lctx.font = `500 10px -apple-system,sans-serif`;
          const tl2  = `${sc2.emoji} ${t.name.slice(0, 12)}${t.name.length > 12 ? '…' : ''}`;
          const tw2  = _lctx.measureText(tl2).width + 12;
          const tx2  = cx - tw2 * 0.5;
          const ty2  = cy + bOff;
          roundRect(_lctx, tx2, ty2, tw2, 16, 8);
          _lctx.fillStyle = sc2.color + '18'; _lctx.fill();
          _lctx.strokeStyle = sc2.color + '60'; _lctx.lineWidth = 0.8;
          roundRect(_lctx, tx2, ty2, tw2, 16, 8); _lctx.stroke();
          _lctx.fillStyle = sc2.color;
          _lctx.textAlign = 'center'; _lctx.textBaseline = 'middle';
          _lctx.fillText(tl2, cx, ty2 + 8);
          bOff += 20;
        });
      }
    }

    // 히트 영역 (해소된 위치 기준)
    if (type !== 'tool') {
      registerHitArea({ cx, cy, r: hr + 4, data: node });
    }

    // globalAlpha 복원
    if (nodeFade < 1.0) {
      _lctx.globalAlpha = 1.0;
    }
  }
}

