'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — 설정 패널들 (LLM 설정, 셋업/설치, 온보딩, 실행 패널)
// [orbit3d-render.js에서 분할]
// ══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 LLM 설정 패널
// ═══════════════════════════════════════════════════════════════════════════════

async function openLlmPanel() {
  const panel = document.getElementById('llm-panel');
  document.getElementById('insight-panel')?.classList.remove('open');
  document.getElementById('info-panel')?.classList.remove('open');
  panel.classList.add('open');
  await renderLlmPanel();
}
function closeLlmPanel() {
  document.getElementById('llm-panel').classList.remove('open');
}
window.openLlmPanel  = openLlmPanel;
window.closeLlmPanel = closeLlmPanel;

async function renderLlmPanel() {
  const body = document.getElementById('lp-body');
  body.innerHTML = `<div style="padding:24px;text-align:center;color:#6e7681;font-size:12px;">불러오는 중…</div>`;

  try {
    const [provResp, ollamaResp] = await Promise.all([
      fetch('/api/llm-settings/providers').then(r => r.json()),
      fetch('/api/llm-settings/ollama-models').then(r => r.json()),
    ]);

    const providers    = provResp.providers || [];
    const ollamaModels = ollamaResp.models  || [];

    body.innerHTML = providers.map(p => _renderProviderRow(p, ollamaModels)).join('');
  } catch (e) {
    body.innerHTML = `<div style="padding:16px;color:#f85149;font-size:12px;">❌ ${escHtml(e.message)}</div>`;
  }
}
window.renderLlmPanel = renderLlmPanel;

function _renderProviderRow(p, ollamaModels) {
  const isOllama    = p.provider === 'ollama';
  const modelList   = isOllama ? ollamaModels : (p.models || []);
  const defaultMod  = p.defaultModel || '';

  // 모델 선택 옵션
  const modelOpts = isOllama
    ? (ollamaModels.length
        ? ollamaModels.map(m =>
            `<option value="${escHtml(m.id)}" ${m.id===defaultMod?'selected':''}>${escHtml(m.label)}${m.size?' ('+m.size+')':''}</option>`
          ).join('')
        : '<option value="">Ollama 실행 안됨</option>')
    : modelList.map(m =>
        `<option value="${escHtml(m.id)}" ${m.id===defaultMod?'selected':''}>
          ${escHtml(m.label)} — ${m.tier||''}
        </option>`
      ).join('');

  const enabledAttr = (p.enabled && (isOllama || p.configured)) ? 'checked' : '';
  const toggleHtml  = isOllama
    ? `<span style="font-size:10px;color:#3fb950;padding:2px 7px;background:rgba(63,185,80,.1);border-radius:8px;">기본값</span>`
    : `<label class="lp-toggle">
         <input type="checkbox" ${enabledAttr} onchange="toggleLlmProvider('${p.provider}', this.checked)">
         <span class="lp-toggle-track"></span>
       </label>`;

  const keySection = isOllama ? `
    <div class="lp-ollama-models">
      ${ollamaModels.length
        ? ollamaModels.map(m => `<span class="lp-model-tag">${escHtml(m.label)}</span>`).join('')
        : '<span style="font-size:10px;color:#6e7681;">Ollama가 실행 중이지 않습니다</span>'}
    </div>` : `
    <div class="lp-key-row">
      <input class="lp-key-input" type="password" id="lp-key-${p.provider}"
        placeholder="${escHtml(p.keyHint || 'API 키 입력...')}"
        ${p.configured ? 'value="••••••••"' : ''}>
      <button class="lp-btn-save" onclick="saveLlmKey('${p.provider}')">저장</button>
      ${p.configured
        ? `<button class="lp-btn-del" onclick="deleteLlmKey('${p.provider}')" title="삭제">🗑</button>`
        : ''}
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      ${p.configured
        ? `<button class="lp-btn-test" onclick="testLlmProvider('${p.provider}')">🔌 연결 테스트</button>`
        : ''}
      <div class="lp-status info" id="lp-status-${p.provider}">
        ${p.configured ? '✅ API 키 등록됨' : ''}
      </div>
    </div>`;

  return `<div class="lp-provider" id="lp-prov-${p.provider}">
    <div class="lp-prov-hdr">
      <span class="lp-prov-icon">${p.icon}</span>
      <div style="flex:1">
        <div class="lp-prov-name">${escHtml(p.name)}</div>
        <div class="lp-prov-desc">${escHtml(p.description || '')}</div>
      </div>
      ${toggleHtml}
    </div>
    ${keySection}
    ${modelList.length
      ? `<select class="lp-model-select" id="lp-model-${p.provider}"
           onchange="setDefaultLlmModel('${p.provider}', this.value)">
           ${modelOpts}
         </select>`
      : ''}
  </div>`;
}

async function saveLlmKey(provider) {
  const input = document.getElementById(`lp-key-${provider}`);
  const key   = input?.value?.trim();
  if (!key || key.startsWith('•')) { showToast('API 키를 입력하세요'); return; }

  const statusEl = document.getElementById(`lp-status-${provider}`);
  if (statusEl) { statusEl.className = 'lp-status info'; statusEl.textContent = '저장 중…'; }

  try {
    const model = document.getElementById(`lp-model-${provider}`)?.value;
    const resp  = await fetch('/api/llm-settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: key, defaultModel: model }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);

    if (statusEl) { statusEl.className = 'lp-status ok'; statusEl.textContent = '✅ 저장됨'; }
    showToast(`${provider} API 키 저장 완료`);
    await renderLlmPanel();          // 패널 갱신
    await loadExecModelOptions();    // exec 선택기 갱신
  } catch (e) {
    if (statusEl) { statusEl.className = 'lp-status err'; statusEl.textContent = `❌ ${e.message}`; }
  }
}
window.saveLlmKey = saveLlmKey;

async function deleteLlmKey(provider) {
  await fetch(`/api/llm-settings/keys/${provider}`, { method: 'DELETE' });
  showToast(`${provider} API 키 삭제됨`);
  await renderLlmPanel();
  await loadExecModelOptions();
}
window.deleteLlmKey = deleteLlmKey;

async function toggleLlmProvider(provider, enabled) {
  await fetch(`/api/llm-settings/keys/${provider}/toggle`, { method: 'PATCH' });
  await loadExecModelOptions();
}
window.toggleLlmProvider = toggleLlmProvider;

async function testLlmProvider(provider) {
  const statusEl = document.getElementById(`lp-status-${provider}`);
  if (statusEl) { statusEl.className = 'lp-status info'; statusEl.textContent = '테스트 중…'; }
  try {
    const resp = await fetch('/api/llm-settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
    });
    const data = await resp.json();
    if (data.ok) {
      if (statusEl) { statusEl.className = 'lp-status ok'; statusEl.textContent = `✅ 연결됨 — "${data.response?.slice(0,30)}"…`; }
    } else {
      throw new Error(data.error);
    }
  } catch (e) {
    if (statusEl) { statusEl.className = 'lp-status err'; statusEl.textContent = `❌ ${e.message.slice(0,60)}`; }
  }
}
window.testLlmProvider = testLlmProvider;

function setDefaultLlmModel(provider, model) {
  fetch('/api/llm-settings/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey: '(keep)', defaultModel: model }),
  }).catch(e => console.warn('[llm] 기본 모델 설정 실패:', e.message));
}
window.setDefaultLlmModel = setDefaultLlmModel;

// ── exec 패널 모델 선택기 (프로바이더별 그룹) ──────────────────────────────────
let _execProviders = []; // 캐시

