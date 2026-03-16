/* orbit3d-ui-panels.js — UI panels, modals, sidebar (extracted from ui) */

// ── 솔루션 제안 토스트 ──────────────────────────────────────────────────────
let _currentSuggestionId = null;

function showSuggestion(suggestion) {
  _currentSuggestionId = suggestion.id;
  document.getElementById('st-body').innerHTML = `
    <b style="color:#cdd9e5">${suggestion.pattern}</b><br>
    <span style="color:#58a6ff">💡 ${suggestion.suggestion}</span>
    ${suggestion.automatable ? '<br><span style="color:#3fb950;font-size:10px">⚡ 자동화 가능</span>' : ''}
  `;
  document.getElementById('suggestion-toast').classList.add('visible');
}

function dismissSuggestion() {
  document.getElementById('suggestion-toast').classList.remove('visible');
  if (_currentSuggestionId) {
    fetch(`/api/learn/seen/${_currentSuggestionId}`, { method: 'POST' }).catch(e => console.warn('[learn] seen 마킹 실패:', e.message));
  }
}

function acceptSuggestion() {
  dismissSuggestion();
  // 기능 패널 열기 (솔루션 마켓으로 연결)
  document.getElementById('feat-btn')?.click();
}

window.dismissSuggestion = dismissSuggestion;
window.acceptSuggestion  = acceptSuggestion;

// 주기적으로 새 제안 확인 (60초마다, API 없으면 자동 중지)
let _suggestionsAvailable = true;
setInterval(async () => {
  if (!_suggestionsAvailable) return;
  try {
    const res = await fetch('/api/learn/suggestions');
    if (res.status === 404) { _suggestionsAvailable = false; return; }
    if (!res.ok) return;
    const list = await res.json();
    const unseen = list.find(s => !s.seen);
    if (unseen && !document.getElementById('suggestion-toast').classList.contains('visible')) {
      showSuggestion(unseen);
    }
  } catch {}
}, 60000);

// ── 동의 모달 ────────────────────────────────────────────────────────────────
function consentDecide(allow) {
  localStorage.setItem('orbitConsentDecided', '1');
  localStorage.setItem('orbitTrackingAllowed', allow ? '1' : '0');
  document.getElementById('consent-modal').classList.remove('visible');
  if (allow) {
    console.log('[Orbit] 자동 트래킹 허용됨');
  }
}
window.consentDecide = consentDecide;

// 자동 허용 (모달 표시 없이 즉시 동의 처리)
if (!localStorage.getItem('orbitConsentDecided')) {
  localStorage.setItem('orbitConsentDecided', '1');
  localStorage.setItem('orbitTrackingAllowed', '1');
  console.log('[Orbit] 자동 트래킹 자동 허용됨');
}

// ── 로그인 모달 ──────────────────────────────────────────────────────────────
let _orbitUser = (() => { try { return JSON.parse(localStorage.getItem('orbitUser') || 'null'); } catch { return null; } })();

function openLoginModal() {
  document.getElementById('login-modal-overlay').classList.add('open');
  renderLoginState();
}
window.openLoginModal = openLoginModal;

function closeLoginModal() {
  document.getElementById('login-modal-overlay').classList.remove('open');
}
window.closeLoginModal = closeLoginModal;

function handleOverlayClick(e) {
  if (e.target === document.getElementById('login-modal-overlay')) closeLoginModal();
}
window.handleOverlayClick = handleOverlayClick;

function renderLoginState() {
  const authView    = document.getElementById('lm-auth-view');
  const profileView = document.getElementById('lm-profile-view');
  const btn         = document.getElementById('login-btn');
  if (_orbitUser) {
    authView.style.display    = 'none';
    profileView.style.display = 'flex';
    profileView.style.flexDirection = 'column';
    profileView.style.gap = '14px';
    document.getElementById('lm-name').textContent       = _orbitUser.name || '사용자';
    document.getElementById('lm-email-disp').textContent = _orbitUser.email || '';
    const av = document.getElementById('lm-av');
    if (_orbitUser.avatar) {
      av.innerHTML = `<img src="${_orbitUser.avatar}" alt="">`;
    } else {
      av.textContent = (_orbitUser.name || '?')[0].toUpperCase();
    }
    btn.textContent = `👤 ${_orbitUser.name || '내 계정'}`;
    btn.classList.add('logged-in');
    // 사이드바 프로필 업데이트
    const lnAv = document.getElementById('ln-avatar-box');
    const lnName = document.getElementById('ln-username');
    const lnEmail = document.getElementById('ln-useremail');
    const lnAuthBtn = document.getElementById('ln-auth-btn');
    const lnLogout = document.getElementById('ln-logout-btn');
    if (lnAv) {
      if (_orbitUser.avatar) lnAv.innerHTML = `<img src="${_orbitUser.avatar}" alt="">`;
      else lnAv.textContent = (_orbitUser.name || '?')[0].toUpperCase();
    }
    if (lnName) lnName.textContent = _orbitUser.name || '사용자';
    if (lnEmail) lnEmail.textContent = _orbitUser.email || '';
    if (lnAuthBtn) lnAuthBtn.style.display = 'none';
    if (lnLogout) lnLogout.style.display = 'flex';
    // 팔로잉 버튼 표시
    const lnFollowingBtn = document.getElementById('ln-following-btn');
    if (lnFollowingBtn) lnFollowingBtn.style.display = 'flex';
    // 트래커 배너 업데이트 (비동기)
    setTimeout(updateTrackerBanner, 500);
    // 프로필 체크 (비동기)
    setTimeout(checkAndPromptProfile, 800);
    // DM 미읽음 폴링 즉시 시작
    setTimeout(_pollUnreadDMs, 500);
  } else {
    // 로그아웃 시 프로필 카드 + 팔로잉 버튼 숨기기
    const pCard = document.getElementById('ln-profile-card');
    if (pCard) pCard.classList.remove('show');
    const lnFollowingBtn = document.getElementById('ln-following-btn');
    if (lnFollowingBtn) lnFollowingBtn.style.display = 'none';
    authView.style.display = 'flex';
    authView.style.flexDirection = 'column';
    authView.style.gap = '10px';
    profileView.style.display = 'none';
    btn.textContent = '🔑 로그인';
    btn.classList.remove('logged-in');
    // 사이드바 프로필 초기화
    const lnAv2 = document.getElementById('ln-avatar-box');
    const lnName2 = document.getElementById('ln-username');
    const lnEmail2 = document.getElementById('ln-useremail');
    const lnAuthBtn2 = document.getElementById('ln-auth-btn');
    const lnLogout2 = document.getElementById('ln-logout-btn');
    if (lnAv2) lnAv2.textContent = '?';
    if (lnName2) lnName2.textContent = '게스트';
    if (lnEmail2) lnEmail2.textContent = '';
    if (lnAuthBtn2) lnAuthBtn2.style.display = 'block';
    if (lnLogout2) lnLogout2.style.display = 'none';
  }
  // Google OAuth 버튼 활성/비활성
  fetch('/api/auth/oauth/status').then(r => r.json()).then(data => {
    const gBtn = document.getElementById('lm-google-btn');
    if (gBtn && !data.google) {
      gBtn.classList.add('disabled');
      gBtn.title = 'Google OAuth 환경변수 미설정 (관리자 문의)';
      gBtn.onclick = null;
    }
  }).catch(e => console.warn('[auth] OAuth 상태 확인 실패:', e.message));
}

function oauthLogin(provider) {
  if (typeof track === 'function') track('auth.login', { provider });
  window.location.href = `/api/auth/${provider}`;
}
window.oauthLogin = oauthLogin;

function showLoginError(msg) {
  const el = document.getElementById('lm-error');
  el.textContent = msg; el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function doEmailLogin() {
  const email = document.getElementById('lm-email').value.trim();
  const pw    = document.getElementById('lm-pw').value;
  if (!email || !pw) { showLoginError('이메일과 비밀번호를 입력하세요'); return; }
  try {
    const r = await fetch('/api/auth/login', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password: pw })
    });
    const d = await r.json();
    if (!r.ok) { showLoginError(d.error || '로그인 실패'); return; }
    const u = d.user || d;                                                       // auth API 응답 형식 호환 (user 객체 또는 플랫)
    _orbitUser = { id: u.id || d.id, name: u.name || d.name, email: u.email || d.email, avatar: u.avatar || d.avatar || null, plan: u.plan || 'free', token: d.token }; // id·plan 포함
    localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
    localStorage.setItem('orbit_token', d.token);                              // 토큰 저장 (API 인증용)
    // claim + Drive 동기화 + 데이터 새로고침 (OAuth 로그인과 동일 흐름)
    if (typeof _postLoginSync === 'function') _postLoginSync(d.token);
    if (typeof track === 'function') track('auth.login', { provider: 'email' });
    renderLoginState();
    closeLoginModal();
  } catch { showLoginError('서버 연결 오류'); }
}
window.doEmailLogin = doEmailLogin;

async function doRegister() {
  const name  = document.getElementById('lm-reg-name').value.trim();
  const email = document.getElementById('lm-reg-email').value.trim();
  const pw    = document.getElementById('lm-reg-pw').value;
  if (!name || !email || !pw) { showLoginError('모든 항목을 입력하세요'); return; }
  try {
    const r = await fetch('/api/auth/register', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, email, password: pw })
    });
    const d = await r.json();
    if (!r.ok) { showLoginError(d.error || '회원가입 실패'); return; }
    const ru = d.user || d;                                                      // auth API 응답 형식 호환
    _orbitUser = { id: ru.id || d.id, name: ru.name || name, email, avatar: null, plan: ru.plan || 'free', token: d.token }; // id·plan 포함
    localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
    localStorage.setItem('orbit_token', d.token);                              // 토큰 저장 (API 인증용)
    if (typeof _postLoginSync === 'function') _postLoginSync(d.token);         // claim + Drive 동기화
    if (typeof track === 'function') track('auth.register', { provider: 'email' });
    renderLoginState();
    closeLoginModal();
  } catch { showLoginError('서버 연결 오류'); }
}
window.doRegister = doRegister;

function toggleRegister() {
  const emailForm    = document.getElementById('lm-email-form');
  const registerForm = document.getElementById('lm-register-form');
  const isEmail      = emailForm.style.display !== 'none';
  emailForm.style.display    = isEmail ? 'none' : 'flex';
  registerForm.style.display = isEmail ? 'flex' : 'none';
  document.getElementById('lm-error').style.display = 'none';
}
window.toggleRegister = toggleRegister;

function doLogoutMain() {
  if (typeof track === 'function') track('auth.logout');
  _orbitUser = null;
  localStorage.removeItem('orbitUser');
  localStorage.removeItem('orbit_token');                                      // 토큰 제거
  renderLoginState();
  closeLoginModal();
  // WS 재연결: 토큰 없는 상태로 → 서버가 빈 그래프 전송
  if (window._globalWs && window._globalWs.readyState <= WebSocket.OPEN) {
    window._globalWs.onclose = null;
    window._globalWs.close();
    if (typeof connectWS === 'function') setTimeout(connectWS, 200);
  }
  if (typeof loadData === 'function') loadData();                              // 빈 화면으로 새로고침
}
window.doLogoutMain = doLogoutMain;

