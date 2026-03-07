// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Talent board, DM panel, inline editing
// ══════════════════════════════════════════════════════════════════════════════
// ─── 인재 보드 (자발적 공개 기반) ────────────────────────────────────────────
const _TALENT_KEY = 'orbitTalentBoard';

// 내 공개 프로필 (localStorage)
function getMyTalentProfile() {
  try { return JSON.parse(localStorage.getItem(_TALENT_KEY + '_me') || 'null'); } catch { return null; }
}
function saveMyTalentProfile(profile) {
  try { localStorage.setItem(_TALENT_KEY + '_me', JSON.stringify(profile)); } catch {}
}

// 현재 작업 기반 스킬 자동 분석
function analyzeMySkilsFromWork() {
  const myId = _myMemberId;
  const skills = new Set();
  const tools  = new Set();
  let analysis = '';

  if (!_teamMode || !_activeSimData) {
    return { skills: [], tools: [], analysis: '팀·회사 시뮬에서 분석 가능합니다.' };
  }

  // 팀 모드: 본인 노드에서 스킬/툴 수집
  const myNode = _teamNodes.find(n => n.type === 'member' && n.memberId === myId);
  const allMembers = _activeSimData?.members ||
    (_activeSimData?.departments || []).flatMap(d => d.members || []);

  const me = allMembers.find(m => m.id === myId) || allMembers[0];
  if (me) {
    (me.tools || []).forEach(t => tools.add(t));
    (me.skills || []).forEach(s => skills.add(s.alias || s));
    (me.tasks || []).forEach(t => {
      // 진행 중 작업의 키워드를 스킬로 추출
      if (t.status === 'active' && t.progress > 0.2) {
        const kw = (t.name || '').replace(/[^\w가-힣\s]/g, '').split(' ')
          .filter(w => w.length > 1).slice(0, 2);
        kw.forEach(k => skills.add(k));
      }
    });
    const activeCount = (me.tasks || []).filter(t => t.status === 'active').length;
    const doneCount   = (me.tasks || []).filter(t => t.status === 'done').length;
    analysis = `현재 ${activeCount}개 작업 진행 중 · ${doneCount}개 완료\n` +
               `주요 툴: ${[...tools].slice(0,3).join(', ')}\n` +
               `이 경험을 공개하면 비슷한 작업을 하는 팀원과 연결될 수 있습니다.`;
  } else {
    analysis = '현재 작업 중인 노드 정보를 분석하고 있습니다.';
  }

  return { skills: [...skills], tools: [...tools], analysis };
}

// 내 능력 공개 패널 열기
let _mtpStatus = 'open';
let _mtpSelectedSkills = new Set();

function openMyTalentPanel() {
  const panel = document.getElementById('my-talent-panel');
  panel.classList.add('open');
  const { skills, tools, analysis } = analyzeMySkilsFromWork();
  document.getElementById('mtp-analysis').textContent = analysis;

  // 스킬 칩 렌더
  const allOptions = [...new Set([...skills, ...tools])];
  const chips = document.getElementById('mtp-skill-chips');
  chips.innerHTML = allOptions.map(s =>
    `<span class="mtp-chip ${_mtpSelectedSkills.has(s) ? 'selected' : ''}"
      onclick="toggleMtpSkill(this,'${s.replace(/'/g,"\\'")}')">${s}</span>`
  ).join('');

  // 기존 프로필 복원
  const existing = getMyTalentProfile();
  if (existing) {
    document.getElementById('mtp-tagline').value = existing.tagline || '';
    _mtpStatus = existing.status || 'open';
    existing.skills?.forEach(s => _mtpSelectedSkills.add(s));
    renderMtpChips();
    updateMtpStatusBtns();
    const btn = document.getElementById('mtp-publish-btn');
    if (existing.published) { btn.textContent = '✅ 공개 중 — 취소하기'; btn.classList.add('published'); }
  }
}
window.openMyTalentPanel = openMyTalentPanel;

function closeMyTalentPanel() { document.getElementById('my-talent-panel').classList.remove('open'); }
window.closeMyTalentPanel = closeMyTalentPanel;

