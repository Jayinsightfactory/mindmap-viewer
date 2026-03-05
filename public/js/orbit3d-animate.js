// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Animation, interaction, drilldown panels
// ══════════════════════════════════════════════════════════════════════════════
// ─── 애니메이션 — 행성 공전 + 파일위성 공전 ─────────────────────────────────
function updateOrbits(dt) {
  if (!orbitAnimOn) return;
  _clock += dt * 0.00025;

  // 행성 공전 (중심별 주위)
  planetMeshes.forEach(p => {
    const { orbitR, orbitφ, orbitSpeed } = p.userData;
    const θ = p.userData.orbitθ + _clock * orbitSpeed;
    const px = orbitR * Math.sin(orbitφ) * Math.cos(θ);
    const py = orbitR * Math.cos(orbitφ) * 0.32;
    const pz = orbitR * Math.sin(orbitφ) * Math.sin(θ);
    p.position.set(px, py, pz);
    p.userData.orbitCenter.set(0,0,0);
  });

  // 파일 위성 공전 (각 행성 주위)
  satelliteMeshes.forEach(s => {
    const planet = (_sessionMap[s.userData.clusterId] || _sessionMap[s.userData.sessionId])?.planet;
    if (!planet) return;
    const { orbitR, orbitθ0, orbitφ0, orbitSpeed } = s.userData;
    const θ = orbitθ0 + _clock * orbitSpeed * 3;
    const sx = planet.position.x + orbitR * Math.cos(θ) * Math.cos(orbitφ0);
    const sy = planet.position.y + orbitR * Math.sin(orbitφ0);
    const sz = planet.position.z + orbitR * Math.sin(θ) * Math.cos(orbitφ0);
    s.position.set(sx, sy, sz);
    s.userData.orbitCenter = planet.position;
  });

  // 연결선 업데이트 (파일위성 → 행성)
  connections.forEach(line => {
    if (!line.userData.satObj) return;
    const s = line.userData.satObj;
    const planet = (_sessionMap[s.userData.clusterId] || _sessionMap[s.userData.sessionId])?.planet;
    if (!planet) return;
    const pts = [planet.position.clone(), s.position.clone()];
    line.geometry.setFromPoints(pts);
    line.geometry.attributes.position.needsUpdate = true;
  });
}

// ─── 중심별 펄스 ──────────────────────────────────────────────────────────────
let _pulseT = 0;
function pulseSun() {
  _pulseT += 0.02;
  sun.intensity = 2.5 + Math.sin(_pulseT)*0.5;
  sun.position.set(Math.cos(_pulseT*0.1)*5, 3, Math.sin(_pulseT*0.1)*5);
  // 태양 셰이더 시간 업데이트
  if (_coreMeshRef && _coreMeshRef.userData.sunUniforms) {
    _coreMeshRef.userData.sunUniforms.uTime.value = _pulseT;
  }
}

// ─── 인터랙션 — Canvas2D 히트 영역 기반 ─────────────────────────────────────
let _lastMouseEvent = { clientX:0, clientY:0 };
let _hoveredHit     = null;  // { cx, cy, r, data, obj }
let _selectedHit    = null;
let _editingNode    = null;  // 현재 인라인 편집 중인 노드

// 편집 아이콘 요소 (동적으로 위치 변경)
const _editIconEl = document.createElement('div');
_editIconEl.id = 'hover-edit-icon';
_editIconEl.title = '레이블 편집';
_editIconEl.textContent = '✎';
Object.assign(_editIconEl.style, {
  position: 'fixed', zIndex: '600', display: 'none',
  width: '22px', height: '22px', lineHeight: '20px', textAlign: 'center',
  background: 'rgba(31,111,235,0.85)', color: '#fff', borderRadius: '6px',
  fontSize: '13px', cursor: 'pointer', border: '1px solid #388bfd',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5)', userSelect: 'none',
  transition: 'opacity .15s',
});
_editIconEl.addEventListener('click', e => { e.stopPropagation(); openInlineEdit(_hoveredHit); });
document.body.appendChild(_editIconEl);

renderer.domElement.addEventListener('mousemove', e => {
  _lastMouseEvent = e;
});

