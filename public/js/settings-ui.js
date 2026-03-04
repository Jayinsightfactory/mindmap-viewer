// ── 계정 탭 로직 ──
async function loadAccountTab() {
  const token = localStorage.getItem('orbit_token');
  if (!token) {
    document.getElementById('account-login').style.display = '';
    document.getElementById('account-profile').style.display = 'none';
    return;
  }
  try {
    const res  = await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('unauthorized');
    const user = await res.json();
    document.getElementById('account-login').style.display = 'none';
    document.getElementById('account-profile').style.display = '';
    const avatarEl = document.getElementById('profile-avatar');
    if (user.avatar) avatarEl.innerHTML = `<img src="${user.avatar}" style="width:100%;height:100%;object-fit:cover">`;
    else avatarEl.textContent = (user.name || '?')[0].toUpperCase();
    document.getElementById('profile-name').textContent  = user.name  || '이름 없음';
    document.getElementById('profile-email').textContent = user.email || '';
    const plan = user.plan || 'free';
    const planColors = { free:'#8b949e', pro:'#58a6ff', team:'#3fb950', enterprise:'#ffa657' };
    document.getElementById('profile-plan').innerHTML =
      `<span style="font-size:11px;padding:2px 8px;border-radius:8px;background:${planColors[plan]||'#8b949e'}22;color:${planColors[plan]||'#8b949e'};border:1px solid ${planColors[plan]||'#8b949e'}44">${plan.toUpperCase()}</span>`;
  } catch {
    localStorage.removeItem('orbit_token');
    document.getElementById('account-login').style.display = '';
    document.getElementById('account-profile').style.display = 'none';
  }
}

function doLogout() {
  localStorage.removeItem('orbit_token');
  fetch('/api/auth/logout', { method: 'DELETE' }).catch(() => {});
  document.getElementById('account-login').style.display = '';
  document.getElementById('account-profile').style.display = 'none';
}

