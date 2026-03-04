// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Data loading, auth, empty state, admin view
// ══════════════════════════════════════════════════════════════════════════════
function _getAuthToken() {
  if (typeof _orbitUser !== 'undefined' && _orbitUser?.token) return _orbitUser.token;
  try { return JSON.parse(localStorage.getItem('orbitUser') || 'null')?.token || ''; } catch { return ''; }
}

// 인증 헤더 포함 fetch 래퍼
function _authFetch(url, opts = {}) {
  const token = _getAuthToken();
  if (token) {
    opts.headers = { ...(opts.headers || {}), 'Authorization': `Bearer ${token}` };
  }
  return fetch(url, opts);
}

async function loadData() {
  document.getElementById('loading-msg').textContent = '서버에서 작업 데이터 가져오는 중…';
  try {
    const res  = await _authFetch('/api/graph');  // 토큰 포함 → 내 데이터만 수신
    const data = await res.json();
    const nodes = data.nodes || [];
    buildPlanetSystem(nodes);
    document.getElementById('loading').style.display = 'none';

    // 이벤트 없음 → 안내 메시지 표시
    if (nodes.length === 0) {
      _showEmptyStateGuide();
    } else {
      _hideEmptyStateGuide();
    }
  } catch(e) {
    document.getElementById('loading').innerHTML =
      `<div style="color:#f85149;text-align:center">⚠ 서버 연결 실패<br><small style="color:#6e7681">${e.message}</small><br><br><a href="/" style="color:#58a6ff;font-size:13px">← 대시보드</a></div>`;
  }
}

// ── 로그인 후 자동 동기화 ──────────────────────────────────────────────────────
// 1) 기존 'local' 이벤트를 내 계정에 귀속
// 2) 토큰을 서버에 전달 → save-turn.js가 사용할 수 있도록 ~/.orbit-config.json 업데이트
// 3) 데이터 새로 로드
async function _postLoginSync(token) {
  try {
    // 1) local 이벤트 귀속
    const claimRes = await fetch('/api/claim-local-events', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const claimData = await claimRes.json();
    if (claimData.claimed > 0) {
      showToast(`${claimData.claimed}개 작업 내역을 내 계정에 연결했습니다`, 'success');
    }

    // 2) 서버에 토큰 등록 → save-turn.js 자동 인증용
    fetch('/api/register-hook-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ token }),
    }).catch(() => {});

    // 3) 데이터 새로 로드
    setTimeout(() => loadData(), 500);
  } catch (e) {
    console.warn('[postLoginSync]', e.message);
    loadData();
  }
}

// ── 로컬 이벤트 귀속 (claim) ──────────────────────────────────────────────────
async function _claimLocalEvents() {
  const token = _getAuthToken();
  if (!token) { showToast('로그인 후 사용 가능합니다', 'warn'); return; }
  try {
    const r = await _authFetch('/api/claim-local-events', { method: 'POST' });
    const d = await r.json();
    if (d.ok) {
      showToast(`✅ ${d.claimed}개 이벤트를 내 계정으로 귀속했습니다`, 'success');
      setTimeout(() => loadData(), 800);
    } else {
      showToast('귀속 실패: ' + (d.error || '알 수 없는 오류'), 'error');
    }
  } catch (e) {
    showToast('귀속 오류: ' + e.message, 'error');
  }
}

// ── 데이터 소스 설정 ─────────────────────────────────────────────────────────
const DATA_SOURCE_KEY = 'orbit_data_source'; // 'cloud' | 'local' | null
const DATA_SOURCE_ACCOUNT_KEY = 'orbit_data_source_account'; // 설정한 계정 이메일

function _getDataSource() {
  return localStorage.getItem(DATA_SOURCE_KEY);
}
function _setDataSource(src, accountEmail) {
  localStorage.setItem(DATA_SOURCE_KEY, src);
  if (accountEmail) localStorage.setItem(DATA_SOURCE_ACCOUNT_KEY, accountEmail);
}

