'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — AI 패널들 (인사이트, 목적 타임라인, AI 추천, 트리거, 개인학습)
// [orbit3d-render.js에서 분할]
// ══════════════════════════════════════════════════════════════════════════════

// ─── 패널 상호 배제: 오른쪽 패널 일괄 닫기 ──────────────────────────────────
function closeAllRightPanels(except) {
  const panels = ['messenger-panel', 'insight-panel', 'suggestion-panel', 'follow-panel', 'my-talent-panel', 'learning-data-panel'];
  panels.forEach(id => {
    if (id === except) return;
    const el = document.getElementById(id);
    if (el) {
      el.style.display = 'none';
      el.classList.remove('open');
    }
  });
}
window.closeAllRightPanels = closeAllRightPanels;

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

// ── 서버 분석 데이터 캐시 (직원 PC 트래킹 기반) ──
let _analysisCache = null;
let _analysisCacheTs = 0;

async function _fetchAnalysis() {
  if (_analysisCache && Date.now() - _analysisCacheTs < 60000) return _analysisCache;
  try {
    const r = await _authFetch('/api/learning/analyze');
    if (r.ok) { _analysisCache = await r.json(); _analysisCacheTs = Date.now(); }
  } catch {}
  return _analysisCache;
}

function computeInsights() {
  // 로컬 노드 기반 실시간 피드 (기존 유지)
  const cutoff = Date.now() - 3_600_000;
  const recentEvents = [..._allNodes]
    .filter(n => new Date(n.timestamp || n.created_at || 0) > cutoff)
    .sort((a,b) => new Date(b.timestamp || b.created_at || 0) - new Date(a.timestamp || a.created_at || 0))
    .slice(0, 20);
  const total = _allNodes.length;

  // 앱별 분포 (로컬 노드에서)
  const appDist = {};
  _allNodes.forEach(n => {
    const app = n.data?.app || n.data?.activeApp || '';
    if (app) appDist[app] = (appDist[app] || 0) + 1;
  });
  const APP_COLORS = { explorer:'#f0883e', kakaotalk:'#ffe066', chrome:'#58a6ff', excel:'#3fb950', nenova:'#bc8cff' };
  const distRows = Object.entries(appDist)
    .sort((a,b) => b[1] - a[1]).slice(0, 6)
    .map(([app, cnt]) => ({ label: app, color: APP_COLORS[app] || '#8b949e', pct: Math.round(cnt / Math.max(total, 1) * 100) }));

  return { recentEvents, distRows, total };
}

const _INS_TYPE_ICON = {
  'keyboard.chunk':'⌨️', 'screen.capture':'📸', 'screen.analyzed':'🔍',
  'idle':'💤', 'file.change':'📁', 'clipboard.change':'📋',
  'bank.security.active':'🏦', 'tool.end':'✅', 'file.read':'📄', 'file.write':'✏️',
};

// ─── 탭 전환 ─────────────────────────────────────────────────────────────────
let _insightTab = 'feed'; // 'feed' | 'purpose' | 'stats'

function switchInsightTab(tab) {
  _insightTab = tab;
  ['feed','purpose','stats','routine'].forEach(t => {
    const tabEl = document.getElementById(`ins-tab-${t}`);
    if (tabEl) tabEl.classList.toggle('active', t === tab);
    const pane = document.getElementById(`ins-pane-${t}`);
    if (pane) {
      if (t === tab) pane.style.display = 'flex';
      else           pane.style.display = 'none';
    }
  });
  if      (tab === 'feed')    renderFeedTab();
  else if (tab === 'purpose') renderPurposeTab();
  else if (tab === 'stats')   renderStatsTab();
  else if (tab === 'routine') renderRoutineTab();
}
window.switchInsightTab = switchInsightTab;