// OAuth 콜백: Google/GitHub 리디렉션 후 URL 파라미터로 토큰 전달
(function handleOAuthCallback() {
  const params     = new URLSearchParams(window.location.search);
  const oauthToken = params.get('oauth_token');
  const provider   = params.get('provider');
  const oauthError = params.get('oauth_error');
  if (oauthError) {
    window.history.replaceState({}, '', window.location.pathname);
    // 모달 열고 에러 표시
    setTimeout(() => { openLoginModal(); showLoginError(`${provider || 'OAuth'} 로그인 실패`); }, 300);
    renderLoginState();
    return;
  }
  if (oauthToken) {
    // 토큰으로 내 정보 가져오기
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${oauthToken}` } })
      .then(r => r.json())
      .then(d => {
        _orbitUser = { id: d.id || d.user?.id, name: d.name || d.user?.name || '사용자', email: d.email || d.user?.email || '', avatar: d.avatar || d.user?.avatar || null, plan: d.plan || d.user?.plan || 'free', token: oauthToken };
        localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
        localStorage.setItem('orbit_token', oauthToken);
        window.history.replaceState({}, '', window.location.pathname);
        renderLoginState();
        closeLoginModal();
        _postLoginSync(oauthToken);
      })
      .catch(() => {
        // JWT 토큰에서 id 추출 시도 (base64 디코딩)
        let tokenId = null;
        try {
          const payload = JSON.parse(atob(oauthToken.split('.')[1]));
          tokenId = payload.id || payload.sub || payload.userId || null;
        } catch {}
        _orbitUser = { id: tokenId, name: provider || '사용자', email: '', avatar: null, plan: 'free', token: oauthToken };
        localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
        localStorage.setItem('orbit_token', oauthToken);
        window.history.replaceState({}, '', window.location.pathname);
        renderLoginState();
        closeLoginModal();
        _postLoginSync(oauthToken);
      });
    return;
  }
  renderLoginState();
  // 로그인 안 된 상태로 진입 시 모달 자동 오픈 (1.2초 후 — 3D 씬 로드 이후)
  if (!_orbitUser) {
    setTimeout(() => {
      if (!_orbitUser) openLoginModal();
    }, 1200);
  }
})();

// ── 초대 링크 자동 참여 처리 ───────────────────────────────────────────────
// URL: /orbit3d.html?invite=CODE  또는 localStorage orbit_pending_invite
(function handleInviteCode() {
  const params = new URLSearchParams(window.location.search);
  const inviteCode = params.get('invite') || localStorage.getItem('orbit_pending_invite');
  if (!inviteCode) return;

  // URL에서 invite 파라미터 제거
  if (params.get('invite')) {
    params.delete('invite');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? '?' + qs : ''));
  }

  async function _tryAutoJoin() {
    const token = localStorage.getItem('orbit_token');
    if (!token) {
      // 로그인 안 됨 → pending으로 저장, 로그인 후 재시도
      localStorage.setItem('orbit_pending_invite', inviteCode);
      return;
    }
    localStorage.removeItem('orbit_pending_invite');
    try {
      const res = await fetch('/api/workspace/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ inviteCode }),
      });
      const d = await res.json();
      if (res.ok) {
        if (d.message === 'already joined') {
          showToast(`이미 "${d.workspace?.name || '워크스페이스'}"에 참여 중입니다`);
        } else {
          showToast(`"${d.workspace?.name || '워크스페이스'}" 참여 요청 완료! 관리자 승인을 기다려주세요.`);
        }
      } else {
        showToast(d.error || '초대코드 참여 실패');
      }
    } catch (e) {
      showToast('초대코드 참여 오류: ' + e.message);
    }
  }

  // 로그인 상태면 즉시 시도, 아니면 로그인 후 시도하도록 저장
  if (_orbitUser) {
    setTimeout(_tryAutoJoin, 500);
  } else {
    localStorage.setItem('orbit_pending_invite', inviteCode);
    // 로그인 성공 후 호출될 수 있도록 전역에 등록
    window._pendingInviteJoin = _tryAutoJoin;
  }
})();

// ── 결제 콜백 처리 (Toss 리다이렉트 후) ───────────────────────────────────
(function handlePaymentCallback() {
  const params = new URLSearchParams(window.location.search);
  const paymentSuccess = params.get('paymentSuccess');
  const paymentFail = params.get('paymentFail');
  if (paymentSuccess) {
    const plan = params.get('plan') || 'pro';
    if (_orbitUser) {
      _orbitUser.plan = plan;
      localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
    }
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(() => showToast(`${plan.toUpperCase()} 플랜으로 업그레이드 완료!`), 500);
  } else if (paymentFail) {
    const error = params.get('error') || '';
    window.history.replaceState({}, '', window.location.pathname);
    setTimeout(() => showToast('결제 실패: ' + (error || '다시 시도해주세요')), 500);
  }
})();

// ── URL ?demo=team|company|parallel 자동 로드 ─────────────────────────────
(function handleDemoParam() {
  const demo = new URLSearchParams(window.location.search).get('demo');
  if (!demo) return;
  // URL에서 파라미터 제거 (히스토리 오염 방지)
  window.history.replaceState({}, '', window.location.pathname);
  const delay = 1800; // 3D 씬 초기화 이후 실행
  if (demo === 'team')     setTimeout(() => { if (typeof loadTeamDemo    === 'function') loadTeamDemo(); },    delay);
  if (demo === 'company')  setTimeout(() => { if (typeof loadCompanyDemo  === 'function') loadCompanyDemo(); },  delay);
  if (demo === 'parallel') setTimeout(() => { if (typeof loadParallelDemo === 'function') loadParallelDemo(); }, delay);
})();

/* ══════════════════════════════════════════════════════════════════════════
 * PROFILE SYSTEM — LinkedIn 수준 프로필 등록/편집
 * ══════════════════════════════════════════════════════════════════════════ */

let _profileData     = null;   // 현재 로드된 프로필
let _profileSkills   = [];
let _profileExps     = [];
let _profileEdus     = [];

// ── 로그인 후 프로필 체크 ────────────────────────────────────────────────
async function checkAndPromptProfile() {
  if (!_orbitUser) return;
  const token = _getToken();
  if (!token) return;

  // 7일 내 이미 스킵했으면 표시 안 함
  const skipped = parseInt(localStorage.getItem('profileSkippedAt') || '0');
  if (Date.now() - skipped < 7 * 24 * 3600 * 1000) return;

  try {
    const res  = await fetch('/api/profile/check', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { console.debug('[Profile] token expired, skipping'); return; }
    if (!res.ok) return;
    const data = await res.json();
    if (!data.exists) {
      setTimeout(() => {
        document.getElementById('profile-prompt-modal').classList.add('open');
      }, 1500);
    } else {
      // 프로필 있으면 사이드바 카드 업데이트
      loadProfileForSidebar(token);
    }
  } catch (_) {}
}
window.checkAndPromptProfile = checkAndPromptProfile;

async function loadProfileForSidebar(token) {
  try {
    const res  = await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const data = await res.json();
    if (!data) return;
    _profileData = data;
    const card    = document.getElementById('ln-profile-card');
    const hl      = document.getElementById('ln-pc-headline');
    const company = document.getElementById('ln-pc-company');
    if (card) {
      if (hl) hl.textContent     = data.headline || '';
      if (company) company.textContent = data.company ? `🏢 ${data.company}` : '';
      if (data.headline || data.company) card.classList.add('show');
    }
  } catch (_) {}
}

function skipProfilePrompt() {
  localStorage.setItem('profileSkippedAt', Date.now().toString());
  document.getElementById('profile-prompt-modal').classList.remove('open');
}
window.skipProfilePrompt = skipProfilePrompt;

// ── 프로필 편집 모달 열기/닫기 ──────────────────────────────────────────
async function openProfileEditModal() {
  // 먼저 유도 모달 닫기
  document.getElementById('profile-prompt-modal').classList.remove('open');
  document.getElementById('profile-edit-modal').classList.add('open');

  // 기존 프로필 로드
  const token = _orbitUser?.token || localStorage.getItem('orbitToken');
  if (token) {
    try {
      const res = await fetch('/api/profile', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        if (data) populateProfileForm(data);
      }
    } catch (_) {}
  }

  // 아바타 표시
  const av = document.getElementById('pem-avatar');
  if (av && _orbitUser) {
    if (_orbitUser.avatar) av.innerHTML = `<img src="${_orbitUser.avatar}" alt="">`;
    else av.textContent = (_orbitUser.name || '?')[0].toUpperCase();
  }
  // 이름 기본값
  const nameInput = document.getElementById('pem-name');
  if (nameInput && !nameInput.value && _orbitUser?.name) nameInput.value = _orbitUser.name;
}
window.openProfileEditModal = openProfileEditModal;

// ── 프로필 영역 클릭 핸들러 (좌측 네비) ────────────
function handleProfileAreaClick() {
  if (typeof _orbitUser !== 'undefined' && _orbitUser) {
    openProfileEditModal();
  } else {
    if (typeof openLoginModal === 'function') openLoginModal();
  }
}
window.handleProfileAreaClick = handleProfileAreaClick;

// ── 필터칩 표시 조건 (별자리 뷰에서는 숨김) ────────
function updateFilterBarVisibility() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  // focusedProject가 있을 때만 표시, 그 외 숨김
  const hasFocus = typeof _focusedProject !== 'undefined' && _focusedProject;
  bar.style.display = hasFocus ? 'flex' : 'none';
}
window.updateFilterBarVisibility = updateFilterBarVisibility;
// 초기에는 숨김
document.addEventListener('DOMContentLoaded', () => updateFilterBarVisibility());

function closeProfileEditModal() {
  document.getElementById('profile-edit-modal').classList.remove('open');
}
window.closeProfileEditModal = closeProfileEditModal;

function populateProfileForm(data) {
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  set('pem-name',     data.name);
  set('pem-headline', data.headline);
  set('pem-company',  data.company);
  set('pem-location', data.location);
  set('pem-bio',      data.bio);
  const links = typeof data.links === 'object' ? data.links : {};
  set('pem-github',   links.github);
  set('pem-linkedin', links.linkedin);
  set('pem-website',  links.website);
  set('pem-twitter',  links.twitter);
  const pub = document.getElementById('pem-public');
  if (pub) pub.checked = data.is_public !== 0;

  // 스킬
  _profileSkills = Array.isArray(data.skills) ? [...data.skills] : [];
  renderSkillTags();

  // 경력
  _profileExps = Array.isArray(data.experiences) ? [...data.experiences] : [];
  renderExpCards();

  // 학력
  _profileEdus = Array.isArray(data.education) ? [...data.education] : [];
  renderEduCards();
}

// ── 스킬 태그 ────────────────────────────────────────────────────────────
function renderSkillTags() {
  const box = document.getElementById('pem-skills-tags');
  if (!box) return;
  box.innerHTML = _profileSkills.map((s, i) => `
    <span class="pem-tag">${s}<span class="pem-tag-x" onclick="removeSkillTag(${i})">✕</span></span>
  `).join('');
}

function addSkillTag() {
  const inp = document.getElementById('pem-skill-input');
  if (!inp) return;
  const val = inp.value.trim();
  if (val && !_profileSkills.includes(val) && _profileSkills.length < 50) {
    _profileSkills.push(val);
    renderSkillTags();
    inp.value = '';
  }
  inp.focus();
}
window.addSkillTag = addSkillTag;

function removeSkillTag(idx) {
  _profileSkills.splice(idx, 1);
  renderSkillTags();
}
window.removeSkillTag = removeSkillTag;

// ── 경력 카드 ────────────────────────────────────────────────────────────
function renderExpCards() {
  const list = document.getElementById('pem-exp-list');
  if (!list) return;
  list.innerHTML = _profileExps.map((e, i) => `
    <div class="pem-card">
      <div class="pem-card-header">
        <span style="font-size:12px;color:#58a6ff;font-weight:600">💼 경력 ${i + 1}</span>
        <button class="pem-card-del" onclick="removeExpCard(${i})">🗑</button>
      </div>
      <div class="pem-row-2">
        <input class="pem-input" placeholder="회사명" value="${e.company||''}"
          oninput="_profileExps[${i}].company=this.value" />
        <input class="pem-input" placeholder="직책/역할" value="${e.role||''}"
          oninput="_profileExps[${i}].role=this.value" />
      </div>
      <input class="pem-input" placeholder="기간  예: 2022.03 – 현재" value="${e.period||''}"
        oninput="_profileExps[${i}].period=this.value" />
      <textarea class="pem-textarea" placeholder="주요 업무/성과" style="min-height:60px"
        oninput="_profileExps[${i}].desc=this.value">${e.desc||''}</textarea>
    </div>
  `).join('');
}

function addExpCard() {
  _profileExps.push({ company: '', role: '', period: '', desc: '' });
  renderExpCards();
}
window.addExpCard = addExpCard;

function removeExpCard(idx) {
  _profileExps.splice(idx, 1);
  renderExpCards();
}
window.removeExpCard = removeExpCard;

// ── 학력 카드 ────────────────────────────────────────────────────────────
function renderEduCards() {
  const list = document.getElementById('pem-edu-list');
  if (!list) return;
  list.innerHTML = _profileEdus.map((e, i) => `
    <div class="pem-card">
      <div class="pem-card-header">
        <span style="font-size:12px;color:#3fb950;font-weight:600">🎓 학력 ${i + 1}</span>
        <button class="pem-card-del" onclick="removeEduCard(${i})">🗑</button>
      </div>
      <div class="pem-row-2">
        <input class="pem-input" placeholder="학교명" value="${e.school||''}"
          oninput="_profileEdus[${i}].school=this.value" />
        <input class="pem-input" placeholder="학위/전공" value="${e.degree||''}"
          oninput="_profileEdus[${i}].degree=this.value" />
      </div>
      <input class="pem-input" placeholder="기간  예: 2018 – 2022" value="${e.period||''}"
        oninput="_profileEdus[${i}].period=this.value" />
    </div>
  `).join('');
}

function addEduCard() {
  _profileEdus.push({ school: '', degree: '', period: '' });
  renderEduCards();
}
window.addEduCard = addEduCard;

function removeEduCard(idx) {
  _profileEdus.splice(idx, 1);
  renderEduCards();
}
window.removeEduCard = removeEduCard;

// ── 프로필 저장 ──────────────────────────────────────────────────────────
async function saveProfile() {
  const token = _orbitUser?.token || localStorage.getItem('orbitToken');
  if (!token) { alert('로그인이 필요합니다.'); return; }

  const get  = id => document.getElementById(id)?.value?.trim() || '';
  const name = get('pem-name');
  if (!name) { document.getElementById('pem-name').focus(); alert('이름을 입력해주세요.'); return; }

  const btn = document.querySelector('.pem-btn-save');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중...'; }

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name,
        headline:    get('pem-headline'),
        company:     get('pem-company'),
        location:    get('pem-location'),
        bio:         get('pem-bio'),
        skills:      _profileSkills,
        experiences: _profileExps,
        education:   _profileEdus,
        links: {
          github:   get('pem-github'),
          linkedin: get('pem-linkedin'),
          website:  get('pem-website'),
          twitter:  get('pem-twitter'),
        },
        is_public: document.getElementById('pem-public')?.checked !== false,
      }),
    });

    if (res.ok) {
      closeProfileEditModal();
      // 사이드바 프로필 카드 업데이트
      const card    = document.getElementById('ln-profile-card');
      const hl      = document.getElementById('ln-pc-headline');
      const company = document.getElementById('ln-pc-company');
      if (hl)      hl.textContent      = get('pem-headline') || name;
      if (company) company.textContent = get('pem-company') ? `🏢 ${get('pem-company')}` : '';
      if (card && (get('pem-headline') || get('pem-company'))) card.classList.add('show');
      if (typeof track === 'function') track('node.edit', { type: 'profile' });
    } else {
      const err = await res.json().catch(() => ({}));
      alert('저장 실패: ' + (err.error || res.status));
    }
  } catch (e) {
    alert('저장 중 오류: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 프로필 저장'; }
  }
}
window.saveProfile = saveProfile;

/* ── 뷰 전환 확인 토스트 ────────────────────────────────────────────────────
 * showSwitchToast(msg, onConfirm) — 줌 LOD 임계값 도달 시 자동 전환 대신 사용자에게 물어봄
 * ─────────────────────────────────────────────────────────────────────────── */
let _switchToastCb = null;
let _switchToastTimer = null;

function showSwitchToast(msg, onConfirm) {
  _switchToastCb = onConfirm;
  const toast = document.getElementById('switch-toast');
  const msgEl = document.getElementById('sw-toast-msg');
  const yesBtn = document.getElementById('sw-toast-yes');
  if (!toast || !msgEl) return;
  msgEl.textContent = msg;
  yesBtn.onclick = () => { dismissSwitchToast(); if (_switchToastCb) _switchToastCb(); };
  toast.classList.add('show');
  // 8초 후 자동 닫기 (무시하면 사라짐)
  clearTimeout(_switchToastTimer);
  _switchToastTimer = setTimeout(dismissSwitchToast, 8000);
}
window.showSwitchToast = showSwitchToast;

function dismissSwitchToast() {
  clearTimeout(_switchToastTimer);
  _switchToastCb = null;
  document.getElementById('switch-toast')?.classList.remove('show');
}
window.dismissSwitchToast = dismissSwitchToast;

/* ══ MESSENGER ════════════════════════════════════════════════════════════════
 * 개인(DM) / 팀 / 회사 채팅 + @orbit AI 봇
 * ─────────────────────────────────────────────────────────────────────────── */
let _msgTab        = 'dm';       // 현재 탭
let _msgRoomId     = null;       // 현재 열린 방 ID
let _msgRoomName   = '';         // 현재 방 이름
let _msgWs         = null;       // WebSocket 참조 (전역 ws 재사용)
let _msgQuota      = null;       // 쿼터 캐시

function _msgToken() {
  return _orbitUser?.token || localStorage.getItem('orbitToken') || '';
}

// ── 패널 열기/닫기 ───────────────────────────────────────────────────────────
function toggleMessenger() {
  closeAllRightPanels('messenger-panel');
  const panel = document.getElementById('messenger-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) {
    if (!_orbitUser) {
      document.getElementById('msg-rooms-list').innerHTML =
        '<div class="msg-empty-chat" style="font-size:11px;padding:16px">로그인이 필요합니다</div>';
      return;
    }
    loadMsgRooms(_msgTab);
    loadMsgQuota();
  }
}
window.toggleMessenger = toggleMessenger;


// ══ 가이드 팝업 ══════════════════════════════════════════════════════════════
function openGuidePopup() {
  document.getElementById('guide-popup').style.display = 'flex';

  // 로그인 상태에 따라 샘플 섹션 / 로그인 버튼 표시 제어
  const isLoggedIn = !!localStorage.getItem('orbit_token');
  const sampleSec = document.getElementById('guide-sample-section');
  const loginBtn  = document.getElementById('guide-login-btn');
  if (sampleSec) sampleSec.style.display = isLoggedIn ? 'none' : '';
  if (loginBtn)  loginBtn.style.display  = isLoggedIn ? 'none' : '';
}
window.openGuidePopup = openGuidePopup;

// ══ 통계 팝업 ═══════════════════════════════════════════════════════════════
async function openStatsPopup() {
  const popup = document.getElementById('stats-popup');
  popup.style.display = 'flex';
  // 서버에서 통계 가져오기
  try {
    const r = await fetch('/api/analysis/summary');
    const data = r.ok ? await r.json() : null;
    if (data) {
      document.getElementById('sc-sessions').textContent = data.totalSessions ?? '-';
      document.getElementById('sc-events').textContent   = data.totalEvents   ?? '-';
      document.getElementById('sc-today').textContent    = data.todaySessions ?? '-';
      // 작업 유형 분포
      const dist = data.distribution || [];
      const maxV = Math.max(...dist.map(d => d.count), 1);
      document.getElementById('stats-bar-list').innerHTML = dist.slice(0, 6).map(d => `
        <div class="stat-bar-row">
          <div class="stat-bar-label">${d.type || '기타'}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${Math.round(d.count/maxV*100)}%;background:${d.color||'#1f6feb'}"></div></div>
          <div style="font-size:11px;color:#8b949e;width:30px;text-align:right">${d.count}</div>
        </div>`).join('');
      // 최근 세션
      const sess = data.recentSessions || [];
      document.getElementById('stats-recent-sessions').innerHTML = sess.slice(0, 5).map(s =>
        `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d">
          <span style="color:#cdd9e5">${s.label || s.title || '세션'}</span>
          <span style="color:#484f58;font-size:10px">${s.ago || ''}</span>
        </div>`).join('');
    }
  } catch (e) {
    // 로컬 데이터로 폴백
    const planets = _planets || [];
    document.getElementById('sc-sessions').textContent = planets.length;
    document.getElementById('sc-events').textContent   = _allNodes?.length || 0;
    document.getElementById('sc-today').textContent    = planets.filter(p => {
      const ts = p.userData?.lastTs;
      return ts && (Date.now() - ts) < 86400000;
    }).length;
    document.getElementById('stats-bar-list').innerHTML =
      '<div style="font-size:11px;color:#6e7681;padding:8px 0">로컬 데이터 기준 (서버 연결 필요)</div>';
    document.getElementById('stats-recent-sessions').innerHTML = planets.slice(0, 5).map(p =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #21262d">
        <span style="color:#cdd9e5">${p.userData?.intent || '세션'}</span>
        <span style="color:#58a6ff;font-size:10px">${p.userData?.satellites || 0}개 작업</span>
      </div>`).join('');
  }
}
window.openStatsPopup = openStatsPopup;