function toggleMtpSkill(el, skill) {
  if (_mtpSelectedSkills.has(skill)) _mtpSelectedSkills.delete(skill);
  else _mtpSelectedSkills.add(skill);
  el.classList.toggle('selected', _mtpSelectedSkills.has(skill));
}
window.toggleMtpSkill = toggleMtpSkill;

function renderMtpChips() {
  document.querySelectorAll('#mtp-skill-chips .mtp-chip').forEach(el => {
    el.classList.toggle('selected', _mtpSelectedSkills.has(el.textContent));
  });
}

function setMtpStatus(s) {
  _mtpStatus = s;
  updateMtpStatusBtns();
}
window.setMtpStatus = setMtpStatus;

function updateMtpStatusBtns() {
  document.getElementById('mtp-st-open').classList.toggle('active', _mtpStatus === 'open');
  document.getElementById('mtp-st-ask').classList.toggle('active',  _mtpStatus === 'ask');
}

function toggleMyPublish() {
  const btn     = document.getElementById('mtp-publish-btn');
  const existing = getMyTalentProfile();
  if (existing?.published) {
    // 공개 취소
    saveMyTalentProfile({ ...existing, published: false });
    btn.textContent = '📡 인재 보드에 공개';
    btn.classList.remove('published');
    renderTalentTicker();
    showHelperToast('🔒 인재 보드 공개가 취소되었습니다.', '#6e7681');
    return;
  }
  // 공개
  const myId = _myMemberId;
  const allMembers = _activeSimData?.members ||
    (_activeSimData?.departments || []).flatMap(d => d.members || []);
  const me = allMembers.find(m => m.id === myId) || allMembers[0];
  if (!me) { showHelperToast('팀/회사 시뮬을 먼저 시작해주세요.', '#f85149'); return; }

  const profile = {
    memberId: me.id, name: me.name, role: me.role, color: me.color || '#58a6ff',
    skills: [..._mtpSelectedSkills],
    tagline: document.getElementById('mtp-tagline').value.trim(),
    status: _mtpStatus,
    published: true,
    publishedAt: Date.now(),
  };
  saveMyTalentProfile(profile);
  btn.textContent = '✅ 공개 중 — 취소하기';
  btn.classList.add('published');
  renderTalentTicker();
  checkHelperSuggestions();  // 공개 후 매칭 제안 체크
  showHelperToast('📡 인재 보드에 공개되었습니다! 관심있는 사람이 DM을 보낼 수 있어요.', '#3fb950');
}
window.toggleMyPublish = toggleMyPublish;

// 인재 보드 ticker 렌더
function buildTalentEntries() {
  const entries = [];
  // 1. 내 공개 프로필
  const me = getMyTalentProfile();
  if (me?.published) entries.push(me);
  // 2. 시뮬 데이터 중 demo opt-in (데모용 — 실제 환경에서는 서버 기반)
  const demoPublished = JSON.parse(localStorage.getItem(_TALENT_KEY + '_demo') || '[]');
  entries.push(...demoPublished);
  return entries;
}

