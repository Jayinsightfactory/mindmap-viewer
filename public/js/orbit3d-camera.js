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
      lerpCameraTo(100, 0, 0, 0);
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
  lerpCameraTo(100, 0, 0, 0, 800);
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
      const dy = (parseInt(p.userData.deptId.replace('d','')) % 2 === 0) ? 4 : -4;
      p.position.set(orbitR * Math.cos(a), dy, orbitR * Math.sin(a));
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
        s.position.set(deptP.position.x + orbitR * Math.cos(a), deptP.position.y + (mi ? 1.2 : -1.2), deptP.position.z + orbitR * Math.sin(a));
      } else if ((s.userData.isTeamTask || s.userData.isTeamTool || s.userData.isTeamSkill || s.userData.isTeamAgent) && memberP) {
        const center = memberP.position;
        if (s.userData.isTeamTask) {
          const { orbitR, orbitAngle, orbitSpeed } = s.userData;
          const a = orbitAngle + _clock * orbitSpeed;
          s.position.set(center.x + orbitR * Math.cos(a), center.y + orbitR * 0.3 * Math.sin(a + 0.8), center.z + orbitR * Math.sin(a));
        } else {
          const { relAngle, relY, relR } = s.userData;
          s.position.set(center.x + relR * Math.cos(relAngle), center.y + relY, center.z + relR * Math.sin(relAngle));
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

  // ── 팀 모드: 공전 비활성화 (고정 위치) ──────────────────────────────────
  // 멤버와 위성은 buildTeamSystem에서 배치한 고정 위치를 유지한다.
  // 공전 애니메이션 없음 — 위치 업데이트 불필요.
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
  const ctx = window._lctx;
  const cvs = window._labelCanvas2d;
  if (!ctx || !cvs) return;
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  if (typeof clearHitAreas === 'function') clearHitAreas();
  if (!_teamNodes || _teamNodes.length === 0) return;

  const cam = window.camera;
  if (!cam) return;

  _teamNodes.forEach(n => {
    if (!n.pos) return;
    const v = n.pos.clone();
    if (n.obj && n.obj.position) v.copy(n.obj.position);
    v.project(cam);
    if (v.z > 1) return;

    const cx = (v.x * 0.5 + 0.5) * cvs.width;
    const cy = (-v.y * 0.5 + 0.5) * cvs.height;
    if (cx < -100 || cx > cvs.width + 100 || cy < -100 || cy > cvs.height + 100) return;

    const alpha = Math.max(0.3, Math.min(1, 1 - v.z * 0.8));
    ctx.globalAlpha = alpha;

    const sizes = { xl: 16, lg: 14, md: 13, sm: 11, xs: 10 };
    const fontSize = sizes[n.size] || 13;

    ctx.font = `600 ${fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = n.color || '#e6edf3';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillText(n.label || '', cx, cy);
    ctx.shadowBlur = 0;

    if (n.sublabel) {
      ctx.font = `400 ${Math.max(fontSize - 3, 9)}px system-ui, sans-serif`;
      ctx.fillStyle = '#8b949e';
      ctx.fillText(n.sublabel, cx, cy + fontSize + 2);
    }

    ctx.globalAlpha = 1.0;
  });
}