async function loadExecModelOptions() {
  try {
    const [provResp, ollamaResp] = await Promise.all([
      fetch('/api/llm-settings/providers').then(r => r.json()),
      fetch('/api/llm-settings/ollama-models').then(r => r.json()),
    ]);
    _execProviders = provResp.providers || [];
    const ollamaModels = ollamaResp.models || [];

    const sel = document.getElementById('ep-model-select');
    if (!sel) return;
    sel.innerHTML = '';

    _execProviders.forEach(p => {
      if (!p.enabled && !p.isDynamic && p.provider !== 'ollama') return;

      const grp  = document.createElement('optgroup');
      grp.label  = `${p.icon} ${p.name}`;
      const mods = p.provider === 'ollama' ? ollamaModels : (p.models || []);
      if (!mods.length) {
        const opt  = document.createElement('option');
        opt.disabled = true;
        opt.textContent = `(모델 없음)`;
        grp.appendChild(opt);
      } else {
        mods.forEach(m => {
          const opt   = document.createElement('option');
          opt.value   = `${p.provider}::${m.id}`;
          opt.textContent = m.label || m.id;
          if (m.id === p.defaultModel) opt.selected = true;
          grp.appendChild(opt);
        });
      }
      sel.appendChild(grp);
    });
  } catch {}
}
window.loadExecModelOptions = loadExecModelOptions;

// ═══════════════════════════════════════════════════════════════════════════════
// ⚙️ 환경설정 / 온보딩 패널
// ═══════════════════════════════════════════════════════════════════════════════

let _setupStatus = null;  // GET /api/setup/check 캐시