// ── 빈 화면 안내 ──────────────────────────────────────────────────────────────
function _showEmptyStateGuide() {
  if (document.getElementById('empty-state-guide')) return;
  const isLoggedIn = !!_getAuthToken();

  // ── 로그인 안 된 상태에서만 안내 표시 ──
  // 로그인 후에는 설정(⚙️) 패널에 설치 명령어가 있으므로 별도 팝업 불필요
  if (!isLoggedIn) {
    const el = document.createElement('div');
    el.id = 'empty-state-guide';
    el.style.cssText = `
      position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
      background:rgba(13,17,23,0.97); border:1px solid #30363d;
      border-radius:18px; padding:28px 32px; max-width:480px; text-align:center;
      z-index:500; backdrop-filter:blur(20px);
      box-shadow:0 16px 64px rgba(0,0,0,0.5);
      font-family:-apple-system,'Segoe UI',sans-serif;
      animation:fadeIn .4s ease;
    `;
    el.innerHTML = `
      <div style="font-size:42px;margin-bottom:12px">⬡</div>
      <div style="font-size:17px;font-weight:700;color:#e6edf3;margin-bottom:8px">
        Orbit AI에 오신 것을 환영합니다
      </div>
      <div style="font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:20px">
        로그인하면 작업 데이터를 클라우드에 저장하고<br>
        여러 PC에서 동기화할 수 있습니다.
      </div>
      <button onclick="document.getElementById('empty-state-guide').remove();openLoginModal()"
        style="width:100%;background:linear-gradient(135deg,#1f6feb,#388bfd);border:none;color:#fff;
        padding:12px 22px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;margin-bottom:10px">
        로그인 / 회원가입
      </button>
      <button onclick="document.getElementById('empty-state-guide').remove()"
        style="width:100%;background:#21262d;border:1px solid #30363d;color:#8b949e;
        padding:10px 22px;border-radius:10px;cursor:pointer;font-size:13px;margin-bottom:14px">
        둘러보기
      </button>
      <div style="font-size:11px;color:#6e7681;line-height:1.5">
        로그인 후 ⚙️ 설정에서 Orbit 설치 명령어를 확인할 수 있습니다.
      </div>
    `;
    document.body.appendChild(el);
  }
  // ── 로그인 된 상태: 데이터 없으면 간단 안내만 (설정 패널 유도) ──
  else {
    const el = document.createElement('div');
    el.id = 'empty-state-guide';
    el.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:rgba(13,17,23,0.95); border:1px solid #30363d;
      border-radius:12px; padding:14px 22px; max-width:400px; text-align:center;
      z-index:500; backdrop-filter:blur(16px);
      box-shadow:0 8px 32px rgba(0,0,0,0.4);
      font-family:-apple-system,'Segoe UI',sans-serif;
      animation:fadeIn .4s ease;
    `;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:8px">
        <span style="font-size:18px">⬡</span>
        <span style="font-size:13px;font-weight:600;color:#e6edf3">아직 수집된 데이터가 없습니다</span>
        <span onclick="document.getElementById('empty-state-guide').remove()"
          style="margin-left:8px;cursor:pointer;color:#6e7681;font-size:16px;line-height:1">✕</span>
      </div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:12px;line-height:1.6">
        <b style="color:#cdd9e5">⚙️ 설정</b>에서 설치 명령어를 복사해 PC에서 실행하세요.
      </div>
      <button onclick="document.getElementById('empty-state-guide').remove();openSetupPanel()"
        style="padding:8px 20px;background:#1f6feb;border:none;border-radius:8px;
        color:#fff;font-size:12px;font-weight:600;cursor:pointer">
        ⚙️ 설정 열기
      </button>
    `;
    document.body.appendChild(el);
  }
}

function _getCurrentUserEmail() {
  try {
    const el = document.getElementById('lm-email-disp');
    return el ? el.textContent.trim() : '';
  } catch(e) { return ''; }
}

// _showEmptyStateStep2 — 더 이상 팝업으로 사용하지 않음 (설정 패널에 설치 명령어 있음)
function _showEmptyStateStep2() {
  // 설정 패널로 유도
  _showEmptyStateGuide();
}

function _resetDataSource() {
  localStorage.removeItem(DATA_SOURCE_KEY);
  localStorage.removeItem(DATA_SOURCE_ACCOUNT_KEY);
  const el = document.getElementById('empty-state-guide');
  if (el) el.remove();
  _showEmptyStateGuide();
}

function _setDataSourceFromSettings(src) {
  const email = _getCurrentUserEmail();
  _setDataSource(src, email);
  // 설정 패널 버튼 UI 갱신
  const cloud = document.getElementById('sp-ds-cloud');
  const local = document.getElementById('sp-ds-local');
  if (cloud && local) {
    cloud.style.borderColor = src==='cloud' ? '#1f6feb' : '#30363d';
    cloud.style.background  = src==='cloud' ? 'rgba(31,111,235,.15)' : '#161b22';
    cloud.style.color       = src==='cloud' ? '#58a6ff' : '#8b949e';
    local.style.borderColor = src==='local' ? '#1f6feb' : '#30363d';
    local.style.background  = src==='local' ? 'rgba(31,111,235,.15)' : '#161b22';
    local.style.color       = src==='local' ? '#58a6ff' : '#8b949e';
  }
  showToast(src==='cloud' ? '클라우드 동기화로 변경됨' : '로컬 데이터 모드로 변경됨', 'success');
}

