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
    if (typeof updateActiveFiles === 'function') updateActiveFiles();  // 활성 파일 갱신
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

    // 3) Google Drive 자동 백업 (Google 로그인 시)
    fetch('/api/gdrive/backup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => {
      if (d.ok) console.log('[gdrive] 자동 백업 완료:', d.eventCount, '이벤트');
    }).catch(() => {});

    // 4) 다른 PC 동기화 확인 (F3)
    _checkSyncFromOtherPC(token);

    // 5) 주기적 자동 백업 시작
    if (typeof _startAutoBackup === 'function') _startAutoBackup();

    // 6) 데이터 새로 로드
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
async function _showEmptyStateGuide() {
  // 기존 안내가 있으면 먼저 제거 (로그인 상태 변경 시 갱신 위해)
  _hideEmptyStateGuide();

  const isLoggedIn = !!_getAuthToken();

  // ── 로그인 안 된 상태 ──
  if (!isLoggedIn) {
    return; // 로그인 모달이 자동 오픈됨 (orbit3d-ui.js)
  }

  // ── 로그인 된 상태: 트래커 연결 여부 확인 ──
  let trackerOnline = false;
  try {
    const r = await fetch('/api/tracker/status', {
      headers: { 'Authorization': `Bearer ${_getAuthToken()}` },
    });
    const d = await r.json();
    trackerOnline = d.online;
  } catch {}

  // 트래커 연결되어 있으면 설치 안내 불필요
  if (trackerOnline) {
    // 데이터만 아직 없는 상태 — 간단 안내
    const el = document.createElement('div');
    el.id = 'empty-state-guide';
    el.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      background:rgba(13,17,23,0.95); border:1px solid #23893680;
      border-radius:12px; padding:14px 22px; max-width:400px; text-align:center;
      z-index:500; backdrop-filter:blur(16px);
      box-shadow:0 8px 32px rgba(0,0,0,0.4);
      font-family:-apple-system,'Segoe UI',sans-serif;
      animation:fadeIn .4s ease;
    `;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;justify-content:center">
        <span style="width:7px;height:7px;border-radius:50%;background:#3fb950;display:inline-block;box-shadow:0 0 6px #3fb950"></span>
        <span style="font-size:12px;color:#e6edf3">Orbit 연결됨 — 작업 패턴 학습 중</span>
        <span onclick="document.getElementById('empty-state-guide').remove()"
          style="margin-left:8px;cursor:pointer;color:#6e7681;font-size:14px">✕</span>
      </div>
      <div style="font-size:11px;color:#8b949e;margin-top:6px">
        AI가 작업 패턴을 학습하면 맞춤 피드백이 대시보드에 표시됩니다.
      </div>
    `;
    document.body.appendChild(el);
    return;
  }

  // ── 트래커 미연결: 확장 프로그램 우선 안내 ──
  const t = _getAuthToken();
  const base = location.origin;
  const isMac = /Mac/i.test(navigator.userAgent);

  // 고급 옵션용 로컬 서버 설치 명령어
  const installCmd = isMac
    ? `bash <(curl -sL '${base}/orbit-setup.sh${t ? '?token='+encodeURIComponent(t) : ''}')`
    : `powershell -ExecutionPolicy Bypass -Command "irm '${base}/orbit-setup.ps1${t ? '?token='+encodeURIComponent(t) : ''}' | iex"`;

  const el = document.createElement('div');
  el.id = 'empty-state-guide';
  el.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:rgba(13,17,23,0.97); border:1px solid #30363d;
    border-radius:18px; padding:28px 32px; max-width:520px; text-align:center;
    z-index:500; backdrop-filter:blur(20px);
    box-shadow:0 16px 64px rgba(0,0,0,0.5);
    font-family:-apple-system,'Segoe UI',sans-serif;
    animation:fadeIn .4s ease;
    max-height:90vh; overflow-y:auto;
  `;
  el.innerHTML = `
    <div style="font-size:42px;margin-bottom:10px">⬡</div>
    <div style="font-size:17px;font-weight:700;color:#e6edf3;margin-bottom:6px">
      Orbit AI 시작하기
    </div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:18px;line-height:1.6">
      확장 프로그램을 설치하면 <b style="color:#58a6ff">별도 서버 설치 없이</b> 바로 사용할 수 있습니다.<br>
      AI가 작업 패턴을 학습하여 업무 효율 피드백을 제공합니다.
    </div>

    <div style="text-align:left;margin-bottom:16px">
      <!-- 1단계: Chrome 확장 -->
      <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:14px">
        <div style="width:24px;height:24px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">1</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:4px">Chrome 확장 프로그램 설치</div>
          <div style="font-size:11px;color:#8b949e;line-height:1.5;margin-bottom:6px">
            AI 대화(ChatGPT, Claude, Gemini 등)를 자동으로 수집합니다.
          </div>
          <div style="font-size:11px;color:#6e7681;line-height:1.5;background:#161b22;border:1px solid #21262d;border-radius:8px;padding:8px 10px">
            <b style="color:#cdd9e5">설치 방법:</b><br>
            1. <code style="color:#3fb950">chrome://extensions</code> 접속<br>
            2. 우측 상단 <b style="color:#cdd9e5">개발자 모드</b> ON<br>
            3. <b style="color:#cdd9e5">압축해제된 확장 프로그램을 로드</b> → <code style="color:#3fb950">chrome-extension</code> 폴더 선택
          </div>
        </div>
      </div>

      <!-- 2단계: VS Code 확장 -->
      <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:14px">
        <div style="width:24px;height:24px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">2</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:4px">VS Code 확장 프로그램 설치</div>
          <div style="font-size:11px;color:#8b949e;line-height:1.5;margin-bottom:6px">
            코딩 활동(파일 저장, 디버그, 프로젝트 전환 등)을 추적합니다.
          </div>
          <div style="font-size:11px;color:#6e7681;line-height:1.5;background:#161b22;border:1px solid #21262d;border-radius:8px;padding:8px 10px">
            <b style="color:#cdd9e5">설치 방법:</b><br>
            VS Code → Extensions(<kbd style="background:#21262d;padding:1px 4px;border-radius:3px;font-size:10px">Ctrl+Shift+X</kbd>) → <code style="color:#3fb950">VSIX에서 설치</code> → <code style="color:#3fb950">vscode-extension</code> 폴더
          </div>
        </div>
      </div>

      <!-- 3단계: 토큰 설정 -->
      <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:14px">
        <div style="width:24px;height:24px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">3</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#e6edf3;margin-bottom:4px">서버 URL + 토큰 설정</div>
          <div style="font-size:11px;color:#8b949e;line-height:1.5;margin-bottom:6px">
            아래 토큰을 복사하여 각 확장 프로그램 설정에 붙여넣으세요.
          </div>
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <div style="flex:1;background:#010409;border:1px solid #21262d;border-radius:8px;padding:8px 10px">
              <div style="font-size:10px;color:#6e7681;margin-bottom:3px">서버 URL</div>
              <code id="esg-server-url" style="font-size:11px;color:#58a6ff;word-break:break-all">${base}</code>
            </div>
          </div>
          <div style="background:#010409;border:1px solid #21262d;border-radius:8px;padding:8px 10px;position:relative">
            <div style="font-size:10px;color:#6e7681;margin-bottom:3px">인증 토큰</div>
            <code id="esg-token" style="font-size:11px;color:#3fb950;word-break:break-all">${t || '(로그인 후 표시됩니다)'}</code>
            ${t ? `<button onclick="(function(){
              navigator.clipboard.writeText('${t}').then(()=>{
                const b=document.getElementById('esg-copy-token');
                b.textContent='복사됨';b.style.background='#238636';
                setTimeout(()=>{b.textContent='토큰 복사';b.style.background='#1f6feb';},2000);
              }).catch(()=>prompt('토큰:','${t}'));
            })()" id="esg-copy-token"
              style="position:absolute;top:8px;right:8px;background:#1f6feb;border:none;
              border-radius:5px;color:#fff;font-size:10px;font-weight:600;padding:3px 10px;cursor:pointer">토큰 복사</button>` : ''}
          </div>
          <div style="font-size:10px;color:#6e7681;margin-top:4px;line-height:1.4">
            <b style="color:#cdd9e5">Chrome:</b> 확장 팝업 → 서버 URL / 토큰 입력<br>
            <b style="color:#cdd9e5">VS Code:</b> 설정(<kbd style="background:#21262d;padding:1px 4px;border-radius:3px;font-size:10px">Ctrl+,</kbd>) → orbit.serverUrl / orbit.token 입력
          </div>
        </div>
      </div>
    </div>

    <!-- 고급: 로컬 서버 설치 (접이식) -->
    <details style="text-align:left;margin-bottom:12px;border:1px solid #21262d;border-radius:8px;background:#161b22">
      <summary style="font-size:12px;color:#8b949e;cursor:pointer;padding:10px 12px;font-weight:600">
        고급: 로컬 서버 설치 (선택 사항)
      </summary>
      <div style="padding:0 12px 10px;font-size:11px;color:#6e7681;line-height:1.6">
        <div style="margin-bottom:6px">로컬 서버를 설치하면 데이터가 PC에만 저장됩니다. (오프라인 가능)</div>
        <div style="background:#010409;border:1px solid #21262d;border-radius:8px;padding:10px;position:relative">
          <code id="esg-install-cmd" style="font-family:'Consolas','Courier New',monospace;font-size:11px;color:#3fb950;word-break:break-all;line-height:1.6;display:block;padding-right:44px">${installCmd}</code>
          <button onclick="(function(){
            const cmd=document.getElementById('esg-install-cmd').textContent.trim();
            navigator.clipboard.writeText(cmd).then(()=>{
              const b=document.getElementById('esg-copy-cmd');
              b.textContent='복사됨';b.style.background='#238636';
              setTimeout(()=>{b.textContent='복사';b.style.background='#1f6feb';},2000);
            }).catch(()=>prompt('복사:',cmd));
          })()" id="esg-copy-cmd"
            style="position:absolute;top:8px;right:8px;background:#1f6feb;border:none;
            border-radius:5px;color:#fff;font-size:10px;font-weight:600;padding:3px 8px;cursor:pointer">복사</button>
        </div>
      </div>
    </details>

    <button onclick="document.getElementById('empty-state-guide').remove()"
      style="background:#21262d;border:1px solid #30363d;color:#e6edf3;
      padding:8px 20px;border-radius:8px;cursor:pointer;font-size:13px">
      닫기
    </button>
  `;
  document.body.appendChild(el);
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

// ── F3: 다른 PC에서 Google Drive 데이터 불러오기 ──────────────────────────────
async function _checkSyncFromOtherPC(token) {
  try {
    const res = await fetch('/api/gdrive/sync-check', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();

    if (!data.hasBackup || data.samePC) return; // 백업 없거나 같은 PC → 무시

    // 다른 PC의 백업 발견 → 모달 표시
    const backup = data.latestBackup;
    const date = new Date(backup.createdAt).toLocaleString();
    const sizeKB = Math.round((backup.size || 0) / 1024);

    const modal = document.createElement('div');
    modal.id = 'sync-import-modal';
    modal.style.cssText = `
      position:fixed;top:0;left:0;width:100%;height:100%;
      background:rgba(0,0,0,0.7);z-index:9999;
      display:flex;align-items:center;justify-content:center;
      backdrop-filter:blur(8px);animation:fadeIn .3s ease;
    `;
    modal.innerHTML = `
      <div style="background:#0d1117;border:1px solid #30363d;border-radius:16px;
        padding:28px 32px;max-width:440px;width:90%;text-align:center;
        box-shadow:0 16px 64px rgba(0,0,0,0.5);font-family:-apple-system,'Segoe UI',sans-serif;">
        <div style="font-size:36px;margin-bottom:8px">☁️</div>
        <div style="font-size:16px;font-weight:700;color:#e6edf3;margin-bottom:6px">
          기존 작업 내역을 가져오시겠습니까?
        </div>
        <div style="font-size:12px;color:#8b949e;margin-bottom:16px;line-height:1.6">
          다른 PC에서 백업된 데이터가 발견되었습니다.
        </div>
        <div style="background:#161b22;border:1px solid #21262d;border-radius:10px;
          padding:12px;margin-bottom:16px;text-align:left;font-size:12px;color:#e6edf3;">
          <div style="margin-bottom:4px"><span style="color:#8b949e">PC:</span> ${backup.pcId}</div>
          <div style="margin-bottom:4px"><span style="color:#8b949e">날짜:</span> ${date}</div>
          <div><span style="color:#8b949e">크기:</span> ${sizeKB} KB</div>
        </div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button onclick="_importFromDrive('${backup.fileId}','${token}')"
            style="background:#238636;border:none;border-radius:8px;color:#fff;
            padding:10px 24px;cursor:pointer;font-size:14px;font-weight:600">
            가져오기
          </button>
          <button onclick="document.getElementById('sync-import-modal').remove()"
            style="background:#21262d;border:1px solid #30363d;border-radius:8px;
            color:#e6edf3;padding:10px 24px;cursor:pointer;font-size:14px">
            새로 시작
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  } catch (e) {
    console.warn('[sync-check]', e.message);
  }
}

