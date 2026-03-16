let _lastLiveActivity=null,_liveBranchNodes=[],_liveBranchTimer=null;function _addLiveBranch(t){const s=t.app||"",o=t.title||"",n=t.url||"",a=t.type||t.activityType||"";if(_lastLiveActivity&&_lastLiveActivity.app===s&&_lastLiveActivity.title===o)return;const r=_lastLiveActivity;_lastLiveActivity={app:s,title:o,url:n,type:a,timestamp:Date.now()};const l=extractIntent({type:n?"browse":"app_switch",data:t});if(!l)return;let e=planetMeshes[0];for(const f of planetMeshes)if(glowIntensity(f.userData.clusterId)>0){e=f;break}if(!e)return;const c=_liveBranchNodes.length,p=c*Math.PI*.4+Math.PI*.25,d=12+c*3,y=e.position.x+d*Math.cos(p),x=e.position.y+(c%2===0?2:-2),h=e.position.z+d*Math.sin(p),i=new THREE.Object3D;i.position.set(e.position.x,e.position.y,e.position.z),i.userData.isFileSat=!0,i.userData.isLiveBranch=!0,i.userData.clusterId=e.userData.clusterId,i.userData.sessionId=e.userData.sessionId,i.userData.fileLabel=l,i.userData.filename=s||o,i.userData.count=1,i.userData.isWrite=!1,i.userData.planetHex=e.userData.hueHex||"#58a6ff",i.userData.orbitR=d,i.userData.orbitθ0=p,i.userData.orbitφ0=0,i.userData.orbitSpeed=0,i.userData.orbitCenter=e.position,i.userData._targetPos=new THREE.Vector3(y,x,h),i.userData._treeBasePos=new THREE.Vector3(y,x,h),i.userData._birthTime=performance.now(),scene.add(i),satelliteMeshes.push(i),_liveBranchNodes.push(i);const v=new THREE.BufferGeometry().setFromPoints([e.position.clone(),i.position.clone()]),b=new THREE.LineBasicMaterial({color:new THREE.Color(e.userData.hueHex||"#58a6ff"),transparent:!0,opacity:.6}),u=new THREE.Line(v,b);for(u.userData.satObj=i,u.userData.isLiveBranch=!0,connections.push(u),scene.add(u),markClusterActive(e.userData.clusterId),showActivityPulse("app_switch",t);_liveBranchNodes.length>8;){const f=_liveBranchNodes.shift();scene.remove(f);const g=satelliteMeshes.indexOf(f);g>=0&&satelliteMeshes.splice(g,1);const m=connections.findIndex(w=>w.userData.satObj===f);m>=0&&(scene.remove(connections[m]),connections.splice(m,1))}clearTimeout(_liveBranchTimer),_liveBranchTimer=setTimeout(()=>{_cleanupLiveBranches(),loadData()},5e3)}function _animateLiveBranches(){const t=performance.now();_liveBranchNodes.forEach(s=>{const o=s.userData._targetPos,n=s.userData._birthTime;if(!o)return;const a=t-n,r=Math.min(1,a/600),l=1-Math.pow(1-r,3),e=s.userData.orbitCenter;e&&s.position.lerpVectors(e,o,l)})}window._animateLiveBranches=_animateLiveBranches;function _cleanupLiveBranches(){_liveBranchNodes.forEach(t=>{scene.remove(t);const s=satelliteMeshes.indexOf(t);s>=0&&satelliteMeshes.splice(s,1);const o=connections.findIndex(n=>n.userData.satObj===t);o>=0&&(scene.remove(connections[o]),connections.splice(o,1))}),_liveBranchNodes=[]}function connectWS(){const t=location.protocol==="https:"?"wss:":"ws:",s=localStorage.getItem("orbit_token")||"",o=s?`${t}//${location.host}?token=${encodeURIComponent(s)}`:`${t}//${location.host}`,n=window._globalWs=new WebSocket(o);let a=null;function r(){clearTimeout(a),a=setTimeout(()=>{a=null,typeof loadData=="function"&&loadData()},800)}n.onmessage=l=>{try{const e=JSON.parse(l.data);if(e.type==="new_event"||e.type==="graph_update"||e.type==="update"||e.type==="hook.events"){if(e.type==="new_event"){const p=e.event?.sessionId||e.sessionId;p&&planetMeshes.forEach(d=>{d.userData.sessionId===p&&markClusterActive(d.userData.clusterId)})}const c=window.RendererManager?.currentMode;!c||c==="personal"?r():e.type==="hook.events"&&e.stats&&typeof showToast=="function"&&e.count>0&&showToast(`⚡ ${e.memberName||"이벤트"} +${e.count}`,1500)}if((e.type==="browser_activity"||e.type==="app_switch")&&_addLiveBranch(e),e.type==="skill_suggestion"&&e.data&&showSkillToast(e.data),e.type==="skill_suggestion"||e.type==="anomaly"){const c=e.sessionId||e.data?.sessionId;if(c){const p=planetMeshes.find(d=>d.userData.sessionId===c||d.userData.clusterId===c);p&&(p.userData._attention=1,setTimeout(()=>{p.userData._attention=0},1e4))}}if(e.type==="ollama_analysis"&&e.data&&(updateOllamaPanel(e.data,e.eventCount),e.data.goal&&(window._lastOllamaGoal={goal:e.data.goal,phase:e.data.phase,progress:e.data.progress})),e.type==="keylog_insight"&&e.insight&&showKeylogInsight(e.insight,e.timestamp),e.type==="new_event"&&e.event){const c=e.event.type||"";(c.startsWith("terminal.")||c.startsWith("vscode.")||c==="ai_conversation_saved")&&(loadData(),showActivityPulse(c,e.event.data))}e.type==="ai_conversation_saved"&&(showActivityPulse("ai.conversation",{site:e.site,title:e.title}),typeof openDesktopWindow=="function"&&openDesktopWindow({windowId:"ai-conv-"+(e.id||Date.now()),type:"ai_tool",source:e.site||"AI",title:e.title||e.site||"AI 대화",site:e.site,msgCount:e.msgs,active:!0,timestamp:new Date().toISOString()})),e.type==="bookmarkUpdate"&&typeof loadBookmarks=="function"&&loadBookmarks(),e.type==="memoUpdate"&&typeof loadMemos=="function"&&loadMemos(),typeof routeEventToMonitor=="function"&&routeEventToMonitor(e)}catch{}},n.onclose=()=>setTimeout(connectWS,3e3)}function updateOllamaPanel(t,s){let o=document.getElementById("ollama-live-panel");o||(o=document.createElement("div"),o.id="ollama-live-panel",o.style.cssText=`
      position:fixed; bottom:70px; right:14px; z-index:300;
      background:rgba(13,17,23,0.97); border:1px solid #bc8cff40;
      border-radius:14px; padding:12px 14px; width:260px;
      backdrop-filter:blur(16px); box-shadow:0 8px 32px rgba(188,140,255,0.15);
      font-family:-apple-system,'Segoe UI',sans-serif; font-size:12px;
      animation: fadeIn .3s ease;
    `,document.body.appendChild(o));const a={code:"💻",debug:"🐛",research:"🔍",review:"👁️",meeting:"💬"}[t.type]||"⬡",r=(t.skills||[]).map(p=>`<span style="background:rgba(88,166,255,.12);border:1px solid #388bfd40;color:#79c0ff;
     font-size:10px;padding:2px 7px;border-radius:5px;font-weight:600;">${p}</span>`).join(" "),e={초기:15,진행중:50,마무리:85,완료:100}[t.progress]||30,c=e>=85?"#3fb950":e>=40?"#58a6ff":"#bc8cff";o.innerHTML=`
    <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
      <div style="width:6px;height:6px;border-radius:50%;background:#bc8cff;
        box-shadow:0 0 6px #bc8cff;animation:blink-badge 1.5s infinite;"></div>
      <span style="font-size:10px;color:#6e7681;letter-spacing:.5px;text-transform:uppercase;">
        Ollama 실시간 · ${s}건</span>
      <button onclick="document.getElementById('ollama-live-panel').remove()"
        style="margin-left:auto;background:none;border:none;color:#6e7681;cursor:pointer;font-size:13px;">✕</button>
    </div>
    ${t.goal?`
    <div style="background:#161b22;border-radius:8px;padding:8px 10px;margin-bottom:8px;">
      <div style="font-size:10px;color:#6e7681;margin-bottom:4px;">🎯 목표</div>
      <div style="font-weight:700;color:#e6edf3;font-size:13px;">${t.goal}</div>
      ${t.phase?`<div style="color:#79c0ff;font-size:11px;margin-top:3px;">→ ${t.phase}</div>`:""}
      <div style="margin-top:6px;height:4px;background:#21262d;border-radius:2px;overflow:hidden;">
        <div style="width:${e}%;height:100%;background:${c};border-radius:2px;transition:width .5s;"></div>
      </div>
      <div style="text-align:right;font-size:9px;color:#6e7681;margin-top:2px;">${t.progress||"진행중"}</div>
    </div>`:""}
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="font-size:18px;">${a}</span>
      <div>
        <div style="font-weight:700;color:#e6edf3;font-size:13px;">${t.focus||"작업 중"}</div>
        <div style="color:#8b949e;font-size:11px;margin-top:2px;">${t.summary||""}</div>
      </div>
    </div>
    ${r?`<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px;">${r}</div>`:""}
    ${t.suggestion?`
      <div style="background:#161b22;border-left:2px solid #bc8cff;border-radius:4px;
        padding:6px 8px;color:#cdd9e5;font-size:11px;line-height:1.5;">
        💡 ${t.suggestion}
      </div>`:""}
  `,clearTimeout(o._closeTimer),o._closeTimer=setTimeout(()=>o?.remove(),3e4)}function showKeylogInsight(t,s){if(!t)return;const n={이메일:"📧",채팅:"💬",문서작성:"📝",코딩:"💻",검색:"🔍",기타:"⌨️"}[t.activity]||"⌨️",a=(t.keywords||[]).slice(0,3).join(" · "),r=document.createElement("div");r.className="keylog-toast",r.style.cssText=`
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: rgba(13,17,23,0.95); border: 1px solid #3fb950;
    border-radius: 12px; padding: 10px 16px; z-index: 9999;
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; color: #e6edf3; min-width: 260px; max-width: 420px;
    box-shadow: 0 4px 20px rgba(63,185,80,0.2);
    animation: slideUp .3s ease; backdrop-filter: blur(12px);
    pointer-events: none;
  `,r.innerHTML=`
    <span style="font-size:18px">${n}</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;color:#3fb950;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${n} ${t.topic||t.activity||"키입력"}
      </div>
      <div style="font-size:11px;color:#6e7681;margin-top:2px">
        ${a||t.context||t.language||""}
      </div>
    </div>
    <span style="font-size:11px;color:#6e7681;flex-shrink:0">로컬 분석</span>
  `,document.body.appendChild(r),setTimeout(()=>{r.style.opacity="0",r.style.transition="opacity .3s",setTimeout(()=>r.remove(),300)},4e3),_addToKeylogStream(t,n)}let _keylogStreamEl=null;const _keylogStreamItems=[];function _addToKeylogStream(t,s){_keylogStreamEl||(_keylogStreamEl=document.createElement("div"),_keylogStreamEl.id="keylog-stream",_keylogStreamEl.style.cssText=`
      position: fixed; right: 14px; top: 14px; z-index: 200;
      width: 220px; display: flex; flex-direction: column; gap: 4px;
      pointer-events: none;
    `,document.body.appendChild(_keylogStreamEl)),_keylogStreamItems.unshift({insight:t,icon:s,ts:Date.now()}),_keylogStreamItems.length>5&&_keylogStreamItems.pop(),_keylogStreamEl.innerHTML=_keylogStreamItems.map(o=>`
    <div style="
      background: rgba(13,17,23,0.88); border: 1px solid #21262d;
      border-left: 3px solid #3fb950; border-radius: 8px;
      padding: 6px 10px; font-size: 11px; color: #8b949e;
    ">
      <span style="color:#3fb950">${o.icon}</span>
      <span style="color:#e6edf3;font-weight:600"> ${o.insight.topic||o.insight.activity}</span>
      <span style="float:right;color:#6e7681">${o.insight.language||""}</span>
    </div>
  `).join("")}function showActivityPulse(t,s){const n={"terminal.command":"⌨️","vscode.file_save":"💾","vscode.file_open":"📂","vscode.debug_start":"🐛","ai.conversation":"💬"}[t]||"⚡",a=s?.fileName||s?.command?.slice(0,30)||s?.title?.slice(0,30)||t;typeof showToast=="function"&&showToast(`${n} ${a}`,2e3)}const _toastTimers=new Map;function showSkillToast(t){const s=document.getElementById("skill-toast-stack");if(!s||_toastTimers.has(t.id))return;const o=t.type==="agent",n=t.evidence?.avgConfidence??0,a=t.evidence?.patternCount??0,r=t.evidence?.category??"",l=document.createElement("div");l.className=`skill-toast ${t.type}`,l.innerHTML=`
    <div class="st-header">
      <div class="st-icon">${t.icon||(o?"🤖":"📌")}</div>
      <div class="st-title-wrap">
        <span class="st-type-chip">${o?"agent":"skill"}</span>
        <div class="st-alias">${t.alias||t.trigger}</div>
        <div class="st-trigger">${t.trigger}</div>
      </div>
    </div>
    <div class="st-evidence">
      패턴 <strong>${a}회</strong> 감지 · 신뢰도 <strong>${Math.round(n*100)}%</strong> · 카테고리: ${r}
    </div>
    <div class="st-actions">
      <button class="st-btn accept" onclick="acceptSkillToast('${t.id}', this)">✅ 적용</button>
      <button class="st-btn dismiss" onclick="dismissSkillToast('${t.id}', this)">✕ 닫기</button>
    </div>
  `,s.appendChild(l);const e=setTimeout(()=>dismissSkillToast(t.id,l),12e3);_toastTimers.set(t.id,{el:l,timer:e,suggestion:t})}function dismissSkillToast(t,s){typeof track=="function"&&track("ai.suggestion_dismiss",{id:t});const o=_toastTimers.get(t),n=s?.closest?.(".skill-toast")||o?.el;n&&(n.style.opacity="0",n.style.transform="translateY(10px) scale(.97)",n.style.transition="all .25s",setTimeout(()=>n.remove(),260)),o?.timer&&clearTimeout(o.timer),_toastTimers.delete(t)}async function acceptSkillToast(t,s){typeof track=="function"&&track("ai.suggestion_accept",{id:t});const o=_toastTimers.get(t);if(o){try{if(await fetch("/api/insights/feedback/apply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId:o.suggestion.clientId,suggestionId:t})}),_myMemberId&&typeof _teamNodes<"u"){const n=_teamNodes.find(a=>a.type==="member"&&a.memberId===_myMemberId);if(n){const a=o.suggestion;_teamNodes.push({type:"skill",memberId:_myMemberId,label:`${a.icon||"📌"} ${a.alias}`,pos:n.pos.clone().add(new THREE.Vector3((Math.random()-.5)*4,(Math.random()-.5)*4,(Math.random()-.5)*4))}),updateMyTaskSidebar()}}}catch(n){console.warn("[Toast] 수락 실패:",n)}dismissSkillToast(t,s)}}
