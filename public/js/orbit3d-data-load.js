// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Data loading, auth, empty state, admin view
// ══════════════════════════════════════════════════════════════════════════════

// ── 트래커 상태 모니터링 (5분마다 체크 → 문제 시 알림) ──
let _lastTrackerCheck = 0;
let _trackerAlertShown = false;

function _checkTrackerHealth() {
  const token = _getAuthToken();
  if (!token) return;

  fetch('/api/tracker/status', { headers: { Authorization: 'Bearer ' + token } })
    .then(r => r.json())
    .then(d => {
      const badge = document.getElementById('ctb-label');

      if (!d.online) {
        if (!_trackerAlertShown) {
          _trackerAlertShown = true;
          _showTrackerAlert('offline', '트래커가 연결되지 않았습니다. 설정에서 설치 코드를 실행해주세요.');
        }
        if (badge) badge.textContent = 'Claude 오프라인';
      } else {
        const lastEvent = d.lastEventAt ? new Date(d.lastEventAt) : null;
        const minsSince = lastEvent ? (Date.now() - lastEvent.getTime()) / 60000 : 999;
        // 워크스페이스 멤버 이벤트도 확인 (관리자는 본인 트래커가 없을 수 있음)
        const wsLastEvent = d.workspaceLastEventAt ? new Date(d.workspaceLastEventAt) : null;
        const wsMinsSince = wsLastEvent ? (Date.now() - wsLastEvent.getTime()) / 60000 : minsSince;
        const effectiveMinsSince = Math.min(minsSince, wsMinsSince);

        if (effectiveMinsSince > 30 && d.eventCount > 0) {
          if (!_trackerAlertShown) {
            _trackerAlertShown = true;
            _showTrackerAlert('stale', '데이터가 30분 이상 수신되지 않고 있습니다. 데몬이 중지되었을 수 있습니다.');
          }
        } else {
          _trackerAlertShown = false;
          _hideTrackerAlert();
        }
        if (badge) badge.textContent = d.online ? 'Claude 트래킹 중' : 'Claude 오프라인';
      }

      // 데몬 에러 이벤트 확인
      _checkDaemonErrors();
    })
    .catch(() => {});
}

function _showTrackerAlert(type, msg) {
  // 기존 알림 제거
  _hideTrackerAlert();
  const alert = document.createElement('div');
  alert.id = 'tracker-alert';
  alert.style.cssText = 'position:fixed;top:60px;right:20px;z-index:9999;background:#0d1117;border:1px solid ' +
    (type === 'offline' ? '#f85149' : type === 'error' ? '#f85149' : '#d29922') + ';border-radius:10px;padding:12px 16px;max-width:380px;box-shadow:0 4px 12px rgba(0,0,0,.5)';
  const titles = { offline: '트래커 미연결', stale: '데이터 수신 중단', error: '데몬 에러 감지' };
  const icons = { offline: '🔴', stale: '⚠️', error: '🛑' };
  alert.innerHTML = '<div style="display:flex;gap:8px;align-items:flex-start">' +
    '<span style="font-size:18px">' + (icons[type] || '⚠️') + '</span>' +
    '<div><div style="color:#e6edf3;font-size:12px;font-weight:600;margin-bottom:4px">' +
    (titles[type] || '알림') + '</div>' +
    '<div style="color:#8b949e;font-size:11px;line-height:1.5">' + msg + '</div>' + /* HTML 지원 */
    '<button onclick="openSetupPanel();_hideTrackerAlert()" style="margin-top:8px;font-size:11px;padding:4px 10px;' +
    'background:#1f6feb;color:#fff;border:none;border-radius:5px;cursor:pointer">설정 열기</button>' +
    '<button onclick="_hideTrackerAlert()" style="margin-top:8px;margin-left:4px;font-size:11px;padding:4px 10px;' +
    'background:none;color:#6e7681;border:1px solid #30363d;border-radius:5px;cursor:pointer">닫기</button>' +
    '</div></div>';
  document.body.appendChild(alert);
}

function _hideTrackerAlert() {
  const el = document.getElementById('tracker-alert');
  if (el) el.remove();
}