// ─── 실시간 피드 탭 ──────────────────────────────────────────────────────────
function renderFeedTab() {
  const ins = computeInsights();
  document.getElementById('ins-feed-list').innerHTML = ins.recentEvents.length
    ? ins.recentEvents.map(n => {
        const app = n.data?.app || n.data?.activeApp || '';
        const title = n.data?.windowTitle || '';
        const label = n.label || (app ? `${app}: ${title}` : n.type);
        return `<div class="ins-feed-item">
          <span class="ins-feed-icon">${_INS_TYPE_ICON[n.type]||'·'}</span>
          <div class="ins-feed-body">
            <div class="ins-feed-label" title="${escHtml(label)}">${escHtml(label.slice(0,42))}</div>
            <div class="ins-feed-time">${relTime(n.timestamp||n.created_at)}</div>
          </div>
        </div>`;
      }).join('')
    : `<div style="padding:14px 4px;color:#6e7681;font-size:12px;">
         최근 1시간 이벤트 없음<br>
         <span style="font-size:10px;color:#3d444d">전체 ${ins.total.toLocaleString()}개 보유</span>
       </div>`;
  document.getElementById('ins-feed-meta').textContent =
    `총 ${ins.recentEvents.length}개 · 최근 1시간`;
}

// ─── 앱 사용 분석 탭 (서버 데이터 기반) ──────────────────────────────────────
async function renderPurposeTab() {
  const el = document.getElementById('ins-purpose-list');
  el.innerHTML = '<div style="padding:14px;color:#6e7681;font-size:12px;text-align:center">분석 중...</div>';

  const data = await _fetchAnalysis();
  if (!data || data.status !== 'ok') {
    el.innerHTML = '<div style="padding:14px;color:#6e7681;font-size:12px;text-align:center">분석 데이터 없음</div>';
    return;
  }

  const totalEv = (data.topApps || []).reduce((s, a) => s + a[1], 0) || 1;
  const APP_COLORS = { explorer:'#f0883e', kakaotalk:'#ffe066', chrome:'#58a6ff', excel:'#3fb950', nenova:'#bc8cff' };

  // 앱별 사용 카드
  const appCards = (data.topApps || []).slice(0, 6).map(([app, cnt]) => {
    const pct = Math.round(cnt / totalEv * 100);
    const c = APP_COLORS[app] || '#8b949e';
    return `<div style="padding:8px 0;border-bottom:1px solid #21262d">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:12px;color:#e6edf3">${escHtml(app)}</span>
        <span style="font-size:11px;color:#8b949e">${cnt}건 (${pct}%)</span>
      </div>
      <div style="height:5px;background:#21262d;border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${c};border-radius:3px"></div>
      </div>
    </div>`;
  }).join('');

  // 카테고리 칩
  const catChips = (data.topCategories || []).slice(0, 5).map(([cat, cnt]) => {
    const pct = Math.round(cnt / totalEv * 100);
    return `<span style="display:inline-block;padding:3px 8px;margin:2px;border-radius:10px;font-size:11px;background:#21262d;color:#e6edf3">${escHtml(cat)} ${pct}%</span>`;
  }).join('');

  // 인사이트
  const insights = (data.insights || []).map(i => {
    const icon = i.type === 'automation' ? '⚡' : i.type === 'focus' ? '🎯' : '💡';
    return `<div style="padding:5px 0;font-size:11px;color:#cdd9e5">${icon} ${escHtml(i.text)}</div>`;
  }).join('');

  el.innerHTML = `
    <div style="padding:4px 0">
      <div style="font-size:11px;color:#6e7681;margin-bottom:6px">앱 사용 분포</div>
      ${appCards}
    </div>
    ${catChips ? `<div style="padding:8px 0"><div style="font-size:11px;color:#6e7681;margin-bottom:4px">작업 카테고리</div>${catChips}</div>` : ''}
    ${insights ? `<div style="padding:8px 0;border-top:1px solid #21262d"><div style="font-size:11px;color:#6e7681;margin-bottom:4px">인사이트</div>${insights}</div>` : ''}
    <div style="text-align:center;font-size:10px;color:#484f58;padding-top:6px">
      이벤트 ${data.eventCount?.toLocaleString() || 0}건 · 세션 ${data.sessionCount || 0}개 · 자동화 ${data.automationScore || 0}/100
    </div>
  `;
}
window.renderPurposeTab = renderPurposeTab;