function renderTalentTicker() {
  const scroll = document.getElementById('ticker-scroll');
  if (!scroll) return;
  const entries = buildTalentEntries();
  if (entries.length === 0) {
    scroll.innerHTML = `<span style="padding:0 24px;color:#6e7681;font-size:12px">
      아직 공개된 인재가 없습니다 — "+ 내 능력 공개" 버튼으로 먼저 등록해보세요 🌱
    </span>`;
    return;
  }
  const makeCard = (e) => {
    const initial = (e.name || '?').slice(-1);
    const stClass = e.status === 'open' ? 'open' : 'ask';
    const stLabel = e.status === 'open' ? '🟢 협업 가능' : '🟡 문의만';
    const skillHtml = (e.skills || []).slice(0, 4).map(s =>
      `<span class="tc-skill-chip">${s}</span>`).join('');
    const tagline = e.tagline ? `<span style="color:#8b949e;font-size:10px;max-width:160px;overflow:hidden;text-overflow:ellipsis">${e.tagline}</span>` : '';
    return `<div class="ticker-card"
      onclick="openDmPanel('${e.memberId}','${(e.name||'').replace(/'/g,"\\'")}','${e.color||'#58a6ff'}')"
      title="${e.name}에게 DM 보내기">
      <div class="tc-avatar" style="background:${e.color||'#1f6feb'};color:#fff">${initial}</div>
      <div class="tc-info">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="tc-name">${e.name}</span>
          <span class="tc-role">${e.role || ''}</span>
        </div>
        <div class="tc-skills">${skillHtml}${tagline}</div>
      </div>
      <span class="tc-status ${stClass}">${stLabel}</span>
      <button class="tc-dm" onclick="event.stopPropagation();openDmPanel('${e.memberId}','${(e.name||'').replace(/'/g,"\\'")}','${e.color||'#58a6ff'}')">DM</button>
    </div>`;
  };
  const html = entries.map(makeCard).join('');
  scroll.innerHTML = html + html; // 두 번 반복 → 무한 스크롤
  const dur = Math.max(24, entries.length * 10);
  scroll.style.animationDuration = dur + 's';
}

function toggleTalentBoard() {
  const ticker = document.getElementById('talent-ticker');
  const btn    = document.getElementById('talent-board-btn');
  const isOpen = ticker.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  if (isOpen) {
    if (typeof track === 'function') track('view.panel_open', { panel: 'talent' });
    renderTalentTicker();
  }
}
window.toggleTalentBoard = toggleTalentBoard;

// ── "이 분에게 도움될 수 있습니다" 매칭 제안 ──────────────────────────────────
function checkHelperSuggestions() {
  if (!_teamMode || !_activeSimData) return;
  const me = getMyTalentProfile();
  if (!me?.published || !me.skills?.length) return;

  // 내 스킬 키워드와 매칭되는 다른 팀원의 진행 중 작업 탐색
  const allMembers = _activeSimData?.members ||
    (_activeSimData?.departments || []).flatMap(d => d.members || []);

  const matches = [];
  allMembers.forEach(m => {
    if (m.id === me.memberId) return;  // 본인 제외
    (m.tasks || []).forEach(task => {
      if (task.status !== 'active') return;
      const relevantSkill = me.skills.find(skill =>
        (task.name + ' ' + (task.subtasks || []).join(' ')).includes(skill) ||
        (m.tools || []).some(t => t.includes(skill) || skill.includes(t))
      );
      if (relevantSkill) {
        matches.push({ member: m, task, skill: relevantSkill });
      }
    });
  });

  if (matches.length > 0) {
    const best = matches[0];
    setTimeout(() => {
      showHelperToast(
        `💡 <strong>${best.member.name}</strong>이 "${best.task.name}"을 진행 중입니다. 내 <strong>${best.skill}</strong> 경험이 도움될 수 있어요!`,
        '#ffd700',
        () => openDmPanel(best.member.id, best.member.name, best.member.color || '#58a6ff'),
        'DM 보내기'
      );
    }, 1200);
  }
}

// 헬퍼 토스트 (멀티 용도 알림)
let _helperToastTimer = null;
function showHelperToast(html, color = '#58a6ff', onAction = null, actionLabel = '확인') {
  let toast = document.getElementById('helper-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'helper-toast';
    Object.assign(toast.style, {
      position: 'fixed', bottom: '64px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '9000', background: 'rgba(13,17,23,0.97)',
      border: `1px solid ${color}`, borderRadius: '12px',
      padding: '10px 16px', maxWidth: '460px', display: 'flex',
      alignItems: 'center', gap: '10px', backdropFilter: 'blur(12px)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)', fontSize: '12px',
      color: '#e6edf3', lineHeight: '1.4', transition: 'opacity .3s',
    });
    document.body.appendChild(toast);
  }
  toast.style.borderColor = color;
  toast.style.opacity = '1';
  toast.innerHTML = `<span style="flex:1">${html}</span>`;
  if (onAction) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    Object.assign(btn.style, {
      background: color, border: 'none', color: '#000', borderRadius: '7px',
      padding: '4px 10px', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit',
      fontWeight: '700', whiteSpace: 'nowrap',
    });
    btn.onclick = () => { onAction(); closeHelperToast(); };
    toast.appendChild(btn);
  }
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, { background:'none', border:'none', color:'#6e7681', cursor:'pointer', fontSize:'14px', flexShrink:'0' });
  closeBtn.onclick = closeHelperToast;
  toast.appendChild(closeBtn);
  clearTimeout(_helperToastTimer);
  _helperToastTimer = setTimeout(closeHelperToast, 8000);
}