// ── 원키 설치 모달 ─────────────────────────────────────────────────────────
// 원키 설치: CMD/PowerShell 모두 동작하는 한 줄 명령어 모달
function showInstallModal() {
  document.getElementById('install-modal')?.remove();

  const ua = navigator.userAgent || '';
  const isWin = /Windows/i.test(ua);
  const isMac = /Mac OS X/i.test(ua);

  // 서버 URL (현재 페이지의 origin)
  const serverUrl = location.origin;

  // 로그인된 사용자 토큰 가져오기 (데몬이 본인 계정으로 데이터 전송용)
  const userToken = localStorage.getItem('token') || '';

  // CMD/PowerShell 모두 호환 — 토큰을 URL 쿼리로 전달 (따옴표 충돌 방지)
  const winCmd  = userToken
    ? `powershell -ExecutionPolicy Bypass -Command "& {$env:ORBIT_TOKEN='${userToken}'; iex (irm '${serverUrl}/setup/install.ps1')}"`
    : `powershell -ExecutionPolicy Bypass -Command "iex (irm '${serverUrl}/setup/install.ps1')"`;
  const winBankCmd = userToken
    ? `powershell -ExecutionPolicy Bypass -Command "& {$env:ORBIT_TOKEN='${userToken}'; iex (irm '${serverUrl}/setup/install-bank.ps1')}"`
    : `powershell -ExecutionPolicy Bypass -Command "iex (irm '${serverUrl}/setup/install-bank.ps1')"`;
  const macCmd  = userToken
    ? `ORBIT_TOKEN='${userToken}' bash <(curl -sL '${serverUrl}/setup/orbit-start.sh')`
    : `bash <(curl -sL '${serverUrl}/setup/orbit-start.sh')`;
  const linuxCmd = macCmd;

  const cmd   = isWin ? winCmd : isMac ? macCmd : linuxCmd;
  const label = isWin ? '🪟 CMD 또는 PowerShell' : '🖥️ 터미널';

  const modal = document.createElement('div');
  modal.id = 'install-modal';
  modal.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10000;
    display:flex;align-items:center;justify-content:center;padding:16px;
  `;
  modal.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:14px;
      max-width:640px;width:100%;
      box-shadow:0 16px 48px rgba(0,0,0,.6);font-family:inherit;">
      <div style="padding:18px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px">
        <span style="font-size:17px">⬡</span>
        <span style="font-size:14px;font-weight:700;color:#f0f6fc">Orbit AI 원키 설치</span>
        <span onclick="document.getElementById('install-modal').remove()"
          style="margin-left:auto;cursor:pointer;color:#6e7681;font-size:20px;line-height:1">✕</span>
      </div>
      <div style="padding:20px">

        <!-- 단계 1 -->
        <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:18px">
          <div style="width:24px;height:24px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">1</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:#f0f6fc;margin-bottom:4px">${label} 열기</div>
            <div style="font-size:11px;color:#8b949e;line-height:1.6">
              ${isWin
                ? '<kbd style="background:#21262d;padding:2px 6px;border-radius:3px">Win + R</kbd> → <b style="color:#cdd9e5">powershell</b> 입력 → Enter'
                : '<kbd style="background:#21262d;padding:2px 6px;border-radius:3px">Spotlight</kbd> → Terminal 검색 → Enter'}
            </div>
          </div>
        </div>

        <!-- 단계 2 -->
        <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:18px">
          <div style="width:24px;height:24px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">2</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:#f0f6fc;margin-bottom:8px">아래 명령어 복사 → 붙여넣기 (<kbd style="background:#21262d;padding:1px 5px;border-radius:3px;font-size:10px">Ctrl+V</kbd>) → Enter</div>
            ${isWin ? `
            <div style="font-size:11px;color:#8b949e;margin-bottom:6px">🏦 은행 앱 <b style="color:#ff7b72">사용</b> PC</div>
            <div style="position:relative;background:#010409;border:1px solid #30363d;border-radius:8px;padding:12px 44px 12px 14px;margin-bottom:10px">
              <code id="install-cmd-bank" style="font-family:'Consolas','Courier New',monospace;font-size:11px;color:#e3b341;word-break:break-all;line-height:1.6">${escHtml(winBankCmd)}</code>
              <button onclick="copyInstallScriptById('install-cmd-bank','copy-btn-bank')" id="copy-btn-bank"
                style="position:absolute;top:8px;right:8px;background:#6e4010;border:1px solid #e3b341;border-radius:5px;
                color:#e3b341;font-size:10px;font-weight:600;padding:3px 8px;cursor:pointer">복사</button>
            </div>
            <div style="font-size:11px;color:#8b949e;margin-bottom:6px">✅ 은행 앱 <b style="color:#3fb950">없는</b> PC</div>
            ` : ''}
            <div style="position:relative;background:#010409;border:1px solid #21262d;border-radius:8px;padding:12px 44px 12px 14px">
              <code id="install-cmd" style="font-family:'Consolas','Courier New',monospace;font-size:11.5px;color:#3fb950;word-break:break-all;line-height:1.6">${escHtml(cmd)}</code>
              <button onclick="copyInstallScriptById('install-cmd','copy-script-btn')" id="copy-script-btn"
                style="position:absolute;top:8px;right:8px;background:#1f6feb;border:none;border-radius:5px;
                color:#fff;font-size:10px;font-weight:600;padding:3px 8px;cursor:pointer">복사</button>
            </div>
            <div style="font-size:10px;color:#6e7681;margin-top:6px;line-height:1.6">
              ✓ Orbit 다운로드 → ✓ 서버 연결 → ✓ 앱·웹·키입력 트래킹 시작
            </div>
          </div>
        </div>

        <!-- 단계 3 -->
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="width:24px;height:24px;background:#238636;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">3</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:#f0f6fc;margin-bottom:4px">설치 완료 후 → 아래 버튼 클릭</div>
            <button onclick="markSetupDone()" style="padding:8px 18px;background:#238636;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer">
              ✅ 설치 완료됨
            </button>
            <span style="font-size:11px;color:#6e7681;margin-left:8px">이미 설치되어 있어도 클릭하세요</span>
          </div>
        </div>

      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // 바깥 클릭 시 닫기
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// 스크립트 복사 (id 지정 방식)
function copyInstallScriptById(codeId, btnId) {
  const el = document.getElementById(codeId) || document.getElementById('install-cmd') || document.getElementById('install-script-box');
  if (!el) return;
  const btn = btnId ? document.getElementById(btnId) : document.getElementById('copy-script-btn');
  const origText = btn ? btn.textContent : '복사';
  navigator.clipboard.writeText(el.textContent || '').then(() => {
    if (btn) { btn.textContent = '✅ 복사됨'; setTimeout(() => btn.textContent = origText, 2000); }
  }).catch(() => {
    const t = el.textContent;
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    if (btn) { btn.textContent = '✅'; setTimeout(() => btn.textContent = origText, 2000); }
  });
}
// 구버전 호환
function copyInstallScript() { copyInstallScriptById('install-cmd', 'copy-script-btn'); }


// 설치 완료 처리
function markSetupDone() {
  // 설치가 실제로 완료됐는지 확인하는 다이얼로그
  // (설치 중 멈춘 상태에서 실수로 완료 처리하는 것 방지)
  const confirmed = confirm(
    '✅ 이 컴퓨터에서 설치 명령어를 실행하고\n' +
    'Orbit 서버가 정상 시작됐나요?\n\n' +
    '(설치 중 오류가 있었다면 "취소"를 눌러주세요)'
  );
  if (!confirmed) return;

  localStorage.setItem('orbit_ollama_ok', '1');
  localStorage.setItem('orbit_hook_ok',   '1');
  document.getElementById('install-modal')?.remove();
  document.getElementById('env-check-banner')?.remove();
  renderSetupPanel();
  showToast('✅ 이 컴퓨터에서 설치 완료 확인됨! Orbit AI가 데이터를 수집합니다.');
}

// ── 로그인 후 자동 환경 체크 ────────────────────────────────────────────────
// 설치 안내는 설정 패널에서 제공 — 자동 팝업 제거
function _autoCheckEnvAfterLogin() {
  // 설정 패널에 설치 명령어가 있으므로 별도 배너/모달 표시하지 않음
}

async function openSetupPanel() {
  // 다른 패널 닫기
  document.getElementById('llm-panel')?.classList.remove('open');
  document.getElementById('insight-panel')?.classList.remove('open');
  document.getElementById('info-panel')?.classList.remove('open');

  document.getElementById('setup-panel').classList.add('open');
  await renderSetupPanel();
  _loadPersonalStats(); // 개인 학습 통계 갱신
}
function closeSetupPanel() {
  document.getElementById('setup-panel').classList.remove('open');
}
window.openSetupPanel  = openSetupPanel;
window.closeSetupPanel = closeSetupPanel;

// ── 클라이언트 환경 감지 ─────────────────────────────────────────────────────
// HTTPS→HTTP localhost는 브라우저 Mixed Content 정책으로 차단됨
// → OS: navigator.userAgent / Ollama·훅: localStorage 확인 상태 사용
function detectClientEnv() {
  const ua = navigator.userAgent || '';
  let os = 'linux';
  if (/Windows/i.test(ua))       os = 'windows';
  else if (/Mac OS X/i.test(ua)) os = 'mac';

  // 사용자가 직접 확인한 상태를 localStorage에 저장
  const ollamaOk = localStorage.getItem('orbit_ollama_ok') === '1';
  const hookOk   = localStorage.getItem('orbit_hook_ok')   === '1';

  return {
    os,
    nodeVersion: 'N/A',
    ollama: { installed: ollamaOk, running: ollamaOk, models: [] },
    hook:   { registered: hookOk },
    claude: { running: false },
    ready:  ollamaOk && hookOk,
  };
}

// 원키 설치 페이지 열기 (localhost:4747 = HTTP → Mixed Content 없음)
function openAutoSetup() {
  window.open('http://localhost:4747/setup.html', 'orbit_setup',
    'width=740,height=680,toolbar=0,menubar=0,scrollbars=1');
}
// 완료 후 수동 확인 버튼
function confirmOllama() {
  localStorage.setItem('orbit_ollama_ok', '1');
  renderSetupPanel();
  document.getElementById('env-check-banner')?.remove();
}
function confirmHook() {
  localStorage.setItem('orbit_hook_ok', '1');
  renderSetupPanel();
  document.getElementById('env-check-banner')?.remove();
}
function resetEnvConfirm() {
  localStorage.removeItem('orbit_ollama_ok');
  localStorage.removeItem('orbit_hook_ok');
  renderSetupPanel();
}
// setup.html이 완료되면 postMessage로 신호를 보냄 → 자동 확인 처리
window.addEventListener('message', (e) => {
  if (e.data?.type === 'orbit_setup_done') {
    localStorage.setItem('orbit_ollama_ok', '1');
    localStorage.setItem('orbit_hook_ok',   '1');
    renderSetupPanel();
    document.getElementById('env-check-banner')?.remove();
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#238636;color:#fff;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.4)';
    t.textContent = '✅ 설정 완료! Orbit AI가 데이터를 수집합니다.';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }
});
window.openAutoSetup      = openAutoSetup;
window.confirmOllama      = confirmOllama;
window.confirmHook        = confirmHook;
window.resetEnvConfirm    = resetEnvConfirm;
window.showInstallModal   = showInstallModal;
window.copyInstallScript  = copyInstallScript;
window.markSetupDone      = markSetupDone;

// Ollama 서버 시작 (설치됐지만 미실행 상태)
async function startOllamaServer() {
  const btn = document.querySelector('button[onclick="startOllamaServer()"]');
  if (btn) { btn.textContent = '⏳ 시작 중…'; btn.disabled = true; }
  try {
    const port = localStorage.getItem('orbit_port') || '4747';
    const res  = await fetch(`http://localhost:${port}/api/setup/start-ollama`, { method: 'POST' });
    if (res.ok) {
      if (typeof showToast === 'function') showToast('✅ Ollama 서버 시작 완료', 3000);
      setTimeout(() => renderSetupPanel(), 2500); // 상태 새로고침
    } else {
      if (typeof showToast === 'function') showToast('❌ 시작 실패 — 터미널에서 ollama serve 실행', 4000);
      if (btn) { btn.textContent = '▶ Ollama 서버 시작'; btn.disabled = false; }
    }
  } catch {
    if (typeof showToast === 'function') showToast('❌ 서버 연결 실패 — 로컬 서버가 실행 중인지 확인', 4000);
    if (btn) { btn.textContent = '▶ Ollama 서버 시작'; btn.disabled = false; }
  }
}
window.startOllamaServer = startOllamaServer;