// ══ 워크스페이스 팝업 ════════════════════════════════════════════════════════
async function openWorkspacePopup() {
  if (!_orbitUser) { openLoginModal(); return; }
  const popup = document.getElementById('workspace-popup');
  popup.style.display = 'flex';
  document.getElementById('ws-create-result').style.display = 'none';
  await _loadMyWorkspaces();
}
window.openWorkspacePopup = openWorkspacePopup;

async function _loadMyWorkspaces() {
  const listEl = document.getElementById('ws-my-list');
  if (!listEl) return;
  const token = _orbitUser?.token || '';
  if (!token) { listEl.innerHTML = '<div style="font-size:12px;color:#6e7681">로그인이 필요합니다</div>'; return; }
  try {
    const res  = await fetch('/api/workspace/my', { headers: { Authorization: `Bearer ${token}` } });
    const rows = res.ok ? await res.json() : [];
    if (!rows.length) {
      listEl.innerHTML = '<div style="font-size:12px;color:#6e7681;padding:8px 0">참여한 워크스페이스가 없습니다.<br>아래에서 만들거나 초대코드로 참여하세요.</div>';
      return;
    }
    listEl.innerHTML = rows.map(ws => `
      <div class="ws-card" onclick="_selectWorkspace('${ws.id}','${(ws.name||'').replace(/'/g,"\\'")}')">
        <div class="ws-card-icon">${ws.role==='owner' ? '👑' : '👤'}</div>
        <div class="ws-card-info">
          <div class="ws-card-name">${escHtml(ws.name)}</div>
          <div class="ws-card-meta">${escHtml(ws.company_name||'')} · 멤버 ${ws.member_count||0}명</div>
          <div class="ws-card-role">${ws.role==='owner' ? '관리자' : '멤버 · '+escHtml(ws.team_name||'')}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <div style="font-size:11px;color:#3fb950;cursor:pointer" onclick="event.stopPropagation();_copyCode('${ws.invite_code||''}')">
            ${ws.invite_code ? `초대코드<br><b style="font-size:14px;letter-spacing:2px">${ws.invite_code}</b>` : ''}
          </div>
          ${(ws.role==='owner'||ws.role==='admin') ? `
            <button onclick="event.stopPropagation();generateInviteLink('${ws.id}')"
              style="font-size:10px;padding:4px 8px;background:rgba(88,166,255,.15);color:#58a6ff;border:1px solid rgba(88,166,255,.3);
              border-radius:6px;cursor:pointer;white-space:nowrap">초대 링크</button>
            <button onclick="event.stopPropagation();openWsMemberManage&&openWsMemberManage('${ws.id}')"
              style="font-size:10px;padding:4px 8px;background:rgba(63,185,80,.15);color:#3fb950;border:1px solid rgba(63,185,80,.3);
              border-radius:6px;cursor:pointer;white-space:nowrap">인원배분</button>
            <button onclick="event.stopPropagation();openWsPendingList&&openWsPendingList('${ws.id}')"
              style="font-size:10px;padding:4px 8px;background:rgba(255,166,87,.15);color:#ffa657;border:1px solid rgba(255,166,87,.3);
              border-radius:6px;cursor:pointer;white-space:nowrap">${ws.pending_count>0?'⚠️ ':''} 승인대기 ${ws.pending_count||0}</button>
          ` : ''}
        </div>
      </div>`).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="font-size:11px;color:#f85149">오류: ${e.message}</div>`;
  }
}

async function openWsPendingList(wsId) {
  const token = _orbitUser?.token || '';
  try {
    const res = await fetch(`/api/workspace/${wsId}/pending-members`, { headers: { Authorization: `Bearer ${token}` } });
    const list = res.ok ? await res.json() : [];
    if (!list.length) { showToast('승인 대기 중인 멤버가 없습니다'); return; }
    const html = list.map(m => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;border-bottom:1px solid #21262d">
        <div style="color:#e6edf3"><div>${escHtml(m.name || '사용자')}</div><div style="font-size:10px;color:#8b949e">${escHtml(m.email || m.userId || '')}</div></div>
        <div style="display:flex;gap:4px">
          <button onclick="this.disabled=true;_approveMember('${wsId}','${m.userId}')" style="font-size:10px;padding:3px 8px;background:#3fb950;color:#fff;border:none;border-radius:4px;cursor:pointer">승인</button>
          <button onclick="this.disabled=true;_rejectMember('${wsId}','${m.userId}')" style="font-size:10px;padding:3px 8px;background:#f85149;color:#fff;border:none;border-radius:4px;cursor:pointer">거절</button>
        </div>
      </div>`).join('');
    showToast(''); // clear
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `<div style="background:#0d1117;border:1px solid #30363d;border-radius:12px;padding:16px;width:320px;max-height:400px;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px"><b style="color:#e6edf3">승인 대기 (${list.length}명)</b><button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:16px">✕</button></div>
      ${html}</div>`;
    document.body.appendChild(modal);
  } catch (e) { showToast('오류: ' + e.message, 'error'); }
}
window.openWsPendingList = openWsPendingList;

async function _approveMember(wsId, userId) {
  const token = _orbitUser?.token || '';
  try {
    const res = await fetch(`/api/workspace/${wsId}/approve-member`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({userId}) });
    const data = await res.json();
    if (res.ok) {
      showToast('승인 완료');
    } else {
      showToast('승인 실패: ' + (data.error || '알 수 없는 오류'), 'error');
    }
  } catch (e) { showToast('승인 오류: ' + e.message, 'error'); }
  // 모달 닫기 + 목록 새로고침
  document.querySelector('div[style*="position:fixed"][style*="z-index:9999"]')?.remove();
  _loadMyWorkspaces();
}
window._approveMember = _approveMember;

async function _rejectMember(wsId, userId) {
  const token = _orbitUser?.token || '';
  try {
    const res = await fetch(`/api/workspace/${wsId}/reject-member`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`}, body:JSON.stringify({userId}) });
    const data = await res.json();
    if (res.ok) {
      showToast('거절 완료');
    } else {
      showToast('거절 실패: ' + (data.error || '알 수 없는 오류'), 'error');
    }
  } catch (e) { showToast('거절 오류: ' + e.message, 'error'); }
  document.querySelector('div[style*="position:fixed"][style*="z-index:9999"]')?.remove();
  _loadMyWorkspaces();
}
window._rejectMember = _rejectMember;

// ── 멤버 관리 (인원배분) 모달 ─────────────────────────────────────────────────
async function openWsMemberManage(wsId) {
  const token = _orbitUser?.token || '';
  if (!token) { showToast('로그인이 필요합니다'); return; }
  try {
    const res = await fetch(`/api/workspace/${wsId}/members`, { headers: { Authorization: `Bearer ${token}` } });
    const members = res.ok ? await res.json() : [];
    if (!members.length) { showToast('멤버가 없습니다'); return; }

    const html = members.map(m => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 8px;border-bottom:1px solid #21262d">
        <div style="flex:1">
          <div style="color:#e6edf3;font-size:13px">${escHtml(m.name || '사용자')}</div>
          <div style="color:#8b949e;font-size:10px">${escHtml(m.email || '')} ${m.status === 'pending' ? '<span style="color:#ffa657">(대기중)</span>' : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <select data-user-id="${m.userId}" data-ws-id="${wsId}" class="ws-team-select"
            style="font-size:11px;padding:3px 6px;background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:4px;cursor:pointer">
            <option value="관리팀" ${m.teamName==='관리팀'?'selected':''}>${escHtml('관리팀')}</option>
            <option value="개발팀" ${m.teamName==='개발팀'?'selected':''}>${escHtml('개발팀')}</option>
            <option value="디자인팀" ${m.teamName==='디자인팀'?'selected':''}>${escHtml('디자인팀')}</option>
            <option value="기획팀" ${m.teamName==='기획팀'?'selected':''}>${escHtml('기획팀')}</option>
            <option value="팀 1" ${m.teamName==='팀 1'?'selected':''}>${escHtml('팀 1')}</option>
            <option value="팀 2" ${m.teamName==='팀 2'?'selected':''}>${escHtml('팀 2')}</option>
            ${m.teamName && !['관리팀','개발팀','디자인팀','기획팀','팀 1','팀 2'].includes(m.teamName) ? `<option value="${escHtml(m.teamName)}" selected>${escHtml(m.teamName)}</option>` : ''}
          </select>
          <span style="font-size:10px;color:${m.role==='owner'?'#ffd700':m.role==='admin'?'#58a6ff':'#8b949e'}">${m.role==='owner'?'소유자':m.role==='admin'?'관리자':'멤버'}</span>
        </div>
      </div>`).join('');

    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `<div style="background:#0d1117;border:1px solid #30363d;border-radius:12px;padding:16px;width:380px;max-height:500px;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px">
        <b style="color:#e6edf3">인원 배분 (${members.length}명)</b>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:16px">&#10005;</button>
      </div>
      ${html}
      <div style="margin-top:12px;text-align:right">
        <button id="ws-member-save-btn" style="font-size:11px;padding:6px 14px;background:#238636;color:#fff;border:none;border-radius:6px;cursor:pointer">저장</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    // 저장 버튼: 변경된 팀 이름을 서버에 반영
    modal.querySelector('#ws-member-save-btn').addEventListener('click', async () => {
      const selects = modal.querySelectorAll('.ws-team-select');
      for (const sel of selects) {
        const uid = sel.dataset.userId;
        const wid = sel.dataset.wsId;
        const teamName = sel.value;
        try {
          await fetch('/api/workspace/member/team-admin', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ workspaceId: wid, userId: uid, teamName }),
          });
        } catch {}
      }
      showToast('팀 배분 저장됨');
      modal.remove();
      _loadMyWorkspaces();
    });
  } catch (e) { showToast('오류: ' + e.message, 'error'); }
}
window.openWsMemberManage = openWsMemberManage;

function _copyCode(code) {
  navigator.clipboard.writeText(code).then(() => showToast(`초대코드 복사됨: ${code}`)).catch(() => {});
}

function _selectWorkspace(id, name) {
  closePopup('workspace-popup');
  window._currentWorkspaceId = id;
  showToast(`'${name}' 워크스페이스 로딩 중...`);

  // multilevel 렌더러 대신 팀 뷰로 직접 전환 (레거시 카드 방지)
  if (window.RendererManager) {
    window.RendererManager.switchTo('team');
    if (window.RendererManager.cleanupMultilevel) window.RendererManager.cleanupMultilevel();
  } else {
    if (typeof clearMyWork === 'function') clearMyWork();
    if (typeof clearAllPlanets === 'function') clearAllPlanets();
    if (typeof exitTeamMode === 'function') exitTeamMode();
  }

  // 선택된 워크스페이스의 팀 뷰 로드
  if (typeof loadTeamDemo === 'function') {
    loadTeamDemo();
  }
}

async function joinWorkspacePopup() {
  const code     = (document.getElementById('ws-join-code')?.value || '').trim().toUpperCase();
  const teamName = (document.getElementById('ws-join-team')?.value || '').trim() || '팀 1';
  if (!code) { showToast('초대코드를 입력하세요'); return; }
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _orbitUser.token;
  try {
    const res  = await fetch('/api/workspace/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ inviteCode: code, teamName }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`✅ '${data.workspace?.name}' 참여 완료!`);
      document.getElementById('ws-join-code').value = '';
      document.getElementById('ws-join-team').value = '';
      await _loadMyWorkspaces();
    } else {
      showToast(`❌ ${data.error || '참여 실패'}`);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.joinWorkspacePopup = joinWorkspacePopup;

async function createWorkspacePopup() {
  const name    = (document.getElementById('ws-create-name')?.value || '').trim();
  const company = (document.getElementById('ws-create-company')?.value || '').trim();
  if (!name) { showToast('워크스페이스 이름을 입력하세요'); return; }
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _getToken();
  if (!token) { showToast('로그인이 필요합니다'); openLoginModal(); return; }
  try {
    const res  = await fetch('/api/workspace/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, companyName: company }),
    });
    const data = await res.json();
    if (res.ok) {
      const resultEl = document.getElementById('ws-create-result');
      document.getElementById('ws-invite-code-display').textContent = data.invite_code;
      resultEl.style.display = 'block';
      document.getElementById('ws-create-name').value = '';
      document.getElementById('ws-create-company').value = '';
      await _loadMyWorkspaces();
    } else {
      showToast(`❌ ${data.error || '생성 실패'}`);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.createWorkspacePopup = createWorkspacePopup;

function copyInviteCode() {
  const code = document.getElementById('ws-invite-code-display')?.textContent?.trim();
  if (!code || code === '----') return;
  navigator.clipboard.writeText(code).then(() => showToast(`초대코드 복사됨: ${code}`)).catch(() => {});
}
window.copyInviteCode = copyInviteCode;

// ── 만료형 초대 링크 생성 (admin/owner) ────────────────────────────────────
let _inviteLinkTimer = null;
async function generateInviteLink(workspaceId) {
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _getToken();
  if (!token) { showToast('로그인이 필요합니다'); return; }
  try {
    const res = await fetch(`/api/workspace/${workspaceId}/generate-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ minutes: 10, maxUses: 0 }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '초대 링크 생성 실패'); return; }

    // 초대 링크 모달 표시
    _showInviteLinkModal(data.link, data.code, data.expiresAt);
  } catch (e) {
    showToast('초대 링크 생성 오류: ' + e.message);
  }
}
window.generateInviteLink = generateInviteLink;

