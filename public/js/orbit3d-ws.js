// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — WebSocket, realtime toasts (keylog, activity, skills)
// ══════════════════════════════════════════════════════════════════════════════

// ─── 실시간 활동 브랜치 확장 시스템 ─────────────────────────────────────────
let _lastLiveActivity = null;   // 마지막으로 감지된 활동 { app, title, type, timestamp }
let _liveBranchNodes  = [];     // 실시간으로 추가된 임시 브랜치 노드
let _liveBranchTimer  = null;   // 브랜치 노드 자동 정리 타이머

function _addLiveBranch(eventData) {
  const app   = eventData.app   || '';
  const title = eventData.title || '';
  const url   = eventData.url   || '';
  const type  = eventData.type  || eventData.activityType || '';

  // 같은 활동이면 무시
  if (_lastLiveActivity &&
      _lastLiveActivity.app === app &&
      _lastLiveActivity.title === title) return;

  const prev = _lastLiveActivity;
  _lastLiveActivity = { app, title, url, type, timestamp: Date.now() };

  // 의미있는 라벨 생성
  const label = extractIntent({
    type: url ? 'browse' : 'app_switch',
    data: eventData,
  });
  if (!label) return;

  // 가장 최근 활성 행성 또는 첫 번째 행성을 부모로 사용
  let parentPlanet = planetMeshes[0];
  for (const p of planetMeshes) {
    if (glowIntensity(p.userData.clusterId) > 0) {
      parentPlanet = p;
      break;
    }
  }
  if (!parentPlanet) return;

  // ── 새 브랜치 위성 노드 생성 ─────────────────────────────────────────
  const branchIdx  = _liveBranchNodes.length;
  const baseAngle  = (branchIdx * Math.PI * 0.4) + Math.PI * 0.25;
  const branchR    = 12 + branchIdx * 3;
  const sx = parentPlanet.position.x + branchR * Math.cos(baseAngle);
  const sy = parentPlanet.position.y + (branchIdx % 2 === 0 ? 2 : -2);
  const sz = parentPlanet.position.z + branchR * Math.sin(baseAngle);

  const branchNode = new THREE.Object3D();
  branchNode.position.set(
    parentPlanet.position.x,  // 시작: 부모 위치
    parentPlanet.position.y,
    parentPlanet.position.z
  );
  branchNode.userData.isFileSat   = true;
  branchNode.userData.isLiveBranch = true;
  branchNode.userData.clusterId   = parentPlanet.userData.clusterId;
  branchNode.userData.sessionId   = parentPlanet.userData.sessionId;
  branchNode.userData.fileLabel   = label;
  branchNode.userData.filename    = app || title;
  branchNode.userData.count       = 1;
  branchNode.userData.isWrite     = false;
  branchNode.userData.planetHex   = parentPlanet.userData.hueHex || '#58a6ff';
  branchNode.userData.orbitR      = branchR;
  branchNode.userData.orbitθ0     = baseAngle;
  branchNode.userData.orbitφ0     = 0;
  branchNode.userData.orbitSpeed  = 0;  // 정적 (애니메이션으로 위치 이동)
  branchNode.userData.orbitCenter = parentPlanet.position;

  // 타겟 위치 (애니메이션용) + 트리 기본 위치
  branchNode.userData._targetPos  = new THREE.Vector3(sx, sy, sz);
  branchNode.userData._treeBasePos = new THREE.Vector3(sx, sy, sz);
  branchNode.userData._birthTime  = performance.now();

  scene.add(branchNode);
  satelliteMeshes.push(branchNode);
  _liveBranchNodes.push(branchNode);

  // 연결선
  const lg = new THREE.BufferGeometry().setFromPoints([
    parentPlanet.position.clone(),
    branchNode.position.clone()
  ]);
  const lm = new THREE.LineBasicMaterial({
    color: new THREE.Color(parentPlanet.userData.hueHex || '#58a6ff'),
    transparent: true, opacity: 0.6
  });
  const conn = new THREE.Line(lg, lm);
  conn.userData.satObj = branchNode;
  conn.userData.isLiveBranch = true;
  connections.push(conn);
  scene.add(conn);

  // 부모 행성에 glow 효과
  markClusterActive(parentPlanet.userData.clusterId);

  // 활동 전환 토스트
  showActivityPulse('app_switch', eventData);

  // 최대 8개까지만 유지 (초과 시 오래된 것 제거)
  while (_liveBranchNodes.length > 8) {
    const old = _liveBranchNodes.shift();
    scene.remove(old);
    const satIdx = satelliteMeshes.indexOf(old);
    if (satIdx >= 0) satelliteMeshes.splice(satIdx, 1);
    // 연결선도 제거
    const connIdx = connections.findIndex(c => c.userData.satObj === old);
    if (connIdx >= 0) {
      scene.remove(connections[connIdx]);
      connections.splice(connIdx, 1);
    }
  }

  // 5초 후 데이터 전체 리로드하여 정식 노드로 대체
  clearTimeout(_liveBranchTimer);
  _liveBranchTimer = setTimeout(() => {
    _cleanupLiveBranches();
    loadData();
  }, 5000);
}

