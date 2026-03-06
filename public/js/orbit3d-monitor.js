// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — AI Agent Monitor (PIP / Tile / Docking)
// ══════════════════════════════════════════════════════════════════════════════

const MONITOR_AGENTS = {
  claude:     { id:'claude',     label:'Claude',      icon:'🟣', accentColor:'#bc8cff' },
  openai:     { id:'openai',     label:'OpenAI',      icon:'🟢', accentColor:'#10a37f' },
  gemini:     { id:'gemini',     label:'Gemini',      icon:'🔵', accentColor:'#4285f4' },
  perplexity: { id:'perplexity', label:'Perplexity',  icon:'🟡', accentColor:'#20b8cd' },
  grok:       { id:'grok',       label:'Grok',        icon:'⚪', accentColor:'#e6edf3' },
  openclaw:   { id:'openclaw',   label:'OpenClaw',    icon:'🔴', accentColor:'#f85149' },
  cowork:     { id:'cowork',     label:'Co-Work',     icon:'🟠', accentColor:'#ffa657' },
  vscode:     { id:'vscode',     label:'VS Code',     icon:'💠', accentColor:'#007acc' },
};

// ─── State ───────────────────────────────────────────────────────────────────
let _monitorMode   = localStorage.getItem('orbitMonitorMode') || 'pip';   // pip | tile | dock
let _monitorOpen   = false;
let _openPanels    = [];  // [{ agentId, el, minimized, x, y, w, h, zIndex }]
let _panelZCounter = 1000;
const _agentEvents = {};  // agentId → [{ text, ts }]  최근 5개
const _agentStats  = {};  // agentId → { files, messages, activeMin, errors }

// Initialize agent data
Object.keys(MONITOR_AGENTS).forEach(id => {
  _agentEvents[id] = [];
  _agentStats[id]  = { files: 0, messages: 0, activeMin: 0, errors: 0 };
});

// ─── Monitor Toggle ──────────────────────────────────────────────────────────
function toggleMonitor() {
  _monitorOpen = !_monitorOpen;
  const picker = document.getElementById('monitor-picker');
  const container = document.getElementById('pip-container');
  if (picker) picker.classList.toggle('open', _monitorOpen);
  if (container) container.classList.toggle('open', _monitorOpen);
  document.getElementById('ln-monitor-btn')?.classList.toggle('active', _monitorOpen);
}
window.toggleMonitor = toggleMonitor;