function _showInviteLinkModal(link, code, expiresAt) {
  // 기존 모달 제거
  let modal = document.getElementById('invite-link-modal');
  if (modal) modal.remove();
  if (_inviteLinkTimer) { clearInterval(_inviteLinkTimer); _inviteLinkTimer = null; }

  modal = document.createElement('div');
  modal.id = 'invite-link-modal';
  Object.assign(modal.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center',
    justifyContent: 'center', zIndex: '3000',
  });
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); if (_inviteLinkTimer) clearInterval(_inviteLinkTimer); } };

  const expiryDate = new Date(expiresAt);

  modal.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:16px;padding:32px;
                max-width:440px;width:90%;text-align:center;position:relative">
      <button onclick="document.getElementById('invite-link-modal').remove()"
        style="position:absolute;top:12px;right:16px;background:none;border:none;color:#8b949e;
        font-size:20px;cursor:pointer;line-height:1">x</button>
      <div style="font-size:24px;margin-bottom:8px">🔗</div>
      <div style="font-size:18px;font-weight:700;color:#f0f6fc;margin-bottom:4px">초대 링크 생성 완료</div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:16px">카카오톡, 슬랙 등으로 공유하세요</div>

      <div style="background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:14px;
                  margin-bottom:12px;word-break:break-all;font-size:13px;color:#58a6ff;
                  cursor:pointer;user-select:all" id="invite-link-text"
           onclick="_copyInviteLink()" title="클릭하여 복사">${link}</div>

      <div style="display:flex;gap:8px;justify-content:center;margin-bottom:16px">
        <button onclick="_copyInviteLink()"
          style="padding:8px 20px;background:#238636;color:#fff;border:none;border-radius:8px;
          font-size:13px;font-weight:600;cursor:pointer">복사</button>
        <button onclick="_shareInviteLink()"
          style="padding:8px 20px;background:rgba(88,166,255,.15);color:#58a6ff;border:1px solid rgba(88,166,255,.3);
          border-radius:8px;font-size:13px;cursor:pointer">공유</button>
      </div>

      <div style="font-size:14px;color:#f0883e;font-weight:600" id="invite-countdown">
        남은 시간: 10:00
      </div>
      <div style="font-size:11px;color:#6e7681;margin-top:4px">10분 후 자동 만료됩니다</div>
    </div>
  `;
  document.body.appendChild(modal);

  // 카운트다운
  const countdownEl = modal.querySelector('#invite-countdown');
  function updateInviteCountdown() {
    const remaining = expiryDate - new Date();
    if (remaining <= 0) {
      countdownEl.textContent = '만료됨';
      countdownEl.style.color = '#f85149';
      if (_inviteLinkTimer) clearInterval(_inviteLinkTimer);
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    countdownEl.textContent = `남은 시간: ${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
  }
  updateInviteCountdown();
  _inviteLinkTimer = setInterval(updateInviteCountdown, 1000);

  // 클립보드 복사 + 공유 함수를 전역에 노출
  window._currentInviteLink = link;
}

function _copyInviteLink() {
  const link = window._currentInviteLink;
  if (!link) return;
  navigator.clipboard.writeText(link)
    .then(() => showToast('초대 링크가 복사되었습니다'))
    .catch(() => {
      // 폴백: 수동 복사
      const el = document.getElementById('invite-link-text');
      if (el) { const range = document.createRange(); range.selectNodeContents(el); window.getSelection().removeAllRanges(); window.getSelection().addRange(range); }
      showToast('링크를 선택했습니다. Ctrl+C로 복사하세요');
    });
}
window._copyInviteLink = _copyInviteLink;

function _shareInviteLink() {
  const link = window._currentInviteLink;
  if (!link) return;
  if (navigator.share) {
    navigator.share({ title: 'Orbit AI 워크스페이스 초대', text: 'Orbit AI 워크스페이스에 참여하세요!', url: link })
      .catch(() => _copyInviteLink());
  } else {
    _copyInviteLink();
  }
}
window._shareInviteLink = _shareInviteLink;

// ══ DM 미읽음 폴링 ═══════════════════════════════════════════════════════════
let _dmUnreadCount = 0;
async function _pollUnreadDMs() {
  if (!_orbitUser) return;
  const token = _getToken();
  if (!token) return;
  try {
    const res = await fetch('/api/chat/rooms', { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { console.debug('[DM poll] token expired, skipping'); return; }
    if (!res.ok) return;
    const rooms = await res.json();
    if (!Array.isArray(rooms)) return;
    const total = rooms.reduce((s, r) => s + (r.unread || 0), 0);
    const btn   = document.getElementById('ln-messenger-btn');
    if (!btn) return;
    // 기존 배지 제거 후 새로 추가
    btn.querySelectorAll('.ln-badge').forEach(el => el.remove());
    if (total > 0) {
      const badge = document.createElement('span');
      badge.className = 'ln-badge';
      badge.textContent = total > 99 ? '99+' : total;
      btn.appendChild(badge);
      _dmUnreadCount = total;
    } else {
      _dmUnreadCount = 0;
    }
  } catch (_) {}
}

// 30초마다 폴링 (로그인 시 즉시 + 주기적으로)
setInterval(_pollUnreadDMs, 30000);

// ── 탭 전환 ──────────────────────────────────────────────────────────────────
function switchMsgTab(tab) {
  _msgTab = tab;
  _msgRoomId = null;
  ['dm','team','company'].forEach(t => {
    document.getElementById('mt-' + t)?.classList.toggle('active', t === tab);
  });
  resetChatView();
  loadMsgRooms(tab);
  toggleCreateModal(false);
}
window.switchMsgTab = switchMsgTab;

function resetChatView() {
  document.getElementById('msg-chat-name').textContent = '채팅방 선택';
  document.getElementById('msg-messages-area').innerHTML =
    '<div class="msg-empty-chat"><span style="font-size:28px">💬</span><span>채팅방을 선택하세요</span><span style="font-size:10px;color:#484f58">@orbit — AI에게 질문 가능</span></div>';
  document.getElementById('msg-input-wrap').style.display = 'none';
}

// ── 방 목록 로드 ─────────────────────────────────────────────────────────────
async function loadMsgRooms(tab) {
  const listEl = document.getElementById('msg-rooms-list');
  if (!listEl) return;
  listEl.innerHTML = '<div class="msg-empty-chat" style="font-size:11px">불러오는 중…</div>';
  const token = _msgToken();
  if (!token) return;
  try {
    const res   = await fetch('/api/chat/rooms', { headers: { Authorization: `Bearer ${token}` } });
    const rooms = await res.json();
    if (!Array.isArray(rooms)) { listEl.innerHTML = '<div class="msg-empty-chat" style="font-size:11px">오류</div>'; return; }

    const filtered = rooms.filter(r => r.type === tab || (tab === 'dm' && r.type === 'dm'));

    let html = '';
    if (tab !== 'dm') {
      html += `<button class="msg-new-room-btn" onclick="toggleCreateModal(true)">+ 채널 만들기</button>`;
    }
    if (filtered.length === 0) {
      html += `<div class="msg-empty-chat" style="font-size:10px;padding:10px">${tab === 'dm' ? '팔로잉한 사람에게<br>DM을 보내보세요' : '채널이 없습니다'}</div>`;
    } else {
      html += filtered.map(room => {
        const name    = room.type === 'dm' ? (room.peerName || room.id) : (room.name || room.id);
        const preview = room.last_msg ? room.last_msg.slice(0, 22) + (room.last_msg.length > 22 ? '…' : '') : '';
        const unread  = room.unread > 0 ? `<span class="msg-unread">${room.unread}</span>` : '';
        return `<div class="msg-room-item${room.id === _msgRoomId ? ' active' : ''}" onclick="openMsgRoom('${room.id}','${name.replace(/'/g,"\\'")}')">
          ${unread}
          <div class="msg-room-name">${name}</div>
          ${preview ? `<div class="msg-room-preview">${preview}</div>` : ''}
        </div>`;
      }).join('');
    }
    listEl.innerHTML = html;

    // DM 탭에서 팔로잉 목록도 표시 (방이 없는 사람들)
    if (tab === 'dm') appendFollowingDmList(listEl, filtered);
  } catch (e) {
    listEl.innerHTML = `<div class="msg-empty-chat" style="font-size:10px">불러오기 실패</div>`;
  }
}
window.loadMsgRooms = loadMsgRooms;

// ── 팔로잉 목록 → DM 시작 버튼 ──────────────────────────────────────────────
async function appendFollowingDmList(listEl, existingRooms) {
  const token = _msgToken();
  if (!token) return;
  try {
    const res  = await fetch('/api/follow/list', { headers: { Authorization: `Bearer ${token}` } });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) return;
    const existingPeers = new Set(existingRooms.map(r => r.peerName));
    const newOnes = list.filter(u => !existingPeers.has(u.name));
    if (newOnes.length === 0) return;
    const sep = document.createElement('div');
    sep.style.cssText = 'font-size:10px;color:#6e7681;padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.4px';
    sep.textContent = '팔로잉';
    listEl.appendChild(sep);
    newOnes.forEach(u => {
      const btn = document.createElement('div');
      btn.className = 'msg-room-item';
      btn.innerHTML = `<div class="msg-room-name">${u.name || '?'}</div><div class="msg-room-preview">${u.headline || ''}</div>`;
      btn.onclick = () => startDmWithUser(u.user_id, u.name);
      listEl.appendChild(btn);
    });
  } catch (_) {}
}

async function startDmWithUser(userId, name) {
  const token = _msgToken();
  if (!token) return;
  try {
    const res  = await fetch(`/api/chat/dm/${userId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (data.roomId) {
      loadMsgRooms('dm');
      openMsgRoom(data.roomId, data.peerName || name);
    }
  } catch (_) {}
}
window.startDmWithUser = startDmWithUser;

// ── 방 열기 + 메시지 로드 ────────────────────────────────────────────────────
async function openMsgRoom(roomId, name) {
  _msgRoomId   = roomId;
  _msgRoomName = name;

  document.querySelectorAll('.msg-room-item').forEach(el => el.classList.remove('active'));
  event?.currentTarget?.classList.add('active');

  document.getElementById('msg-chat-name').textContent = name;
  document.getElementById('msg-input-wrap').style.display = 'flex';
  document.getElementById('msg-messages-area').innerHTML =
    '<div class="msg-empty-chat" style="font-size:11px">불러오는 중…</div>';

  // WS 채팅 방 구독
  _subscribeWsChatRoom(roomId);

  // 메시지 로드
  const token = _msgToken();
  try {
    const res  = await fetch(`/api/chat/${roomId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
    const msgs = await res.json();
    renderMsgBubbles(Array.isArray(msgs) ? msgs : []);
    // 읽음 처리
    fetch(`/api/chat/${roomId}/read`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } }).catch(e => console.warn('[chat] 읽음 처리 실패:', e.message));
    // 방 목록 unread 배지 업데이트
    loadMsgRooms(_msgTab);
  } catch (_) {
    document.getElementById('msg-messages-area').innerHTML =
      '<div class="msg-empty-chat" style="font-size:11px">메시지를 불러올 수 없습니다</div>';
  }

  document.getElementById('msg-input')?.focus();
}
window.openMsgRoom = openMsgRoom;

// ── 버블 렌더링 ───────────────────────────────────────────────────────────────
function renderMsgBubbles(msgs) {
  const area = document.getElementById('msg-messages-area');
  if (!area) return;
  if (!msgs.length) {
    area.innerHTML = '<div class="msg-empty-chat"><span>대화를 시작해보세요</span><span style="font-size:10px;color:#484f58">@orbit 으로 AI에게 질문할 수 있어요</span></div>';
    return;
  }
  const myId = _orbitUser?.id || '';
  area.innerHTML = msgs.map(m => {
    const isMine = m.sender_id === myId;
    const isBot  = m.sender_id === 'orbit-bot' || m.type === 'ai';
    const cls    = isBot ? 'ai-bot' : isMine ? 'mine' : 'theirs';
    const time   = m.created_at ? new Date(m.created_at).toLocaleTimeString('ko', { hour:'2-digit', minute:'2-digit' }) : '';
    const metaHtml = !isMine ? `<div class="msg-meta">${m.sender_name || '?'}</div>` : '';
    return `${metaHtml}<div class="msg-bubble ${cls}">${escapeHtml(m.content)}<div class="msg-time">${time}</div></div>`;
  }).join('');
  area.scrollTop = area.scrollHeight;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ── 메시지 전송 ───────────────────────────────────────────────────────────────
async function sendChatMsg() {
  if (!_msgRoomId) return;
  const input   = document.getElementById('msg-input');
  const content = (input?.value || '').trim();
  if (!content) return;
  input.value = '';

  const token = _msgToken();
  if (!token) { openLoginModal(); return; }

  // 낙관적 UI: 즉시 버블 추가
  const area = document.getElementById('msg-messages-area');
  const tmpId = 'tmp_' + Date.now();
  const time  = new Date().toLocaleTimeString('ko', { hour:'2-digit', minute:'2-digit' });
  const tmpEl = document.createElement('div');
  tmpEl.id = tmpId;
  tmpEl.innerHTML = `<div class="msg-bubble mine" style="opacity:.6">${escapeHtml(content)}<div class="msg-time">${time}</div></div>`;
  // AI 로딩 표시
  let aiLoadingEl = null;
  if (content.includes('@orbit') || content.startsWith('/ai ')) {
    aiLoadingEl = document.createElement('div');
    aiLoadingEl.id = 'ai-loading-msg';
    aiLoadingEl.innerHTML = `<div class="msg-bubble ai-bot" style="opacity:.7">🤖 Orbit AI 응답 중…</div>`;
  }

  // 빈 상태 제거
  const empty = area.querySelector('.msg-empty-chat');
  if (empty) empty.remove();
  area.appendChild(tmpEl);
  if (aiLoadingEl) area.appendChild(aiLoadingEl);
  area.scrollTop = area.scrollHeight;

  try {
    const res  = await fetch(`/api/chat/${_msgRoomId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();

    if (res.status === 402) {
      // 한도 초과
      tmpEl.remove();
      if (aiLoadingEl) aiLoadingEl.remove();
      showApplyEffect('⚠️ ' + (data.message || '메시지 한도 초과'));
      document.getElementById('msg-quota-wrap').style.display = 'block';
      return;
    }

    // 낙관적 버블 실제 버블로 교체
    if (tmpEl && data.id) {
      tmpEl.querySelector('.msg-bubble')?.style.removeProperty('opacity');
    }
    loadMsgQuota();
  } catch (e) {
    tmpEl.querySelector('.msg-bubble')?.setAttribute('style', 'opacity:.4;text-decoration:line-through');
  }
}
window.sendChatMsg = sendChatMsg;

// ── 쿼터 로드 ─────────────────────────────────────────────────────────────────
async function loadMsgQuota() {
  const token = _msgToken();
  if (!token) return;
  try {
    const res   = await fetch('/api/chat/quota', { headers: { Authorization: `Bearer ${token}` } });
    const quota = await res.json();
    _msgQuota = quota;
    const wrapEl = document.getElementById('msg-quota-wrap');
    if (!wrapEl || quota.limit === null) return; // unlimited plan

    if (quota.percent >= 70) { // 70% 이상이면 표시
      wrapEl.style.display = 'block';
      document.getElementById('msg-quota-text').textContent = `${quota.count} / ${quota.limit}개 (${quota.percent}%)`;
      const fillEl = document.getElementById('msg-quota-fill');
      fillEl.style.width = quota.percent + '%';
      fillEl.classList.toggle('warn', quota.percent >= 90);
    }
  } catch (_) {}
}

// ── 채널 생성 모달 토글 ───────────────────────────────────────────────────────
function toggleCreateModal(show) {
  document.getElementById('msg-create-modal')?.classList.toggle('open', show);
  if (show) document.getElementById('msg-create-name')?.focus();
}
window.toggleCreateModal = toggleCreateModal;

async function createChatChannel() {
  const name  = document.getElementById('msg-create-name')?.value.trim();
  if (!name) return;
  const token = _msgToken();
  if (!token) return;
  try {
    const res  = await fetch('/api/chat/channel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: _msgTab }),
    });
    const data = await res.json();
    if (data.roomId) {
      toggleCreateModal(false);
      document.getElementById('msg-create-name').value = '';
      loadMsgRooms(_msgTab);
      showApplyEffect(`채널 생성: #${name}`);
    }
  } catch (_) {}
}
window.createChatChannel = createChatChannel;

// ── WebSocket 채팅 방 구독 (실시간 수신) ─────────────────────────────────────
// WS 채팅 핸들러가 이미 설치됐는지 추적 — 중복 등록 방지
let _wsChatHandlerInstalled = false;

function _subscribeWsChatRoom(roomId) {
  const ws = window._globalWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat.subscribe', roomId }));

  // 핸들러는 한 번만 설치 (방이 바뀌어도 _msgRoomId로 필터링)
  if (_wsChatHandlerInstalled) return;
  _wsChatHandlerInstalled = true;

  const origOnMsg = ws.onmessage;
  ws.onmessage = function(e) {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'chat_message' && msg.message?.room_id === _msgRoomId) {
        _appendIncomingMsg(msg.message);
      } else if (msg.type === 'chat_delete' && msg.room_id === _msgRoomId) {
        // 삭제 처리
      } else if (origOnMsg) origOnMsg.call(this, e);
    } catch (_) { if (origOnMsg) origOnMsg.call(this, e); }
  };
  // WS 재연결 시 플래그 초기화
  ws.addEventListener('close', () => { _wsChatHandlerInstalled = false; }, { once: true });
}