function closeHelperToast() {
  const t = document.getElementById('helper-toast');
  if (t) { t.style.opacity = '0'; setTimeout(() => t?.remove(), 300); }
}
window.closeHelperToast = closeHelperToast;

// ─── DM 패널 ──────────────────────────────────────────────────────────────────
const _dmHistory = {};  // { memberId: [{ me, text, time }] }
let   _dmTarget  = null;

function openDmPanel(memberId, memberName, memberColor) {
  if (typeof track === 'function') track('view.panel_open', { panel: 'dm' });
  _dmTarget = { memberId, memberName, memberColor: memberColor || '#58a6ff' };
  const panel  = document.getElementById('dm-panel');
  const avatar = document.getElementById('dm-avatar');
  const name   = document.getElementById('dm-name');
  avatar.textContent  = memberName?.slice(-1) || '?';
  avatar.style.background = memberColor || '#1f6feb';
  name.textContent    = memberName || '팀원';
  renderDmMessages(memberId);
  panel.classList.add('open');
  document.getElementById('dm-input').focus();
}

function openDmFromIssue(memberId, issueName) {
  // _teamNodes에서 해당 멤버 찾기
  const node = _teamNodes.find(n => n.type === 'member' && n.memberId === memberId);
  const name  = node?.label || memberId;
  const color = node?.color || '#58a6ff';
  // 이슈 선택시 자동 메시지 입력
  openDmPanel(memberId, name, color);
  const input = document.getElementById('dm-input');
  if (input) input.value = `안녕하세요! "${issueName}" 이슈 관련해서 도움 드릴 수 있을 것 같아요 🙋`;
}
window.openDmFromIssue = openDmFromIssue;

function renderDmMessages(memberId) {
  const container = document.getElementById('dm-messages');
  const msgs = _dmHistory[memberId] || [];
  if (msgs.length === 0) {
    container.innerHTML = '<div class="dm-empty">대화를 시작해보세요 👋</div>';
    return;
  }
  container.innerHTML = msgs.map(m =>
    `<div class="dm-msg ${m.me ? 'me' : ''}">
      <div class="dm-bubble">${escHtml(m.text)}</div>
      <span class="dm-time">${m.time}</span>
    </div>`
  ).join('');
  container.scrollTop = container.scrollHeight;
}

function sendDm() {
  const input = document.getElementById('dm-input');
  const text  = input.value.trim();
  if (!text || !_dmTarget) return;
  const memberId = _dmTarget.memberId;
  if (!_dmHistory[memberId]) _dmHistory[memberId] = [];
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
  _dmHistory[memberId].push({ me: true, text, time });
  input.value = '';
  renderDmMessages(memberId);
  // 자동 응답 (시뮬레이션)
  setTimeout(() => {
    if (!_dmHistory[memberId]) return;
    const replies = [
      '알겠습니다! 확인해볼게요 👍',
      '감사합니다, 내일까지 처리할게요.',
      '해당 부분 검토해보겠습니다.',
      '도움 요청 감사해요! 바로 확인해볼게요 🙌',
    ];
    const reply = replies[Math.floor(Math.random() * replies.length)];
    _dmHistory[memberId].push({ me: false, text: reply, time });
    renderDmMessages(memberId);
  }, 800 + Math.random() * 1200);
}
window.sendDm = sendDm;