renderer.domElement.addEventListener('click', e => {
  const hit = hitTest(e.clientX, e.clientY);
  if (hit) {
    _selectedHit = hit;
    const type = hit.data.type;

    // ── 별자리 오브 클릭 → 해당 프로젝트 포커스 ────────────────────────────
    if (type === 'constellation') {
      if (_focusedProject === hit.data.projName) {
        exitConstellationFocus();
      } else {
        focusProject(hit.data.projName);
      }
      return;
    }

    if (_companyMode) {
      // 회사 모드 클릭 처리
      if (type === 'department') {
        if (_focusedDept?.deptId === hit.data.deptId) {
          unfocusDept();  // 같은 부서 재클릭 → 줌아웃
        } else {
          focusDept(hit.data);
        }
      } else if (type === 'member') {
        focusMember(hit.data);
      } else if (type === 'goal' && (_focusedMember || _focusedDept)) {
        unfocusDept();
      }
    } else if (_teamMode) {
      // 팀 모드 클릭 처리
      if (type === 'member') {
        if (_focusedMember === hit.data) {
          drillDownToMember(hit.data);   // 2번째 클릭 → 개인 화면
        } else {
          focusMember(hit.data);          // 1번째 클릭 → 포커스
        }
      } else if (_focusedMember && type === 'goal') {
        unfocusMember();
      }
    }

    showPanel(hit.data, hit.obj);

    // ── 클릭한 노드를 카메라 중심으로 이동 ─────────────────────────────────
    // focusMember/focusDept가 처리하지 않은 나머지 노드: 개인 모드 행성, 태스크, 병렬 노드
    const _alreadyFocused = (_teamMode && type === 'member') ||
                            (_companyMode && (type === 'member' || type === 'department'));
    if (!_alreadyFocused) {
      const p3 = hit.data?.pos;              // _teamNodes 의 THREE.Vector3 pos
      const m3 = hit.obj?.position;          // 개인 모드 planet mesh position
      const tp = (p3 instanceof THREE.Vector3) ? p3 : (m3 instanceof THREE.Vector3 ? m3 : null);
      if (tp) {
        const curR = controls.sph.r;
        // 개인모드는 현재 거리 유지, 팀/병렬 태스크는 적당히 당겨줌
        const targetR = (!_teamMode && !_companyMode && !_parallelMode)
          ? curR
          : Math.min(curR, 40);
        lerpCameraTo(targetR, tp.x, tp.y, tp.z, 450);
      }
    }

  } else {
    _selectedHit = null;
    if ((_teamMode || _companyMode) && (_focusedMember || _focusedDept)) {
      if (_companyMode) unfocusDept(); else unfocusMember();
      closePanel();
    } else {
      closePanel();
      // ── 개인 모드: 빈 공간 클릭 → 전체 "내 화면"으로 복귀 ──────────────
      if (!_teamMode && !_companyMode && !_parallelMode) {
        if (_focusedProject) {
          exitConstellationFocus();          // 별자리 포커스 해제 → 전체 뷰
        } else {
          lerpCameraTo(75, 0, 0, 0, 600);   // 카메라를 기본 위치로 부드럽게 복귀
        }
      }
    }
  }
});

function hitTest(clientX, clientY) {
  // _labelCanvas2d 기준 로컬 좌표로 변환 (사이드바 오프셋 보정)
  const rect = _labelCanvas2d.getBoundingClientRect();
  const mx   = clientX - rect.left;
  const my   = clientY - rect.top;
  for (const h of _hitAreas) {
    const dx = mx - h.cx, dy = my - h.cy;
    if (dx*dx + dy*dy <= h.r*h.r) return h;
  }
  return null;
}

function updateRaycast() {
  const tooltip = document.getElementById('tooltip');
  const hit = hitTest(_lastMouseEvent.clientX, _lastMouseEvent.clientY);

  if (hit) {
    if (hit !== _hoveredHit) {
      _hoveredHit = hit;
      renderer.domElement.style.cursor = 'pointer';
    }
    const data = hit.data;
    if (data) {
      let ttIntent = data.label || data.intent || '';
      let ttMeta   = '';
      if (data.type === 'member')  ttMeta = `👤 ${data.sublabel || ''} · 클릭하여 포커스`;
      else if (data.type === 'task')  ttMeta = `${data.emoji || ''} ${Math.round((data.progress||0)*100)}% 완료`;
      else if (data.type === 'goal')  ttMeta = '🎯 팀 목표';
      else if (data.type === 'file')  ttMeta = `📄 ${data.filename || ''}  ×${data.count || 1}`;
      else ttMeta = data.eventCount ? `세션 • ${data.eventCount}개 작업` : '세션';
      document.getElementById('tt-intent').textContent = ttIntent;
      document.getElementById('tt-meta').textContent   = ttMeta;
      tooltip.style.display = 'block';
      tooltip.style.left = (_lastMouseEvent.clientX + 14) + 'px';
      tooltip.style.top  = (_lastMouseEvent.clientY - 10) + 'px';
      // 편집 아이콘: 레이블 우측에 표시 (편집 중이 아닐 때)
      if (!_editingNode && (data.label || data.intent)) {
        _editIconEl.style.display = 'block';
        _editIconEl.style.left = (hit.cx + hit.r - 2) + 'px';
        _editIconEl.style.top  = (hit.cy - 11) + 'px';
      }
    }
  } else {
    _hoveredHit = null;
    tooltip.style.display = 'none';
    renderer.domElement.style.cursor = 'default';
    // 편집 아이콘 숨김 (마우스가 편집 아이콘 위에 있으면 유지)
    setTimeout(() => {
      if (!_editingNode && document.querySelector('#hover-edit-icon:hover') === null) {
        _editIconEl.style.display = 'none';
      }
    }, 80);
  }
}

// ─── 탭 전환 ──────────────────────────────────────────────────────────────────
let _currentPanelData = null;

function switchTab(name, btn) {
  document.querySelectorAll('.ip-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.ip-tab-pane').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(`ip-pane-${name}`).classList.add('active');
  if (name === 'history' && _currentPanelData) renderHistory(_currentPanelData);
  if (name === 'files'   && _currentPanelData) renderFiles(_currentPanelData);
}
window.switchTab = switchTab;