function _appendIncomingMsg(msg) {
  const area = document.getElementById('msg-messages-area');
  if (!area) return;
  const myId  = _orbitUser?.id || '';
  const isMine = msg.sender_id === myId;
  const isBot  = msg.sender_id === 'orbit-bot' || msg.type === 'ai';

  // 내가 보낸 메시지는 낙관적 UI로 이미 표시됨 → 중복 방지
  // 낙관적 버블의 opacity만 확정으로 변경
  if (isMine && !isBot) {
    const tmpBubbles = area.querySelectorAll('.msg-bubble.mine[style*="opacity"]');
    if (tmpBubbles.length > 0) {
      tmpBubbles[tmpBubbles.length - 1].style.removeProperty('opacity');
    }
    return;
  }

  const cls    = isBot ? 'ai-bot' : 'theirs';
  const time   = new Date(msg.created_at || Date.now()).toLocaleTimeString('ko', { hour:'2-digit', minute:'2-digit' });
  const metaHtml = `<div class="msg-meta">${msg.sender_name || '?'}</div>`;

  // AI 로딩 제거
  document.getElementById('ai-loading-msg')?.remove();
  // 빈 상태 제거
  area.querySelector('.msg-empty-chat')?.remove();

  const el = document.createElement('div');
  el.innerHTML = `${metaHtml}<div class="msg-bubble ${cls}">${escapeHtml(msg.content)}<div class="msg-time">${time}</div></div>`;
  area.appendChild(el);
  area.scrollTop = area.scrollHeight;
}

/* ── FOLLOW SYSTEM ───────────────────────────────────────────────────────────
 * 팔로우 / 언팔로우, 팔로잉 목록, 팔로워 목록
 * ─────────────────────────────────────────────────────────────────────────── */
let _followPanelTab = 'following'; // 'following' | 'followers'

// ── 토큰 통일 헬퍼 ──────────────────────────────────────────────────────────
function _getToken() {
  return _orbitUser?.token || localStorage.getItem('orbit_token') || '';
}

async function toggleFollow(userId, btn) {
  if (!_orbitUser) { openLoginModal(); return; }
  const token = _getToken();
  const isFollowing = btn.classList.contains('following');
  btn.disabled = true;
  try {
    const res  = await fetch(`/api/follow/${userId}`, {
      method: isFollowing ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.ok !== undefined) {
      btn.classList.toggle('following', data.following);
      btn.textContent = data.following ? '✓ 팔로잉' : '+ 팔로우';
    }
  } catch (e) {
    console.warn('[follow] error:', e.message);
  } finally {
    btn.disabled = false;
  }
}
window.toggleFollow = toggleFollow;

async function checkFollowStatus(userId, btn) {
  if (!_orbitUser) return;
  const token = _getToken();
  try {
    const res  = await fetch(`/api/follow/check/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    btn.classList.toggle('following', data.following);
    btn.textContent = data.following ? '✓ 팔로잉' : '+ 팔로우';
  } catch (_) {}
}
window.checkFollowStatus = checkFollowStatus;

function toggleFollowPanel() {
  closeAllRightPanels('follow-panel');
  const panel = document.getElementById('follow-panel');
  const isOpen = panel.classList.toggle('open');
  if (isOpen) loadFollowList(_followPanelTab);
}
window.toggleFollowPanel = toggleFollowPanel;

function switchFollowTab(tab) {
  _followPanelTab = tab;
  document.getElementById('fp-tab-ing').classList.toggle('active', tab === 'following');
  document.getElementById('fp-tab-ers').classList.toggle('active', tab === 'followers');
  loadFollowList(tab);
}
window.switchFollowTab = switchFollowTab;

async function loadFollowList(tab) {
  const listEl = document.getElementById('fp-list-area');
  if (!listEl) return;
  listEl.innerHTML = '<div class="fp-empty">불러오는 중…</div>';
  if (!_orbitUser) { listEl.innerHTML = '<div class="fp-empty">로그인 후 이용하세요</div>'; return; }
  const token = _getToken();
  const url   = tab === 'followers' ? '/api/follow/followers' : '/api/follow/list';
  try {
    const res  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      const emptyMsg = tab === 'followers'
        ? '팔로워가 없습니다<br><span style="font-size:10px;color:#484f58">위 검색창에서 사람을 찾아 팔로우하면<br>상대방도 팔로우할 수 있습니다</span>'
        : '팔로잉하는 사람이 없습니다<br><span style="font-size:10px;color:#484f58">위 검색창에서 이름·이메일로 검색하세요</span>';
      listEl.innerHTML = `<div class="fp-empty" style="line-height:1.7">${emptyMsg}</div>`;
      return;
    }
    listEl.innerHTML = list.map(u => `
      <div class="fp-user">
        <div class="fp-avatar">${u.avatar_url
          ? `<img src="${u.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`
          : (u.name || '?').charAt(0)}</div>
        <div class="fp-info">
          <div class="fp-name">${u.name || '익명'}</div>
          <div class="fp-sub">${u.headline || u.company || ''}</div>
        </div>
        <button onclick="fpStartDm('${u.user_id}','${(u.name||'').replace(/'/g,"\\'")}',event)"
          style="background:rgba(88,166,255,0.1);border:1px solid #1f6feb;color:#58a6ff;
                 border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;flex-shrink:0"
          title="DM 보내기">💬</button>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="fp-empty">불러오기 실패</div>';
  }
}
window.loadFollowList = loadFollowList;

// ── 팔로우 패널에서 DM 시작 ────────────────────────────────────────────────
async function fpStartDm(userId, name, e) {
  if (e) e.stopPropagation();
  if (!_orbitUser) { showToast('로그인이 필요합니다'); return; }
  // 메신저 열기 + DM 탭으로 이동
  const panel = document.getElementById('messenger-panel');
  if (!panel.classList.contains('open')) toggleMessenger();
  switchMsgTab('dm');
  // DM 방 생성 또는 기존 방 열기
  await startDmWithUser(userId, name);
  showToast(`💬 ${name}님과 DM 시작`);
}
window.fpStartDm = fpStartDm;

// ── 사용자 검색 (팔로우 패널) ─────────────────────────────────────────────
let _fpSearchTimer = null;
function fpSearchDebounce(q) {
  clearTimeout(_fpSearchTimer);
  const resultEl = document.getElementById('fp-search-results');
  if (!q.trim()) { resultEl.style.display = 'none'; return; }
  _fpSearchTimer = setTimeout(() => fpSearchUsers(q.trim()), 400);
}
window.fpSearchDebounce = fpSearchDebounce;

async function fpSearchUsers(q) {
  const resultEl = document.getElementById('fp-search-results');
  if (!_orbitUser) { resultEl.style.display = 'none'; return; }
  const token = _getToken();
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div style="font-size:11px;color:#9ca3af;padding:6px 0">검색 중…</div>';
  try {
    const res  = await fetch(`/api/follow/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const list = await res.json();
    if (!Array.isArray(list) || list.length === 0) {
      resultEl.innerHTML = '<div style="font-size:11px;color:#9ca3af;padding:6px 0">검색 결과 없음</div>';
      return;
    }
    resultEl.innerHTML = list.map(u => {
      const isGoogle = u.provider === 'google';
      const provBadge = isGoogle
        ? '<span style="font-size:9px;background:rgba(66,133,244,0.12);color:#4285f4;padding:1px 5px;border-radius:3px;margin-left:4px">G</span>'
        : '';
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #e5e7eb">
        <div style="width:28px;height:28px;border-radius:50%;background:${isGoogle?'#4285f4':'#2563eb'};display:flex;align-items:center;
                    justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">
          ${u.avatar_url ? `<img src="${u.avatar_url}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">` : (u.name||'?').charAt(0)}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:600;color:#1a1a2e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${u.name||'익명'}${provBadge}</div>
          <div style="font-size:10px;color:#6b7280">${u.email||u.headline||''}</div>
        </div>
        <button onclick="fpFollowUser('${u.id}','${(u.name||'').replace(/'/g,"\\'")}',this)"
          style="background:${u.is_following?'rgba(34,197,94,0.1)':'rgba(37,99,235,0.1)'};
                 border:1px solid ${u.is_following?'#22c55e':'#2563eb'};
                 color:${u.is_following?'#16a34a':'#2563eb'};
                 border-radius:6px;padding:2px 8px;font-size:10px;cursor:pointer;flex-shrink:0">
          ${u.is_following?'✓ 팔로잉':'+ 팔로우'}
        </button>
      </div>`;
    }).join('');
  } catch(e) {
    resultEl.innerHTML = '<div style="font-size:11px;color:#dc2626;padding:6px 0">검색 실패</div>';
  }
}
window.fpSearchUsers = fpSearchUsers;