// 라이브 브랜치 애니메이션 (매 프레임 호출)
function _animateLiveBranches() {
  const now = performance.now();
  _liveBranchNodes.forEach(node => {
    const target = node.userData._targetPos;
    const birth  = node.userData._birthTime;
    if (!target) return;

    // 0~600ms 이징 애니메이션
    const elapsed = now - birth;
    const t = Math.min(1, elapsed / 600);
    const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

    const parent = node.userData.orbitCenter;
    if (parent) {
      node.position.lerpVectors(parent, target, ease);
    }
  });
}
window._animateLiveBranches = _animateLiveBranches;

function _cleanupLiveBranches() {
  _liveBranchNodes.forEach(node => {
    scene.remove(node);
    const satIdx = satelliteMeshes.indexOf(node);
    if (satIdx >= 0) satelliteMeshes.splice(satIdx, 1);
    const connIdx = connections.findIndex(c => c.userData.satObj === node);
    if (connIdx >= 0) {
      scene.remove(connections[connIdx]);
      connections.splice(connIdx, 1);
    }
  });
  _liveBranchNodes = [];
}

// ─────────────────────────────────────────────────────────────────────────────
function connectWS() {
  // 로그인 토큰이 있으면 WS URL에 포함 → 서버에서 사용자별 데이터 격리
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = localStorage.getItem('orbit_token') || '';
  const wsUrl = token
    ? `${proto}//${location.host}?token=${encodeURIComponent(token)}`
    : `${proto}//${location.host}`;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = ev => {
    try {
      const m = JSON.parse(ev.data);
      if (m.type === 'new_event' || m.type === 'graph_update') {
        // 실시간 glow: 이벤트가 속한 세션의 모든 행성 클러스터에 빛 효과
        if (m.type === 'new_event') {
          const sid = m.event?.sessionId || m.sessionId;
          if (sid) {
            planetMeshes.forEach(p => {
              if (p.userData.sessionId === sid) {
                markClusterActive(p.userData.clusterId);
              }
            });
          }
        }
        loadData();
      }
      // ── 브라우저/앱 활동 이벤트 → 실시간 브랜치 확장 ────────────────────
      if (m.type === 'browser_activity' || m.type === 'app_switch') {
        _addLiveBranch(m);
      }
      // 듀얼 Ollama 스킬/에이전트 제안 알림
      if (m.type === 'skill_suggestion' && m.data) {
        showSkillToast(m.data);
      }
      // ── 중요 항목 주목 이펙트 (suggestion/anomaly → 금색 펄스) ──────────
      if (m.type === 'skill_suggestion' || m.type === 'anomaly') {
        const targetSid = m.sessionId || m.data?.sessionId;
        if (targetSid) {
          const planet = planetMeshes.find(p => p.userData.sessionId === targetSid || p.userData.clusterId === targetSid);
          if (planet) {
            planet.userData._attention = 1;
            setTimeout(() => { planet.userData._attention = 0; }, 10000);
          }
        }
      }
      // Ollama 실시간 분석 결과
      if (m.type === 'ollama_analysis' && m.data) {
        updateOllamaPanel(m.data, m.eventCount);
        // 목표+단계를 행성 라벨에 반영 (drawLabels에서 참조)
        if (m.data.goal) {
          window._lastOllamaGoal = { goal: m.data.goal, phase: m.data.phase, progress: m.data.progress };
        }
      }
      // 키로거 인사이트 (원문 없음 — 분석 결과만)
      if (m.type === 'keylog_insight' && m.insight) {
        showKeylogInsight(m.insight, m.timestamp);
      }
      // 터미널·VS Code·AI대화 이벤트 → 그래프 업데이트 + 토스트
      if (m.type === 'new_event' && m.event) {
        const et = m.event.type || '';
        if (et.startsWith('terminal.') || et.startsWith('vscode.') || et === 'ai_conversation_saved') {
          loadData();
          showActivityPulse(et, m.event.data);
        }
      }
      // AI 대화 저장 알림 + 작업표시줄 아이템 추가
      if (m.type === 'ai_conversation_saved') {
        showActivityPulse('ai.conversation', { site: m.site, title: m.title });
        if (typeof openDesktopWindow === 'function') {
          openDesktopWindow({
            windowId: 'ai-conv-' + (m.id || Date.now()),
            type: 'ai_tool',
            source: m.site || 'AI',
            title: m.title || m.site || 'AI 대화',
            site: m.site,
            msgCount: m.msgs,
            active: true,
            timestamp: new Date().toISOString(),
          });
        }
      }
      // 즐겨찾기/메모 변경 → 캐시 새로고침
      if (m.type === 'bookmarkUpdate' && typeof loadBookmarks === 'function') loadBookmarks();
      if (m.type === 'memoUpdate' && typeof loadMemos === 'function') loadMemos();
    } catch{}
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
}

// ── Ollama 분석 패널 업데이트 ─────────────────────────────────────────────────
function updateOllamaPanel(data, eventCount) {
  let panel = document.getElementById('ollama-live-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'ollama-live-panel';
    panel.style.cssText = `
      position:fixed; bottom:70px; right:14px; z-index:300;
      background:rgba(13,17,23,0.97); border:1px solid #bc8cff40;
      border-radius:14px; padding:12px 14px; width:260px;
      backdrop-filter:blur(16px); box-shadow:0 8px 32px rgba(188,140,255,0.15);
      font-family:-apple-system,'Segoe UI',sans-serif; font-size:12px;
      animation: fadeIn .3s ease;
    `;
    document.body.appendChild(panel);
  }
  const typeIcon = { code:'💻', debug:'🐛', research:'🔍', review:'👁️', meeting:'💬' };
  const icon = typeIcon[data.type] || '⬡';
  const skillsHtml = (data.skills || []).map(s =>
    `<span style="background:rgba(88,166,255,.12);border:1px solid #388bfd40;color:#79c0ff;
     font-size:10px;padding:2px 7px;border-radius:5px;font-weight:600;">${s}</span>`
  ).join(' ');

  // 진행 상태 바
  const progressMap = { '초기': 15, '진행중': 50, '마무리': 85, '완료': 100 };
  const progressPct = progressMap[data.progress] || 30;
  const progressColor = progressPct >= 85 ? '#3fb950' : progressPct >= 40 ? '#58a6ff' : '#bc8cff';

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
      <div style="width:6px;height:6px;border-radius:50%;background:#bc8cff;
        box-shadow:0 0 6px #bc8cff;animation:blink-badge 1.5s infinite;"></div>
      <span style="font-size:10px;color:#6e7681;letter-spacing:.5px;text-transform:uppercase;">
        Ollama 실시간 · ${eventCount}건</span>
      <button onclick="document.getElementById('ollama-live-panel').remove()"
        style="margin-left:auto;background:none;border:none;color:#6e7681;cursor:pointer;font-size:13px;">✕</button>
    </div>
    ${data.goal ? `
    <div style="background:#161b22;border-radius:8px;padding:8px 10px;margin-bottom:8px;">
      <div style="font-size:10px;color:#6e7681;margin-bottom:4px;">🎯 목표</div>
      <div style="font-weight:700;color:#e6edf3;font-size:13px;">${data.goal}</div>
      ${data.phase ? `<div style="color:#79c0ff;font-size:11px;margin-top:3px;">→ ${data.phase}</div>` : ''}
      <div style="margin-top:6px;height:4px;background:#21262d;border-radius:2px;overflow:hidden;">
        <div style="width:${progressPct}%;height:100%;background:${progressColor};border-radius:2px;transition:width .5s;"></div>
      </div>
      <div style="text-align:right;font-size:9px;color:#6e7681;margin-top:2px;">${data.progress || '진행중'}</div>
    </div>` : ''}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:18px;">${icon}</span>
      <div>
        <div style="font-weight:700;color:#e6edf3;font-size:13px;">${data.focus || '작업 중'}</div>
        <div style="color:#8b949e;font-size:11px;margin-top:2px;">${data.summary || ''}</div>
      </div>
    </div>
    ${skillsHtml ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px;">${skillsHtml}</div>` : ''}
    ${data.suggestion ? `
      <div style="background:#161b22;border-left:2px solid #bc8cff;border-radius:4px;
        padding:6px 8px;color:#cdd9e5;font-size:11px;line-height:1.5;">
        💡 ${data.suggestion}
      </div>` : ''}
  `;

  // 30초 후 자동 닫힘
  clearTimeout(panel._closeTimer);
  panel._closeTimer = setTimeout(() => panel?.remove(), 30000);
}

// ── 키로거 인사이트 토스트 ────────────────────────────────────────────────────
// 원문 없이 Ollama 분석 결과(주제/활동/키워드)만 표시
function showKeylogInsight(insight, timestamp) {
  if (!insight) return;

  // 활동 타입별 아이콘
  const actIcons = {
    '이메일': '📧', '채팅': '💬', '문서작성': '📝',
    '코딩': '💻', '검색': '🔍', '기타': '⌨️',
  };
  const icon = actIcons[insight.activity] || '⌨️';

  // 키워드 3개까지 표시
  const kwText = (insight.keywords || []).slice(0, 3).join(' · ');

  // 토스트 DOM 생성
  const toast = document.createElement('div');
  toast.className = 'keylog-toast';
  toast.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(13,17,23,0.95); border: 1px solid #3fb950;
    border-radius: 12px; padding: 10px 16px; z-index: 9999;
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; color: #e6edf3; min-width: 260px; max-width: 420px;
    box-shadow: 0 4px 20px rgba(63,185,80,0.2);
    animation: slideUp .3s ease; backdrop-filter: blur(12px);
    pointer-events: none;
  `;
  toast.innerHTML = `
    <span style="font-size:18px">${icon}</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;color:#3fb950;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${icon} ${insight.topic || insight.activity || '키입력'}
      </div>
      <div style="font-size:11px;color:#6e7681;margin-top:2px">
        ${kwText || insight.context || insight.language || ''}
      </div>
    </div>
    <span style="font-size:11px;color:#6e7681;flex-shrink:0">로컬 분석</span>
  `;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0'; toast.style.transition = 'opacity .3s';
    setTimeout(() => toast.remove(), 300);
  }, 4000);

  // 상단 인사이트 스트림에도 추가 (최근 5개 유지)
  _addToKeylogStream(insight, icon);
}