function _hideEmptyStateGuide() {
  const el = document.getElementById('empty-state-guide');
  if (el) el.remove();
}

// ─── 관리자 맞춤 뷰 ───────────────────────────────────────────────────────────

// 상태: localStorage 영속
const _mgrCfg = (() => {
  const saved = localStorage.getItem('orbitMgrCfg');
  const def = {
    fields:    { progress: true, deadline: true, blocker: true, taskCount: false },
    highlight: null,  // null | 'blocker' | 'deadline' | 'low_progress'
  };
  return saved ? { ...def, ...JSON.parse(saved) } : def;
})();
function _saveMgrCfg() { localStorage.setItem('orbitMgrCfg', JSON.stringify(_mgrCfg)); }

function toggleMgrPanel() {
  const btn   = document.getElementById('mgr-btn');
  const panel = document.getElementById('mgr-panel');
  const open  = panel.classList.toggle('open');
  btn.classList.toggle('open', open);
  if (open) {
    if (typeof track === 'function') track('view.panel_open', { panel: 'mgr' });
    updateMgrFieldUI();
  }
}

function updateMgrFieldUI() {
  ['progress','deadline','blocker','taskCount'].forEach(f => {
    const el = document.getElementById(`mgrf-${f}`);
    if (el) el.classList.toggle('on', !!_mgrCfg.fields[f]);
  });
  // highlight chips
  ['all','blocker','deadline','low_progress'].forEach(k => {
    const el = document.getElementById(`mgrf-chip-${k === null ? 'all' : k}`);
    if (el) el.classList.toggle('on',
      k === null ? _mgrCfg.highlight === null
                : _mgrCfg.highlight === k
    );
  });
  document.getElementById('mgrf-chip-all')?.classList.toggle('on', _mgrCfg.highlight === null);
}

function toggleMgrField(field) {
  _mgrCfg.fields[field] = !_mgrCfg.fields[field];
  _saveMgrCfg();
  updateMgrFieldUI();
}

function setMgrHighlight(val, btn) {
  _mgrCfg.highlight = val;
  _saveMgrCfg();
  document.querySelectorAll('.mgr-filter-chip').forEach(c => c.classList.remove('on'));
  btn?.classList.add('on');
}

// ── AI 봇 쿼리 처리 ─────────────────────────────────────────────────────────
function submitMgrBot() {
  const input = document.getElementById('mgr-bot-input');
  const resp  = document.getElementById('mgr-bot-resp');
  const text  = (input?.value || '').trim();
  if (!text) return;

  const result = parseMgrQuery(text);

  // 필드 적용
  Object.entries(result.fields).forEach(([k, v]) => { if (v) _mgrCfg.fields[k] = true; });
  if (result.highlight !== undefined) _mgrCfg.highlight = result.highlight;
  _saveMgrCfg();
  updateMgrFieldUI();

  // 응답 표시
  if (resp) {
    resp.style.display = 'block';
    resp.innerHTML = `🤖 ${result.response}`;
  }
  if (input) input.value = '';
}

function parseMgrQuery(text) {
  const t  = text;
  const result = { fields: {}, highlight: undefined, response: '' };
  const applied = [];

  if (/진행률|진행|progress/i.test(t))   { result.fields.progress = true;  applied.push('진행률'); }
  if (/마감|deadline|d-?day|디데이/i.test(t)) { result.fields.deadline = true; applied.push('마감 D-Day'); }
  if (/블로커|블록|막힌|blocker/i.test(t)) { result.fields.blocker = true; result.highlight = 'blocker'; applied.push('블로커'); }
  if (/개수|건수|작업수/i.test(t))        { result.fields.taskCount = true; applied.push('작업 수'); }

  if (/이번주|7일|임박/i.test(t))         { result.highlight = 'deadline'; applied.push('마감 임박 강조'); }
  if (/낮은|저조|부진|slow/i.test(t))     { result.highlight = 'low_progress'; applied.push('저조 강조'); }
  if (/전체|모두|all/i.test(t))           { result.highlight = null; applied.push('전체 표시'); }

  // 멤버 이름 매칭 → 포커스
  const members = (_activeSimData?.members) ||
    (_activeSimData?.departments || []).flatMap(d => d.members || []) ||
    TEAM_DEMO.members;
  members.forEach(m => {
    if (t.includes(m.name)) {
      const node = _teamNodes?.find(n => n.type === 'member' && n.memberId === m.id);
      if (node) { focusMember(node); applied.push(`${m.name} 포커스`); }
    }
  });

  result.response = applied.length > 0
    ? `${applied.join(' · ')} 적용했습니다.`
    : '조건을 인식하지 못했습니다. "블로커 있는 사람", "이번주 마감 임박" 등으로 물어보세요.';
  return result;
}