// ── 팔로우/언팔로우 (검색 결과에서) ──────────────────────────────────────
async function fpFollowUser(userId, name, btn) {
  if (!_orbitUser) { showToast('로그인이 필요합니다'); return; }
  const token = _getToken();
  const isFollowing = btn.textContent.includes('팔로잉');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/follow/${userId}`, {
      method: isFollowing ? 'DELETE' : 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      if (isFollowing) {
        btn.textContent = '+ 팔로우';
        btn.style.borderColor = '#2563eb'; btn.style.color = '#2563eb';
        btn.style.background = 'rgba(37,99,235,0.1)';
        showToast(`${name}님 언팔로우`);
      } else {
        btn.textContent = '✓ 팔로잉';
        btn.style.borderColor = '#22c55e'; btn.style.color = '#16a34a';
        btn.style.background = 'rgba(34,197,94,0.1)';
        showToast(`✓ ${name}님 팔로우 완료!`);
        loadFollowList(_followPanelTab);
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error === 'invalid token' ? '로그인이 만료되었습니다. 다시 로그인해주세요' : '팔로우 실패');
      if (err.error === 'invalid token' || err.error === 'unauthorized') openLoginModal();
    }
  } catch(e) { showToast('오류 발생'); }
  btn.disabled = false;
}
window.fpFollowUser = fpFollowUser;

/* ── ORBIT ANALYTICS ─────────────────────────────────────────────────────────
 * 사용자 행동 데이터 수집 모듈
 * 수집 이벤트: auth / view / node / ai / session
 * 서버: POST /api/analytics/batch (2초 디바운스 배치 전송)
 * ─────────────────────────────────────────────────────────────────────────── */
(function setupOrbitAnalytics() {
  'use strict';
  const SESSION_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const _queue = [];
  let _flushTimer = null;

  function track(event, meta) {
    // 트래킹 거부 시 스킵
    if (localStorage.getItem('orbitTrackingAllowed') === '0') return;
    const user = (() => { try { return JSON.parse(localStorage.getItem('orbitUser') || 'null'); } catch(_) { return null; } })();
    _queue.push({
      event:      String(event).slice(0, 100),
      meta:       meta || null,
      user_id:    user ? (user.email || null) : null,
      session_id: SESSION_ID,
    });
    if (!_flushTimer) _flushTimer = setTimeout(flush, 2000);
  }
  window.track = track;

  function flush() {
    _flushTimer = null;
    if (!_queue.length) return;
    const batch = _queue.splice(0, 50);
    fetch('/api/analytics/batch', {
      method:    'POST',
      headers:   { 'Content-Type': 'application/json' },
      body:      JSON.stringify({ events: batch }),
      keepalive: true,
    }).catch(e => console.warn('[analytics] 배치 전송 실패:', e.message));
  }

  // 페이지 언로드 시 잔여 이벤트 즉시 전송
  window.addEventListener('beforeunload', flush);

  // ── SESSION START ────────────────────────────────────────────────────────
  track('session.start', { referrer: document.referrer.slice(0, 100) });

  // ── SESSION HEARTBEAT (60초마다) ─────────────────────────────────────────
  setInterval(() => {
    const mode = typeof _parallelMode !== 'undefined' && _parallelMode ? 'parallel'
               : typeof _companyMode  !== 'undefined' && _companyMode  ? 'company'
               : typeof _teamMode     !== 'undefined' && _teamMode     ? 'team'
               : 'personal';
    track('session.heartbeat', { mode });
  }, 60000);
})();

// ══════════════════════════════════════════════════════════════════════════════
// 구독 플랜 모달
// ══════════════════════════════════════════════════════════════════════════════
let _pricePeriod = 'monthly';

function openPricing() {
  const overlay = document.getElementById('pricing-overlay');
  overlay.classList.add('open');
  renderPricingGrid();
}
window.openPricing = openPricing;

function closePricing() {
  document.getElementById('pricing-overlay').classList.remove('open');
}
window.closePricing = closePricing;

function setPricePeriod(period, btn) {
  _pricePeriod = period;
  document.querySelectorAll('.pm-period-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPricingGrid();
}
window.setPricePeriod = setPricePeriod;

async function renderPricingGrid() {
  const grid = document.getElementById('pm-grid');
  if (!grid) return;
  let plans;
  try {
    const res = await fetch('/api/payment/plans');
    const data = await res.json();
    plans = data.plans || [];
  } catch {
    plans = [
      { id:'free', name:'Free', badge:'', priceLabel:'₩0', period:'', description:'개인 개발자를 위한 무료 플랜',
        features:['개인 작업 추적','기본 3D 마인드맵','5개 세션 히스토리','기본 이펙트 2개','커뮤니티 지원'], cta:'현재 플랜', popular:false, price:0 },
      { id:'pro', name:'Pro', badge:'POPULAR', priceLabel:'₩9,900', period:'/월', description:'파워 유저를 위한 프로 플랜',
        features:['Free의 모든 기능','무제한 세션 히스토리','팀 대시보드 (10명)','AI 인사이트 분석','Shadow AI 감지','감사 로그','컨텍스트 브릿지','모든 이펙트 + 스킨','테마 마켓 판매 가능','이메일 지원'], cta:'프로 시작하기', popular:true, price:9900 },
      { id:'team', name:'Team', badge:'', priceLabel:'₩29,900', period:'/월/멤버', description:'팀 협업을 위한 비즈니스 플랜',
        features:['Pro의 모든 기능','무제한 채널 & 멤버','실시간 팀 협업','부서별 대시보드','관리자 뷰','PR 자동 태그','PDF 감사 리포트','작업 충돌 감지','팀 인사이트 분석','우선 지원 (SLA 24h)'], cta:'팀 시작하기', popular:false, price:29900 },
      { id:'enterprise', name:'Enterprise', badge:'', priceLabel:'문의', period:'', description:'대규모 조직을 위한 엔터프라이즈',
        features:['Team의 모든 기능','온프레미스 배포 지원','SSO / SAML 인증','커스텀 AI 모델 연동','전용 인프라 격리','SLA 99.9% 보장','전담 매니저 배정','API 무제한 호출','보안 감사 인증서','맞춤 교육 & 온보딩'], cta:'영업팀 문의', popular:false, price:-1 },
    ];
  }

  grid.innerHTML = plans.map(p => {
    const yearly = _pricePeriod === 'yearly';
    let priceLabel = p.priceLabel || '₩0';
    let period = p.period || '';
    if (yearly && p.price > 0) {
      const yp = Math.round(p.price * 12 * 0.8);
      priceLabel = '₩' + yp.toLocaleString();
      period = '/년' + (p.period?.includes('멤버') ? '/멤버' : '');
    }
    return `
      <div class="pm-card${p.popular ? ' popular' : ''}">
        ${p.badge ? `<div class="pm-badge">${p.badge}</div>` : ''}
        <div class="pm-plan-name">${p.name}</div>
        <div class="pm-plan-desc">${p.description || ''}</div>
        <div class="pm-price">
          <span class="pm-price-amount">${priceLabel}</span>
          <span class="pm-price-period">${period}</span>
        </div>
        <ul class="pm-features">
          ${(p.features || []).map(f => `<li>${f}</li>`).join('')}
        </ul>
        <button class="pm-cta" onclick="selectPlan('${p.id}')">${p.cta || '선택'}</button>
      </div>
    `;
  }).join('');
}

// ── Toss Payments 결제 위젯 상태 ──────────────────────────────────────────────
let _tossWidgets = null;     // TossPayments 위젯 인스턴스
let _tossPendingOrder = null; // { planId, orderId, amount, userId }

async function selectPlan(planId) {
  if (planId === 'free') { closePricing(); return; }
  if (planId === 'enterprise') { alert('enterprise@orbit-ai.dev 로 문의해주세요.'); return; }
  if (!_orbitUser) { openLoginModal(); return; }

  try {
    const userId = _orbitUser.id || 'local';
    const token = _orbitUser.token || localStorage.getItem('orbit_token') || '';

    // 1단계: 결제 요청 생성
    const res = await fetch('/api/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ planId, userId, userEmail: _orbitUser.email || '' })
    });
    const result = await res.json();
    if (result.error) { alert(result.error); return; }

    _tossPendingOrder = { planId, orderId: result.orderId, amount: result.amount, userId };

    if (result.mock) {
      // ── MOCK 모드: Toss 위젯 없이 결제 확인 UI 표시 ──────────────────
      _showMockPaymentUI(planId, result);
    } else if (result.clientKey) {
      // ── 실결제: Toss Payment Widget 렌더링 ────────────────────────────
      await _showTossPaymentWidget(result);
    }
  } catch (e) {
    alert('결제 오류: ' + e.message);
  }
}
window.selectPlan = selectPlan;

// ── MOCK 모드 결제 UI (테스트 결제 확인 화면) ─────────────────────────────────
function _showMockPaymentUI(planId, result) {
  const grid = document.getElementById('pm-grid');
  const area = document.getElementById('toss-payment-area');
  const widget = document.getElementById('toss-payment-widget');
  const agreeWidget = document.getElementById('toss-agreement-widget');
  const payBtn = document.getElementById('toss-pay-btn');

  grid.style.display = 'none';
  area.style.display = 'block';
  document.getElementById('toss-plan-label').textContent = `${planId.toUpperCase()} 플랜 · 테스트 결제`;

  // 결제 확인 카드 (mock)
  widget.innerHTML = `
    <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:12px;padding:20px;text-align:center">
      <div style="font-size:24px;margin-bottom:8px">🧪</div>
      <div style="font-size:14px;font-weight:600;color:#92400e;margin-bottom:8px">테스트 결제 모드</div>
      <div style="font-size:12px;color:#a16207;line-height:1.6">
        현재 PG사 연동 전 테스트 모드입니다.<br>
        실제 결제는 발생하지 않습니다.
      </div>
      <div style="margin-top:16px;padding:12px;background:rgba(255,255,255,0.7);border-radius:8px">
        <div style="font-size:20px;font-weight:700;color:#1a1a2e">₩${(result.amount || 0).toLocaleString()}<span style="font-size:12px;color:#6b7280">/월</span></div>
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">주문번호: ${result.orderId}</div>
      </div>
    </div>
  `;
  agreeWidget.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#374151;cursor:pointer">
      <input type="checkbox" id="mock-agree-chk" checked>
      테스트 결제에 동의합니다 (실제 청구 없음)
    </label>
  `;
  payBtn.textContent = '🧪 테스트 결제 진행';
  payBtn.onclick = () => executeMockPayment(planId);
}

async function executeMockPayment(planId) {
  const order = _tossPendingOrder;
  if (!order) return;
  const token = _orbitUser?.token || localStorage.getItem('orbit_token') || '';
  try {
    const confirmRes = await fetch('/api/payment/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        paymentKey: 'mock-key-' + Date.now(),
        orderId: order.orderId,
        amount: order.amount,
        userId: order.userId,
        planId: order.planId,
      })
    });
    const confirmResult = await confirmRes.json();
    if (confirmResult.success) {
      if (_orbitUser) {
        _orbitUser.plan = planId;
        localStorage.setItem('orbitUser', JSON.stringify(_orbitUser));
      }
      closeTossPayment();
      closePricing();
      showToast(`${planId.toUpperCase()} 플랜으로 업그레이드 되었습니다! (테스트)`);
    } else {
      alert('결제 승인 실패: ' + (confirmResult.error || '알 수 없는 오류'));
    }
  } catch (e) { alert('결제 오류: ' + e.message); }
}

// ── 실결제: Toss Payment Widget 렌더링 ────────────────────────────────────────
async function _showTossPaymentWidget(result) {
  const grid = document.getElementById('pm-grid');
  const area = document.getElementById('toss-payment-area');
  const payBtn = document.getElementById('toss-pay-btn');

  grid.style.display = 'none';
  area.style.display = 'block';
  document.getElementById('toss-plan-label').textContent = `${result.planId?.toUpperCase() || ''} 플랜 결제`;

  try {
    // Toss Payments v2 SDK 초기화
    const tossPayments = TossPayments(result.clientKey);
    _tossWidgets = tossPayments.widgets({ customerKey: result.customerKey || result.userId || 'guest' });

    // 결제 금액 설정
    await _tossWidgets.setAmount({ currency: 'KRW', value: result.amount });

    // 결제 수단 위젯 렌더링
    await _tossWidgets.renderPaymentMethods({
      selector: '#toss-payment-widget',
      variantKey: 'DEFAULT',
    });

    // 약관 동의 위젯 렌더링
    await _tossWidgets.renderAgreement({
      selector: '#toss-agreement-widget',
      variantKey: 'AGREEMENT',
    });

    payBtn.textContent = `₩${result.amount.toLocaleString()} 결제하기`;
    payBtn.onclick = executeTossPayment;
  } catch (e) {
    document.getElementById('toss-payment-widget').innerHTML =
      `<div style="padding:20px;text-align:center;color:#dc2626">결제 위젯 로드 실패: ${e.message}</div>`;
  }
}

async function executeTossPayment() {
  if (!_tossWidgets || !_tossPendingOrder) return;
  const order = _tossPendingOrder;
  try {
    // Toss SDK가 결제창을 열고, 성공 시 successUrl로 리다이렉트
    await _tossWidgets.requestPayment({
      orderId: order.orderId,
      orderName: `Orbit ${order.planId.toUpperCase()} 월정액`,
      successUrl: `${window.location.origin}/api/payment/toss-success?planId=${order.planId}&userId=${order.userId}`,
      failUrl: `${window.location.origin}/orbit3d.html?paymentFail=true`,
    });
  } catch (e) {
    if (e.code === 'USER_CANCEL') {
      showToast('결제가 취소되었습니다');
    } else {
      alert('결제 실패: ' + (e.message || e.code));
    }
  }
}
window.executeTossPayment = executeTossPayment;

function closeTossPayment() {
  document.getElementById('toss-payment-area').style.display = 'none';
  document.getElementById('pm-grid').style.display = '';
  document.getElementById('toss-payment-widget').innerHTML = '';
  document.getElementById('toss-agreement-widget').innerHTML = '';
  _tossWidgets = null;
  _tossPendingOrder = null;
}
window.closeTossPayment = closeTossPayment;

// ══════════════════════════════════════════════════════════════════════════════
// 바탕화면 윈도우 시스템 — 3D 마인드맵 위에서 다중 창 열기/닫기
// ══════════════════════════════════════════════════════════════════════════════
const _openWindows = new Map(); // windowId → { el, data, minimized }
let _windowZIndex = 260;
let _taskbarVisible = false;

// 아이콘 매핑 (AI 도구 / 웹 사이트)
const TOOL_ICONS = {
  'chatgpt': '🤖', 'claude': '⬡', 'gemini': '✦', 'copilot': '🧑‍✈️',
  'cursor': '📝', 'windsurf': '🏄', 'perplexity': '🔍', 'midjourney': '🎨',
  'github': '🐙', 'vscode': '💻', 'terminal': '⌨️', 'browser': '🌐',
  'default': '📄',
};

function getToolIcon(source) {
  if (!source) return TOOL_ICONS.default;
  const s = source.toLowerCase();
  for (const [key, icon] of Object.entries(TOOL_ICONS)) {
    if (s.includes(key)) return icon;
  }
  return TOOL_ICONS.default;
}

function showTaskbar() {
  if (_taskbarVisible) return;
  _taskbarVisible = true;
  document.getElementById('desktop-taskbar').classList.add('active');
  // 통합 패널 버튼 위치 조정
  const ucBtn = document.getElementById('unified-ctrl-btn');
  if (ucBtn) ucBtn.style.bottom = '56px';
  // 시계 업데이트
  updateTaskbarClock();
  setInterval(updateTaskbarClock, 30000);
}

function updateTaskbarClock() {
  const el = document.getElementById('taskbar-clock');
  if (!el) return;
  const now = new Date();
  el.textContent = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
}

function openDesktopWindow(data) {
  const id = data.windowId || 'win-' + Date.now();
  if (_openWindows.has(id)) {
    // 이미 열린 창 → 포커스 + 복원
    const win = _openWindows.get(id);
    win.minimized = false;
    win.el.classList.remove('minimized');
    focusWindow(id);
    updateTaskbarItems();
    return id;
  }

  showTaskbar();

  const icon = getToolIcon(data.source || data.type || '');
  const title = data.title || data.label || data.intent || 'Window';

  // 새 창 위치 계산 (cascade)
  const offset = _openWindows.size * 30;
  const left = 100 + offset;
  const top = 60 + offset;

  const win = document.createElement('div');
  win.className = 'dw-window focused';
  win.id = id;
  win.style.cssText = `left:${left}px;top:${top}px;width:${data.width||480}px;height:${data.height||360}px;z-index:${++_windowZIndex}`;

  // 타이틀바
  const titlebar = document.createElement('div');
  titlebar.className = 'dw-titlebar';
  titlebar.innerHTML = `
    <span class="dw-title-icon">${icon}</span>
    <span class="dw-title-text">${escapeHtml(title)}</span>
    <button class="dw-btn" onclick="minimizeWindow('${id}')" title="최소화">─</button>
    <button class="dw-btn close" onclick="closeDesktopWindow('${id}')" title="닫기">✕</button>
  `;

  // 드래그 가능
  makeDraggable(win, titlebar);

  // 본문
  const body = document.createElement('div');
  body.className = 'dw-body';

  if (data.url) {
    body.innerHTML = `<iframe src="${escapeHtml(data.url)}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>`;
    body.style.padding = '0';
  } else {
    body.innerHTML = buildWindowContent(data);
  }

  // 상태바
  const status = document.createElement('div');
  status.className = 'dw-status';
  const dotColor = data.active ? '#3fb950' : '#6e7681';
  status.innerHTML = `<div class="dw-status-dot" style="background:${dotColor}"></div>
    <span>${data.source || data.type || 'orbit'}</span>
    <span style="margin-left:auto">${data.timestamp ? relativeTime(data.timestamp) : ''}</span>`;

  win.appendChild(titlebar);
  win.appendChild(body);
  win.appendChild(status);

  // 클릭 시 포커스
  win.addEventListener('mousedown', () => focusWindow(id));

  document.getElementById('desktop-windows').appendChild(win);

  _openWindows.set(id, { el: win, data, minimized: false });
  updateTaskbarItems();
  return id;
}
window.openDesktopWindow = openDesktopWindow;

