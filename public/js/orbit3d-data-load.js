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
    _autoCheckEnvAfterLogin();
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
  const savedSource = _getDataSource();
  const isMac = /Mac/i.test(navigator.userAgent);

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

  // ── 로그인 안 된 상태: 로그인 유도 ──
  if (!isLoggedIn) {
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
      <button onclick="_setDataSource('local');_showEmptyStateStep2()"
        style="width:100%;background:#21262d;border:1px solid #30363d;color:#8b949e;
        padding:10px 22px;border-radius:10px;cursor:pointer;font-size:13px;margin-bottom:14px">
        로그인 없이 로컬 데이터로 시작
      </button>
      <div style="font-size:11px;color:#6e7681;line-height:1.5">
        로컬 모드에서도 작업 트래킹은 정상 동작합니다.<br>
        나중에 설정에서 언제든 변경할 수 있습니다.
      </div>
    `;
  }
  // ── 로그인 된 상태: 데이터 소스 선택 ──
  else if (!savedSource) {
    el.innerHTML = `
      <div style="font-size:42px;margin-bottom:12px">⬡</div>
      <div style="font-size:17px;font-weight:700;color:#e6edf3;margin-bottom:8px">
        데이터 소스를 선택하세요
      </div>
      <div style="font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:20px">
        작업 데이터를 어디서 불러올까요?<br>
        같은 계정이면 다른 PC에서도 동일하게 적용됩니다.
      </div>
      <button onclick="_setDataSource('cloud',_getCurrentUserEmail());_showEmptyStateStep2()"
        style="width:100%;background:linear-gradient(135deg,#1f6feb,#388bfd);border:none;color:#fff;
        padding:12px 22px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:600;margin-bottom:10px;
        text-align:left;display:flex;align-items:center;gap:12px">
        <span style="font-size:22px">&#9729;</span>
        <span><b>내 계정에서 불러오기</b><br><span style="font-size:11px;font-weight:400;opacity:.8">클라우드 동기화 — 여러 PC에서 동일한 데이터</span></span>
      </button>
      <button onclick="_setDataSource('local',_getCurrentUserEmail());_showEmptyStateStep2()"
        style="width:100%;background:#21262d;border:1px solid #30363d;color:#e6edf3;
        padding:12px 22px;border-radius:10px;cursor:pointer;font-size:14px;margin-bottom:14px;
        text-align:left;display:flex;align-items:center;gap:12px">
        <span style="font-size:22px">&#128187;</span>
        <span><b>이 PC 로컬 데이터로 작업</b><br><span style="font-size:11px;font-weight:400;color:#8b949e">이 컴퓨터의 데이터만 표시</span></span>
      </button>
      <div style="font-size:11px;color:#6e7681;line-height:1.5">
        설정에서 언제든 변경할 수 있습니다.
      </div>
    `;
  }
  // ── 이미 소스 설정됨: 설치 안내 (step2) ──
  else {
    _showEmptyStateStep2();
    return;
  }

  document.body.appendChild(el);
}

function _getCurrentUserEmail() {
  try {
    const el = document.getElementById('lm-email-disp');
    return el ? el.textContent.trim() : '';
  } catch(e) { return ''; }
}

function _showEmptyStateStep2() {
  let el = document.getElementById('empty-state-guide');
  if (!el) {
    el = document.createElement('div');
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
    document.body.appendChild(el);
  }

  const isMac = /Mac/i.test(navigator.userAgent);
  const t = _getAuthToken();
  const base = location.origin;
  const installCmd = isMac
    ? `bash <(curl -sL '${base}/orbit-setup.sh${t ? '?token='+encodeURIComponent(t) : ''}')`
    : `powershell -ExecutionPolicy Bypass -Command "irm '${base}/orbit-setup.ps1${t ? '?token='+encodeURIComponent(t) : ''}' | iex"`;
  const termLabel = isMac ? '터미널' : 'PowerShell';
  const srcLabel = _getDataSource() === 'cloud' ? '클라우드 동기화' : '로컬 데이터';

  const termOpen = isMac
    ? '<kbd style="background:#21262d;padding:2px 6px;border-radius:3px;font-size:11px">Spotlight</kbd> → Terminal 검색 → Enter'
    : '<kbd style="background:#21262d;padding:2px 6px;border-radius:3px;font-size:11px">Win + R</kbd> → <b style="color:#cdd9e5">powershell</b> 입력 → Enter';

  el.innerHTML = `
    <div style="font-size:42px;margin-bottom:12px">⬡</div>
    <div style="font-size:17px;font-weight:700;color:#e6edf3;margin-bottom:6px">
      Orbit AI 설치
    </div>
    <div style="font-size:12px;color:#58a6ff;margin-bottom:16px">
      데이터 모드: <b>${srcLabel}</b>
      <span onclick="_resetDataSource()" style="color:#6e7681;cursor:pointer;margin-left:6px;text-decoration:underline;font-size:11px">변경</span>
    </div>

    <div style="text-align:left;margin-bottom:16px">
      <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px">
        <div style="width:22px;height:22px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0">1</div>
        <div style="font-size:12px;color:#8b949e;line-height:1.6">
          ${termOpen}
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px">
        <div style="width:22px;height:22px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff;flex-shrink:0">2</div>
        <div style="font-size:12px;color:#8b949e;line-height:1.6">
          아래 명령어 <b style="color:#cdd9e5">복사</b> → 붙여넣기(<kbd style="background:#21262d;padding:1px 5px;border-radius:3px;font-size:10px">Ctrl+V</kbd>) → <b style="color:#cdd9e5">Enter</b>
        </div>
      </div>
    </div>

    <div style="background:#010409;border:1px solid #21262d;border-radius:10px;
      padding:12px 14px;margin-bottom:10px;position:relative">
      <code id="esg-install-cmd" style="font-family:'Consolas','Courier New',monospace;
        font-size:11px;color:#3fb950;word-break:break-all;line-height:1.6;display:block">${installCmd}</code>
    </div>
    <button onclick="(function(){
      const cmd = document.getElementById('esg-install-cmd').textContent.trim();
      navigator.clipboard.writeText(cmd).then(()=>{
        const b=document.getElementById('esg-copy-btn');
        b.textContent='✅ 복사됨! 터미널에 붙여넣기 하세요'; b.style.background='#238636';
        setTimeout(()=>{b.textContent='명령어 복사';b.style.background='';},3000);
      }).catch(()=>prompt('복사하세요:',cmd));
    })()" id="esg-copy-btn"
      style="width:100%;background:#1f6feb;border:none;color:#fff;
      padding:9px 0;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;margin-bottom:12px">
      명령어 복사
    </button>
    <div style="font-size:11px;color:#6e7681;line-height:1.6;margin-bottom:14px">
      모든 앱 사용·웹 브라우징·키 입력이 로컬에 자동 저장됩니다 (AI 분석: 클라우드)
    </div>
    <button onclick="document.getElementById('empty-state-guide').remove()"
      style="background:#21262d;border:1px solid #30363d;color:#e6edf3;
      padding:8px 20px;border-radius:8px;cursor:pointer;font-size:13px">
      닫기
    </button>
  `;
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