// ── 로컬 모델 탭 로직 ──
async function loadModelTab() {
  // Ollama 연결 상태
  try {
    const res    = await fetch('/api/model/status');
    const data   = await res.json();
    const badge  = document.getElementById('ollama-status-badge');
    const body   = document.getElementById('ollama-status-body');
    if (data.ollamaConnected) {
      badge.style.background = 'rgba(63,185,80,0.15)';
      badge.style.color      = '#3fb950';
      badge.textContent      = '● 연결됨';
      body.textContent       = `Ollama ${data.ollamaVersion || ''} — ${data.ollamaUrl || 'http://localhost:11434'}`;
    } else {
      badge.style.background = 'rgba(248,81,73,0.15)';
      badge.style.color      = '#f85149';
      badge.textContent      = '● 미연결';
      body.textContent       = 'Ollama가 실행되지 않습니다. ollama serve 명령으로 시작하세요.';
    }
    // 활성 모델
    document.getElementById('active-model-name').textContent  = data.activeModel || 'llama3.2 (기본)';
    document.getElementById('active-model-meta').textContent  = data.trainedAt
      ? `학습일: ${new Date(data.trainedAt).toLocaleString('ko-KR')}`
      : '기본 모델 사용 중 — 학습 후 업그레이드됩니다';
  } catch (e) {
    document.getElementById('ollama-status-badge').textContent = '● 오류';
  }

  // 모델 목록
  try {
    const res    = await fetch('/api/model/list');
    const models = await res.json();
    const el     = document.getElementById('model-list-body');
    if (!models.length) {
      el.innerHTML = '<div class="empty">학습된 orbit-* 모델 없음</div>';
    } else {
      el.innerHTML = models.map(m => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(48,54,61,0.3)">
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text)">${m}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button onclick="activateModel('${m}')"
              style="padding:3px 8px;border-radius:4px;border:1px solid var(--accent);background:rgba(137,87,229,0.1);color:var(--accent);font-size:10px;cursor:pointer;font-family:inherit">
              활성화
            </button>
            <button onclick="deleteModel('${m}')"
              style="padding:3px 8px;border-radius:4px;border:1px solid rgba(248,81,73,0.3);background:rgba(248,81,73,0.1);color:#f85149;font-size:10px;cursor:pointer;font-family:inherit">
              삭제
            </button>
          </div>
        </div>`).join('');
    }
  } catch {}

  // 학습 데이터 미리보기
  try {
    const res  = await fetch('/api/model/training-data');
    const data = await res.json();
    const el   = document.getElementById('training-preview');
    if (!data.pairs || !data.pairs.length) {
      el.innerHTML = '<div class="empty">학습 데이터 없음</div>';
    } else {
      el.innerHTML = data.pairs.slice(0, 5).map(p => `
        <div style="margin-bottom:10px;padding:8px;background:var(--bg3);border-radius:6px;font-size:11px">
          <div style="color:var(--blue);margin-bottom:3px">📥 ${escHtml((p.prompt||'').slice(0,100))}${(p.prompt||'').length>100?'…':''}</div>
          <div style="color:var(--green)">📤 ${escHtml((p.response||'').slice(0,100))}${(p.response||'').length>100?'…':''}</div>
        </div>`).join('');
    }
  } catch {}
}

async function activateModel(name) {
  const res = await fetch('/api/model/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelName: name }),
  });
  if (res.ok) { alert(`✅ ${name} 활성화 완료`); loadModelTab(); }
}

async function deleteModel(name) {
  if (!confirm(`"${name}" 모델을 삭제할까요?`)) return;
  const res = await fetch(`/api/model/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (res.ok) loadModelTab();
}

async function startTraining() {
  const btn      = document.getElementById('train-btn');
  const progress = document.getElementById('train-progress');
  const status   = document.getElementById('train-status');
  const bar      = document.getElementById('train-bar');
  btn.disabled   = true;
  btn.textContent = '학습 중...';
  progress.style.display = '';
  status.textContent = '학습 데이터 추출 중...';
  bar.style.width = '20%';

  try {
    const res  = await fetch('/api/model/train', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      bar.style.width = '100%';
      status.textContent = `✅ 완료: ${data.modelName}`;
      setTimeout(() => loadModelTab(), 1500);
    } else {
      status.textContent = `❌ 오류: ${data.error}`;
    }
  } catch (e) {
    status.textContent = `❌ 오류: ${e.message}`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '🚀 학습 시작';
    setTimeout(() => { progress.style.display = 'none'; bar.style.width = '0%'; }, 3000);
  }
}

// ── switchTab 오버라이드 (모든 탭 포함) ──
const _origSwitchTab = window.switchTab;
window.switchTab = function(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => { c.classList.remove('active'); c.style.display = 'none'; });
  const target = document.getElementById('tab-' + tab);
  if (target) { target.classList.add('active'); target.style.display = ''; }
  // 탭 버튼 활성화 (onclick 속성 기준)
  document.querySelectorAll('.tab-btn').forEach(b => {
    if (b.getAttribute('onclick') === `switchTab('${tab}')`) b.classList.add('active');
  });
  if (tab === 'account')       loadAccountTab();
  if (tab === 'localmodel')    loadModelTab();
  if (tab === 'accessibility') loadAccessibilityTab();
  if (tab === 'costs')         loadCostsTab();
  if (tab === 'roi')           loadRoiTab();
  if (tab === 'leaderboard')   loadLeaderboardTab();
  if (tab === 'certificate')   loadCertificateTab();
  if (tab === 'points')        loadPointsTab();
};

// ── 접근성 탭 ──
function loadAccessibilityTab() {
  const tab = document.getElementById('tab-accessibility');
  if (!tab || tab._loaded) return;
  tab._loaded = true;

  const colorblind = localStorage.getItem('orbit_colorblind') === '1';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const highContrast  = window.matchMedia('(prefers-contrast: high)').matches;

  tab.innerHTML = `
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
              <input type="checkbox" id="cb-colorblind" ${colorblind ? 'checked' : ''} onchange="toggleCbMode(this.checked)" />
              <span id="cb-status" style="font-size:12px;color:${colorblind ? 'var(--green)' : 'var(--text3)'}">${colorblind ? '활성' : '비활성'}</span>
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
              <div>움직임 감소 모드: <span style="color:${reducedMotion ? 'var(--green)' : 'var(--text-muted)'}">${reducedMotion ? '✓ 활성 (시스템 설정)' : '비활성'}</span></div>
              <div>고대비 모드: <span style="color:${highContrast ? 'var(--green)' : 'var(--text-muted)'}">${highContrast ? '✓ 활성 (시스템 설정)' : '비활성'}</span></div>
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
  `;
}

function toggleCbMode(active) {
  localStorage.setItem('orbit_colorblind', active ? '1' : '0');
  const status = document.getElementById('cb-status');
  if (status) { status.textContent = active ? '활성' : '비활성'; status.style.color = active ? 'var(--green)' : 'var(--text3)'; }
}

// ── 비용 추적 탭 ──
async function loadCostsTab() {
  const tab = document.getElementById('tab-costs');
  if (!tab) return;
  tab.innerHTML = '<div style="padding:20px;color:var(--text3)">비용 데이터 로딩 중...</div>';

  try {
    const [dash, byDate] = await Promise.all([
      fetch('/api/costs/dashboard?days=30').then(r => r.json()),
      fetch('/api/costs/by-date?days=30').then(r => r.json()),
    ]);

    const s = dash.summary || {};
    tab.innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">💸 AI 토큰 비용 추적 (최근 30일)</span></div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:16px">
            ${[
              ['총 비용', '$' + (s.totalCostUsd||0).toFixed(4)],
              ['총 토큰', ((s.totalTokens||0)/1000).toFixed(1) + 'K'],
              ['이벤트 수', (s.eventCount||0).toLocaleString()],
              ['일 평균', '$' + (s.avgDailyCost||0).toFixed(4)],
            ].map(([l,v]) => `
              <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">
                <div style="font-size:18px;font-weight:700;color:var(--blue)">${v}</div>
                <div style="font-size:11px;color:var(--text3)">${l}</div>
              </div>
            `).join('')}
          </div>

          ${dash.byModel?.length ? `
            <div style="margin-bottom:16px">
              <div style="font-weight:600;margin-bottom:8px;font-size:13px">모델별 비용</div>
              ${dash.byModel.slice(0,5).map(m => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px;font-size:12px">
                  <span style="color:var(--text2)">${m.model}</span>
                  <span style="color:var(--blue)">$${m.cost?.toFixed(4)||'0'}</span>
                  <span style="color:var(--text3)">${m.events}회</span>
                </div>
              `).join('')}
            </div>
          ` : ''}

          <div style="text-align:right;margin-top:8px">
            <a href="/api/costs/dashboard" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 JSON 보기 →</a>
          </div>
          ${s.estimatedRatio > 0 ? `<div style="font-size:11px;color:var(--text3);margin-top:8px">※ ${s.estimatedRatio}%는 추정 토큰 수 사용</div>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    tab.innerHTML = `<div style="padding:20px;color:var(--red)">비용 데이터 로드 실패: ${err.message}</div>`;
  }
}

