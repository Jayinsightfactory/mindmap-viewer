'use strict';
/* graph-shell.js — 업무 흐름 청사진 (옵시디언 그래프 뷰)
 * 전역 ForceGraph(2D) / ForceGraph3D(3D) 사용. /api/flow/* 를 읽어 렌더.
 * ORBIT_3D_REDESIGN_GUIDE.md 의 Global/Local/Timeline 모델 실현. */

(function () {
  const $ = (s) => document.querySelector(s);
  const API = '';
  const TOKEN_KEY = 'orbit_flow_token';

  const KIND_COLOR = { employee: '#8a7df0', action: '#5b9dff', customer: '#e0913a', erp: '#46a06a', default: '#5a5f68' };
  const EDGE_COLOR = { handoff: '#5b9dff', mentions: '#e0913a', triggered: '#46a06a', updated_erp: '#46a06a', next: '#3a3d44', default: '#3a3d44' };
  const confDot = (c) => (c >= 1 ? '#2e9e6b' : c >= 0.67 ? '#d9a630' : '#7e828a');

  const state = { mode: 'company', is3d: false, fg: null, data: { nodes: [], links: [] }, highlight: new Set(), hoverId: null };

  function token() { return sessionStorage.getItem(TOKEN_KEY) || ''; }
  function setStatus(t) { $('#status').textContent = t; }

  function askToken() {
    const t = prompt('관리자 토큰 (orbit_...)', token());
    if (t != null) { sessionStorage.setItem(TOKEN_KEY, t.trim()); reload(); }
  }

  async function api(path) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await fetch(API + path + sep + 'token=' + encodeURIComponent(token()));
    if (r.status === 401) { setStatus('인증 실패 — 토큰 확인'); throw new Error('401'); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ── 컨텍스트 셀렉터 (모드별) ────────────────────────────────────────────────
  let peopleCache = null;
  async function buildCtx() {
    const ctx = $('#ctx'); ctx.innerHTML = '';
    if (state.mode === 'employee') {
      const sel = document.createElement('select'); sel.id = 'empSel';
      sel.innerHTML = '<option>직원 로딩…</option>'; ctx.appendChild(sel);
      try {
        if (!peopleCache) peopleCache = (await api('/api/flow/people')).people || [];
        sel.innerHTML = peopleCache.map(p => `<option value="${p.userId}">${p.label} (${p.count})</option>`).join('');
        sel.onchange = () => loadEmployee(sel.value);
      } catch { sel.innerHTML = '<option>로딩 실패</option>'; }
    } else if (state.mode === 'workunit') {
      const inp = document.createElement('input');
      inp.id = 'wuInp'; inp.placeholder = '거래처명 또는 주문번호'; inp.style.width = '180px';
      const go = document.createElement('button'); go.className = 'ghost'; go.textContent = '조회';
      go.onclick = () => { const v = inp.value.trim(); if (v) loadWorkunit(v); };
      inp.onkeydown = (e) => { if (e.key === 'Enter') go.click(); };
      ctx.appendChild(inp); ctx.appendChild(go);
    }
  }

  // ── 데이터 적재 ─────────────────────────────────────────────────────────────
  function toGraph(api) {
    const nodes = (api.nodes || []).map(n => ({ ...n }));
    const ids = new Set(nodes.map(n => n.id));
    const links = (api.edges || []).filter(e => ids.has(e.from) && ids.has(e.to))
      .map(e => ({ source: e.from, target: e.to, ...e }));
    return { nodes, links };
  }
  async function loadCompany() { setStatus('회사맵 로딩…'); render(toGraph(await api('/api/flow/company')), '회사 전체'); }
  async function loadEmployee(uid) {
    if (!uid) { const s = $('#empSel'); uid = s && s.value; }
    if (!uid) return; setStatus('직원 흐름 로딩…');
    const d = await api('/api/flow/employee?hours=168&userId=' + encodeURIComponent(uid));
    render(toGraph(d), '직원 흐름 · ' + (peopleCache?.find(p => p.userId === uid)?.label || uid));
  }
  async function loadWorkunit(key) {
    setStatus('업무단위 로딩…');
    const isNum = /^\d+$/.test(key);
    const d = await api('/api/flow/workunit?' + (isNum ? 'order=' : 'customer=') + encodeURIComponent(key));
    render(toGraph(d), '업무단위 · ' + key + (d.note ? ' (' + d.note + ')' : ''));
  }

  async function reload() {
    if (!token()) { setStatus('토큰 입력 필요'); return; }
    try {
      await buildCtx();
      if (state.mode === 'company') await loadCompany();
      else if (state.mode === 'employee') await loadEmployee();
      else $('#status').textContent = '거래처명/주문번호를 입력하세요';
    } catch (e) { setStatus('오류: ' + e.message); }
  }

  // ── 렌더 (force graph) ──────────────────────────────────────────────────────
  function neighbors(id) {
    const s = new Set([id]);
    for (const l of state.data.links) {
      const a = l.source.id || l.source, b = l.target.id || l.target;
      if (a === id) s.add(b); if (b === id) s.add(a);
    }
    return s;
  }
  function nodeColor(n) { return KIND_COLOR[n.kind] || KIND_COLOR.default; }
  function nodeVal(n) { return n.kind === 'employee' ? Math.max(3, Math.sqrt(n.count || 1)) : n.kind === 'customer' ? 4 : 2.5; }

  function makeFG() {
    const el = $('#graph'); el.innerHTML = '';
    const FG = state.is3d ? ForceGraph3D : ForceGraph;
    const fg = FG()(el)
      .backgroundColor('#191a1d')
      .nodeId('id')
      .nodeVal(nodeVal)
      .nodeLabel(n => `${n.label}${n.count ? ' · ' + n.count : ''}${n.auto ? ' ⚡' : ''}`)
      .nodeColor(n => {
        if (state.highlight.size && !state.highlight.has(n.id)) return 'rgba(120,120,130,0.15)';
        return nodeColor(n);
      })
      .linkColor(l => {
        const base = EDGE_COLOR[l.kind] || EDGE_COLOR.default;
        if (state.highlight.size) {
          const a = l.source.id || l.source, b = l.target.id || l.target;
          if (!(state.highlight.has(a) && state.highlight.has(b))) return 'rgba(120,120,130,0.08)';
        }
        return base;
      })
      .linkWidth(l => (l.kind === 'handoff' ? 2.5 : l.kind === 'next' ? 0.5 : 1.3))
      .linkDirectionalParticles(l => (l.kind === 'handoff' || l.kind === 'triggered') ? 2 : 0)
      .linkDirectionalParticleWidth(2)
      .linkDirectionalArrowLength(l => l.kind === 'next' ? 0 : 3.5)
      .onNodeClick(openPanel)
      .onNodeHover(n => { state.hoverId = n ? n.id : null; state.highlight = n ? neighbors(n.id) : new Set(); refresh(); });

    if (!state.is3d) {
      fg.nodeCanvasObjectMode(() => 'after').nodeCanvasObject((n, ctx, scale) => {
        // confidence ring
        const r = Math.max(2, nodeVal(n)) ;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.5, 0, 2 * Math.PI);
        ctx.strokeStyle = confDot(n.confidence || 0.34); ctx.lineWidth = 1.2 / scale; ctx.stroke();
        if (scale > 1.3 || n.kind !== 'action') {
          const dim = state.highlight.size && !state.highlight.has(n.id);
          ctx.fillStyle = dim ? 'rgba(180,184,190,0.25)' : '#c9ccd1';
          ctx.font = `${10 / scale}px system-ui`; ctx.textAlign = 'center';
          ctx.fillText((n.label || '').slice(0, 16) + (n.auto ? ' ⚡' : ''), n.x, n.y + r + 9 / scale);
        }
      });
    }
    state.fg = fg;
  }
  function refresh() { if (state.fg) state.fg.nodeColor(state.fg.nodeColor()).linkColor(state.fg.linkColor()); }

  function render(data, title) {
    state.data = data; state.highlight = new Set();
    if (!state.fg) makeFG();
    state.fg.graphData(data);
    setStatus(`${title} · 노드 ${data.nodes.length} · 연결 ${data.links.length}`);
    renderLegend();
  }

  // ── 우측 패널 (OAG 증거 패킷) ────────────────────────────────────────────────
  async function openPanel(n) {
    $('#sideEmpty').style.display = 'none';
    const body = $('#sideBody'); body.style.display = 'block';
    if (n.kind !== 'action' || !n.actionId) {
      body.innerHTML = `<h2>${n.label}</h2><div class="sub">${n.kind}${n.userId ? ' · ' + n.userId : ''}</div>`
        + (n.count != null ? `<div class="kv"><b>활동/연결</b><span>${n.count}</span></div>` : '')
        + `<div class="kv"><b>신뢰도</b><span><span style="color:${confDot(n.confidence)}">●</span> ${n.confidence}</span></div>`;
      return;
    }
    body.innerHTML = '<h2>증거 패킷 로딩…</h2>';
    try {
      const r = await fetch(`/api/ops-ontology/actions/${encodeURIComponent(n.actionId)}/context?token=${encodeURIComponent(token())}`);
      const d = await r.json();
      const a = d.action || {}; const data = (typeof a.data === 'object' ? a.data : {}) || {};
      const rels = d.relations || [];
      body.innerHTML = `
        <h2>${data.activity || data.app || '작업'} ${data.auto ? '⚡' : ''}</h2>
        <div class="sub">${new Date(a.timestamp).toLocaleString('ko-KR')} · ${a.user_id || ''}</div>
        ${data.screen ? `<div class="rel">🖥 ${data.screen}</div>` : ''}
        <div class="kv"><b>앱</b><span>${data.app || '-'}</span></div>
        ${data.room ? `<div class="kv"><b>카톡방</b><span>${data.room}</span></div>` : ''}
        <div class="kv"><b>신뢰도</b><span><span style="color:${confDot(data.confidence)}">●</span> ${data.confidence} (${(data.sources || []).join(',')})</span></div>
        <div class="kv"><b>타이핑</b><span>${data.typedChars || 0}자</span></div>
        <div class="kv"><b>클릭</b><span>${data.clicks || 0}</span></div>
        <div class="kv"><b>시간</b><span>${data.durationSec || 0}초</span></div>
        <div style="margin:10px 0 4px;color:var(--muted);font-size:11px">관계 ${rels.length}</div>
        ${rels.map(x => `<div class="rel">${x.rel_type}: ${x.from_type==='Action'?'…':x.from_ref} → ${x.to_ref.slice(0,40)}</div>`).join('')}
      `;
    } catch (e) { body.innerHTML = '<h2>패킷 로드 실패</h2><div class="sub">' + e.message + '</div>'; }
  }

  function renderLegend() {
    const L = [['employee', '직원'], ['action', '액션'], ['customer', '거래처'], ['erp', 'ERP결과']];
    $('#legend').innerHTML =
      L.map(([k, n]) => `<span class="dot" style="background:${KIND_COLOR[k]}"></span>${n}`).join(' &nbsp; ')
      + `<br><span style="color:#5b9dff">━</span> 핸드오프 &nbsp; <span style="color:#e0913a">┄</span> 거래처 &nbsp; <span style="color:#46a06a">━</span> 대화→작업`
      + `<br>고리색 신뢰도: <span style="color:#2e9e6b">●</span>1.0 <span style="color:#d9a630">●</span>0.67 <span style="color:#7e828a">●</span>0.34`;
  }

  // ── 툴바 ────────────────────────────────────────────────────────────────────
  $('#modeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    [...$('#modeSeg').children].forEach(x => x.classList.remove('on')); b.classList.add('on');
    state.mode = b.dataset.mode; reload();
  });
  $('#reload').onclick = reload;
  $('#setToken').onclick = askToken;
  $('#toggle3d').onclick = () => {
    state.is3d = !state.is3d; $('#toggle3d').textContent = state.is3d ? '2D' : '3D';
    $('#toggle3d').classList.toggle('on'); makeFG(); state.fg.graphData(state.data);
  };

  // 초기화
  if (!token()) askToken(); else reload();
})();