// 좌상단 스트림 패널에 키로그 인사이트 기록 유지
let _keylogStreamEl = null;
const _keylogStreamItems = [];
function _addToKeylogStream(insight, icon) {
  if (!_keylogStreamEl) {
    _keylogStreamEl = document.createElement('div');
    _keylogStreamEl.id = 'keylog-stream';
    _keylogStreamEl.style.cssText = `
      position: fixed; right: 14px; top: 14px; z-index: 200;
      width: 220px; display: flex; flex-direction: column; gap: 4px;
      pointer-events: none;
    `;
    document.body.appendChild(_keylogStreamEl);
  }

  _keylogStreamItems.unshift({ insight, icon, ts: Date.now() });
  if (_keylogStreamItems.length > 5) _keylogStreamItems.pop();

  _keylogStreamEl.innerHTML = _keylogStreamItems.map(item => `
    <div style="
      background: rgba(13,17,23,0.88); border: 1px solid #21262d;
      border-left: 3px solid #3fb950; border-radius: 8px;
      padding: 6px 10px; font-size: 11px; color: #8b949e;
    ">
      <span style="color:#3fb950">${item.icon}</span>
      <span style="color:#e6edf3;font-weight:600"> ${item.insight.topic || item.insight.activity}</span>
      <span style="float:right;color:#6e7681">${item.insight.language || ''}</span>
    </div>
  `).join('');
}