async function _importFromDrive(fileId, token) {
  const modal = document.getElementById('sync-import-modal');
  try {
    // 버튼 비활성화
    if (modal) {
      const btns = modal.querySelectorAll('button');
      btns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; });
      btns[0].textContent = '가져오는 중...';
    }

    const res = await fetch('/api/gdrive/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fileId }),
    });
    const data = await res.json();

    if (modal) modal.remove();

    if (data.ok) {
      showToast(`${data.imported}개 이벤트를 가져왔습니다 (${data.skipped}개 중복 건너뜀)`, 'success');
      setTimeout(() => loadData(), 800);
    } else {
      showToast('가져오기 실패: ' + (data.error || '알 수 없는 오류'), 'error');
    }
  } catch (e) {
    if (modal) modal.remove();
    showToast('가져오기 오류: ' + e.message, 'error');
  }
}

// ─── 주기적 Google Drive 자동 백업 (5분마다) ──────────────────────────────────
let _autoBackupTimer = null;
function _startAutoBackup() {
  if (_autoBackupTimer) return;                                                  // 이미 실행 중
  _autoBackupTimer = setInterval(() => {
    const token = _getAuthToken();
    if (!token) return;                                                          // 비로그인 시 스킵
    fetch('/api/gdrive/backup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => {
      if (d.ok) console.log('[gdrive] 자동 백업:', d.eventCount, '이벤트');
    }).catch(() => {});
  }, 5 * 60 * 1000);                                                            // 5분 간격
}
// 페이지 로드 시 로그인 상태면 자동 백업 시작
setTimeout(() => { if (_getAuthToken()) _startAutoBackup(); }, 10000);

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