function closeDmPanel() {
  document.getElementById('dm-panel').classList.remove('open');
  _dmTarget = null;
}
window.closeDmPanel = closeDmPanel;

// escHtml is defined in orbit3d-render.js

// ─── 인라인 텍스트 편집 ────────────────────────────────────────────────────────
const _labelAliasMap = (() => { try { return JSON.parse(localStorage.getItem('orbitLabelAliases') || '{}'); } catch { return {}; } })();

function openInlineEdit(hit) {
  if (!hit?.data) return;
  _editingNode = hit.data;
  _editIconEl.style.display = 'none';

  const overlay = document.getElementById('inline-edit-overlay');
  const input   = document.getElementById('inline-edit-input');
  const label   = document.getElementById('inline-edit-label');

  const nodeKey = _editingNode.nodeKey
                || _editingNode.projName  || _editingNode.memberId || _editingNode.deptId
                || _editingNode.clusterId || _editingNode.sessionId
                || (_editingNode.intent || _editingNode.label || '').slice(0, 20);
  label.textContent = `✎ 레이블 편집`;
  // 노드 타입별 현재 라벨 결정
  const currentLabel = _labelAliasMap[nodeKey]
    || _editingNode.intent || _editingNode.label
    || _editingNode.info?.name || _editingNode.projName
    || _editingNode.catLabel || '';
  input.value = currentLabel;

  // 위치: 노드 상단 중앙 근처
  overlay.style.left = Math.min(hit.cx + 20, innerWidth - 220) + 'px';
  overlay.style.top  = Math.max(hit.cy - 30, 10) + 'px';
  overlay.classList.add('open');
  overlay.dataset.nodeKey = nodeKey;
  setTimeout(() => input.focus(), 50);
}

function saveInlineEdit() {
  const overlay  = document.getElementById('inline-edit-overlay');
  const input    = document.getElementById('inline-edit-input');
  const nodeKey  = overlay.dataset.nodeKey;
  const newLabel = input.value.trim();
  if (newLabel && _editingNode) {
    _labelAliasMap[nodeKey] = newLabel;
    localStorage.setItem('orbitLabelAliases', JSON.stringify(_labelAliasMap));
    // 노드 레이블 즉시 업데이트
    _editingNode.label = newLabel;
    _editingNode.intent = newLabel;
    // 프로젝트 노드 편집 시 info.name 도 업데이트
    if (_editingNode.info) _editingNode.info.name = newLabel;
    if (_editingNode.projName && !_editingNode.clusterId) _editingNode.projName = newLabel;
    // 카테고리 노드 편집 시 catLabel 업데이트
    if (_editingNode.catLabel) _editingNode.catLabel = newLabel;
    // 3D 행성 userData도 업데이트 (개인 모드 행성)
    const cid = _editingNode.clusterId || _editingNode.sessionId;
    if (cid) {
      const planet = planetMeshes.find(p => p.userData.clusterId === cid || p.userData.sessionId === cid);
      if (planet) planet.userData.intent = newLabel;
    }
    // 중앙 태양(core) 편집 시 userData 업데이트
    if (nodeKey === '__orbit_core__' && typeof _coreMeshRef !== 'undefined' && _coreMeshRef) {
      _coreMeshRef.userData.intent = newLabel;
    }
    // _nodeAliases 도 저장 (orbit3d-ui.js alias 시스템과 연동)
    if (typeof _nodeAliases !== 'undefined' && _editingNode.label) {
      _nodeAliases[nodeKey] = newLabel;
      if (typeof saveAliases === 'function') saveAliases();
    }
    if (typeof track === 'function') track('node.edit', { node_type: _editingNode.type || 'unknown' });
  }
  closeInlineEdit();
}

function closeInlineEdit() {
  document.getElementById('inline-edit-overlay').classList.remove('open');
  _editingNode = null;
  _editIconEl.style.display = 'none';
}
window.saveInlineEdit  = saveInlineEdit;
window.closeInlineEdit = closeInlineEdit;

// ─── 시작 ─────────────────────────────────────────────────────────────────────
loadData();
connectWS();