// ── 활동 펄스 토스트 (터미널·VS Code 이벤트용 미니 알림) ────────────────────
function showActivityPulse(type, data) {
  const icons = {
    'terminal.command':  '⌨️',
    'vscode.file_save':  '💾',
    'vscode.file_open':  '📂',
    'vscode.debug_start':'🐛',
    'ai.conversation':   '💬',
  };
  const icon  = icons[type] || '⚡';
  const label = data?.fileName || data?.command?.slice(0, 30) || data?.title?.slice(0, 30) || type;
  if (typeof showToast === 'function') showToast(`${icon} ${label}`, 2000);
}

// ─── 스킬/에이전트 제안 토스트 ───────────────────────────────────────────────
const _toastTimers = new Map();

function showSkillToast(suggestion) {
  const stack = document.getElementById('skill-toast-stack');
  if (!stack) return;

  // 동일 트리거 중복 방지
  if (_toastTimers.has(suggestion.id)) return;

  const isAgent = suggestion.type === 'agent';
  const conf    = suggestion.evidence?.avgConfidence ?? 0;
  const count   = suggestion.evidence?.patternCount  ?? 0;
  const cat     = suggestion.evidence?.category      ?? '';

  const toast = document.createElement('div');
  toast.className = `skill-toast ${suggestion.type}`;
  toast.innerHTML = `
    <div class="st-header">
      <div class="st-icon">${suggestion.icon || (isAgent ? '🤖' : '📌')}</div>
      <div class="st-title-wrap">
        <span class="st-type-chip">${isAgent ? 'agent' : 'skill'}</span>
        <div class="st-alias">${suggestion.alias || suggestion.trigger}</div>
        <div class="st-trigger">${suggestion.trigger}</div>
      </div>
    </div>
    <div class="st-evidence">
      패턴 <strong>${count}회</strong> 감지 · 신뢰도 <strong>${Math.round(conf * 100)}%</strong> · 카테고리: ${cat}
    </div>
    <div class="st-actions">
      <button class="st-btn accept" onclick="acceptSkillToast('${suggestion.id}', this)">✅ 적용</button>
      <button class="st-btn dismiss" onclick="dismissSkillToast('${suggestion.id}', this)">✕ 닫기</button>
    </div>
  `;

  stack.appendChild(toast);

  // 12초 후 자동 닫기
  const timer = setTimeout(() => dismissSkillToast(suggestion.id, toast), 12000);
  _toastTimers.set(suggestion.id, { el: toast, timer, suggestion });
}

