let currentHistoryNode=null,currentHistoryEvents=[],selectedEventIndex=-1;async function showHistoryPopup(t){console.log("📊 히스토리 팝업 열기:",t.name),currentHistoryNode=t,selectedEventIndex=-1;const i=document.getElementById("history-overlay"),s=document.getElementById("history-modal"),e=document.getElementById("history-node-name");if(!i||!s){console.error("History popup elements not found");return}e.textContent=t.name||"작업 히스토리",i.classList.add("show"),s.classList.add("show"),await loadHistoryEvents(t.id)}function closeHistoryPopup(){console.log("📊 히스토리 팝업 닫기");const t=document.getElementById("history-overlay"),i=document.getElementById("history-modal");t&&t.classList.remove("show"),i&&i.classList.remove("show"),setTimeout(()=>{currentHistoryNode=null,currentHistoryEvents=[],selectedEventIndex=-1,clearHistoryDetail()},300)}async function loadHistoryEvents(t){const i=document.getElementById("history-events-list");if(i){i.innerHTML='<div style="color:#6e7681;font-size:12px;text-align:center;padding:20px">이벤트 로딩 중...</div>';try{const s=await fetch(`/api/graph/nodeHistory?nodeId=${encodeURIComponent(t)}`);if(!s.ok)throw new Error(`Failed to load history: ${s.status}`);const e=await s.json();currentHistoryEvents=Array.isArray(e)?e:e.events||[],currentHistoryEvents.length===0&&(currentHistoryEvents=generateDummyHistoryEvents(currentHistoryNode)),renderHistoryTimeline()}catch(s){console.error("Error loading history:",s),console.log("Using dummy history events"),currentHistoryEvents=generateDummyHistoryEvents(currentHistoryNode),renderHistoryTimeline()}}}function generateDummyHistoryEvents(t){const i=new Date;return[{id:"event_1",timestamp:new Date(i.getTime()-10080*60*1e3).toISOString(),action:"작업 시작",title:"프로젝트 초기화",status:"완료",description:"프로젝트 기본 구조 설정 및 초기 분석",analysis:"초기 진단 완료. 18개 모듈 식별됨. 의존성 분석 완료.",icon:"🚀",progress:10,metadata:{duration:"2시간 30분",completionRate:100,issues:0}},{id:"event_2",timestamp:new Date(i.getTime()-7200*60*1e3).toISOString(),action:"미팅 진행",title:"팀 회의 - 요구사항 정의",status:"완료",description:"팀원들과 함께 프로젝트 요구사항 논의 및 마일스톤 수립",analysis:"팀 합의 완료. 5개 마일스톤 정의. 리소스 할당 완료.",icon:"👥",progress:25,metadata:{duration:"1시간",participants:5,decisions:3}},{id:"event_3",timestamp:new Date(i.getTime()-4320*60*1e3).toISOString(),action:"개발 진행",title:"핵심 모듈 개발",status:"진행중",description:"주요 기능 모듈 구현 중. 현재 60% 완료.",analysis:"2개 모듈 완성. 1개 모듈 진행 중 (진행률 60%). 테스트 대기 중.",icon:"🔧",progress:60,metadata:{duration:"24시간 (누적)",completionRate:60,issues:2}},{id:"event_4",timestamp:new Date(i.getTime()-1440*60*1e3).toISOString(),action:"테스트 및 검증",title:"단위 테스트 수행",status:"진행중",description:"개발된 모듈에 대한 단위 테스트 진행 중",analysis:"12개 테스트 케이스 작성. 10개 통과, 2개 실패. 실패 원인 분석 중.",icon:"✅",progress:75,metadata:{duration:"8시간 (누적)",testCases:12,passRate:83.3}},{id:"event_5",timestamp:new Date(i.getTime()-7200*1e3).toISOString(),action:"최종 검토",title:"코드 리뷰 및 최적화",status:"진행중",description:"팀 리더와 코드 리뷰 진행. 최적화 사항 파악.",analysis:"3개 이슈 발견. 2개는 중요도 낮음. 1개는 보안 관련 필수 수정.",icon:"🔍",progress:85,metadata:{duration:"2시간",issuesFound:3,criticalIssues:1}}]}function renderHistoryTimeline(){const t=document.getElementById("history-events-list");if(!t)return;if(currentHistoryEvents.length===0){t.innerHTML='<div style="color:#6e7681;font-size:12px;text-align:center;padding:20px">이벤트가 없습니다</div>';return}const s=[...currentHistoryEvents].sort((e,o)=>new Date(o.timestamp)-new Date(e.timestamp)).map((e,o)=>{const n=new Date(e.timestamp),d=formatEventTime(n);return`
      <div class="history-event ${o===selectedEventIndex?"active":""}" 
           data-index="${currentHistoryEvents.findIndex(r=>r.id===e.id)}"
           onclick="selectHistoryEvent(${currentHistoryEvents.findIndex(r=>r.id===e.id)})">
        <div class="history-event-marker">${o+1}</div>
        <div class="history-event-info">
          <div class="history-event-time">${d}</div>
          <div class="history-event-title">${e.title||e.action}</div>
          <div class="history-event-status">
            ${e.icon?e.icon+" ":""}${e.status||"진행중"}
          </div>
        </div>
      </div>
    `}).join("");t.innerHTML=s}function selectHistoryEvent(t){if(t<0||t>=currentHistoryEvents.length)return;selectedEventIndex=t;const i=currentHistoryEvents[t];document.querySelectorAll(".history-event").forEach((e,o)=>{parseInt(e.dataset.index)===t?e.classList.add("active"):e.classList.remove("active")}),showHistoryDetail(i)}function showHistoryDetail(t){const i=document.getElementById("history-detail-title"),s=document.getElementById("history-detail-time"),e=document.getElementById("history-detail-content");if(!i||!s||!e)return;const n=new Date(t.timestamp).toLocaleString("ko-KR",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});i.textContent=t.title||t.action||"이벤트",s.textContent=n;const d=`
    <div class="history-detail-field">
      <div class="history-detail-label">📋 설명</div>
      <div class="history-detail-value">${t.description||"설명이 없습니다"}</div>
    </div>

    <div class="history-detail-field">
      <div class="history-detail-label">🎯 분석 결과</div>
      <div class="history-detail-value">${t.analysis||"분석 결과가 없습니다"}</div>
    </div>

    ${t.progress!==void 0?`
    <div class="history-detail-field">
      <div class="history-detail-label">⏳ 진행률</div>
      <div class="history-detail-value">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:8px;background:#1e293b;border-radius:4px;overflow:hidden">
            <div style="width:${t.progress}%;height:100%;background:#3a7bd5;transition:width 0.3s"></div>
          </div>
          <span style="font-weight:600;color:#58a6ff">${t.progress}%</span>
        </div>
      </div>
    </div>
    `:""}

    ${t.metadata?`
    <div class="history-detail-field">
      <div class="history-detail-label">📊 메타데이터</div>
      <div class="history-detail-value">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
          ${Object.entries(t.metadata).map(([l,c])=>`
            <div style="padding:6px;background:#1e293b;border-radius:4px">
              <div style="color:#94a3b8;font-size:10px;margin-bottom:2px">${l}</div>
              <div style="color:#cbd5e1;font-weight:500">${formatMetadata(c)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
    `:""}

    <div class="history-detail-field">
      <div class="history-detail-label">✨ 상태</div>
      <div class="history-detail-value">
        <span style="display:inline-block;padding:4px 8px;background:${getStatusColor(t.status)};border-radius:4px;font-size:12px;font-weight:600">
          ${t.status||"진행중"}
        </span>
      </div>
    </div>
  `;e.innerHTML=d;const r=document.getElementById("history-edit-btn"),a=document.getElementById("history-restart-btn");r&&a&&(r.disabled=!1,a.disabled=!1)}function clearHistoryDetail(){const t=document.getElementById("history-detail-content"),i=document.getElementById("history-detail-title"),s=document.getElementById("history-detail-time");t&&(t.innerHTML='<div style="color:#6e7681;font-size:12px;text-align:center;padding:20px">타임라인에서 항목을 선택하세요</div>'),i&&(i.textContent="작업 상세 정보"),s&&(s.textContent="")}function editHistoryItem(){if(selectedEventIndex<0||selectedEventIndex>=currentHistoryEvents.length){alert("수정할 항목을 선택하세요");return}const t=currentHistoryEvents[selectedEventIndex];console.log("🖊️ 항목 수정:",t.id),alert(`"${t.title}" 항목을 수정합니다.

(실제 수정 UI는 추후 구현)`)}function restartFromHistoryItem(){if(selectedEventIndex<0||selectedEventIndex>=currentHistoryEvents.length){alert("재시작할 항목을 선택하세요");return}const t=currentHistoryEvents[selectedEventIndex];console.log("🔄 재시작:",t.id),confirm(`"${t.title}" 부터 다시 시작하시겠습니까?

이전 작업 내용은 보존됩니다.`)&&alert(`재시작 요청 완료.

(실제 재시작 처리는 추후 구현)`)}function formatEventTime(t){const s=new Date-t,e=Math.floor(s/(1e3*60*60*24)),o=Math.floor(s/(1e3*60*60)),n=Math.floor(s/(1e3*60));return e>0?`${e}일 전`:o>0?`${o}시간 전`:n>0?`${n}분 전`:"방금 전"}function formatMetadata(t){return typeof t=="number"?t>1e3?(t/1e3).toFixed(1)+"K":t.toString():typeof t=="boolean"?t?"예":"아니오":t.toString()}function getStatusColor(t){return{완료:"#10b981",진행중:"#f59e0b",대기:"#6366f1",실패:"#ef4444",취소:"#64748b"}[t]||"#3a7bd5"}console.log("[orbit3d-history] History popup system initialized"),window.showHistoryPopup=showHistoryPopup,window.closeHistoryPopup=closeHistoryPopup,window.selectHistoryEvent=selectHistoryEvent,window.editHistoryItem=editHistoryItem,window.restartFromHistoryItem=restartFromHistoryItem;
