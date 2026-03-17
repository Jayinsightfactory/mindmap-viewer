"use strict";function closeAllRightPanels(t){["messenger-panel","insight-panel","suggestion-panel","follow-panel","my-talent-panel","learning-data-panel"].forEach(s=>{if(s===t)return;const n=document.getElementById(s);n&&(n.style.display="none",n.classList.remove("open"))})}window.closeAllRightPanels=closeAllRightPanels;function escHtml(t){return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function relTime(t){const e=Date.now()-new Date(t||0).getTime();return e<6e4?"방금":e<36e5?`${Math.floor(e/6e4)}분 전`:e<864e5?`${Math.floor(e/36e5)}시간 전`:`${Math.floor(e/864e5)}일 전`}function computeInsights(){const t=Date.now()-36e5,e=[..._allNodes].filter(o=>new Date(o.timestamp||o.created_at||0)>t).sort((o,p)=>new Date(p.timestamp||p.created_at||0)-new Date(o.timestamp||o.created_at||0)).slice(0,20),s={chat:{label:"💬 대화",color:"#58a6ff"},code:{label:"⚡ 코드",color:"#3fb950"},file:{label:"📄 파일",color:"#ffa657"},git:{label:"🌿 Git",color:"#39d2c0"},error:{label:"❌ 오류",color:"#f85149"}},n={};_allNodes.forEach(o=>{const p=typeCfg(o.type).cat||"chat";n[p]=(n[p]||0)+1});const l=Math.max(_allNodes.length,1),c=Object.entries(n).sort((o,p)=>p[1]-o[1]).map(([o,p])=>({...s[o]||{label:o,color:"#8b949e"},pct:Math.round(p/l*100)})),r={auth:"🔐 인증",api:"🌐 API",data:"🗄️ 데이터",ui:"🎨 UI",test:"🧪 테스트",server:"🚀 서버",infra:"🐳 인프라",fix:"🔧 버그수정",git:"🌿 Git",chat:"💬 대화",general:"⚙️ 일반"},i={};planetMeshes.forEach(o=>{const p=o.userData.domain||"general";i[p]=(i[p]||0)+1});const a=Object.entries(i).sort((o,p)=>p[1]-o[1])[0],d=a&&planetMeshes.length?`${r[a[0]]||a[0]} ${Math.round(a[1]/planetMeshes.length*100)}%`:"—",u=(_allNodes.filter(o=>o.type==="tool.error").length/l*100).toFixed(1),h=_allNodes.filter(o=>o.type==="git.commit"||o.type==="git.push").length,y={};_allNodes.forEach(o=>{const f=(o.data?.filePath||o.data?.fileName||"").replace(/\\/g,"/").split("/").pop();f&&f.includes(".")&&(y[f]=(y[f]||0)+1)});const g=Object.entries(y).sort((o,p)=>p[1]-o[1])[0]?.[0]||"—";return{recentEvents:e,distRows:c,topDomainLabel:d,errRate:u,gitCount:h,topFile:g,total:l}}const _INS_TYPE_ICON={"user.message":"💬","assistant.message":"🤖","assistant.response":"🤖","tool.start":"⚡","tool.end":"✅","tool.error":"❌","file.read":"📄","file.write":"✏️","git.commit":"🌿","git.push":"🚀"};let _insightTab="feed";function switchInsightTab(t){_insightTab=t,["feed","purpose","stats"].forEach(e=>{document.getElementById(`ins-tab-${e}`).classList.toggle("active",e===t);const s=document.getElementById(`ins-pane-${e}`);e===t?s.style.display="flex":s.style.display="none"}),t==="feed"?renderFeedTab():t==="purpose"?renderPurposeTab():t==="stats"&&renderStatsTab()}window.switchInsightTab=switchInsightTab;function renderFeedTab(){const t=computeInsights();document.getElementById("ins-feed-list").innerHTML=t.recentEvents.length?t.recentEvents.map(e=>`
        <div class="ins-feed-item">
          <span class="ins-feed-icon">${_INS_TYPE_ICON[e.type]||"·"}</span>
          <div class="ins-feed-body">
            <div class="ins-feed-label" title="${escHtml(e.label||e.type)}">${escHtml((e.label||e.type).slice(0,42))}</div>
            <div class="ins-feed-time">${relTime(e.timestamp||e.created_at)}</div>
          </div>
        </div>`).join(""):`<div style="padding:14px 4px;color:#6e7681;font-size:12px;">
         최근 1시간 이벤트 없음<br>
         <span style="font-size:10px;color:#3d444d">전체 ${t.total.toLocaleString()}개 보유</span>
       </div>`,document.getElementById("ins-feed-meta").textContent=`총 ${t.recentEvents.length}개 · 최근 1시간`}function buildPurposeCards(){const t={};return _allNodes.forEach(e=>{const s=e.purposeLabel||e.data?.purposeLabel;s&&(t[s]||(t[s]=[]),t[s].push(e))}),Object.entries(t).map(([e,s])=>{s.sort((g,o)=>new Date(g.timestamp||g.created_at||0)-new Date(o.timestamp||o.created_at||0));const n=s[0]?.timestamp||s[0]?.created_at,l=s[s.length-1]?.timestamp||s[s.length-1]?.created_at,c=s.find(g=>g.type==="user.message"),r=(c?.label||c?.data?.text||"").trim(),i=[],a=new Set;s.forEach(g=>{if(g.type!=="tool.start")return;const o=g.data?.toolName||g.label||"",p=g.data?.filePath||g.data?.fileName||"";let f=null;if(/Glob|Grep/.test(o)&&!/Edit|Write/.test(o))f={label:"Explore",icon:"🔍"};else if(/^Read$/i.test(o)&&!/Edit|Write/.test(o))f={label:"탐색",icon:"📂"};else if(/plan\.md/i.test(p)&&/Write|Edit/.test(o))f={label:"Plan",icon:"📋"};else if(/Write|Edit/.test(o))f={label:"구현",icon:"⚡"};else if(/Bash/i.test(o)){const b=g.data?.command||"";/git\s+commit/i.test(b)?f={label:"커밋",icon:"🌿"}:/git\s+push/i.test(b)?f={label:"푸시",icon:"🚀"}:f={label:"Bash",icon:"💻"}}f&&!a.has(f.label)&&(a.add(f.label),i.push(f))});const d={};s.forEach(g=>{const p=(g.data?.filePath||g.data?.fileName||"").replace(/\\/g,"/").split("/").pop();!p||!p.includes(".")||(d[p]||(d[p]={name:p,write:0}),["file.write","tool.start"].includes(g.type)&&/Write|Edit/.test(g.data?.toolName||"")&&d[p].write++)});const m=[...s].reverse().find(g=>g.type==="git.commit"),u=m?.data?.hash||m?.data?.commitHash||"",h=s.some(g=>g.type==="tool.error");let y;return h?y="❌":u?y="✅":i.length?y="⚡":y="⏳",{purposeLabel:e,trigger:r,agentSteps:i,files:Object.values(d),commitHash:u,hasError:h,statusIcon:y,firstTs:n,lastTs:l}}).sort((e,s)=>new Date(s.lastTs||0)-new Date(e.lastTs||0))}function renderPurposeTab(){const t=buildPurposeCards(),e=document.getElementById("ins-purpose-list");if(!t.length){e.innerHTML=`<div class="ins-purpose-empty">
      📭 목적(purposeLabel) 데이터 없음<br>
      <span style="font-size:10px;color:#3d444d;margin-top:6px;display:block;">
        이벤트에 purposeLabel 필드가 있어야 합니다
      </span>
    </div>`;return}e.innerHTML=t.map(s=>{const n=s.agentSteps.length?s.agentSteps.map((i,a)=>`${a>0?'<span class="ins-pc-step-arrow">›</span>':""}
           <span class="ins-pc-step ok">${i.icon} ${escHtml(i.label)}</span>`).join(""):'<span style="font-size:10px;color:#3d444d">스텝 정보 없음</span>',l=s.files.length?s.files.slice(0,4).map(i=>`<span class="ins-pc-file" title="${escHtml(i.name)}">
            ${escHtml(i.name.slice(0,20))}
            ${i.write?'<span class="ins-pc-diff">✏️</span>':""}
           </span>`).join(""):"",c=s.commitHash?JSON.stringify({type:"rollback",hash:s.commitHash,projectDir:"",description:`${s.purposeLabel} 롤백 (${s.commitHash.slice(0,7)})`}).replace(/"/g,"&quot;"):"",r=s.commitHash?`<div class="ins-pc-actions">
           <div class="ins-pc-commit-btn" title="커밋 해시: ${escHtml(s.commitHash)}">
             🌿 ${escHtml(s.commitHash.slice(0,7))}
           </div>
           <div class="ins-pc-rollback-btn"
                onclick="openExecPanel(${c})">
             ↩ 롤백 미리보기
           </div>
         </div>`:"";return`<div class="ins-purpose-card">
      <div class="ins-pc-hdr">
        <span class="ins-pc-status">${s.statusIcon}</span>
        <span class="ins-pc-label" title="${escHtml(s.purposeLabel)}">
          ${escHtml(s.purposeLabel.slice(0,34))}${s.purposeLabel.length>34?"…":""}
        </span>
        <span class="ins-pc-time">${relTime(s.lastTs)}</span>
      </div>
      ${s.trigger?`<div class="ins-pc-trigger">💬 "${escHtml(s.trigger.slice(0,60))}${s.trigger.length>60?"…":""}"</div>`:""}
      <div class="ins-pc-steps">${n}</div>
      ${l?`<div class="ins-pc-files">${l}</div>`:""}
      ${r}
    </div>`}).join("")}window.renderPurposeTab=renderPurposeTab;function renderStatsTab(){const t=computeInsights();document.getElementById("ins-dist-list").innerHTML=t.distRows.filter(s=>s.pct>0).map(s=>`
      <div class="ins-dist-row">
        <span class="ins-dist-label">${s.label}</span>
        <div class="ins-dist-bg">
          <div class="ins-dist-fill" style="width:${s.pct}%;background:${s.color}"></div>
        </div>
        <span class="ins-dist-pct">${s.pct}%</span>
      </div>`).join("");const e=parseFloat(t.errRate)<5?"✅ 건강함":parseFloat(t.errRate)<15?"⚠️ 주의":"🔴 불안정";document.getElementById("ins-kv-list").innerHTML=[["🔧 주요 도메인",t.topDomainLabel],["⚠️ 오류율",`${t.errRate}% ${e}`],["🌿 Git 활동",`${t.gitCount}회`],["🏆 최다 파일",t.topFile],["📦 전체 이벤트",`${t.total.toLocaleString()}개`]].map(([s,n])=>`
    <div class="ins-kv-row">
      <span class="ins-kv-key">${s}</span>
      <span class="ins-kv-val">${escHtml(String(n))}</span>
    </div>`).join("")}function renderInsightPanel(){_insightTab==="feed"?renderFeedTab():_insightTab==="purpose"?renderPurposeTab():_insightTab==="stats"&&renderStatsTab()}window.renderInsightPanel=renderInsightPanel;let _insightRefreshTimer=null;function toggleInsightPanel(){const t=document.getElementById("insight-panel"),e=t.classList.contains("open");closeAllRightPanels("insight-panel"),document.getElementById("info-panel")?.classList.remove("open"),e?(t.classList.remove("open"),clearInterval(_insightRefreshTimer),_insightRefreshTimer=null):(t.classList.add("open"),_insightTab!=="feed"?switchInsightTab("feed"):renderFeedTab(),_insightRefreshTimer=setInterval(renderInsightPanel,3e4))}window.toggleInsightPanel=toggleInsightPanel;let _ptOpen=!1,_ptPurposes=[],_ptActive=-1;async function togglePurposeTimeline(){const t=document.getElementById("purpose-timeline"),e=document.getElementById("ln-purpose-btn");_ptOpen=!_ptOpen,t.classList.toggle("open",_ptOpen),e?.classList.toggle("active",_ptOpen),_ptOpen&&(await _ptLoadSessions(),await loadPurposeTimeline())}window.togglePurposeTimeline=togglePurposeTimeline;async function _ptLoadSessions(){try{const e=await(await fetch("/api/purposes/sessions")).json(),s=document.getElementById("pt-sess-sel");if(!s)return;const n=(e.sessions||[]).map(l=>`<option value="${escHtml(l.sessionId)}">${escHtml(l.sessionTitle)} · ${l.purposeCount}목적</option>`).join("");s.innerHTML=`<option value="">전체 세션</option>${n}`}catch{}}async function loadPurposeTimeline(){const t=document.getElementById("pt-cards"),e=document.getElementById("pt-meta-label"),s=document.getElementById("pt-sess-sel")?.value||"";t.innerHTML='<div class="pt-empty-msg">불러오는 중…</div>';try{const n=s?`&session_id=${encodeURIComponent(s)}`:"";_ptPurposes=(await(await fetch(`/api/purposes/timeline?limit=60${n}`)).json()).purposes||[],e&&(e.textContent=`총 ${_ptPurposes.length}개 목적`),_ptRenderCards(_ptPurposes)}catch(n){t.innerHTML=`<div class="pt-empty-msg">❌ ${escHtml(n.message)}</div>`}}window.loadPurposeTimeline=loadPurposeTimeline;function _ptRenderCards(t){const e=document.getElementById("pt-cards");if(!t.length){e.innerHTML='<div class="pt-empty-msg">목적 데이터가 없습니다 — 이벤트가 쌓이면 자동으로 분류됩니다</div>';return}const s=[...t].reverse();e.innerHTML=s.map((n,l)=>{const c=t.length-1-l,r=n.gitHash?`<span class="pt-git-badge">🌿 ${escHtml(n.gitHash.slice(0,7))}</span>`:'<span class="pt-nocommit-badge">미커밋</span>',i=(n.files||[]).slice(0,4).map(h=>{const y=h.replace(/\\/g,"/").split("/").pop();return`<span class="pt-file-chip" title="${escHtml(h)}">${escHtml(y.slice(0,15))}</span>`}).join(""),a=(n.files||[]).length>4?`<span class="pt-file-more">+${n.files.length-4}</span>`:"",d=n.triggerText?`<div class="pt-card-trigger">"${escHtml(n.triggerText.slice(0,100))}"</div>`:"",m=n.gitHash?`<button class="pt-rollback-btn" onclick="ptRollback(${c},event)">↩ 롤백</button>`:"";return`${l>0?'<div class="pt-connector"><div class="pt-connector-line"></div></div>':""}<div class="pt-card" id="pt-card-${c}" onclick="ptSelectCard(${c})">
      <div class="pt-card-top">
        <span class="pt-card-icon" style="color:${n.color||"#8b949e"}">${n.icon||"📌"}</span>
        <span class="pt-card-label">${escHtml(n.label||"")}</span>
        ${r}
      </div>
      ${d}
      <div class="pt-card-files">${i}${a}</div>
      <div class="pt-card-foot">
        <span class="pt-card-time">${relTime(n.startTs)}</span>
        <span class="pt-card-cnt">${n.eventsCount}이벤트</span>
      </div>
      ${m}
    </div>`}).join("")}function ptSelectCard(t){document.querySelectorAll(".pt-card").forEach(s=>s.classList.remove("active")),document.getElementById(`pt-card-${t}`)?.classList.add("active"),_ptActive=t;const e=_ptPurposes[t];e&&_ptShowDetail(e)}window.ptSelectCard=ptSelectCard;function _ptShowDetail(t){const e=document.getElementById("info-panel");if(!e)return;const s=document.getElementById("ip-dot");s&&(s.style.background=t.color||"#8b949e");const n=document.getElementById("ip-type-text");n&&(n.textContent=`${t.icon} ${t.label}`);const l=document.getElementById("ip-intent");l&&(l.textContent=t.triggerText?`"${t.triggerText.slice(0,80)}"`:t.label);const c=document.getElementById("ip-kv-list");if(c){const i=[["목적",`${t.icon} ${t.label}`],["신뢰도",`${Math.round((t.confidence||0)*100)}%`],["이벤트",`${t.eventsCount}개`],["시작",t.startTs?new Date(t.startTs).toLocaleString("ko-KR"):"-"],["소요시간",t.startTs&&t.endTs?`${Math.round((new Date(t.endTs)-new Date(t.startTs))/6e4)}분`:"-"],["Git 커밋",t.gitHash?t.gitHash.slice(0,12):"없음"]];c.innerHTML=i.map(([d,m])=>`<div class="ip-kv"><span class="k">${d}</span><span class="v">${escHtml(String(m))}</span></div>`).join("");const a=t.eventIds?(_allNodes||[]).filter(d=>t.eventIds.includes(d.id)):[];a.length>0&&typeof renderWorkUnits=="function"&&(c.innerHTML+='<div style="margin-top:10px;font-size:11px;color:#cdd9e5;font-weight:600;margin-bottom:4px">📋 작업 흐름</div>'+renderWorkUnits(a))}const r=document.getElementById("ip-preview");if(r){const i=t.files?.length?`<div style="margin-bottom:8px">
          <div style="font-size:9px;color:#6e7681;margin-bottom:4px">📁 변경된 파일 (${t.files.length}개)</div>
          ${t.files.map(m=>`<div style="font-size:10px;color:#58a6ff;padding:2px 0">${escHtml(m.split("/").pop())}</div>`).join("")}
         </div>`:"",a=t.gitHash?`<div style="background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.2);
            border-radius:7px;padding:8px 10px;margin-bottom:8px">
          <div style="font-size:9px;color:#3fb950;font-weight:700;margin-bottom:3px">🌿 Git 커밋</div>
          <div style="font-size:10px;color:#7ee787;font-family:'SF Mono',monospace">${escHtml(t.gitHash.slice(0,12))}</div>
          ${t.gitMessage?`<div style="font-size:9px;color:#8b949e;margin-top:3px">${escHtml(t.gitMessage)}</div>`:""}
         </div>`:"",d=t.gitHash?`<button onclick="ptRollback(${_ptActive},null)"
           style="width:100%;background:none;border:1px solid #f85149;color:#f85149;
             border-radius:7px;padding:7px;font-size:11px;cursor:pointer;font-family:inherit;
             transition:background .15s"
           onmouseover="this.style.background='rgba(248,81,73,.08)'"
           onmouseout="this.style.background='none'">
           ↩ 이 목적 전으로 롤백 (${escHtml(t.gitHash.slice(0,7))})
         </button>`:"";r.innerHTML=i+a+d,r.style.display="block"}e.classList.add("open")}function ptRollback(t,e){e&&e.stopPropagation();const s=_ptPurposes[t];if(!s?.gitHash){showToast("이 목적에 연결된 커밋이 없습니다");return}typeof openExecPanel=="function"&&openExecPanel({type:"rollback",hash:s.gitHash,description:`↩ 롤백: ${s.label} (${s.gitHash.slice(0,7)})`})}window.ptRollback=ptRollback;let _sgOpen=!1;function toggleSuggestionPanel(){const t=document.getElementById("suggestion-panel"),e=document.getElementById("ln-suggest-btn");_sgOpen=!_sgOpen,closeAllRightPanels("suggestion-panel"),t.classList.toggle("open",_sgOpen),e?.classList.toggle("active",_sgOpen),document.getElementById("info-panel")?.classList.remove("open"),_sgOpen&&loadSuggestions()}window.toggleSuggestionPanel=toggleSuggestionPanel;function switchSgTab(t){const e=t==="suggest";document.getElementById("sg-panel-suggest").style.display=e?"":"none",document.getElementById("sg-panel-trigger").style.display=e?"none":"";const s=document.getElementById("sg-tab-suggest"),n=document.getElementById("sg-tab-trigger");s&&(s.style.background=e?"#21262d":"transparent",s.style.color=e?"#cdd9e5":"#6e7681"),n&&(n.style.background=e?"transparent":"#21262d",n.style.color=e?"#6e7681":"#cdd9e5"),e||loadTriggers()}window.switchSgTab=switchSgTab;const SIGNAL_META={wpm_spike:{icon:"⚡",label:"타이핑 속도 이상",color:"#f85149",bg:"rgba(248,81,73,.08)"},messaging_burst:{icon:"💬",label:"메시지 집중 급증",color:"#ff9500",bg:"rgba(255,149,0,.08)"},night_anomaly:{icon:"🌙",label:"야간 활동 감지",color:"#bc78de",bg:"rgba(188,120,222,.08)"},short_burst_chat:{icon:"🔥",label:"급박 메시지 감지",color:"#f85149",bg:"rgba(248,81,73,.08)"},app_storm:{icon:"🌀",label:"앱 전환 급증",color:"#ff9500",bg:"rgba(255,149,0,.08)"}},SEV_LABEL={high:"🔴 긴급",medium:"🟠 주의",low:"🟡 참고"};function _renderSignalCard(t){const e=SIGNAL_META[t.signal]||{icon:"⚠️",label:t.signal,color:"#ff9500",bg:"rgba(255,149,0,.08)"},s=SEV_LABEL[t.severity]||"🟠 주의",n=t.detected_at?relTime(t.detected_at):"";return`<div class="sg-card" style="border-color:${e.color}55;background:${e.bg};border-left:3px solid ${e.color}">
    <div class="sg-card-top" style="justify-content:space-between">
      <span style="font-size:18px">${e.icon}</span>
      <span class="sg-card-pri" style="background:${e.color}22;color:${e.color}">${s}</span>
    </div>
    <div class="sg-card-title" style="color:${e.color}">${escHtml(e.label)}</div>
    <div class="sg-card-desc" style="font-size:10px">${escHtml(t.desc||"")}</div>
    <div class="sg-card-evidence" style="color:#6e7681">${n} · 내용 無읽음 — 행동 패턴만</div>
    <div class="sg-card-actions">
      <button class="sg-accept-btn" style="background:${e.color}22;border-color:${e.color}"
        onclick="ackSignal('${escHtml(t.id)}', this)">✓ 확인함</button>
    </div>
  </div>`}function _renderFreeSolCard(t){const e=t.accuracy?`${Math.round(t.accuracy*100)}%`:"–";return`<div class="sg-card" style="border-color:rgba(138,87,222,.35);background:rgba(138,87,222,.06)">
    <div class="sg-card-top">
      <span class="sg-card-pri" style="background:rgba(138,87,222,.2);color:#bc78de">✅ 검증됨</span>
      <span class="sg-card-type">🎁 무료 솔루션</span>
    </div>
    <div class="sg-card-title">${escHtml(t.title||"")}</div>
    <div class="sg-card-desc">${escHtml(t.description||"")}</div>
    <div class="sg-card-evidence">정확도 ${e} · 사용 ${t.usageCount||0}회</div>
    <div class="sg-card-actions">
      <button class="sg-accept-btn" style="background:rgba(138,87,222,.25);border-color:#8957e5"
        onclick="applyFreeSolution(${escHtml(JSON.stringify(t))})">⚡ 적용</button>
    </div>
  </div>`}function _renderLocalSugCard(t){const e={automation:"⚙️ 자동화",template:"📝 템플릿",shortcut:"⌨️ 단축키",review:"🔍 검토",consolidation:"🔗 통합",prompt_template:"🧠 프롬프트 학습"},s={5:"🔴",4:"🟠",3:"🟡",2:"🔵",1:"⚪"},l=(Array.isArray(t.evidence)?t.evidence:[]).map(a=>a.type==="file_access"?`📁 ${(a.path||"").split("/").pop()} · ${a.count}회`:a.type==="repeat_typing"?`⌨️ 반복 입력 ${a.count}회`:a.type==="app_switch"?`🔄 ${a.pair} · ${a.count}회`:a.type==="long_session"?`⏱ ${Math.round((a.durationMin||0)/60*10)/10}시간`:a.type==="prompt_refinement"?`🔁 ${a.app||"AI"} 수정 ${a.revisionCount}회 · "${(a.firstPrompt||"").slice(0,25)}…"`:"").filter(Boolean).join(" · "),c=typeof t.suggestion=="object"&&t.suggestion?t.suggestion:{},r=t.type==="prompt_template",i=r?`<div style="font-size:10px;color:#8957e5;margin:4px 0">
         📡 오퍼레이터 검증 후 무료 솔루션으로 제공됩니다
       </div>`:"";return`<div class="sg-card" id="sg-card-${escHtml(t.id)}">
    <div class="sg-card-top">
      <span class="sg-card-pri p${t.priority||3}">${s[t.priority||3]||"🟡"}</span>
      <span class="sg-card-type">${e[t.type]||t.type}</span>
      ${r?'<span style="font-size:9px;color:#8b949e;margin-left:auto">학습 중 ●</span>':""}
    </div>
    <div class="sg-card-title">${escHtml(t.title)}</div>
    <div class="sg-card-desc">${escHtml(t.description||"")}</div>
    ${l?`<div class="sg-card-evidence">${escHtml(l)}</div>`:""}
    ${i}
    <div class="sg-card-actions">
      ${r?"":`<button class="sg-accept-btn" onclick="respondSuggestion('${escHtml(t.id)}','accept')">✓ 수락</button>`}
      <button class="sg-dismiss-btn" onclick="respondSuggestion('${escHtml(t.id)}','dismiss')">✕ 무시</button>
    </div>
  </div>`}async function loadSuggestions(){const t=document.getElementById("sg-list"),e=document.getElementById("sg-footer");if(t){t.innerHTML='<div class="sg-empty">불러오는 중…</div>';try{const[s,n,l]=await Promise.allSettled([fetch("/api/personal/signals?limit=10"),fetch("/api/sync/free-solutions"),fetch("/api/personal/suggestions?limit=50")]),c=s.status==="fulfilled"?((await s.value.json()).signals||[]).filter(m=>!m.acknowledged):[],r=n.status==="fulfilled"?(await n.value.json()).solutions||[]:[],i=l.status==="fulfilled"?(await l.value.json()).suggestions||[]:[],a=c.length+r.length+i.length;if(e&&(e.textContent=[c.length?`⚠️ 신호 ${c.length}개`:"",r.length?`🎁 솔루션 ${r.length}개`:"",i.length?`📡 학습 ${i.length}개`:""].filter(Boolean).join(" · ")||"데이터 없음"),!a){t.innerHTML=`<div class="sg-empty">
        아직 데이터가 없습니다.<br><br>
        <span style="font-size:10px">orbit learn start 실행 후<br>
        AI 작업을 하면 자동으로 학습됩니다</span>
      </div>`;return}let d="";if(c.length){const m=c.filter(u=>u.severity==="high").length;d+=`<div style="font-size:10px;color:#f85149;font-weight:600;
                  padding:6px 0 4px;border-bottom:1px solid rgba(248,81,73,.25);
                  margin-bottom:6px;display:flex;align-items:center;gap:6px">
                 ⚠️ 행동 이상 신호 (${c.length})
                 ${m?`<span style="background:#f85149;color:#fff;border-radius:8px;padding:1px 6px;font-size:9px">긴급 ${m}</span>`:""}
                 <span style="color:#6e7681;font-weight:normal;font-size:9px">내용 없이 타이핑 행동만 감지</span>
               </div>`,d+=c.map(_renderSignalCard).join("")}r.length&&(d+=`<div style="font-size:10px;color:#bc78de;font-weight:600;
                  padding:6px 0 4px;border-bottom:1px solid rgba(138,87,222,.2);
                  margin-bottom:6px;margin-top:${c.length?"10px":"0"}">
                 🎁 무료 솔루션 (${r.length})</div>`,d+=r.map(_renderFreeSolCard).join("")),i.length&&(d+=`<div style="font-size:10px;color:#8b949e;font-weight:600;
                  padding:8px 0 4px;border-bottom:1px solid #30363d;
                  margin-bottom:6px;margin-top:${r.length?"10px":"0"}">
                 📡 학습 중 (${i.length}) — 검증 후 솔루션으로 등록됩니다</div>`,d+=i.map(_renderLocalSugCard).join("")),t.innerHTML=d}catch(s){t.innerHTML=`<div class="sg-empty">❌ ${escHtml(s.message)}</div>`}}}window.loadSuggestions=loadSuggestions;async function applyFreeSolution(t){try{t.template?(await navigator.clipboard.writeText(t.template),showToast(`✅ "${t.title}" 복사됨 — AI에 붙여넣기하세요`)):showToast(`✅ "${t.title}" 적용됨`),fetch("/api/sync/free-solutions/use",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:t.id})}).catch(e=>console.warn("[solution] 사용 기록 실패:",e.message))}catch(e){showToast(`❌ ${e.message}`)}}window.applyFreeSolution=applyFreeSolution;async function ackSignal(t,e){try{await fetch(`/api/personal/signals/${encodeURIComponent(t)}/ack`,{method:"POST"});const s=e?.closest(".sg-card");s&&(s.style.opacity="0.35",s.style.pointerEvents="none",setTimeout(()=>s.remove(),500))}catch(s){showToast(`❌ ${s.message}`)}}window.ackSignal=ackSignal;async function markIssue(t={}){try{(await(await fetch("/api/personal/issue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({severity:t.severity||"medium",issue_type:t.issue_type||"불명확",note:t.note||"",source:t.source||"user_marked"})})).json()).ok&&(showToast("🚨 이슈 마킹 완료 — 직전 대화 패턴 역추적 중…"),setTimeout(loadTriggers,2e3))}catch(e){showToast(`❌ ${e.message}`)}}window.markIssue=markIssue;const TOPIC_KR={work_pressure:"업무 압박",interpersonal:"인간관계 갈등",deadline:"일정 압박",blame_shift:"책임 전가",technical:"기술 문제",praise:"칭찬",other:"기타"},SENTIMENT_KR={positive:"긍정",negative:"부정",neutral:"중립",frustrated:"좌절",anxious:"불안",angry:"분노"},URGENCY_KR={none:"없음",low:"낮음",medium:"보통",high:"높음",critical:"위급"};async function loadTriggers(){const t=document.getElementById("sg-trigger-list");if(t)try{const[e,s]=await Promise.allSettled([fetch("/api/personal/triggers?limit=10"),fetch("/api/personal/risk")]),n=e.status==="fulfilled"?(await e.value.json()).triggers||[]:[],l=s.status==="fulfilled"?await s.value.json():{},c=l.riskLevel||"unknown",r=l.score||0,i=l.matchedPattern,a={high:"#f85149",medium:"#ff9500",low:"#3fb950",unknown:"#8b949e",none:"#3fb950"},d={high:"🔴 높음",medium:"🟠 보통",low:"🟢 낮음",unknown:"⚪ 미측정",none:"🟢 없음"};let m=`<div style="background:#0d1117;border-radius:8px;padding:8px 10px;margin-bottom:8px">
      <div style="font-size:10px;color:#6e7681;margin-bottom:4px">현재 대화 위험도</div>
      <div style="font-size:13px;font-weight:600;color:${a[c]||"#8b949e"}">
        ${d[c]||c}
        <span style="font-size:10px;font-weight:normal;color:#6e7681"> (${(r*100).toFixed(0)}%)</span>
      </div>
      ${i?`<div style="font-size:10px;color:#8b949e;margin-top:3px">
        유사 패턴: ${escHtml(TOPIC_KR[i.dominant_topic]||"")} + ${escHtml(SENTIMENT_KR[i.dominant_sentiment]||"")} → 평균 ${i.hours_before_issue?.toFixed(0)||"?"}h 후 이슈
      </div>`:""}
    </div>`;n.length?m+=n.map(u=>{const h=Math.round((u.correlation||.5)*100),y=h>70?"#f85149":h>50?"#ff9500":"#3fb950";return`<div style="margin-bottom:7px;padding:7px 9px;background:#0d1117;border-radius:6px;border-left:2px solid ${y}">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <span style="font-size:11px;color:#cdd9e5;font-weight:600">
              ${escHtml(TOPIC_KR[u.dominant_topic]||u.dominant_topic)} + ${escHtml(SENTIMENT_KR[u.dominant_sentiment]||"")}
            </span>
            <span style="font-size:10px;color:#6e7681">${u.frequency}회</span>
          </div>
          <div style="font-size:10px;color:#6e7681;margin-bottom:4px">
            ${URGENCY_KR[u.dominant_urgency]||""} · 평균 ${u.hours_before_issue?.toFixed(0)||"?"}h 전 시작
          </div>
          <div style="height:3px;background:#21262d;border-radius:2px">
            <div style="width:${h}%;height:100%;background:${y};border-radius:2px"></div>
          </div>
          <div style="font-size:9px;color:#6e7681;margin-top:2px">예측 정확도 ${h}%</div>
        </div>`}).join(""):m+=`<div style="font-size:11px;color:#6e7681;text-align:center;padding:12px 0">
        이슈 마킹 시 직전 대화 패턴을<br>역추적해 트리거를 학습합니다
      </div>`,t.innerHTML=m}catch(e){t.innerHTML=`<div style="color:#f85149;font-size:11px">❌ ${escHtml(e.message)}</div>`}}window.loadTriggers=loadTriggers;async function respondSuggestion(t,e){try{await fetch(`/api/personal/suggestions/${encodeURIComponent(t)}/${e}`,{method:"POST"});const s=document.getElementById(`sg-card-${t}`);s&&(s.style.opacity="0.4",s.style.pointerEvents="none",setTimeout(()=>{s.remove()},600)),showToast(e==="accept"?"✅ 제안 수락됨":"제안 무시됨")}catch(s){showToast(`❌ ${s.message}`)}}window.respondSuggestion=respondSuggestion;async function savePromptSkill(t,e){try{const s=await fetch("/api/skills",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:e.name||"최적화 프롬프트",description:e.description||"AI 수정 패턴에서 학습된 최적 프롬프트",trigger:e.name||"최적화 프롬프트",prompt:e.prompt||"",type:"prompt_template",source:"suggestion_engine"})});s.ok?(showToast("🧠 스킬로 저장됨! /skills 에서 확인하세요."),respondSuggestion(t,"accept")):showToast("❌ 스킬 저장 실패: "+await s.text())}catch(s){showToast(`❌ ${s.message}`)}}window.savePromptSkill=savePromptSkill;const _plState={keyboard:!0,file:!0,app:!0};async function togglePersonalLearning(t){_plState[t]=!_plState[t];try{const e={};t==="keyboard"&&(e.keyboard=_plState.keyboard),t==="file"&&(e.fileWatcher=_plState.file),t==="app"&&(e.appMonitor=_plState.app),await fetch("/api/personal/toggle",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(e)}),_updatePersonalToggles()}catch{}}window.togglePersonalLearning=togglePersonalLearning;function _updatePersonalToggles(){const t={keyboard:"sp-toggle-keyboard",file:"sp-toggle-file",app:"sp-toggle-app"};for(const[e,s]of Object.entries(t)){const n=document.getElementById(s);n&&(n.textContent=_plState[e]?"ON ●":"OFF ○",n.style.color=_plState[e]?"#3fb950":"#8b949e")}}async function _loadPersonalStats(){try{const e=await(await fetch("/api/personal/status")).json(),s=document.getElementById("sp-personal-stats");if(!s)return;const n=e.today||{};s.innerHTML=`
      <div>⌨️ 키보드: <strong style="color:#cdd9e5">${(n.keywordChars||0).toLocaleString()}자</strong></div>
      <div>📁 파일: <strong style="color:#cdd9e5">${n.fileContents||0}개 처리</strong></div>
      <div>🖥️ 앱 전환: <strong style="color:#cdd9e5">${n.appActivities||0}회</strong></div>
      <div>💡 대기 제안: <strong style="color:#f0c040">${e.pendingSuggestions||0}개</strong></div>
    `;const l=document.getElementById("sp-sync-status");if(l){const c=e.syncLevel??(e.syncConsented?1:0),r={0:{text:"🔒 내 기기에서만 학습 중",color:"#8b949e"},1:{text:"🤝 패턴 인사이트 공유 중 (내용 없음)",color:"#3fb950"},2:{text:"🔬 심층 학습 참여 중",color:"#bc78de"}},i=r[c]||r[0],a=e.lastSync?` · 마지막: ${relTime(e.lastSync)}`:"";l.textContent=i.text+a,l.style.color=i.color,[0,1,2].forEach(d=>{const m=document.getElementById(`sp-sync-btn-${d}`);m&&(m.style.outline=d===c?"2px solid currentColor":"")})}_updatePersonalToggles()}catch{}}async function setSyncConsent(t){try{const s=await(await fetch("/api/sync/consent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({level:t})})).json(),n={0:"🔒 내 기기에서만 학습합니다",1:"🤝 패턴 인사이트 공유 시작 — 내용은 전송되지 않습니다",2:"🔬 심층 학습 참여 — 프롬프트 구조 공유로 솔루션 품질 향상에 기여합니다"};showToast(n[s.level??t]||"✅ 설정 저장"),_loadPersonalStats(),renderSetupPanel()}catch(e){showToast(`❌ ${e.message}`)}}window.setSyncConsent=setSyncConsent;async function triggerSyncPush(){try{showToast("↑ 동기화 중…");const e=await(await fetch("/api/sync/push",{method:"POST"})).json();e.ok?showToast(`✅ 동기화 완료: 이벤트 ${e.eventCount||0}개`):showToast(`❌ ${e.error}`),_loadPersonalStats()}catch(t){showToast(`❌ ${t.message}`)}}window.triggerSyncPush=triggerSyncPush;async function startPersonalAgent(){try{const t=await fetch("/api/exec/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:"node daemon/personal-agent.js &",cwd:".",label:"personal-agent"})});showToast("▶ 개인 학습 에이전트 시작")}catch(t){showToast(`❌ ${t.message}`)}}window.startPersonalAgent=startPersonalAgent;
