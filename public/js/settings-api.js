const AI_COLORS = {
  claude:'#3fb950', n8n:'#ea4b71', openai:'#8b949e',
  cursor:'#58a6ff', vscode:'#f85149', perplexity:'#bc8cff', gpt:'#8b949e', default:'#6b7280'
};

// 현재 Orbit에서 지원하는 전체 기능 목록
const ALL_FEATURES = [
  { key:'맵 뷰', desc:'vis-network 기반 마인드맵' },
  { key:'행성계 뷰', desc:'orbit.html 캔버스 애니메이션' },
  { key:'대시보드', desc:'통계/분석 페이지' },
  { key:'히스토리', desc:'이벤트 타임라인 + 롤백' },
  { key:'설정', desc:'라벨/채널 커스터마이징' },
  { key:'Claude 훅', desc:'Claude Code 실시간 연동' },
  { key:'n8n 연동', desc:'n8n 워크플로우 이벤트' },
  { key:'VS Code 연동', desc:'파일 변경 감지' },
  { key:'채널 시스템', desc:'팀 협업 공간 분리' },
  { key:'보안 스캐너', desc:'API 키 유출 감지' },
  { key:'코드 분석', desc:'파일 접근 패턴 분석' },
  { key:'WebSocket', desc:'실시간 브로드캐스트' },
  { key:'롤백', desc:'이벤트 지점 복원' },
  { key:'검색', desc:'이벤트 전문 검색' },
  { key:'PostgreSQL', desc:'DB 자동 전환' },
];

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b,i) => {
    b.classList.toggle('active', ['analysis','tools','channels','insights'][i] === name);
  });
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
}

function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── 사용 분석 ──────────────────────────────────────
async function loadAnalysis() {
  const [statsRes, graphRes, sessionsRes] = await Promise.all([
    fetch('/api/stats'), fetch('/api/graph'), fetch('/api/sessions')
  ]);
  const stats    = await statsRes.json();
  const graph    = await graphRes.json();
  const sessions = await sessionsRes.json();
  const nodes    = graph.nodes || [];

  // 통계 카드
  const retention = sessions.length > 0
    ? Math.round(nodes.length / sessions.length)
    : 0;
  document.getElementById('stat-grid').innerHTML = `
    <div class="stat-mini">
      <div class="stat-mini-val" style="color:var(--green)">${stats.eventCount||0}</div>
      <div class="stat-mini-lbl">총 이벤트</div>
    </div>
    <div class="stat-mini">
      <div class="stat-mini-val" style="color:var(--blue)">${sessions.length}</div>
      <div class="stat-mini-lbl">총 세션</div>
    </div>
    <div class="stat-mini">
      <div class="stat-mini-val" style="color:var(--purple)">${retention}</div>
      <div class="stat-mini-lbl">세션당 평균 이벤트</div>
    </div>
  `;

  // 기능별 사용 빈도
  const typeCounts = {};
  for (const n of nodes) { typeCounts[n.type] = (typeCounts[n.type]||0)+1; }
  const typeEntries = Object.entries(typeCounts).sort((a,b) => b[1]-a[1]);
  const maxType = typeEntries[0]?.[1] || 1;
  const typeColors = {
    'tool.end':'#bc8cff','tool.start':'#8957e5','assistant.message':'#3fb950',
    'user.message':'#58a6ff','session.start':'#39d2c0','file.write':'#f778ba',
    'file.read':'#ffa657','task.complete':'#3fb950',
  };
  document.getElementById('feature-usage').innerHTML = typeEntries.map(([type, cnt]) => {
    const pct = Math.round(cnt/maxType*100);
    const color = typeColors[type] || '#6b7280';
    return `
      <div class="feature-row">
        <span class="feature-name">${type}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="feature-bar"><div class="feature-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="feature-count" style="color:${color}">${cnt}</span>
        </div>
      </div>`;
  }).join('');

  // AI 소스별
  const aiStats = stats.aiSourceStats || {};
  const aiTotal = Object.values(aiStats).reduce((s,v) => s+v, 0);
  const aiEntries = Object.entries(aiStats).sort((a,b) => b[1]-a[1]);
  document.getElementById('ai-usage').innerHTML = aiEntries.length ? aiEntries.map(([src, cnt]) => {
    const color = AI_COLORS[src.toLowerCase()] || AI_COLORS.default;
    const pct = aiTotal > 0 ? Math.round(cnt/aiTotal*100) : 0;
    return `
      <div class="feature-row">
        <span class="feature-name" style="color:${color};font-weight:600">${src}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:var(--text3)">${pct}%</span>
          <div class="feature-bar"><div class="feature-fill" style="width:${pct}%;background:${color}"></div></div>
          <span class="feature-count" style="color:${color}">${cnt}</span>
        </div>
      </div>`;
  }).join('') : '<div class="empty">AI 소스 데이터 없음</div>';

  // 미사용 기능 분석
  const usedTypes = new Set(Object.keys(typeCounts));
  const usedSources = new Set(Object.keys(aiStats).map(s=>s.toLowerCase()));
  const unusedFeatures = ALL_FEATURES.filter(f => {
    if (f.key === 'n8n 연동') return !usedSources.has('n8n');
    if (f.key === 'VS Code 연동') return !usedSources.has('vscode');
    if (f.key === 'Claude 훅') return !usedTypes.has('tool.end') && !usedTypes.has('user.message');
    if (f.key === '롤백') return true; // 사용 여부 추적 어려움
    if (f.key === '검색') return true;
    return false;
  });

  document.getElementById('unused-features').innerHTML = unusedFeatures.length
    ? unusedFeatures.map(f => `
        <div class="feature-row">
          <div>
            <div class="feature-name">${f.key}</div>
            <div style="font-size:11px;color:var(--text3)">${f.desc}</div>
          </div>
          <span class="unused-badge">미사용</span>
        </div>`).join('')
    : '<div class="empty">모든 기능이 사용됩니다 ✅</div>';

  // AI 인사이트 생성
  generateInsights(stats, nodes, sessions, aiEntries, typeEntries);
}