function buildWindowContent(data) {
  if (data.type === 'session') {
    const ctx = typeof _sessionContextCache !== 'undefined' ? _sessionContextCache[data.sessionId] : null;
    return `
      <div style="padding:4px">
        <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.intent || '작업 세션'}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
          <span style="color:#6e7681">세션</span><span>${data.sessionId?.slice(-8) || '-'}</span>
          <span style="color:#6e7681">작업수</span><span>${data.eventCount || 0}개</span>
          <span style="color:#6e7681">프로젝트</span><span>${ctx?.projectName || '-'}</span>
        </div>
        ${ctx?.firstMsg ? `<div style="margin-top:12px;padding:8px;background:#161b22;border-radius:8px;font-size:11px;color:#8b949e">${ctx.firstMsg.slice(0,300)}</div>` : ''}
      </div>
    `;
  }
  if (data.type === 'file') {
    return `
      <div style="padding:4px">
        <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.filename || data.fileLabel || '파일'}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
          <span style="color:#6e7681">접근</span><span>${data.count || 1}회</span>
          <span style="color:#6e7681">역할</span><span>${data.isWrite ? '✏️ 수정' : '📄 읽기'}</span>
        </div>
      </div>
    `;
  }
  if (data.type === 'ai_tool' || data.site) {
    return `
      <div style="padding:4px">
        <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.title || data.site || 'AI Tool'}</div>
        <div style="font-size:12px;color:#8b949e;margin-bottom:8px">${data.url || ''}</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px">
          <span style="color:#6e7681">소스</span><span>${data.site || data.source || '-'}</span>
          <span style="color:#6e7681">메시지</span><span>${data.msgCount || data.msg_count || '-'}개</span>
        </div>
      </div>
    `;
  }
  // 기본
  return `
    <div style="padding:4px">
      <div style="font-size:14px;font-weight:700;color:#e6edf3;margin-bottom:8px">${data.label || data.title || 'Window'}</div>
      <pre style="font-size:11px;color:#8b949e;white-space:pre-wrap;word-break:break-all">${JSON.stringify(data, null, 2).slice(0, 1000)}</pre>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return '방금';
  if (diff < 3600000) return Math.floor(diff/60000) + '분 전';
  if (diff < 86400000) return Math.floor(diff/3600000) + '시간 전';
  return Math.floor(diff/86400000) + '일 전';
}

function focusWindow(id) {
  document.querySelectorAll('.dw-window').forEach(w => w.classList.remove('focused'));
  const win = _openWindows.get(id);
  if (!win) return;
  win.el.style.zIndex = ++_windowZIndex;
  win.el.classList.add('focused');
  updateTaskbarItems();
}
window.focusWindow = focusWindow;

function minimizeWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  win.minimized = true;
  win.el.classList.add('minimized');
  updateTaskbarItems();
}
window.minimizeWindow = minimizeWindow;

function restoreWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  if (win.minimized) {
    win.minimized = false;
    win.el.classList.remove('minimized');
  }
  focusWindow(id);
  updateTaskbarItems();
}
window.restoreWindow = restoreWindow;

function closeDesktopWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  win.el.remove();
  _openWindows.delete(id);
  updateTaskbarItems();
  if (_openWindows.size === 0) {
    _taskbarVisible = false;
    document.getElementById('desktop-taskbar').classList.remove('active');
    const ucBtn = document.getElementById('unified-ctrl-btn');
    if (ucBtn) ucBtn.style.bottom = '16px';
  }
}
window.closeDesktopWindow = closeDesktopWindow;

function toggleDesktopWindow(id) {
  const win = _openWindows.get(id);
  if (!win) return;
  if (win.minimized) {
    restoreWindow(id);
  } else if (win.el.classList.contains('focused')) {
    minimizeWindow(id);
  } else {
    focusWindow(id);
  }
}

function updateTaskbarItems() {
  const container = document.getElementById('taskbar-items');
  if (!container) return;
  container.innerHTML = '';
  for (const [id, win] of _openWindows) {
    const icon = getToolIcon(win.data.source || win.data.type || '');
    const label = win.data.title || win.data.label || win.data.intent || 'Window';
    const isFocused = win.el.classList.contains('focused') && !win.minimized;
    const item = document.createElement('div');
    item.className = 'tb-item' + (isFocused ? ' active' : '');
    item.innerHTML = `
      <span class="tb-item-icon">${icon}</span>
      <span class="tb-item-label">${escapeHtml(label)}</span>
      <button class="tb-item-close" onclick="event.stopPropagation();closeDesktopWindow('${id}')">✕</button>
    `;
    item.onclick = () => toggleDesktopWindow(id);
    container.appendChild(item);
  }
}

function makeDraggable(el, handle) {
  let startX, startY, origX, origY;
  handle.addEventListener('mousedown', e => {
    if (e.target.tagName === 'BUTTON') return;
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
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// 성장 엔진 — 스트릭, 레벨업, 뱃지 시스템
// ══════════════════════════════════════════════════════════════════════════════

const _GROWTH_KEY = 'orbitGrowthData';
const _growthData = JSON.parse(localStorage.getItem(_GROWTH_KEY) || 'null') || {
  xp: 0, level: 1, streak: 0,
  lastActiveDate: null,
  badges: [],
  history: [],
};

function saveGrowthData() {
  localStorage.setItem(_GROWTH_KEY, JSON.stringify(_growthData));
}

// XP 요구량 계산 (레벨 * 100)
function xpForLevel(lvl) { return lvl * 100; }

// XP 추가
function addXP(amount, reason) {
  _growthData.xp += amount;
  _growthData.history.unshift({ text: `+${amount} XP — ${reason}`, ts: Date.now() });
  if (_growthData.history.length > 50) _growthData.history.length = 50;

  // 레벨업 체크
  while (_growthData.xp >= xpForLevel(_growthData.level)) {
    _growthData.xp -= xpForLevel(_growthData.level);
    _growthData.level++;
    _growthData.history.unshift({ text: `🎉 Level ${_growthData.level} 달성!`, ts: Date.now() });
    checkBadge('level10', _growthData.level >= 10);
  }

  saveGrowthData();
  renderGrowthPanel();
}

// 스트릭 업데이트 (매일 첫 작업 시 호출)
function updateStreak() {
  const today = new Date().toDateString();
  if (_growthData.lastActiveDate === today) return; // 이미 오늘 업데이트됨

  const yesterday = new Date(Date.now() - 86400000).toDateString();
  if (_growthData.lastActiveDate === yesterday) {
    _growthData.streak++;
  } else if (_growthData.lastActiveDate !== today) {
    _growthData.streak = 1; // 리셋
  }

  _growthData.lastActiveDate = today;
  addXP(10, '일일 로그인');

  // 스트릭 뱃지 체크
  checkBadge('streak3',  _growthData.streak >= 3);
  checkBadge('streak7',  _growthData.streak >= 7);
  checkBadge('streak30', _growthData.streak >= 30);

  saveGrowthData();
  renderGrowthPanel();
}

// 뱃지 체크 & 부여
const BADGE_DEFS = [
  { id:'firstWork',   label:'🌱 첫 작업',     condition:'first_work' },
  { id:'streak3',     label:'🔥 3일 연속',     condition:'streak3' },
  { id:'streak7',     label:'⚡ 7일 연속',     condition:'streak7' },
  { id:'streak30',    label:'🏆 30일 연속',    condition:'streak30' },
  { id:'files100',    label:'💯 100개 파일',   condition:'files100' },
  { id:'aiChat50',    label:'🤖 AI 대화 50회', condition:'aiChat50' },
  { id:'teamSim',     label:'👥 팀 시뮬 참여',  condition:'teamSim' },
  { id:'level10',     label:'🌟 레벨 10',      condition:'level10' },
];

function checkBadge(id, condition) {
  if (!condition) return;
  if (_growthData.badges.includes(id)) return;
  _growthData.badges.push(id);
  _growthData.history.unshift({ text: `🏅 뱃지 획득: ${BADGE_DEFS.find(b => b.id === id)?.label || id}`, ts: Date.now() });
  saveGrowthData();
  if (typeof showToast === 'function') showToast(`🏅 뱃지 획득!`, 3000);
}

// 이벤트 훅: 파일 작업 시 XP
function onFileEvent(isWrite) {
  addXP(isWrite ? 5 : 2, isWrite ? '파일 수정' : '파일 읽기');
  checkBadge('firstWork', true);
}
window.onFileEvent = onFileEvent;

// 이벤트 훅: AI 대화 시 XP
function onAIConversation() {
  addXP(8, 'AI 대화');
}
window.onAIConversation = onAIConversation;

// 이벤트 훅: 팀 시뮬 참여 시
function onTeamSimJoin() {
  checkBadge('teamSim', true);
  addXP(15, '팀 시뮬 참여');
}
window.onTeamSimJoin = onTeamSimJoin;

// ─── 성장 패널 렌더링 ────────────────────────────
function renderGrowthPanel() {
  const lvEl = document.getElementById('gp-level');
  const lvnEl = document.getElementById('gp-level-num');
  const xpEl = document.getElementById('gp-xp');
  const xpmEl = document.getElementById('gp-xp-max');
  const xpfEl = document.getElementById('gp-xp-fill');
  const skEl = document.getElementById('gp-streak');
  const shEl = document.getElementById('gp-streak-hint');
  const bdEl = document.getElementById('gp-badges');
  const hiEl = document.getElementById('gp-history');

  if (lvEl) lvEl.textContent = _growthData.level;
  if (lvnEl) lvnEl.textContent = _growthData.level;
  if (xpEl) xpEl.textContent = _growthData.xp;
  const maxXP = xpForLevel(_growthData.level);
  if (xpmEl) xpmEl.textContent = maxXP;
  if (xpfEl) xpfEl.style.width = Math.min(100, Math.round((_growthData.xp / maxXP) * 100)) + '%';
  if (skEl) skEl.textContent = _growthData.streak;
  if (shEl) {
    const today = new Date().toDateString();
    shEl.textContent = _growthData.lastActiveDate === today ? '오늘 활동 완료!' : '오늘 작업을 시작하세요!';
  }

  // Badges
  if (bdEl) {
    bdEl.innerHTML = BADGE_DEFS.map(b => {
      const earned = _growthData.badges.includes(b.id);
      return `<div class="gp-badge ${earned ? 'earned' : 'locked'}">${b.label}</div>`;
    }).join('');
  }

  // History
  if (hiEl) {
    const items = _growthData.history.slice(0, 10);
    if (items.length === 0) {
      hiEl.innerHTML = '<div style="color:#6e7681;font-size:11px;text-align:center;padding:10px">아직 활동이 없습니다</div>';
    } else {
      hiEl.innerHTML = items.map(h => {
        const ago = formatGrowthTimeAgo(h.ts);
        return `<div style="display:flex;justify-content:space-between;font-size:11px;padding:3px 0;border-bottom:1px solid #161b22"><span style="color:#cdd9e5">${h.text}</span><span style="color:#6e7681;flex-shrink:0;margin-left:8px">${ago}</span></div>`;
      }).join('');
    }
  }
}

function formatGrowthTimeAgo(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return '방금';
  if (sec < 3600) return Math.floor(sec / 60) + '분 전';
  if (sec < 86400) return Math.floor(sec / 3600) + '시간 전';
  return Math.floor(sec / 86400) + '일 전';
}

function toggleGrowthPanel() {
  const panel = document.getElementById('growth-panel');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  if (isOpen) renderGrowthPanel();
}
window.toggleGrowthPanel = toggleGrowthPanel;

// 초기 스트릭 체크
document.addEventListener('DOMContentLoaded', () => {
  updateStreak();
  renderGrowthPanel();
});

// ── 숨김 노드 리스트 패널 ──────────────────────────────────────────────────
function openHiddenNodePanel() {
  let panel = document.getElementById('hidden-node-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'hidden-node-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '2000', background: '#0d1117', border: '1px solid rgba(99,102,241,0.4)',
      borderRadius: '16px', padding: '24px', width: '360px', maxHeight: '480px',
      overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.7)', color: '#e2e8f0',
    });
    document.body.appendChild(panel);
  }

  const hidden = typeof window.getHiddenNodeList === 'function' ? window.getHiddenNodeList() : [];
  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <span style="font-weight:700;font-size:15px">🙈 숨긴 노드 (${hidden.length})</span>
      <button onclick="document.getElementById('hidden-node-panel').remove()"
        style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1">×</button>
    </div>
    ${hidden.length === 0
      ? '<p style="color:#64748b;text-align:center;padding:20px 0">숨긴 노드가 없습니다</p>'
      : hidden.map(n => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;
          margin-bottom:8px;background:rgba(255,255,255,0.04);border-radius:10px;border:1px solid rgba(255,255,255,0.06)">
          <span style="font-size:13px;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px">${escHtml(n.label)}</span>
          <button onclick="window.unhideNode('${escHtml(n.key)}');openHiddenNodePanel()" style="
            background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.4);color:#a5b4fc;
            border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;flex-shrink:0;margin-left:8px">
            복원
          </button>
        </div>`).join('')}
  `;
}
window.openHiddenNodePanel = openHiddenNodePanel;

// ── 프로젝트 표시 토글 패널 ──────────────────────────────────────────────────
function openProjectTogglePanel() {
  let panel = document.getElementById('project-toggle-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'project-toggle-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '2000', background: '#0d1117', border: '1px solid rgba(99,102,241,0.4)',
      borderRadius: '16px', padding: '24px', width: '380px', maxHeight: '520px',
      overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.7)', color: '#e2e8f0',
    });
    document.body.appendChild(panel);
  }

  const groups = window._projectGroups || {};
  const hidden = window._hiddenNodes || {};
  const allProjects = Object.keys(groups).filter(name => {
    const grp = groups[name];
    const planets = grp.planetMeshes || [];
    return planets.reduce((s, p) => s + (p.userData.eventCount || 0), 0) > 0;
  }).sort();

  const visibleCount = allProjects.filter(n => !hidden[n]).length;
  const hiddenCount = allProjects.length - visibleCount;

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <span style="font-weight:700;font-size:15px">📍 프로젝트 표시 (${visibleCount}/${allProjects.length})</span>
      <button onclick="document.getElementById('project-toggle-panel').remove()"
        style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1">×</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button onclick="_projToggleAll(true)" style="
        flex:1;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);color:#4ade80;
        border-radius:8px;padding:6px 0;font-size:12px;cursor:pointer">✓ 모두 표시</button>
      <button onclick="_projToggleAll(false)" style="
        flex:1;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);color:#f87171;
        border-radius:8px;padding:6px 0;font-size:12px;cursor:pointer">✕ 모두 숨기기</button>
    </div>
    ${allProjects.length === 0
      ? '<p style="color:#64748b;text-align:center;padding:20px 0">프로젝트가 없습니다</p>'
      : allProjects.map(name => {
        const isVisible = !hidden[name];
        const grp = groups[name];
        const planets = grp.planetMeshes || [];
        const evCount = planets.reduce((s, p) => s + (p.userData.eventCount || 0), 0);
        const color = grp.color || '#58a6ff';
        return `
        <div style="display:flex;align-items:center;padding:8px 10px;margin-bottom:6px;
          background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.06);
          cursor:pointer;transition:background 0.15s"
          onclick="_projToggleSingle('${escHtml(name)}')">
          <div style="width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;
            margin-right:10px;flex-shrink:0;font-size:16px;
            background:${isVisible ? 'rgba(34,197,94,0.2)' : 'rgba(100,116,139,0.2)'};
            border:1px solid ${isVisible ? 'rgba(34,197,94,0.4)' : 'rgba(100,116,139,0.3)'}">
            ${isVisible ? '✓' : ''}
          </div>
          <div style="flex:1;overflow:hidden">
            <div style="font-size:13px;color:${isVisible ? '#e2e8f0' : '#64748b'};overflow:hidden;
              text-overflow:ellipsis;white-space:nowrap">${escHtml(name)}</div>
            <div style="font-size:11px;color:#64748b">${planets.length}세션 · ${evCount}이벤트</div>
          </div>
          <div style="width:8px;height:8px;border-radius:50%;background:${color};margin-left:8px;flex-shrink:0;
            opacity:${isVisible ? '1' : '0.3'}"></div>
        </div>`;
      }).join('')}
  `;
}
window.openProjectTogglePanel = openProjectTogglePanel;