// ─── 통계 탭 (앱 분포 + 세션 요약) ─────────────────────────────────────────
function renderStatsTab() {
  const ins = computeInsights();
  document.getElementById('ins-dist-list').innerHTML = ins.distRows.length
    ? ins.distRows.filter(r => r.pct > 0).map(r => `
      <div class="ins-dist-row">
        <span class="ins-dist-label">${escHtml(r.label)}</span>
        <div class="ins-dist-bg">
          <div class="ins-dist-fill" style="width:${r.pct}%;background:${r.color}"></div>
        </div>
        <span class="ins-dist-pct">${r.pct}%</span>
      </div>`).join('')
    : '<div style="padding:8px;color:#6e7681;font-size:11px">앱 데이터 없음</div>';

  // KV 리스트: 직원 트래킹 기반 요약
  const captureCount = _allNodes.filter(n => n.type === 'screen.capture').length;
  const keyboardCount = _allNodes.filter(n => n.type === 'keyboard.chunk').length;
  const analyzedCount = _allNodes.filter(n => n.type === 'screen.analyzed').length;
  const idleCount = _allNodes.filter(n => n.type === 'idle').length;
  document.getElementById('ins-kv-list').innerHTML = [
    ['📸 캡처',      `${captureCount}건`],
    ['⌨️ 키보드',    `${keyboardCount}건`],
    ['🔍 Vision 분석', `${analyzedCount}건`],
    ['💤 대기',      `${idleCount}건`],
    ['📦 전체 이벤트', `${ins.total.toLocaleString()}개`],
  ].map(([k,v]) => `
    <div class="ins-kv-row">
      <span class="ins-kv-key">${k}</span>
      <span class="ins-kv-val">${escHtml(String(v))}</span>
    </div>`).join('');
}

// ─── 최근 작업 세션 탭 ──────────────────────────────────────────────────────
async function renderRoutineTab() {
  const el = document.getElementById('ins-routine-content');
  if (!el) return;

  el.innerHTML = '<div style="text-align:center;padding:28px 0;color:#6e7681;font-size:12px">로딩 중...</div>';

  const data = await _fetchAnalysis();
  if (!data || !data.sessions?.length) {
    el.innerHTML = '<div style="text-align:center;padding:20px 0;color:#6e7681;font-size:12px">세션 데이터 없음</div>';
    return;
  }

  el.innerHTML = data.sessions.slice(0, 8).map(s => {
    const app = s.primaryApp || '';
    const cat = s.primaryCategory || '';
    const dur = s.durationMin ? `${s.durationMin}분` : '';
    const wins = (s.uniqueWindows || []).slice(0, 2).join(', ');
    return `<div style="padding:8px 0;border-bottom:1px solid #21262d">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;color:#58a6ff">${escHtml(app)}</span>
        <span style="font-size:10px;color:#8b949e">${escHtml(dur)} · ${escHtml(cat)}</span>
      </div>
      ${wins ? `<div style="font-size:10px;color:#484f58;margin-top:2px">${escHtml(wins)}</div>` : ''}
      <div style="font-size:10px;color:#3d444d;margin-top:2px">캡처 ${s.captureCount || 0}건 · 클릭 ${s.totalClicks || 0}회 · 이벤트 ${s.eventCount || 0}건</div>
    </div>`;
  }).join('');
}
window.renderRoutineTab = renderRoutineTab;

