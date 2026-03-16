"use strict";async function openLlmPanel(){const e=document.getElementById("llm-panel");document.getElementById("insight-panel")?.classList.remove("open"),document.getElementById("info-panel")?.classList.remove("open"),e.classList.add("open"),await renderLlmPanel()}function closeLlmPanel(){document.getElementById("llm-panel").classList.remove("open")}window.openLlmPanel=openLlmPanel,window.closeLlmPanel=closeLlmPanel;async function renderLlmPanel(){const e=document.getElementById("lp-body");e.innerHTML='<div style="padding:24px;text-align:center;color:#6e7681;font-size:12px;">불러오는 중…</div>';try{const[t,o]=await Promise.all([fetch("/api/llm-settings/providers").then(i=>i.json()),fetch("/api/llm-settings/ollama-models").then(i=>i.json())]),n=t.providers||[],s=o.models||[];e.innerHTML=n.map(i=>_renderProviderRow(i,s)).join("")}catch(t){e.innerHTML=`<div style="padding:16px;color:#f85149;font-size:12px;">❌ ${escHtml(t.message)}</div>`}}window.renderLlmPanel=renderLlmPanel;function _renderProviderRow(e,t){const o=e.provider==="ollama",n=o?t:e.models||[],s=e.defaultModel||"",i=o?t.length?t.map(c=>`<option value="${escHtml(c.id)}" ${c.id===s?"selected":""}>${escHtml(c.label)}${c.size?" ("+c.size+")":""}</option>`).join(""):'<option value="">Ollama 실행 안됨</option>':n.map(c=>`<option value="${escHtml(c.id)}" ${c.id===s?"selected":""}>
          ${escHtml(c.label)} — ${c.tier||""}
        </option>`).join(""),a=e.enabled&&(o||e.configured)?"checked":"",l=o?'<span style="font-size:10px;color:#3fb950;padding:2px 7px;background:rgba(63,185,80,.1);border-radius:8px;">기본값</span>':`<label class="lp-toggle">
         <input type="checkbox" ${a} onchange="toggleLlmProvider('${e.provider}', this.checked)">
         <span class="lp-toggle-track"></span>
       </label>`,d=o?`
    <div class="lp-ollama-models">
      ${t.length?t.map(c=>`<span class="lp-model-tag">${escHtml(c.label)}</span>`).join(""):'<span style="font-size:10px;color:#6e7681;">Ollama가 실행 중이지 않습니다</span>'}
    </div>`:`
    <div class="lp-key-row">
      <input class="lp-key-input" type="password" id="lp-key-${e.provider}"
        placeholder="${escHtml(e.keyHint||"API 키 입력...")}"
        ${e.configured?'value="••••••••"':""}>
      <button class="lp-btn-save" onclick="saveLlmKey('${e.provider}')">저장</button>
      ${e.configured?`<button class="lp-btn-del" onclick="deleteLlmKey('${e.provider}')" title="삭제">🗑</button>`:""}
    </div>
    <div style="display:flex;gap:6px;align-items:center;">
      ${e.configured?`<button class="lp-btn-test" onclick="testLlmProvider('${e.provider}')">🔌 연결 테스트</button>`:""}
      <div class="lp-status info" id="lp-status-${e.provider}">
        ${e.configured?"✅ API 키 등록됨":""}
      </div>
    </div>`;return`<div class="lp-provider" id="lp-prov-${e.provider}">
    <div class="lp-prov-hdr">
      <span class="lp-prov-icon">${e.icon}</span>
      <div style="flex:1">
        <div class="lp-prov-name">${escHtml(e.name)}</div>
        <div class="lp-prov-desc">${escHtml(e.description||"")}</div>
      </div>
      ${l}
    </div>
    ${d}
    ${n.length?`<select class="lp-model-select" id="lp-model-${e.provider}"
           onchange="setDefaultLlmModel('${e.provider}', this.value)">
           ${i}
         </select>`:""}
  </div>`}async function saveLlmKey(e){const o=document.getElementById(`lp-key-${e}`)?.value?.trim();if(!o||o.startsWith("•")){showToast("API 키를 입력하세요");return}const n=document.getElementById(`lp-status-${e}`);n&&(n.className="lp-status info",n.textContent="저장 중…");try{const s=document.getElementById(`lp-model-${e}`)?.value,i=await fetch("/api/llm-settings/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:e,apiKey:o,defaultModel:s})}),a=await i.json();if(!i.ok)throw new Error(a.error);n&&(n.className="lp-status ok",n.textContent="✅ 저장됨"),showToast(`${e} API 키 저장 완료`),await renderLlmPanel(),await loadExecModelOptions()}catch(s){n&&(n.className="lp-status err",n.textContent=`❌ ${s.message}`)}}window.saveLlmKey=saveLlmKey;async function deleteLlmKey(e){await fetch(`/api/llm-settings/keys/${e}`,{method:"DELETE"}),showToast(`${e} API 키 삭제됨`),await renderLlmPanel(),await loadExecModelOptions()}window.deleteLlmKey=deleteLlmKey;async function toggleLlmProvider(e,t){await fetch(`/api/llm-settings/keys/${e}/toggle`,{method:"PATCH"}),await loadExecModelOptions()}window.toggleLlmProvider=toggleLlmProvider;async function testLlmProvider(e){const t=document.getElementById(`lp-status-${e}`);t&&(t.className="lp-status info",t.textContent="테스트 중…");try{const n=await(await fetch("/api/llm-settings/test",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:e})})).json();if(n.ok)t&&(t.className="lp-status ok",t.textContent=`✅ 연결됨 — "${n.response?.slice(0,30)}"…`);else throw new Error(n.error)}catch(o){t&&(t.className="lp-status err",t.textContent=`❌ ${o.message.slice(0,60)}`)}}window.testLlmProvider=testLlmProvider;function setDefaultLlmModel(e,t){fetch("/api/llm-settings/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({provider:e,apiKey:"(keep)",defaultModel:t})}).catch(o=>console.warn("[llm] 기본 모델 설정 실패:",o.message))}window.setDefaultLlmModel=setDefaultLlmModel;let _execProviders=[];async function loadExecModelOptions(){try{const[e,t]=await Promise.all([fetch("/api/llm-settings/providers").then(s=>s.json()),fetch("/api/llm-settings/ollama-models").then(s=>s.json())]);_execProviders=e.providers||[];const o=t.models||[],n=document.getElementById("ep-model-select");if(!n)return;n.innerHTML="",_execProviders.forEach(s=>{if(!s.enabled&&!s.isDynamic&&s.provider!=="ollama")return;const i=document.createElement("optgroup");i.label=`${s.icon} ${s.name}`;const a=s.provider==="ollama"?o:s.models||[];if(a.length)a.forEach(l=>{const d=document.createElement("option");d.value=`${s.provider}::${l.id}`,d.textContent=l.label||l.id,l.id===s.defaultModel&&(d.selected=!0),i.appendChild(d)});else{const l=document.createElement("option");l.disabled=!0,l.textContent="(모델 없음)",i.appendChild(l)}n.appendChild(i)})}catch{}}window.loadExecModelOptions=loadExecModelOptions;let _setupStatus=null;function showInstallModal(){document.getElementById("install-modal")?.remove();const e=navigator.userAgent||"",t=/Windows/i.test(e),o=/Mac OS X/i.test(e),n=location.origin,s=`powershell -ExecutionPolicy Bypass -Command "irm ${n}/orbit-setup.ps1 | iex"`,i=`bash <(curl -sL ${n}/orbit-setup.sh)`,l=t?s:o?i:i,d=t?"🪟 CMD 또는 PowerShell":"🖥️ 터미널",c=document.createElement("div");c.id="install-modal",c.style.cssText=`
    position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:10000;
    display:flex;align-items:center;justify-content:center;padding:16px;
  `,c.innerHTML=`
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
            <div style="font-size:13px;font-weight:600;color:#f0f6fc;margin-bottom:4px">${d} 열기</div>
            <div style="font-size:11px;color:#8b949e;line-height:1.6">
              ${t?'<kbd style="background:#21262d;padding:2px 6px;border-radius:3px">Win + R</kbd> → <b style="color:#cdd9e5">powershell</b> 입력 → Enter':'<kbd style="background:#21262d;padding:2px 6px;border-radius:3px">Spotlight</kbd> → Terminal 검색 → Enter'}
            </div>
          </div>
        </div>

        <!-- 단계 2 -->
        <div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:18px">
          <div style="width:24px;height:24px;background:#1f6feb;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">2</div>
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:#f0f6fc;margin-bottom:6px">아래 명령어 복사 → 붙여넣기 (<kbd style="background:#21262d;padding:1px 5px;border-radius:3px;font-size:10px">Ctrl+V</kbd>) → Enter</div>
            <div style="position:relative;background:#010409;border:1px solid #21262d;border-radius:8px;padding:12px 44px 12px 14px">
              <code id="install-cmd" style="font-family:'Consolas','Courier New',monospace;font-size:11.5px;color:#3fb950;word-break:break-all;line-height:1.6">${escHtml(l)}</code>
              <button onclick="copyInstallScript()" id="copy-script-btn"
                style="position:absolute;top:8px;right:8px;background:#1f6feb;border:none;border-radius:5px;
                color:#fff;font-size:10px;font-weight:600;padding:3px 8px;cursor:pointer">복사</button>
            </div>
            <div style="font-size:10px;color:#6e7681;margin-top:6px;line-height:1.6">
              ✓ Orbit 다운로드 → ✓ 훅 등록 → ✓ 서버 시작 → ✓ 앱·웹·키입력 트래킹 시작
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
  `,document.body.appendChild(c),c.addEventListener("click",r=>{r.target===c&&c.remove()})}function copyInstallScript(){const e=document.getElementById("install-cmd")||document.getElementById("install-script-box");e&&navigator.clipboard.writeText(e.textContent||"").then(()=>{const t=document.getElementById("copy-script-btn");t&&(t.textContent="✅ 복사됨",setTimeout(()=>t.textContent="복사",2e3))}).catch(()=>{const t=e.textContent,o=document.createElement("textarea");o.value=t,document.body.appendChild(o),o.select(),document.execCommand("copy"),document.body.removeChild(o),alert("복사됨!")})}function markSetupDone(){confirm(`✅ 이 컴퓨터에서 설치 명령어를 실행하고
Orbit 서버가 정상 시작됐나요?

(설치 중 오류가 있었다면 "취소"를 눌러주세요)`)&&(localStorage.setItem("orbit_ollama_ok","1"),localStorage.setItem("orbit_hook_ok","1"),document.getElementById("install-modal")?.remove(),document.getElementById("env-check-banner")?.remove(),renderSetupPanel(),showToast("✅ 이 컴퓨터에서 설치 완료 확인됨! Orbit AI가 데이터를 수집합니다."))}function _autoCheckEnvAfterLogin(){}async function openSetupPanel(){document.getElementById("llm-panel")?.classList.remove("open"),document.getElementById("insight-panel")?.classList.remove("open"),document.getElementById("info-panel")?.classList.remove("open"),document.getElementById("setup-panel").classList.add("open"),await renderSetupPanel(),_loadPersonalStats()}function closeSetupPanel(){document.getElementById("setup-panel").classList.remove("open")}window.openSetupPanel=openSetupPanel,window.closeSetupPanel=closeSetupPanel;function detectClientEnv(){const e=navigator.userAgent||"";let t="linux";/Windows/i.test(e)?t="windows":/Mac OS X/i.test(e)&&(t="mac");const o=localStorage.getItem("orbit_ollama_ok")==="1",n=localStorage.getItem("orbit_hook_ok")==="1";return{os:t,nodeVersion:"N/A",ollama:{installed:o,running:o,models:[]},hook:{registered:n},claude:{running:!1},ready:o&&n}}function openAutoSetup(){window.open("http://localhost:4747/setup.html","orbit_setup","width=740,height=680,toolbar=0,menubar=0,scrollbars=1")}function confirmOllama(){localStorage.setItem("orbit_ollama_ok","1"),renderSetupPanel(),document.getElementById("env-check-banner")?.remove()}function confirmHook(){localStorage.setItem("orbit_hook_ok","1"),renderSetupPanel(),document.getElementById("env-check-banner")?.remove()}function resetEnvConfirm(){localStorage.removeItem("orbit_ollama_ok"),localStorage.removeItem("orbit_hook_ok"),renderSetupPanel()}window.addEventListener("message",e=>{if(e.data?.type==="orbit_setup_done"){localStorage.setItem("orbit_ollama_ok","1"),localStorage.setItem("orbit_hook_ok","1"),renderSetupPanel(),document.getElementById("env-check-banner")?.remove();const t=document.createElement("div");t.style.cssText="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#238636;color:#fff;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:600;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.4)",t.textContent="✅ 설정 완료! Orbit AI가 데이터를 수집합니다.",document.body.appendChild(t),setTimeout(()=>t.remove(),4e3)}}),window.openAutoSetup=openAutoSetup,window.confirmOllama=confirmOllama,window.confirmHook=confirmHook,window.resetEnvConfirm=resetEnvConfirm,window.showInstallModal=showInstallModal,window.copyInstallScript=copyInstallScript,window.markSetupDone=markSetupDone;async function startOllamaServer(){const e=document.querySelector('button[onclick="startOllamaServer()"]');e&&(e.textContent="⏳ 시작 중…",e.disabled=!0);try{const t=localStorage.getItem("orbit_port")||"4747";(await fetch(`http://localhost:${t}/api/setup/start-ollama`,{method:"POST"})).ok?(typeof showToast=="function"&&showToast("✅ Ollama 서버 시작 완료",3e3),setTimeout(()=>renderSetupPanel(),2500)):(typeof showToast=="function"&&showToast("❌ 시작 실패 — 터미널에서 ollama serve 실행",4e3),e&&(e.textContent="▶ Ollama 서버 시작",e.disabled=!1))}catch{typeof showToast=="function"&&showToast("❌ 서버 연결 실패 — 로컬 서버가 실행 중인지 확인",4e3),e&&(e.textContent="▶ Ollama 서버 시작",e.disabled=!1)}}window.startOllamaServer=startOllamaServer;async function renderSetupPanel(){const e=document.getElementById("sp-body");e.innerHTML='<div style="padding:24px;text-align:center;color:#6e7681;font-size:12px;">환경 감지 중…</div>';const t=detectClientEnv();_setupStatus=t;const{os:o}=t,n=o==="mac"?"🍎":o==="windows"?"🪟":"🐧";let s=!1,i="",a=0;try{const u=await(await _authFetch("/api/tracker/status")).json();s=u.online,i=u.hostname||"",a=u.eventCount||0}catch{}const l=s?`<div class="sp-check-card" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;width:100%;align-items:center">
          <div class="sp-check-label">트래커</div>
          <div class="sp-check-val sp-check-ok">🟢 연결됨</div>
        </div>
        <div style="font-size:10px;color:#6e7681">${i?i+" · ":""}${a}개 이벤트</div>
      </div>`:`<div class="sp-check-card" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;width:100%;align-items:center">
          <div class="sp-check-label">트래커</div>
          <div class="sp-check-val sp-check-warn">🔴 미연결</div>
        </div>
        <div style="font-size:10px;color:#6e7681">아래 설치 명령어를 PC에서 실행하세요</div>
      </div>`,c=[{label:"OS",val:`${n} ${o}`,cls:"sp-check-neutral"}].map(b=>`
    <div class="sp-check-card">
      <div class="sp-check-label">${b.label}</div>
      <div class="sp-check-val ${b.cls}">${escHtml(b.val)}</div>
    </div>`).join("")+l+`<div class="sp-check-card" style="flex-direction:column;align-items:flex-start;gap:4px">
      <div style="display:flex;width:100%;align-items:center">
        <div class="sp-check-label">AI 분석</div>
        <div class="sp-check-val sp-check-ok">☁️ Haiku</div>
      </div>
      <div style="font-size:10px;color:#6e7681">클라우드 AI — 로컬 설치 불필요</div>
    </div>`,r=_getAuthToken(),p=location.origin+"/orbit-setup.ps1"+(r?`?token=${encodeURIComponent(r)}`:""),f=location.origin+"/orbit-setup.sh"+(r?`?token=${encodeURIComponent(r)}`:""),y=o==="windows"?`irm '${p}' | iex`:`bash <(curl -sL '${f}')`,x=`
    <div class="sp-section">📦 설치 / 업데이트 <span style="font-size:9px;color:#6e7681;text-transform:none;font-weight:400">— 1~2분 소요</span></div>

    ${r?`<div style="font-size:11px;color:#3fb950;background:rgba(63,185,80,.08);
           border:1px solid rgba(63,185,80,.2);border-radius:6px;padding:6px 10px;margin-bottom:7px">
           ✅ 내 계정 토큰 포함 — 실행하면 자동으로 내 계정에 연동됩니다
         </div>`:`<div style="font-size:11px;color:#f0a82e;background:rgba(240,168,46,.08);
           border:1px solid rgba(240,168,46,.2);border-radius:6px;padding:6px 10px;margin-bottom:7px">
           ⚠ 로그인하면 토큰이 포함된 개인화 명령어를 받을 수 있습니다
         </div>`}

    <div style="background:#010409;border:1px solid #21262d;border-radius:8px;
      padding:10px 12px;margin-bottom:8px;position:relative">
      <div style="font-size:10px;color:#6e7681;margin-bottom:5px">
        ${o==="windows"?"🪟 PowerShell (Win+R → powershell → Enter)":"🖥️ 터미널"}
      </div>
      <code id="sp-install-inline-cmd"
        style="font-family:'Consolas','Courier New',monospace;font-size:11px;
        color:#3fb950;word-break:break-all;line-height:1.6;display:block;
        padding-right:52px">${escHtml(y)}</code>
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
  `,m=_getDataSource()||"cloud",g=localStorage.getItem(DATA_SOURCE_ACCOUNT_KEY)||"",v=`
    <div class="sp-section">📂 데이터 소스</div>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button id="sp-ds-cloud" onclick="_setDataSourceFromSettings('cloud')"
        style="flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;
        border:1px solid ${m==="cloud"?"#1f6feb":"#30363d"};
        background:${m==="cloud"?"rgba(31,111,235,.15)":"#161b22"};
        color:${m==="cloud"?"#58a6ff":"#8b949e"}">
        &#9729; 클라우드 동기화
      </button>
      <button id="sp-ds-local" onclick="_setDataSourceFromSettings('local')"
        style="flex:1;padding:10px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;
        border:1px solid ${m==="local"?"#1f6feb":"#30363d"};
        background:${m==="local"?"rgba(31,111,235,.15)":"#161b22"};
        color:${m==="local"?"#58a6ff":"#8b949e"}">
        &#128187; 로컬 데이터
      </button>
    </div>
    <div style="font-size:11px;color:#6e7681;line-height:1.5;margin-bottom:4px">
      ${m==="cloud"?"같은 계정으로 로그인하면 어떤 PC에서든 동일한 데이터를 봅니다.":"이 PC의 로컬 데이터만 작업 화면에 표시됩니다."}
      ${g?'<br>연결 계정: <b style="color:#cdd9e5">'+g+"</b>":""}
    </div>
  `;e.innerHTML=`
    <div class="sp-check-grid">${c}</div>
    ${x}
    ${v}

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

    ${_getAuthToken()?`
    <div class="sp-section" style="margin-top:12px">🔑 CLI 연동 토큰</div>
    <div style="font-size:12px;color:#8b949e;margin-bottom:6px;line-height:1.5">
      설치 스크립트 실행 후 <code style="color:#7ee787">~/.orbit-config.json</code>에<br>
      아래 토큰을 넣으면 내 계정으로 이벤트가 저장됩니다.
    </div>
    <div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:11px;font-family:monospace;color:#e6edf3;word-break:break-all;margin-bottom:6px">
      ${JSON.stringify({serverUrl:location.origin,token:_getAuthToken()},null,2).replace(/</g,"&lt;")}
    </div>
    <button class="sp-btn sp-btn-outline" style="font-size:11px;width:100%"
      onclick="_copyCliConfig()">📋 ~/.orbit-config.json 내용 복사</button>
    `:""}

    <button class="sp-btn sp-btn-outline" onclick="renderSetupPanel()" style="margin-top:12px">
      ↺ 상태 새로고침
    </button>
  `}window.renderSetupPanel=renderSetupPanel;function _copyCliConfig(){const e=_getAuthToken();if(!e){showToast("로그인 필요","warn");return}const t=JSON.stringify({serverUrl:location.origin,token:e},null,2);navigator.clipboard.writeText(t).then(()=>{showToast("✅ 클립보드에 복사됨 — ~/.orbit-config.json 파일에 붙여넣기 하세요","success")}).catch(()=>{prompt("내용을 복사하세요 (Ctrl+A → Ctrl+C):",t)})}window._copyCliConfig=_copyCliConfig;async function _loadInstallScript(e){try{const t=typeof _orbitUser<"u"?_orbitUser:null,o=t?.token||localStorage.getItem("orbitUser")&&JSON.parse(localStorage.getItem("orbitUser"))?.token||"",n=location.hostname!=="127.0.0.1"&&location.hostname!=="localhost"?location.origin:"",s=t?.name||"",i=new URLSearchParams({os:e});o&&i.set("token",o),n&&i.set("serverUrl",n),s&&i.set("memberName",s);const l=await(await fetch(`/api/setup/install-script?${i}`)).json(),d=document.getElementById("sp-script-box");d&&(d.textContent=l.script||"")}catch{}}async function copySetupScript(){const e=document.getElementById("sp-script-box");if(e)try{await navigator.clipboard.writeText(e.textContent),showToast("✅ 스크립트 복사 완료 — 터미널에 붙여넣기 하세요")}catch{showToast("복사 실패 — 직접 선택 후 복사하세요")}}window.copySetupScript=copySetupScript;async function registerHookOnly(){try{const t=await(await fetch("/api/setup/hook-register",{method:"POST"})).json();t.ok?(showToast("✅ Claude 훅 등록 완료"),await renderSetupPanel()):showToast(`❌ 실패: ${t.error}`)}catch(e){showToast(`❌ ${e.message}`)}}window.registerHookOnly=registerHookOnly;async function pullOllamaModel(){const e=document.getElementById("sp-model-select")?.value||"llama3.2:latest",t=document.getElementById("sp-pull-log");if(t){t.classList.add("active"),t.textContent=`⬇️ ${e} 다운로드 시작...
`;try{const n=(await fetch("/api/setup/ollama-pull",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:e})})).body.getReader(),s=new TextDecoder;let i="";for(;;){const{done:a,value:l}=await n.read();if(a)break;i+=s.decode(l,{stream:!0});const d=i.split(`

`);i=d.pop(),d.forEach(c=>{const r=c.match(/^data: (.+)$/m);if(r)try{const p=JSON.parse(r[1]);p.type==="stdout"||p.type==="stderr"?(t.textContent+=p.text,t.scrollTop=t.scrollHeight):p.type==="done"&&(t.textContent+=p.exitCode===0?`
✅ 완료!`:`
❌ 실패 (code ${p.exitCode})`,showToast(p.exitCode===0?`✅ ${e} 다운로드 완료`:"❌ 다운로드 실패"))}catch{}})}}catch(o){t.textContent+=`
❌ ${o.message}`}}}window.pullOllamaModel=pullOllamaModel;async function toggleClaudeTracking(e){try{const o=await(await fetch("/api/setup/claude-toggle",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled:e})})).json();showToast(o.tracking?"✅ Claude 트래킹 ON":"⏸ Claude 트래킹 OFF"),_updateTrackingBadge(o.tracking,_setupStatus?.claude?.running)}catch(t){showToast(`❌ ${t.message}`)}}window.toggleClaudeTracking=toggleClaudeTracking;function _updateTrackingBadge(e,t){const o=document.getElementById("claude-tracking-badge"),n=document.getElementById("ctb-dot"),s=document.getElementById("ctb-label");o&&(t&&e?(o.className="on",n&&(n.textContent="⬤"),s&&(s.textContent="Claude 트래킹 중")):t&&!e?(o.className="off",n&&(n.textContent="⬤"),s&&(s.textContent="Claude 일시정지")):(o.className="off",n&&(n.textContent="⬤"),s&&(s.textContent="Claude 오프라인")))}function _initTrackerStatusBadge(){let e=document.getElementById("tracker-status-badge");e||(e=document.createElement("div"),e.id="tracker-status-badge",e.style.cssText=`
      position:fixed; top:44px; right:14px; z-index:90;
      background:rgba(13,17,23,0.92); border:1px solid #30363d;
      border-radius:8px; padding:6px 12px;
      font-family:-apple-system,'Segoe UI',sans-serif;
      font-size:11px; color:#8b949e;
      backdrop-filter:blur(12px);
      display:flex; align-items:center; gap:6px;
      cursor:default; user-select:none;
      transition:all .3s ease;
    `,e.innerHTML='<span id="tracker-dot" style="width:7px;height:7px;border-radius:50%;background:#484f58;display:inline-block"></span><span id="tracker-label">확인 중…</span><button id="tracker-close-btn" style="background:none;border:none;color:#6e7681;font-size:13px;cursor:pointer;padding:0 0 0 4px;line-height:1" title="닫기">✕</button>',e.querySelector("#tracker-close-btn").addEventListener("click",o=>{o.stopPropagation(),e.style.display="none"}),document.body.appendChild(e));const t=async()=>{const o=typeof _getAuthToken=="function"?_getAuthToken():"";e.style.display="flex";try{const s=await(await fetch("/api/tracker/status",{headers:o?{Authorization:`Bearer ${o}`}:{}})).json(),i=document.getElementById("tracker-dot"),a=document.getElementById("tracker-label");s.online?(i.style.background="#3fb950",i.style.boxShadow="0 0 6px #3fb950",a.textContent=`트래커 연결됨${s.hostname?" · "+s.hostname:""}`,e.style.borderColor="#23893680"):s.eventCount>0?(i.style.background="#d29922",i.style.boxShadow="0 0 4px #d29922",a.textContent="트래커 설치됨 · 실행 필요",e.style.borderColor="#d2992240"):(i.style.background="#f85149",i.style.boxShadow="none",a.textContent="트래커 미연결",e.style.borderColor="#f8514950")}catch{e.style.display="none"}};setTimeout(t,2e3),setInterval(t,6e4)}async function checkOnboardingState(){if(document.getElementById("onboarding-overlay")&&localStorage.getItem("orbit_onboarding_done")!=="1"){localStorage.setItem("orbit_onboarding_done","1"),localStorage.setItem("orbit_onboarding_visited","1");try{const t=_getAuthToken();t&&fetch("/api/tracker/ping",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({hostname:navigator.userAgent.slice(0,50),eventCount:1})}).catch(o=>console.warn("[tracker] ping 실패:",o.message))}catch{}}}function showOnboardingOverlay(e){const t=document.getElementById("onboarding-overlay");t&&(e==="first"?t.innerHTML=`
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
      </div>`:t.innerHTML=`
      <div class="ob-return-box">
        <div class="ob-title">⬡ Orbit AI 트래커 상태</div>
        <div class="ob-desc">트래커 연결이 확인되지 않았습니다.</div>
        <div class="ob-return-btns" style="flex-direction:column;gap:8px">
          <button class="ob-btn-install-sm" onclick="confirmOnboardingDone()" style="width:100%">✓ 이미 설치했어요</button>
          <button class="ob-btn-install-sm" onclick="showOnboardingInstall()" style="width:100%;background:linear-gradient(135deg,#21262d,#30363d)">📦 설치하기</button>
          <button class="ob-btn-later" onclick="dismissOnboarding(true)">나중에</button>
        </div>
      </div>`,t.classList.add("open"))}function showOnboardingInstall(){const e=document.getElementById("onboarding-overlay");if(!e)return;const t=detectClientEnv(),{os:o}=t,n=_getAuthToken(),s=location.origin+"/orbit-setup.ps1"+(n?`?token=${encodeURIComponent(n)}`:""),i=location.origin+"/orbit-setup.sh"+(n?`?token=${encodeURIComponent(n)}`:""),a=o==="windows"?`irm '${s}' | iex`:`bash <(curl -sL '${i}')`,l=o==="mac"?"macOS / Linux":o==="windows"?"Windows PowerShell":"Linux";e.innerHTML=`
    <div class="ob-box">
      <div class="ob-logo">⬡</div>
      <div class="ob-title">터미널에서 실행하세요</div>
      <div class="ob-desc">${l} 터미널을 열고 아래 명령어를 붙여넣으세요.</div>
      <div class="ob-cmd-box">
        <div class="ob-cmd-label">${l}</div>
        <div class="ob-cmd-code" id="ob-cmd-text">${a}</div>
        <button class="ob-copy-btn" onclick="copyOnboardingCmd()">복사</button>
      </div>
      <div class="ob-hint">설치가 완료되면 아래 버튼을 눌러주세요.</div>
      <button class="ob-btn-install" onclick="confirmOnboardingDone()" style="margin-top:16px">
        ✓ 설치 완료
      </button>
      <button class="ob-btn-skip" onclick="dismissOnboarding(false)" style="margin-top:8px">닫기</button>
    </div>`}function copyOnboardingCmd(){const e=document.getElementById("ob-cmd-text");e&&navigator.clipboard.writeText(e.textContent).then(()=>{const t=document.querySelector(".ob-copy-btn");t&&(t.textContent="✓ 복사됨",setTimeout(()=>{t.textContent="복사"},2e3))}).catch(t=>console.warn("[clipboard] 복사 실패:",t.message))}function showOnboardingSkipWarning(){const e=document.getElementById("onboarding-overlay");e&&(e.innerHTML=`
    <div class="ob-box">
      <div class="ob-warning">
        <strong>⚠ 설치하지 않으면</strong> 업무 효율 AI를 활성화할 수 없습니다.<br>
        트래커가 업무 패턴을 수집해야 AI 분석이 시작됩니다.
      </div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button class="ob-btn-install-sm" onclick="showOnboardingInstall()">설치하기</button>
        <button class="ob-btn-later" onclick="dismissOnboarding(true)">계속 건너뛰기</button>
      </div>
    </div>`)}function confirmOnboardingDone(){localStorage.setItem("orbit_onboarding_done","1"),dismissOnboarding(!1);const e=_getAuthToken();e&&fetch("/api/tracker/ping",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${e}`},body:JSON.stringify({hostname:navigator.userAgent.slice(0,50),eventCount:1})}).catch(t=>console.warn("[tracker] 설치완료 ping 실패:",t.message)),typeof _initTrackerStatusBadge=="function"&&_initTrackerStatusBadge()}function dismissOnboarding(e){e&&localStorage.setItem("orbit_onboarding_skipped_at",String(Date.now()));const t=document.getElementById("onboarding-overlay");t&&(t.classList.remove("open"),t.innerHTML="")}window.checkOnboardingState=checkOnboardingState,window.showOnboardingOverlay=showOnboardingOverlay,window.showOnboardingInstall=showOnboardingInstall,window.copyOnboardingCmd=copyOnboardingCmd,window.showOnboardingSkipWarning=showOnboardingSkipWarning,window.dismissOnboarding=dismissOnboarding,window.confirmOnboardingDone=confirmOnboardingDone;async function initClaudeStatusBadge(){try{const t=await(await fetch("/api/setup/claude-status")).json();_updateTrackingBadge(t.tracking,t.running),t.hookRegistered||setTimeout(checkOnboardingState,1500)}catch{}}let _execCmdId=null,_execRequest=null;async function openExecPanel(e){_execRequest=e;const t=document.getElementById("exec-panel");document.getElementById("insight-panel")?.classList.remove("open"),document.getElementById("info-panel")?.classList.remove("open"),document.getElementById("llm-panel")?.classList.remove("open"),t.classList.add("open"),_showExecLoading(`${e.description||e.type} 미리보기 생성 중…`),document.getElementById("ep-model-select")?.options.length||await loadExecModelOptions();let o=!1;try{o=(await(await fetch("/api/orbit-cmd/ai-status")).json()).connected}catch{}const n=document.getElementById("ep-model-select")?.value||"ollama::orbit-insight:v1",[s,i]=n.includes("::")?n.split("::"):["ollama",n],a=document.getElementById("ep-mode-badge");if(o&&s==="ollama")a.textContent="AI 연결됨",a.className="ep-mode-badge ep-mode-ai";else{const l=_execProviders.find(d=>d.provider===s)?.icon||"🟡";a.textContent=`${l} ${s}`,a.className="ep-mode-badge ep-mode-ollama"}try{const l=await fetch("/api/orbit-cmd/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:e.type,hash:e.hash,projectDir:e.projectDir,instruction:e.instruction,provider:s,model:i})}),d=await l.json();if(!l.ok)throw new Error(d.error||l.statusText);_execCmdId=d.id,_showExecPreview(d.preview,d.cmds,d.mode)}catch(l){_showExecError(l.message)}}window.openExecPanel=openExecPanel;function closeExecPanel(){document.getElementById("exec-panel").classList.remove("open"),_execCmdId=null,_execRequest=null}window.closeExecPanel=closeExecPanel;function _showExecLoading(e){document.getElementById("ep-body").innerHTML=`
    <div class="ep-loading">
      <div class="ep-spinner"></div>
      <div class="ep-loading-msg">${escHtml(e)}</div>
    </div>`,document.getElementById("ep-actions").style.display="none"}function _showExecPreview(e,t,o){const n=o==="ai";document.getElementById("ep-body").innerHTML=`
    <div class="ep-preview-label">변경 미리보기</div>
    <div class="ep-diff">${_colorDiff(escHtml(e))}</div>
    ${n?"":`
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
    </div>`}
  `;const s=document.getElementById("ep-actions");s.style.display="flex",s.innerHTML=`
    ${n?"":'<button class="ep-btn ep-btn-regen" onclick="_regenExec()">↺ 재생성</button>'}
    <button class="ep-btn ep-btn-apply"  onclick="_applyExec()">
      ${n?"✅ AI에 전달됨 (닫기)":"✅ 적용"}
    </button>
    <button class="ep-btn ep-btn-cancel" onclick="closeExecPanel()">✕</button>
  `,n&&(document.querySelector(".ep-btn-apply").onclick=closeExecPanel)}function _showExecRunning(){document.getElementById("ep-body").innerHTML='<div class="ep-preview-label">실행 중…</div><div class="ep-log" id="ep-log-box"></div>',document.getElementById("ep-actions").style.display="none"}function _showExecDone(e,t){document.getElementById("ep-body").innerHTML+=`
    <div class="ep-done-banner">
      <div class="ep-done-icon">${e?"✅":"❌"}</div>
      <div class="ep-done-msg">${e?"완료":"실패"}</div>
      <div class="ep-done-sub">${escHtml(t||"")}</div>
    </div>`;const o=document.getElementById("ep-actions");o.style.display="flex",o.innerHTML='<button class="ep-btn ep-btn-apply" onclick="closeExecPanel()">닫기</button>'}function _showExecError(e){document.getElementById("ep-body").innerHTML=`
    <div style="color:#f85149;font-size:12px;padding:16px 0;">
      ❌ 오류: ${escHtml(e)}
    </div>`;const t=document.getElementById("ep-actions");t.style.display="flex",t.innerHTML='<button class="ep-btn ep-btn-cancel" onclick="closeExecPanel()">닫기</button>'}function _colorDiff(e){return e.split(`
`).map(t=>t.startsWith("+")?`<span style="color:#3fb950">${t}</span>`:t.startsWith("-")?`<span style="color:#f85149">${t}</span>`:t.startsWith("@@")?`<span style="color:#6e7681">${t}</span>`:t).join(`
`)}async function _regenExec(){const e=document.getElementById("ep-instr-input")?.value||"";await openExecPanel({..._execRequest,instruction:e||_execRequest?.instruction})}async function _applyExec(){if(!_execCmdId)return;_showExecRunning();const e=document.getElementById("ep-log-box"),t=(o,n)=>{const s=document.createElement("span");s.className=o,s.textContent=n,e.appendChild(s),e.scrollTop=e.scrollHeight};try{const o=await fetch("/api/orbit-cmd/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:_execCmdId})});if(!o.ok){const a=await o.json();return _showExecError(a.error||o.statusText)}const n=o.body.getReader(),s=new TextDecoder;let i="";for(;;){const{done:a,value:l}=await n.read();if(a)break;i+=s.decode(l,{stream:!0});const d=i.split(`
`);i=d.pop();for(const c of d)if(c.startsWith("data:"))try{const r=JSON.parse(c.slice(5).trim());r.type==="cmd"&&t("log-cmd",`$ ${r.cmd}
`),r.type==="stdout"&&t("log-stdout",r.text),r.type==="stderr"&&t("log-stderr",r.text),r.type==="cmd_done"&&r.exitCode===0&&t("log-ok",`✓ 완료
`),r.type==="error"&&t("log-err",`✗ ${r.msg}
`),r.type==="done"&&_showExecDone(r.exitCode===0,"모든 명령 완료")}catch{}}}catch(o){_showExecError(o.message)}}window._regenExec=_regenExec,window._applyExec=_applyExec;