async function renderSetupPanel() {
  const body = document.getElementById('sp-body');
  body.innerHTML = `<div style="padding:24px;text-align:center;color:#6e7681;font-size:12px;">환경 감지 중…</div>`;

  const status = detectClientEnv();
  _setupStatus = status;
  const { os } = status;
  const osIcon = os === 'mac' ? '🍎' : os === 'windows' ? '🪟' : '🐧';

  // ── 서버 버전 가져오기 ────────────────────────────────────────────────────
  let _serverVer = 'unknown';
  let _serverTs = '';
  try {
    const vr = await fetch('/api/daemon/version');
    const vd = await vr.json();
    _serverVer = vd.version || 'unknown';
    _serverTs = vd.ts ? new Date(vd.ts).toLocaleString('ko-KR') : '';
  } catch {}

  // ── 트래커 연결 상태 서버에서 확인 ──────────────────────────────────────
  let trackerOnline = false;
  let trackerHost = '';
  let trackerEvents = 0;
  try {
    const r = await _authFetch('/api/tracker/status');
    const d = await r.json();
    trackerOnline = d.online;
    trackerHost = d.hostname || '';
    trackerEvents = d.eventCount || 0;
  } catch {}

  // ── 상태 카드 ─────────────────────────────────────────────────────────────
  const trackerCard = trackerOnline
    ? `<div class="sp-check-card" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;width:100%;align-items:center">
          <div class="sp-check-label">트래커</div>
          <div class="sp-check-val sp-check-ok">🟢 연결됨</div>
        </div>
        <div style="font-size:10px;color:#6e7681">${trackerHost ? trackerHost + ' · ' : ''}${trackerEvents}개 이벤트</div>
      </div>`
    : `<div class="sp-check-card" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;width:100%;align-items:center">
          <div class="sp-check-label">트래커</div>
          <div class="sp-check-val sp-check-warn">🔴 미연결</div>
        </div>
        <div style="font-size:10px;color:#6e7681">아래 설치 명령어를 PC에서 실행하세요</div>
      </div>`;

  const aiCard = `<div class="sp-check-card" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;width:100%;align-items:center">
        <div class="sp-check-label">AI 분석</div>
        <div class="sp-check-val sp-check-ok">☁️ Haiku</div>
      </div>
      <div style="font-size:10px;color:#6e7681">클라우드 AI — 로컬 설치 불필요</div>
    </div>`;

  const cards = [
    { label:'OS', val: `${osIcon} ${os}`, cls:'sp-check-neutral' },
  ].map(c => `
    <div class="sp-check-card">
      <div class="sp-check-label">${c.label}</div>
      <div class="sp-check-val ${c.cls}">${escHtml(c.val)}</div>
    </div>`).join('') + trackerCard + aiCard;

  // ── 설치 섹션 ─────────────────────────────────────────────────────────────
  const _token       = _getAuthToken();
  const _setupScript = location.origin + '/setup/install.ps1';
  const _setupSh     = location.origin + '/setup/orbit-start.sh';
  // 설치 명령어에 토큰 포함 — 사용자가 따로 입력 안 해도 자동 연동
  const _installCmd  = os === 'windows'
    ? `&([scriptblock]::Create((irm '${_setupScript}'))) -Token '${_token||''}'`
    : `ORBIT_TOKEN='${_token||''}' bash <(curl -sL '${_setupSh}')`;

  const installSection = `
    <div class="sp-section">📦 설치 / 업데이트 <span style="font-size:9px;color:#6e7681;text-transform:none;font-weight:400">— 1~2분 소요</span></div>

    ${_token
      ? `<div style="font-size:11px;color:#3fb950;background:rgba(63,185,80,.08);
           border:1px solid rgba(63,185,80,.2);border-radius:6px;padding:6px 10px;margin-bottom:7px">
           ✅ 내 계정 토큰 포함 — 실행하면 자동으로 내 계정에 연동됩니다
         </div>`
      : `<div style="font-size:11px;color:#f0a82e;background:rgba(240,168,46,.08);
           border:1px solid rgba(240,168,46,.2);border-radius:6px;padding:6px 10px;margin-bottom:7px">
           ⚠ 로그인하면 토큰이 포함된 개인화 명령어를 받을 수 있습니다
         </div>`
    }

    <div style="background:#010409;border:1px solid #21262d;border-radius:8px;
      padding:10px 12px;margin-bottom:8px;position:relative">
      <div style="font-size:10px;color:#6e7681;margin-bottom:5px">
        ${os === 'windows' ? '🪟 PowerShell (Win+R → powershell → Enter)' : '🖥️ 터미널'}
      </div>
      <code id="sp-install-inline-cmd"
        style="font-family:'Consolas','Courier New',monospace;font-size:11px;
        color:#3fb950;word-break:break-all;line-height:1.6;display:block;
        padding-right:52px">${escHtml(_installCmd)}</code>
      <button onclick="(function(){
        const el=document.getElementById('sp-install-inline-cmd');
        navigator.clipboard.writeText(el.textContent.trim()).then(()=>{
          const b=document.getElementById('sp-inline-copy-btn');
          b.textContent='✅';b.style.background='#238636';
          setTimeout(()=>{b.textContent='복사';b.style.background='#1f6feb';},2000);
        }).catch(()=>prompt('복사:',el.textContent.trim()));
      })()" id="sp-inline-copy-btn"
        style="position:absolute;top:8px;right:8px;background:#1f6feb;border:none;
        border-radius:5px;color:#fff;font-size:10px;font-weight:600;
        padding:3px 8px;cursor:pointer">복사</button>
    </div>

    <div style="font-size:11px;color:#6e7681;line-height:1.6;margin-bottom:4px">
      <b style="color:#cdd9e5">수집 항목:</b> 모든 앱 사용 · 웹 브라우징 · 키 입력 · Claude Code · VS Code · 터미널<br>
      <b style="color:#cdd9e5">동기화:</b> 5분마다 자동 전송 · 원본 데이터는 로컬에만 저장<br>
      <b style="color:#cdd9e5">업데이트:</b> 이미 설치된 PC에서 같은 명령어 재실행하면 최신 버전으로 업데이트
    </div>
  `;

  // ── Chrome 확장 설치 가이드 ────────────────────────────────────────────────
  const chromeSection = `
    <div class="sp-section">🧩 Chrome 확장 (선택)</div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:8px">ChatGPT, Claude, Gemini 대화를 자동 수집합니다</div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;margin-bottom:8px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="font-size:28px;flex-shrink:0">1️⃣</div>
        <div>
          <div style="font-size:12px;color:#e6edf3;font-weight:600;margin-bottom:4px">chrome://extensions 열기</div>
          <a href="#" onclick="navigator.clipboard.writeText('chrome://extensions');this.textContent='✅ 복사됨! 주소창에 붙여넣기';this.style.color='#3fb950';return false"
            style="font-size:11px;color:#58a6ff;text-decoration:underline;cursor:pointer">클릭하여 주소 복사 → 주소창에 붙여넣기</a>
        </div>
      </div>
    </div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;margin-bottom:8px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="font-size:28px;flex-shrink:0">2️⃣</div>
        <div>
          <div style="font-size:12px;color:#e6edf3;font-weight:600;margin-bottom:4px">우측 상단 "개발자 모드" 토글 ON</div>
          <div style="display:inline-block;background:#0d1117;border:1px solid #1f6feb;border-radius:12px;padding:2px 10px;font-size:11px;color:#58a6ff;margin-top:4px">개발자 모드 🔵</div>
        </div>
      </div>
    </div>
    <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px;margin-bottom:8px">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <div style="font-size:28px;flex-shrink:0">3️⃣</div>
        <div>
          <div style="font-size:12px;color:#e6edf3;font-weight:600;margin-bottom:4px">"압축해제된 확장 프로그램을 로드합니다" 클릭</div>
          <div style="font-size:11px;color:#6e7681">→ <b>chrome-extension</b> 폴더 선택</div>
          <div style="background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:6px 10px;margin-top:6px;font-family:monospace;font-size:11px;color:#79c0ff;cursor:pointer"
            onclick="navigator.clipboard.writeText('~/mindmap-viewer/chrome-extension');this.style.borderColor='#3fb950'"
          >📁 ~/mindmap-viewer/chrome-extension <span style="color:#6e7681;font-size:9px">(클릭 복사)</span></div>
        </div>
      </div>
    </div>
    <a href="/chrome-guide.html" target="_blank" style="font-size:11px;color:#58a6ff;text-decoration:none">📖 자세한 가이드 보기 →</a>
  `;

  // ── 데이터 소스 설정 ──────────────────────────────────────────────────────
  const _curSource = _getDataSource() || 'cloud';
  const _curAccount = localStorage.getItem(DATA_SOURCE_ACCOUNT_KEY) || '';
  const dataSourceSection = `
    <div class="sp-section">📂 데이터 소스</div>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button id="sp-ds-cloud" onclick="_setDataSourceFromSettings('cloud')"
        style="flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;
        border:1px solid ${_curSource==='cloud'?'#1f6feb':'#30363d'};
        background:${_curSource==='cloud'?'rgba(31,111,235,.15)':'#161b22'};
        color:${_curSource==='cloud'?'#58a6ff':'#8b949e'}">
        &#9729; 클라우드 동기화
      </button>
      <button id="sp-ds-local" onclick="_setDataSourceFromSettings('local')"
        style="flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;
        border:1px solid ${_curSource==='local'?'#1f6feb':'#30363d'};
        background:${_curSource==='local'?'rgba(31,111,235,.15)':'#161b22'};
        color:${_curSource==='local'?'#58a6ff':'#8b949e'}">
        &#128187; 로컬 데이터
      </button>
    </div>
    <div style="font-size:11px;color:#6e7681;line-height:1.5;margin-bottom:4px">
      ${_curSource==='cloud'
        ? '같은 계정으로 로그인하면 어떤 PC에서든 동일한 데이터를 봅니다.'
        : '이 PC의 로컬 데이터만 작업 화면에 표시됩니다.'}
      ${_curAccount ? '<br>연결 계정: <b style="color:#cdd9e5">'+_curAccount+'</b>' : ''}
    </div>
  `;

  body.innerHTML = `
    <div class="sp-check-grid">${cards}</div>
    ${installSection}
    ${chromeSection}
    ${dataSourceSection}

    <div class="sp-section" style="margin-top:12px">🧠 AI 개인 학습</div>
    <div id="sp-personal-section">
      <div style="color:#6e7681;font-size:11px;margin-bottom:8px;line-height:1.7">
        내 업무 <b style="color:#cdd9e5">패턴</b>을 로컬 AI가 학습해 <b style="color:#3fb950">나만을 위한 제안</b>을 만듭니다.<br>
        <span style="color:#3fb950">✓ 모든 원본 내용은 내 기기 밖으로 나가지 않음</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px" id="sp-personal-toggles">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#cdd9e5">⌨️ 타이핑 패턴 학습</span>
          <button class="sp-btn sp-btn-outline" style="padding:2px 10px;font-size:11px"
            id="sp-toggle-keyboard" onclick="togglePersonalLearning('keyboard')">로딩중</button>
        </div>
        <div style="font-size:10px;color:#6e7681;padding-left:4px">
          반복 입력·AI 수정 패턴 감지 → 효율적인 방법 제안<br>
          ⚠️ 비밀번호 앱(1Password 등) 활성 시 자동 제외 ·
          <span style="color:#58a6ff;cursor:pointer"
            onclick="open('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')">
            Accessibility 권한 열기</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#cdd9e5">📁 파일 작업 패턴 학습</span>
          <button class="sp-btn sp-btn-outline" style="padding:2px 10px;font-size:11px"
            id="sp-toggle-file" onclick="togglePersonalLearning('file')">로딩중</button>
        </div>
        <div style="font-size:10px;color:#6e7681;padding-left:4px">
          자주 여는 파일·장시간 작업 감지 → 자동화 제안<br>
          ~/Documents, ~/Desktop, ~/Downloads · docx·xlsx·pdf·md 지원
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;color:#cdd9e5">🖥️ 앱 전환 패턴 학습</span>
          <button class="sp-btn sp-btn-outline" style="padding:2px 10px;font-size:11px"
            id="sp-toggle-app" onclick="togglePersonalLearning('app')">로딩중</button>
        </div>
        <div style="font-size:10px;color:#6e7681;padding-left:4px">
          Word↔Excel 반복 전환 감지 → 통합 워크플로우 제안
        </div>
      </div>
      <div id="sp-personal-stats" style="margin-top:10px;background:#0d1117;border-radius:8px;padding:8px 10px;font-size:11px;color:#8b949e;line-height:1.7">
        통계 불러오는 중…
      </div>
      <button class="sp-btn" style="margin-top:8px;background:#1f6feb;border-color:#1f6feb;font-size:11px"
        onclick="startPersonalAgent()">▶ 데몬 시작 (orbit learn start)</button>
    </div>

    <div class="sp-section" style="margin-top:12px">🧠 학습 공유 설정</div>
    <div id="sp-sync-section">
      <div style="font-size:11px;color:#6e7681;margin-bottom:8px;line-height:1.8">
        내 업무 원본은 <b style="color:#cdd9e5">절대 전송되지 않습니다.</b><br>
        <span style="color:#3fb950">✓ 로컬에서 학습한 패턴 인사이트만 공유</span><br>
        <span style="color:#3fb950">✓ 공유된 인사이트로 모든 사용자에게 무료 솔루션 제공</span>
      </div>
      <div id="sp-sync-status" style="font-size:11px;color:#8b949e;margin-bottom:8px">불러오는 중…</div>

      <div style="display:flex;flex-direction:column;gap:5px">
        <button class="sp-btn" id="sp-sync-btn-1"
          style="font-size:11px;text-align:left;padding:7px 10px;background:rgba(56,139,253,.12);border-color:#1f6feb"
          onclick="setSyncConsent(1)">
          🤝 <b>학습 인사이트 공유</b> (권장)<br>
          <span style="font-size:10px;color:#8b949e;font-weight:normal">
            "몇 번 반복했는지" 같은 패턴만 · 내용은 절대 포함 안 됨
          </span>
        </button>
        <button class="sp-btn" id="sp-sync-btn-2"
          style="font-size:11px;text-align:left;padding:7px 10px;background:rgba(188,120,222,.10);border-color:#8957e5"
          onclick="setSyncConsent(2)">
          🔬 <b>심층 학습 참여</b><br>
          <span style="font-size:10px;color:#8b949e;font-weight:normal">
            최적 프롬프트 구조까지 공유 → 무료 솔루션 품질 향상에 기여
          </span>
        </button>
        <button class="sp-btn sp-btn-outline" id="sp-sync-btn-0"
          style="font-size:11px"
          onclick="setSyncConsent(0)">🔒 내 기기에서만 학습</button>
      </div>
      <button class="sp-btn sp-btn-outline" style="margin-top:6px;font-size:11px;width:100%"
        onclick="triggerSyncPush()">↑ 지금 공유</button>
    </div>

    ${_getAuthToken() ? `
    <div class="sp-section" style="margin-top:12px">🔑 CLI 연동 토큰</div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:6px;line-height:1.5">
      설치 스크립트 실행 후 <code style="color:#7ee787">~/.orbit-config.json</code>에<br>
      아래 토큰을 넣으면 내 계정으로 이벤트가 저장됩니다.
    </div>
    <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:11px;font-family:monospace;color:#e6edf3;word-break:break-all;margin-bottom:6px">
      ${JSON.stringify({ serverUrl: location.origin, token: _getAuthToken() }, null, 2).replace(/</g,'&lt;')}
    </div>
    <button class="sp-btn sp-btn-outline" style="font-size:11px;width:100%"
      onclick="_copyCliConfig()">📋 ~/.orbit-config.json 내용 복사</button>
    ` : ''}

    <button class="sp-btn sp-btn-outline" onclick="renderSetupPanel()" style="margin-top:12px">
      ↺ 상태 새로고침
    </button>

    <div style="margin-top:16px;padding-top:12px;border-top:1px solid #21262d;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:10px;color:#484f58">
        서버 버전: <span style="color:#58a6ff;font-family:monospace">${_serverVer}</span>
      </div>
      <div style="font-size:10px;color:#484f58">
        ${_serverTs}
      </div>
    </div>
  `;

}

