const AI_COLORS={claude:"#3fb950",n8n:"#ea4b71",openai:"#8b949e",cursor:"#58a6ff",vscode:"#f85149",perplexity:"#bc8cff",gpt:"#8b949e",default:"#6b7280"},ALL_FEATURES=[{key:"맵 뷰",desc:"vis-network 기반 마인드맵"},{key:"행성계 뷰",desc:"orbit.html 캔버스 애니메이션"},{key:"대시보드",desc:"통계/분석 페이지"},{key:"히스토리",desc:"이벤트 타임라인 + 롤백"},{key:"설정",desc:"라벨/채널 커스터마이징"},{key:"Claude 훅",desc:"Claude Code 실시간 연동"},{key:"n8n 연동",desc:"n8n 워크플로우 이벤트"},{key:"VS Code 연동",desc:"파일 변경 감지"},{key:"채널 시스템",desc:"팀 협업 공간 분리"},{key:"보안 스캐너",desc:"API 키 유출 감지"},{key:"코드 분석",desc:"파일 접근 패턴 분석"},{key:"WebSocket",desc:"실시간 브로드캐스트"},{key:"롤백",desc:"이벤트 지점 복원"},{key:"검색",desc:"이벤트 전문 검색"},{key:"PostgreSQL",desc:"DB 자동 전환"}];function switchTab(a){document.querySelectorAll(".tab-btn").forEach((i,o)=>{i.classList.toggle("active",["analysis","tools","channels","insights"][o]===a)}),document.querySelectorAll(".tab-content").forEach(i=>i.classList.remove("active")),document.getElementById("tab-"+a).classList.add("active")}function escHtml(a){return String(a||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}async function loadAnalysis(){const[a,i,o]=await Promise.all([fetch("/api/stats"),fetch("/api/graph"),fetch("/api/sessions")]),c=await a.json(),u=await i.json(),n=await o.json(),l=u.nodes||[],p=n.length>0?Math.round(l.length/n.length):0;document.getElementById("stat-grid").innerHTML=`
    <div class="stat-mini">
      <div class="stat-mini-val" style="color:var(--green)">${c.eventCount||0}</div>
      <div class="stat-mini-lbl">총 이벤트</div>
    </div>
    <div class="stat-mini">
      <div class="stat-mini-val" style="color:var(--blue)">${n.length}</div>
      <div class="stat-mini-lbl">총 세션</div>
    </div>
    <div class="stat-mini">
      <div class="stat-mini-val" style="color:var(--purple)">${p}</div>
      <div class="stat-mini-lbl">세션당 평균 이벤트</div>
    </div>
  `;const t={};for(const e of l)t[e.type]=(t[e.type]||0)+1;const s=Object.entries(t).sort((e,d)=>d[1]-e[1]),v=s[0]?.[1]||1,r={"tool.end":"#bc8cff","tool.start":"#8957e5","assistant.message":"#3fb950","user.message":"#58a6ff","session.start":"#39d2c0","file.write":"#f778ba","file.read":"#ffa657","task.complete":"#3fb950"};document.getElementById("feature-usage").innerHTML=s.map(([e,d])=>{const g=Math.round(d/v*100),m=r[e]||"#6b7280";return`
      <div class="feature-row">
        <span class="feature-name">${e}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="feature-bar"><div class="feature-fill" style="width:${g}%;background:${m}"></div></div>
          <span class="feature-count" style="color:${m}">${d}</span>
        </div>
      </div>`}).join("");const f=c.aiSourceStats||{},h=Object.values(f).reduce((e,d)=>e+d,0),y=Object.entries(f).sort((e,d)=>d[1]-e[1]);document.getElementById("ai-usage").innerHTML=y.length?y.map(([e,d])=>{const g=AI_COLORS[e.toLowerCase()]||AI_COLORS.default,m=h>0?Math.round(d/h*100):0;return`
      <div class="feature-row">
        <span class="feature-name" style="color:${g};font-weight:600">${e}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:var(--text3)">${m}%</span>
          <div class="feature-bar"><div class="feature-fill" style="width:${m}%;background:${g}"></div></div>
          <span class="feature-count" style="color:${g}">${d}</span>
        </div>
      </div>`}).join(""):'<div class="empty">AI 소스 데이터 없음</div>';const b=new Set(Object.keys(t)),w=new Set(Object.keys(f).map(e=>e.toLowerCase())),$=ALL_FEATURES.filter(e=>e.key==="n8n 연동"?!w.has("n8n"):e.key==="VS Code 연동"?!w.has("vscode"):e.key==="Claude 훅"?!b.has("tool.end")&&!b.has("user.message"):e.key==="롤백"||e.key==="검색");document.getElementById("unused-features").innerHTML=$.length?$.map(e=>`
        <div class="feature-row">
          <div>
            <div class="feature-name">${e.key}</div>
            <div style="font-size:11px;color:var(--text3)">${e.desc}</div>
          </div>
          <span class="unused-badge">미사용</span>
        </div>`).join(""):'<div class="empty">모든 기능이 사용됩니다 ✅</div>',generateInsights(c,l,n,y,s)}function generateInsights(a,i,o,c,u){const n=[],l=c[0],p=u[0],t=a.eventCount||0,s=u.filter(([r])=>r.startsWith("tool")).reduce((r,[,f])=>r+f,0);if(l){const r=Math.round(l[1]/(t||1)*100);n.push({title:`🤖 주요 AI: ${l[0]}`,text:`전체 이벤트의 ${r}%가 ${l[0]}에서 발생합니다. ${c.length}개 AI 소스가 연결되어 있습니다.`})}s>t*.5&&n.push({title:"🔧 도구 중심 워크플로우",text:`이벤트의 ${Math.round(s/t*100)}%가 도구 실행입니다. 자동화 워크플로우가 활발하게 사용되고 있습니다.`}),o.length>3&&n.push({title:"📊 멀티 세션 활동",text:`${o.length}개 세션이 기록됐습니다. 채널별로 분류하면 프로젝트 진행 상황을 더 명확하게 파악할 수 있습니다.`}),n.push({title:"💡 다음 단계 추천",text:`• 팀원들과 같은 채널(MINDMAP_CHANNEL)을 설정하면 실시간 협업 뷰가 활성화됩니다
• n8n 워크플로우에 orbit-agent SDK를 연결하면 자동화 작업도 시각화됩니다
• VS Code에서 vscode-orbit.js watch 실행 시 파일 편집도 추적됩니다`});const v=document.getElementById("insights-container");v.innerHTML=n.map(r=>`
    <div class="insight-card">
      <div class="insight-title">${r.title}</div>
      <div class="insight-text">${escHtml(r.text)}</div>
    </div>`).join("")}async function loadMappings(){const i=await(await fetch("/api/tool-mappings")).json(),o=document.getElementById("mapping-list");if(!i.length){o.innerHTML='<div class="empty">커스텀 라벨 없음. 아래에서 추가하세요.</div>';return}o.innerHTML=i.map(c=>`
    <div class="mapping-row">
      <input class="mapping-input" value="${escHtml(c.toolName)}" readonly>
      <span class="mapping-arrow">→</span>
      <input class="mapping-input" value="${escHtml(c.label)}">
      <button class="del-btn" onclick="deleteMapping('${escHtml(c.toolName)}')">삭제</button>
    </div>`).join("")}async function addMapping(){const a=document.getElementById("new-tool").value.trim(),i=document.getElementById("new-label").value.trim();if(!a||!i)return alert("도구명과 라벨을 모두 입력하세요");await fetch("/api/tool-mappings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({toolName:a,label:i})}),document.getElementById("new-tool").value="",document.getElementById("new-label").value="",loadMappings()}async function deleteMapping(a){await fetch(`/api/tool-mappings/${encodeURIComponent(a)}`,{method:"DELETE"}),loadMappings()}async function loadChannels(){const[a,i]=await Promise.all([fetch("/api/sessions"),fetch("/api/graph")]),o=await a.json(),u=(await i.json()).nodes||[],n={};for(const t of u){const s=t.sessionId&&o.find(v=>v.id===t.sessionId)?.channelId||"default";n[s]||(n[s]={events:0,sessions:new Set,aiSources:new Set}),n[s].events++,t.sessionId&&n[s].sessions.add(t.sessionId),t.aiSource&&n[s].aiSources.add(t.aiSource)}const l=document.getElementById("channel-list"),p=Object.entries(n).sort((t,s)=>s[1].events-t[1].events);if(!p.length){l.innerHTML='<div class="empty">채널 데이터 없음</div>';return}l.innerHTML=p.map(([t,s])=>`
    <div class="channel-row">
      <div>
        <div class="ch-name">${escHtml(t)}</div>
        <div class="ch-meta">세션 ${s.sessions.size}개 · AI: ${[...s.aiSources].join(", ")||"없음"}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:14px;font-weight:700;color:var(--accent)">${s.events}</div>
        <div style="font-size:10px;color:var(--text3)">이벤트</div>
      </div>
    </div>`).join("")}loadAnalysis(),loadMappings(),loadChannels();