// ─── Layout Mode Switch ─────────────────────────────────────────────────────
function setMonitorMode(mode) {
  _monitorMode = mode;
  localStorage.setItem('orbitMonitorMode', mode);
  document.querySelectorAll('.mp-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  repositionAllPanels();
}
window.setMonitorMode = setMonitorMode;

// ─── Agent Picker Toggle ─────────────────────────────────────────────────────
function toggleAgentPanel(agentId) {
  const idx = _openPanels.findIndex(p => p.agentId === agentId);
  if (idx >= 0) {
    removePanel(agentId);
  } else {
    addPanel(agentId);
  }
  updatePickerChips();
}
window.toggleAgentPanel = toggleAgentPanel;

// ─── Create Panel ────────────────────────────────────────────────────────────
function addPanel(agentId) {
  const agent = MONITOR_AGENTS[agentId];
  if (!agent) return;

  const el = document.createElement('div');
  el.className = 'monitor-panel';
  el.id = `mpanel-${agentId}`;
  el.dataset.agent = agentId;
  el.style.borderColor = agent.accentColor + '60';

  const state = { agentId, el, minimized: false, x: 0, y: 0, w: 360, h: 280, zIndex: ++_panelZCounter };

  el.innerHTML = buildPanelHTML(agent);
  el.style.zIndex = state.zIndex;

  // Bring to front on click
  el.addEventListener('mousedown', () => {
    state.zIndex = ++_panelZCounter;
    el.style.zIndex = state.zIndex;
  });

  // Drag
  const header = el.querySelector('.mp-hdr');
  if (header) initDrag(header, el, state);

  // Resize
  const resizer = el.querySelector('.mp-resize');
  if (resizer) initResize(resizer, el, state);

  document.getElementById('pip-container').appendChild(el);
  _openPanels.push(state);
  repositionAllPanels();
  saveMonitorLayout();
}

function removePanel(agentId) {
  const idx = _openPanels.findIndex(p => p.agentId === agentId);
  if (idx < 0) return;
  _openPanels[idx].el.remove();
  _openPanels.splice(idx, 1);
  repositionAllPanels();
  saveMonitorLayout();
}

function minimizePanel(agentId) {
  const panel = _openPanels.find(p => p.agentId === agentId);
  if (!panel) return;
  panel.minimized = !panel.minimized;
  panel.el.classList.toggle('minimized', panel.minimized);
}
window.minimizePanel = minimizePanel;

function closePanelBtn(agentId) {
  removePanel(agentId);
  updatePickerChips();
}
window.closePanelBtn = closePanelBtn;

// ─── Panel HTML ──────────────────────────────────────────────────────────────
function buildPanelHTML(agent) {
  const statusClass = getAgentStatusClass(agent.id);
  return `
    <div class="mp-hdr" style="border-bottom-color:${agent.accentColor}30">
      <div class="mp-led ${statusClass}"></div>
      <span class="mp-agent-icon">${agent.icon}</span>
      <span class="mp-agent-label">${agent.label}</span>
      <div class="mp-hdr-actions">
        <button class="mp-btn" onclick="minimizePanel('${agent.id}')" title="최소화">─</button>
        <button class="mp-btn" onclick="closePanelBtn('${agent.id}')" title="닫기">✕</button>
      </div>
    </div>
    <div class="mp-body">
      <div class="mp-cctv">
        <div class="mp-status-row">
          <span class="mp-status-text" id="mp-status-${agent.id}">대기 중...</span>
        </div>
        <div class="mp-events" id="mp-events-${agent.id}">
          <div class="mp-event-empty">이벤트 대기 중</div>
        </div>
      </div>
      <div class="mp-stats-row">
        <div class="mp-stat"><b id="mp-s-files-${agent.id}">0</b><span>파일</span></div>
        <div class="mp-stat"><b id="mp-s-msgs-${agent.id}">0</b><span>메시지</span></div>
        <div class="mp-stat"><b id="mp-s-time-${agent.id}">0m</b><span>활동</span></div>
        <div class="mp-stat"><b id="mp-s-errs-${agent.id}">0</b><span>오류</span></div>
      </div>
    </div>
    <div class="mp-resize">⤡</div>
  `;
}

function getAgentStatusClass(agentId) {
  const stats = _agentStats[agentId];
  if (!stats) return 'gray';
  if (stats.errors > 0) return 'red';
  if (stats.messages > 0) return 'green';
  return 'gray';
}

// ─── Update panel content ────────────────────────────────────────────────────
function updatePanelContent(agentId) {
  const stats = _agentStats[agentId];
  const events = _agentEvents[agentId];
  if (!stats) return;

  const filesEl = document.getElementById(`mp-s-files-${agentId}`);
  const msgsEl  = document.getElementById(`mp-s-msgs-${agentId}`);
  const timeEl  = document.getElementById(`mp-s-time-${agentId}`);
  const errsEl  = document.getElementById(`mp-s-errs-${agentId}`);

  if (filesEl) filesEl.textContent = stats.files;
  if (msgsEl)  msgsEl.textContent  = stats.messages;
  if (timeEl)  timeEl.textContent  = stats.activeMin + 'm';
  if (errsEl)  errsEl.textContent  = stats.errors;

  // Update LED
  const led = document.querySelector(`#mpanel-${agentId} .mp-led`);
  if (led) {
    led.className = 'mp-led ' + getAgentStatusClass(agentId);
  }

  // Update events list
  const evEl = document.getElementById(`mp-events-${agentId}`);
  if (evEl && events.length > 0) {
    evEl.innerHTML = events.slice(0, 5).map(e => {
      const ago = formatTimeAgo(e.ts);
      return `<div class="mp-event-item"><span class="mp-ev-time">${ago}</span><span class="mp-ev-text">${e.text}</span></div>`;
    }).join('');
  }

  // Update status text
  const statusEl = document.getElementById(`mp-status-${agentId}`);
  if (statusEl && events.length > 0) {
    statusEl.textContent = events[0].text;
  }
}

// ─── Route WebSocket event to monitor ────────────────────────────────────────
function routeEventToMonitor(m) {
  if (!_monitorOpen) return;

  let agentId = null;
  let eventText = '';

  // Detect agent from event
  if (m.type === 'ollama_analysis') {
    agentId = 'openclaw';
    eventText = m.data?.focus || 'Ollama 분석 중';
  } else if (m.type === 'ai_conversation_saved') {
    const site = (m.site || '').toLowerCase();
    if (site.includes('claude')) agentId = 'claude';
    else if (site.includes('chatgpt') || site.includes('openai')) agentId = 'openai';
    else if (site.includes('gemini')) agentId = 'gemini';
    else if (site.includes('perplexity')) agentId = 'perplexity';
    else if (site.includes('grok')) agentId = 'grok';
    else agentId = 'cowork';
    eventText = m.title || `${m.site} 대화`;
    _agentStats[agentId].messages++;
  } else if (m.type === 'new_event' && m.event) {
    const et = m.event.type || '';
    if (et.startsWith('vscode.')) {
      agentId = 'vscode';
      eventText = m.event.data?.fileName || et;
      if (et === 'vscode.file_save') _agentStats.vscode.files++;
    } else if (et.startsWith('terminal.')) {
      agentId = 'vscode';
      eventText = m.event.data?.command?.slice(0, 40) || 'Terminal';
    }
  } else if (m.type === 'skill_suggestion') {
    agentId = 'openclaw';
    eventText = m.data?.alias || '스킬 제안';
  }

  if (!agentId) return;

  // Push event
  _agentEvents[agentId].unshift({ text: eventText, ts: Date.now() });
  if (_agentEvents[agentId].length > 20) _agentEvents[agentId].pop();

  // Update stats
  _agentStats[agentId].activeMin = Math.round((Date.now() - (_agentStats[agentId]._startTime || Date.now())) / 60000);
  if (!_agentStats[agentId]._startTime) _agentStats[agentId]._startTime = Date.now();

  updatePanelContent(agentId);
}
window.routeEventToMonitor = routeEventToMonitor;

// ─── Reposition panels by layout mode ────────────────────────────────────────
function repositionAllPanels() {
  const container = document.getElementById('pip-container');
  if (!container) return;

  container.className = `pip-container mode-${_monitorMode}`;
  if (!_monitorOpen) container.classList.remove('open');
  else container.classList.add('open');

  if (_monitorMode === 'pip') {
    // PIP: free-floating, restore saved positions
    const saved = JSON.parse(localStorage.getItem('orbitMonitorPositions') || '{}');
    _openPanels.forEach((p, i) => {
      const s = saved[p.agentId];
      p.el.style.position = 'fixed';
      p.el.style.width  = (s?.w || 360) + 'px';
      p.el.style.height = (s?.h || 280) + 'px';
      p.el.style.left   = (s?.x ?? (80 + i * 30)) + 'px';
      p.el.style.top    = (s?.y ?? (80 + i * 30)) + 'px';
      p.el.classList.remove('tile-mode', 'dock-mode');
    });
  } else if (_monitorMode === 'tile') {
    // Tile: CCTV grid
    const count = _openPanels.length;
    const cols  = count <= 2 ? count : count <= 4 ? 2 : 3;
    _openPanels.forEach((p, i) => {
      p.el.style.position = 'relative';
      p.el.style.width  = '';
      p.el.style.height = '';
      p.el.style.left   = '';
      p.el.style.top    = '';
      p.el.classList.add('tile-mode');
      p.el.classList.remove('dock-mode');
    });
    container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  } else if (_monitorMode === 'dock') {
    // Dock: right-side stacked accordion
    _openPanels.forEach(p => {
      p.el.style.position = 'relative';
      p.el.style.width  = '';
      p.el.style.height = '';
      p.el.style.left   = '';
      p.el.style.top    = '';
      p.el.classList.add('dock-mode');
      p.el.classList.remove('tile-mode');
    });
  }
}

// ─── Drag ────────────────────────────────────────────────────────────────────
function initDrag(handle, el, state) {
  let startX, startY, origX, origY;
  handle.addEventListener('mousedown', e => {
    if (_monitorMode !== 'pip') return;
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
      state.x = el.offsetLeft;
      state.y = el.offsetTop;
      saveMonitorLayout();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Resize ──────────────────────────────────────────────────────────────────
function initResize(handle, el, state) {
  handle.addEventListener('mousedown', e => {
    if (_monitorMode !== 'pip') return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const origW = el.offsetWidth, origH = el.offsetHeight;
    const onMove = ev => {
      el.style.width  = Math.max(260, origW + ev.clientX - startX) + 'px';
      el.style.height = Math.max(180, origH + ev.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      state.w = el.offsetWidth;
      state.h = el.offsetHeight;
      saveMonitorLayout();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ─── Persist layout ──────────────────────────────────────────────────────────
function saveMonitorLayout() {
  const positions = {};
  _openPanels.forEach(p => {
    positions[p.agentId] = { x: p.x, y: p.y, w: p.w, h: p.h };
  });
  localStorage.setItem('orbitMonitorPositions', JSON.stringify(positions));
  localStorage.setItem('orbitMonitorOpenPanels', JSON.stringify(_openPanels.map(p => p.agentId)));
}

// ─── Restore on load ─────────────────────────────────────────────────────────
function restoreMonitorLayout() {
  const saved = JSON.parse(localStorage.getItem('orbitMonitorOpenPanels') || '[]');
  saved.forEach(id => {
    if (MONITOR_AGENTS[id]) addPanel(id);
  });
  updatePickerChips();
}

// ─── Update picker chip states ───────────────────────────────────────────────
function updatePickerChips() {
  const openIds = new Set(_openPanels.map(p => p.agentId));
  document.querySelectorAll('.mp-agent-chip').forEach(chip => {
    chip.classList.toggle('active', openIds.has(chip.dataset.agent));
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function formatTimeAgo(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return sec + '초';
  if (sec < 3600) return Math.floor(sec / 60) + '분';
  return Math.floor(sec / 3600) + '시간';
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Set initial mode buttons
  document.querySelectorAll('.mp-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === _monitorMode);
  });
});
