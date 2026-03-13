'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — AI 패널들 (인사이트, 목적 타임라인, AI 추천, 트리거, 개인학습)
// [orbit3d-render.js에서 분할]
// ══════════════════════════════════════════════════════════════════════════════

// ─── AI 인사이트 패널 ─────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function relTime(ts) {
  const diff = Date.now() - new Date(ts || 0).getTime();
  if (diff < 60000)    return '방금';
  if (diff < 3600000)  return `${Math.floor(diff/60000)}분 전`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}시간 전`;
  return `${Math.floor(diff/86400000)}일 전`;
}

function computeInsights() {
  const cutoff = Date.now() - 3_600_000;

  // ① 최근 1시간 이벤트 피드 (최신순, 최대 20개)
  const recentEvents = [..._allNodes]
    .filter(n => new Date(n.timestamp || n.created_at || 0) > cutoff)
    .sort((a,b) => new Date(b.timestamp || b.created_at || 0) - new Date(a.timestamp || a.created_at || 0))
    .slice(0, 20);

  // ② 타입 카테고리 분포
  const CAT_META = {
    chat:  { label:'💬 대화', color:'#58a6ff' },
    code:  { label:'⚡ 코드', color:'#3fb950' },
    file:  { label:'📄 파일', color:'#ffa657' },
    git:   { label:'🌿 Git',  color:'#39d2c0' },
    error: { label:'❌ 오류', color:'#f85149' },
  };
  const catDist = {};
  _allNodes.forEach(n => {
    const cat = typeCfg(n.type).cat || 'chat';
    catDist[cat] = (catDist[cat]||0) + 1;
  });
  const total = Math.max(_allNodes.length, 1);
  const distRows = Object.entries(catDist)
    .sort((a,b) => b[1]-a[1])
    .map(([cat, cnt]) => ({
      ...(CAT_META[cat] || { label:cat, color:'#8b949e' }),
      pct: Math.round(cnt/total*100),
    }));

  // ③ 도메인 분포 → 주요 도메인
  const DOMAIN_LABELS = {
    auth:'🔐 인증', api:'🌐 API', data:'🗄️ 데이터', ui:'🎨 UI',
    test:'🧪 테스트', server:'🚀 서버', infra:'🐳 인프라', fix:'🔧 버그수정',
    git:'🌿 Git', chat:'💬 대화', general:'⚙️ 일반',
  };
  const domainDist = {};
  planetMeshes.forEach(p => {
    const d = p.userData.domain || 'general';
    domainDist[d] = (domainDist[d]||0) + 1;
  });
  const topDE = Object.entries(domainDist).sort((a,b)=>b[1]-a[1])[0];
  const topDomainLabel = topDE && planetMeshes.length
    ? `${DOMAIN_LABELS[topDE[0]]||topDE[0]} ${Math.round(topDE[1]/planetMeshes.length*100)}%`
    : '—';

  // ④ 오류율
  const errCount = _allNodes.filter(n => n.type === 'tool.error').length;
  const errRate  = (errCount / total * 100).toFixed(1);

  // ⑤ Git 활동
  const gitCount = _allNodes.filter(n => n.type === 'git.commit' || n.type === 'git.push').length;

  // ⑥ 최다 파일
  const fileDist = {};
  _allNodes.forEach(n => {
    const fp = ((n.data?.filePath || n.data?.fileName || '')).replace(/\\/g,'/');
    const fn = fp.split('/').pop();
    if (fn && fn.includes('.')) fileDist[fn] = (fileDist[fn]||0) + 1;
  });
  const topFile = Object.entries(fileDist).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';

  return { recentEvents, distRows, topDomainLabel, errRate, gitCount, topFile, total };
}

const _INS_TYPE_ICON = {
  'user.message':'💬', 'assistant.message':'🤖', 'assistant.response':'🤖',
  'tool.start':'⚡', 'tool.end':'✅', 'tool.error':'❌',
  'file.read':'📄', 'file.write':'✏️', 'git.commit':'🌿', 'git.push':'🚀',
};

// ─── 탭 전환 ─────────────────────────────────────────────────────────────────
let _insightTab = 'feed'; // 'feed' | 'purpose' | 'stats'

function switchInsightTab(tab) {
  _insightTab = tab;
  ['feed','purpose','stats'].forEach(t => {
    document.getElementById(`ins-tab-${t}`).classList.toggle('active', t === tab);
    const pane = document.getElementById(`ins-pane-${t}`);
    if (t === tab) pane.style.display = 'flex';
    else           pane.style.display = 'none';
  });
  if      (tab === 'feed')    renderFeedTab();
  else if (tab === 'purpose') renderPurposeTab();
  else if (tab === 'stats')   renderStatsTab();
}
window.switchInsightTab = switchInsightTab;

// ─── 실시간 피드 탭 ──────────────────────────────────────────────────────────
function renderFeedTab() {
  const ins = computeInsights();
  document.getElementById('ins-feed-list').innerHTML = ins.recentEvents.length
    ? ins.recentEvents.map(n => `
        <div class="ins-feed-item">
          <span class="ins-feed-icon">${_INS_TYPE_ICON[n.type]||'·'}</span>
          <div class="ins-feed-body">
            <div class="ins-feed-label" title="${escHtml(n.label||n.type)}">${escHtml((n.label||n.type).slice(0,42))}</div>
            <div class="ins-feed-time">${relTime(n.timestamp||n.created_at)}</div>
          </div>
        </div>`).join('')
    : `<div style="padding:14px 4px;color:#6e7681;font-size:12px;">
         최근 1시간 이벤트 없음<br>
         <span style="font-size:10px;color:#3d444d">전체 ${ins.total.toLocaleString()}개 보유</span>
       </div>`;
  document.getElementById('ins-feed-meta').textContent =
    `총 ${ins.recentEvents.length}개 · 최근 1시간`;
}

// ─── 목적 카드 탭 ─────────────────────────────────────────────────────────────
function buildPurposeCards() {
  const groups = {};
  _allNodes.forEach(n => {
    const key = n.purposeLabel || n.data?.purposeLabel;
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(n);
  });

  return Object.entries(groups).map(([purposeLabel, events]) => {
    // 시간순 정렬
    events.sort((a,b) =>
      new Date(a.timestamp||a.created_at||0) - new Date(b.timestamp||b.created_at||0));
    const firstTs = events[0]?.timestamp || events[0]?.created_at;
    const lastTs  = events[events.length-1]?.timestamp || events[events.length-1]?.created_at;

    // ① 트리거 질문
    const triggerEv = events.find(e => e.type === 'user.message');
    const trigger   = (triggerEv?.label || triggerEv?.data?.text || '').trim();

    // ② 에이전트 스텝 감지 (순서 보존, 중복 제거)
    const agentSteps = [];
    const seenStep   = new Set();
    events.forEach(e => {
      if (e.type !== 'tool.start') return;
      const tname = e.data?.toolName || e.label || '';
      const fpath = (e.data?.filePath || e.data?.fileName || '');
      let step = null;
      if      (/Glob|Grep/.test(tname) && !/Edit|Write/.test(tname)) step = { label:'Explore', icon:'🔍' };
      else if (/^Read$/i.test(tname)   && !/Edit|Write/.test(tname)) step = { label:'탐색', icon:'📂' };
      else if (/plan\.md/i.test(fpath) && /Write|Edit/.test(tname))  step = { label:'Plan', icon:'📋' };
      else if (/Write|Edit/.test(tname))                              step = { label:'구현', icon:'⚡' };
      else if (/Bash/i.test(tname)) {
        const cmd = e.data?.command || '';
        if      (/git\s+commit/i.test(cmd)) step = { label:'커밋', icon:'🌿' };
        else if (/git\s+push/i.test(cmd))   step = { label:'푸시', icon:'🚀' };
        else                                step = { label:'Bash', icon:'💻' };
      }
      if (step && !seenStep.has(step.label)) {
        seenStep.add(step.label);
        agentSteps.push(step);
      }
    });

    // ③ 변경 파일 목록
    const fileDist = {};
    events.forEach(e => {
      const fp = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/');
      const fn = fp.split('/').pop();
      if (!fn || !fn.includes('.')) return;
      if (!fileDist[fn]) fileDist[fn] = { name: fn, write: 0 };
      if (['file.write','tool.start'].includes(e.type) &&
          /Write|Edit/.test(e.data?.toolName || '')) fileDist[fn].write++;
    });

    // ④ Git 커밋 해시 (마지막)
    const commitEv  = [...events].reverse().find(e => e.type === 'git.commit');
    const commitHash = commitEv?.data?.hash || commitEv?.data?.commitHash || '';

    // ⑤ 상태 판정
    const hasError = events.some(e => e.type === 'tool.error');
    let statusIcon;
    if      (hasError)        statusIcon = '❌';
    else if (commitHash)      statusIcon = '✅';
    else if (agentSteps.length) statusIcon = '⚡';
    else                      statusIcon = '⏳';

    return { purposeLabel, trigger, agentSteps,
             files: Object.values(fileDist),
             commitHash, hasError, statusIcon, firstTs, lastTs };
  }).sort((a,b) => new Date(b.lastTs||0) - new Date(a.lastTs||0));
}

function renderPurposeTab() {
  const cards = buildPurposeCards();
  const el    = document.getElementById('ins-purpose-list');
  if (!cards.length) {
    el.innerHTML = `<div class="ins-purpose-empty">
      📭 목적(purposeLabel) 데이터 없음<br>
      <span style="font-size:10px;color:#3d444d;margin-top:6px;display:block;">
        이벤트에 purposeLabel 필드가 있어야 합니다
      </span>
    </div>`;
    return;
  }

  el.innerHTML = cards.map(c => {
    // 스텝 HTML
    const stepsHtml = c.agentSteps.length
      ? c.agentSteps.map((s, i) =>
          `${i > 0 ? '<span class="ins-pc-step-arrow">›</span>' : ''}
           <span class="ins-pc-step ok">${s.icon} ${escHtml(s.label)}</span>`).join('')
      : `<span style="font-size:10px;color:#3d444d">스텝 정보 없음</span>`;

    // 파일 HTML
    const filesHtml = c.files.length
      ? c.files.slice(0, 4).map(f =>
          `<span class="ins-pc-file" title="${escHtml(f.name)}">
            ${escHtml(f.name.slice(0, 20))}
            ${f.write ? '<span class="ins-pc-diff">✏️</span>' : ''}
           </span>`).join('')
      : '';

    // 액션 버튼 HTML — 롤백 버튼을 실행 패널로 연결
    const rollbackPayload = c.commitHash ? JSON.stringify({
      type: 'rollback', hash: c.commitHash,
      projectDir: '', description: `${c.purposeLabel} 롤백 (${c.commitHash.slice(0,7)})`,
    }).replace(/"/g, '&quot;') : '';
    const actionsHtml = c.commitHash
      ? `<div class="ins-pc-actions">
           <div class="ins-pc-commit-btn" title="커밋 해시: ${escHtml(c.commitHash)}">
             🌿 ${escHtml(c.commitHash.slice(0,7))}
           </div>
           <div class="ins-pc-rollback-btn"
                onclick="openExecPanel(${rollbackPayload})">
             ↩ 롤백 미리보기
           </div>
         </div>`
      : '';

    return `<div class="ins-purpose-card">
      <div class="ins-pc-hdr">
        <span class="ins-pc-status">${c.statusIcon}</span>
        <span class="ins-pc-label" title="${escHtml(c.purposeLabel)}">
          ${escHtml(c.purposeLabel.slice(0, 34))}${c.purposeLabel.length>34?'…':''}
        </span>
        <span class="ins-pc-time">${relTime(c.lastTs)}</span>
      </div>
      ${c.trigger ? `<div class="ins-pc-trigger">💬 "${escHtml(c.trigger.slice(0,60))}${c.trigger.length>60?'…':''}"</div>` : ''}
      <div class="ins-pc-steps">${stepsHtml}</div>
      ${filesHtml ? `<div class="ins-pc-files">${filesHtml}</div>` : ''}
      ${actionsHtml}
    </div>`;
  }).join('');
}
window.renderPurposeTab = renderPurposeTab;

// ─── 통계 탭 ─────────────────────────────────────────────────────────────────
function renderStatsTab() {
  const ins = computeInsights();
  document.getElementById('ins-dist-list').innerHTML = ins.distRows
    .filter(r => r.pct > 0)
    .map(r => `
      <div class="ins-dist-row">
        <span class="ins-dist-label">${r.label}</span>
        <div class="ins-dist-bg">
          <div class="ins-dist-fill" style="width:${r.pct}%;background:${r.color}"></div>
        </div>
        <span class="ins-dist-pct">${r.pct}%</span>
      </div>`).join('');

  const health = parseFloat(ins.errRate) < 5
    ? '✅ 건강함' : parseFloat(ins.errRate) < 15 ? '⚠️ 주의' : '🔴 불안정';
  document.getElementById('ins-kv-list').innerHTML = [
    ['🔧 주요 도메인', ins.topDomainLabel],
    ['⚠️ 오류율',     `${ins.errRate}% ${health}`],
    ['🌿 Git 활동',   `${ins.gitCount}회`],
    ['🏆 최다 파일',   ins.topFile],
    ['📦 전체 이벤트', `${ins.total.toLocaleString()}개`],
  ].map(([k,v]) => `
    <div class="ins-kv-row">
      <span class="ins-kv-key">${k}</span>
      <span class="ins-kv-val">${escHtml(String(v))}</span>
    </div>`).join('');
}

// ─── renderInsightPanel: 현재 활성 탭 렌더 ──────────────────────────────────
function renderInsightPanel() {
  if      (_insightTab === 'feed')    renderFeedTab();
  else if (_insightTab === 'purpose') renderPurposeTab();
  else if (_insightTab === 'stats')   renderStatsTab();
}
window.renderInsightPanel = renderInsightPanel;

// ─── 패널 열기/닫기 ──────────────────────────────────────────────────────────
let _insightRefreshTimer = null;

function toggleInsightPanel() {
  const panel  = document.getElementById('insight-panel');
  const isOpen = panel.classList.contains('open');
  document.getElementById('info-panel')?.classList.remove('open');
  if (isOpen) {
    panel.classList.remove('open');
    clearInterval(_insightRefreshTimer); _insightRefreshTimer = null;
  } else {
    panel.classList.add('open');
    // 첫 열기 시 피드 탭으로 초기화
    if (_insightTab !== 'feed') switchInsightTab('feed');
    else renderFeedTab();
    _insightRefreshTimer = setInterval(renderInsightPanel, 30000);
  }
}
window.toggleInsightPanel = toggleInsightPanel;

// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ 목적(Purpose) 타임라인 패널
// ═══════════════════════════════════════════════════════════════════════════════

let _ptOpen     = false;
let _ptPurposes = [];
let _ptActive   = -1;

async function togglePurposeTimeline() {
  const panel  = document.getElementById('purpose-timeline');
  const btn    = document.getElementById('ln-purpose-btn');
  _ptOpen = !_ptOpen;
  panel.classList.toggle('open', _ptOpen);
  btn?.classList.toggle('active', _ptOpen);
  if (_ptOpen) {
    await _ptLoadSessions();
    await loadPurposeTimeline();
  }
}
window.togglePurposeTimeline = togglePurposeTimeline;

async function _ptLoadSessions() {
  try {
    const r    = await fetch('/api/purposes/sessions');
    const data = await r.json();
    const sel  = document.getElementById('pt-sess-sel');
    if (!sel) return;
    const opts = (data.sessions || []).map(s =>
      `<option value="${escHtml(s.sessionId)}">${escHtml(s.sessionTitle)} · ${s.purposeCount}목적</option>`
    ).join('');
    sel.innerHTML = `<option value="">전체 세션</option>${opts}`;
  } catch {}
}

async function loadPurposeTimeline() {
  const container = document.getElementById('pt-cards');
  const metaEl    = document.getElementById('pt-meta-label');
  const sessId    = document.getElementById('pt-sess-sel')?.value || '';

  container.innerHTML = '<div class="pt-empty-msg">불러오는 중…</div>';
  try {
    const qs  = sessId ? `&session_id=${encodeURIComponent(sessId)}` : '';
    const r   = await fetch(`/api/purposes/timeline?limit=60${qs}`);
    const data= await r.json();
    _ptPurposes = data.purposes || [];
    if (metaEl) metaEl.textContent = `총 ${_ptPurposes.length}개 목적`;
    _ptRenderCards(_ptPurposes);
  } catch (e) {
    container.innerHTML = `<div class="pt-empty-msg">❌ ${escHtml(e.message)}</div>`;
  }
}
window.loadPurposeTimeline = loadPurposeTimeline;

function _ptRenderCards(purposes) {
  const container = document.getElementById('pt-cards');
  if (!purposes.length) {
    container.innerHTML = '<div class="pt-empty-msg">목적 데이터가 없습니다 — 이벤트가 쌓이면 자동으로 분류됩니다</div>';
    return;
  }

  // 최신순 → 오래된순으로 표시 (타임라인 흐름)
  const ordered = [...purposes].reverse();

  container.innerHTML = ordered.map((p, i) => {
    const realIdx = purposes.length - 1 - i; // _ptPurposes 에서의 실제 인덱스

    const gitBadge = p.gitHash
      ? `<span class="pt-git-badge">🌿 ${escHtml(p.gitHash.slice(0,7))}</span>`
      : `<span class="pt-nocommit-badge">미커밋</span>`;

    const filesHtml = (p.files || []).slice(0, 4).map(f => {
      const name = f.replace(/\\/g, '/').split('/').pop();
      return `<span class="pt-file-chip" title="${escHtml(f)}">${escHtml(name.slice(0,15))}</span>`;
    }).join('');
    const moreFiles = (p.files || []).length > 4
      ? `<span class="pt-file-more">+${p.files.length - 4}</span>` : '';

    const triggerHtml = p.triggerText
      ? `<div class="pt-card-trigger">"${escHtml(p.triggerText.slice(0,100))}"</div>` : '';

    const rollbackBtn = p.gitHash
      ? `<button class="pt-rollback-btn" onclick="ptRollback(${realIdx},event)">↩ 롤백</button>` : '';

    const connector = i > 0
      ? `<div class="pt-connector"><div class="pt-connector-line"></div></div>` : '';

    return `${connector}<div class="pt-card" id="pt-card-${realIdx}" onclick="ptSelectCard(${realIdx})">
      <div class="pt-card-top">
        <span class="pt-card-icon" style="color:${p.color||'#8b949e'}">${p.icon||'📌'}</span>
        <span class="pt-card-label">${escHtml(p.label||'')}</span>
        ${gitBadge}
      </div>
      ${triggerHtml}
      <div class="pt-card-files">${filesHtml}${moreFiles}</div>
      <div class="pt-card-foot">
        <span class="pt-card-time">${relTime(p.startTs)}</span>
        <span class="pt-card-cnt">${p.eventsCount}이벤트</span>
      </div>
      ${rollbackBtn}
    </div>`;
  }).join('');
}

function ptSelectCard(idx) {
  // 활성 표시
  document.querySelectorAll('.pt-card').forEach(el => el.classList.remove('active'));
  document.getElementById(`pt-card-${idx}`)?.classList.add('active');
  _ptActive = idx;

  const p = _ptPurposes[idx];
  if (!p) return;

  // info-panel에 목적 상세 주입
  _ptShowDetail(p);
}
window.ptSelectCard = ptSelectCard;

function _ptShowDetail(p) {
  const panel = document.getElementById('info-panel');
  if (!panel) return;

  // 헤더
  const dotEl = document.getElementById('ip-dot');
  if (dotEl) dotEl.style.background = p.color || '#8b949e';
  const typeEl = document.getElementById('ip-type-text');
  if (typeEl) typeEl.textContent = `${p.icon} ${p.label}`;
  const intentEl = document.getElementById('ip-intent');
  if (intentEl) intentEl.textContent = p.triggerText ? `"${p.triggerText.slice(0,80)}"` : p.label;

  // KV 목록
  const kvList = document.getElementById('ip-kv-list');
  if (kvList) {
    const kvRows = [
      ['목적',      `${p.icon} ${p.label}`],
      ['신뢰도',    `${Math.round((p.confidence||0)*100)}%`],
      ['이벤트',    `${p.eventsCount}개`],
      ['시작',      p.startTs ? new Date(p.startTs).toLocaleString('ko-KR') : '-'],
      ['소요시간',  p.startTs && p.endTs
                      ? `${Math.round((new Date(p.endTs)-new Date(p.startTs))/60000)}분` : '-'],
      ['Git 커밋',  p.gitHash ? p.gitHash.slice(0,12) : '없음'],
    ];
    kvList.innerHTML = kvRows.map(([k,v]) =>
      `<div class="ip-kv"><span class="k">${k}</span><span class="v">${escHtml(String(v))}</span></div>`
    ).join('');
  }

  // 미리보기: 파일 목록 + 롤백 버튼
  const previewEl = document.getElementById('ip-preview');
  if (previewEl) {
    const filesHtml = p.files?.length
      ? `<div style="margin-bottom:8px">
          <div style="font-size:9px;color:#6e7681;margin-bottom:4px">📁 변경된 파일 (${p.files.length}개)</div>
          ${p.files.map(f => `<div style="font-size:10px;color:#58a6ff;padding:2px 0">${escHtml(f.split('/').pop())}</div>`).join('')}
         </div>` : '';

    const commitHtml = p.gitHash
      ? `<div style="background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.2);
            border-radius:7px;padding:8px 10px;margin-bottom:8px">
          <div style="font-size:9px;color:#3fb950;font-weight:700;margin-bottom:3px">🌿 Git 커밋</div>
          <div style="font-size:10px;color:#7ee787;font-family:'SF Mono',monospace">${escHtml(p.gitHash.slice(0,12))}</div>
          ${p.gitMessage ? `<div style="font-size:9px;color:#8b949e;margin-top:3px">${escHtml(p.gitMessage)}</div>` : ''}
         </div>` : '';

    const rollbackHtml = p.gitHash
      ? `<button onclick="ptRollback(${_ptActive},null)"
           style="width:100%;background:none;border:1px solid #f85149;color:#f85149;
             border-radius:7px;padding:7px;font-size:11px;cursor:pointer;font-family:inherit;
             transition:background .15s"
           onmouseover="this.style.background='rgba(248,81,73,.08)'"
           onmouseout="this.style.background='none'">
           ↩ 이 목적 전으로 롤백 (${escHtml(p.gitHash.slice(0,7))})
         </button>` : '';

    previewEl.innerHTML = filesHtml + commitHtml + rollbackHtml;
    previewEl.style.display = 'block';
  }

  panel.classList.add('open');
}

function ptRollback(idx, ev) {
  if (ev) ev.stopPropagation();
  const p = _ptPurposes[idx];
  if (!p?.gitHash) { showToast('이 목적에 연결된 커밋이 없습니다'); return; }
  if (typeof openExecPanel === 'function') {
    openExecPanel({
      type:        'rollback',
      hash:        p.gitHash,
      description: `↩ 롤백: ${p.label} (${p.gitHash.slice(0,7)})`,
    });
  }
}
window.ptRollback = ptRollback;

// ═══════════════════════════════════════════════════════════════════════════════
// 💡 AI 추천 패널
// ═══════════════════════════════════════════════════════════════════════════════

let _sgOpen = false;

function toggleSuggestionPanel() {
  const panel = document.getElementById('suggestion-panel');
  const btn   = document.getElementById('ln-suggest-btn');
  _sgOpen = !_sgOpen;
  panel.classList.toggle('open', _sgOpen);
  btn?.classList.toggle('active', _sgOpen);
  document.getElementById('insight-panel')?.classList.remove('open');
  document.getElementById('info-panel')?.classList.remove('open');
  if (_sgOpen) loadSuggestions();
}
window.toggleSuggestionPanel = toggleSuggestionPanel;

// ── 제안 패널 탭 전환 ────────────────────────────────────────────────────────
function switchSgTab(tab) {
  const isSuggest = tab === 'suggest';
  document.getElementById('sg-panel-suggest').style.display = isSuggest ? '' : 'none';
  document.getElementById('sg-panel-trigger').style.display = isSuggest ? 'none' : '';
  const t1 = document.getElementById('sg-tab-suggest');
  const t2 = document.getElementById('sg-tab-trigger');
  if (t1) { t1.style.background = isSuggest ? '#21262d' : 'transparent'; t1.style.color = isSuggest ? '#cdd9e5' : '#6e7681'; }
  if (t2) { t2.style.background = isSuggest ? 'transparent' : '#21262d'; t2.style.color = isSuggest ? '#6e7681' : '#cdd9e5'; }
  if (!isSuggest) loadTriggers();
}
window.switchSgTab = switchSgTab;


// ── 행동 이상 신호 카드 렌더 ─────────────────────────────────────────────────
const SIGNAL_META = {
  wpm_spike:       { icon:'⚡', label:'타이핑 속도 이상',   color:'#f85149', bg:'rgba(248,81,73,.08)'  },
  messaging_burst: { icon:'💬', label:'메시지 집중 급증',   color:'#ff9500', bg:'rgba(255,149,0,.08)'  },
  night_anomaly:   { icon:'🌙', label:'야간 활동 감지',     color:'#bc78de', bg:'rgba(188,120,222,.08)' },
  short_burst_chat:{ icon:'🔥', label:'급박 메시지 감지',   color:'#f85149', bg:'rgba(248,81,73,.08)'  },
  app_storm:       { icon:'🌀', label:'앱 전환 급증',       color:'#ff9500', bg:'rgba(255,149,0,.08)'  },
};
const SEV_LABEL = { high:'🔴 긴급', medium:'🟠 주의', low:'🟡 참고' };

function _renderSignalCard(s) {
  const meta = SIGNAL_META[s.signal] || { icon:'⚠️', label:s.signal, color:'#ff9500', bg:'rgba(255,149,0,.08)' };
  const sevLabel = SEV_LABEL[s.severity] || '🟠 주의';
  const timeAgo  = s.detected_at ? relTime(s.detected_at) : '';
  return `<div class="sg-card" style="border-color:${meta.color}55;background:${meta.bg};border-left:3px solid ${meta.color}">
    <div class="sg-card-top" style="justify-content:space-between">
      <span style="font-size:18px">${meta.icon}</span>
      <span class="sg-card-pri" style="background:${meta.color}22;color:${meta.color}">${sevLabel}</span>
    </div>
    <div class="sg-card-title" style="color:${meta.color}">${escHtml(meta.label)}</div>
    <div class="sg-card-desc" style="font-size:10px">${escHtml(s.desc||'')}</div>
    <div class="sg-card-evidence" style="color:#6e7681">${timeAgo} · 내용 無읽음 — 행동 패턴만</div>
    <div class="sg-card-actions">
      <button class="sg-accept-btn" style="background:${meta.color}22;border-color:${meta.color}"
        onclick="ackSignal('${escHtml(s.id)}', this)">✓ 확인함</button>
    </div>
  </div>`;
}

// ── 제안 패널: 무료 솔루션 카드 렌더 ─────────────────────────────────────────
function _renderFreeSolCard(s) {
  const acc = s.accuracy ? `${Math.round(s.accuracy * 100)}%` : '–';
  return `<div class="sg-card" style="border-color:rgba(138,87,222,.35);background:rgba(138,87,222,.06)">
    <div class="sg-card-top">
      <span class="sg-card-pri" style="background:rgba(138,87,222,.2);color:#bc78de">✅ 검증됨</span>
      <span class="sg-card-type">🎁 무료 솔루션</span>
    </div>
    <div class="sg-card-title">${escHtml(s.title||'')}</div>
    <div class="sg-card-desc">${escHtml(s.description||'')}</div>
    <div class="sg-card-evidence">정확도 ${acc} · 사용 ${s.usageCount||0}회</div>
    <div class="sg-card-actions">
      <button class="sg-accept-btn" style="background:rgba(138,87,222,.25);border-color:#8957e5"
        onclick="applyFreeSolution(${escHtml(JSON.stringify(s))})">⚡ 적용</button>
    </div>
  </div>`;
}

// ── 제안 패널: 로컬 학습 카드 렌더 ──────────────────────────────────────────
function _renderLocalSugCard(s) {
  const TYPE_LABEL = {
    automation:'⚙️ 자동화', template:'📝 템플릿',
    shortcut:'⌨️ 단축키', review:'🔍 검토', consolidation:'🔗 통합',
    prompt_template:'🧠 프롬프트 학습',
  };
  const PRI_LABEL = { 5:'🔴', 4:'🟠', 3:'🟡', 2:'🔵', 1:'⚪' };
  const evidence  = Array.isArray(s.evidence) ? s.evidence : [];
  const evText    = evidence.map(ev => {
    if (ev.type === 'file_access')       return `📁 ${(ev.path||'').split('/').pop()} · ${ev.count}회`;
    if (ev.type === 'repeat_typing')     return `⌨️ 반복 입력 ${ev.count}회`;
    if (ev.type === 'app_switch')        return `🔄 ${ev.pair} · ${ev.count}회`;
    if (ev.type === 'long_session')      return `⏱ ${Math.round((ev.durationMin||0)/60*10)/10}시간`;
    if (ev.type === 'prompt_refinement')
      return `🔁 ${ev.app||'AI'} 수정 ${ev.revisionCount}회 · "${(ev.firstPrompt||'').slice(0,25)}…"`;
    return '';
  }).filter(Boolean).join(' · ');

  const sug      = (typeof s.suggestion === 'object' && s.suggestion) ? s.suggestion : {};
  const isPrompt = s.type === 'prompt_template';
  // prompt_template은 "학습 중" 배지만 — 무료솔루션으로 승격 후 사용 가능
  const learningNote = isPrompt
    ? `<div style="font-size:10px;color:#8957e5;margin:4px 0">
         📡 오퍼레이터 검증 후 무료 솔루션으로 제공됩니다
       </div>`
    : '';

  return `<div class="sg-card" id="sg-card-${escHtml(s.id)}">
    <div class="sg-card-top">
      <span class="sg-card-pri p${s.priority||3}">${PRI_LABEL[s.priority||3]||'🟡'}</span>
      <span class="sg-card-type">${TYPE_LABEL[s.type]||s.type}</span>
      ${isPrompt ? '<span style="font-size:9px;color:#8b949e;margin-left:auto">학습 중 ●</span>' : ''}
    </div>
    <div class="sg-card-title">${escHtml(s.title)}</div>
    <div class="sg-card-desc">${escHtml(s.description||'')}</div>
    ${evText ? `<div class="sg-card-evidence">${escHtml(evText)}</div>` : ''}
    ${learningNote}
    <div class="sg-card-actions">
      ${!isPrompt ? `<button class="sg-accept-btn" onclick="respondSuggestion('${escHtml(s.id)}','accept')">✓ 수락</button>` : ''}
      <button class="sg-dismiss-btn" onclick="respondSuggestion('${escHtml(s.id)}','dismiss')">✕ 무시</button>
    </div>
  </div>`;
}

async function loadSuggestions() {
  const list   = document.getElementById('sg-list');
  const footer = document.getElementById('sg-footer');
  if (!list) return;
  list.innerHTML = '<div class="sg-empty">불러오는 중…</div>';

  try {
    // 병렬 fetch: 행동신호 + 클라우드 무료솔루션 + 로컬 학습 데이터
    const [sigRes, solRes, sugRes] = await Promise.allSettled([
      fetch('/api/personal/signals?limit=10'),
      fetch('/api/sync/free-solutions'),
      fetch('/api/personal/suggestions?limit=50'),
    ]);

    const signals = sigRes.status === 'fulfilled'
      ? ((await sigRes.value.json()).signals || []).filter(s => !s.acknowledged)
      : [];
    const freeSols = solRes.status === 'fulfilled'
      ? ((await solRes.value.json()).solutions || [])
      : [];
    const localSugs = sugRes.status === 'fulfilled'
      ? ((await sugRes.value.json()).suggestions || [])
      : [];

    const totalCount = signals.length + freeSols.length + localSugs.length;
    if (footer) footer.textContent = [
      signals.length   ? `⚠️ 신호 ${signals.length}개`   : '',
      freeSols.length  ? `🎁 솔루션 ${freeSols.length}개` : '',
      localSugs.length ? `📡 학습 ${localSugs.length}개`  : '',
    ].filter(Boolean).join(' · ') || '데이터 없음';

    if (!totalCount) {
      list.innerHTML = `<div class="sg-empty">
        아직 데이터가 없습니다.<br><br>
        <span style="font-size:10px">orbit learn start 실행 후<br>
        AI 작업을 하면 자동으로 학습됩니다</span>
      </div>`;
      return;
    }

    let html = '';

    // ── 섹션 0: 행동 이상 신호 (최우선 표시) ───────────────────────────────
    if (signals.length) {
      const highCount = signals.filter(s => s.severity === 'high').length;
      html += `<div style="font-size:10px;color:#f85149;font-weight:600;
                  padding:6px 0 4px;border-bottom:1px solid rgba(248,81,73,.25);
                  margin-bottom:6px;display:flex;align-items:center;gap:6px">
                 ⚠️ 행동 이상 신호 (${signals.length})
                 ${highCount ? `<span style="background:#f85149;color:#fff;border-radius:8px;padding:1px 6px;font-size:9px">긴급 ${highCount}</span>` : ''}
                 <span style="color:#6e7681;font-weight:normal;font-size:9px">내용 없이 타이핑 행동만 감지</span>
               </div>`;
      html += signals.map(_renderSignalCard).join('');
    }

    // ── 섹션 1: 검증된 무료 솔루션 ────────────────────────────────────────
    if (freeSols.length) {
      html += `<div style="font-size:10px;color:#bc78de;font-weight:600;
                  padding:6px 0 4px;border-bottom:1px solid rgba(138,87,222,.2);
                  margin-bottom:6px;margin-top:${signals.length?'10px':'0'}">
                 🎁 무료 솔루션 (${freeSols.length})</div>`;
      html += freeSols.map(_renderFreeSolCard).join('');
    }

    // ── 섹션 2: 로컬 학습 중 데이터 ───────────────────────────────────────
    if (localSugs.length) {
      html += `<div style="font-size:10px;color:#8b949e;font-weight:600;
                  padding:8px 0 4px;border-bottom:1px solid #30363d;
                  margin-bottom:6px;margin-top:${freeSols.length?'10px':'0'}">
                 📡 학습 중 (${localSugs.length}) — 검증 후 솔루션으로 등록됩니다</div>`;
      html += localSugs.map(_renderLocalSugCard).join('');
    }

    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = `<div class="sg-empty">❌ ${escHtml(e.message)}</div>`;
  }
}
window.loadSuggestions = loadSuggestions;

// ── 무료 솔루션 적용 ─────────────────────────────────────────────────────────
async function applyFreeSolution(sol) {
  try {
    if (sol.template) {
      // 클립보드에 복사
      await navigator.clipboard.writeText(sol.template);
      showToast(`✅ "${sol.title}" 복사됨 — AI에 붙여넣기하세요`);
    } else {
      showToast(`✅ "${sol.title}" 적용됨`);
    }
    // 사용 카운트 서버 전송
    fetch('/api/sync/free-solutions/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sol.id }),
    }).catch(() => {});
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.applyFreeSolution = applyFreeSolution;

// ── 행동 이상 신호 확인 처리 ──────────────────────────────────────────────────
async function ackSignal(id, btn) {
  try {
    await fetch(`/api/personal/signals/${encodeURIComponent(id)}/ack`, { method: 'POST' });
    const card = btn?.closest('.sg-card');
    if (card) {
      card.style.opacity = '0.35';
      card.style.pointerEvents = 'none';
      setTimeout(() => card.remove(), 500);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.ackSignal = ackSignal;

// ── 이슈 마킹 ────────────────────────────────────────────────────────────────
async function markIssue(opts = {}) {
  try {
    const r = await fetch('/api/personal/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity:   opts.severity   || 'medium',
        issue_type: opts.issue_type || '불명확',
        note:       opts.note       || '',
        source:     opts.source     || 'user_marked',
      }),
    });
    const d = await r.json();
    if (d.ok) {
      showToast('🚨 이슈 마킹 완료 — 직전 대화 패턴 역추적 중…');
      setTimeout(loadTriggers, 2000);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.markIssue = markIssue;

// ── 트리거 패턴 로드 ──────────────────────────────────────────────────────────
const TOPIC_KR = {
  work_pressure:'업무 압박', interpersonal:'인간관계 갈등',
  deadline:'일정 압박', blame_shift:'책임 전가',
  technical:'기술 문제', praise:'칭찬', other:'기타',
};
const SENTIMENT_KR = {
  positive:'긍정', negative:'부정', neutral:'중립',
  frustrated:'좌절', anxious:'불안', angry:'분노',
};
const URGENCY_KR = { none:'없음', low:'낮음', medium:'보통', high:'높음', critical:'위급' };

async function loadTriggers() {
  const el = document.getElementById('sg-trigger-list');
  if (!el) return;
  try {
    const [trigRes, riskRes] = await Promise.allSettled([
      fetch('/api/personal/triggers?limit=10'),
      fetch('/api/personal/risk'),
    ]);
    const triggers = trigRes.status==='fulfilled' ? ((await trigRes.value.json()).triggers||[]) : [];
    const riskData = riskRes.status==='fulfilled' ? (await riskRes.value.json()) : {};
    const riskLevel = riskData.riskLevel || 'unknown';
    const riskScore = riskData.score || 0;
    const matched   = riskData.matchedPattern;
    const riskColors = { high:'#f85149', medium:'#ff9500', low:'#3fb950', unknown:'#8b949e', none:'#3fb950' };
    const riskLabels = { high:'🔴 높음', medium:'🟠 보통', low:'🟢 낮음', unknown:'⚪ 미측정', none:'🟢 없음' };

    let html = `<div style="background:#0d1117;border-radius:8px;padding:8px 10px;margin-bottom:8px">
      <div style="font-size:10px;color:#6e7681;margin-bottom:4px">현재 대화 위험도</div>
      <div style="font-size:13px;font-weight:600;color:${riskColors[riskLevel]||'#8b949e'}">
        ${riskLabels[riskLevel]||riskLevel}
        <span style="font-size:10px;font-weight:normal;color:#6e7681"> (${(riskScore*100).toFixed(0)}%)</span>
      </div>
      ${matched ? `<div style="font-size:10px;color:#8b949e;margin-top:3px">
        유사 패턴: ${escHtml(TOPIC_KR[matched.dominant_topic]||'')} + ${escHtml(SENTIMENT_KR[matched.dominant_sentiment]||'')} → 평균 ${matched.hours_before_issue?.toFixed(0)||'?'}h 후 이슈
      </div>` : ''}
    </div>`;

    if (!triggers.length) {
      html += `<div style="font-size:11px;color:#6e7681;text-align:center;padding:12px 0">
        이슈 마킹 시 직전 대화 패턴을<br>역추적해 트리거를 학습합니다
      </div>`;
    } else {
      html += triggers.map(t => {
        const pct   = Math.round((t.correlation||0.5)*100);
        const color = pct>70?'#f85149':pct>50?'#ff9500':'#3fb950';
        return `<div style="margin-bottom:7px;padding:7px 9px;background:#0d1117;border-radius:6px;border-left:2px solid ${color}">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <span style="font-size:11px;color:#cdd9e5;font-weight:600">
              ${escHtml(TOPIC_KR[t.dominant_topic]||t.dominant_topic)} + ${escHtml(SENTIMENT_KR[t.dominant_sentiment]||'')}
            </span>
            <span style="font-size:10px;color:#6e7681">${t.frequency}회</span>
          </div>
          <div style="font-size:10px;color:#6e7681;margin-bottom:4px">
            ${URGENCY_KR[t.dominant_urgency]||''} · 평균 ${t.hours_before_issue?.toFixed(0)||'?'}h 전 시작
          </div>
          <div style="height:3px;background:#21262d;border-radius:2px">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div>
          </div>
          <div style="font-size:9px;color:#6e7681;margin-top:2px">예측 정확도 ${pct}%</div>
        </div>`;
      }).join('');
    }
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div style="color:#f85149;font-size:11px">❌ ${escHtml(e.message)}</div>`;
  }
}
window.loadTriggers = loadTriggers;