// ─── 히스토리 탭 렌더 ─────────────────────────────────────────────────────────
function renderHistory(data) {
  const el = document.getElementById('ip-event-list');
  const clusterId = data.clusterId || data.sessionId;
  const entry = _sessionMap[clusterId];
  const events = entry?.events || [];

  if (events.length === 0) {
    el.innerHTML = '<div style="color:#6e7681;font-size:12px;padding:12px 0;text-align:center">이벤트 없음</div>';
    return;
  }

  // 최신 50개
  const slice = [...events].reverse().slice(0, 50);
  el.innerHTML = slice.map(e => {
    const cfg   = typeCfg(e.type);
    const hex   = '#' + new THREE.Color(cfg.color).getHexString();
    const label = e.label || extractIntent(e) || e.type;
    const ts    = e.timestamp ? new Date(e.timestamp).toLocaleTimeString('ko',{hour:'2-digit',minute:'2-digit'}) : '';
    return `
      <div class="ip-event-item" onclick="openEventDetail('${(e.id||e.eventId||'').replace(/'/g,'')}')" title="${label}">
        <div class="ip-event-dot" style="background:${hex}"></div>
        <div class="ip-event-text">${label}</div>
        <div class="ip-event-time">${ts}</div>
      </div>`;
  }).join('');
}

function openEventDetail(id) {
  // 인앱 iframe 패널로 표시 (새 창 대신)
  if (!id) return;
  const url = `/orbit-timeline.html?event=${id}`;
  showInAppPanel(url, '이벤트 상세');
}
window.openEventDetail = openEventDetail;

// ─── 파일 탭 렌더 ─────────────────────────────────────────────────────────────
function renderFiles(data) {
  const el = document.getElementById('ip-file-list');
  const clusterId = data.clusterId || data.sessionId;
  const entry = _sessionMap[clusterId];
  const events = entry?.events || [];

  // 파일 집계 (buildFileSatellites와 동일하지만 더 많이)
  const fileCounts = {};
  for (const e of events) {
    let d = e.data || {};
    const fc = e.fullContent;
    if (fc && typeof fc === 'string' && fc.startsWith('{')) { try { d = {...d,...JSON.parse(fc)}; } catch{} }
    else if (fc && typeof fc === 'string' && fc.includes('/')) d = {...d, filePath: fc};
    const rawPath = d.filePath || d.fileName || '';
    if (!rawPath) continue;
    const fname = rawPath.replace(/\\/g,'/').split('/').pop();
    if (!fname || fname.length < 2) continue;
    if (!fileCounts[fname]) fileCounts[fname] = { count:0, writes:0, path: rawPath };
    fileCounts[fname].count++;
    if (e.type === 'file.write' || (e.type === 'tool.end' && d.toolName === 'Write')) fileCounts[fname].writes++;
  }

  const files = Object.entries(fileCounts).sort((a,b)=>b[1].count-a[1].count).slice(0,30);

  if (files.length === 0) {
    el.innerHTML = '<div style="color:#6e7681;font-size:12px;padding:12px 0;text-align:center">파일 기록 없음</div>';
    return;
  }

  el.innerHTML = files.map(([fname, info]) => {
    const role    = inferFileRole(fname) || '📄';
    const isWrite = info.writes > 0;
    const badge   = isWrite
      ? `<span class="ip-file-badge write">수정 ${info.writes}회</span>`
      : `<span class="ip-file-badge read">읽기</span>`;
    return `
      <div class="ip-file-item" onclick="openFileHistory('${fname.replace(/'/g,'')}')">
        <div class="ip-file-role">${role.split(' ')[0]}</div>
        <div class="ip-file-info">
          <div class="ip-file-name">${fname}</div>
          <div class="ip-file-cnt">접근 ${info.count}회</div>
        </div>
        ${badge}
      </div>`;
  }).join('');
}

function openFileHistory(fname) {
  const url = `/history.html?file=${encodeURIComponent(fname)}`;
  showInAppPanel(url, fname);
}
window.openFileHistory = openFileHistory;

// ─── 인앱 패널 (iframe 오버레이) ──────────────────────────────────────────────
function showInAppPanel(url, title) {
  let overlay = document.getElementById('inapp-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'inapp-overlay';
    overlay.innerHTML = `
      <div id="inapp-header">
        <span id="inapp-title"></span>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="inapp-newtab" title="새 탭에서 열기">↗</button>
          <button id="inapp-close" title="닫기">✕</button>
        </div>
      </div>
      <iframe id="inapp-frame" frameborder="0"></iframe>
    `;
    overlay.style.cssText = 'position:fixed;top:0;right:0;width:50vw;height:100vh;background:#0d1117;border-left:1px solid #30363d;z-index:9999;display:flex;flex-direction:column;box-shadow:-4px 0 20px rgba(0,0,0,0.5);transition:transform .2s ease';
    const header = overlay.querySelector('#inapp-header');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px 16px;background:#161b22;border-bottom:1px solid #30363d;min-height:40px';
    const titleEl = overlay.querySelector('#inapp-title');
    titleEl.style.cssText = 'color:#e6edf3;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    overlay.querySelectorAll('button').forEach(btn => {
      btn.style.cssText = 'background:none;border:1px solid #30363d;color:#8b949e;cursor:pointer;padding:4px 8px;border-radius:6px;font-size:14px';
      btn.onmouseover = () => btn.style.color = '#e6edf3';
      btn.onmouseout  = () => btn.style.color = '#8b949e';
    });
    const frame = overlay.querySelector('#inapp-frame');
    frame.style.cssText = 'flex:1;width:100%;border:none;background:#0d1117';
    overlay.querySelector('#inapp-close').onclick = () => overlay.style.display = 'none';
    overlay.querySelector('#inapp-newtab').onclick = () => {
      window.open(frame.src, '_blank');
      overlay.style.display = 'none';
    };
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';
  overlay.querySelector('#inapp-title').textContent = title || '';
  overlay.querySelector('#inapp-frame').src = url;
}
window.showInAppPanel = showInAppPanel;