function generateInsights(stats, nodes, sessions, aiEntries, typeEntries) {
  const insights = [];
  const topAI = aiEntries[0];
  const topType = typeEntries[0];
  const totalEvents = stats.eventCount || 0;
  const toolPct = typeEntries.filter(([t]) => t.startsWith('tool')).reduce((s,[,v]) => s+v, 0);

  if (topAI) {
    const pct = Math.round(topAI[1] / (totalEvents||1) * 100);
    insights.push({
      title: `🤖 주요 AI: ${topAI[0]}`,
      text: `전체 이벤트의 ${pct}%가 ${topAI[0]}에서 발생합니다. ${aiEntries.length}개 AI 소스가 연결되어 있습니다.`,
    });
  }

  if (toolPct > totalEvents * 0.5) {
    insights.push({
      title: '🔧 도구 중심 워크플로우',
      text: `이벤트의 ${Math.round(toolPct/totalEvents*100)}%가 도구 실행입니다. 자동화 워크플로우가 활발하게 사용되고 있습니다.`,
    });
  }

  if (sessions.length > 3) {
    insights.push({
      title: '📊 멀티 세션 활동',
      text: `${sessions.length}개 세션이 기록됐습니다. 채널별로 분류하면 프로젝트 진행 상황을 더 명확하게 파악할 수 있습니다.`,
    });
  }

  insights.push({
    title: '💡 다음 단계 추천',
    text: `• 팀원들과 같은 채널(MINDMAP_CHANNEL)을 설정하면 실시간 협업 뷰가 활성화됩니다\n• n8n 워크플로우에 orbit-agent SDK를 연결하면 자동화 작업도 시각화됩니다\n• VS Code에서 vscode-orbit.js watch 실행 시 파일 편집도 추적됩니다`,
  });

  const el = document.getElementById('insights-container');
  el.innerHTML = insights.map(i => `
    <div class="insight-card">
      <div class="insight-title">${i.title}</div>
      <div class="insight-text">${escHtml(i.text)}</div>
    </div>`).join('');
}

// ── 도구 매핑 ───────────────────────────────────────
async function loadMappings() {
  const res  = await fetch('/api/tool-mappings');
  const data = await res.json();
  const el   = document.getElementById('mapping-list');
  if (!data.length) { el.innerHTML = '<div class="empty">커스텀 라벨 없음. 아래에서 추가하세요.</div>'; return; }
  el.innerHTML = data.map(m => `
    <div class="mapping-row">
      <input class="mapping-input" value="${escHtml(m.toolName)}" readonly>
      <span class="mapping-arrow">→</span>
      <input class="mapping-input" value="${escHtml(m.label)}">
      <button class="del-btn" onclick="deleteMapping('${escHtml(m.toolName)}')">삭제</button>
    </div>`).join('');
}

async function addMapping() {
  const tool  = document.getElementById('new-tool').value.trim();
  const label = document.getElementById('new-label').value.trim();
  if (!tool || !label) return alert('도구명과 라벨을 모두 입력하세요');
  await fetch('/api/tool-mappings', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ toolName: tool, label })
  });
  document.getElementById('new-tool').value = '';
  document.getElementById('new-label').value = '';
  loadMappings();
}

async function deleteMapping(toolName) {
  await fetch(`/api/tool-mappings/${encodeURIComponent(toolName)}`, { method:'DELETE' });
  loadMappings();
}

// ── 채널 현황 ────────────────────────────────────────
async function loadChannels() {
  const [sessRes, graphRes] = await Promise.all([
    fetch('/api/sessions'), fetch('/api/graph')
  ]);
  const sessions = await sessRes.json();
  const graph    = await graphRes.json();
  const nodes    = graph.nodes || [];

  // 채널별 통계
  const channelStats = {};
  for (const n of nodes) {
    const ch = n.sessionId ? sessions.find(s=>s.id===n.sessionId)?.channelId || 'default' : 'default';
    if (!channelStats[ch]) channelStats[ch] = { events:0, sessions: new Set(), aiSources: new Set() };
    channelStats[ch].events++;
    if (n.sessionId) channelStats[ch].sessions.add(n.sessionId);
    if (n.aiSource)  channelStats[ch].aiSources.add(n.aiSource);
  }

  const el = document.getElementById('channel-list');
  const entries = Object.entries(channelStats).sort((a,b) => b[1].events-a[1].events);
  if (!entries.length) { el.innerHTML = '<div class="empty">채널 데이터 없음</div>'; return; }
  el.innerHTML = entries.map(([ch, s]) => `
    <div class="channel-row">
      <div>
        <div class="ch-name">${escHtml(ch)}</div>
        <div class="ch-meta">세션 ${s.sessions.size}개 · AI: ${[...s.aiSources].join(', ')||'없음'}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:14px;font-weight:700;color:var(--accent)">${s.events}</div>
        <div style="font-size:10px;color:var(--text3)">이벤트</div>
      </div>
    </div>`).join('');
}

// ── 초기화 ──
loadAnalysis();
loadMappings();
loadChannels();