// ── ROI 탭 ──
async function loadRoiTab() {
  const tab = document.getElementById('tab-roi');
  if (!tab || tab._loaded) return;
  tab._loaded = true;
  tab.innerHTML = '<div style="padding:20px;color:var(--text3)">ROI 계산 중...</div>';
  try {
    const [dash, proj] = await Promise.all([
      fetch('/api/roi/dashboard').then(r => r.json()),
      fetch('/api/roi/projection?months=6').then(r => r.json()),
    ]);
    const i = dash.individual || {};
    const g = dash.grade || {};
    const GRADE_COLOR = { S:'#ffd700', A:'#58a6ff', B:'#3fb950', C:'#d29922', D:'#f0883e', F:'#f85149' };
    const gc = GRADE_COLOR[g.grade] || '#8b949e';
    tab.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">📊 AI 투자 수익률 (ROI)</span>
          <span style="font-size:20px;font-weight:700;color:${gc}">${g.grade || '?'} <span style="font-size:13px">${g.label||''}</span></span>
        </div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
            ${[
              ['절감 시간', `${i.savedHours||0}h`, '#3fb950'],
              ['절감 비용', `$${i.savedUsd||0}`, '#58a6ff'],
              ['ROI', `${i.roiPct||0}%`, gc],
              ['도구 비용', `$${i.toolCostUsd||0}`, '#f85149'],
              ['순 절감액', `$${i.netSavedUsd||0}`, '#bc8cff'],
              ['활동 기간', `${dash.meta?.monthsActive||0}개월`, '#ffa657'],
            ].map(([l,v,c]) => `
              <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${l}</div>
                <div style="font-size:18px;font-weight:700;color:${c}">${v}</div>
              </div>
            `).join('')}
          </div>

          ${proj.projections?.length ? `
            <div style="font-weight:600;font-size:13px;margin-bottom:8px">📈 향후 6개월 예측</div>
            <div style="overflow-x:auto">
              <table style="width:100%;font-size:12px;border-collapse:collapse">
                <tr style="color:var(--text3);border-bottom:1px solid var(--border)">
                  <th style="padding:6px;text-align:left">월</th>
                  <th style="padding:6px;text-align:right">절감시간</th>
                  <th style="padding:6px;text-align:right">절감비용</th>
                  <th style="padding:6px;text-align:right">ROI</th>
                </tr>
                ${proj.projections.map(p => `
                  <tr style="border-bottom:1px solid rgba(48,54,61,0.4)">
                    <td style="padding:6px;color:var(--text2)">${p.month}개월차</td>
                    <td style="padding:6px;text-align:right;color:var(--green)">${p.savedHours}h</td>
                    <td style="padding:6px;text-align:right;color:var(--blue)">$${p.savedUsd}</td>
                    <td style="padding:6px;text-align:right;color:${p.roiPct > 100 ? 'var(--green)' : 'var(--orange)'}">${p.roiPct}%</td>
                  </tr>
                `).join('')}
              </table>
            </div>
            ${proj.breakEvenMonth ? `<div style="margin-top:10px;font-size:12px;color:var(--green)">✅ 손익분기점: ${proj.breakEvenMonth}개월차</div>` : ''}
          ` : ''}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/roi/dashboard" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 JSON →</a>
            <a href="/api/roi/comparison" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">Before/After →</a>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    tab.innerHTML = `<div style="padding:20px;color:var(--red)">ROI 로드 실패: ${err.message}</div>`;
  }
}