// 데몬 에러 확인
function _checkDaemonErrors() {
  _authFetch('/api/graph').then(r => r.json()).then(d => {
    const errors = (d.nodes || []).filter(n =>
      n.type === 'daemon.error' && n.timestamp > new Date(Date.now() - 3600000).toISOString()
    );
    if (errors.length > 0) {
      const latest = errors[errors.length - 1];
      const errData = latest.data || {};
      const component = errData.component || latest.label || 'daemon';
      const errMsg = errData.error || errData.detail || '';
      const hostname = errData.hostname || '';
      _showTrackerAlert('error',
        '<b>' + hostname + '</b> 데몬 에러:<br>' +
        '<code style="font-size:10px;color:#f85149;word-break:break-all">[' + component + '] ' + errMsg.slice(0, 120) + '</code><br>' +
        '<span style="font-size:10px;color:#6e7681">PC 터미널에서 확인: cat ~/.orbit/daemon.log</span>'
      );
    }
  }).catch(() => {});
}

// 5분마다 체크
setInterval(_checkTrackerHealth, 5 * 60 * 1000);
// 로그인 30초 후 첫 체크
setTimeout(_checkTrackerHealth, 30000);
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

// ── 팀원 월드 데이터 로드 (워크스페이스 팀원 클러스터용) ─────────────────────
async function loadTeamWorldData() {
  const token = _getAuthToken();
  if (!token) { window._teamWorldData = null; return; }
  try {
    const res = await _authFetch('/api/workspace/team-view');
    if (!res.ok) return;
    const data = await res.json();
    // members 배열이 있으면 저장 (나 자신 제외)
    if (data?.members?.length) {
      const myId = (typeof _orbitUser !== 'undefined' ? _orbitUser?.id : null)
                || JSON.parse(localStorage.getItem('orbitUser') || 'null')?.id;
      data.members = data.members.filter(m => m.userId !== myId);
      window._teamWorldData = data;
    }
  } catch {}
}
window.loadTeamWorldData = loadTeamWorldData;

// ── 팔로잉 데이터 로드 (개인 뷰 줌아웃 시 팔로잉 클러스터 표시용) ────────────
async function loadFollowingData() {
  const token = _getAuthToken();
  if (!token) { window._followingData = null; return; }
  try {
    const res = await _authFetch('/api/follow/list');
    if (!res.ok) return;
    const data = await res.json();
    // 배열이면 저장
    if (Array.isArray(data) && data.length > 0) {
      window._followingData = data;
    } else {
      window._followingData = null;
    }
  } catch { window._followingData = null; }
}
window.loadFollowingData = loadFollowingData;

async function loadData() {
  document.getElementById('loading-msg').textContent = '서버에서 작업 데이터 가져오는 중…';
  try {
    const res  = await _authFetch('/api/graph');  // 토큰 포함 → 내 데이터만 수신
    const data = await res.json();
    const nodes = data.nodes || [];
    buildPlanetSystem(nodes);
    // 노드 수에 맞게 자동 줌 피트 (많을수록 줌아웃해서 한눈에 보이게)
    if (typeof autoFitZoom === 'function') autoFitZoom(nodes.length);
    if (typeof updateActiveFiles === 'function') updateActiveFiles();  // 활성 파일 갱신
    if (typeof _loadWorkspaceState === 'function') _loadWorkspaceState();
    // 개인 모드에서도 3D 카메라 회전 유지 (controls.enabled = true)
    // 팀원 월드 데이터 비동기 로드 (개인 뷰에서 줌아웃 시 표시용)
    loadTeamWorldData();
    // 팔로잉 데이터 비동기 로드 (개인 뷰에서 줌아웃 시 표시용)
    loadFollowingData();
    document.getElementById('loading').style.display = 'none';

    // 이벤트 없음 → 조건부 안내
    if (nodes.length === 0) {
      // OAuth 리디렉트 직후면 _postLoginSync가 곧 loadData를 다시 호출하므로 대기
      const params = new URLSearchParams(window.location.search);
      if (params.get('oauth_token')) return;

      // 로그인 상태면 트래커 확인 → online이면 안내 스킵
      if (_getAuthToken()) {
        try {
          const sr = await _authFetch('/api/tracker/status');
          const sd = await sr.json();
          if (sd.online || sd.eventCount > 0) return; // 트래커 활성 — 데이터 도착 대기
        } catch {}
      }
      _showEmptyStateGuide();
    } else {
      _hideEmptyStateGuide();
      sessionStorage.removeItem('orbit_reload_retries');
      // 개인 뷰 활동 분석 자동 로드
      _loadActivityAnalysis();
    }
  } catch(e) {
    document.getElementById('loading').innerHTML =
      `<div style="color:#f85149;text-align:center">⚠ 서버 연결 실패<br><small style="color:#6e7681">${e.message}</small><br><br><a href="/" style="color:#58a6ff;font-size:13px">← 대시보드</a></div>`;
  }
}