window.renderSetupPanel = renderSetupPanel;

// CLI 연동 설정 클립보드 복사
function _copyCliConfig() {
  const token = _getAuthToken();
  if (!token) { showToast('로그인 필요', 'warn'); return; }
  const config = JSON.stringify({ serverUrl: location.origin, token }, null, 2);
  navigator.clipboard.writeText(config).then(() => {
    showToast('✅ 클립보드에 복사됨 — ~/.orbit-config.json 파일에 붙여넣기 하세요', 'success');
  }).catch(() => {
    // 클립보드 API 실패 시 프롬프트로 표시
    prompt('내용을 복사하세요 (Ctrl+A → Ctrl+C):', config);
  });
}
window._copyCliConfig = _copyCliConfig;

async function _loadInstallScript(osType) {
  try {
    // 로그인 상태면 토큰 + 서버URL 자동 삽입 → 팀원이 붙여넣기만 하면 됨
    const user      = typeof _orbitUser !== 'undefined' ? _orbitUser : null;
    const token     = user?.token || localStorage.getItem('orbitUser') && JSON.parse(localStorage.getItem('orbitUser'))?.token || '';
    const serverUrl = (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost')
      ? location.origin : '';
    const memberName = user?.name || '';

    const params = new URLSearchParams({ os: osType });
    if (token)      params.set('token',      token);
    if (serverUrl)  params.set('serverUrl',  serverUrl);
    if (memberName) params.set('memberName', memberName);

    const r    = await fetch(`/api/setup/install-script?${params}`);
    const data = await r.json();
    const el   = document.getElementById('sp-script-box');
    if (el) el.textContent = data.script || '';
  } catch {}
}

async function copySetupScript() {
  const el = document.getElementById('sp-script-box');
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    showToast('✅ 스크립트 복사 완료 — 터미널에 붙여넣기 하세요');
  } catch { showToast('복사 실패 — 직접 선택 후 복사하세요'); }
}
window.copySetupScript = copySetupScript;