function _renderRoutineData(el, data) {
  if (!data.patterns) {
    el.innerHTML = '<div style="text-align:center;padding:20px 0;color:#6e7681;font-size:12px">로그인이 필요합니다</div>';
    return;
  }

  const p = data.patterns;
  let html = '';

  // ── 요약 헤더 ────────────────────────────────────────────────────────────
  html += `<div style="background:rgba(37,99,235,.06);border:1px solid rgba(37,99,235,.2);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <div style="font-size:12px;font-weight:700;color:#58a6ff;margin-bottom:4px">작업 루틴 분석</div>
    <div style="font-size:11px;color:#8b949e">${p.totalSessions}개 세션 / ${p.totalWorkUnits}개 작업 단위</div>
  </div>`;

  // ── 반복 패턴 ────────────────────────────────────────────────────────────
  if (p.routines && p.routines.length > 0) {
    html += `<div class="ins-section-title" style="padding-left:0">반복 작업 패턴</div>`;
    html += p.routines.slice(0, 5).map((r, i) => {
      const steps = r.sequence.split('\u2192');
      const stepsHtml = steps.map(s =>
        `<span style="font-size:10px;background:rgba(63,185,80,.1);color:#3fb950;border-radius:4px;padding:2px 6px;white-space:nowrap">${escHtml(s.trim())}</span>`
      ).join('<span style="color:#3d444d;font-size:9px;margin:0 2px">\u203A</span>');
      return `<div style="background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:11px;color:#e6edf3;font-weight:600">#${i+1}</span>
          <span style="font-size:10px;color:#ffa657;font-weight:600">${r.count}회 반복</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:3px">${stepsHtml}</div>
      </div>`;
    }).join('');
  } else {
    html += `<div style="background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px;margin-bottom:10px;text-align:center">
      <div style="font-size:11px;color:#6e7681">아직 반복 패턴이 감지되지 않았습니다</div>
      <div style="font-size:10px;color:#3d444d;margin-top:4px">더 많은 작업 데이터가 쌓이면 자동으로 분석됩니다</div>
    </div>`;
  }

  // ── 시간대별 패턴 ────────────────────────────────────────────────────────
  const timeEntries = Object.entries(p.timePatterns || {}).sort((a, b) => b[1] - a[1]);
  if (timeEntries.length > 0) {
    const maxTime = timeEntries[0][1];
    const TIME_ICONS = { '새벽': '🌙', '오전': '☀️', '오후': '🌤️', '저녁': '🌆' };
    html += `<div class="ins-section-title" style="padding-left:0;margin-top:8px">시간대별 작업량</div>`;
    html += timeEntries.map(([slot, count]) => {
      const pct = Math.round(count / maxTime * 100);
      return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <span style="font-size:12px;width:20px;text-align:center">${TIME_ICONS[slot] || ''}</span>
        <span style="font-size:11px;color:#8b949e;width:28px;flex-shrink:0">${slot}</span>
        <div style="flex:1;height:6px;background:#161b22;border-radius:3px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:linear-gradient(90deg,#2563eb,#58a6ff);border-radius:3px"></div>
        </div>
        <span style="font-size:10px;color:#6e7681;width:30px;text-align:right">${count}건</span>
      </div>`;
    }).join('');
  }

  // ── 도구 사용 패턴 ───────────────────────────────────────────────────────
  const toolEntries = Object.entries(p.toolPatterns || {}).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    const TOOL_META = {
      edit:     { icon: '✏️', label: '편집',     color: '#ffa657' },
      write:    { icon: '📝', label: '파일 생성', color: '#3fb950' },
      bash:     { icon: '💻', label: '터미널',   color: '#bc78de' },
      research: { icon: '🔍', label: '검색',     color: '#58a6ff' },
    };
    const maxTool = toolEntries[0][1];
    html += `<div class="ins-section-title" style="padding-left:0;margin-top:8px">도구 사용 빈도</div>`;
    html += toolEntries.map(([tool, count]) => {
      const meta = TOOL_META[tool] || { icon: '🔧', label: tool, color: '#8b949e' };
      const pct = Math.round(count / maxTool * 100);
      return `<div style="display:flex;align-items:center;gap:8px;margin:4px 0">
        <span style="font-size:12px;width:20px;text-align:center">${meta.icon}</span>
        <span style="font-size:11px;color:#8b949e;width:52px;flex-shrink:0">${meta.label}</span>
        <div style="flex:1;height:6px;background:#161b22;border-radius:3px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${meta.color};border-radius:3px"></div>
        </div>
        <span style="font-size:10px;color:#6e7681;width:30px;text-align:right">${count}회</span>
      </div>`;
    }).join('');
  }

  // ── 파일 역할 분포 ───────────────────────────────────────────────────────
  const roleEntries = Object.entries(p.fileRolePatterns || {}).sort((a, b) => b[1] - a[1]);
  if (roleEntries.length > 0) {
    const ROLE_COLORS = {
      '인증': '#f85149', 'API': '#58a6ff', '서비스': '#bc78de', 'UI': '#ffa657',
      '모델': '#39d2c0', '테스트': '#3fb950', '설정': '#8b949e', '이벤트처리': '#ff9500',
      '배포': '#d2a8ff', '코드': '#6e7681',
    };
    html += `<div class="ins-section-title" style="padding-left:0;margin-top:8px">파일 역할 분포</div>`;
    html += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px">`;
    html += roleEntries.slice(0, 8).map(([role, count]) => {
      const color = ROLE_COLORS[role] || '#6e7681';
      return `<span style="font-size:10px;background:${color}15;color:${color};border:1px solid ${color}33;border-radius:12px;padding:3px 8px">${role} ${count}</span>`;
    }).join('');
    html += `</div>`;
  }

  // ── 개선 제안 ────────────────────────────────────────────────────────────
  if (p.suggestions && p.suggestions.length > 0) {
    const SUG_ICONS = { routine: '🔄', time: '⏰', specialization: '🎯', tool: '🔧' };
    html += `<div class="ins-section-title" style="padding-left:0;margin-top:8px">개선 제안</div>`;
    html += p.suggestions.map(s => {
      const icon = SUG_ICONS[s.type] || '💡';
      return `<div style="background:rgba(255,166,87,.06);border:1px solid rgba(255,166,87,.2);border-left:3px solid #ffa657;border-radius:6px;padding:8px 10px;margin-bottom:6px">
        <div style="font-size:11px;color:#e6edf3">${icon} ${escHtml(s.message)}</div>
      </div>`;
    }).join('');
  }

  // ── 새로고침 + Sheets 내보내기 버튼 ──────────────────────────────────────
  html += `<div style="display:flex;justify-content:center;gap:8px;margin-top:10px;padding-bottom:10px">
    <button onclick="_routineCache=null;renderRoutineTab()"
      style="background:none;border:1px solid #30363d;color:#8b949e;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:11px;font-family:inherit">
      ↺ 새로고침
    </button>
    <button onclick="exportLearningSheet()"
      style="background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:#34d399;border-radius:6px;padding:5px 14px;cursor:pointer;font-size:11px;font-family:inherit">
      📊 Sheets 내보내기
    </button>
  </div>`;

  el.innerHTML = html;
}

// ─── renderInsightPanel: 현재 활성 탭 렌더 ──────────────────────────────────
function renderInsightPanel() {
  if      (_insightTab === 'feed')    renderFeedTab();
  else if (_insightTab === 'purpose') renderPurposeTab();
  else if (_insightTab === 'stats')   renderStatsTab();
  else if (_insightTab === 'routine') renderRoutineTab();
}
window.renderInsightPanel = renderInsightPanel;

// ─── 패널 열기/닫기 ──────────────────────────────────────────────────────────
let _insightRefreshTimer = null;

function toggleInsightPanel() {
  const panel  = document.getElementById('insight-panel');
  const isOpen = panel.classList.contains('open');
  closeAllRightPanels('insight-panel');
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

    // 의도 기반 업무 타임라인 추가
    const purposeEvents = p.eventIds ? (_allNodes || []).filter(n => p.eventIds.includes(n.id)) : [];
    if (purposeEvents.length > 0 && typeof renderWorkUnits === 'function') {
      kvList.innerHTML +=
        '<div style="margin-top:10px;font-size:11px;color:#cdd9e5;font-weight:600;margin-bottom:4px">📋 작업 흐름</div>'
        + renderWorkUnits(purposeEvents);
    }
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
  closeAllRightPanels('suggestion-panel');
  panel.classList.toggle('open', _sgOpen);
  btn?.classList.toggle('active', _sgOpen);
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
  list.innerHTML = '<div class="sg-empty">분석 중…</div>';

  try {
    const data = await _fetchAnalysis();
    if (!data || data.status !== 'ok') {
      list.innerHTML = '<div class="sg-empty">분석 데이터가 아직 없습니다.<br><br><span style="font-size:10px">PC에서 데이터가 수집되면 자동으로 분석됩니다</span></div>';
      if (footer) footer.textContent = '';
      return;
    }

    let html = '';
    const insights = data.insights || [];
    const sessions = data.sessions || [];

    // ── 인사이트 기반 추천 ────────────────────────────────────────
    if (insights.length) {
      html += `<div style="font-size:10px;color:#3fb950;font-weight:600;padding:6px 0 4px;border-bottom:1px solid rgba(63,185,80,.25);margin-bottom:6px">💡 분석 인사이트 (${insights.length})</div>`;
      html += insights.map(i => {
        const icon = i.type === 'automation' ? '⚡' : i.type === 'focus' ? '🎯' : '💡';
        const colors = { automation:'#ff9500', focus:'#58a6ff', info:'#3fb950' };
        return `<div style="padding:8px 10px;margin-bottom:6px;background:#0d1117;border-radius:8px;border-left:2px solid ${colors[i.type]||'#8b949e'}">
          <div style="font-size:12px;color:#cdd9e5">${icon} ${escHtml(i.text)}</div>
        </div>`;
      }).join('');
    }

    // ── 자동화 가능성 ──────────────────────────────────────────
    const score = data.automationScore || 0;
    const scoreColor = score >= 60 ? '#3fb950' : score >= 30 ? '#ff9500' : '#f85149';
    html += `<div style="padding:10px;margin:8px 0;background:#0d1117;border-radius:8px">
      <div style="font-size:10px;color:#6e7681;margin-bottom:4px">자동화 가능성</div>
      <div style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;height:6px;background:#21262d;border-radius:3px;overflow:hidden">
          <div style="height:100%;width:${score}%;background:${scoreColor};border-radius:3px"></div>
        </div>
        <span style="font-size:13px;font-weight:600;color:${scoreColor}">${score}/100</span>
      </div>
    </div>`;

    // ── 주요 앱별 작업 요약 ──────────────────────────────────────
    if (sessions.length) {
      html += `<div style="font-size:10px;color:#8b949e;font-weight:600;padding:8px 0 4px;border-bottom:1px solid #30363d;margin-bottom:6px;margin-top:4px">🕐 최근 작업 세션 (${sessions.length})</div>`;
      html += sessions.slice(0, 5).map(s => {
        const app = s.primaryApp || '앱';
        const cat = s.primaryCategory || '';
        const dur = s.durationMin ? `${s.durationMin}분` : '';
        return `<div style="padding:6px 10px;margin-bottom:4px;background:#0d1117;border-radius:6px">
          <div style="display:flex;justify-content:space-between">
            <span style="font-size:11px;color:#58a6ff">${escHtml(app)}</span>
            <span style="font-size:10px;color:#6e7681">${escHtml(dur)} ${escHtml(cat)}</span>
          </div>
        </div>`;
      }).join('');
    }

    list.innerHTML = html;
    if (footer) footer.textContent = `이벤트 ${data.eventCount?.toLocaleString()||0}건 · 세션 ${data.sessionCount||0}개`;
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
    }).catch(e => console.warn('[solution] 사용 기록 실패:', e.message));
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
