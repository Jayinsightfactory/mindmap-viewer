class SelectionLayoutManager{constructor(){this.selectedNode=null,this.selectedNodeData=null,this.selectionStack=[],this.isAnimating=!1,this.panelOpen=!1,this.panelWidth=320,this.camera=null,this.scene=null,this.waitForThreeJS(),this.initPanels(),this.setupEventListeners()}waitForThreeJS(){let e=0;const t=setInterval(()=>{typeof camera<"u"&&typeof scene<"u"?(this.camera=camera,this.scene=scene,console.log("[orbit3d-selection] Three.js 객체 로드 완료"),clearInterval(t)):e++>50&&(console.warn("[orbit3d-selection] Three.js 객체를 찾을 수 없음. 스크립트 로드 순서 확인 필요"),clearInterval(t))},100)}initPanels(){if(!document.getElementById("selection-overlay")){const e=document.createElement("div");e.id="selection-overlay",e.className="sel-overlay",e.innerHTML=`
        <!-- 왼쪽 패널: 선택된 노드 정보 -->
        <div class="sel-panel sel-left">
          <button class="sel-back-btn" onclick="selectionMgr.goBack()" title="뒤로">← 뒤로</button>
          <button class="sel-close-btn" onclick="selectionMgr.closeSelection()" title="닫기">✕</button>

          <div class="sel-node-info" id="sel-node-info">
            <div class="sel-title" id="sel-title">선택됨</div>
            <div class="sel-subtitle" id="sel-subtitle"></div>
            <div class="sel-badges" id="sel-badges"></div>
            <div class="sel-meta" id="sel-meta"></div>
          </div>

          <!-- 협업자 (상단) -->
          <div class="sel-collaborators-top">
            <div class="sel-label">🤝 팀원</div>
            <div class="sel-collaborators-list" id="sel-collab-top"></div>
          </div>
        </div>

        <!-- 오른쪽 패널: 하위 노드들 -->
        <div class="sel-panel sel-right">
          <div class="sel-label">📋 항목</div>
          <div class="sel-items" id="sel-items"></div>
        </div>

        <!-- 상단 협업자 -->
        <div class="sel-panel sel-top">
          <div class="sel-label">👥 같은 팀</div>
          <div class="sel-collaborators-grid" id="sel-collab-same"></div>
        </div>

        <!-- 하단 협업자 -->
        <div class="sel-panel sel-bottom">
          <div class="sel-label">🔗 협업자</div>
          <div class="sel-collaborators-grid" id="sel-collab-other"></div>
        </div>
      `,document.body.appendChild(e)}}setupEventListeners(){document.addEventListener("click",e=>{const t=document.getElementById("selection-overlay");t&&e.target===t&&this.closeSelection()}),window.addEventListener("wheel",e=>{this.panelOpen&&this.isAnimating&&e.preventDefault()}),document.addEventListener("keydown",e=>{e.key==="Escape"&&this.panelOpen&&this.closeSelection()})}selectNode(e,t){if(this.isAnimating)return;this.isAnimating=!0,this.selectedNode&&this.selectionStack.push({node:this.selectedNode,data:this.selectedNodeData,cameraPos:{x:camera.position.x,y:camera.position.y,z:camera.position.z}}),this.selectedNode=e,this.selectedNodeData=t,this.panelOpen=!0,this.updateLeftPanel(t),this.updateRightPanel(t.children||[]),this.updateCollaboratorsPanel(t),this.animateCamera(e),this.highlightNode(e);const i=document.getElementById("selection-overlay");i.style.opacity="0",i.style.pointerEvents="auto",i.style.display="flex",setTimeout(()=>{i.style.opacity="1"},50),setTimeout(()=>{this.isAnimating=!1},600)}updateLeftPanel(e){const t=document.getElementById("sel-title"),i=document.getElementById("sel-subtitle"),l=document.getElementById("sel-badges"),a=document.getElementById("sel-meta");t.textContent=e.name||"노드",i.textContent=e.type||"";let s="";if(e.reliability){const c=Math.round(e.reliability/20);s+=`<span class="sel-badge">⭐ ${"⭐".repeat(c)}</span>`}e.status&&(s+=`<span class="sel-badge">${e.status}</span>`),l.innerHTML=s;let n="";e.department&&(n+=`<div>📍 부서: ${e.department}</div>`),e.team&&(n+=`<div>👥 팀: ${e.team}</div>`),e.duration&&(n+=`<div>⏱️ 기간: ${e.duration}</div>`),e.progress!==void 0&&(n+=`<div>📊 진행률: ${e.progress}%</div>`),a.innerHTML=n}updateRightPanel(e){const t=document.getElementById("sel-items");if(!e||e.length===0){t.innerHTML='<div class="sel-empty">항목 없음</div>';return}t.innerHTML=e.map((i,l)=>`
      <div class="sel-item" onclick="selectionMgr.selectNode(null, ${JSON.stringify(i)})">
        <div class="sel-item-icon">${i.icon||"◆"}</div>
        <div class="sel-item-name">${i.name}</div>
        <div class="sel-item-sub">${i.subtitle||""}</div>
      </div>
    `).join("")}updateCollaboratorsPanel(e){const t=e.collaborators?.sameTeam||[],i=e.collaborators?.otherTeam||[],l=document.getElementById("sel-collab-same");l.innerHTML=t.map(s=>`
      <div class="sel-collab" onclick="selectionMgr.selectNode(null, ${JSON.stringify(s)})">
        <div class="sel-collab-avatar">${s.avatar||s.name?.[0]||"?"}</div>
        <div class="sel-collab-name">${s.name}</div>
      </div>
    `).join("");const a=document.getElementById("sel-collab-other");a.innerHTML=i.map(s=>`
      <div class="sel-collab" onclick="selectionMgr.selectNode(null, ${JSON.stringify(s)})">
        <div class="sel-collab-avatar">${s.avatar||s.name?.[0]||"?"}</div>
        <div class="sel-collab-name">${s.name}</div>
      </div>
    `).join("")}animateCamera(e){if(!e||!e.position||!this.camera){console.warn("Invalid node or camera not ready");return}const t=e.position.clone(),i=3,l=new THREE.Vector3(0,0,1).normalize(),a=t.clone().add(l.multiplyScalar(i));if(typeof TWEEN<"u"&&this.camera){const s={x:this.camera.position.x,y:this.camera.position.y,z:this.camera.position.z};new TWEEN.Tween(s).to(a,600).easing(TWEEN.Easing.Cubic.InOut).onUpdate(()=>{this.camera.position.set(s.x,s.y,s.z),this.camera.lookAt(t)}).start()}else this.camera&&(this.camera.position.copy(a),this.camera.lookAt(t))}highlightNode(e){if(e&&(this.clearHighlight(),e.material&&(e.material.emissive.setHex(65535),e.material.emissiveIntensity=.5),e.scale)){const t={x:e.scale.x,y:e.scale.y,z:e.scale.z};typeof TWEEN<"u"&&new TWEEN.Tween(e.scale).to({x:e.scale.x*1.2,y:e.scale.y*1.2,z:e.scale.z*1.2},400).easing(TWEEN.Easing.Cubic.Out).start()}}clearHighlight(){this.selectedNode&&this.selectedNode.material&&(this.selectedNode.material.emissive.setHex(0),this.selectedNode.material.emissiveIntensity=0)}closeSelection(){this.panelOpen=!1,this.clearHighlight();const e=document.getElementById("selection-overlay");e.style.opacity="0",setTimeout(()=>{e.style.display="none"},300),this.resetCamera(),this.selectedNode=null,this.selectedNodeData=null}goBack(){if(this.selectionStack.length===0){this.closeSelection();return}const e=this.selectionStack.pop();this.selectedNode=e.node,this.selectedNodeData=e.data,this.updateLeftPanel(e.data),this.updateRightPanel(e.data.children||[]),this.updateCollaboratorsPanel(e.data),e.cameraPos&&camera.position.set(e.cameraPos.x,e.cameraPos.y,e.cameraPos.z)}resetCamera(){if(this.camera)if(typeof TWEEN<"u"){const e={x:this.camera.position.x,y:this.camera.position.y,z:this.camera.position.z},t={x:0,y:0,z:15};new TWEEN.Tween(e).to(t,600).easing(TWEEN.Easing.Cubic.InOut).onUpdate(()=>{this.camera.position.set(e.x,e.y,e.z),this.camera.lookAt(0,0,0)}).start()}else this.camera.position.set(0,0,15),this.camera.lookAt(0,0,0)}getBreadcrumb(){const e=[];for(let t=0;t<this.selectionStack.length;t++)e.push(this.selectionStack[t].data.name);return this.selectedNodeData&&e.push(this.selectedNodeData.name),e.join(" > ")}}window.selectionMgr=new SelectionLayoutManager;const selectionMgr=window.selectionMgr;console.log("[orbit3d-selection] Selection manager 인스턴스 생성됨");function onNodeClicked(o,e){window.selectionMgr&&window.selectionMgr.selectNode(o,e)}