async function respondSuggestion(id, action) {
  try {
    await fetch(`/api/personal/suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const card = document.getElementById(`sg-card-${id}`);
    if (card) {
      card.style.opacity = '0.4';
      card.style.pointerEvents = 'none';
      setTimeout(() => { card.remove(); }, 600);
    }
    showToast(action === 'accept' ? '✅ 제안 수락됨' : '제안 무시됨');
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.respondSuggestion = respondSuggestion;

// ── 프롬프트 최적화 → Orbit 스킬 저장 ────────────────────────────────────────
async function savePromptSkill(suggestionId, fixedSkill) {
  try {
    // 스킬 저장 (POST /api/skills 또는 로컬 스킬 목록에 추가)
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:        fixedSkill.name        || '최적화 프롬프트',
        description: fixedSkill.description || 'AI 수정 패턴에서 학습된 최적 프롬프트',
        trigger:     fixedSkill.name        || '최적화 프롬프트',
        prompt:      fixedSkill.prompt      || '',
        type:        'prompt_template',
        source:      'suggestion_engine',
      }),
    });
    if (r.ok) {
      showToast('🧠 스킬로 저장됨! /skills 에서 확인하세요.');
      respondSuggestion(suggestionId, 'accept');
    } else {
      showToast('❌ 스킬 저장 실패: ' + (await r.text()));
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.savePromptSkill = savePromptSkill;

// ── 개인 학습 토글 ────────────────────────────────────────────────────────────
const _plState = { keyboard: true, file: true, app: true };

async function togglePersonalLearning(type) {
  _plState[type] = !_plState[type];
  try {
    const body = {};
    if (type === 'keyboard') body.keyboard    = _plState.keyboard;
    if (type === 'file')     body.fileWatcher = _plState.file;
    if (type === 'app')      body.appMonitor  = _plState.app;
    await fetch('/api/personal/toggle', { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    _updatePersonalToggles();
  } catch {}
}
window.togglePersonalLearning = togglePersonalLearning;

function _updatePersonalToggles() {
  const labels = { keyboard: 'sp-toggle-keyboard', file: 'sp-toggle-file', app: 'sp-toggle-app' };
  for (const [key, btnId] of Object.entries(labels)) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    btn.textContent = _plState[key] ? 'ON ●' : 'OFF ○';
    btn.style.color = _plState[key] ? '#3fb950' : '#8b949e';
  }
}

async function _loadPersonalStats() {
  try {
    const r    = await fetch('/api/personal/status');
    const data = await r.json();
    const el   = document.getElementById('sp-personal-stats');
    if (!el) return;
    const t = data.today || {};
    el.innerHTML = `
      <div>⌨️ 키보드: <strong style="color:#cdd9e5">${(t.keywordChars||0).toLocaleString()}자</strong></div>
      <div>📁 파일: <strong style="color:#cdd9e5">${t.fileContents||0}개 처리</strong></div>
      <div>🖥️ 앱 전환: <strong style="color:#cdd9e5">${t.appActivities||0}회</strong></div>
      <div>💡 대기 제안: <strong style="color:#f0c040">${data.pendingSuggestions||0}개</strong></div>
    `;

    // 동기화 상태 (level 0/1/2)
    const syncEl = document.getElementById('sp-sync-status');
    if (syncEl) {
      const lvl = data.syncLevel ?? (data.syncConsented ? 1 : 0);
      const lvlLabels = {
        0: { text:'🔒 내 기기에서만 학습 중', color:'#8b949e' },
        1: { text:'🤝 패턴 인사이트 공유 중 (내용 없음)', color:'#3fb950' },
        2: { text:'🔬 심층 학습 참여 중', color:'#bc78de' },
      };
      const lbl = lvlLabels[lvl] || lvlLabels[0];
      const lastTxt = data.lastSync ? ` · 마지막: ${relTime(data.lastSync)}` : '';
      syncEl.textContent = lbl.text + lastTxt;
      syncEl.style.color = lbl.color;

      // 현재 선택된 버튼 강조
      [0,1,2].forEach(n => {
        const btn = document.getElementById(`sp-sync-btn-${n}`);
        if (btn) btn.style.outline = n === lvl ? '2px solid currentColor' : '';
      });
    }
    _updatePersonalToggles();
  } catch {}
}

async function setSyncConsent(level) {
  // level: 0 = 로컬만, 1 = 제안만 전송, 2 = 원본 이벤트 포함
  try {
    const r    = await fetch('/api/sync/consent', { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({ level }) });
    const data = await r.json();
    const msgs = {
      0: '🔒 내 기기에서만 학습합니다',
      1: '🤝 패턴 인사이트 공유 시작 — 내용은 전송되지 않습니다',
      2: '🔬 심층 학습 참여 — 프롬프트 구조 공유로 솔루션 품질 향상에 기여합니다',
    };
    showToast(msgs[data.level ?? level] || '✅ 설정 저장');
    _loadPersonalStats();
    renderSetupPanel(); // sync 버튼 상태 갱신
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.setSyncConsent = setSyncConsent;

async function triggerSyncPush() {
  try {
    showToast('↑ 동기화 중…');
    const r    = await fetch('/api/sync/push', { method:'POST' });
    const data = await r.json();
    if (data.ok) showToast(`✅ 동기화 완료: 이벤트 ${data.eventCount||0}개`);
    else         showToast(`❌ ${data.error}`);
    _loadPersonalStats();
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.triggerSyncPush = triggerSyncPush;

async function startPersonalAgent() {
  try {
    const r    = await fetch('/api/exec/run', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command: 'node daemon/personal-agent.js &', cwd: '.', label: 'personal-agent' }) });
    showToast('▶ 개인 학습 에이전트 시작');
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.startPersonalAgent = startPersonalAgent;