// ─── 드릴다운 패널 ────────────────────────────────────────────────────────────
function showPanel(data, obj) {
  _currentPanelData = data;
  if (typeof track === 'function') {
    const mode = typeof _parallelMode !== 'undefined' && _parallelMode ? 'parallel'
               : typeof _companyMode  !== 'undefined' && _companyMode  ? 'company'
               : typeof _teamMode     !== 'undefined' && _teamMode     ? 'team' : 'personal';
    track('node.click', { node_type: data.type || 'unknown', mode });
  }
  const panel = document.getElementById('info-panel');

  // 탭 초기화 (요약으로)
  document.querySelectorAll('.ip-tab').forEach((t,i) => t.classList.toggle('active', i===0));
  document.querySelectorAll('.ip-tab-pane').forEach((p,i) => p.classList.toggle('active', i===0));

  if (data.type === 'session') {
    const hueHex = data.hueHex || '#58a6ff';
    document.getElementById('ip-dot').style.background  = hueHex;
    document.getElementById('ip-type-text').textContent = '작업 클러스터';
    document.getElementById('ip-intent').textContent    = data.intent || '';

    // KV 목록
    const ctx = _sessionContextCache[data.sessionId];
    // ── 현재 활동 상세 표시 (app_switch/browse 이벤트 기반) ──────────────
    const _entry = _sessionMap[data.clusterId || data.sessionId];
    const _sEvs  = _entry?.events || [];
    const _latestAct = [..._sEvs].reverse().find(e =>
      e.type === 'app_switch' || e.type === 'browse' || e.type === 'browser_activity'
    );
    const _actDesc = _latestAct ? extractIntent(_latestAct) : null;

    const kvData = [
      ['작업 수',   `${data.eventCount}개`],
      ['프로젝트',  ctx?.projectName || data.sessionId?.slice(-8) || '-'],
      ['경로',      ctx?.projectDir?.replace(/\\/g,'/').split('/').slice(-2).join('/') || '-'],
    ];
    if (_actDesc) kvData.push(['현재 활동', _actDesc]);
    document.getElementById('ip-kv-list').innerHTML = kvData.map(([k,v]) =>
      `<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`
    ).join('');

    const preview = ctx?.firstMsg || ctx?.autoTitle || '';
    const pv = document.getElementById('ip-preview');
    if (preview) { pv.textContent = preview; pv.style.display = 'block'; }
    else { pv.style.display = 'none'; }

    if (!ctx && data.sessionId) {
      loadSessionContext(data.sessionId).then(c => {
        if (c && _selectedHit?.data === data) showPanel(data, obj);
      });
    }

  } else if (data.type === 'file') {
    document.getElementById('ip-dot').style.background  = '#ffa657';
    document.getElementById('ip-type-text').textContent = '파일 위성';
    document.getElementById('ip-intent').textContent    = data.fileLabel || data.intent || '';

    document.getElementById('ip-kv-list').innerHTML = [
      ['파일명',   data.filename || '-'],
      ['접근 횟수', `${data.count || 1}회`],
      ['역할',     data.isWrite ? '✏️ 수정 대상' : '📄 읽기'],
    ].map(([k,v]) => `<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    document.getElementById('ip-preview').style.display = 'none';

  } else if (data.type === 'member') {
    // ── 팀원/직원 디테일 패널 ───────────────────────────────────────────────
    const srcMembers = _companyMode
      ? (_activeSimData?.departments || []).flatMap(d => d.members || [])
      : (_activeSimData?.members || []);
    const member = srcMembers.find(m => m.id === data.memberId);
    if (!member) return;

    document.getElementById('ip-dot').style.background  = member.color;
    document.getElementById('ip-type-text').textContent = '👤 팀원';
    document.getElementById('ip-intent').textContent    = `${member.name}`;

    const doneCount = member.tasks.filter(t => t.status === 'done').length;
    const activeCount = member.tasks.filter(t => t.status === 'active').length;
    document.getElementById('ip-kv-list').innerHTML = [
      ['역할',   member.role],
      ['진행 중', `${activeCount}개`],
      ['완료',   `${doneCount} / ${member.tasks.length}`],
      ['사용 툴', member.tools.join(', ')],
    ].map(([k,v]) => `<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    // 작업 목록 (서브태스크 포함)
    const taskListHtml = member.tasks.map(t => {
      const sc = STATUS_CFG[t.status] || STATUS_CFG.pending;
      const pct = Math.round(t.progress * 100);
      const subsHtml = (t.subtasks || []).map((sub, si) => {
        const done = si < (t.completedSubtasks || 0);
        return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 6px;border-radius:10px;margin:2px 2px 0 0;background:rgba(255,255,255,0.04);color:${done ? '#3fb950' : '#6e7681'};border:1px solid ${done ? '#3fb95040' : '#21262d'}">${done ? '✓' : '○'} ${sub}</span>`;
      }).join('');
      return `
        <div style="padding:9px 10px;border-radius:9px;border:1px solid ${sc.color}30;background:#0d1117;margin-bottom:7px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
            <span style="font-size:12px;color:#e6edf3;font-weight:600">${t.name}</span>
            <span style="font-size:10px;color:${sc.color};background:${sc.color}18;padding:1px 6px;border-radius:8px">${sc.emoji} ${pct}%</span>
          </div>
          <div style="height:3px;background:#21262d;border-radius:2px;margin-bottom:6px">
            <div style="height:3px;background:${sc.color};border-radius:2px;width:${pct}%"></div>
          </div>
          ${subsHtml ? `<div style="margin-top:4px">${subsHtml}</div>` : ''}
        </div>`;
    }).join('');

    const toolHtml = member.tools.map(t =>
      `<span style="display:inline-block;padding:3px 10px;border-radius:12px;border:1px solid ${member.color}50;color:${member.color};font-size:11px;background:${member.color}12;margin:3px 3px 0 0">${t}</span>`
    ).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="margin-bottom:10px">
        <div style="font-size:10px;color:#6e7681;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px">사용 툴</div>
        ${toolHtml}
      </div>
      <div style="font-size:10px;color:#6e7681;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px">작업 목록</div>
      ${taskListHtml}
    `;
    pv.style.display = 'block';

    // ── 팔로우 버튼 (userId가 있는 실제 유저인 경우) ───────────────────────
    if (member.userId && _orbitUser && member.userId !== (_orbitUser.id || '')) {
      const followBtn = document.createElement('button');
      followBtn.className = 'ip-follow-btn';
      followBtn.id        = `follow-btn-${member.userId}`;
      followBtn.textContent = '+ 팔로우';
      followBtn.onclick   = () => toggleFollow(member.userId, followBtn);
      pv.appendChild(followBtn);
      checkFollowStatus(member.userId, followBtn);
    }

  } else if (data.type === 'task') {
    // ── 작업 디테일 패널 ────────────────────────────────────────────────────
    const srcMembers2 = _companyMode
      ? (_activeSimData?.departments || []).flatMap(d => d.members || [])
      : (_activeSimData?.members || []);
    const member = srcMembers2.find(m => m.id === data.memberId);
    const task   = member?.tasks.find(t => t.name === data.label);
    if (!task || !member) return;

    const sc  = STATUS_CFG[task.status] || STATUS_CFG.pending;
    const pct = Math.round(task.progress * 100);
    document.getElementById('ip-dot').style.background  = sc.color;
    document.getElementById('ip-type-text').textContent = `${sc.emoji} 작업`;
    document.getElementById('ip-intent').textContent    = task.name;

    document.getElementById('ip-kv-list').innerHTML = [
      ['담당자', `${member.name} · ${member.role}`],
      ['상태',   `<span style="color:${sc.color}">${sc.emoji} ${task.status}</span>`],
      ['진행률', `<span style="color:${sc.color};font-weight:700">${pct}%</span>`],
    ].map(([k,v]) => `<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    // 서브태스크
    const subsHtml = (task.subtasks || []).map((sub, si) => {
      const done = si < (task.completedSubtasks || 0);
      return `
        <div class="ip-event-item" style="border-radius:7px;background:${done ? 'rgba(63,185,80,0.06)' : ''}">
          <div class="ip-event-dot" style="background:${done ? '#3fb950' : '#3d444d'}"></div>
          <div class="ip-event-text" style="${done ? 'color:#3fb950;opacity:0.7;text-decoration:line-through' : ''}">${sub}</div>
          <div class="ip-event-time">${done ? '✓' : '○'}</div>
        </div>`;
    }).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
          <span style="font-size:11px;color:#6e7681">진행률</span>
          <span style="font-size:11px;color:${sc.color};font-weight:700">${pct}%</span>
        </div>
        <div style="height:5px;background:#21262d;border-radius:3px;overflow:hidden">
          <div style="height:5px;background:${sc.color};border-radius:3px;width:${pct}%;box-shadow:0 0 6px ${sc.color}80;transition:width .3s"></div>
        </div>
      </div>
      ${task.subtasks?.length ? `
        <div style="font-size:10px;color:#6e7681;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px">
          서브태스크 · ${task.completedSubtasks || 0} / ${task.subtasks.length} 완료
        </div>
        <div class="ip-event-list">${subsHtml}</div>
      ` : ''}
      <div style="margin-top:10px;font-size:11px;color:#6e7681">담당: <span style="color:${member.color}">${member.name}</span> (${member.role})</div>
    `;
    pv.style.display = 'block';

  } else if (data.type === 'ptask' || data.type === 'prequest' || data.type === 'presult') {
    // ── Claude 병렬 태스크 패널 ──────────────────────────────────────────────
    const sc = STATUS_CFG[data.taskStatus] || STATUS_CFG.pending;
    document.getElementById('ip-dot').style.background  = data.color;
    document.getElementById('ip-type-text').textContent = data.type === 'prequest' ? '🧠 Claude 요청' : data.type === 'presult' ? '✅ 완료 결과' : `🤖 ${data.agentType || 'Agent'} 태스크`;
    document.getElementById('ip-intent').textContent    = data.label;

    const pct = data.progress != null ? Math.round(data.progress * 100) : 0;
    document.getElementById('ip-kv-list').innerHTML = [
      ['상태',    `<span style="color:${sc.color}">${sc.emoji} ${data.taskStatus || 'pending'}</span>`],
      ['배치',    data.batchId || '-'],
      ['툴',      data.sublabel || '-'],
      ['진행률',  data.progress != null ? `<span style="color:${sc.color};font-weight:700">${pct}%</span>` : '대기 중'],
    ].map(([k,v]) => `<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
          <span style="font-size:11px;color:#6e7681">진행률</span>
          <span style="font-size:11px;color:${sc.color};font-weight:700">${pct}%</span>
        </div>
        <div style="height:5px;background:#21262d;border-radius:3px;overflow:hidden">
          <div style="height:5px;background:${sc.color};border-radius:3px;width:${pct}%;box-shadow:0 0 6px ${sc.color}80;transition:width .3s"></div>
        </div>
      </div>
      <div style="font-size:11px;color:#6e7681;margin-top:8px">⚡ Claude 병렬 작업 그래프</div>
    `;
    pv.style.display = 'block';

  } else if (data.type === 'goal') {
    // ── 팀/회사 목표 패널 ───────────────────────────────────────────────────
    const sim = _activeSimData || TEAM_DEMO;
    const goalColor = sim.goalColor || '#ffd700';
    const simMembers = _companyMode
      ? (sim.departments || []).flatMap(d => d.members || [])
      : (sim.members || []);
    document.getElementById('ip-dot').style.background  = goalColor;
    document.getElementById('ip-type-text').textContent = _companyMode ? '🏢 회사 목표' : '🎯 팀 목표';
    document.getElementById('ip-intent').textContent    = sim.goal;

    const totalTasks   = simMembers.reduce((s, m) => s + m.tasks.length, 0);
    const doneTasks    = simMembers.reduce((s, m) => s + m.tasks.filter(t => t.status === 'done').length, 0);
    const activeTasks  = simMembers.reduce((s, m) => s + m.tasks.filter(t => t.status === 'active').length, 0);
    const blockedTasks = simMembers.reduce((s, m) => s + m.tasks.filter(t => t.status === 'blocked').length, 0);
    const overallPct   = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;

    document.getElementById('ip-kv-list').innerHTML = [
      _companyMode ? ['회사명', sim.name] : ['팀명', sim.name || TEAM_DEMO.name],
      ['조직', _companyMode ? `${(sim.departments||[]).length}개 부서` : (sim.company?.name || '')],
      ['전체 진행', `${overallPct}%`],
      [_companyMode ? '직원 수' : '팀원 수',  `${simMembers.length}명`],
    ].map(([k,v]) => `<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    const memberHtml = simMembers.map(m => {
      const d  = m.tasks.filter(t => t.status === 'done').length;
      const pct = Math.round(d / m.tasks.length * 100);
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #161b22">
          <div style="width:8px;height:8px;border-radius:50%;background:${m.color};flex-shrink:0"></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:11px;color:#cdd9e5;font-weight:500">${m.name} <span style="color:#6e7681;font-weight:400">${m.role}</span></div>
            <div style="height:3px;background:#21262d;border-radius:2px;margin-top:3px">
              <div style="height:3px;background:${m.color};border-radius:2px;width:${pct}%"></div>
            </div>
          </div>
          <div style="font-size:10px;color:${m.color}">${pct}%</div>
        </div>`;
    }).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="margin-bottom:8px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
          <span style="font-size:11px;color:#6e7681">전체 진행률</span>
          <span style="font-size:11px;color:#ffd700;font-weight:700">${overallPct}%</span>
        </div>
        <div style="height:5px;background:#21262d;border-radius:3px;overflow:hidden">
          <div style="height:5px;background:#ffd700;border-radius:3px;width:${overallPct}%;box-shadow:0 0 8px #ffd70060"></div>
        </div>
        <div style="display:flex;gap:12px;margin-top:6px;font-size:10px">
          <span style="color:#3fb950">✅ 완료 ${doneTasks}</span>
          <span style="color:#58a6ff">⚡ 진행중 ${activeTasks}</span>
          <span style="color:#f0883e">🚧 차단 ${blockedTasks}</span>
        </div>
      </div>
      <div style="font-size:10px;color:#6e7681;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px">${_companyMode ? '직원 현황' : '팀원 현황'}</div>
      ${memberHtml}
    `;
    pv.style.display = 'block';

  } else if (data.type === 'department') {
    // ── 부서 패널 ────────────────────────────────────────────────────────────
    const dept = (_activeSimData?.departments || []).find(d => d.id === data.deptId);
    if (!dept) return;
    const deptMembers = dept.members || [];
    document.getElementById('ip-dot').style.background  = dept.color || '#58a6ff';
    document.getElementById('ip-type-text').textContent = `${dept.icon || '🏢'} 부서`;
    document.getElementById('ip-intent').textContent    = dept.name;

    const dtotal = deptMembers.reduce((s,m)=>s+m.tasks.length,0);
    const ddone  = deptMembers.reduce((s,m)=>s+m.tasks.filter(t=>t.status==='done').length,0);
    const dactive= deptMembers.reduce((s,m)=>s+m.tasks.filter(t=>t.status==='active').length,0);
    const dpct   = dtotal > 0 ? Math.round(ddone/dtotal*100) : 0;

    document.getElementById('ip-kv-list').innerHTML = [
      ['부서명',  dept.name],
      ['인원',    `${deptMembers.length}명`],
      ['진행 중', `${dactive}개`],
      ['완료율',  `${dpct}%`],
    ].map(([k,v])=>`<div class="ip-kv"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

    const dmemberHtml = deptMembers.map(m => {
      const md = m.tasks.filter(t=>t.status==='done').length;
      const mpct = m.tasks.length > 0 ? Math.round(md/m.tasks.length*100) : 0;
      const toolBadges = (m.tools||[]).slice(0,3).map(t=>`<span style="font-size:9px;padding:1px 6px;border-radius:8px;border:1px solid ${dept.color}40;color:${dept.color};background:${dept.color}14">${t}</span>`).join(' ');
      return `
        <div style="padding:7px 8px;border-radius:8px;border:1px solid ${m.color||dept.color}25;background:#0d1117;margin-bottom:6px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:11px;color:#cdd9e5;font-weight:600">${m.name}</span>
            <span style="font-size:10px;color:${m.color||dept.color}">${mpct}%</span>
          </div>
          <div style="font-size:10px;color:#6e7681;margin-bottom:4px">${m.role}</div>
          <div style="height:2px;background:#21262d;border-radius:2px;margin-bottom:5px">
            <div style="height:2px;background:${m.color||dept.color};border-radius:2px;width:${mpct}%"></div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:3px">${toolBadges}</div>
        </div>`;
    }).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="margin-bottom:10px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:11px;color:#6e7681">부서 진행률</span>
          <span style="font-size:11px;color:${dept.color};font-weight:700">${dpct}%</span>
        </div>
        <div style="height:4px;background:#21262d;border-radius:3px;overflow:hidden">
          <div style="height:4px;background:${dept.color};border-radius:3px;width:${dpct}%;box-shadow:0 0 6px ${dept.color}60"></div>
        </div>
      </div>
      <div style="font-size:10px;color:#6e7681;margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px">구성원</div>
      ${dmemberHtml}
    `;
    pv.style.display = 'block';

  } else if (data.type === 'skill') {
    // ── 스킬 패널 ────────────────────────────────────────────────────────────
    const cfg = data.config || {};
    document.getElementById('ip-dot').style.background  = '#d2a8ff';
    document.getElementById('ip-type-text').textContent = '⚡ AI 스킬';
    document.getElementById('ip-intent').textContent    = data.label;

    document.getElementById('ip-kv-list').innerHTML = [
      ['별명(alias)', data.label],
      ['모델',        cfg.model || '-'],
      ['트리거',      cfg.trigger || '-'],
      ['타입',        'skill'],
    ].map(([k,v])=>`<div class="ip-kv"><span class="k">${k}</span><span class="v" style="color:#d2a8ff">${v}</span></div>`).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="background:#1a0e2e;border:1px solid #d2a8ff30;border-radius:10px;padding:12px;font-family:monospace;font-size:11px">
        <div style="color:#6e7681;margin-bottom:6px;font-family:-apple-system,sans-serif;font-size:10px;letter-spacing:.6px;text-transform:uppercase">스킬 설정</div>
        ${cfg.trigger ? `<div style="color:#79c0ff;margin-bottom:3px">trigger: <span style="color:#d2a8ff">${cfg.trigger}</span></div>` : ''}
        ${cfg.model   ? `<div style="color:#79c0ff;margin-bottom:3px">model:   <span style="color:#3fb950">"${cfg.model}"</span></div>` : ''}
        ${cfg.systemPrompt ? `<div style="color:#79c0ff;margin-bottom:3px">prompt:  <span style="color:#e6edf3;font-size:10px">${cfg.systemPrompt.slice(0,60)}…</span></div>` : ''}
      </div>
      <div style="margin-top:8px;font-size:10px;color:#6e7681">⚡ 슬래시 커맨드로 즉시 실행 가능한 저장 스킬</div>
    `;
    pv.style.display = 'block';

  } else if (data.type === 'agent') {
    // ── 에이전트 패널 ─────────────────────────────────────────────────────────
    const cfg = data.config || {};
    document.getElementById('ip-dot').style.background  = '#39d2c0';
    document.getElementById('ip-type-text').textContent = '🤖 AI 에이전트';
    document.getElementById('ip-intent').textContent    = data.label;

    document.getElementById('ip-kv-list').innerHTML = [
      ['별명(alias)', data.label],
      ['모델',        cfg.model || '-'],
      ['역할',        cfg.task  || '-'],
      ['자동 실행',   cfg.autoRun ? '✅ ON' : '❌ OFF'],
    ].map(([k,v])=>`<div class="ip-kv"><span class="k">${k}</span><span class="v" style="color:#39d2c0">${v}</span></div>`).join('');

    const pv = document.getElementById('ip-preview');
    pv.innerHTML = `
      <div style="background:#0b1e1d;border:1px solid #39d2c030;border-radius:10px;padding:12px;font-family:monospace;font-size:11px">
        <div style="color:#6e7681;margin-bottom:6px;font-family:-apple-system,sans-serif;font-size:10px;letter-spacing:.6px;text-transform:uppercase">에이전트 설정</div>
        ${cfg.model   ? `<div style="color:#79c0ff;margin-bottom:3px">model:   <span style="color:#3fb950">"${cfg.model}"</span></div>` : ''}
        ${cfg.task    ? `<div style="color:#79c0ff;margin-bottom:3px">task:    <span style="color:#e6edf3">${cfg.task}</span></div>` : ''}
        ${cfg.autoRun !== undefined ? `<div style="color:#79c0ff;margin-bottom:3px">autoRun: <span style="color:${cfg.autoRun?'#3fb950':'#f85149'}">${cfg.autoRun}</span></div>` : ''}
      </div>
      <div style="margin-top:8px;font-size:10px;color:#6e7681">🤖 ${cfg.autoRun ? '자동으로 백그라운드 실행되는 에이전트' : '수동 트리거 방식 에이전트'}</div>
    `;
    pv.style.display = 'block';
  }

  // ── 메모 + 즐겨찾기 섹션 (요약 탭 하단) ────────────────────────────────
  const eventId = data.clusterId || data.sessionId || data.eventId || data.memberId || '';
  if (eventId && (data.type === 'session' || data.type === 'file')) {
    const summaryPane = document.getElementById('ip-pane-summary');
    if (summaryPane) {
      // 즐겨찾기 버튼 (헤더에 추가)
      let bmBtn = document.getElementById('ip-bookmark-toggle');
      if (!bmBtn) {
        bmBtn = document.createElement('button');
        bmBtn.id = 'ip-bookmark-toggle';
        bmBtn.className = 'ip-bookmark-btn';
        const headerText = document.querySelector('.ip-header-text');
        if (headerText) headerText.parentElement.insertBefore(bmBtn, document.querySelector('.ip-close'));
      }
      const isBM = (typeof _bookmarksCache !== 'undefined' ? _bookmarksCache : []).some(b => b.event_id === eventId);
      bmBtn.textContent = isBM ? '★' : '☆';
      bmBtn.className = 'ip-bookmark-btn' + (isBM ? ' active' : '');
      bmBtn.onclick = async () => {
        const bms = typeof _bookmarksCache !== 'undefined' ? _bookmarksCache : [];
        const existing = bms.find(b => b.event_id === eventId);
        if (existing) {
          await fetch('/api/bookmarks/' + existing.id, { method: 'DELETE' });
        } else {
          await fetch('/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'bm-' + Date.now(), eventId, label: data.intent || data.fileLabel || eventId.slice(-8) })
          });
        }
        if (typeof loadBookmarks === 'function') await loadBookmarks();
        const nowBM = (typeof _bookmarksCache !== 'undefined' ? _bookmarksCache : []).some(b => b.event_id === eventId);
        bmBtn.textContent = nowBM ? '★' : '☆';
        bmBtn.className = 'ip-bookmark-btn' + (nowBM ? ' active' : '');
      };

      // 메모 섹션
      let memoDiv = document.getElementById('ip-memo-section');
      if (!memoDiv) {
        memoDiv = document.createElement('div');
        memoDiv.id = 'ip-memo-section';
        memoDiv.style.cssText = 'padding:8px 0;border-top:1px solid #21262d;margin-top:8px';
        summaryPane.appendChild(memoDiv);
      }
      // 기존 메모 찾기
      const memos = typeof _memosCache !== 'undefined' ? _memosCache : [];
      const existingMemo = memos.find(m => m.event_id === eventId);
      memoDiv.innerHTML = `
        <div style="font-size:10px;color:#6e7681;margin-bottom:4px;text-transform:uppercase;letter-spacing:.6px">메모</div>
        <textarea class="ip-memo-area" id="ip-memo-text" placeholder="이 노드에 대한 메모를 작성하세요…">${existingMemo ? existingMemo.content : ''}</textarea>
        <div class="ip-memo-actions">
          <button class="ip-memo-btn" onclick="saveMemo('${eventId}')">저장</button>
          ${existingMemo ? `<button class="ip-memo-btn del" onclick="deleteMemo('${existingMemo.id}','${eventId}')">삭제</button>` : ''}
        </div>
      `;
    }
  }

  panel.classList.add('open');
  // 이펙트 탭이 열려있으면 선택 노드 업데이트
  const fxPane = document.getElementById('up-pane-fx');
  if (fxPane && fxPane.classList.contains('active')) {
    updateEffectsPanelNode();
  }
}

// ── 팝아웃: info-panel 내용을 바탕화면 윈도우로 분리 ──────────────────────
function popOutCurrentPanel() {
  if (!_currentPanelData) return;
  const data = { ..._currentPanelData };
  data.windowId = 'win-' + (data.clusterId || data.sessionId || data.eventId || Date.now());
  data.title = data.intent || data.fileLabel || data.label || data.sessionId?.slice(-8) || 'Window';
  data.source = data.type;
  if (typeof openDesktopWindow === 'function') {
    openDesktopWindow(data);
    closePanel();
  }
}
window.popOutCurrentPanel = popOutCurrentPanel;

// ── 메모 CRUD 헬퍼 ────────────────────────────────────────────────────────
let _memosCache = [];

async function loadMemos() {
  try {
    const res = await fetch('/api/node-memos');
    _memosCache = await res.json();
  } catch { _memosCache = []; }
}

async function saveMemo(eventId) {
  const content = document.getElementById('ip-memo-text')?.value?.trim();
  if (!content) return;
  const existing = _memosCache.find(m => m.event_id === eventId);
  const id = existing ? existing.id : 'memo-' + Date.now();
  await fetch('/api/node-memos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, eventId, content })
  });
  await loadMemos();
  // 패널 리프레시
  if (_currentPanelData && _selectedHit) showPanel(_currentPanelData, _selectedHit.obj);
}
window.saveMemo = saveMemo;

async function deleteMemo(id, eventId) {
  await fetch('/api/node-memos/' + id, { method: 'DELETE' });
  await loadMemos();
  if (_currentPanelData && _selectedHit) showPanel(_currentPanelData, _selectedHit.obj);
}
window.deleteMemo = deleteMemo;

// 초기 로드
loadMemos();

function closePanel() {
  document.getElementById('info-panel').classList.remove('open');
  _selectedHit = null;
  _currentPanelData = null;
}
window.closePanel = closePanel;