// ── 개인 뷰 활동 분석 자동 로드 ─────────────────────────────────────────────────
async function _loadActivityAnalysis() {
  const panel = document.getElementById('activity-panel');
  const content = document.getElementById('ap-content');
  if (!panel || !content) return;

  try {
    const res = await _authFetch('/api/learning/analyze');
    if (!res.ok) return;
    const d = await res.json();
    if (!d || d.status !== 'ok' || !d.eventCount) return;

    // 앱 사용 바 차트
    const totalEvents = (d.topApps || []).reduce((s, a) => s + a[1], 0) || 1;
    const appBars = (d.topApps || []).slice(0, 5).map(([app, cnt]) => {
      const pct = Math.round(cnt / totalEvents * 100);
      const colors = { explorer: '#f0883e', kakaotalk: '#ffe066', chrome: '#58a6ff', excel: '#3fb950', nenova: '#bc8cff' };
      const c = colors[app] || '#8b949e';
      return `<div style="margin-bottom:6px">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px"><span>${app}</span><span style="color:#8b949e">${pct}%</span></div>
        <div style="height:6px;background:#21262d;border-radius:3px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${c};border-radius:3px"></div></div>
      </div>`;
    }).join('');

    // 카테고리 칩
    const catChips = (d.topCategories || []).slice(0, 5).map(([cat, cnt]) => {
      const pct = Math.round(cnt / totalEvents * 100);
      return `<span style="display:inline-block;padding:3px 8px;margin:2px;border-radius:10px;font-size:11px;background:#21262d;color:#e6edf3">${cat} ${pct}%</span>`;
    }).join('');

    // 인사이트
    const insights = (d.insights || []).map(i => {
      const icon = i.type === 'automation' ? '⚡' : i.type === 'focus' ? '🎯' : '💡';
      return `<div style="padding:6px 0;border-bottom:1px solid #21262d;font-size:12px">${icon} ${i.text}</div>`;
    }).join('');

    // 최근 세션 (최대 3개)
    const sessions = (d.sessions || []).slice(0, 3).map(s => {
      const dur = s.durationMin ? `${s.durationMin}분` : '';
      const app = s.primaryApp || '';
      const cat = s.primaryCategory || '';
      const wins = (s.uniqueWindows || []).slice(0, 2).join(', ');
      return `<div style="padding:6px 0;border-bottom:1px solid #21262d;font-size:12px">
        <span style="color:#58a6ff">${app}</span> <span style="color:#8b949e">${dur}</span> <span style="color:#6e7681">${cat}</span>
        ${wins ? `<div style="color:#484f58;font-size:11px;margin-top:2px">${wins}</div>` : ''}
      </div>`;
    }).join('');

    content.innerHTML = `
      <div style="margin-bottom:14px">
        <div style="color:#8b949e;font-size:11px;margin-bottom:8px">앱 사용 비율</div>
        ${appBars}
      </div>
      <div style="margin-bottom:14px">
        <div style="color:#8b949e;font-size:11px;margin-bottom:6px">작업 카테고리</div>
        ${catChips}
      </div>
      ${insights ? `<div style="margin-bottom:14px"><div style="color:#8b949e;font-size:11px;margin-bottom:6px">분석 인사이트</div>${insights}</div>` : ''}
      ${sessions ? `<div><div style="color:#8b949e;font-size:11px;margin-bottom:6px">최근 작업</div>${sessions}</div>` : ''}
      <div style="margin-top:10px;text-align:center;color:#484f58;font-size:11px">이벤트 ${d.eventCount.toLocaleString()}건 · 세션 ${d.sessionCount}개 · 자동화 ${d.automationScore || 0}/100</div>
    `;
    panel.style.display = 'block';
  } catch (e) {
    console.warn('[activity-panel] 분석 로드 실패:', e.message);
  }
}
window._loadActivityAnalysis = _loadActivityAnalysis;

