async function loadAccountTab(){const e=localStorage.getItem("orbit_token");if(!e){document.getElementById("account-login").style.display="",document.getElementById("account-profile").style.display="none";return}try{const t=await fetch("/api/auth/me",{headers:{Authorization:"Bearer "+e}});if(!t.ok)throw new Error("unauthorized");const o=await t.json();document.getElementById("account-login").style.display="none",document.getElementById("account-profile").style.display="";const a=document.getElementById("profile-avatar");o.avatar?a.innerHTML=`<img src="${o.avatar}" style="width:100%;height:100%;object-fit:cover">`:a.textContent=(o.name||"?")[0].toUpperCase(),document.getElementById("profile-name").textContent=o.name||"이름 없음",document.getElementById("profile-email").textContent=o.email||"";const i=o.plan||"free",r={free:"#8b949e",pro:"#58a6ff",team:"#3fb950",enterprise:"#ffa657"};document.getElementById("profile-plan").innerHTML=`<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:${r[i]||"#8b949e"}22;color:${r[i]||"#8b949e"};border:1px solid ${r[i]||"#8b949e"}44">${i.toUpperCase()}</span>`}catch{localStorage.removeItem("orbit_token"),document.getElementById("account-login").style.display="",document.getElementById("account-profile").style.display="none"}}function doLogout(){localStorage.removeItem("orbit_token"),fetch("/api/auth/logout",{method:"DELETE"}).catch(e=>console.warn("[auth] 로그아웃 실패:",e.message)),document.getElementById("account-login").style.display="",document.getElementById("account-profile").style.display="none"}async function loadModelTab(){try{const t=await(await fetch("/api/model/status")).json(),o=document.getElementById("ollama-status-badge"),a=document.getElementById("ollama-status-body");t.ollamaConnected?(o.style.background="rgba(63,185,80,0.15)",o.style.color="#3fb950",o.textContent="● 연결됨",a.textContent=`Ollama ${t.ollamaVersion||""} — ${t.ollamaUrl||"http://localhost:11434"}`):(o.style.background="rgba(248,81,73,0.15)",o.style.color="#f85149",o.textContent="● 미연결",a.textContent="Ollama가 실행되지 않습니다. ollama serve 명령으로 시작하세요."),document.getElementById("active-model-name").textContent=t.activeModel||"llama3.2 (기본)",document.getElementById("active-model-meta").textContent=t.trainedAt?`학습일: ${new Date(t.trainedAt).toLocaleString("ko-KR")}`:"기본 모델 사용 중 — 학습 후 업그레이드됩니다"}catch{document.getElementById("ollama-status-badge").textContent="● 오류"}try{const t=await(await fetch("/api/model/list")).json(),o=document.getElementById("model-list-body");t.length?o.innerHTML=t.map(a=>`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(48,54,61,0.3)">
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text)">${a}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button onclick="activateModel('${a}')"
              style="padding:3px 8px;border-radius:4px;border:1px solid var(--accent);background:rgba(137,87,229,0.1);color:var(--accent);font-size:10px;cursor:pointer;font-family:inherit">
              활성화
            </button>
            <button onclick="deleteModel('${a}')"
              style="padding:3px 8px;border-radius:4px;border:1px solid rgba(248,81,73,0.3);background:rgba(248,81,73,0.1);color:#f85149;font-size:10px;cursor:pointer;font-family:inherit">
              삭제
            </button>
          </div>
        </div>`).join(""):o.innerHTML='<div class="empty">학습된 orbit-* 모델 없음</div>'}catch{}try{const t=await(await fetch("/api/model/training-data")).json(),o=document.getElementById("training-preview");!t.pairs||!t.pairs.length?o.innerHTML='<div class="empty">학습 데이터 없음</div>':o.innerHTML=t.pairs.slice(0,5).map(a=>`
        <div style="margin-bottom:10px;padding:8px;background:var(--bg3);border-radius:6px;font-size:11px">
          <div style="color:var(--blue);margin-bottom:3px">📥 ${escHtml((a.prompt||"").slice(0,100))}${(a.prompt||"").length>100?"…":""}</div>
          <div style="color:var(--green)">📤 ${escHtml((a.response||"").slice(0,100))}${(a.response||"").length>100?"…":""}</div>
        </div>`).join("")}catch{}}async function activateModel(e){(await fetch("/api/model/activate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({modelName:e})})).ok&&(alert(`✅ ${e} 활성화 완료`),loadModelTab())}async function deleteModel(e){if(!confirm(`"${e}" 모델을 삭제할까요?`))return;(await fetch(`/api/model/${encodeURIComponent(e)}`,{method:"DELETE"})).ok&&loadModelTab()}async function startTraining(){const e=document.getElementById("train-btn"),t=document.getElementById("train-progress"),o=document.getElementById("train-status"),a=document.getElementById("train-bar");e.disabled=!0,e.textContent="학습 중...",t.style.display="",o.textContent="학습 데이터 추출 중...",a.style.width="20%";try{const i=await fetch("/api/model/train",{method:"POST"}),r=await i.json();i.ok?(a.style.width="100%",o.textContent=`✅ 완료: ${r.modelName}`,setTimeout(()=>loadModelTab(),1500)):o.textContent=`❌ 오류: ${r.error}`}catch(i){o.textContent=`❌ 오류: ${i.message}`}finally{e.disabled=!1,e.textContent="🚀 학습 시작",setTimeout(()=>{t.style.display="none",a.style.width="0%"},3e3)}}const _origSwitchTab=window.switchTab;window.switchTab=function(e){document.querySelectorAll(".tab-btn").forEach(o=>o.classList.remove("active")),document.querySelectorAll(".tab-content").forEach(o=>{o.classList.remove("active"),o.style.display="none"});const t=document.getElementById("tab-"+e);t&&(t.classList.add("active"),t.style.display=""),document.querySelectorAll(".tab-btn").forEach(o=>{o.getAttribute("onclick")===`switchTab('${e}')`&&o.classList.add("active")}),e==="account"&&loadAccountTab(),e==="localmodel"&&loadModelTab(),e==="accessibility"&&loadAccessibilityTab(),e==="costs"&&loadCostsTab(),e==="roi"&&loadRoiTab(),e==="leaderboard"&&loadLeaderboardTab(),e==="certificate"&&loadCertificateTab(),e==="points"&&loadPointsTab()};function loadAccessibilityTab(){const e=document.getElementById("tab-accessibility");if(!e||e._loaded)return;e._loaded=!0;const t=localStorage.getItem("orbit_colorblind")==="1",o=window.matchMedia("(prefers-reduced-motion: reduce)").matches,a=window.matchMedia("(prefers-contrast: high)").matches;e.innerHTML=`
    <div class="card">
      <div class="card-header"><span class="card-title">♿ 접근성 설정</span></div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:14px">

          <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">
            <div>
              <div style="font-weight:600;margin-bottom:2px">🎨 색맹 지원 모드</div>
              <div style="font-size:12px;color:var(--text3)">색상 조합을 색맹 친화적으로 변경합니다 (Paul Tol 팔레트)</div>
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="cb-colorblind" ${t?"checked":""} onchange="toggleCbMode(this.checked)" />
              <span id="cb-status" style="font-size:12px;color:${t?"var(--green)":"var(--text3)"}">${t?"활성":"비활성"}</span>
            </label>
          </div>

          <div style="padding:10px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">
            <div style="font-weight:600;margin-bottom:6px">⌨️ 키보드 단축키</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;font-size:12px;color:var(--text3)">
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">Tab</kbd> 다음 노드 이동</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">Shift+Tab</kbd> 이전 노드</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">Enter</kbd> 노드 줌</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">Escape</kbd> 패널 닫기</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">Arrow</kbd> 카메라 이동</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">F</kbd> 전체 보기</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">?</kbd> 단축키 도움말</div>
              <div><kbd style="background:var(--bg);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">Ctrl+K</kbd> 노드 검색</div>
            </div>
          </div>

          <div style="padding:10px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">
            <div style="font-weight:600;margin-bottom:6px">🖥️ 시스템 접근성 설정</div>
            <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text3)">
              <div>움직임 감소 모드: <span style="color:${o?"var(--green)":"var(--text-muted)"}">${o?"✓ 활성 (시스템 설정)":"비활성"}</span></div>
              <div>고대비 모드: <span style="color:${a?"var(--green)":"var(--text-muted)"}">${a?"✓ 활성 (시스템 설정)":"비활성"}</span></div>
            </div>
          </div>

          <div style="padding:10px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">
            <div style="font-weight:600;margin-bottom:6px">🔗 유용한 링크</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <a href="/orbit-timeline.html" style="color:var(--blue);font-size:12px;text-decoration:none">⏱ 타임라인 뷰</a>
              <a href="/team-dashboard.html" style="color:var(--blue);font-size:12px;text-decoration:none">👥 팀 대시보드</a>
              <a href="/contributor-dashboard.html" style="color:var(--blue);font-size:12px;text-decoration:none">💰 기여자 대시보드</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `}function toggleCbMode(e){localStorage.setItem("orbit_colorblind",e?"1":"0");const t=document.getElementById("cb-status");t&&(t.textContent=e?"활성":"비활성",t.style.color=e?"var(--green)":"var(--text3)")}async function loadCostsTab(){const e=document.getElementById("tab-costs");if(e){e.innerHTML='<div style="padding:20px;color:var(--text3)">비용 데이터 로딩 중...</div>';try{const[t,o]=await Promise.all([fetch("/api/costs/dashboard?days=30").then(i=>i.json()),fetch("/api/costs/by-date?days=30").then(i=>i.json())]),a=t.summary||{};e.innerHTML=`
      <div class="card">
        <div class="card-header"><span class="card-title">💸 AI 토큰 비용 추적 (최근 30일)</span></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px">
            ${[["총 비용","$"+(a.totalCostUsd||0).toFixed(4)],["총 토큰",((a.totalTokens||0)/1e3).toFixed(1)+"K"],["이벤트 수",(a.eventCount||0).toLocaleString()],["일 평균","$"+(a.avgDailyCost||0).toFixed(4)]].map(([i,r])=>`
              <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">
                <div style="font-size:18px;font-weight:700;color:var(--blue)">${r}</div>
                <div style="font-size:11px;color:var(--text3)">${i}</div>
              </div>
            `).join("")}
          </div>

          ${t.byModel?.length?`
            <div style="margin-bottom:16px">
              <div style="font-weight:600;margin-bottom:8px;font-size:13px">모델별 비용</div>
              ${t.byModel.slice(0,5).map(i=>`
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px;font-size:12px">
                  <span style="color:var(--text2)">${i.model}</span>
                  <span style="color:var(--blue)">$${i.cost?.toFixed(4)||"0"}</span>
                  <span style="color:var(--text3)">${i.events}회</span>
                </div>
              `).join("")}
            </div>
          `:""}

          <div style="text-align:right;margin-top:8px">
            <a href="/api/costs/dashboard" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 JSON 보기 →</a>
          </div>
          ${a.estimatedRatio>0?`<div style="font-size:11px;color:var(--text3);margin-top:8px">※ ${a.estimatedRatio}%는 추정 토큰 수 사용</div>`:""}
        </div>
      </div>
    `}catch(t){e.innerHTML=`<div style="padding:20px;color:var(--red)">비용 데이터 로드 실패: ${t.message}</div>`}}}async function loadRoiTab(){const e=document.getElementById("tab-roi");if(!(!e||e._loaded)){e._loaded=!0,e.innerHTML='<div style="padding:20px;color:var(--text3)">ROI 계산 중...</div>';try{const[t,o]=await Promise.all([fetch("/api/roi/dashboard").then(d=>d.json()),fetch("/api/roi/projection?months=6").then(d=>d.json())]),a=t.individual||{},i=t.grade||{},n={S:"#ffd700",A:"#58a6ff",B:"#3fb950",C:"#d29922",D:"#f0883e",F:"#f85149"}[i.grade]||"#8b949e";e.innerHTML=`
      <div class="card">
        <div class="card-header">
          <span class="card-title">📊 AI 투자 수익률 (ROI)</span>
          <span style="font-size:20px;font-weight:700;color:${n}">${i.grade||"?"} <span style="font-size:13px">${i.label||""}</span></span>
        </div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
            ${[["절감 시간",`${a.savedHours||0}h`,"#3fb950"],["절감 비용",`$${a.savedUsd||0}`,"#58a6ff"],["ROI",`${a.roiPct||0}%`,n],["도구 비용",`$${a.toolCostUsd||0}`,"#f85149"],["순 절감액",`$${a.netSavedUsd||0}`,"#bc8cff"],["활동 기간",`${t.meta?.monthsActive||0}개월`,"#ffa657"]].map(([d,s,l])=>`
              <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${d}</div>
                <div style="font-size:18px;font-weight:700;color:${l}">${s}</div>
              </div>
            `).join("")}
          </div>

          ${o.projections?.length?`
            <div style="font-weight:600;font-size:13px;margin-bottom:8px">📈 향후 6개월 예측</div>
            <div style="overflow-x:auto">
              <table style="width:100%;font-size:12px;border-collapse:collapse">
                <tr style="color:var(--text3);border-bottom:1px solid var(--border)">
                  <th style="padding:6px;text-align:left">월</th>
                  <th style="padding:6px;text-align:right">절감시간</th>
                  <th style="padding:6px;text-align:right">절감비용</th>
                  <th style="padding:6px;text-align:right">ROI</th>
                </tr>
                ${o.projections.map(d=>`
                  <tr style="border-bottom:1px solid rgba(48,54,61,0.4)">
                    <td style="padding:6px;color:var(--text2)">${d.month}개월차</td>
                    <td style="padding:6px;text-align:right;color:var(--green)">${d.savedHours}h</td>
                    <td style="padding:6px;text-align:right;color:var(--blue)">$${d.savedUsd}</td>
                    <td style="padding:6px;text-align:right;color:${d.roiPct>100?"var(--green)":"var(--orange)"}">${d.roiPct}%</td>
                  </tr>
                `).join("")}
              </table>
            </div>
            ${o.breakEvenMonth?`<div style="margin-top:10px;font-size:12px;color:var(--green)">✅ 손익분기점: ${o.breakEvenMonth}개월차</div>`:""}
          `:""}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/roi/dashboard" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 JSON →</a>
            <a href="/api/roi/comparison" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">Before/After →</a>
          </div>
        </div>
      </div>
    `}catch(t){e.innerHTML=`<div style="padding:20px;color:var(--red)">ROI 로드 실패: ${t.message}</div>`}}}async function loadLeaderboardTab(){const e=document.getElementById("tab-leaderboard");if(!(!e||e._loaded)){e._loaded=!0,e.innerHTML='<div style="padding:20px;color:var(--text3)">리더보드 로딩 중...</div>';try{const[t,o]=await Promise.all([fetch("/api/leaderboard?limit=10").then(a=>a.json()),fetch("/api/leaderboard/me").then(a=>a.json())]);e.innerHTML=`
      <div class="card">
        <div class="card-header">
          <span class="card-title">🏆 AI 활용 리더보드</span>
          ${o.rank?`<span style="color:var(--blue);font-size:12px">${o.rank}위 / ${o.total}명</span>`:""}
        </div>
        <div class="card-body">
          ${o.rank?`
            <div style="background:rgba(88,166,255,0.08);border:1px solid rgba(88,166,255,0.3);border-radius:8px;padding:12px;margin-bottom:16px">
              <div style="font-size:12px;color:var(--text3);margin-bottom:4px">내 순위</div>
              <div style="display:flex;gap:16px;align-items:center">
                <span style="font-size:24px;font-weight:700;color:var(--blue)">#${o.rank}</span>
                <div>
                  <div style="font-size:13px">점수: <strong>${o.score}</strong></div>
                  <div style="font-size:11px;color:var(--text3)">상위 ${o.percentile}% | ${o.events}개 이벤트 | ${o.streak}일 연속</div>
                </div>
              </div>
            </div>
          `:""}

          <div style="font-weight:600;font-size:13px;margin-bottom:8px">전체 랭킹 TOP 10</div>
          ${(t.leaderboard||[]).map(a=>`
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px">
              <span style="font-size:16px;min-width:24px;text-align:center">${a.medal||a.rank}</span>
              <span style="font-size:13px;flex:1;color:var(--text2)">${a.userId}</span>
              <span style="font-size:12px;color:var(--text3)">${a.streak}일 🔥</span>
              <span style="font-size:13px;font-weight:600;color:var(--blue)">${a.score}pt</span>
            </div>
          `).join("")}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/leaderboard" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 랭킹 →</a>
            <a href="/api/leaderboard/achievements/local" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">업적 보기 →</a>
          </div>
        </div>
      </div>
    `}catch(t){e.innerHTML=`<div style="padding:20px;color:var(--red)">리더보드 로드 실패: ${t.message}</div>`}}}async function loadCertificateTab(){const e=document.getElementById("tab-certificate");if(!(!e||e._loaded)){e._loaded=!0,e.innerHTML='<div style="padding:20px;color:var(--text3)">인증서 로딩 중...</div>';try{const t=await fetch("/api/certificate/local/score").then(i=>i.json()),a={Master:"#0ea5e9",Expert:"#d97706",Proficient:"#059669",Practitioner:"#db2777",Beginner:"#4b5563"}[t.grade?.tier]||"#8b949e";e.innerHTML=`
      <div class="card">
        <div class="card-header">
          <span class="card-title">🎓 Orbit AI 인증서</span>
          <span style="color:${a};font-weight:700">${t.grade?.emoji||""} ${t.grade?.label||""}</span>
        </div>
        <div class="card-body">
          <div style="text-align:center;margin-bottom:20px">
            <div style="font-size:56px;font-weight:700;color:${a}">${t.total}</div>
            <div style="font-size:14px;color:var(--text3)">/1000 점</div>
          </div>

          <div style="margin-bottom:16px">
            ${Object.entries(t.breakdown||{}).map(([i,r])=>{const n={volume:"사용량(300)",diversity:"다양성(200)",depth:"깊이(200)",consistency:"일관성(150)",contribution:"기여(150)"},s={volume:300,diversity:200,depth:200,consistency:150,contribution:150}[i]||100;return`
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-bottom:3px">
                    <span>${n[i]||i}</span><span>${r}/${s}</span>
                  </div>
                  <div style="background:var(--bg3);border-radius:4px;height:8px;overflow:hidden">
                    <div style="background:${a};height:100%;width:${Math.round(r/s*100)}%;border-radius:4px;transition:width 0.5s"></div>
                  </div>
                </div>
              `}).join("")}
          </div>

          ${t.total>=200?`
            <button onclick="issueCertificate()" style="width:100%;padding:10px;background:${a};color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
              🎓 인증서 발급하기
            </button>
          `:`
            <div style="text-align:center;color:var(--text3);font-size:12px;padding:12px;background:var(--bg3);border-radius:8px">
              발급 최소 점수: 200점 (현재 ${t.total}점)
            </div>
          `}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/certificate/local/svg" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">SVG 미리보기 →</a>
            <a href="/api/certificate/local/json" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">JSON 검증 →</a>
          </div>
        </div>
      </div>

      <!-- 배지 README 스니펫 생성기 -->
      <div class="card">
        <div class="card-header"><span class="card-title">📛 GitHub README 배지</span><span class="card-sub">복사해서 바로 사용</span></div>
        <div class="card-body">
          <div style="margin-bottom:12px">
            <img src="/api/badge/local/svg?type=events" alt="Orbit AI events" style="height:20px;margin-right:6px;vertical-align:middle">
            <img src="/api/badge/local/svg?type=saved" alt="Orbit AI saved" style="height:20px;margin-right:6px;vertical-align:middle">
            <img src="/api/badge/local/svg?type=streak" alt="Orbit AI streak" style="height:20px;vertical-align:middle">
          </div>
          <div style="margin-bottom:8px">
            <img src="/api/badge/local/card" alt="Orbit AI profile card" style="max-width:100%;border-radius:6px">
          </div>
          <div style="font-size:11px;color:var(--text3);margin-bottom:6px">README.md에 복사하세요:</div>
          ${["events","saved","streak"].map(i=>{const r=location.origin,n=`[![Orbit AI](${r}/api/badge/local/svg?type=${i})](${r})`;return`
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <code style="flex:1;font-size:11px;background:var(--bg3);padding:6px 10px;border-radius:6px;color:var(--text2);overflow:auto;white-space:nowrap">${n.replace(/</g,"&lt;")}</code>
                <button onclick="navigator.clipboard.writeText('${n.replace(/'/g,"\\'")}').then(()=>this.textContent='✅').catch(()=>{})" style="padding:4px 10px;font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;color:var(--text3);cursor:pointer;font-family:inherit;white-space:nowrap">복사</button>
              </div>
            `}).join("")}
          <div style="font-size:11px;color:var(--text3);margin-top:10px">
            프로필 카드: <code style="font-size:11px;background:var(--bg3);padding:3px 8px;border-radius:4px;color:var(--blue)">[![Orbit AI Card](${location.origin}/api/badge/local/card)](${location.origin})</code>
            <button onclick="navigator.clipboard.writeText('[![Orbit AI Card](${location.origin}/api/badge/local/card)](${location.origin})').then(()=>this.textContent='✅').catch(()=>{})" style="margin-left:6px;padding:3px 8px;font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;font-family:inherit">복사</button>
          </div>
        </div>
      </div>
    `}catch(t){e.innerHTML=`<div style="padding:20px;color:var(--red)">인증서 로드 실패: ${t.message}</div>`}}}async function issueCertificate(){try{const t=await(await fetch("/api/certificate/local/issue",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();if(t.success){alert(`✅ 인증서 발급 완료!
등급: ${t.grade?.label}
점수: ${t.score}/1000

${t.linkedinSnippet}`);const o=document.getElementById("tab-certificate");o&&(delete o._loaded,loadCertificateTab())}else alert("오류: "+(t.error||"발급 실패"))}catch(e){alert("발급 오류: "+e.message)}}async function loadPointsTab(){const e=document.getElementById("tab-points");if(!(!e||e._loaded)){e._loaded=!0,e.innerHTML='<div style="padding:20px;color:var(--text3)">포인트 로딩 중...</div>';try{const[t,o]=await Promise.all([fetch("/api/points/balance").then(a=>a.json()),fetch("/api/points/rewards").then(a=>a.json())]);e.innerHTML=`
      <div class="card">
        <div class="card-header">
          <span class="card-title">⭐ Orbit Points</span>
          <span style="color:var(--orange);font-weight:700">${t.balance?.toLocaleString()||0}pt</span>
        </div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
            ${[["잔액",`${(t.balance||0).toLocaleString()}pt`,"#ffa657"],["총 획득",`${(t.totalEarned||0).toLocaleString()}pt`,"#3fb950"],["레벨",`Lv.${t.level||1} (${t.levelTitle||""})`,"#bc8cff"]].map(([a,i,r])=>`
              <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${a}</div>
                <div style="font-size:14px;font-weight:700;color:${r}">${i}</div>
              </div>
            `).join("")}
          </div>

          ${t.level?`
            <div style="margin-bottom:16px">
              <div style="font-size:11px;color:var(--text3);margin-bottom:4px">레벨 진행도 (${t.progress||0}%)</div>
              <div style="background:var(--bg3);border-radius:4px;height:8px;overflow:hidden">
                <div style="background:linear-gradient(90deg,#bc8cff,#f778ba);height:100%;width:${t.progress||0}%;border-radius:4px;transition:width 0.5s"></div>
              </div>
            </div>
          `:""}

          <div style="font-weight:600;font-size:13px;margin-bottom:8px">🎁 사용 가능 리워드</div>
          ${(o.rewards||[]).slice(0,5).map(a=>`
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px;opacity:${a.affordable?1:.5}">
              <div>
                <div style="font-size:13px;color:var(--text)">${a.name}</div>
                <div style="font-size:11px;color:var(--text3)">${a.description}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:12px;font-weight:600;color:var(--orange)">${a.cost}pt</div>
                ${a.affordable?`<button onclick="redeemReward('${a.id}')" style="font-size:10px;padding:3px 8px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;margin-top:2px">교환</button>`:""}
              </div>
            </div>
          `).join("")}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/points/rewards" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 리워드 →</a>
            <a href="/api/points/leaderboard" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">포인트 랭킹 →</a>
          </div>
        </div>
      </div>
    `}catch(t){e.innerHTML=`<div style="padding:20px;color:var(--red)">포인트 로드 실패: ${t.message}</div>`}}}async function redeemReward(e){try{const o=await(await fetch("/api/points/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rewardId:e})})).json();if(o.success){alert(`✅ 교환 완료! 남은 포인트: ${o.balance}pt`);const a=document.getElementById("tab-points");a&&(delete a._loaded,loadPointsTab())}else alert("오류: "+(o.error||"교환 실패"))}catch(t){alert("교환 오류: "+t.message)}}