// ── 리더보드 탭 ──
async function loadLeaderboardTab() {
  const tab = document.getElementById('tab-leaderboard');
  if (!tab || tab._loaded) return;
  tab._loaded = true;
  tab.innerHTML = '<div style="padding:20px;color:var(--text3)">리더보드 로딩 중...</div>';
  try {
    const [board, me] = await Promise.all([
      fetch('/api/leaderboard?limit=10').then(r => r.json()),
      fetch('/api/leaderboard/me').then(r => r.json()),
    ]);
    tab.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">🏆 AI 활용 리더보드</span>
          ${me.rank ? `<span style="color:var(--blue);font-size:12px">${me.rank}위 / ${me.total}명</span>` : ''}
        </div>
        <div class="card-body">
          ${me.rank ? `
            <div style="background:rgba(88,166,255,0.08);border:1px solid rgba(88,166,255,0.3);border-radius:8px;padding:12px;margin-bottom:16px">
              <div style="font-size:12px;color:var(--text3);margin-bottom:4px">내 순위</div>
              <div style="display:flex;gap:16px;align-items:center">
                <span style="font-size:24px;font-weight:700;color:var(--blue)">#${me.rank}</span>
                <div>
                  <div style="font-size:13px">점수: <strong>${me.score}</strong></div>
                  <div style="font-size:11px;color:var(--text3)">상위 ${me.percentile}% | ${me.events}개 이벤트 | ${me.streak}일 연속</div>
                </div>
              </div>
            </div>
          ` : ''}

          <div style="font-weight:600;font-size:13px;margin-bottom:8px">전체 랭킹 TOP 10</div>
          ${(board.leaderboard || []).map(r => `
            <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px">
              <span style="font-size:16px;min-width:24px;text-align:center">${r.medal || r.rank}</span>
              <span style="font-size:13px;flex:1;color:var(--text2)">${r.userId}</span>
              <span style="font-size:12px;color:var(--text3)">${r.streak}일 🔥</span>
              <span style="font-size:13px;font-weight:600;color:var(--blue)">${r.score}pt</span>
            </div>
          `).join('')}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/leaderboard" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 랭킹 →</a>
            <a href="/api/leaderboard/achievements/local" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">업적 보기 →</a>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    tab.innerHTML = `<div style="padding:20px;color:var(--red)">리더보드 로드 실패: ${err.message}</div>`;
  }
}