// ── 로그인 후 자동 동기화 ──────────────────────────────────────────────────────
// 1) 기존 'local' 이벤트를 내 계정에 귀속
// 2) 토큰을 서버에 전달 → save-turn.js가 사용할 수 있도록 ~/.orbit-config.json 업데이트
// 3) 데이터 새로 로드
async function _postLoginSync(token) {
  // WS 재연결: 기존 연결(이전 사용자 토큰)을 닫고 새 토큰으로 재연결
  if (window._globalWs && window._globalWs.readyState <= WebSocket.OPEN) {
    window._globalWs.onclose = null; // 자동재연결 일시 억제
    window._globalWs.close();
    if (typeof connectWS === 'function') setTimeout(connectWS, 300);
  }
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
    }).catch(e => console.warn('[hook-token] 등록 실패:', e.message));

    // 3) Google Drive 자동 백업 (Google 로그인 시)
    fetch('/api/gdrive/backup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).then(r => r.json()).then(d => {
      if (d.ok) console.log('[gdrive] 자동 백업 완료:', d.eventCount, '이벤트');
    }).catch(e => console.warn('[gdrive] 백업 실패:', e.message));

    // 4) 다른 PC 동기화 확인 (F3)
    _checkSyncFromOtherPC(token);

    // 5) 주기적 자동 백업 시작
    if (typeof _startAutoBackup === 'function') _startAutoBackup();

    // 6) 데이터 새로 로드
    setTimeout(() => loadData(), 500);

    // 7) 대기 중인 초대코드 자동 참여
    if (typeof window._pendingInviteJoin === 'function') {
      setTimeout(() => {
        window._pendingInviteJoin();
        window._pendingInviteJoin = null;
      }, 1000);
    }
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

  // ── 비로그인 → Google 로그인 모달 자동 오픈 ──
  if (!isLoggedIn) {
    if (typeof openLoginModal === 'function') openLoginModal();
    return;
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

  // 트래커 연결되어 있거나 이미 닫은 적 있으면 설치 안내 불필요
  if (trackerOnline || localStorage.getItem('orbit_tracker_dismissed')) {
    return;
  }

  // ── 트래커 미연결: 로컬 PC 트래커 설치 안내 ──
  const t = _getAuthToken();
  const base = location.origin;
  const isMac = /Mac/i.test(navigator.userAgent);

  const installCmd = isMac
    ? `ORBIT_TOKEN='${t||''}' bash <(curl -sL '${base}/setup/orbit-start.sh')`
    : `powershell -ExecutionPolicy Bypass -Command "& {$env:ORBIT_TOKEN='${t||''}'; iex (irm '${base}/setup/install.ps1')}"`;


  const el = document.createElement('div');
  el.id = 'empty-state-guide';
  el.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:rgba(13,17,23,0.97); border:1px solid #30363d;
    border-radius:18px; padding:32px 36px; max-width:480px; text-align:center;
    z-index:500; backdrop-filter:blur(20px);
    box-shadow:0 16px 64px rgba(0,0,0,0.5);
    font-family:-apple-system,'Segoe UI',sans-serif;
    animation:fadeIn .4s ease;
  `;
  el.innerHTML = `
    <div style="font-size:42px;margin-bottom:12px">⬡</div>
    <div style="font-size:18px;font-weight:700;color:#e6edf3;margin-bottom:8px">
      Orbit 트래커 설치
    </div>
    <div style="font-size:13px;color:#8b949e;margin-bottom:20px;line-height:1.6">
      로컬 PC에서 작업 데이터를 수집하려면<br>아래 명령어를 터미널에 붙여넣으세요.
    </div>

    <!-- OS 탭 -->
    <div style="display:flex;gap:6px;justify-content:center;margin-bottom:12px">
      <button id="esg-tab-${isMac?'mac':'win'}" onclick="document.getElementById('esg-cmd-mac').style.display='${isMac?'block':'none'}';document.getElementById('esg-cmd-win').style.display='${isMac?'none':'block'}';this.style.background='#1f6feb';document.getElementById('esg-tab-${isMac?'win':'mac'}').style.background='#21262d'"
        style="background:#1f6feb;border:none;color:#fff;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">${isMac?'macOS':'Windows'}</button>
      <button id="esg-tab-${isMac?'win':'mac'}" onclick="document.getElementById('esg-cmd-win').style.display='${isMac?'block':'none'}';document.getElementById('esg-cmd-mac').style.display='${isMac?'none':'block'}';this.style.background='#1f6feb';document.getElementById('esg-tab-${isMac?'mac':'win'}').style.background='#21262d'"
        style="background:#21262d;border:none;color:#8b949e;padding:5px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">${isMac?'Windows':'macOS'}</button>
    </div>

    <!-- macOS 명령어 -->
    <div id="esg-cmd-mac" style="display:${isMac?'block':'none'};text-align:left;background:#010409;border:1px solid #21262d;border-radius:10px;padding:14px;position:relative;margin-bottom:14px">
      <div style="font-size:10px;color:#6e7681;margin-bottom:6px">Terminal</div>
      <code style="font-family:'Consolas','Courier New',monospace;font-size:12px;color:#3fb950;word-break:break-all;line-height:1.6;display:block;padding-right:44px">bash <(curl -sL '${base}/orbit-setup.sh${t ? '?token='+encodeURIComponent(t) : ''}')</code>
      <button onclick="(function(){
        const cmd=\`bash <(curl -sL '${base}/orbit-setup.sh${t ? '?token='+encodeURIComponent(t) : ''}')\`;
        navigator.clipboard.writeText(cmd).then(()=>{const b=event.target;b.textContent='Copied';b.style.background='#238636';setTimeout(()=>{b.textContent='Copy';b.style.background='#1f6feb'},1500)}).catch(()=>prompt('Copy:',cmd))
      })()"
        style="position:absolute;top:12px;right:12px;background:#1f6feb;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;padding:4px 12px;cursor:pointer">Copy</button>
    </div>

    <!-- Windows 명령어 -->
    <div id="esg-cmd-win" style="display:${isMac?'none':'block'};text-align:left;background:#010409;border:1px solid #21262d;border-radius:10px;padding:14px;position:relative;margin-bottom:14px">
      <div style="font-size:10px;color:#6e7681;margin-bottom:6px">PowerShell (관리자)</div>
      <code id="esg-win-cmd-text" style="font-family:'Consolas','Courier New',monospace;font-size:12px;color:#3fb950;word-break:break-all;line-height:1.6;display:block;padding-right:44px">powershell -ExecutionPolicy Bypass -Command "& {$env:ORBIT_TOKEN='${t||''}'; iex (irm '${base}/setup/install.ps1')}"</code>
      <button onclick="(function(){
        const el=document.getElementById('esg-win-cmd-text');
        navigator.clipboard.writeText(el.textContent.trim()).then(()=>{const b=event.target;b.textContent='Copied';b.style.background='#238636';setTimeout(()=>{b.textContent='Copy';b.style.background='#1f6feb'},1500)}).catch(()=>prompt('Copy:',el.textContent.trim()))
      })()"
        style="position:absolute;top:12px;right:12px;background:#1f6feb;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;padding:4px 12px;cursor:pointer">Copy</button>
    </div>

    <div style="font-size:11px;color:#6e7681;line-height:1.6;margin-bottom:16px">
      설치 후 자동으로 작업 데이터가 수집되며<br>이 화면에 실시간 시각화됩니다.
    </div>

    <button onclick="localStorage.setItem('orbit_tracker_dismissed','1');document.getElementById('empty-state-guide').remove()"
      style="background:#21262d;border:1px solid #30363d;color:#e6edf3;
      padding:8px 24px;border-radius:8px;cursor:pointer;font-size:13px">
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
    }).catch(e => console.warn('[gdrive] 주기 백업 실패:', e.message));
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