async function registerHookOnly() {
  try {
    const r    = await fetch('/api/setup/hook-register', { method: 'POST' });
    const data = await r.json();
    if (data.ok) {
      showToast('✅ Claude 훅 등록 완료');
      await renderSetupPanel();
    } else {
      showToast(`❌ 실패: ${data.error}`);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.registerHookOnly = registerHookOnly;

async function pullOllamaModel() {
  const model = document.getElementById('sp-model-select')?.value || 'llama3.2:latest';
  const log   = document.getElementById('sp-pull-log');
  if (!log) return;
  log.classList.add('active');
  log.textContent = `⬇️ ${model} 다운로드 시작...\n`;

  try {
    const resp = await fetch('/api/setup/ollama-pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop();
      lines.forEach(line => {
        const m = line.match(/^data: (.+)$/m);
        if (!m) return;
        try {
          const d = JSON.parse(m[1]);
          if (d.type === 'stdout' || d.type === 'stderr') {
            log.textContent += d.text;
            log.scrollTop = log.scrollHeight;
          } else if (d.type === 'done') {
            log.textContent += d.exitCode === 0 ? '\n✅ 완료!' : `\n❌ 실패 (code ${d.exitCode})`;
            showToast(d.exitCode === 0 ? `✅ ${model} 다운로드 완료` : `❌ 다운로드 실패`);
          }
        } catch {}
      });
    }
  } catch (e) {
    log.textContent += `\n❌ ${e.message}`;
  }
}
window.pullOllamaModel = pullOllamaModel;

async function toggleClaudeTracking(enabled) {
  try {
    const r    = await fetch('/api/setup/claude-toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const data = await r.json();
    showToast(data.tracking ? '✅ Claude 트래킹 ON' : '⏸ Claude 트래킹 OFF');
    _updateTrackingBadge(data.tracking, _setupStatus?.claude?.running);
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.toggleClaudeTracking = toggleClaudeTracking;

function _updateTrackingBadge(tracking, running) {
  const badge = document.getElementById('claude-tracking-badge');
  const dot   = document.getElementById('ctb-dot');
  const label = document.getElementById('ctb-label');
  if (!badge) return;
  if (running && tracking) {
    badge.className = 'on';
    if (dot)   dot.textContent   = '⬤';
    if (label) label.textContent = 'Claude 트래킹 중';
  } else if (running && !tracking) {
    badge.className = 'off';
    if (dot)   dot.textContent   = '⬤';
    if (label) label.textContent = 'Claude 일시정지';
  } else {
    badge.className = 'off';
    if (dot)   dot.textContent   = '⬤';
    if (label) label.textContent = 'Claude 오프라인';
  }
}

/** 페이지 로드 시 Claude 상태 배지 초기화 */
// ── 트래커 연결 상태 배지 ─────────────────────────────────────────────────
function _initTrackerStatusBadge() {
  // 배지 컨테이너 생성
  let badge = document.getElementById('tracker-status-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'tracker-status-badge';
    badge.style.cssText = `
      position:fixed; top:44px; right:14px; z-index:90;
      background:rgba(13,17,23,0.92); border:1px solid #30363d;
      border-radius:8px; padding:6px 12px;
      font-family:-apple-system,'Segoe UI',sans-serif;
      font-size:11px; color:#8b949e;
      backdrop-filter:blur(12px);
      display:flex; align-items:center; gap:6px;
      cursor:default; user-select:none;
      transition:all .3s ease;
    `;
    badge.innerHTML = `<span id="tracker-dot" style="width:7px;height:7px;border-radius:50%;background:#484f58;display:inline-block"></span><span id="tracker-label">확인 중…</span><button id="tracker-close-btn" style="background:none;border:none;color:#6e7681;font-size:13px;cursor:pointer;padding:0 0 0 4px;line-height:1" title="닫기">✕</button>`;
    badge.querySelector('#tracker-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      badge.style.display = 'none';
    });
    document.body.appendChild(badge);
  }

  const updateStatus = async () => {
    const token = typeof _getAuthToken === 'function' ? _getAuthToken() : '';
    badge.style.display = 'flex';
    try {
      const r = await fetch('/api/tracker/status', {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      const d = await r.json();
      const dot   = document.getElementById('tracker-dot');
      const label = document.getElementById('tracker-label');
      if (d.online) {
        dot.style.background = '#3fb950';
        dot.style.boxShadow  = '0 0 6px #3fb950';
        label.textContent = `트래커 연결됨${d.hostname ? ' · ' + d.hostname : ''}`;
        badge.style.borderColor = '#23893680';
      } else if (d.eventCount > 0) {
        dot.style.background = '#d29922';
        dot.style.boxShadow  = '0 0 4px #d29922';
        label.textContent = '트래커 설치됨 · 실행 필요';
        badge.style.borderColor = '#d2992240';
      } else {
        dot.style.background = '#f85149';
        dot.style.boxShadow  = 'none';
        label.textContent = '트래커 미연결';
        badge.style.borderColor = '#f8514950';
      }
    } catch {
      badge.style.display = 'none';
    }
  };

  // 첫 체크: 2초 후 (로그인 상태 복원 이후), 이후 60초마다
  setTimeout(updateStatus, 2000);
  setInterval(updateStatus, 60000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⬡ 온보딩 플로우 — 첫 방문 / 재방문 간소화
// ═══════════════════════════════════════════════════════════════════════════════

async function checkOnboardingState() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  // 자동 완료 처리 (모달 표시 없이 즉시 통과)
  if (localStorage.getItem('orbit_onboarding_done') !== '1') {
    localStorage.setItem('orbit_onboarding_done', '1');
    localStorage.setItem('orbit_onboarding_visited', '1');
    try {
      const token = _getAuthToken();
      if (token) {
        fetch('/api/tracker/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ hostname: navigator.userAgent.slice(0, 50), eventCount: 1 }),
        }).catch(e => console.warn('[tracker] ping 실패:', e.message));
      }
    } catch {}
  }
  return;
}

function showOnboardingOverlay(mode) {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  if (mode === 'first') {
    overlay.innerHTML = `
      <div class="ob-box">
        <div class="ob-logo">⬡</div>
        <div class="ob-title">Orbit AI 설치하기</div>
        <div class="ob-desc">
          업무 패턴을 자동으로 분석하고<br>
          AI가 맞춤 인사이트를 제공합니다.
        </div>
        <button class="ob-btn-install" onclick="showOnboardingInstall()">
          📦 설치하기
        </button>
        <button class="ob-btn-skip" onclick="showOnboardingSkipWarning()">
          건너뛰기
        </button>
      </div>`;
  } else {
    // returning
    overlay.innerHTML = `
      <div class="ob-return-box">
        <div class="ob-title">⬡ Orbit AI 트래커 상태</div>
        <div class="ob-desc">트래커 연결이 확인되지 않았습니다.</div>
        <div class="ob-return-btns" style="flex-direction:column;gap:8px">
          <button class="ob-btn-install-sm" onclick="confirmOnboardingDone()" style="width:100%">✓ 이미 설치했어요</button>
          <button class="ob-btn-install-sm" onclick="showOnboardingInstall()" style="width:100%;background:linear-gradient(135deg,#21262d,#30363d)">📦 설치하기</button>
          <button class="ob-btn-later" onclick="dismissOnboarding(true)">나중에</button>
        </div>
      </div>`;
  }

  overlay.classList.add('open');
}

function showOnboardingInstall() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  const status = detectClientEnv();
  const { os } = status;
  const _token       = _getAuthToken();
  const _installCmd  = os === 'windows'
    ? `powershell -ExecutionPolicy Bypass -Command "& {$env:ORBIT_TOKEN='${_token||''}'; iex (irm '${location.origin}/setup/install.ps1')}"`
    : `ORBIT_TOKEN='${_token||''}' bash <(curl -sL '${location.origin}/setup/orbit-start.sh')`;

  const osLabel = os === 'mac' ? 'macOS / Linux' : os === 'windows' ? 'Windows PowerShell' : 'Linux';

  overlay.innerHTML = `
    <div class="ob-box">
      <div class="ob-logo">⬡</div>
      <div class="ob-title">터미널에서 실행하세요</div>
      <div class="ob-desc">${osLabel} 터미널을 열고 아래 명령어를 붙여넣으세요.</div>
      <div class="ob-cmd-box">
        <div class="ob-cmd-label">${osLabel}</div>
        <div class="ob-cmd-code" id="ob-cmd-text">${_installCmd}</div>
        <button class="ob-copy-btn" onclick="copyOnboardingCmd()">복사</button>
      </div>
      <div class="ob-hint">설치가 완료되면 아래 버튼을 눌러주세요.</div>
      <button class="ob-btn-install" onclick="confirmOnboardingDone()" style="margin-top:16px">
        ✓ 설치 완료
      </button>
      <button class="ob-btn-skip" onclick="dismissOnboarding(false)" style="margin-top:8px">닫기</button>
    </div>`;
}

function copyOnboardingCmd() {
  const code = document.getElementById('ob-cmd-text');
  if (!code) return;
  navigator.clipboard.writeText(code.textContent).then(() => {
    const btn = document.querySelector('.ob-copy-btn');
    if (btn) { btn.textContent = '✓ 복사됨'; setTimeout(() => { btn.textContent = '복사'; }, 2000); }
  }).catch(e => console.warn('[clipboard] 복사 실패:', e.message));
}

function showOnboardingSkipWarning() {
  const overlay = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  overlay.innerHTML = `
    <div class="ob-box">
      <div class="ob-warning">
        <strong>⚠ 설치하지 않으면</strong> 업무 효율 AI를 활성화할 수 없습니다.<br>
        트래커가 업무 패턴을 수집해야 AI 분석이 시작됩니다.
      </div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="ob-btn-install-sm" onclick="showOnboardingInstall()">설치하기</button>
        <button class="ob-btn-later" onclick="dismissOnboarding(true)">계속 건너뛰기</button>
      </div>
    </div>`;
}

function confirmOnboardingDone() {
  localStorage.setItem('orbit_onboarding_done', '1');
  dismissOnboarding(false);
  // 서버에 트래커 핑 전송 (로그인 상태면 자동 등록)
  const token = _getAuthToken();
  if (token) {
    fetch('/api/tracker/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ hostname: navigator.userAgent.slice(0, 50), eventCount: 1 }),
    }).catch(e => console.warn('[tracker] 설치완료 ping 실패:', e.message));
  }
  // 트래커 배지 새로고침
  if (typeof _initTrackerStatusBadge === 'function') _initTrackerStatusBadge();
}

function dismissOnboarding(markSkipped) {
  if (markSkipped) {
    localStorage.setItem('orbit_onboarding_skipped_at', String(Date.now()));
  }
  const overlay = document.getElementById('onboarding-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.innerHTML = '';
  }
}

// 전역 노출
window.checkOnboardingState       = checkOnboardingState;
window.showOnboardingOverlay      = showOnboardingOverlay;
window.showOnboardingInstall      = showOnboardingInstall;
window.copyOnboardingCmd          = copyOnboardingCmd;
window.showOnboardingSkipWarning  = showOnboardingSkipWarning;
window.dismissOnboarding          = dismissOnboarding;
window.confirmOnboardingDone      = confirmOnboardingDone;

async function initClaudeStatusBadge() {
  try {
    const r    = await fetch('/api/setup/claude-status');
    const data = await r.json();
    _updateTrackingBadge(data.tracking, data.running);

    // 신규 사용자 감지 (훅 미등록) → 간소화된 온보딩 플로우
    if (!data.hookRegistered) {
      setTimeout(checkOnboardingState, 1500);
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🖥️ 실행 패널 — diff 미리보기 → 승인 → 실행 로그
// ═══════════════════════════════════════════════════════════════════════════════

let _execCmdId   = null;   // 현재 대기 중인 명령 ID
let _execRequest = null;   // { type, hash, projectDir, description }

/** 실행 패널 열기 — 진입점 */
async function openExecPanel(request) {
  _execRequest = request;
  const panel = document.getElementById('exec-panel');

  // 다른 패널 닫기
  document.getElementById('insight-panel')?.classList.remove('open');
  document.getElementById('info-panel')?.classList.remove('open');
  document.getElementById('llm-panel')?.classList.remove('open');

  panel.classList.add('open');
  _showExecLoading(`${request.description || request.type} 미리보기 생성 중…`);

  // 모델 선택기 로드 (첫 번째 열기 시)
  if (!document.getElementById('ep-model-select')?.options.length) {
    await loadExecModelOptions();
  }

  // AI 연결 상태 확인
  let aiConnected = false;
  try {
    const r = await fetch('/api/orbit-cmd/ai-status');
    aiConnected = (await r.json()).connected;
  } catch {}

  // 선택된 provider::model 파싱
  const selVal   = document.getElementById('ep-model-select')?.value || 'ollama::orbit-insight:v1';
  const [selProvider, selModel] = selVal.includes('::') ? selVal.split('::') : ['ollama', selVal];

  // 모드 배지
  const badge = document.getElementById('ep-mode-badge');
  if (aiConnected && selProvider === 'ollama') {
    badge.textContent = 'AI 연결됨'; badge.className = 'ep-mode-badge ep-mode-ai';
  } else {
    const pIcon = _execProviders.find(p => p.provider === selProvider)?.icon || '🟡';
    badge.textContent = `${pIcon} ${selProvider}`; badge.className = 'ep-mode-badge ep-mode-ollama';
  }

  // generate 요청
  try {
    const resp = await fetch('/api/orbit-cmd/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type:        request.type,
        hash:        request.hash,
        projectDir:  request.projectDir,
        instruction: request.instruction,
        provider:    selProvider,
        model:       selModel,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || resp.statusText);
    _execCmdId = data.id;
    _showExecPreview(data.preview, data.cmds, data.mode);
  } catch (err) {
    _showExecError(err.message);
  }
}
window.openExecPanel = openExecPanel;

function closeExecPanel() {
  document.getElementById('exec-panel').classList.remove('open');
  _execCmdId = null; _execRequest = null;
}
window.closeExecPanel = closeExecPanel;

// ── 내부 렌더 헬퍼 ────────────────────────────────────────────────────────────

function _showExecLoading(msg) {
  document.getElementById('ep-body').innerHTML = `
    <div class="ep-loading">
      <div class="ep-spinner"></div>
      <div class="ep-loading-msg">${escHtml(msg)}</div>
    </div>`;
  document.getElementById('ep-actions').style.display = 'none';
}

function _showExecPreview(preview, cmds, mode) {
  const isAi = mode === 'ai';
  document.getElementById('ep-body').innerHTML = `
    <div class="ep-preview-label">변경 미리보기</div>
    <div class="ep-diff">${_colorDiff(escHtml(preview))}</div>
    ${!isAi ? `
    <div class="ep-model-row">
      <span class="ep-model-label">모델</span>
      <select class="ep-model-select" id="ep-model-select">
        <option value="orbit-insight:v1">orbit-insight:v1 (기본)</option>
        <option value="codellama:13b">codellama:13b (정밀)</option>
        <option value="llama3:8b">llama3:8b (빠름)</option>
      </select>
    </div>
    <div class="ep-instr-row">
      <textarea class="ep-instr-input" id="ep-instr-input" rows="2"
        placeholder="추가 지시 (선택) — &quot;이 부분은 유지하고 저것만 수정해&quot;"></textarea>
    </div>` : ''}
  `;
  const acts = document.getElementById('ep-actions');
  acts.style.display = 'flex';
  acts.innerHTML = `
    ${!isAi
      ? `<button class="ep-btn ep-btn-regen" onclick="_regenExec()">↺ 재생성</button>`
      : ''}
    <button class="ep-btn ep-btn-apply"  onclick="_applyExec()">
      ${isAi ? '✅ AI에 전달됨 (닫기)' : '✅ 적용'}
    </button>
    <button class="ep-btn ep-btn-cancel" onclick="closeExecPanel()">✕</button>
  `;
  if (isAi) {
    // AI 모드면 적용 버튼이 닫기 역할
    document.querySelector('.ep-btn-apply').onclick = closeExecPanel;
  }
}

function _showExecRunning() {
  document.getElementById('ep-body').innerHTML =
    `<div class="ep-preview-label">실행 중…</div><div class="ep-log" id="ep-log-box"></div>`;
  document.getElementById('ep-actions').style.display = 'none';
}

function _showExecDone(success, msg) {
  document.getElementById('ep-body').innerHTML += `
    <div class="ep-done-banner">
      <div class="ep-done-icon">${success ? '✅' : '❌'}</div>
      <div class="ep-done-msg">${success ? '완료' : '실패'}</div>
      <div class="ep-done-sub">${escHtml(msg || '')}</div>
    </div>`;
  const acts = document.getElementById('ep-actions');
  acts.style.display = 'flex';
  acts.innerHTML = `<button class="ep-btn ep-btn-apply" onclick="closeExecPanel()">닫기</button>`;
}

function _showExecError(msg) {
  document.getElementById('ep-body').innerHTML = `
    <div style="color:#f85149;font-size:12px;padding:16px 0;">
      ❌ 오류: ${escHtml(msg)}
    </div>`;
  const acts = document.getElementById('ep-actions');
  acts.style.display = 'flex';
  acts.innerHTML = `<button class="ep-btn ep-btn-cancel" onclick="closeExecPanel()">닫기</button>`;
}

/** diff 텍스트에 색상 span 적용 */
function _colorDiff(html) {
  return html.split('\n').map(line => {
    if (line.startsWith('+'))  return `<span style="color:#3fb950">${line}</span>`;
    if (line.startsWith('-'))  return `<span style="color:#f85149">${line}</span>`;
    if (line.startsWith('@@')) return `<span style="color:#6e7681">${line}</span>`;
    return line;
  }).join('\n');
}

/** 재생성 — 추가 지시 반영 */
async function _regenExec() {
  const extra = document.getElementById('ep-instr-input')?.value || '';
  await openExecPanel({ ..._execRequest, instruction: extra || _execRequest?.instruction });
}

/** 실행 승인 — SSE 스트리밍 */
async function _applyExec() {
  if (!_execCmdId) return;
  _showExecRunning();

  const logBox = document.getElementById('ep-log-box');
  const append = (cls, text) => {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    logBox.appendChild(span);
    logBox.scrollTop = logBox.scrollHeight;
  };

  try {
    const resp = await fetch('/api/orbit-cmd/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: _execCmdId }),
    });

    if (!resp.ok) {
      const err = await resp.json();
      return _showExecError(err.error || resp.statusText);
    }

    const reader = resp.body.getReader();
    const dec    = new TextDecoder();
    let   buf    = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.type === 'cmd')      append('log-cmd',    `$ ${ev.cmd}\n`);
          if (ev.type === 'stdout')   append('log-stdout', ev.text);
          if (ev.type === 'stderr')   append('log-stderr', ev.text);
          if (ev.type === 'cmd_done' && ev.exitCode === 0) append('log-ok', `✓ 완료\n`);
          if (ev.type === 'error')    append('log-err',    `✗ ${ev.msg}\n`);
          if (ev.type === 'done')     _showExecDone(ev.exitCode === 0, '모든 명령 완료');
        } catch {}
      }
    }
  } catch (err) {
    _showExecError(err.message);
  }
}
window._regenExec  = _regenExec;
window._applyExec  = _applyExec;

// [extracted to orbit3d-drilldown.js]: focusProject, exitConstellationFocus,
// drillToCategory, drillToFileDetail, focusCategoryView, exitCategoryFocus