// ── 인증서 탭 ──
async function loadCertificateTab() {
  const tab = document.getElementById('tab-certificate');
  if (!tab || tab._loaded) return;
  tab._loaded = true;
  tab.innerHTML = '<div style="padding:20px;color:var(--text3)">인증서 로딩 중...</div>';
  try {
    const score = await fetch('/api/certificate/local/score').then(r => r.json());
    const GRADE_COLOR = { Master:'#0ea5e9', Expert:'#d97706', Proficient:'#059669', Practitioner:'#db2777', Beginner:'#4b5563' };
    const gc = GRADE_COLOR[score.grade?.tier] || '#8b949e';
    tab.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">🎓 Orbit AI 인증서</span>
          <span style="color:${gc};font-weight:700">${score.grade?.emoji||''} ${score.grade?.label||''}</span>
        </div>
        <div class="card-body">
          <div style="text-align:center;margin-bottom:20px">
            <div style="font-size:56px;font-weight:700;color:${gc}">${score.total}</div>
            <div style="font-size:14px;color:var(--text3)">/1000 점</div>
          </div>

          <div style="margin-bottom:16px">
            ${Object.entries(score.breakdown||{}).map(([k,v]) => {
              const LABELS = { volume:'사용량(300)', diversity:'다양성(200)', depth:'깊이(200)', consistency:'일관성(150)', contribution:'기여(150)' };
              const MAX    = { volume:300, diversity:200, depth:200, consistency:150, contribution:150 };
              const max    = MAX[k] || 100;
              return `
                <div style="margin-bottom:8px">
                  <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-bottom:3px">
                    <span>${LABELS[k]||k}</span><span>${v}/${max}</span>
                  </div>
                  <div style="background:var(--bg3);border-radius:4px;height:8px;overflow:hidden">
                    <div style="background:${gc};height:100%;width:${Math.round(v/max*100)}%;border-radius:4px;transition:width 0.5s"></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>

          ${score.total >= 200 ? `
            <button onclick="issueCertificate()" style="width:100%;padding:10px;background:${gc};color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">
              🎓 인증서 발급하기
            </button>
          ` : `
            <div style="text-align:center;color:var(--text3);font-size:12px;padding:12px;background:var(--bg3);border-radius:8px">
              발급 최소 점수: 200점 (현재 ${score.total}점)
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
          ${['events','saved','streak'].map(t => {
            const base = location.origin;
            const md   = `[![Orbit AI](${base}/api/badge/local/svg?type=${t})](${base})`;
            return `
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                <code style="flex:1;font-size:11px;background:var(--bg3);padding:6px 10px;border-radius:6px;color:var(--text2);overflow:auto;white-space:nowrap">${md.replace(/</g,'&lt;')}</code>
                <button onclick="navigator.clipboard.writeText('${md.replace(/'/g,"\\'")}').then(()=>this.textContent='✅').catch(()=>{})" style="padding:4px 10px;font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:5px;color:var(--text3);cursor:pointer;font-family:inherit;white-space:nowrap">복사</button>
              </div>
            `;
          }).join('')}
          <div style="font-size:11px;color:var(--text3);margin-top:10px">
            프로필 카드: <code style="font-size:11px;background:var(--bg3);padding:3px 8px;border-radius:4px;color:var(--blue)">[![Orbit AI Card](${location.origin}/api/badge/local/card)](${location.origin})</code>
            <button onclick="navigator.clipboard.writeText('[![Orbit AI Card](${location.origin}/api/badge/local/card)](${location.origin})').then(()=>this.textContent='✅').catch(()=>{})" style="margin-left:6px;padding:3px 8px;font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text3);cursor:pointer;font-family:inherit">복사</button>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    tab.innerHTML = `<div style="padding:20px;color:var(--red)">인증서 로드 실패: ${err.message}</div>`;
  }
}

async function issueCertificate() {
  try {
    const r = await fetch('/api/certificate/local/issue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const d = await r.json();
    if (d.success) {
      alert(`✅ 인증서 발급 완료!\n등급: ${d.grade?.label}\n점수: ${d.score}/1000\n\n${d.linkedinSnippet}`);
      const tab = document.getElementById('tab-certificate');
      if (tab) { delete tab._loaded; loadCertificateTab(); }
    } else {
      alert('오류: ' + (d.error || '발급 실패'));
    }
  } catch (e) {
    alert('발급 오류: ' + e.message);
  }
}

// ── 포인트 탭 ──
async function loadPointsTab() {
  const tab = document.getElementById('tab-points');
  if (!tab || tab._loaded) return;
  tab._loaded = true;
  tab.innerHTML = '<div style="padding:20px;color:var(--text3)">포인트 로딩 중...</div>';
  try {
    const [bal, rewards] = await Promise.all([
      fetch('/api/points/balance').then(r => r.json()),
      fetch('/api/points/rewards').then(r => r.json()),
    ]);
    tab.innerHTML = `
      <div class="card">
        <div class="card-header">
          <span class="card-title">⭐ Orbit Points</span>
          <span style="color:var(--orange);font-weight:700">${bal.balance?.toLocaleString()||0}pt</span>
        </div>
        <div class="card-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
            ${[
              ['잔액', `${(bal.balance||0).toLocaleString()}pt`, '#ffa657'],
              ['총 획득', `${(bal.totalEarned||0).toLocaleString()}pt`, '#3fb950'],
              ['레벨', `Lv.${bal.level||1} (${bal.levelTitle||''})`, '#bc8cff'],
            ].map(([l,v,c]) => `
              <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
                <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${l}</div>
                <div style="font-size:14px;font-weight:700;color:${c}">${v}</div>
              </div>
            `).join('')}
          </div>

          ${bal.level ? `
            <div style="margin-bottom:16px">
              <div style="font-size:11px;color:var(--text3);margin-bottom:4px">레벨 진행도 (${bal.progress||0}%)</div>
              <div style="background:var(--bg3);border-radius:4px;height:8px;overflow:hidden">
                <div style="background:linear-gradient(90deg,#bc8cff,#f778ba);height:100%;width:${bal.progress||0}%;border-radius:4px;transition:width 0.5s"></div>
              </div>
            </div>
          ` : ''}

          <div style="font-weight:600;font-size:13px;margin-bottom:8px">🎁 사용 가능 리워드</div>
          ${(rewards.rewards || []).slice(0,5).map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--bg3);border-radius:6px;margin-bottom:4px;opacity:${r.affordable?1:0.5}">
              <div>
                <div style="font-size:13px;color:var(--text)">${r.name}</div>
                <div style="font-size:11px;color:var(--text3)">${r.description}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:12px;font-weight:600;color:var(--orange)">${r.cost}pt</div>
                ${r.affordable ? `<button onclick="redeemReward('${r.id}')" style="font-size:10px;padding:3px 8px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:inherit;margin-top:2px">교환</button>` : ''}
              </div>
            </div>
          `).join('')}

          <div style="margin-top:12px;display:flex;gap:8px">
            <a href="/api/points/rewards" target="_blank" style="color:var(--blue);font-size:12px;text-decoration:none">전체 리워드 →</a>
            <a href="/api/points/leaderboard" target="_blank" style="color:var(--purple);font-size:12px;text-decoration:none">포인트 랭킹 →</a>
          </div>
        </div>
      </div>
    `;
  } catch (err) {
    tab.innerHTML = `<div style="padding:20px;color:var(--red)">포인트 로드 실패: ${err.message}</div>`;
  }
}

async function redeemReward(rewardId) {
  try {
    const r = await fetch('/api/points/redeem', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rewardId }),
    });
    const d = await r.json();
    if (d.success) {
      alert(`✅ 교환 완료! 남은 포인트: ${d.balance}pt`);
      const tab = document.getElementById('tab-points');
      if (tab) { delete tab._loaded; loadPointsTab(); }
    } else {
      alert('오류: ' + (d.error || '교환 실패'));
    }
  } catch (e) {
    alert('교환 오류: ' + e.message);
  }
}