function _projToggleSingle(name) {
  const hidden = window._hiddenNodes || {};
  if (hidden[name]) {
    delete hidden[name];
  } else {
    hidden[name] = name;
  }
  if (typeof window._saveHiddenNodes === 'function') window._saveHiddenNodes();
  // 숨긴 노드 버튼 표시 업데이트
  const hiddenBtn = document.getElementById('ln-hidden-btn');
  if (hiddenBtn) hiddenBtn.style.display = Object.keys(hidden).length > 0 ? '' : 'none';
  openProjectTogglePanel();
}
window._projToggleSingle = _projToggleSingle;

function _projToggleAll(show) {
  const hidden = window._hiddenNodes || {};
  const groups = window._projectGroups || {};
  if (show) {
    Object.keys(hidden).forEach(k => delete hidden[k]);
  } else {
    Object.keys(groups).forEach(name => { hidden[name] = name; });
  }
  if (typeof window._saveHiddenNodes === 'function') window._saveHiddenNodes();
  const hiddenBtn = document.getElementById('ln-hidden-btn');
  if (hiddenBtn) hiddenBtn.style.display = Object.keys(hidden).length > 0 ? '' : 'none';
  openProjectTogglePanel();
}
window._projToggleAll = _projToggleAll;

// ── 팀원 세션 정보 패널 ──────────────────────────────────────────────────────
function openTeamMemberPanel(hitData) {
  const { memberName, color, member } = hitData;
  if (!member) return;

  let panel = document.getElementById('team-member-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'team-member-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
      zIndex: '2000', background: '#0d1117', border: `1px solid ${color}44`,
      borderRadius: '16px', padding: '24px', width: '400px', maxHeight: '520px',
      overflowY: 'auto', boxShadow: '0 8px 40px rgba(0,0,0,0.7)', color: '#e2e8f0',
    });
    document.body.appendChild(panel);
  }

  const tasks = member.tasks || [];
  const activeTasks = tasks.filter(t => t.status === 'active');
  const doneTasks = tasks.filter(t => t.status === 'done');
  const role = member.role || '';

  panel.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:36px;height:36px;border-radius:50%;background:${color}33;border:2px solid ${color};
          display:flex;align-items:center;justify-content:center;font-size:18px">👤</div>
        <div>
          <div style="font-weight:700;font-size:15px">${escHtml(memberName)}</div>
          <div style="font-size:11px;color:#64748b">${escHtml(role)} · ${activeTasks.length}개 진행 · ${doneTasks.length}개 완료</div>
        </div>
      </div>
      <button onclick="document.getElementById('team-member-panel').remove()"
        style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;line-height:1">×</button>
    </div>
    ${tasks.length === 0
      ? '<p style="color:#64748b;text-align:center;padding:20px 0">활동 정보가 없습니다</p>'
      : tasks.map(t => {
        const statusColor = t.status === 'active' ? '#3fb950' : t.status === 'done' ? '#58a6ff' : '#6e7681';
        const statusText = t.status === 'active' ? '진행중' : t.status === 'done' ? '완료' : '대기';
        const pct = Math.round((t.progress || 0) * 100);
        const subtasks = t.subtasks || [];
        return `
        <div style="padding:12px;margin-bottom:8px;background:rgba(255,255,255,0.03);
          border-radius:10px;border:1px solid rgba(255,255,255,0.06)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:13px;font-weight:600;color:#e2e8f0">${escHtml(t.name)}</span>
            <span style="font-size:11px;color:${statusColor};background:${statusColor}22;
              padding:2px 8px;border-radius:10px">${statusText}</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;margin-bottom:6px">
            <div style="height:100%;width:${pct}%;background:${statusColor};border-radius:2px"></div>
          </div>
          ${subtasks.length > 0 ? `
            <div style="font-size:11px;color:#64748b;margin-top:4px">
              ${subtasks.slice(0, 3).map(f => `<div style="padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">📄 ${escHtml(f.split('/').pop())}</div>`).join('')}
              ${subtasks.length > 3 ? `<div style="color:#475569">+${subtasks.length - 3}개 파일</div>` : ''}
            </div>
          ` : ''}
        </div>`;
      }).join('')}
  `;
}
window.openTeamMemberPanel = openTeamMemberPanel;

// ── 트래커 설치 배너 ────────────────────────────────────────────────
async function updateTrackerBanner() {
  const profileView = document.getElementById('lm-profile-view');
  if (!profileView) return;

  // 기존 배너 제거
  const existingBanner = profileView.querySelector('.tracker-banner');
  if (existingBanner) existingBanner.remove();

  // 트래커 상태 확인
  try {
    const token = localStorage.getItem('orbit_token');
    if (!token) return;

    const res = await fetch('/api/tracker/status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const status = await res.json();

    // 배너 생성
    const banner = document.createElement('div');
    banner.className = 'tracker-banner';

    if (status.installed) {
      // 이미 설치됨 상태
      banner.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:600;font-size:15px;color:#fff">✓ PC 작업 추적 설치됨</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px">메시지 서비스 ${status.messageServices?.length || 0}개 연결</div>
          </div>
          <button onclick="window.openTrackerSettings()" style="
            background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);
            color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;
            white-space:nowrap">설정</button>
        </div>
      `;
    } else {
      // 설치되지 않음 - CTA 배너
      banner.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div>
            <div style="font-weight:600;font-size:15px;color:#fff">🚀 PC 작업 추적 설치</div>
            <div style="font-size:13px;color:rgba(255,255,255,0.8);margin-top:4px">파일 변경, 메시지를 자동 분석하고 업무 환경 개선 기회 발견</div>
          </div>
          <button onclick="window.startTrackerSetup()" style="
            background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);
            color:#fff;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:500;
            white-space:nowrap">설치하기</button>
        </div>
      `;
    }

    profileView.appendChild(banner);
  } catch (e) {
    console.warn('[tracker-banner]', e.message);
  }
}

async function startTrackerSetup() {
  try {
    const token = localStorage.getItem('orbit_token');
    if (!token) {
      alert('로그인이 필요합니다');
      return;
    }

    const res = await fetch('/api/tracker/oauth/init', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    if (data.authUrl) {
      window.location.href = data.authUrl;
    } else if (data.error) {
      alert('설치 오류: ' + data.error);
    }
  } catch (e) {
    alert('설치 시작 실패: ' + e.message);
  }
}
window.startTrackerSetup = startTrackerSetup;

async function openTrackerSettings() {
  // TODO: Tracker 설정 모달 열기
  alert('트래커 설정 준비 중입니다');
}
window.openTrackerSettings = openTrackerSettings;

// ═══════════════════════════════════════════════════════════════════════════════
// 학습 데이터 패널
// ═══════════════════════════════════════════════════════════════════════════════
let _ldData = null;

async function openLearningDataPanel() {
  const panel = document.getElementById('learning-data-panel');
  if (!panel) return;
  panel.style.display = 'block';
  await loadLearningData();
}
window.openLearningDataPanel = openLearningDataPanel;

function closeLearningDataPanel() {
  const panel = document.getElementById('learning-data-panel');
  if (panel) panel.style.display = 'none';
}
window.closeLearningDataPanel = closeLearningDataPanel;

async function loadLearningData() {
  const sumEl = document.getElementById('ld-summary');
  const contEl = document.getElementById('ld-content');
  const statusEl = document.getElementById('ld-drive-status');
  if (!sumEl) return;
  sumEl.innerHTML = '<div style="color:#64748b">로딩 중...</div>';

  try {
    // 데이터 요약 로드
    const [sumRes, insRes, sugRes, trigRes, driveRes] = await Promise.allSettled([
      fetch('/api/me/data-summary').then(r => r.json()),
      fetch('/api/me/insights').then(r => r.json()),
      fetch('/api/personal/suggestions').then(r => r.json()),
      fetch('/api/personal/triggers').then(r => r.json()),
      fetch('/api/gdrive/auth-status').then(r => r.json()),
    ]);

    const sum = sumRes.status === 'fulfilled' ? sumRes.value : {};
    const insights = insRes.status === 'fulfilled' ? (insRes.value.insights || insRes.value || []) : [];
    const suggestions = sugRes.status === 'fulfilled' ? (sugRes.value.suggestions || sugRes.value || []) : [];
    const triggers = trigRes.status === 'fulfilled' ? (trigRes.value.triggers || trigRes.value || []) : [];

    _ldData = { sum, insights, suggestions, triggers };

    // 요약 카드
    sumEl.innerHTML = [
      mkCard('📊 이벤트', sum.eventCount || 0),
      mkCard('🗓️ 세션', sum.sessionCount || 0),
      mkCard('💡 인사이트', Array.isArray(insights) ? insights.length : 0),
      mkCard('⚡ 트리거', Array.isArray(triggers) ? triggers.length : 0),
    ].join('');

    // Drive 상태
    const driveOk = driveRes.status === 'fulfilled' && driveRes.value.authenticated;
    if (statusEl) statusEl.textContent = driveOk
      ? '✅ Google Drive 연결됨'
      : '⚠️ Drive 미연결 — 로그인 후 백업 가능';

    // 기본 탭
    switchLdTab('insights');
  } catch (e) {
    sumEl.innerHTML = `<div style="color:#ef4444">데이터 로드 실패: ${e.message}</div>`;
  }
}

function mkCard(label, value) {
  return `<div style="background:rgba(51,65,85,0.4);border:1px solid #334155;border-radius:8px;padding:12px;text-align:center">
    <div style="color:#94a3b8;font-size:11px;margin-bottom:4px">${label}</div>
    <div style="color:#e2e8f0;font-size:22px;font-weight:700">${typeof value === 'number' ? value.toLocaleString() : value}</div>
  </div>`;
}

function switchLdTab(tab, btn) {
  // 탭 활성화
  document.querySelectorAll('.ld-tab').forEach(b => {
    b.style.background = 'transparent'; b.style.color = '#94a3b8';
    b.classList.remove('active');
  });
  if (btn) { btn.style.background = 'rgba(6,182,212,0.15)'; btn.style.color = '#06b6d4'; btn.classList.add('active'); }

  const el = document.getElementById('ld-content');
  if (!el || !_ldData) return;

  if (tab === 'insights') {
    const items = Array.isArray(_ldData.insights) ? _ldData.insights.slice(0, 20) : [];
    el.innerHTML = items.length === 0
      ? '<div style="color:#64748b;padding:20px;text-align:center">아직 생성된 인사이트가 없습니다</div>'
      : items.map(i => `<div style="background:rgba(51,65,85,0.3);border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:8px">
          <div style="font-weight:600;color:#06b6d4;font-size:12px;margin-bottom:4px">${i.type || i.category || '인사이트'}</div>
          <div style="color:#e2e8f0">${i.message || i.title || i.text || JSON.stringify(i).slice(0, 120)}</div>
          ${i.evidence ? `<div style="color:#64748b;font-size:11px;margin-top:4px">${i.evidence}</div>` : ''}
        </div>`).join('');
  } else if (tab === 'patterns') {
    el.innerHTML = '<div style="color:#64748b;padding:20px;text-align:center">패턴 분석은 충분한 데이터 수집 후 자동 생성됩니다</div>';
    fetch('/api/learning/routines').then(r => r.json()).then(data => {
      const routines = data.routines || data || [];
      if (routines.length > 0) {
        el.innerHTML = routines.map(r => `<div style="background:rgba(51,65,85,0.3);border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:8px">
          <div style="font-weight:600;color:#a78bfa">${r.name || r.pattern || '패턴'}</div>
          <div style="color:#cbd5e1;font-size:12px;margin-top:4px">${r.description || r.summary || ''}</div>
        </div>`).join('');
      }
    }).catch(e => console.warn('[learn] 루틴 데이터 로드 실패:', e.message));
  } else if (tab === 'suggestions') {
    const items = Array.isArray(_ldData.suggestions) ? _ldData.suggestions : [];
    el.innerHTML = items.length === 0
      ? '<div style="color:#64748b;padding:20px;text-align:center">아직 AI 추천이 없습니다</div>'
      : items.map(s => `<div style="background:rgba(51,65,85,0.3);border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font-weight:600;color:#22c55e">${s.title || s.type || '추천'}</span>
            <span style="font-size:10px;color:#64748b;background:rgba(100,116,139,0.2);padding:2px 6px;border-radius:4px">${s.confidence ? Math.round(s.confidence * 100) + '%' : ''}</span>
          </div>
          <div style="color:#cbd5e1;font-size:12px;margin-top:4px">${s.description || ''}</div>
        </div>`).join('');
  } else if (tab === 'triggers') {
    const items = Array.isArray(_ldData.triggers) ? _ldData.triggers : [];
    el.innerHTML = items.length === 0
      ? '<div style="color:#64748b;padding:20px;text-align:center">트리거 패턴이 아직 학습되지 않았습니다</div>'
      : items.map(t => `<div style="background:rgba(51,65,85,0.3);border:1px solid #1e293b;border-radius:8px;padding:12px;margin-bottom:8px">
          <div style="font-weight:600;color:#f59e0b">⚡ ${t.name || t.trigger || t.type || '트리거'}</div>
          <div style="color:#cbd5e1;font-size:12px;margin-top:4px">${t.description || t.condition || ''}</div>
        </div>`).join('');
  }
}
window.switchLdTab = switchLdTab;

async function backupLearningToDrive() {
  const statusEl = document.getElementById('ld-drive-status');
  if (statusEl) statusEl.textContent = '⏳ Drive 백업 중...';
  try {
    const res = await fetch('/api/gdrive/backup-learning', { method: 'POST' });
    const data = await res.json();
    if (data.fileId) {
      if (statusEl) statusEl.textContent = `✅ 백업 완료: ${data.fileName}`;
      showToast('학습 데이터가 Google Drive에 저장되었습니다');
    } else {
      if (statusEl) statusEl.textContent = `❌ ${data.error || '백업 실패'}`;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = `❌ 오류: ${e.message}`;
  }
}
window.backupLearningToDrive = backupLearningToDrive;

async function exportMyData() {
  try {
    showToast('데이터 내보내기 준비 중...');
    const res = await fetch('/api/me/export-data');
    if (!res.ok) throw new Error('내보내기 실패');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `orbit-my-data-${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast('데이터 다운로드 완료');
  } catch (e) { showToast('내보내기 실패: ' + e.message); }
}
window.exportMyData = exportMyData;

async function deleteMyData() {
  if (!confirm('정말로 모든 데이터를 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.')) return;
  if (!confirm('마지막 확인: 모든 이벤트, 세션, 북마크, 메모가 삭제됩니다.')) return;
  try {
    const res = await fetch('/api/me/delete-data', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_MY_DATA' }),
    });
    const data = await res.json();
    if (data.deleted) {
      showToast('데이터 삭제 완료');
      closeLearningDataPanel();
      if (typeof loadData === 'function') loadData();
    } else {
      showToast('삭제 실패: ' + (data.error || ''));
    }
  } catch (e) { showToast('삭제 실패: ' + e.message); }
}
window.deleteMyData = deleteMyData;