// ── 멤버 노드 관리자 뱃지 렌더링 ────────────────────────────────────────────
function renderMgrBadges(memberId, cx, baseY) {
  const fields = _mgrCfg.fields;
  if (!Object.values(fields).some(v => v)) return;

  const allMembers = (_activeSimData?.members) ||
    (_activeSimData?.departments || []).flatMap(d => d.members || []) ||
    TEAM_DEMO.members;
  const mData = allMembers.find(m => m.id === memberId);
  if (!mData) return;

  const tasks       = mData.tasks || [];
  const activeTasks = tasks.filter(t => t.status === 'active');
  const doneTasks   = tasks.filter(t => t.status === 'done');
  const today       = new Date();

  // 뱃지 목록 구성
  const badges = [];

  if (fields.progress && activeTasks.length > 0) {
    const avg = activeTasks.reduce((s, t) => s + (t.progress || 0), 0) / activeTasks.length;
    const pct = Math.round(avg * 100);
    const col = pct >= 70 ? '#3fb950' : pct >= 40 ? '#f0883e' : '#f85149';
    // 저조 강조 시 깜빡임
    const dim = _mgrCfg.highlight === 'low_progress' && pct < 40;
    badges.push({ text: `${pct}%`, color: col, flash: dim });
  }

  if (fields.blocker) {
    const hasBlocker = tasks.some(t => t.blocker && t.status !== 'done');
    if (hasBlocker) badges.push({ text: '⚠️ 블로커', color: '#f85149', flash: _mgrCfg.highlight === 'blocker' });
  }

  if (fields.taskCount) {
    badges.push({ text: `${doneTasks.length}/${tasks.length}`, color: '#58a6ff', flash: false });
  }

  if (fields.deadline) {
    let minDays = Infinity;
    activeTasks.forEach(t => {
      if (!t.dueDate) return;
      const [mo, dy] = t.dueDate.split('-').map(Number);
      const due  = new Date(today.getFullYear(), mo - 1, dy);
      const diff = Math.ceil((due - today) / 86400000);
      if (diff < minDays) minDays = diff;
    });
    if (minDays < Infinity) {
      const col = minDays <= 3 ? '#f85149' : minDays <= 7 ? '#f0883e' : '#6e7681';
      const lbl = minDays <= 0 ? 'D-Day' : `D-${minDays}`;
      badges.push({ text: lbl, color: col, flash: _mgrCfg.highlight === 'deadline' && minDays <= 7 });
    }
  }

  if (!badges.length) return;

  _lctx.save();
  _lctx.font = '500 9px -apple-system,sans-serif';
  _lctx.textBaseline = 'middle';
  _lctx.textAlign = 'left';

  const badgeH = 15;
  const gap = 4;
  const now = Date.now() / 1000;

  // 전체 너비 계산 후 가운데 정렬
  badges.forEach(b => { b.w = _lctx.measureText(b.text).width + 10; });
  const totalW = badges.reduce((s, b) => s + b.w, 0) + gap * (badges.length - 1);
  let bx = cx - totalW / 2;
  const by = baseY + 20;

  badges.forEach(b => {
    const alpha = b.flash ? (0.5 + 0.5 * Math.sin(now * 4)) : 1.0;
    _lctx.globalAlpha = alpha;
    roundRect(_lctx, bx, by, b.w, badgeH, badgeH / 2);
    _lctx.fillStyle = b.color + '22'; _lctx.fill();
    _lctx.strokeStyle = b.color + '70'; _lctx.lineWidth = 0.8;
    roundRect(_lctx, bx, by, b.w, badgeH, badgeH / 2); _lctx.stroke();
    _lctx.fillStyle = b.color;
    _lctx.fillText(b.text, bx + 5, by + badgeH / 2);
    bx += b.w + gap;
  });

  _lctx.globalAlpha = 1;
  _lctx.restore();
}