function dismissSkillToast(id, el) {
  if (typeof track === 'function') track('ai.suggestion_dismiss', { id });
  const entry = _toastTimers.get(id);
  const node  = el?.closest?.('.skill-toast') || entry?.el;
  if (node) {
    node.style.opacity  = '0';
    node.style.transform = 'translateY(10px) scale(.97)';
    node.style.transition = 'all .25s';
    setTimeout(() => node.remove(), 260);
  }
  if (entry?.timer) clearTimeout(entry.timer);
  _toastTimers.delete(id);
}

async function acceptSkillToast(id, el) {
  if (typeof track === 'function') track('ai.suggestion_accept', { id });
  const entry = _toastTimers.get(id);
  if (!entry) return;
  try {
    await fetch('/api/insights/feedback/apply', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientId: entry.suggestion.clientId, suggestionId: id }),
    });
    // 수락 노드를 현재 팀 멤버에 추가 (파티클 이펙트)
    if (_myMemberId && typeof _teamNodes !== 'undefined') {
      const mNode = _teamNodes.find(n => n.type === 'member' && n.memberId === _myMemberId);
      if (mNode) {
        const s = entry.suggestion;
        _teamNodes.push({
          type: 'skill', memberId: _myMemberId,
          label: `${s.icon || '📌'} ${s.alias}`,
          pos: mNode.pos.clone().add(new THREE.Vector3(
            (Math.random()-0.5)*4, (Math.random()-0.5)*4, (Math.random()-0.5)*4
          )),
        });
        updateMyTaskSidebar();
      }
    }
  } catch(e) { console.warn('[Toast] 수락 실패:', e); }
  dismissSkillToast(id, el);
}

