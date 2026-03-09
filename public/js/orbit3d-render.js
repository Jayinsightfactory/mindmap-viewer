// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Canvas2D rendering, labels, constellations, LOD, zoom summary
// ══════════════════════════════════════════════════════════════════════════════
// ─── Canvas2D 오버레이 — LOD 텍스트 행성 ────────────────────────────────────
const _labelCanvas2d = document.createElement('canvas');
_labelCanvas2d.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;z-index:50;';
document.body.appendChild(_labelCanvas2d);
const _lctx = _labelCanvas2d.getContext('2d');

function resizeLabelCanvas() {
  const sw = getNavWidth();
  _labelCanvas2d.width  = innerWidth - sw;
  _labelCanvas2d.height = innerHeight;
  _labelCanvas2d.style.left = sw + 'px';
}
resizeLabelCanvas();
// DOM 준비 후 초기 렌더 영역 적용
window.addEventListener('DOMContentLoaded', () => {
  resizeRendererToSidebar();
  initClaudeStatusBadge();     // Claude 트래킹 배지 초기화
  _loadPersonalStats();        // 개인 학습 통계 초기화
  _initTrackerStatusBadge();   // 트래커 연결 상태 배지

  // ── 뷰 모드 복원 ──────────────────────────────────────────────────────────
  setTimeout(() => {
    const savedView = localStorage.getItem('orbitViewMode');
    if (savedView === 'team' && typeof loadTeamDemo === 'function') loadTeamDemo();
    else if (savedView === 'company' && typeof loadCompanyDemo === 'function') loadCompanyDemo();
    else if (savedView === 'parallel' && typeof loadParallelDemo === 'function') loadParallelDemo();
  }, 800);
}, { once: true });

// ─── Escape: 드릴다운 복귀 ────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (window._drillDownSource === 'team') {
    window._drillDownSource = null;
    window._drillDownMemberId = null;
    window._drillDownMemberName = null;
    loadTeamDemo(); // 샘플 직접 호출 금지 → 로그인 검증 경유
  }
});
setTimeout(resizeRendererToSidebar, 100); // fallback

// ─── 줌 거리 → LOD 레벨 ─────────────────────────────────────────────────────
// LOD 0: 줌인 (r < 60)   — 행성 크게 + 위성 상세
// LOD 1: 중간 (r 60~130) — 행성 보통 + 위성 보통
// LOD 2: 줌아웃 (r > 130) — 행성만 작게, 위성 숨김
// LOD 3: 최대줌아웃 (>180) — 요약 오버레이 (updateZoomSummary 처리)
function getLOD() {
  const r = controls.sph.r;
  if (r < 45)  return 0;   // 매우 가까이: 모든 디테일 표시
  if (r < 100) return 1;   // 팀 기본 뷰: 멤버+목표 (task/skill 숨김)
  if (r < 170) return 2;   // 회사 뷰: 부서+목표만
  return 3;                 // 유니버스 뷰
}

// 거리 → 화면 픽셀 스케일
function screenScale(worldPos) {
  const dist = camera.position.distanceTo(worldPos);
  const fovFactor = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  return fovFactor / Math.max(dist, 0.1);
}

// pill 경로
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r, y); ctx.lineTo(x+w-r, y);
  ctx.arcTo(x+w, y, x+w, y+r, r); ctx.lineTo(x+w, y+h-r);
  ctx.arcTo(x+w, y+h, x+w-r, y+h, r); ctx.lineTo(x+r, y+h);
  ctx.arcTo(x, y+h, x, y+h-r, r); ctx.lineTo(x, y+r);
  ctx.arcTo(x, y, x+r, y, r); ctx.closePath();
}

// 3D 와이어프레임 그리드 헬퍼 (모든 카드/pill 공통)
function drawWireframeGrid(ctx, x, y, w, h, r, color, alpha) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = 0.5; ctx.globalAlpha = alpha;
  const midX = x + w / 2, midY = y + h / 2;
  // 수평 곡선
  const hLines = Math.max(2, Math.round(h / 14));
  for (let i = 1; i < hLines; i++) {
    const t = i / hLines;
    const gy = y + h * t;
    const bulge = Math.sin(t * Math.PI) * Math.min(3, h * 0.06);
    ctx.beginPath(); ctx.moveTo(x, gy);
    ctx.quadraticCurveTo(midX, gy - bulge, x + w, gy); ctx.stroke();
  }
  // 수직 곡선
  const vLines = Math.max(3, Math.round(w / 22));
  for (let i = 1; i < vLines; i++) {
    const t = i / vLines;
    const gx = x + w * t;
    const bulge = Math.sin(t * Math.PI) * Math.min(2, w * 0.03);
    ctx.beginPath(); ctx.moveTo(gx, y);
    ctx.quadraticCurveTo(gx + bulge, midY, gx, y + h); ctx.stroke();
  }
  ctx.restore();
}

// ── 통일 카드 상수 (모든 뷰 공통) ──────────────────────────────────────────
const UNI_CARD_W = 180, UNI_CARD_H = 51;
const UNI_CARD_R = 10, UNI_CARD_BAR = 5;

// ── 통일 카드 그리기 (모든 뷰 공통) ──────────────────────────────────────────
function drawUnifiedCard(ctx, cx, cy, color, title, sub, isActive, isHover, isDrilled) {
  const lx = cx - UNI_CARD_W / 2, ly = cy - UNI_CARD_H / 2;
  ctx.save();
  ctx.shadowColor = isDrilled ? 'rgba(6,182,212,0.25)' : 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = isDrilled ? 16 : 10; ctx.shadowOffsetY = 2;
  ctx.fillStyle = isDrilled ? 'rgba(6,182,212,0.12)' : isHover ? 'rgba(6,182,212,0.08)' : 'rgba(2,6,23,0.80)';
  roundRect(ctx, lx, ly, UNI_CARD_W, UNI_CARD_H, UNI_CARD_R); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.restore();

  drawWireframeGrid(ctx, lx, ly, UNI_CARD_W, UNI_CARD_H, UNI_CARD_R, color, isDrilled ? 0.35 : isHover ? 0.28 : 0.18);

  // 좌측 컬러 바
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(lx + UNI_CARD_R, ly); ctx.lineTo(lx + UNI_CARD_BAR + UNI_CARD_R, ly);
  ctx.lineTo(lx + UNI_CARD_BAR + UNI_CARD_R, ly + UNI_CARD_H);
  ctx.moveTo(lx + UNI_CARD_R, ly + UNI_CARD_H);
  ctx.arcTo(lx, ly + UNI_CARD_H, lx, ly + UNI_CARD_H - UNI_CARD_R, UNI_CARD_R);
  ctx.lineTo(lx, ly + UNI_CARD_R); ctx.arcTo(lx, ly, lx + UNI_CARD_R, ly, UNI_CARD_R);
  ctx.closePath();
  ctx.fillStyle = color; ctx.globalAlpha = 0.7; ctx.fill(); ctx.globalAlpha = 1;
  ctx.restore();

  ctx.strokeStyle = isDrilled ? color : isHover ? 'rgba(6,182,212,0.4)' : 'rgba(255,255,255,0.10)';
  ctx.lineWidth = isDrilled ? 1.5 : isHover ? 1.2 : 0.8;
  roundRect(ctx, lx, ly, UNI_CARD_W, UNI_CARD_H, UNI_CARD_R); ctx.stroke();

  if (isActive) {
    ctx.save();
    ctx.fillStyle = '#22c55e'; ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(lx + UNI_CARD_W - 8, ly + 8, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  const textX = lx + UNI_CARD_BAR + UNI_CARD_R + 6;
  const maxTextW = UNI_CARD_W - UNI_CARD_BAR - UNI_CARD_R - 16;
  ctx.textAlign = 'left';
  ctx.font = "600 14px 'Inter',-apple-system,sans-serif";
  ctx.fillStyle = '#e2e8f0';
  let clipped = title;
  while (ctx.measureText(clipped).width > maxTextW && clipped.length > 1) clipped = clipped.slice(0, -1);
  if (clipped !== title) clipped += '\u2026';
  ctx.fillText(clipped, textX, ly + 21);

  if (sub) {
    ctx.font = "400 11px 'JetBrains Mono','Fira Code',monospace";
    ctx.fillStyle = '#94a3b8';
    let cs = sub;
    while (ctx.measureText(cs).width > maxTextW && cs.length > 1) cs = cs.slice(0, -1);
    if (cs !== sub) cs += '\u2026';
    ctx.fillText(cs, textX, ly + 39);
  }
}

// 3D → 화면 좌표
function toScreen(worldPos) {
  const v = worldPos.clone().project(camera);
  return { x:(v.x+1)/2*innerWidth, y:(-v.y+1)/2*innerHeight, z:v.z };
}

// ─── 실시간 작업 빛 상태 ─────────────────────────────────────────────────────
// WS 이벤트로 최근 활성화된 clusterId → 타임스탬프
const _activeGlow = {}; // clusterId → lastActiveMs
const GLOW_FADE_MS = 4000; // 4초 후 서서히 소멸

function markClusterActive(clusterId) {
  _activeGlow[clusterId] = Date.now();
}

// glow 강도 (0~1)
function glowIntensity(clusterId) {
  const t = _activeGlow[clusterId];
  if (!t) return 0;
  const age = Date.now() - t;
  if (age > GLOW_FADE_MS) return 0;
  return 1 - age / GLOW_FADE_MS;
}

// ─── 프로젝트별 활성 파일 추적 ────────────────────────────────────────────────
// 최근 5분 내 이벤트에서 파일 경로를 추출하여 프로젝트별로 그룹화
const _activeFilesPerProject = {};          // projName → [{ file, shortName, timestamp, filePath }]
const ACTIVE_FILE_TTL = 5 * 60 * 1000;     // 5분간 활성 표시

// 씬 빌드 후 또는 데이터 로드 시 호출
function updateActiveFiles() {
  const now = Date.now();
  // _sessionMap: clusterId → { planet, fileSats, events }
  Object.keys(_activeFilesPerProject).forEach(k => delete _activeFilesPerProject[k]);

  for (const [clusterId, entry] of Object.entries(_sessionMap || {})) {
    if (!entry || !entry.events) continue;
    const proj = entry.planet?.userData?.projectName || '기타';
    if (!_activeFilesPerProject[proj]) _activeFilesPerProject[proj] = [];

    // 최근 이벤트에서 파일 경로 추출
    for (let i = entry.events.length - 1; i >= 0; i--) {
      const e = entry.events[i];
      const ts = new Date(e.timestamp).getTime();
      if (now - ts > ACTIVE_FILE_TTL) break;     // 5분 초과 → 중단

      const fp = e.data?.filePath || e.data?.fileName || '';
      if (!fp) continue;
      const shortName = fp.replace(/\\/g, '/').split('/').pop();
      // 중복 방지
      if (_activeFilesPerProject[proj].some(f => f.filePath === fp)) continue;

      _activeFilesPerProject[proj].push({
        file: shortName,
        shortName: shortName.length > 18 ? shortName.slice(0, 16) + '…' : shortName,
        timestamp: e.timestamp,
        filePath: fp,
        eventType: e.type,
        isWrite: e.type === 'file.write' || e.type === 'tool.end',
      });
      if (_activeFilesPerProject[proj].length >= 5) break;  // 프로젝트당 최대 5개
    }
  }
}

// VS Code로 파일 열기 (vscode:// 프로토콜 사용)
function openFileInEditor(filePath) {
  if (!filePath) return;
  // Windows 경로 → URI 변환
  const uri = filePath.replace(/\\/g, '/');
  const vscodeUrl = `vscode://file/${uri}`;
  window.open(vscodeUrl, '_blank');
  if (typeof showToast === 'function') showToast(`📂 ${uri.split('/').pop()} 열기`, 2000);
}

// ─── 글로우 pill 헬퍼 ────────────────────────────────────────────────────────
function drawGlow(ctx, cx, cy, r, hex, intensity) {
  if (intensity <= 0.02) return;
  const grad = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 2.8);
  const alpha = (intensity * 0.55).toFixed(3);
  grad.addColorStop(0, hex + Math.round(intensity * 200).toString(16).padStart(2,'0'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ─── AI 인사이트 패널 ─────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function relTime(ts) {
  const diff = Date.now() - new Date(ts || 0).getTime();
  if (diff < 60000)    return '방금';
  if (diff < 3600000)  return `${Math.floor(diff/60000)}분 전`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}시간 전`;
  return `${Math.floor(diff/86400000)}일 전`;
}

function computeInsights() {
  const cutoff = Date.now() - 3_600_000;

  // ① 최근 1시간 이벤트 피드 (최신순, 최대 20개)
  const recentEvents = [..._allNodes]
    .filter(n => new Date(n.timestamp || n.created_at || 0) > cutoff)
    .sort((a,b) => new Date(b.timestamp || b.created_at || 0) - new Date(a.timestamp || a.created_at || 0))
    .slice(0, 20);

  // ② 타입 카테고리 분포
  const CAT_META = {
    chat:  { label:'💬 대화', color:'#58a6ff' },
    code:  { label:'⚡ 코드', color:'#3fb950' },
    file:  { label:'📄 파일', color:'#ffa657' },
    git:   { label:'🌿 Git',  color:'#39d2c0' },
    error: { label:'❌ 오류', color:'#f85149' },
  };
  const catDist = {};
  _allNodes.forEach(n => {
    const cat = typeCfg(n.type).cat || 'chat';
    catDist[cat] = (catDist[cat]||0) + 1;
  });
  const total = Math.max(_allNodes.length, 1);
  const distRows = Object.entries(catDist)
    .sort((a,b) => b[1]-a[1])
    .map(([cat, cnt]) => ({
      ...(CAT_META[cat] || { label:cat, color:'#8b949e' }),
      pct: Math.round(cnt/total*100),
    }));

  // ③ 도메인 분포 → 주요 도메인
  const DOMAIN_LABELS = {
    auth:'🔐 인증', api:'🌐 API', data:'🗄️ 데이터', ui:'🎨 UI',
    test:'🧪 테스트', server:'🚀 서버', infra:'🐳 인프라', fix:'🔧 버그수정',
    git:'🌿 Git', chat:'💬 대화', general:'⚙️ 일반',
  };
  const domainDist = {};
  planetMeshes.forEach(p => {
    const d = p.userData.domain || 'general';
    domainDist[d] = (domainDist[d]||0) + 1;
  });
  const topDE = Object.entries(domainDist).sort((a,b)=>b[1]-a[1])[0];
  const topDomainLabel = topDE && planetMeshes.length
    ? `${DOMAIN_LABELS[topDE[0]]||topDE[0]} ${Math.round(topDE[1]/planetMeshes.length*100)}%`
    : '—';

  // ④ 오류율
  const errCount = _allNodes.filter(n => n.type === 'tool.error').length;
  const errRate  = (errCount / total * 100).toFixed(1);

  // ⑤ Git 활동
  const gitCount = _allNodes.filter(n => n.type === 'git.commit' || n.type === 'git.push').length;

  // ⑥ 최다 파일
  const fileDist = {};
  _allNodes.forEach(n => {
    const fp = ((n.data?.filePath || n.data?.fileName || '')).replace(/\\/g,'/');
    const fn = fp.split('/').pop();
    if (fn && fn.includes('.')) fileDist[fn] = (fileDist[fn]||0) + 1;
  });
  const topFile = Object.entries(fileDist).sort((a,b)=>b[1]-a[1])[0]?.[0] || '—';

  return { recentEvents, distRows, topDomainLabel, errRate, gitCount, topFile, total };
}

const _INS_TYPE_ICON = {
  'user.message':'💬', 'assistant.message':'🤖', 'assistant.response':'🤖',
  'tool.start':'⚡', 'tool.end':'✅', 'tool.error':'❌',
  'file.read':'📄', 'file.write':'✏️', 'git.commit':'🌿', 'git.push':'🚀',
};

// ─── 탭 전환 ─────────────────────────────────────────────────────────────────
let _insightTab = 'feed'; // 'feed' | 'purpose' | 'stats'

function switchInsightTab(tab) {
  _insightTab = tab;
  ['feed','purpose','stats'].forEach(t => {
    document.getElementById(`ins-tab-${t}`).classList.toggle('active', t === tab);
    const pane = document.getElementById(`ins-pane-${t}`);
    if (t === tab) pane.style.display = 'flex';
    else           pane.style.display = 'none';
  });
  if      (tab === 'feed')    renderFeedTab();
  else if (tab === 'purpose') renderPurposeTab();
  else if (tab === 'stats')   renderStatsTab();
}
window.switchInsightTab = switchInsightTab;

// ─── 실시간 피드 탭 ──────────────────────────────────────────────────────────
function renderFeedTab() {
  const ins = computeInsights();
  document.getElementById('ins-feed-list').innerHTML = ins.recentEvents.length
    ? ins.recentEvents.map(n => `
        <div class="ins-feed-item">
          <span class="ins-feed-icon">${_INS_TYPE_ICON[n.type]||'·'}</span>
          <div class="ins-feed-body">
            <div class="ins-feed-label" title="${escHtml(n.label||n.type)}">${escHtml((n.label||n.type).slice(0,42))}</div>
            <div class="ins-feed-time">${relTime(n.timestamp||n.created_at)}</div>
          </div>
        </div>`).join('')
    : `<div style="padding:14px 4px;color:#6e7681;font-size:12px;">
         최근 1시간 이벤트 없음<br>
         <span style="font-size:10px;color:#3d444d">전체 ${ins.total.toLocaleString()}개 보유</span>
       </div>`;
  document.getElementById('ins-feed-meta').textContent =
    `총 ${ins.recentEvents.length}개 · 최근 1시간`;
}

// ─── 목적 카드 탭 ─────────────────────────────────────────────────────────────
function buildPurposeCards() {
  const groups = {};
  _allNodes.forEach(n => {
    const key = n.purposeLabel || n.data?.purposeLabel;
    if (!key) return;
    if (!groups[key]) groups[key] = [];
    groups[key].push(n);
  });

  return Object.entries(groups).map(([purposeLabel, events]) => {
    // 시간순 정렬
    events.sort((a,b) =>
      new Date(a.timestamp||a.created_at||0) - new Date(b.timestamp||b.created_at||0));
    const firstTs = events[0]?.timestamp || events[0]?.created_at;
    const lastTs  = events[events.length-1]?.timestamp || events[events.length-1]?.created_at;

    // ① 트리거 질문
    const triggerEv = events.find(e => e.type === 'user.message');
    const trigger   = (triggerEv?.label || triggerEv?.data?.text || '').trim();

    // ② 에이전트 스텝 감지 (순서 보존, 중복 제거)
    const agentSteps = [];
    const seenStep   = new Set();
    events.forEach(e => {
      if (e.type !== 'tool.start') return;
      const tname = e.data?.toolName || e.label || '';
      const fpath = (e.data?.filePath || e.data?.fileName || '');
      let step = null;
      if      (/Glob|Grep/.test(tname) && !/Edit|Write/.test(tname)) step = { label:'Explore', icon:'🔍' };
      else if (/^Read$/i.test(tname)   && !/Edit|Write/.test(tname)) step = { label:'탐색', icon:'📂' };
      else if (/plan\.md/i.test(fpath) && /Write|Edit/.test(tname))  step = { label:'Plan', icon:'📋' };
      else if (/Write|Edit/.test(tname))                              step = { label:'구현', icon:'⚡' };
      else if (/Bash/i.test(tname)) {
        const cmd = e.data?.command || '';
        if      (/git\s+commit/i.test(cmd)) step = { label:'커밋', icon:'🌿' };
        else if (/git\s+push/i.test(cmd))   step = { label:'푸시', icon:'🚀' };
        else                                step = { label:'Bash', icon:'💻' };
      }
      if (step && !seenStep.has(step.label)) {
        seenStep.add(step.label);
        agentSteps.push(step);
      }
    });

    // ③ 변경 파일 목록
    const fileDist = {};
    events.forEach(e => {
      const fp = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/');
      const fn = fp.split('/').pop();
      if (!fn || !fn.includes('.')) return;
      if (!fileDist[fn]) fileDist[fn] = { name: fn, write: 0 };
      if (['file.write','tool.start'].includes(e.type) &&
          /Write|Edit/.test(e.data?.toolName || '')) fileDist[fn].write++;
    });

    // ④ Git 커밋 해시 (마지막)
    const commitEv  = [...events].reverse().find(e => e.type === 'git.commit');
    const commitHash = commitEv?.data?.hash || commitEv?.data?.commitHash || '';

    // ⑤ 상태 판정
    const hasError = events.some(e => e.type === 'tool.error');
    let statusIcon;
    if      (hasError)        statusIcon = '❌';
    else if (commitHash)      statusIcon = '✅';
    else if (agentSteps.length) statusIcon = '⚡';
    else                      statusIcon = '⏳';

    return { purposeLabel, trigger, agentSteps,
             files: Object.values(fileDist),
             commitHash, hasError, statusIcon, firstTs, lastTs };
  }).sort((a,b) => new Date(b.lastTs||0) - new Date(a.lastTs||0));
}

function renderPurposeTab() {
  const cards = buildPurposeCards();
  const el    = document.getElementById('ins-purpose-list');
  if (!cards.length) {
    el.innerHTML = `<div class="ins-purpose-empty">
      📭 목적(purposeLabel) 데이터 없음<br>
      <span style="font-size:10px;color:#3d444d;margin-top:6px;display:block;">
        이벤트에 purposeLabel 필드가 있어야 합니다
      </span>
    </div>`;
    return;
  }

  el.innerHTML = cards.map(c => {
    // 스텝 HTML
    const stepsHtml = c.agentSteps.length
      ? c.agentSteps.map((s, i) =>
          `${i > 0 ? '<span class="ins-pc-step-arrow">›</span>' : ''}
           <span class="ins-pc-step ok">${s.icon} ${escHtml(s.label)}</span>`).join('')
      : `<span style="font-size:10px;color:#3d444d">스텝 정보 없음</span>`;

    // 파일 HTML
    const filesHtml = c.files.length
      ? c.files.slice(0, 4).map(f =>
          `<span class="ins-pc-file" title="${escHtml(f.name)}">
            ${escHtml(f.name.slice(0, 20))}
            ${f.write ? '<span class="ins-pc-diff">✏️</span>' : ''}
           </span>`).join('')
      : '';

    // 액션 버튼 HTML — 롤백 버튼을 실행 패널로 연결
    const rollbackPayload = c.commitHash ? JSON.stringify({
      type: 'rollback', hash: c.commitHash,
      projectDir: '', description: `${c.purposeLabel} 롤백 (${c.commitHash.slice(0,7)})`,
    }).replace(/"/g, '&quot;') : '';
    const actionsHtml = c.commitHash
      ? `<div class="ins-pc-actions">
           <div class="ins-pc-commit-btn" title="커밋 해시: ${escHtml(c.commitHash)}">
             🌿 ${escHtml(c.commitHash.slice(0,7))}
           </div>
           <div class="ins-pc-rollback-btn"
                onclick="openExecPanel(${rollbackPayload})">
             ↩ 롤백 미리보기
           </div>
         </div>`
      : '';

    return `<div class="ins-purpose-card">
      <div class="ins-pc-hdr">
        <span class="ins-pc-status">${c.statusIcon}</span>
        <span class="ins-pc-label" title="${escHtml(c.purposeLabel)}">
          ${escHtml(c.purposeLabel.slice(0, 34))}${c.purposeLabel.length>34?'…':''}
        </span>
        <span class="ins-pc-time">${relTime(c.lastTs)}</span>
      </div>
      ${c.trigger ? `<div class="ins-pc-trigger">💬 "${escHtml(c.trigger.slice(0,60))}${c.trigger.length>60?'…':''}"</div>` : ''}
      <div class="ins-pc-steps">${stepsHtml}</div>
      ${filesHtml ? `<div class="ins-pc-files">${filesHtml}</div>` : ''}
      ${actionsHtml}
    </div>`;
  }).join('');
}
window.renderPurposeTab = renderPurposeTab;

// ─── 통계 탭 ─────────────────────────────────────────────────────────────────
function renderStatsTab() {
  const ins = computeInsights();
  document.getElementById('ins-dist-list').innerHTML = ins.distRows
    .filter(r => r.pct > 0)
    .map(r => `
      <div class="ins-dist-row">
        <span class="ins-dist-label">${r.label}</span>
        <div class="ins-dist-bg">
          <div class="ins-dist-fill" style="width:${r.pct}%;background:${r.color}"></div>
        </div>
        <span class="ins-dist-pct">${r.pct}%</span>
      </div>`).join('');

  const health = parseFloat(ins.errRate) < 5
    ? '✅ 건강함' : parseFloat(ins.errRate) < 15 ? '⚠️ 주의' : '🔴 불안정';
  document.getElementById('ins-kv-list').innerHTML = [
    ['🔧 주요 도메인', ins.topDomainLabel],
    ['⚠️ 오류율',     `${ins.errRate}% ${health}`],
    ['🌿 Git 활동',   `${ins.gitCount}회`],
    ['🏆 최다 파일',   ins.topFile],
    ['📦 전체 이벤트', `${ins.total.toLocaleString()}개`],
  ].map(([k,v]) => `
    <div class="ins-kv-row">
      <span class="ins-kv-key">${k}</span>
      <span class="ins-kv-val">${escHtml(String(v))}</span>
    </div>`).join('');
}

// ─── renderInsightPanel: 현재 활성 탭 렌더 ──────────────────────────────────
function renderInsightPanel() {
  if      (_insightTab === 'feed')    renderFeedTab();
  else if (_insightTab === 'purpose') renderPurposeTab();
  else if (_insightTab === 'stats')   renderStatsTab();
}
window.renderInsightPanel = renderInsightPanel;

// ─── 패널 열기/닫기 ──────────────────────────────────────────────────────────
let _insightRefreshTimer = null;

function toggleInsightPanel() {
  const panel  = document.getElementById('insight-panel');
  const isOpen = panel.classList.contains('open');
  document.getElementById('info-panel')?.classList.remove('open');
  if (isOpen) {
    panel.classList.remove('open');
    clearInterval(_insightRefreshTimer); _insightRefreshTimer = null;
  } else {
    panel.classList.add('open');
    // 첫 열기 시 피드 탭으로 초기화
    if (_insightTab !== 'feed') switchInsightTab('feed');
    else renderFeedTab();
    _insightRefreshTimer = setInterval(renderInsightPanel, 30000);
  }
}
window.toggleInsightPanel = toggleInsightPanel;

// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ 목적(Purpose) 타임라인 패널
// ═══════════════════════════════════════════════════════════════════════════════

let _ptOpen     = false;
let _ptPurposes = [];
let _ptActive   = -1;

async function togglePurposeTimeline() {
  const panel  = document.getElementById('purpose-timeline');
  const btn    = document.getElementById('ln-purpose-btn');
  _ptOpen = !_ptOpen;
  panel.classList.toggle('open', _ptOpen);
  btn?.classList.toggle('active', _ptOpen);
  if (_ptOpen) {
    await _ptLoadSessions();
    await loadPurposeTimeline();
  }
}
window.togglePurposeTimeline = togglePurposeTimeline;

async function _ptLoadSessions() {
  try {
    const r    = await fetch('/api/purposes/sessions');
    const data = await r.json();
    const sel  = document.getElementById('pt-sess-sel');
    if (!sel) return;
    const opts = (data.sessions || []).map(s =>
      `<option value="${escHtml(s.sessionId)}">${escHtml(s.sessionTitle)} · ${s.purposeCount}목적</option>`
    ).join('');
    sel.innerHTML = `<option value="">전체 세션</option>${opts}`;
  } catch {}
}

async function loadPurposeTimeline() {
  const container = document.getElementById('pt-cards');
  const metaEl    = document.getElementById('pt-meta-label');
  const sessId    = document.getElementById('pt-sess-sel')?.value || '';

  container.innerHTML = '<div class="pt-empty-msg">불러오는 중…</div>';
  try {
    const qs  = sessId ? `&session_id=${encodeURIComponent(sessId)}` : '';
    const r   = await fetch(`/api/purposes/timeline?limit=60${qs}`);
    const data= await r.json();
    _ptPurposes = data.purposes || [];
    if (metaEl) metaEl.textContent = `총 ${_ptPurposes.length}개 목적`;
    _ptRenderCards(_ptPurposes);
  } catch (e) {
    container.innerHTML = `<div class="pt-empty-msg">❌ ${escHtml(e.message)}</div>`;
  }
}
window.loadPurposeTimeline = loadPurposeTimeline;

function _ptRenderCards(purposes) {
  const container = document.getElementById('pt-cards');
  if (!purposes.length) {
    container.innerHTML = '<div class="pt-empty-msg">목적 데이터가 없습니다 — 이벤트가 쌓이면 자동으로 분류됩니다</div>';
    return;
  }

  // 최신순 → 오래된순으로 표시 (타임라인 흐름)
  const ordered = [...purposes].reverse();

  container.innerHTML = ordered.map((p, i) => {
    const realIdx = purposes.length - 1 - i; // _ptPurposes 에서의 실제 인덱스

    const gitBadge = p.gitHash
      ? `<span class="pt-git-badge">🌿 ${escHtml(p.gitHash.slice(0,7))}</span>`
      : `<span class="pt-nocommit-badge">미커밋</span>`;

    const filesHtml = (p.files || []).slice(0, 4).map(f => {
      const name = f.replace(/\\/g, '/').split('/').pop();
      return `<span class="pt-file-chip" title="${escHtml(f)}">${escHtml(name.slice(0,15))}</span>`;
    }).join('');
    const moreFiles = (p.files || []).length > 4
      ? `<span class="pt-file-more">+${p.files.length - 4}</span>` : '';

    const triggerHtml = p.triggerText
      ? `<div class="pt-card-trigger">"${escHtml(p.triggerText.slice(0,100))}"</div>` : '';

    const rollbackBtn = p.gitHash
      ? `<button class="pt-rollback-btn" onclick="ptRollback(${realIdx},event)">↩ 롤백</button>` : '';

    const connector = i > 0
      ? `<div class="pt-connector"><div class="pt-connector-line"></div></div>` : '';

    return `${connector}<div class="pt-card" id="pt-card-${realIdx}" onclick="ptSelectCard(${realIdx})">
      <div class="pt-card-top">
        <span class="pt-card-icon" style="color:${p.color||'#8b949e'}">${p.icon||'📌'}</span>
        <span class="pt-card-label">${escHtml(p.label||'')}</span>
        ${gitBadge}
      </div>
      ${triggerHtml}
      <div class="pt-card-files">${filesHtml}${moreFiles}</div>
      <div class="pt-card-foot">
        <span class="pt-card-time">${relTime(p.startTs)}</span>
        <span class="pt-card-cnt">${p.eventsCount}이벤트</span>
      </div>
      ${rollbackBtn}
    </div>`;
  }).join('');
}

function ptSelectCard(idx) {
  // 활성 표시
  document.querySelectorAll('.pt-card').forEach(el => el.classList.remove('active'));
  document.getElementById(`pt-card-${idx}`)?.classList.add('active');
  _ptActive = idx;

  const p = _ptPurposes[idx];
  if (!p) return;

  // info-panel에 목적 상세 주입
  _ptShowDetail(p);
}
window.ptSelectCard = ptSelectCard;

function _ptShowDetail(p) {
  const panel = document.getElementById('info-panel');
  if (!panel) return;

  // 헤더
  const dotEl = document.getElementById('ip-dot');
  if (dotEl) dotEl.style.background = p.color || '#8b949e';
  const typeEl = document.getElementById('ip-type-text');
  if (typeEl) typeEl.textContent = `${p.icon} ${p.label}`;
  const intentEl = document.getElementById('ip-intent');
  if (intentEl) intentEl.textContent = p.triggerText ? `"${p.triggerText.slice(0,80)}"` : p.label;

  // KV 목록
  const kvList = document.getElementById('ip-kv-list');
  if (kvList) {
    const kvRows = [
      ['목적',      `${p.icon} ${p.label}`],
      ['신뢰도',    `${Math.round((p.confidence||0)*100)}%`],
      ['이벤트',    `${p.eventsCount}개`],
      ['시작',      p.startTs ? new Date(p.startTs).toLocaleString('ko-KR') : '-'],
      ['소요시간',  p.startTs && p.endTs
                      ? `${Math.round((new Date(p.endTs)-new Date(p.startTs))/60000)}분` : '-'],
      ['Git 커밋',  p.gitHash ? p.gitHash.slice(0,12) : '없음'],
    ];
    kvList.innerHTML = kvRows.map(([k,v]) =>
      `<div class="ip-kv"><span class="k">${k}</span><span class="v">${escHtml(String(v))}</span></div>`
    ).join('');
  }

  // 미리보기: 파일 목록 + 롤백 버튼
  const previewEl = document.getElementById('ip-preview');
  if (previewEl) {
    const filesHtml = p.files?.length
      ? `<div style="margin-bottom:8px">
          <div style="font-size:9px;color:#6e7681;margin-bottom:4px">📁 변경된 파일 (${p.files.length}개)</div>
          ${p.files.map(f => `<div style="font-size:10px;color:#58a6ff;padding:2px 0">${escHtml(f.split('/').pop())}</div>`).join('')}
         </div>` : '';

    const commitHtml = p.gitHash
      ? `<div style="background:rgba(63,185,80,.08);border:1px solid rgba(63,185,80,.2);
            border-radius:7px;padding:8px 10px;margin-bottom:8px">
          <div style="font-size:9px;color:#3fb950;font-weight:700;margin-bottom:3px">🌿 Git 커밋</div>
          <div style="font-size:10px;color:#7ee787;font-family:'SF Mono',monospace">${escHtml(p.gitHash.slice(0,12))}</div>
          ${p.gitMessage ? `<div style="font-size:9px;color:#8b949e;margin-top:3px">${escHtml(p.gitMessage)}</div>` : ''}
         </div>` : '';

    const rollbackHtml = p.gitHash
      ? `<button onclick="ptRollback(${_ptActive},null)"
           style="width:100%;background:none;border:1px solid #f85149;color:#f85149;
             border-radius:7px;padding:7px;font-size:11px;cursor:pointer;font-family:inherit;
             transition:background .15s"
           onmouseover="this.style.background='rgba(248,81,73,.08)'"
           onmouseout="this.style.background='none'">
           ↩ 이 목적 전으로 롤백 (${escHtml(p.gitHash.slice(0,7))})
         </button>` : '';

    previewEl.innerHTML = filesHtml + commitHtml + rollbackHtml;
    previewEl.style.display = 'block';
  }

  panel.classList.add('open');
}

function ptRollback(idx, ev) {
  if (ev) ev.stopPropagation();
  const p = _ptPurposes[idx];
  if (!p?.gitHash) { showToast('이 목적에 연결된 커밋이 없습니다'); return; }
  if (typeof openExecPanel === 'function') {
    openExecPanel({
      type:        'rollback',
      hash:        p.gitHash,
      description: `↩ 롤백: ${p.label} (${p.gitHash.slice(0,7)})`,
    });
  }
}
window.ptRollback = ptRollback;

// ═══════════════════════════════════════════════════════════════════════════════
// 💡 AI 추천 패널
// ═══════════════════════════════════════════════════════════════════════════════

let _sgOpen = false;

function toggleSuggestionPanel() {
  const panel = document.getElementById('suggestion-panel');
  const btn   = document.getElementById('ln-suggest-btn');
  _sgOpen = !_sgOpen;
  panel.classList.toggle('open', _sgOpen);
  btn?.classList.toggle('active', _sgOpen);
  document.getElementById('insight-panel')?.classList.remove('open');
  document.getElementById('info-panel')?.classList.remove('open');
  if (_sgOpen) loadSuggestions();
}
window.toggleSuggestionPanel = toggleSuggestionPanel;

// ── 제안 패널 탭 전환 ────────────────────────────────────────────────────────
function switchSgTab(tab) {
  const isSuggest = tab === 'suggest';
  document.getElementById('sg-panel-suggest').style.display = isSuggest ? '' : 'none';
  document.getElementById('sg-panel-trigger').style.display = isSuggest ? 'none' : '';
  const t1 = document.getElementById('sg-tab-suggest');
  const t2 = document.getElementById('sg-tab-trigger');
  if (t1) { t1.style.background = isSuggest ? '#21262d' : 'transparent'; t1.style.color = isSuggest ? '#cdd9e5' : '#6e7681'; }
  if (t2) { t2.style.background = isSuggest ? 'transparent' : '#21262d'; t2.style.color = isSuggest ? '#6e7681' : '#cdd9e5'; }
  if (!isSuggest) loadTriggers();
}
window.switchSgTab = switchSgTab;


// ── 행동 이상 신호 카드 렌더 ─────────────────────────────────────────────────
const SIGNAL_META = {
  wpm_spike:       { icon:'⚡', label:'타이핑 속도 이상',   color:'#f85149', bg:'rgba(248,81,73,.08)'  },
  messaging_burst: { icon:'💬', label:'메시지 집중 급증',   color:'#ff9500', bg:'rgba(255,149,0,.08)'  },
  night_anomaly:   { icon:'🌙', label:'야간 활동 감지',     color:'#bc78de', bg:'rgba(188,120,222,.08)' },
  short_burst_chat:{ icon:'🔥', label:'급박 메시지 감지',   color:'#f85149', bg:'rgba(248,81,73,.08)'  },
  app_storm:       { icon:'🌀', label:'앱 전환 급증',       color:'#ff9500', bg:'rgba(255,149,0,.08)'  },
};
const SEV_LABEL = { high:'🔴 긴급', medium:'🟠 주의', low:'🟡 참고' };

function _renderSignalCard(s) {
  const meta = SIGNAL_META[s.signal] || { icon:'⚠️', label:s.signal, color:'#ff9500', bg:'rgba(255,149,0,.08)' };
  const sevLabel = SEV_LABEL[s.severity] || '🟠 주의';
  const timeAgo  = s.detected_at ? relTime(s.detected_at) : '';
  return `<div class="sg-card" style="border-color:${meta.color}55;background:${meta.bg};border-left:3px solid ${meta.color}">
    <div class="sg-card-top" style="justify-content:space-between">
      <span style="font-size:18px">${meta.icon}</span>
      <span class="sg-card-pri" style="background:${meta.color}22;color:${meta.color}">${sevLabel}</span>
    </div>
    <div class="sg-card-title" style="color:${meta.color}">${escHtml(meta.label)}</div>
    <div class="sg-card-desc" style="font-size:10px">${escHtml(s.desc||'')}</div>
    <div class="sg-card-evidence" style="color:#6e7681">${timeAgo} · 내용 無읽음 — 행동 패턴만</div>
    <div class="sg-card-actions">
      <button class="sg-accept-btn" style="background:${meta.color}22;border-color:${meta.color}"
        onclick="ackSignal('${escHtml(s.id)}', this)">✓ 확인함</button>
    </div>
  </div>`;
}

// ── 제안 패널: 무료 솔루션 카드 렌더 ─────────────────────────────────────────
function _renderFreeSolCard(s) {
  const acc = s.accuracy ? `${Math.round(s.accuracy * 100)}%` : '–';
  return `<div class="sg-card" style="border-color:rgba(138,87,222,.35);background:rgba(138,87,222,.06)">
    <div class="sg-card-top">
      <span class="sg-card-pri" style="background:rgba(138,87,222,.2);color:#bc78de">✅ 검증됨</span>
      <span class="sg-card-type">🎁 무료 솔루션</span>
    </div>
    <div class="sg-card-title">${escHtml(s.title||'')}</div>
    <div class="sg-card-desc">${escHtml(s.description||'')}</div>
    <div class="sg-card-evidence">정확도 ${acc} · 사용 ${s.usageCount||0}회</div>
    <div class="sg-card-actions">
      <button class="sg-accept-btn" style="background:rgba(138,87,222,.25);border-color:#8957e5"
        onclick="applyFreeSolution(${escHtml(JSON.stringify(s))})">⚡ 적용</button>
    </div>
  </div>`;
}

// ── 제안 패널: 로컬 학습 카드 렌더 ──────────────────────────────────────────
function _renderLocalSugCard(s) {
  const TYPE_LABEL = {
    automation:'⚙️ 자동화', template:'📝 템플릿',
    shortcut:'⌨️ 단축키', review:'🔍 검토', consolidation:'🔗 통합',
    prompt_template:'🧠 프롬프트 학습',
  };
  const PRI_LABEL = { 5:'🔴', 4:'🟠', 3:'🟡', 2:'🔵', 1:'⚪' };
  const evidence  = Array.isArray(s.evidence) ? s.evidence : [];
  const evText    = evidence.map(ev => {
    if (ev.type === 'file_access')       return `📁 ${(ev.path||'').split('/').pop()} · ${ev.count}회`;
    if (ev.type === 'repeat_typing')     return `⌨️ 반복 입력 ${ev.count}회`;
    if (ev.type === 'app_switch')        return `🔄 ${ev.pair} · ${ev.count}회`;
    if (ev.type === 'long_session')      return `⏱ ${Math.round((ev.durationMin||0)/60*10)/10}시간`;
    if (ev.type === 'prompt_refinement')
      return `🔁 ${ev.app||'AI'} 수정 ${ev.revisionCount}회 · "${(ev.firstPrompt||'').slice(0,25)}…"`;
    return '';
  }).filter(Boolean).join(' · ');

  const sug      = (typeof s.suggestion === 'object' && s.suggestion) ? s.suggestion : {};
  const isPrompt = s.type === 'prompt_template';
  // prompt_template은 "학습 중" 배지만 — 무료솔루션으로 승격 후 사용 가능
  const learningNote = isPrompt
    ? `<div style="font-size:10px;color:#8957e5;margin:4px 0">
         📡 오퍼레이터 검증 후 무료 솔루션으로 제공됩니다
       </div>`
    : '';

  return `<div class="sg-card" id="sg-card-${escHtml(s.id)}">
    <div class="sg-card-top">
      <span class="sg-card-pri p${s.priority||3}">${PRI_LABEL[s.priority||3]||'🟡'}</span>
      <span class="sg-card-type">${TYPE_LABEL[s.type]||s.type}</span>
      ${isPrompt ? '<span style="font-size:9px;color:#8b949e;margin-left:auto">학습 중 ●</span>' : ''}
    </div>
    <div class="sg-card-title">${escHtml(s.title)}</div>
    <div class="sg-card-desc">${escHtml(s.description||'')}</div>
    ${evText ? `<div class="sg-card-evidence">${escHtml(evText)}</div>` : ''}
    ${learningNote}
    <div class="sg-card-actions">
      ${!isPrompt ? `<button class="sg-accept-btn" onclick="respondSuggestion('${escHtml(s.id)}','accept')">✓ 수락</button>` : ''}
      <button class="sg-dismiss-btn" onclick="respondSuggestion('${escHtml(s.id)}','dismiss')">✕ 무시</button>
    </div>
  </div>`;
}

async function loadSuggestions() {
  const list   = document.getElementById('sg-list');
  const footer = document.getElementById('sg-footer');
  if (!list) return;
  list.innerHTML = '<div class="sg-empty">불러오는 중…</div>';

  try {
    // 병렬 fetch: 행동신호 + 클라우드 무료솔루션 + 로컬 학습 데이터
    const [sigRes, solRes, sugRes] = await Promise.allSettled([
      fetch('/api/personal/signals?limit=10'),
      fetch('/api/sync/free-solutions'),
      fetch('/api/personal/suggestions?limit=50'),
    ]);

    const signals = sigRes.status === 'fulfilled'
      ? ((await sigRes.value.json()).signals || []).filter(s => !s.acknowledged)
      : [];
    const freeSols = solRes.status === 'fulfilled'
      ? ((await solRes.value.json()).solutions || [])
      : [];
    const localSugs = sugRes.status === 'fulfilled'
      ? ((await sugRes.value.json()).suggestions || [])
      : [];

    const totalCount = signals.length + freeSols.length + localSugs.length;
    if (footer) footer.textContent = [
      signals.length   ? `⚠️ 신호 ${signals.length}개`   : '',
      freeSols.length  ? `🎁 솔루션 ${freeSols.length}개` : '',
      localSugs.length ? `📡 학습 ${localSugs.length}개`  : '',
    ].filter(Boolean).join(' · ') || '데이터 없음';

    if (!totalCount) {
      list.innerHTML = `<div class="sg-empty">
        아직 데이터가 없습니다.<br><br>
        <span style="font-size:10px">orbit learn start 실행 후<br>
        AI 작업을 하면 자동으로 학습됩니다</span>
      </div>`;
      return;
    }

    let html = '';

    // ── 섹션 0: 행동 이상 신호 (최우선 표시) ───────────────────────────────
    if (signals.length) {
      const highCount = signals.filter(s => s.severity === 'high').length;
      html += `<div style="font-size:10px;color:#f85149;font-weight:600;
                  padding:6px 0 4px;border-bottom:1px solid rgba(248,81,73,.25);
                  margin-bottom:6px;display:flex;align-items:center;gap:6px">
                 ⚠️ 행동 이상 신호 (${signals.length})
                 ${highCount ? `<span style="background:#f85149;color:#fff;border-radius:8px;padding:1px 6px;font-size:9px">긴급 ${highCount}</span>` : ''}
                 <span style="color:#6e7681;font-weight:normal;font-size:9px">내용 없이 타이핑 행동만 감지</span>
               </div>`;
      html += signals.map(_renderSignalCard).join('');
    }

    // ── 섹션 1: 검증된 무료 솔루션 ────────────────────────────────────────
    if (freeSols.length) {
      html += `<div style="font-size:10px;color:#bc78de;font-weight:600;
                  padding:6px 0 4px;border-bottom:1px solid rgba(138,87,222,.2);
                  margin-bottom:6px;margin-top:${signals.length?'10px':'0'}">
                 🎁 무료 솔루션 (${freeSols.length})</div>`;
      html += freeSols.map(_renderFreeSolCard).join('');
    }

    // ── 섹션 2: 로컬 학습 중 데이터 ───────────────────────────────────────
    if (localSugs.length) {
      html += `<div style="font-size:10px;color:#8b949e;font-weight:600;
                  padding:8px 0 4px;border-bottom:1px solid #30363d;
                  margin-bottom:6px;margin-top:${freeSols.length?'10px':'0'}">
                 📡 학습 중 (${localSugs.length}) — 검증 후 솔루션으로 등록됩니다</div>`;
      html += localSugs.map(_renderLocalSugCard).join('');
    }

    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = `<div class="sg-empty">❌ ${escHtml(e.message)}</div>`;
  }
}
window.loadSuggestions = loadSuggestions;

// ── 무료 솔루션 적용 ─────────────────────────────────────────────────────────
async function applyFreeSolution(sol) {
  try {
    if (sol.template) {
      // 클립보드에 복사
      await navigator.clipboard.writeText(sol.template);
      showToast(`✅ "${sol.title}" 복사됨 — AI에 붙여넣기하세요`);
    } else {
      showToast(`✅ "${sol.title}" 적용됨`);
    }
    // 사용 카운트 서버 전송
    fetch('/api/sync/free-solutions/use', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sol.id }),
    }).catch(() => {});
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.applyFreeSolution = applyFreeSolution;

// ── 행동 이상 신호 확인 처리 ──────────────────────────────────────────────────
async function ackSignal(id, btn) {
  try {
    await fetch(`/api/personal/signals/${encodeURIComponent(id)}/ack`, { method: 'POST' });
    const card = btn?.closest('.sg-card');
    if (card) {
      card.style.opacity = '0.35';
      card.style.pointerEvents = 'none';
      setTimeout(() => card.remove(), 500);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.ackSignal = ackSignal;

// ── 이슈 마킹 ────────────────────────────────────────────────────────────────
async function markIssue(opts = {}) {
  try {
    const r = await fetch('/api/personal/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity:   opts.severity   || 'medium',
        issue_type: opts.issue_type || '불명확',
        note:       opts.note       || '',
        source:     opts.source     || 'user_marked',
      }),
    });
    const d = await r.json();
    if (d.ok) {
      showToast('🚨 이슈 마킹 완료 — 직전 대화 패턴 역추적 중…');
      setTimeout(loadTriggers, 2000);
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.markIssue = markIssue;

// ── 트리거 패턴 로드 ──────────────────────────────────────────────────────────
const TOPIC_KR = {
  work_pressure:'업무 압박', interpersonal:'인간관계 갈등',
  deadline:'일정 압박', blame_shift:'책임 전가',
  technical:'기술 문제', praise:'칭찬', other:'기타',
};
const SENTIMENT_KR = {
  positive:'긍정', negative:'부정', neutral:'중립',
  frustrated:'좌절', anxious:'불안', angry:'분노',
};
const URGENCY_KR = { none:'없음', low:'낮음', medium:'보통', high:'높음', critical:'위급' };

async function loadTriggers() {
  const el = document.getElementById('sg-trigger-list');
  if (!el) return;
  try {
    const [trigRes, riskRes] = await Promise.allSettled([
      fetch('/api/personal/triggers?limit=10'),
      fetch('/api/personal/risk'),
    ]);
    const triggers = trigRes.status==='fulfilled' ? ((await trigRes.value.json()).triggers||[]) : [];
    const riskData = riskRes.status==='fulfilled' ? (await riskRes.value.json()) : {};
    const riskLevel = riskData.riskLevel || 'unknown';
    const riskScore = riskData.score || 0;
    const matched   = riskData.matchedPattern;
    const riskColors = { high:'#f85149', medium:'#ff9500', low:'#3fb950', unknown:'#8b949e', none:'#3fb950' };
    const riskLabels = { high:'🔴 높음', medium:'🟠 보통', low:'🟢 낮음', unknown:'⚪ 미측정', none:'🟢 없음' };

    let html = `<div style="background:#0d1117;border-radius:8px;padding:8px 10px;margin-bottom:8px">
      <div style="font-size:10px;color:#6e7681;margin-bottom:4px">현재 대화 위험도</div>
      <div style="font-size:13px;font-weight:600;color:${riskColors[riskLevel]||'#8b949e'}">
        ${riskLabels[riskLevel]||riskLevel}
        <span style="font-size:10px;font-weight:normal;color:#6e7681"> (${(riskScore*100).toFixed(0)}%)</span>
      </div>
      ${matched ? `<div style="font-size:10px;color:#8b949e;margin-top:3px">
        유사 패턴: ${escHtml(TOPIC_KR[matched.dominant_topic]||'')} + ${escHtml(SENTIMENT_KR[matched.dominant_sentiment]||'')} → 평균 ${matched.hours_before_issue?.toFixed(0)||'?'}h 후 이슈
      </div>` : ''}
    </div>`;

    if (!triggers.length) {
      html += `<div style="font-size:11px;color:#6e7681;text-align:center;padding:12px 0">
        이슈 마킹 시 직전 대화 패턴을<br>역추적해 트리거를 학습합니다
      </div>`;
    } else {
      html += triggers.map(t => {
        const pct   = Math.round((t.correlation||0.5)*100);
        const color = pct>70?'#f85149':pct>50?'#ff9500':'#3fb950';
        return `<div style="margin-bottom:7px;padding:7px 9px;background:#0d1117;border-radius:6px;border-left:2px solid ${color}">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <span style="font-size:11px;color:#cdd9e5;font-weight:600">
              ${escHtml(TOPIC_KR[t.dominant_topic]||t.dominant_topic)} + ${escHtml(SENTIMENT_KR[t.dominant_sentiment]||'')}
            </span>
            <span style="font-size:10px;color:#6e7681">${t.frequency}회</span>
          </div>
          <div style="font-size:10px;color:#6e7681;margin-bottom:4px">
            ${URGENCY_KR[t.dominant_urgency]||''} · 평균 ${t.hours_before_issue?.toFixed(0)||'?'}h 전 시작
          </div>
          <div style="height:3px;background:#21262d;border-radius:2px">
            <div style="width:${pct}%;height:100%;background:${color};border-radius:2px"></div>
          </div>
          <div style="font-size:9px;color:#6e7681;margin-top:2px">예측 정확도 ${pct}%</div>
        </div>`;
      }).join('');
    }
    el.innerHTML = html;
  } catch(e) {
    el.innerHTML = `<div style="color:#f85149;font-size:11px">❌ ${escHtml(e.message)}</div>`;
  }
}
window.loadTriggers = loadTriggers;

async function respondSuggestion(id, action) {
  try {
    await fetch(`/api/personal/suggestions/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    const card = document.getElementById(`sg-card-${id}`);
    if (card) {
      card.style.opacity = '0.4';
      card.style.pointerEvents = 'none';
      setTimeout(() => { card.remove(); }, 600);
    }
    showToast(action === 'accept' ? '✅ 제안 수락됨' : '제안 무시됨');
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.respondSuggestion = respondSuggestion;

// ── 프롬프트 최적화 → Orbit 스킬 저장 ────────────────────────────────────────
async function savePromptSkill(suggestionId, fixedSkill) {
  try {
    // 스킬 저장 (POST /api/skills 또는 로컬 스킬 목록에 추가)
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:        fixedSkill.name        || '최적화 프롬프트',
        description: fixedSkill.description || 'AI 수정 패턴에서 학습된 최적 프롬프트',
        trigger:     fixedSkill.name        || '최적화 프롬프트',
        prompt:      fixedSkill.prompt      || '',
        type:        'prompt_template',
        source:      'suggestion_engine',
      }),
    });
    if (r.ok) {
      showToast('🧠 스킬로 저장됨! /skills 에서 확인하세요.');
      respondSuggestion(suggestionId, 'accept');
    } else {
      showToast('❌ 스킬 저장 실패: ' + (await r.text()));
    }
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.savePromptSkill = savePromptSkill;

// ── 개인 학습 토글 ────────────────────────────────────────────────────────────
const _plState = { keyboard: true, file: true, app: true };

async function togglePersonalLearning(type) {
  _plState[type] = !_plState[type];
  try {
    const body = {};
    if (type === 'keyboard') body.keyboard    = _plState.keyboard;
    if (type === 'file')     body.fileWatcher = _plState.file;
    if (type === 'app')      body.appMonitor  = _plState.app;
    await fetch('/api/personal/toggle', { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    _updatePersonalToggles();
  } catch {}
}
window.togglePersonalLearning = togglePersonalLearning;

function _updatePersonalToggles() {
  const labels = { keyboard: 'sp-toggle-keyboard', file: 'sp-toggle-file', app: 'sp-toggle-app' };
  for (const [key, btnId] of Object.entries(labels)) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    btn.textContent = _plState[key] ? 'ON ●' : 'OFF ○';
    btn.style.color = _plState[key] ? '#3fb950' : '#8b949e';
  }
}

async function _loadPersonalStats() {
  try {
    const r    = await fetch('/api/personal/status');
    const data = await r.json();
    const el   = document.getElementById('sp-personal-stats');
    if (!el) return;
    const t = data.today || {};
    el.innerHTML = `
      <div>⌨️ 키보드: <strong style="color:#cdd9e5">${(t.keywordChars||0).toLocaleString()}자</strong></div>
      <div>📁 파일: <strong style="color:#cdd9e5">${t.fileContents||0}개 처리</strong></div>
      <div>🖥️ 앱 전환: <strong style="color:#cdd9e5">${t.appActivities||0}회</strong></div>
      <div>💡 대기 제안: <strong style="color:#f0c040">${data.pendingSuggestions||0}개</strong></div>
    `;

    // 동기화 상태 (level 0/1/2)
    const syncEl = document.getElementById('sp-sync-status');
    if (syncEl) {
      const lvl = data.syncLevel ?? (data.syncConsented ? 1 : 0);
      const lvlLabels = {
        0: { text:'🔒 내 기기에서만 학습 중', color:'#8b949e' },
        1: { text:'🤝 패턴 인사이트 공유 중 (내용 없음)', color:'#3fb950' },
        2: { text:'🔬 심층 학습 참여 중', color:'#bc78de' },
      };
      const lbl = lvlLabels[lvl] || lvlLabels[0];
      const lastTxt = data.lastSync ? ` · 마지막: ${relTime(data.lastSync)}` : '';
      syncEl.textContent = lbl.text + lastTxt;
      syncEl.style.color = lbl.color;

      // 현재 선택된 버튼 강조
      [0,1,2].forEach(n => {
        const btn = document.getElementById(`sp-sync-btn-${n}`);
        if (btn) btn.style.outline = n === lvl ? '2px solid currentColor' : '';
      });
    }
    _updatePersonalToggles();
  } catch {}
}

async function setSyncConsent(level) {
  // level: 0 = 로컬만, 1 = 제안만 전송, 2 = 원본 이벤트 포함
  try {
    const r    = await fetch('/api/sync/consent', { method:'POST',
      headers:{'Content-Type':'application/json'}, body: JSON.stringify({ level }) });
    const data = await r.json();
    const msgs = {
      0: '🔒 내 기기에서만 학습합니다',
      1: '🤝 패턴 인사이트 공유 시작 — 내용은 전송되지 않습니다',
      2: '🔬 심층 학습 참여 — 프롬프트 구조 공유로 솔루션 품질 향상에 기여합니다',
    };
    showToast(msgs[data.level ?? level] || '✅ 설정 저장');
    _loadPersonalStats();
    renderSetupPanel(); // sync 버튼 상태 갱신
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.setSyncConsent = setSyncConsent;

async function triggerSyncPush() {
  try {
    showToast('↑ 동기화 중…');
    const r    = await fetch('/api/sync/push', { method:'POST' });
    const data = await r.json();
    if (data.ok) showToast(`✅ 동기화 완료: 이벤트 ${data.eventCount||0}개`);
    else         showToast(`❌ ${data.error}`);
    _loadPersonalStats();
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.triggerSyncPush = triggerSyncPush;

async function startPersonalAgent() {
  try {
    const r    = await fetch('/api/exec/run', { method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ command: 'node daemon/personal-agent.js &', cwd: '.', label: 'personal-agent' }) });
    showToast('▶ 개인 학습 에이전트 시작');
  } catch (e) { showToast(`❌ ${e.message}`); }
}
window.startPersonalAgent = startPersonalAgent;

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
  }).catch(() => {});
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

  // CMD에도 붙여넣기 가능한 한 줄 명령어
  const winCmd  = `powershell -ExecutionPolicy Bypass -Command "irm ${serverUrl}/orbit-setup.ps1 | iex"`;
  const macCmd  = `bash <(curl -sL ${serverUrl}/orbit-setup.sh)`;
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
            <div style="font-size:13px;font-weight:600;color:#f0f6fc;margin-bottom:6px">아래 명령어 복사 → 붙여넣기 (<kbd style="background:#21262d;padding:1px 5px;border-radius:3px;font-size:10px">Ctrl+V</kbd>) → Enter</div>
            <div style="position:relative;background:#010409;border:1px solid #21262d;border-radius:8px;padding:12px 44px 12px 14px">
              <code id="install-cmd" style="font-family:'Consolas','Courier New',monospace;font-size:11.5px;color:#3fb950;word-break:break-all;line-height:1.6">${escHtml(cmd)}</code>
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
  `;
  document.body.appendChild(modal);

  // 바깥 클릭 시 닫기
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// 스크립트 복사 (install-cmd 또는 install-script-box)
function copyInstallScript() {
  const el = document.getElementById('install-cmd') || document.getElementById('install-script-box');
  if (!el) return;
  navigator.clipboard.writeText(el.textContent || '').then(() => {
    const btn = document.getElementById('copy-script-btn');
    if (btn) { btn.textContent = '✅ 복사됨'; setTimeout(() => btn.textContent = '복사', 2000); }
  }).catch(() => {
    const t = el.textContent;
    const ta = document.createElement('textarea');
    ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    alert('복사됨!');
  });
}


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

  // ── 트래커 연결 상태 서버에서 확인 ──────────────────────────────────────
  let trackerOnline = false;
  let trackerHost = '';
  let trackerEvents = 0;
  try {
    const token = _getAuthToken();
    const r = await fetch('/api/tracker/status', {
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
    });
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
  const _setupScript = location.origin + '/orbit-setup.ps1' + (_token ? `?token=${encodeURIComponent(_token)}` : '');
  const _setupSh     = location.origin + '/orbit-setup.sh'  + (_token ? `?token=${encodeURIComponent(_token)}` : '');
  const _installCmd  = os === 'windows'
    ? `irm '${_setupScript}' | iex`
    : `bash <(curl -sL '${_setupSh}')`;

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
        }).catch(() => {});
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
  const _setupScript = location.origin + '/orbit-setup.ps1' + (_token ? `?token=${encodeURIComponent(_token)}` : '');
  const _setupSh     = location.origin + '/orbit-setup.sh'  + (_token ? `?token=${encodeURIComponent(_token)}` : '');
  const _installCmd  = os === 'windows'
    ? `irm '${_setupScript}' | iex`
    : `bash <(curl -sL '${_setupSh}')`;

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
  }).catch(() => {});
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
    }).catch(() => {});
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

// ─── 4단계 드릴다운 네비게이션 ─────────────────────────────────────────────
function focusProject(projName) {
  _focusedProject = projName;
  _focusedCategory = null;
  _drillStage = 1;
  _drillProject = { name: projName };
  _drillCategory = null;
  _drillTimelineEvent = null;

  const btn = document.getElementById('constellation-back-btn');
  if (btn) btn.style.display = 'none'; // 빈곳 클릭으로 뒤로가기

  // 카메라 약간 줌아웃 (2D 센터 이동이 실제 레이아웃을 처리)
  lerpCameraTo(85, 0, 0, 0, 700);
}
window.focusProject = focusProject;

function exitConstellationFocus() {
  _focusedProject = null;
  _drillStage = 0;
  _drillProject = null;
  _drillCategory = null;
  _drillTimelineEvent = null;
  closePanel();
  lerpCameraTo(60, 0, 0, 0, 700);
  const btn = document.getElementById('constellation-back-btn');
  if (btn) btn.style.display = 'none';
}
window.exitConstellationFocus = exitConstellationFocus;

// ── 카테고리 드릴 (2단계 → 3단계: 타임라인 패널) ───────────────────────────
function drillToCategory(catData) {
  _drillStage = 2;
  _drillCategory = catData;
  _focusedCategory = catData.catKey;

  // 해당 카테고리의 모든 이벤트 수집
  const allEvents = [];
  (catData.planets || []).forEach(planet => {
    const entry = _sessionMap[planet.userData.clusterId];
    if (!entry) return;
    for (const e of entry.events) {
      allEvents.push({ ...e, clusterId: planet.userData.clusterId });
    }
  });
  allEvents.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  _drillCategory.events = allEvents;

  lerpCameraTo(75, 0, 0, 0, 500);
  showDrillTimeline(_drillCategory);
}
window.drillToCategory = drillToCategory;

function drillToFileDetail(fileName, filePath) {
  _drillStage = 3;
  _drillTimelineEvent = { fileName, filePath };
  showDrillFileDetail(fileName, filePath);
}
window.drillToFileDetail = drillToFileDetail;

// ── 카테고리 포커스 (동적 프로젝트 타입 - 호환) ─────────────────────────────
function focusCategoryView(catKey) {
  _focusedCategory = catKey;
  _focusedProject  = null;
  const catCfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
  const grp = _categoryGroups[catKey];
  if (!grp || grp.planets.length === 0) return;
  let tx = 0, tz = 0;
  grp.planets.forEach(p => { tx += p.position.x; tz += p.position.z; });
  tx /= grp.planets.length; tz /= grp.planets.length;
  lerpCameraTo(35, tx, 0, tz, 700);
}
window.focusCategoryView = focusCategoryView;

function exitCategoryFocus() {
  _focusedCategory = null;
  if (_drillStage >= 2) {
    _drillStage = 1;
    _drillCategory = null;
    _drillTimelineEvent = null;
    closePanel();
    lerpCameraTo(70, 0, 0, 0, 500);
  } else {
    lerpCameraTo(55, 0, 0, 0, 700);
  }
}
window.exitCategoryFocus = exitCategoryFocus;

// ─── 토픽 유사도 기반 글로잉 연결선 ──────────────────────────────────────────
// 로컬 키워드 분석: Ollama 없이도 의미 있는 연결 추론
const _topicLinks = [];         // { a, b, score, color } — 행성 쌍
let _topicLinksBuilt = false;
let _topicLinksLastBuilt = 0;   // 마지막 빌드 시각 (ms) — 5초마다 재빌드

function _tokenize(text) {
  return (text || '').toLowerCase()
    .replace(/[🛠🔧⚙️📝🌐🔐🗄️🎨🧪🚀🐳💬🌿📐]/gu, '')
    .split(/[\s\-_/.,!?·]+/)
    .filter(t => t.length >= 2 && !/^(및|의|을|를|이|가|은|는|로|에|와|과|그|이|저|것|들|수|않|없|있|하|했|됩|될|게|도|만|좀|더|잘|안|못|제|제가|저는)$/.test(t));
}

function _topicSimilarity(intentA, intentB, domainA, domainB) {
  // 1. 같은 도메인 → 기본 점수
  let score = (domainA === domainB && domainA !== 'general' && domainA !== 'purpose') ? 0.35 : 0;
  // 2. 공통 키워드 비율
  const ta = new Set(_tokenize(intentA));
  const tb = new Set(_tokenize(intentB));
  if (ta.size && tb.size) {
    let common = 0;
    ta.forEach(w => { if (tb.has(w)) common++; });
    score += common / Math.sqrt(ta.size * tb.size) * 1.5;
  }
  // 3. 핵심 주제어 일치 보너스 (SaaS, auth, deploy, 결제 등)
  const keywords = ['saas','auth','deploy','결제','랜딩','pipeline','automation','api','test','bug','fix','버그'];
  const sharedKw = keywords.filter(k => (intentA||'').toLowerCase().includes(k) && (intentB||'').toLowerCase().includes(k));
  score += sharedKw.length * 0.25;
  return Math.min(score, 1.0);
}

function buildTopicLinks() {
  if (planetMeshes.length < 2) return;
  const now = Date.now();
  // loadSessionContext() 비동기 완료 대기: 씬 초기화 후 3초 뒤부터 빌드
  // 이후 인텐트가 업데이트될 수 있으므로 5초마다 재빌드
  if (_topicLinksBuilt && now - _topicLinksLastBuilt < 5000) return;
  _topicLinksBuilt = true;
  _topicLinksLastBuilt = now;
  _topicLinks.length = 0;

  for (let i = 0; i < planetMeshes.length; i++) {
    for (let j = i + 1; j < planetMeshes.length; j++) {
      const a = planetMeshes[i], b = planetMeshes[j];
      // 같은 세션 내 클러스터끼리는 이미 별자리로 연결됨 → 스킵
      if (a.userData.sessionId === b.userData.sessionId) continue;
      // 둘 다 제네릭(기타/general) 이면 스킵 (노이즈 방지)
      const iA = a.userData.intent || '', iB = b.userData.intent || '';
      if (/^⚙️\s?기타|^⚙️\s?작업/.test(iA) && /^⚙️\s?기타|^⚙️\s?작업/.test(iB)) continue;
      // 둘 다 짧은 도메인 레이블(구체적 내용 없음)이면 스킵
      const isGenericLabel = t => t.replace(/[^\s\w가-힣]/gu, '').trim().length < 6;
      if (isGenericLabel(iA) && isGenericLabel(iB)) continue;
      const score = _topicSimilarity(iA, iB, a.userData.domain, b.userData.domain);
      if (score >= 0.45) {
        _topicLinks.push({ a, b, score });
      }
    }
  }
}

function drawTopicLinks() {
  if (!planetMeshes.length) return;
  buildTopicLinks();
  if (!_topicLinks.length) return;

  const now = performance.now() / 1000;
  const lod = getLOD();
  if (lod >= 3) return;   // 너무 줌아웃 시 표시 안 함

  _topicLinks.forEach(({ a, b, score }) => {
    const sa = toScreen(a.position);
    const sb = toScreen(b.position);
    if (sa.z > 1 || sb.z > 1) return;

    const hexA = a.userData.hueHex || '#58a6ff';
    const hexB = b.userData.hueHex || '#3fb950';

    // 애니메이션: pulse + 흐름 효과
    const pulse = 0.5 + 0.5 * Math.sin(now * 1.8 + score * 5);
    const baseAlpha = 0.12 + score * 0.28;
    const alpha = baseAlpha * (0.7 + pulse * 0.3);

    // 그래디언트 선
    const grad = _lctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
    grad.addColorStop(0, hexA + Math.round(alpha * 255).toString(16).padStart(2,'0'));
    grad.addColorStop(1, hexB + Math.round(alpha * 255).toString(16).padStart(2,'0'));

    _lctx.save();
    _lctx.globalAlpha = 1;
    _lctx.strokeStyle = grad;
    _lctx.lineWidth   = score >= 0.7 ? 2.2 : score >= 0.5 ? 1.6 : 1.0;

    // 높은 유사도: 실선 + glow / 낮은 유사도: 점선
    if (score >= 0.55) {
      _lctx.shadowColor = hexA;
      _lctx.shadowBlur  = 8 + pulse * 6;
    } else {
      _lctx.setLineDash([6, 10]);
    }

    _lctx.beginPath();
    _lctx.moveTo(sa.x, sa.y);
    _lctx.lineTo(sb.x, sb.y);
    _lctx.stroke();
    _lctx.setLineDash([]);
    _lctx.shadowBlur = 0;
    _lctx.restore();

    // 유사도 뱃지 (중간 지점, score가 높을 때만)
    if (score >= 0.6 && lod <= 1) {
      const mx = (sa.x + sb.x) / 2, my = (sa.y + sb.y) / 2;
      const label = `${Math.round(score * 100)}%`;
      _lctx.save();
      _lctx.globalAlpha = alpha * 1.2;
      _lctx.font = '600 9px -apple-system,sans-serif';
      _lctx.textAlign = 'center';
      _lctx.fillStyle = hexA;
      _lctx.fillText(label, mx, my - 4);
      _lctx.restore();
    }
  });
}

// ─── 별자리 그리기 ────────────────────────────────────────────────────────────
function drawConstellations() {
  const projEntries = Object.entries(_projectGroups);
  if (!projEntries.length) return;

  const now = performance.now() / 1000;

  projEntries.forEach(([projName, grp]) => {
    const pts = grp.planetMeshes
      .map(p => toScreen(p.position))
      .filter(s => s.z <= 1);
    if (!pts.length) return;

    // 별자리 중심 (스크린 좌표 평균)
    let cx = 0, cy = 0;
    pts.forEach(s => { cx += s.x; cy += s.y; });
    cx /= pts.length; cy /= pts.length;

    const color    = grp.color || '#58a6ff';
    const cnt      = grp.planetMeshes.length;
    const isHover  = _hoveredHit?.data?.type === 'constellation' && _hoveredHit?.data?.projName === projName;

    // ── 개별 별 점 (희미하게) ────────────────────────────────────────────
    pts.forEach((s, i) => {
      const pulse = 0.5 + 0.5 * Math.sin(now * 1.4 + i * 1.2);
      _lctx.save();
      _lctx.globalAlpha = 0.35 + pulse * 0.25;
      _lctx.fillStyle   = color;
      _lctx.shadowColor = color; _lctx.shadowBlur = 6;
      _lctx.beginPath(); _lctx.arc(s.x, s.y, 3 + pulse, 0, Math.PI*2); _lctx.fill();
      _lctx.restore();
    });

    // ── 별 연결선 (콘스텔레이션 라인) ────────────────────────────────────
    if (pts.length >= 2) {
      _lctx.save();
      _lctx.strokeStyle = color;
      _lctx.globalAlpha = 0.15;
      _lctx.lineWidth   = 1;
      _lctx.setLineDash([4, 6]);
      _lctx.beginPath();
      // 중심 → 각 별 (허브-앤-스포크)
      pts.forEach(s => {
        _lctx.moveTo(cx, cy);
        _lctx.lineTo(s.x, s.y);
      });
      _lctx.stroke();
      _lctx.setLineDash([]);
      _lctx.restore();
    }

    // ── 중심 오브 (프로젝트 이름 pill) ───────────────────────────────────
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.9);
    // projName 정제: 세션-XXXX → 대표 의도로 대체, hyphen-name → Readable Name
    let _dispName = projName;
    if (/^세션-/.test(projName)) {
      const best = grp.planetMeshes.map(p => p.userData.intent).find(t => t && !/^(⚙️\s?기타|⚙️\s?작업)/.test(t));
      _dispName = best ? best.split(/\s{2,}/)[0].trim() : projName;
    } else if (/[-_]/.test(projName) && !/\s/.test(projName)) {
      _dispName = projName.split(/[-_]/).filter(s => s !== 'session' && s !== 'wf').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ').slice(0, 28);
    }
    const label = `🗂 ${_dispName}`;
    // ── 별자리 서브: 최근 활동 내용 또는 세션 수 ──────────────────────────
    let sub = `${cnt}개 세션`;
    const _grpLatestAct = grp.planetMeshes.reduce((best, pm) => {
      const ent = _sessionMap[pm.userData.clusterId];
      if (!ent) return best;
      const actEv = [...(ent.events || [])].reverse().find(e =>
        e.type === 'app_switch' || e.type === 'browse' || e.type === 'browser_activity'
      );
      if (actEv && (!best || (actEv.timestamp || '') > (best.timestamp || ''))) return actEv;
      return best;
    }, null);
    if (_grpLatestAct) {
      const _actText = extractIntent(_grpLatestAct);
      if (_actText) sub = _actText.slice(0, 30);
    }
    const pxMain = isHover ? 17 : 15;
    const pxSub  = 11;

    _lctx.font = `700 ${pxMain}px -apple-system,'Segoe UI',sans-serif`;
    _lctx.textAlign = 'center';
    const tw   = _lctx.measureText(label).width;
    const pw   = tw + 28;
    const ph   = pxMain + 16;
    const lx   = cx - pw / 2;
    const ly   = cy - ph / 2;

    // 글로우
    _lctx.save();
    _lctx.globalAlpha = 0.18 + pulse * 0.12;
    _lctx.shadowColor = color; _lctx.shadowBlur = 22 + pulse * 8;
    _lctx.fillStyle = color;
    _lctx.beginPath(); _lctx.arc(cx, cy, (pw + ph) / 4 + 6, 0, Math.PI * 2); _lctx.fill();
    _lctx.restore();

    // 배경 pill
    _lctx.globalAlpha = isHover ? 0.97 : 0.88;
    _lctx.fillStyle   = 'rgba(6,10,16,0.93)';
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.fill();

    // 3D 와이어프레임 그리드
    drawWireframeGrid(_lctx, lx, ly, pw, ph, ph / 2, color, isHover ? 0.28 : 0.18);

    // 테두리
    _lctx.strokeStyle = color;
    _lctx.lineWidth   = isHover ? 2.5 : 1.8;
    _lctx.shadowColor = color; _lctx.shadowBlur = isHover ? 14 : 6;
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.stroke();
    _lctx.shadowBlur  = 0;

    // 텍스트
    _lctx.fillStyle = isHover ? '#ffffff' : '#e6edf3';
    _lctx.fillText(label, cx, ly + ph * 0.67);

    // 서브 레이블
    _lctx.font = `400 ${pxSub}px -apple-system,sans-serif`;
    _lctx.fillStyle = color + '99';
    _lctx.globalAlpha = 0.85;
    _lctx.fillText(sub, cx, ly + ph + pxSub + 2);

    _lctx.globalAlpha = 1;

    // ── 활성 파일 배지 (프로젝트 pill 아래에 표시) ─────────────────────────
    const activeFiles = _activeFilesPerProject[projName] || [];
    if (activeFiles.length > 0) {
      const badgeY = ly + ph + pxSub + 18;       // 서브 레이블 아래
      const badgePx = 10;
      const badgeH = badgePx + 8;
      const badgeGap = 3;
      const maxBadges = Math.min(activeFiles.length, 3);   // 최대 3개 표시

      // 전체 너비 계산 (중앙 정렬용)
      _lctx.font = `600 ${badgePx}px -apple-system,'Segoe UI',monospace`;
      let totalW = 0;
      for (let bi = 0; bi < maxBadges; bi++) {
        totalW += _lctx.measureText('⚡ ' + activeFiles[bi].shortName).width + 16;
        if (bi < maxBadges - 1) totalW += badgeGap;
      }
      let bx = cx - totalW / 2;

      for (let bi = 0; bi < maxBadges; bi++) {
        const af = activeFiles[bi];
        const afLabel = (af.isWrite ? '✏️ ' : '⚡ ') + af.shortName;
        const afW = _lctx.measureText(afLabel).width + 16;
        const bPulse = 0.5 + 0.5 * Math.sin(now * 2.5 + bi * 1.3);

        // 배지 배경 (어두운 반투명 + 활성 색상 테두리)
        _lctx.save();
        _lctx.globalAlpha = 0.92;
        _lctx.fillStyle = 'rgba(13,17,23,0.95)';
        roundRect(_lctx, bx, badgeY, afW, badgeH, badgeH / 2);
        _lctx.fill();

        // 테두리 + 펄스 글로우
        _lctx.strokeStyle = af.isWrite ? '#f0883e' : '#3fb950';
        _lctx.lineWidth = 1.5;
        _lctx.shadowColor = af.isWrite ? '#f0883e' : '#3fb950';
        _lctx.shadowBlur = 4 + bPulse * 6;
        roundRect(_lctx, bx, badgeY, afW, badgeH, badgeH / 2);
        _lctx.stroke();
        _lctx.shadowBlur = 0;

        // 텍스트
        _lctx.font = `600 ${badgePx}px -apple-system,'Segoe UI',monospace`;
        _lctx.fillStyle = af.isWrite ? '#f0883e' : '#3fb950';
        _lctx.globalAlpha = 0.7 + bPulse * 0.3;
        _lctx.textAlign = 'left';
        _lctx.fillText(afLabel, bx + 8, badgeY + badgeH * 0.7);
        _lctx.restore();

        // 히트 영역 (클릭으로 파일 열기)
        _hitAreas.push({
          cx: bx + afW / 2, cy: badgeY + badgeH / 2,
          r: Math.max(afW, badgeH) / 2 + 4,
          obj: null,
          data: { type: 'activeFile', filePath: af.filePath, fileName: af.file, projName },
        });

        bx += afW + badgeGap;
      }

      // 추가 파일 수 표시 (+N more)
      if (activeFiles.length > maxBadges) {
        _lctx.save();
        _lctx.font = `400 9px -apple-system,sans-serif`;
        _lctx.fillStyle = '#6e7681';
        _lctx.globalAlpha = 0.7;
        _lctx.textAlign = 'left';
        _lctx.fillText(`+${activeFiles.length - maxBadges}`, bx + 4, badgeY + badgeH * 0.7);
        _lctx.restore();
      }

      _lctx.textAlign = 'center';  // 원래대로 복원
    }

    // 히트 영역
    _hitAreas.push({
      cx, cy,
      r: (Math.max(pw, ph) / 2) + 6,
      obj: null,
      data: { type: 'constellation', projName, planetCount: cnt, color },
    });
  });
}

// ─── 1단계: 프로젝트 노드 뷰 (방사형 + 밝은 테마) ──────────────────────────
// ME 노드 중심, 프로젝트를 원형 배치, 클릭 시 2단계 카테고리 링 전개
function drawCompactProjectView() {
  const projNames = Object.keys(_projectGroups);
  if (projNames.length === 0) return;

  const now = performance.now() / 1000;
  const ctx = _lctx;

  // ── 캔버스 중앙 기준점 ──────────────────────────────────────────────────────
  const W = _labelCanvas2d.width, H = _labelCanvas2d.height;
  let centerX = W / 2;
  let centerY = H / 2;

  // ── 프로젝트별 정보 집계 ──────────────────────────────────────────────────
  const projects = projNames.map(name => {
    const grp = _projectGroups[name];
    const planets = grp.planetMeshes || [];
    const eventCount = planets.reduce((s, p) => s + (p.userData.eventCount || 0), 0);
    const hasActive = (_activeFilesPerProject[name] || []).length > 0;
    const typeCounts = {};
    planets.forEach(p => {
      const t = p.userData.macroCat || 'general';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    });
    const mainType = Object.entries(typeCounts).sort((a,b) => b[1] - a[1])[0]?.[0] || 'general';
    const typeCfg = PROJECT_TYPES[mainType] || PROJECT_TYPES.general;
    return { name, planets, eventCount, hasActive, mainType, typeCfg, color: grp.color || typeCfg.color };
  }).filter(p => p.eventCount > 0).sort((a,b) => b.eventCount - a.eventCount);

  if (projects.length === 0) return;

  // ── 스마트 프로젝트명 분석 ────────────────────────────────────────────────
  function analyzeProject(proj) {
    const planets = proj.planets || [];
    const catCounts = {};
    planets.forEach(p => {
      const c = p.userData.macroCat || 'general';
      catCounts[c] = (catCounts[c] || 0) + 1;
    });
    const topCats = Object.entries(catCounts).sort((a,b) => b[1] - a[1]);
    const topCat = topCats[0]?.[0] || 'general';
    const topCfg = PROJECT_TYPES[topCat] || PROJECT_TYPES.general;

    const exts = {};
    planets.forEach(p => {
      const entry = _sessionMap[p.userData.clusterId];
      if (!entry) return;
      for (const e of entry.events) {
        const f = (e.data?.filePath || e.data?.fileName || '');
        const m = f.match(/\.([a-z]{1,6})$/i);
        if (m) exts[m[1].toLowerCase()] = (exts[m[1].toLowerCase()] || 0) + 1;
      }
    });
    const topExts = Object.entries(exts).sort((a,b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);

    const rawName = proj.name;
    let smartName;
    if (rawName && rawName !== '기타' && !/^세션-/.test(rawName)) {
      smartName = rawName.split(/[-_]/).filter(s => s !== 'session')
        .map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    } else {
      const stack = topExts.length > 0 ? topExts.join('+').toUpperCase() : '';
      smartName = stack ? `${stack} ${topCfg.label}` : topCfg.label + ' 프로젝트';
    }

    const allFiles = new Set();
    planets.forEach(p => {
      const entry = _sessionMap[p.userData.clusterId];
      if (!entry) return;
      for (const e of entry.events) {
        const f = (e.data?.filePath || e.data?.fileName || '');
        if (f) allFiles.add(f.split(/[\\/]/).pop());
      }
    });

    return {
      name: smartName.slice(0, 24),
      icon: topCfg.icon,
      catBreakdown: topCats.slice(0, 3).map(([k, v]) => {
        const cfg = PROJECT_TYPES[k] || PROJECT_TYPES.general;
        return { key: k, label: cfg.label, icon: cfg.icon, count: v, color: cfg.color };
      }),
      fileCount: allFiles.size,
      sessionCount: planets.length,
      techStack: topExts.join(' · ') || '',
    };
  }

  // ── ME 노드 (화면 중앙) ────────────────────────────────────────────────────
  const meW = 130, meH = 48;
  const meLx = centerX - meW / 2, meLy = centerY - meH / 2;
  const meR = meH / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
  ctx.shadowColor = 'rgba(6,182,212,0.15)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 0;
  roundRect(ctx, meLx, meLy, meW, meH, meR); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.restore();
  // 3D 와이어프레임 그리드
  drawWireframeGrid(ctx, meLx, meLy, meW, meH, meR, 'rgba(6,182,212,1)', 0.22);
  ctx.strokeStyle = 'rgba(6,182,212,0.5)'; ctx.lineWidth = 1.5;
  roundRect(ctx, meLx, meLy, meW, meH, meR); ctx.stroke();
  ctx.font = "700 16px 'Inter',-apple-system,sans-serif";
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText('나의 작업', centerX, centerY + 6);

  // 라벨 별칭 맵 (인라인 편집 저장본)
  const _aliases = (() => { try { return JSON.parse(localStorage.getItem('orbitLabelAliases') || '{}'); } catch { return {}; } })();

  // ── 프로젝트 노드 수평 직선 배치 (ME 박스 바로 위에 밀착) ─────────────────
  const H_GAP = 6;                                           // 카드 간 가로 간격
  const CARD_TOP_OFFSET = meH / 2 + UNI_CARD_H / 2 + 4;   // ME 박스 상단에서 카드 중심까지
  const totalCardsW = projects.length * UNI_CARD_W + (projects.length - 1) * H_GAP;
  const isDrillStage1 = _drillStage >= 1 && _drillProject;
  const LAYER_OFFSET = UNI_CARD_W + 8;

  // ── 드릴다운 시 centerY를 아래로 이동: 위로 방사되는 카드들이 전부 화면에 들어오게 ──
  if (isDrillStage1) {
    const drillIdx = projects.findIndex(p => p.name === _drillProject.name);
    if (drillIdx >= 0) {
      // 직선 배치이므로 방향은 항상 위(-y)
      const expandLayers = 3;                               // 프로젝트→카테고리→세션 최대 3단계
      const totalExpand = CARD_TOP_OFFSET + expandLayers * (UNI_CARD_H + H_GAP) * 4;
      const marginT = 80;
      const availY = centerY - marginT;
      const needY = totalExpand;
      const shiftY = Math.max(0, needY - availY);
      centerY += shiftY;                                    // 아래로 밀어서 상단 확장 공간 확보
    }
  }

  projects.forEach((proj, i) => {
    // 수평 직선 배치: ME 박스 바로 위에 나란히
    const isThisDrilled = isDrillStage1 && _drillProject.name === proj.name;

    const cx = centerX - totalCardsW / 2 + i * (UNI_CARD_W + H_GAP) + UNI_CARD_W / 2;
    const cy = centerY - CARD_TOP_OFFSET;
    const isHover = _hoveredHit?.data?.type === 'constellation' && _hoveredHit?.data?.projName === proj.name;
    const color = proj.color;
    const info = analyzeProject(proj);

    // 비활성 프로젝트 흐리게
    const dimmed = isDrillStage1 && !isThisDrilled;
    if (dimmed) ctx.globalAlpha = 0.3;

    // 라벨 별칭 적용
    const projTitle = _aliases[proj.name] || `${info.icon} ${info.name}`;
    const projSub = `${info.sessionCount}세션 · ${info.fileCount}파일`;

    drawUnifiedCard(ctx, cx, cy, color, projTitle, projSub, proj.hasActive, isHover, isThisDrilled);

    ctx.globalAlpha = 1;

    // ME → 프로젝트 연결선
    {
      ctx.save();
      ctx.globalAlpha = dimmed ? 0.1 : 0.18;
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(centerX, centerY - meH / 2); ctx.lineTo(cx, cy + UNI_CARD_H / 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 히트 영역
    _hitAreas.push({
      cx, cy, r: Math.max(UNI_CARD_W, UNI_CARD_H) / 2 + 6,
      obj: null,
      data: { type: 'constellation', projName: proj.name, planetCount: proj.planets.length, color, info },
    });

    // ══ 2단계: 카테고리 + 세션 — 바깥 방향 스택 (카드 밀착, 겹침 방지) ══════
    if (isThisDrilled && proj.planets.length > 0) {
      const catGroups = {};
      proj.planets.forEach(planet => {
        const cat = planet.userData.macroCat || 'general';
        if (!catGroups[cat]) catGroups[cat] = [];
        catGroups[cat].push(planet);
      });
      const sortedCats = Object.entries(catGroups).sort((a, b) => b[1].length - a[1].length);
      const numCats = sortedCats.length;

      // 직선 배치: 방향은 항상 위(-y), 수직은 가로(+x)
      const dirX = 0, dirY = -1;
      const perpX = 1, perpY = 0;

      // 방향에 따른 동적 간격: 카드(180x51)가 가로로 길어서 방향별 룰이 다름
      // outward 방향 간격 = 카드가 그 방향에서 차지하는 크기
      const outwardStep = Math.abs(dirX) * UNI_CARD_W + Math.abs(dirY) * UNI_CARD_H;
      // perpendicular 방향 간격 = 카드가 수직 방향에서 차지하는 크기
      const perpStep = Math.abs(perpX) * UNI_CARD_W + Math.abs(perpY) * UNI_CARD_H;

      const CAT_GAP = 4;
      const CAT_OFFSET = outwardStep + 8;                               // 프로젝트→카테고리 밀착 거리
      const catBaseX = cx + dirX * CAT_OFFSET;
      const catBaseY = cy + dirY * CAT_OFFSET;

      // 각 카테고리의 세션 수를 고려한 동적 스텝 — 세션 서브스택끼리 겹치지 않게
      const maxShowPerCat = sortedCats.map(([, ps]) => Math.min(ps.length, 4));
      const catHeights = maxShowPerCat.map(n => Math.max(perpStep, n * (perpStep + 4) - 4));
      const totalH = catHeights.reduce((s, h, i) => s + h + (i > 0 ? CAT_GAP : 0), 0);
      const catOffsets = [];
      let cumY = -totalH / 2;
      catHeights.forEach((h, i) => {
        catOffsets.push(cumY + h / 2);
        cumY += h + CAT_GAP;
      });

      sortedCats.forEach(([catKey, catPlanets], ci) => {
        const cfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
        // 수직 스택: 중앙 정렬 (세션 높이 고려)
        const stackOffset = catOffsets[ci];
        const catCx = catBaseX + perpX * stackOffset;
        const catCy = catBaseY + perpY * stackOffset;

        const catSessionCount = catPlanets.length;
        const isCatDrilled = _drillStage >= 2 && _drillCategory?.catKey === catKey;
        const isCatHover = _hoveredHit?.data?.type === 'drillCategory' && _hoveredHit?.data?.catKey === catKey;

        const catTitle = _aliases[catKey] || `${cfg.icon} ${cfg.label}`;
        const catSub = `${catSessionCount} 세션`;

        // 프로젝트 → 카테고리 연결선
        ctx.save();
        ctx.globalAlpha = 0.15;
        ctx.strokeStyle = cfg.color; ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(catCx, catCy); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        drawUnifiedCard(ctx, catCx, catCy, cfg.color, catTitle, catSub, false, isCatHover, isCatDrilled);

        // 카테고리 히트 영역
        _hitAreas.push({
          cx: catCx, cy: catCy, r: Math.max(UNI_CARD_W, UNI_CARD_H) / 2 + 4,
          obj: null,
          data: {
            type: 'drillCategory', catKey,
            catLabel: cfg.label, catColor: cfg.color, catIcon: cfg.icon,
            projName: proj.name, planets: catPlanets, sessionCount: catSessionCount,
          },
        });

        // ── 세션 노드: 같은 바깥 방향으로 밀착 스택 ──────────────────────────
        const maxShow = Math.min(catPlanets.length, 4);
        const SES_GAP = 4;
        const SES_OFFSET = outwardStep + 8;                            // 카테고리→세션 밀착 거리

        for (let si = 0; si < maxShow; si++) {
          const planet = catPlanets[si];
          const sesStackOff = (si - (maxShow - 1) / 2) * (perpStep + SES_GAP);
          const sx = catCx + dirX * SES_OFFSET + perpX * sesStackOff;
          const sy = catCy + dirY * SES_OFFSET + perpY * sesStackOff;

          const evCnt = planet.userData.eventCount || 0;
          const isSubHover = _hoveredHit?.obj === planet;
          const nodeColor = cfg.color;

          // 세션 라벨
          const sesKey = planet.userData.clusterId || planet.userData.sessionId || '';
          let sLabel = _aliases[sesKey] || planet.userData.intent || '';
          sLabel = sLabel.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚙️🔐🌐🗄🎨🧪🚀🐳📝📐🔧🌿💬]\s*/gu, '').trim();
          if (!sLabel) sLabel = planet.userData.domain || '작업';
          const sesSub = evCnt > 0 ? `${evCnt}개 작업` : '';

          // 카테고리 → 세션 연결선
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = cfg.color; ctx.lineWidth = 0.8;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(catCx, catCy); ctx.lineTo(sx, sy); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          drawUnifiedCard(ctx, sx, sy, nodeColor, sLabel, sesSub, false, isSubHover, false);

          // 히트 영역
          _hitAreas.push({
            cx: sx, cy: sy, r: Math.max(UNI_CARD_W, UNI_CARD_H) / 2 + 4,
            obj: planet,
            data: { type: 'drillSession', intent: planet.userData.intent,
                    clusterId: planet.userData.clusterId,
                    sessionId: planet.userData.sessionId,
                    eventCount: evCnt, hueHex: nodeColor,
                    catKey, catLabel: cfg.label, catColor: cfg.color, catIcon: cfg.icon,
                    projName: proj.name, planets: catPlanets },
          });
        }

        // 남은 세션 수
        if (catPlanets.length > maxShow) {
          const mx = catCx + dirX * (SES_OFFSET + UNI_CARD_W / 2 + 16);
          const my = catCy + dirY * (SES_OFFSET + UNI_CARD_W / 2 + 16);
          ctx.globalAlpha = 0.6;
          ctx.font = '400 10px -apple-system,sans-serif';
          ctx.fillStyle = cfg.color; ctx.textAlign = 'center';
          ctx.fillText(`+${catPlanets.length - maxShow}개`, mx, my + 4);
          ctx.globalAlpha = 1;
        }
      });
    }
  });

  // ── hitArea 우선순위 정렬: 드릴 노드가 프로젝트 카드보다 위 (역순 루프 대응) ──
  // constellation(프로젝트 카드)을 앞으로, drillCategory/drillSession을 뒤로 이동
  // → hitTest는 배열 역순이므로 드릴 노드가 겹칠 때 우선 선택됨
  _hitAreas.sort((a, b) => {
    const drillTypes = new Set(['drillCategory', 'drillSession']);
    const aDrill = drillTypes.has(a.data?.type) ? 1 : 0;
    const bDrill = drillTypes.has(b.data?.type) ? 1 : 0;
    return aDrill - bDrill;
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 개인 모드 행성 라벨 (밝은 테마, 연결선 없음)
// ═══════════════════════════════════════════════════════════════════════════════
function _drawPersonalPlanets() {
  const lod = getLOD();
  const globalAlpha = lod === 3 ? 0.12 : 1;
  _lctx.globalAlpha = globalAlpha;

  planetMeshes.forEach(p => {
    if (_focusedCategory && p.userData.macroCat !== _focusedCategory) return;
    const sc = toScreen(p.position);
    if (sc.z > 1) return;

    const scale      = screenScale(p.position);
    const hex        = p.userData.hueHex || '#58a6ff';
    const evCnt      = p.userData.eventCount || 0;
    const isHovered  = _hoveredHit?.obj === p;
    const isSelected = _selectedHit?.obj === p;

    const pxSize = isSelected ? 20 : isHovered ? 16 : Math.max(9, Math.min(14, scale * 12));

    let fullText = p.userData.intent || '';
    let text = '';
    if (fullText) {
      text = fullText.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚙️🔐🌐🗄🎨🧪🚀🐳📝📐🔧🌿💬]\s*/gu, '').trim();
      if (/^\[.+?\]\s+/.test(text)) text = text.replace(/^\[.+?\]\s+/, '');
      if (text.length > 24) text = text.slice(0, 23) + '…';
    }
    if (!text && p.userData.msgPreview) text = p.userData.msgPreview.slice(0, 24);
    if (!text && p.userData.firstMsg) text = p.userData.firstMsg.slice(0, 24);
    if (!text && p.userData.projectName && p.userData.projectName !== '기타') text = p.userData.projectName.slice(0, 16);
    if (!text) {
      const DS = { auth:'인증', api:'API', data:'데이터', ui:'UI', test:'테스트',
        server:'서버', infra:'인프라', fix:'수정', git:'Git', chat:'대화', general:'작업', docs:'문서', design:'설계' };
      text = DS[p.userData.domain] || '작업';
    }
    if (!text) return;

    _lctx.font = `600 ${pxSize}px -apple-system,'Segoe UI',sans-serif`;
    _lctx.textAlign = 'center';

    const tw = _lctx.measureText(text).width;
    const pw = tw + 22;
    const ph = pxSize + 10;
    const lx = sc.x - pw / 2;
    const ly = sc.y - ph / 2;

    if (rectOverlaps(lx - 4, ly - 4, pw + 8, ph + 30)) return;
    reserveRect(lx - 4, ly - 4, pw + 8, ph + 30);

    // 선택 강조
    if (isSelected) {
      _lctx.save();
      _lctx.shadowColor = hex; _lctx.shadowBlur = 10;
      _lctx.strokeStyle = hex; _lctx.lineWidth = 2.5;
      _lctx.globalAlpha = globalAlpha * 0.8;
      roundRect(_lctx, lx - 2, ly - 2, pw + 4, ph + 4, (ph + 4) / 2);
      _lctx.stroke(); _lctx.shadowBlur = 0;
      _lctx.restore();
      _lctx.globalAlpha = globalAlpha;
    }

    // 배경 pill (다크 글래스)
    _lctx.save();
    _lctx.shadowColor = isSelected ? 'rgba(6,182,212,0.2)' : 'rgba(0,0,0,0.3)';
    _lctx.shadowBlur = isSelected ? 12 : 6; _lctx.shadowOffsetY = 1;
    _lctx.fillStyle = isSelected ? 'rgba(6,182,212,0.12)' : 'rgba(2,6,23,0.78)';
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.fill();
    _lctx.shadowBlur = 0; _lctx.shadowOffsetY = 0;
    _lctx.restore();

    // 테두리 (white/10)
    _lctx.strokeStyle = isSelected ? hex : isHovered ? 'rgba(6,182,212,0.35)' : 'rgba(255,255,255,0.10)';
    _lctx.lineWidth = isSelected ? 1.5 : isHovered ? 1 : 0.8;
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.stroke();

    // 텍스트 (밝은 색)
    _lctx.fillStyle = isSelected ? '#e2e8f0' : isHovered ? '#cbd5e1' : '#94a3b8';
    _lctx.fillText(text, sc.x, ly + ph * 0.68);

    // 이벤트 수 (선택/호버 시)
    if (evCnt > 0 && pxSize >= 13) {
      const sub = Math.max(9, pxSize * 0.5);
      _lctx.font = `500 ${sub}px 'JetBrains Mono','Fira Code',monospace`;
      _lctx.fillStyle = '#475569';
      _lctx.fillText(`${evCnt}개 작업`, sc.x, ly + ph + sub + 1);
    }

    // 히트 영역
    _hitAreas.push({
      cx: sc.x, cy: sc.y, r: Math.max(pw, ph) / 2 + 4,
      obj: p,
      data: { type: 'session', intent: fullText, clusterId: p.userData.clusterId,
              sessionId: p.userData.sessionId, eventCount: evCnt, hueHex: hex },
    });
  });

  _lctx.globalAlpha = 1;
}

// ─── drawLabels ──────────────────────────────────────────────────────────────
// ── 텍스트 겹침 방지 ──────────────────────────────────────────────────────
const _usedRects = [];
function rectOverlaps(x, y, w, h) {
  for (const r of _usedRects) {
    if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return true;
  }
  return false;
}
function reserveRect(x, y, w, h) { _usedRects.push({ x, y, w, h }); }

// ═══════════════════════════════════════════════════════════════════════════════
// 세션 상세 윈도우 — 데스크톱 창 스타일
// 세션 클릭 시 화면 중앙에 윈도우 형태로 표시
// ═══════════════════════════════════════════════════════════════════════════════
let _pyramidTrayScale = 1.0;

function drawInvertedPyramid(planetObj, hitData) {
  const sc = toScreen(planetObj.position);
  if (sc.z > 1) return;

  const ctx = _lctx;
  const clusterId = planetObj.userData?.clusterId || planetObj.userData?.sessionId;
  const entry     = _sessionMap[clusterId];
  const events    = entry?.events || [];
  if (events.length === 0) return;

  const hex = planetObj.userData?.hueHex || '#58a6ff';

  // ── 데이터 준비 ─────────────────────────────────────────────────────────
  const sessionCtx = _sessionContextCache[clusterId] || {};
  const projName   = sessionCtx.projectName || planetObj.userData?.projectName || '';
  const firstMsg   = sessionCtx.firstMsg || sessionCtx.autoTitle || '';

  // 파일 집계
  const fileCounts = {};
  let writeCount = 0, readCount = 0, msgCount = 0, toolCount = 0;
  for (const e of events) {
    let d = e.data || {};
    if (e.fullContent && typeof e.fullContent === 'string' && e.fullContent.startsWith('{')) {
      try { d = {...d, ...JSON.parse(e.fullContent)}; } catch {}
    }
    // 통계
    if (e.type === 'file.write' || (e.type === 'tool.end' && d.toolName === 'Write')) writeCount++;
    else if (e.type === 'file.read') readCount++;
    else if (e.type === 'user.message' || e.type === 'assistant.message' || e.type === 'assistant.response') msgCount++;
    else toolCount++;

    const raw = d.filePath || d.fileName || '';
    if (!raw) continue;
    const fname = raw.replace(/\\/g, '/').split('/').pop();
    if (!fname || fname.length < 2) continue;
    if (!fileCounts[fname]) fileCounts[fname] = { count: 0, writes: 0 };
    fileCounts[fname].count++;
    if (e.type === 'file.write' || (e.type === 'tool.end' && d.toolName === 'Write')) fileCounts[fname].writes++;
  }
  const fileList = Object.entries(fileCounts).sort((a,b) => b[1].count - a[1].count).slice(0, 8);

  // 시간 범위
  const timestamps = events.filter(e => e.timestamp).map(e => new Date(e.timestamp).getTime());
  const startTime = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : null;
  const endTime   = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
  const durationMin = startTime && endTime ? Math.round((endTime - startTime) / 60000) : 0;

  // 최근 이벤트 (스크롤 오프셋 적용)
  const recentEvts = [...events].reverse().slice(0, 50);
  const scrollIdx  = Math.min(Math.floor((_pyramidScrollOffset || 0) / 36), Math.max(0, recentEvts.length - 6));
  const visibleEvts = recentEvts.slice(scrollIdx, scrollIdx + 6);

  // ── 레이아웃 ─────────────────────────────────────────────────────────────
  const WIN_W   = Math.min(480, ctx.canvas.width * 0.80);
  const PAD     = 18;
  const TITLE_H = 38;   // 타이틀바
  const SUMMARY_H = 60; // 요약 카드 영역
  const ROW_H   = 30;
  const GAP     = 3;
  const FILE_ROW_H = 28;

  const evtSectionH = visibleEvts.length * (ROW_H + GAP) + 24;
  const fileSectionH = fileList.length > 0 ? (24 + fileList.length * (FILE_ROW_H + GAP)) : 0;
  const scrollHintH = recentEvts.length > 6 ? 20 : 0;
  const totalH = TITLE_H + SUMMARY_H + evtSectionH + scrollHintH + fileSectionH + PAD;

  const centerX = ctx.canvas.width / 2;
  const winX = centerX - WIN_W / 2;
  const winY = Math.max(30, (ctx.canvas.height - totalH) / 2 - 30);

  ctx.save();

  // ── 윈도우 그림자 (다크 글래스) ───────────────────────────────────────
  ctx.shadowColor = 'rgba(6,182,212,0.1)';
  ctx.shadowBlur = 30;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
  roundRect(ctx, winX, winY, WIN_W, totalH, 12);
  ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // 윈도우 테두리 (white/10)
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1;
  roundRect(ctx, winX, winY, WIN_W, totalH, 12);
  ctx.stroke();

  // ── 타이틀바 (다크 글래스) ───────────────────────────────────────────
  ctx.fillStyle = 'rgba(6,182,212,0.06)';
  // 상단 좌/우 모서리만 둥글게
  ctx.beginPath();
  ctx.moveTo(winX + 12, winY);
  ctx.lineTo(winX + WIN_W - 12, winY);
  ctx.arcTo(winX + WIN_W, winY, winX + WIN_W, winY + 12, 12);
  ctx.lineTo(winX + WIN_W, winY + TITLE_H);
  ctx.lineTo(winX, winY + TITLE_H);
  ctx.lineTo(winX, winY + 12);
  ctx.arcTo(winX, winY, winX + 12, winY, 12);
  ctx.closePath();
  ctx.fill();

  // 타이틀바 하단선
  ctx.strokeStyle = hex + '30';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(winX, winY + TITLE_H); ctx.lineTo(winX + WIN_W, winY + TITLE_H); ctx.stroke();

  // 윈도우 버튼 (장식)
  const btnY = winY + TITLE_H / 2;
  [['#ff5f57', winX + 16], ['#ffbd2e', winX + 32], ['#28c840', winX + 48]].forEach(([c, bx]) => {
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(bx, btnY, 5, 0, Math.PI * 2); ctx.fill();
  });

  // 타이틀 텍스트
  const titleText = firstMsg
    ? (firstMsg.length > 40 ? firstMsg.slice(0, 39) + '…' : firstMsg)
    : planetObj.userData?.intent?.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚙️🔐🌐🗄🎨🧪🚀🐳📝📐🔧🌿💬]\s*/gu, '').trim().slice(0, 40) || '세션 상세';
  ctx.font = "600 13px 'Inter',-apple-system,'Segoe UI',sans-serif";
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText(titleText, centerX, winY + TITLE_H / 2 + 4);

  let curY = winY + TITLE_H + 12;

  // ── 요약 카드 섹션 (stat chips) ────────────────────────────────────────
  const stats = [
    { icon: '💬', label: '대화', value: msgCount, color: '#79c0ff' },
    { icon: '✏️', label: '편집', value: writeCount, color: '#ffa657' },
    { icon: '📄', label: '파일', value: fileList.length, color: '#3fb950' },
    { icon: '⏱', label: '소요', value: durationMin > 0 ? `${durationMin}분` : '-', color: '#d2a8ff' },
  ];

  const CHIP_W = (WIN_W - PAD * 2 - 12) / 4;
  const CHIP_H = 42;
  stats.forEach((st, si) => {
    const chipX = winX + PAD + si * (CHIP_W + 4);
    const chipY = curY;

    // 칩 배경 (다크 글래스)
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    roundRect(ctx, chipX, chipY, CHIP_W, CHIP_H, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 0.5;
    roundRect(ctx, chipX, chipY, CHIP_W, CHIP_H, 8); ctx.stroke();

    // 값
    ctx.textAlign = 'center';
    ctx.font = "700 15px 'JetBrains Mono','Fira Code',monospace";
    ctx.fillStyle = st.color;
    ctx.fillText(`${st.value}`, chipX + CHIP_W / 2, chipY + 18);

    // 라벨
    ctx.font = "400 9px 'Inter',-apple-system,sans-serif";
    ctx.fillStyle = '#475569';
    ctx.fillText(`${st.icon} ${st.label}`, chipX + CHIP_W / 2, chipY + 34);
  });

  curY += CHIP_H + 14;

  // 시간 범위 표시
  if (startTime) {
    ctx.textAlign = 'left';
    ctx.font = `400 10px -apple-system,sans-serif`;
    ctx.fillStyle = '#6e7681';
    const timeRange = `${startTime.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'})} ~ ${endTime.toLocaleTimeString('ko-KR', {hour:'2-digit', minute:'2-digit'})}`;
    const dateStr = startTime.toLocaleDateString('ko-KR', {month:'short', day:'numeric'});
    ctx.fillText(`📅 ${dateStr}  ${timeRange}`, winX + PAD, curY);
    if (projName) {
      ctx.textAlign = 'right';
      ctx.fillStyle = hex;
      ctx.fillText(`📂 ${projName}`, winX + WIN_W - PAD, curY);
    }
    curY += 16;
  }

  // 구분선
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(winX + PAD, curY); ctx.lineTo(winX + WIN_W - PAD, curY); ctx.stroke();
  curY += 8;

  // ── 타임라인 이벤트 (세로 카드) ────────────────────────────────────────
  const TYPE_ICONS = {
    'user.message': '💬', 'assistant.message': '🤖', 'assistant.response': '🤖',
    'tool.start': '⚡', 'tool.end': '✅', 'tool.error': '❌',
    'file.read': '📄', 'file.write': '✏️', 'git.commit': '🌿', 'git.push': '🚀',
    'session.start': '🌟', 'browse': '🌐', 'app_switch': '🔄',
  };
  const evtCardW = WIN_W - PAD * 2;

  visibleEvts.forEach((evt, i) => {
    const ex = winX + PAD;
    const ey = curY + i * (ROW_H + GAP);
    const icon = TYPE_ICONS[evt.type] || '⚙️';
    const label = (evt.label || extractIntent(evt) || evt.type || '').slice(0, 45);
    const ts = evt.timestamp
      ? new Date(evt.timestamp).toLocaleTimeString('ko', { hour: '2-digit', minute: '2-digit' })
      : '';

    // 타임라인 점
    ctx.fillStyle = hex;
    ctx.beginPath(); ctx.arc(ex + 6, ey + ROW_H / 2, 3, 0, Math.PI * 2); ctx.fill();
    // 타임라인 수직선
    if (i < visibleEvts.length - 1) {
      ctx.strokeStyle = hex + '25';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ex + 6, ey + ROW_H / 2 + 3); ctx.lineTo(ex + 6, ey + ROW_H + GAP + ROW_H / 2 - 3); ctx.stroke();
    }

    // 이벤트 카드 배경
    ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0)';
    roundRect(ctx, ex + 16, ey, evtCardW - 16, ROW_H, 6); ctx.fill();

    // 아이콘 + 라벨
    ctx.textAlign = 'left';
    ctx.font = `500 12px -apple-system,sans-serif`;
    ctx.fillStyle = '#cdd9e5';
    ctx.fillText(`${icon}  ${label}`, ex + 22, ey + ROW_H * 0.62);

    // 시간
    ctx.textAlign = 'right';
    ctx.font = `400 10px -apple-system,sans-serif`;
    ctx.fillStyle = '#6e7681';
    ctx.fillText(ts, ex + evtCardW - 4, ey + ROW_H * 0.62);

    _hitAreas.push({
      cx: ex + evtCardW / 2, cy: ey + ROW_H / 2, r: evtCardW / 2,
      obj: planetObj,
      data: { type: 'session', intent: label, clusterId, sessionId: planetObj.userData?.sessionId,
              eventCount: events.length, hueHex: hex },
    });
  });

  curY += visibleEvts.length * (ROW_H + GAP);

  // ── 스크롤 힌트 ──────────────────────────────────────────────────────────
  if (recentEvts.length > 6) {
    ctx.font = `400 10px -apple-system,sans-serif`;
    ctx.fillStyle = '#6e7681';
    ctx.textAlign = 'center';
    ctx.fillText(
      `↕ 마우스 휠로 스크롤 (${scrollIdx + 1}~${scrollIdx + visibleEvts.length} / ${recentEvts.length})`,
      centerX, curY + 6
    );
    curY += 20;
  }

  // ── 파일 섹션 ────────────────────────────────────────────────────────────
  if (fileList.length > 0) {
    // 구분선
    ctx.strokeStyle = '#ffffff10';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(winX + PAD, curY + 4); ctx.lineTo(winX + WIN_W - PAD, curY + 4); ctx.stroke();
    curY += 12;

    ctx.textAlign = 'left';
    ctx.font = `600 11px -apple-system,sans-serif`;
    ctx.fillStyle = '#8b949e';
    ctx.fillText(`📁 관련 파일 (${fileList.length})`, winX + PAD, curY + 4);
    curY += 14;

    fileList.forEach(([fname, info], i) => {
      const fx = winX + PAD;
      const fy = curY + i * (FILE_ROW_H + GAP);
      const isWrite = info.writes > 0;

      // 파일 행 배경
      ctx.fillStyle = isWrite ? 'rgba(255,166,87,0.06)' : 'rgba(88,166,255,0.04)';
      roundRect(ctx, fx, fy, WIN_W - PAD * 2, FILE_ROW_H, 6); ctx.fill();

      // 파일명
      const shortName = fname.length > 30 ? fname.slice(0, 29) + '…' : fname;
      ctx.font = `500 11px -apple-system,sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = isWrite ? '#ffa657' : '#79c0ff';
      ctx.fillText(`${isWrite ? '✏️' : '📄'} ${shortName}`, fx + 10, fy + FILE_ROW_H * 0.62);

      // 횟수
      ctx.textAlign = 'right';
      ctx.font = `400 10px -apple-system,sans-serif`;
      ctx.fillStyle = '#6e7681';
      ctx.fillText(`${info.count}회`, fx + WIN_W - PAD * 2 - 8, fy + FILE_ROW_H * 0.62);

      _hitAreas.push({
        cx: fx + (WIN_W - PAD * 2) / 2, cy: fy + FILE_ROW_H / 2, r: (WIN_W - PAD * 2) / 2,
        obj: planetObj,
        data: { type: 'file', intent: fname, fileLabel: fname, filename: fname,
                count: info.count, isWrite },
      });
    });
  }

  ctx.restore();
}

function drawLabels() {
  _lctx.clearRect(0, 0, innerWidth, innerHeight);
  _hitAreas = [];
  _usedRects.length = 0; // 매 프레임 리셋

  const lod = getLOD();

  // ── 3단계 확장형 뷰 시스템 ────────────────────────────────────────────────
  // 1단계: 아무것도 선택 안 됨 → 3대 카테고리 고정 표시 (기능구현/조사분석/배포운영)
  // 2단계: 카테고리/프로젝트 포커스 → 해당 클러스터 펼침 + 브랜치 라인
  // 3단계: 특정 클러스터 선택 → 파일 위성 표시 + 상세 정보
  const isPersonalMode = !_teamMode && !_companyMode && !_parallelMode;
  const hasSelection   = !!_selectedHit;
  const focusedProj    = _focusedProject;
  const focusedCat     = _focusedCategory;
  const selectedProj   = _selectedHit?.obj?.userData?.projectName;
  const selectedCat    = _selectedHit?.obj?.userData?.macroCat;

  // 연결선 표시/숨김 — 개인 모드에서는 모든 연결선 숨김
  connections.forEach(c => {
    if (isPersonalMode) {
      c.visible = false;                                                     // 개인 모드: 연결선 전부 숨김
    } else if (c.userData.isBranch) {
      const pCat  = c.userData.planetObj?.userData?.macroCat;
      const proj  = c.userData.planetObj?.userData?.projectName;
      c.visible = !!(focusedCat && pCat === focusedCat)
               || !!(focusedProj && proj === focusedProj);
    } else if (c.userData.satObj) {
      const cid = c.userData.satObj?.userData?.clusterId;
      c.visible = !!(_selectedHit?.obj?.userData?.clusterId === cid);
    }
  });

  // 행성 위치 보간: 포커스된 프로젝트/카테고리가 있으면 확장 위치로 이동
  planetMeshes.forEach(p => {
    const inFocusedCat  = focusedCat && p.userData.macroCat === focusedCat;
    const inFocusedProj = focusedProj && p.userData.projectName === focusedProj;
    const inSelectedProj = selectedProj && p.userData.projectName === selectedProj;
    const targetExpanded = inFocusedCat || inFocusedProj || inSelectedProj;
    const target = targetExpanded ? p.userData._expandedPos : p.userData._compactPos;
    if (target) p.position.lerp(target, 0.08);
  });

  // 개인 모드: 프로젝트 노드 → 클릭 시 하위 세션 전개 (상세 패널 없음)
  if (isPersonalMode) {
    drawCompactProjectView();
    _lctx.globalAlpha = 1;
    return;
  }

  // 토픽 유사도 글로잉 연결선 (팀/회사 모드 전용)
  drawTopicLinks();

  // LOD 3: 요약 뷰, 라벨은 아주 희미하게만
  const globalAlpha = lod === 3 ? 0.12 : 1;
  _lctx.globalAlpha = globalAlpha;

  // ── 1. 행성 ──────────────────────────────────────────────────────────────
  // 2단계: 포커스된 카테고리/프로젝트의 행성만 표시, 나머지는 작은 점으로
  const activeProj = focusedProj || selectedProj;
  const activeCat  = focusedCat || selectedCat;

  planetMeshes.forEach(p => {
    const catMatch  = !activeCat  || p.userData.macroCat === activeCat;
    const projMatch = !activeProj || p.userData.projectName === activeProj;
    // 활성 카테고리/프로젝트 아닌 행성은 작은 점으로만 표시
    if ((activeCat && !catMatch) || (activeProj && !projMatch)) {
      const sc = toScreen(p.position);
      if (sc.z <= 1) {
        _lctx.save();
        _lctx.globalAlpha = 0.25;
        _lctx.fillStyle = p.userData.hueHex || '#58a6ff';
        _lctx.beginPath(); _lctx.arc(sc.x, sc.y, 3, 0, Math.PI*2); _lctx.fill();
        _lctx.restore();
      }
      return;
    }
    const sc = toScreen(p.position);
    if (sc.z > 1) return;

    const scale      = screenScale(p.position);
    const hex        = p.userData.hueHex || '#58a6ff';
    const evCnt      = p.userData.eventCount || 0;
    const isHovered  = _hoveredHit?.obj === p;
    const isSelected = _selectedHit?.obj === p;
    const glow       = glowIntensity(p.userData.clusterId);

    // ── 폰트 크기 — 선택 노드 기준 차등 ──────────────────────────────────
    const isFocused = _selectedHit?.obj === p;
    const isChildOfFocused = _selectedHit?.obj?.userData?.clusterId
      && p.userData.clusterId === _selectedHit.obj.userData.clusterId;

    let pxSize;
    if (isFocused) {
      pxSize = 22;
    } else if (isChildOfFocused) {
      pxSize = 16;
    } else {
      pxSize = Math.max(9, Math.min(14, scale * 12));
    }
    if (isSelected) pxSize *= 1.12;

    // ── 텍스트 — 사람이 이해할 수 있는 작업 설명 표시 ────────────────────
    let fullText = p.userData.intent || '';                   // 전체 의도 텍스트
    let text = '';                                            // 화면 표시용

    // 1순위: intent에서 실제 작업 설명 추출 (아이콘 제거 후 핵심만)
    if (fullText) {
      // 아이콘 이모지 제거 + 앞뒤 공백 정리
      text = fullText.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚙️🔐🌐🗄🎨🧪🚀🐳📝📐🔧🌿💬]\s*/gu, '').trim();
      // "[프로젝트명] 설명" 형태면 설명만 추출
      if (/^\[.+?\]\s+/.test(text)) text = text.replace(/^\[.+?\]\s+/, '');
      // 너무 길면 자름
      if (text.length > 24) text = text.slice(0, 23) + '…';
    }

    // 2순위: msgPreview (첫 사용자 메시지)
    if (!text && p.userData.msgPreview) {
      text = p.userData.msgPreview.slice(0, 24);
    }

    // 3순위: firstMsg
    if (!text && p.userData.firstMsg) {
      text = p.userData.firstMsg.slice(0, 24);
    }

    // 4순위: 프로젝트명
    const proj = p.userData.projectName;
    if (!text && proj && proj !== '기타') {
      text = proj.slice(0, 16);
    }

    // 최종 폴백: 도메인 라벨
    if (!text) {
      const DS = { auth:'인증 구현', api:'API 개발', data:'데이터', ui:'UI 작업',
        test:'테스트', server:'서버 개발', infra:'인프라', fix:'버그 수정',
        git:'Git 관리', chat:'AI 대화', general:'작업', docs:'문서화', design:'설계' };
      text = DS[p.userData.domain] || '작업';
    }
    if (!text) return;

    _lctx.font = `700 ${pxSize}px -apple-system,'Segoe UI',sans-serif`;
    _lctx.textAlign = 'center';

    const tw = _lctx.measureText(text).width;
    const pw = tw + 22;
    const ph = pxSize + 10;
    const lx = sc.x - pw / 2;
    const ly = sc.y - ph / 2;

    // ── 텍스트 겹침 방지 — 겹치면 바깥 방향으로 밀어내기 ───────────────
    let offX = 0, offY = 0;
    const ndx = sc.x - innerWidth / 2, ndy = sc.y - innerHeight / 2;
    const nDist = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
    const nudgeStepX = (ndx / nDist) * (ph * 0.6);
    const nudgeStepY = (ndy / nDist) * (ph * 0.6);
    for (let nudge = 0; nudge < 3; nudge++) {
      if (!rectOverlaps(lx + offX - 4, ly + offY - 4, pw + 8, ph + 30)) break;
      offX += nudgeStepX;
      offY += nudgeStepY;
    }
    if (rectOverlaps(lx + offX - 4, ly + offY - 4, pw + 8, ph + 30)) return;
    reserveRect(lx + offX - 4, ly + offY - 4, pw + 8, ph + 30);
    // 오프셋 적용
    sc.x += offX; sc.y += offY;
    const _lx = lx + offX, _ly = ly + offY;

    // ── 글로우 효과 (실시간 작업 중) ─────────────────────────────────────
    if (glow > 0) {
      _lctx.globalAlpha = globalAlpha;
      drawGlow(_lctx, sc.x, sc.y, Math.max(pw, ph) / 2, hex, glow);
      // 테두리 펄스
      _lctx.save();
      _lctx.globalAlpha = globalAlpha * (0.4 + glow * 0.6);
      _lctx.strokeStyle = hex;
      _lctx.lineWidth   = 2 + glow * 3;
      _lctx.shadowColor = hex;
      _lctx.shadowBlur  = 12 * glow;
      roundRect(_lctx, _lx - 2, _ly - 2, pw + 4, ph + 4, (ph + 4) / 2);
      _lctx.stroke();
      _lctx.restore();
    }

    _lctx.globalAlpha = globalAlpha;

    // ── 선택 글로우 효과 (강한 시각적 피드백) ─────────────────────────────
    if (isSelected) {
      _lctx.save();
      const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 300);
      _lctx.shadowColor = hex;
      _lctx.shadowBlur  = 16 + pulse * 8;
      _lctx.strokeStyle = hex;
      _lctx.lineWidth   = 3;
      _lctx.globalAlpha = globalAlpha * (0.7 + pulse * 0.3);
      roundRect(_lctx, _lx - 3, _ly - 3, pw + 6, ph + 6, (ph + 6) / 2);
      _lctx.stroke();
      _lctx.shadowBlur = 0;
      _lctx.restore();
      _lctx.globalAlpha = globalAlpha;
    }

    // ── 중요 항목 주목 이펙트 (attention) ──────────────────────────────────
    const isImportant = p.userData._attention > 0;
    if (isImportant) {
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
      _lctx.save();
      _lctx.shadowColor = '#ffd700';
      _lctx.shadowBlur = 20 + pulse * 15;
      _lctx.strokeStyle = '#ffd700';
      _lctx.lineWidth = 3 + pulse * 2;
      roundRect(_lctx, _lx - 4, _ly - 4, pw + 8, ph + 8, (ph + 8) / 2);
      _lctx.stroke();
      _lctx.restore();
      // "!" 배지
      _lctx.save();
      _lctx.font = 'bold 12px sans-serif';
      _lctx.fillStyle = '#ffd700';
      _lctx.textAlign = 'left';
      _lctx.fillText('!', _lx + pw + 6, _ly + 10);
      _lctx.restore();
      _lctx.textAlign = 'center';
    }

    // ── 배경 pill ────────────────────────────────────────────────────────
    const bgAlpha = isSelected ? 0.97 : isHovered ? 0.93 : 0.78;
    _lctx.fillStyle = isSelected ? `rgba(31,111,235,0.15)` : `rgba(6,10,16,${bgAlpha})`;
    roundRect(_lctx, _lx, _ly, pw, ph, ph / 2);
    _lctx.fill();

    // 3D 와이어프레임 그리드
    drawWireframeGrid(_lctx, _lx, _ly, pw, ph, ph / 2, hex, isSelected ? 0.30 : isHovered ? 0.24 : 0.18);

    // ── 테두리 ────────────────────────────────────────────────────────────
    _lctx.strokeStyle = isSelected ? '#58a6ff' : hex;
    _lctx.lineWidth   = isSelected ? 2.5 : isHovered ? 2 : glow > 0.1 ? 1.8 : 1;
    roundRect(_lctx, _lx, _ly, pw, ph, ph / 2);
    _lctx.stroke();

    // ── 텍스트 ────────────────────────────────────────────────────────────
    _lctx.fillStyle = isSelected ? '#ffffff' : isHovered ? '#f0f6fc' : '#cdd9e5';
    _lctx.fillText(text, sc.x, _ly + ph * 0.68);

    // ── 즐겨찾기 ★ 표시 ──────────────────────────────────────────────────
    const nodeId = p.userData?.clusterId || p.userData?.sessionId || p.userData?.eventId || '';
    if (nodeId && typeof _bookmarksCache !== 'undefined' && _bookmarksCache.some(b => b.event_id === nodeId)) {
      const starSize = Math.max(10, pxSize * 0.7);
      _lctx.save();
      _lctx.font = `${starSize}px sans-serif`;
      _lctx.fillStyle = '#ffd700';
      _lctx.textAlign = 'left';
      _lctx.fillText('★', _lx + pw + 3, _ly + ph * 0.72);
      _lctx.restore();
      _lctx.textAlign = 'center';
    }

    // ── 서브 정보 — 이벤트 수 (줌인 시만) ──────────────────────────────────
    if (evCnt > 0 && pxSize >= 13) {
      const sub = Math.max(9, pxSize * 0.5);
      _lctx.font = `500 ${sub}px -apple-system,sans-serif`;
      const tagY = _ly + ph + sub + 1;
      _lctx.fillStyle = hex + '88';
      _lctx.fillText(`${evCnt}개 작업`, sc.x, tagY);
    }

    // 히트 영역
    _hitAreas.push({
      cx: sc.x, cy: sc.y,
      r:  Math.max(pw, ph) / 2 + 4,
      obj: p,
      data: {
        type: 'session', intent: fullText,
        clusterId:  p.userData.clusterId,
        sessionId:  p.userData.sessionId,
        eventCount: evCnt, hueHex: hex,
      },
    });
  });

  // ── 2. 파일 위성 (팀/회사 모드 전용, 개인 모드는 위에서 return) ─────────
  const selectedCluster = _selectedHit?.obj?.userData?.clusterId;
  if (!selectedCluster) { _lctx.globalAlpha = 1; return; }

  satelliteMeshes.forEach(s => {
    // 선택된 클러스터의 위성만 표시
    if (s.userData.clusterId !== selectedCluster) return;
    const sc = toScreen(s.position);
    if (sc.z > 1) return;

    const scale      = screenScale(s.position);
    const label      = s.userData.fileLabel || '';
    if (!label) return;

    const isHovered  = _hoveredHit?.obj === s;
    const isWrite    = s.userData.isWrite;
    // 부모 행성 색 사용 (없으면 기존 isWrite 기반 fallback)
    const pHex = s.userData.planetHex || (isWrite ? '#ffa657' : '#58a6ff');
    const pR   = parseInt(pHex.slice(1,3),16);
    const pG   = parseInt(pHex.slice(3,5),16);
    const pB   = parseInt(pHex.slice(5,7),16);

    // LOD0: 크게, LOD1: 작게
    const pxSize = lod === 0
      ? Math.max(11, Math.min(17, scale * 13))
      : Math.max(9,  Math.min(13, scale * 9));

    _lctx.font = `500 ${pxSize}px -apple-system,sans-serif`;
    _lctx.textAlign = 'center';

    const tw = _lctx.measureText(label).width;
    const pw = tw + (lod === 0 ? 16 : 12);
    const ph = pxSize + (lod === 0 ? 8 : 6);
    const lx = sc.x - pw / 2;
    const ly = sc.y - ph / 2;

    // (Canvas2D 위성↔행성 연결선 제거 — 깔끔한 화면 유지)

    const bgA   = isHovered ? 0.28 : lod === 0 ? 0.16 : 0.10;
    _lctx.fillStyle = `rgba(${pR},${pG},${pB},${bgA})`;
    roundRect(_lctx, lx, ly, pw, ph, ph / 2);
    _lctx.fill();

    _lctx.strokeStyle = pHex;
    _lctx.lineWidth   = isHovered ? 1.4 : lod === 0 ? 1.0 : 0.7;
    roundRect(_lctx, lx, ly, pw, ph, ph / 2);
    _lctx.stroke();

    _lctx.fillStyle = pHex;
    _lctx.fillText(label, sc.x, ly + ph * 0.70);

    // 히트 영역
    _hitAreas.push({
      cx: sc.x, cy: sc.y,
      r:  Math.max(pw, ph) / 2 + 3,
      obj: s,
      data: {
        type: 'file', intent: label,
        fileLabel: label,
        filename:  s.userData.filename,
        count:     s.userData.count,
        isWrite:   s.userData.isWrite,
        sessionId: s.userData.sessionId,
      },
    });
  });
}

// ─── 기능 목록 (실제 구현된 것만) ────────────────────────────────────────────
const ORBIT_FEATURES = [
  { icon:'🌌', name:'작업 우주',   color:'#58a6ff', desc:'3D 공간에 목적별 클러스터를 행성으로 시각화', badge:'지금 여기', action:null },
  { icon:'📊', name:'통계',        color:'#3fb950', desc:'실시간 이벤트 스트림 및 작업 통계',           badge:'실시간',  action:()=>{ toggleFeatPanel(); openStatsPopup(); } },
  { icon:'👥', name:'워크스페이스', color:'#58a6ff', desc:'팀원 초대·참여·팀뷰 연동',                 badge:'팀',      action:()=>{ toggleFeatPanel(); openWorkspacePopup(); } },
  { icon:'💬', name:'팀 채팅',     color:'#3fb950', desc:'팀 채널 + 1:1 DM + @orbit AI 어시스턴트', badge:'채팅',    action:()=>{ toggleFeatPanel(); toggleMessenger(); } },
  { icon:'🕐', name:'타임라인',    color:'#ffa657', desc:'세션 이벤트를 시간 흐름으로 탐색',           badge:'뷰어',    action:()=>{ toggleFeatPanel(); window.open('/orbit-timeline.html','_blank'); } },
  { icon:'🛒', name:'MCP 마켓',   color:'#39d2c0', desc:'MCP 서버 검색·설치·관리',                  badge:'마켓',    action:()=>{ toggleFeatPanel(); window.open('/mcp-market.html','_blank'); } },
  { icon:'💡', name:'AI 추천',     color:'#ffd700', desc:'업무 패턴 분석 → 자동화·템플릿 제안',        badge:'AI',      action:()=>{ toggleFeatPanel(); toggleSuggestionPanel(); } },
  { icon:'⚡', name:'AI 인사이트', color:'#d2a8ff', desc:'실시간 피드·목적 분석·통계 대시보드',        badge:'인사이트', action:()=>{ toggleFeatPanel(); toggleInsightPanel(); } },
  { icon:'👥', name:'팀 시뮬',     color:'#f78166', desc:'실제 팀원 데이터로 3D 팀 우주 탐색',         badge:'팀뷰',    action:()=>{ toggleFeatPanel(); loadTeamDemo(); } },
  { icon:'🏢', name:'전사 뷰',     color:'#bc8cff', desc:'회사 전체 AI 작업 현황 한눈에',             badge:'전사',    action:()=>{ toggleFeatPanel(); loadCompanyDemo(); } },
  { icon:'⚙️', name:'설정/설치',  color:'#8b949e', desc:'Claude 훅 등록·원키 설치·AI 모델 설정',      badge:'설정',    action:()=>{ toggleFeatPanel(); openSetupPanel(); } },
  { icon:'📖', name:'가이드',      color:'#79c0ff', desc:'3분 안에 시작하는 Orbit AI 빠른 가이드',      badge:'튜토리얼', action:()=>{ toggleFeatPanel(); openGuidePopup(); } },
  { icon:'✨', name:'이펙트 마켓', color:'#ffa657', desc:'행성 VFX 이펙트 구매·적용',                badge:'마켓',    action:()=>{ toggleFeatPanel(); toggleEffectsPanel(); } },
  { icon:'🌍', name:'스킨 마켓',   color:'#3fb950', desc:'행성 스킨·테마 변경',                      badge:'스킨',    action:()=>{ toggleFeatPanel(); toggleCoreSkinPanel(); } },
  { icon:'📡', name:'인재 마켓',   color:'#f0883e', desc:'팀원 프로필·스킬 탐색',                    badge:'인재',    action:()=>{ toggleFeatPanel(); toggleTalentBoard(); } },
  { icon:'📋', name:'할 일',       color:'#6e7681', desc:'팀/개인 작업 목록 관리',                   badge:'할 일',   action:()=>{ toggleFeatPanel(); toggleTaskSidebar(); } },
  { icon:'🤖', name:'AI 모델',     color:'#58a6ff', desc:'Ollama 로컬 모델·API 키 설정',             badge:'LLM',     action:()=>{ toggleFeatPanel(); openLlmPanel(); } },
  { icon:'📈', name:'성장 엔진',   color:'#79c0ff', desc:'작업 스트릭·레벨업·뱃지 시스템',            badge:'XP',      action:()=>{ toggleFeatPanel(); toggleGrowthPanel(); } },
  { icon:'📹', name:'AI 모니터',  color:'#bc8cff', desc:'멀티 AI 에이전트 실시간 모니터링',           badge:'관제',    action:()=>{ toggleFeatPanel(); toggleMonitor(); } },
];

function buildFeatCards() {
  const container = document.getElementById('feat-cards');
  container.innerHTML = '';
  ORBIT_FEATURES.forEach(f => {
    const card = document.createElement('div');
    card.className = 'feat-card';
    card.style.setProperty('--fc', f.color);
    if (f.action) {
      card.style.cursor = 'pointer';
      card.onclick = f.action;
    }
    card.innerHTML = `
      <div class="fc-icon">${f.icon}</div>
      <div class="fc-name">${f.name}</div>
      <div class="fc-desc">${f.desc}</div>
      <div class="fc-badge">${f.action ? '▶ ' : ''}${f.badge}</div>
    `;
    container.appendChild(card);
  });
}

function showFeaturePreview(f) {
  // 인포 패널에 기능 상세 표시
  const panel = document.getElementById('info-panel');
  document.getElementById('ip-dot').style.background  = f.color;
  document.getElementById('ip-type-text').textContent  = f.badge;
  document.getElementById('ip-intent').textContent     = `${f.icon} ${f.name}`;
  document.getElementById('ip-label-time').textContent    = '설명';
  document.getElementById('ip-label-session').textContent = '상태';
  document.getElementById('ip-label-ai').textContent      = '경로';
  document.getElementById('ip-time').textContent    = f.desc;
  document.getElementById('ip-session').textContent = '구현 완료';
  document.getElementById('ip-ai').textContent      = f.url ? f.url : '/api/*';
  document.getElementById('ip-preview-wrap').style.display = 'none';
  panel.classList.add('open');
}

function toggleFeatPanel() {
  const panel = document.getElementById('feat-panel');
  const btn   = document.getElementById('feat-btn');
  const isOpen = panel.classList.toggle('open');
  btn.classList.toggle('open', isOpen);
  btn.textContent = isOpen ? '✕ 닫기' : '⚡ 기능 목록';
  if (isOpen && typeof track === 'function') track('view.panel_open', { panel: 'feat' });
  if (isOpen) buildFeatCards();
}
window.toggleFeatPanel = toggleFeatPanel;

// ─── 줌아웃 요약 ─────────────────────────────────────────────────────────────
// 카메라가 멀어지면 행성 대신 "지금 뭐하고 있냐" 요약 오버레이 표시
let _zoomSummaryVisible = false;
const ZOOM_OUT_THRESHOLD = 180; // 이 거리 이상이면 요약 뷰

// signal-engine 상태 캐시 (주기적으로 fetch)
let _signalStates = {};
async function refreshSignalStates() {
  try {
    const res = await fetch('/api/signal');
    if (res.ok) _signalStates = await res.json();
  } catch {}
}
setInterval(refreshSignalStates, 5000);
refreshSignalStates();

// 상태 → 이모지 매핑
const STATE_EMOJI = {
  FOCUSED:    { emoji: '🎯', color: '#3fb950', label: '집중' },
  BLOCKED:    { emoji: '🚧', color: '#f0883e', label: '막힘' },
  CRISIS:     { emoji: '🔥', color: '#f85149', label: '위기' },
  IDLE:       { emoji: '💤', color: '#6e7681', label: '대기' },
  PRODUCTIVE: { emoji: '⚡', color: '#58a6ff', label: '생산적' },
};

function updateZoomSummary() {
  const dist = controls.sph.r;
  const el   = document.getElementById('zoom-summary');
  const shouldShow = dist >= ZOOM_OUT_THRESHOLD;

  // 줌아웃 중이면 매 프레임 업데이트 (칩 갱신)
  if (!shouldShow) {
    if (_zoomSummaryVisible) {
      el.classList.remove('visible');
      _zoomSummaryVisible = false;
    }
    return;
  }
  _zoomSummaryVisible = true;

  // 활성 클러스터 집계
  const activeClusters = planetMeshes
    .map(p => p.userData)
    .filter(u => u.isPlanet && u.intent)
    .sort((a, b) => b.eventCount - a.eventCount);

  if (activeClusters.length === 0) return;

  // 칩 생성 (상위 10개) — signal-engine 상태 배지 포함
  const chipsEl = document.getElementById('zs-chips');
  chipsEl.innerHTML = activeClusters.slice(0, 10).map(u => {
    const hex        = u.hueHex || '#58a6ff';
    const shortLabel = u.intent.length > 28 ? u.intent.slice(0, 26) + '…' : u.intent;
    const glow       = glowIntensity(u.clusterId);

    // signal-engine 상태 (sessionId 기준으로 매핑)
    const sigData   = _signalStates[u.sessionId || u.clusterId];
    const sigState  = sigData?.state || 'IDLE';
    const sigInfo   = STATE_EMOJI[sigState] || STATE_EMOJI.IDLE;
    const stateBadge = `<span style="font-size:11px;opacity:0.85">${sigInfo.emoji}</span>`;

    // 활성 글로우 강조
    const boxShadow = glow > 0.1
      ? `box-shadow:0 0 ${Math.round(8 + glow * 12)}px ${hex}${Math.round(glow * 160).toString(16).padStart(2,'0')}`
      : '';

    return `<div class="zs-chip" style="border-color:${hex};color:${hex};${boxShadow}" title="${sigInfo.label}">
      ${stateBadge} ${shortLabel}
      <span style="font-size:10px;color:#6e7681;margin-left:4px">${u.eventCount}</span>
    </div>`;
  }).join('');

  // 서브 요약 — 상태별 집계
  const totalEvents = activeClusters.reduce((s, u) => s + u.eventCount, 0);
  const stateGroups = {};
  for (const [, sig] of Object.entries(_signalStates)) {
    const s = sig.state || 'IDLE';
    stateGroups[s] = (stateGroups[s] || 0) + 1;
  }
  const stateSummary = Object.entries(stateGroups)
    .filter(([,c]) => c > 0)
    .map(([s,c]) => `${STATE_EMOJI[s]?.emoji || '●'} ${c}`)
    .join('  ');

  document.getElementById('zs-sub').textContent =
    `${activeClusters.length}개 작업 • ${totalEvents}개 이벤트${stateSummary ? ' • ' + stateSummary : ''}`;

  el.classList.add('visible');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ⬡ 학습 모드 위젯 — Web Speech API 음성 인식
// ═══════════════════════════════════════════════════════════════════════════════
(function initLearningModeWidget() {
  let _recognition = null;
  let _isListening = false;
  let _textBuffer = '';
  let _startTime = 0;
  let _timerInterval = null;
  let _retryCount = 0;
  const MAX_RETRIES = 3;
  const SEND_INTERVAL = 30000; // 30초마다 전송
  let _sendInterval = null;

  // 위젯 버튼 생성
  const btn = document.createElement('button');
  btn.id = 'learning-mode-btn';
  btn.style.cssText = `
    position:fixed; bottom:20px; left:20px; z-index:95;
    background:rgba(13,17,23,0.92); border:1px solid #30363d;
    border-radius:10px; padding:8px 14px;
    font-family:-apple-system,'Segoe UI',sans-serif;
    font-size:12px; color:#8b949e;
    backdrop-filter:blur(12px);
    cursor:pointer; user-select:none;
    transition:all .3s ease;
    display:flex; align-items:center; gap:6px;
  `;
  btn.innerHTML = '<span style="font-size:14px">🎧</span><span id="lm-label">학습 모드</span>';
  document.body.appendChild(btn);

  btn.addEventListener('click', () => {
    if (_isListening) stopListening();
    else startListening();
  });

  function startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.');
      return;
    }
    _recognition = new SpeechRecognition();
    _recognition.continuous = true;
    _recognition.interimResults = false;
    _recognition.lang = 'ko-KR';

    _recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          _textBuffer += event.results[i][0].transcript + ' ';
        }
      }
    };

    _recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        stopListening();
        return;
      }
      if (_retryCount < MAX_RETRIES && _isListening) {
        _retryCount++;
        try { _recognition.start(); } catch {}
      } else {
        stopListening();
      }
    };

    _recognition.onend = () => {
      if (_isListening && _retryCount < MAX_RETRIES) {
        _retryCount++;
        try { _recognition.start(); } catch {}
      }
    };

    _isListening = true;
    _startTime = Date.now();
    _retryCount = 0;
    _textBuffer = '';
    try { _recognition.start(); } catch {}

    // UI 업데이트
    btn.style.borderColor = '#3fb950';
    btn.style.background = 'rgba(63,185,80,0.12)';
    _timerInterval = setInterval(updateTimer, 1000);
    updateTimer();

    // 30초마다 전송
    _sendInterval = setInterval(sendBuffer, SEND_INTERVAL);
  }

  function stopListening() {
    _isListening = false;
    if (_recognition) {
      try { _recognition.stop(); } catch {}
      _recognition = null;
    }
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    if (_sendInterval) { clearInterval(_sendInterval); _sendInterval = null; }

    // 남은 버퍼 전송
    sendBuffer();

    // UI 복원
    btn.style.borderColor = '#30363d';
    btn.style.background = 'rgba(13,17,23,0.92)';
    document.getElementById('lm-label').textContent = '학습 모드';
  }

  function updateTimer() {
    const elapsed = Math.floor((Date.now() - _startTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    document.getElementById('lm-label').textContent = `학습 중... ${mm}:${ss}`;
  }

  function sendBuffer() {
    const text = _textBuffer.trim();
    if (!text || text.length < 5) return;
    _textBuffer = '';

    const duration = Math.floor((Date.now() - _startTime) / 1000);
    fetch('/api/personal/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        source: 'speech',
        lang: 'ko-KR',
        duration,
      }),
    }).catch(() => {});
  }
})();

// ─── 데이터 로드 ──────────────────────────────────────────────────────────────
// 현재 로그인 토큰 반환 헬퍼 (fetch 인증 헤더용)

// ══════════════════════════════════════════════════════════════════════════════
// MY CREATIVE CORE — 개인 뷰 기술스택/핵심 도구 노드 링
// ══════════════════════════════════════════════════════════════════════════════

// 기본 스킬 세트 (사용자 데이터가 없을 때 표시)
const _defaultCoreSkills = [
  { id: 'sk-claude',  label: 'Claude AI',   icon: '🤖', color: '#00c8ff', type: 'ai'     },
  { id: 'sk-code',    label: 'Coding',       icon: '💻', color: '#a855f7', type: 'tool'   },
  { id: 'sk-design',  label: 'Design',       icon: '🎨', color: '#00ff88', type: 'skill'  },
  { id: 'sk-data',    label: 'Data',         icon: '📊', color: '#ffd700', type: 'skill'  },
  { id: 'sk-collab',  label: 'Collab',       icon: '🤝', color: '#ff6b35', type: 'social' },
  { id: 'sk-deploy',  label: 'Deploy',       icon: '🚀', color: '#39d2c0', type: 'tool'   },
];

// 사용자 이벤트 데이터로부터 스킬 노드 추출
function deriveSkillsFromEvents(events) {
  const toolCounts = {};
  const typeCounts = {};
  for (const ev of events || []) {
    const tool = ev.data?.tool || ev.data?.toolName;
    if (tool) toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    if (ev.type) typeCounts[ev.type] = (typeCounts[ev.type] || 0) + 1;
  }
  const skills = [];
  if ((typeCounts['assistant.message'] || 0) + (typeCounts['user.message'] || 0) > 5) {
    skills.push({ id: 'sk-ai', label: 'AI 협업', icon: '🤖', color: '#00c8ff', type: 'ai' });
  }
  if ((typeCounts['file.write'] || 0) + (typeCounts['file.create'] || 0) > 3) {
    skills.push({ id: 'sk-code', label: '코딩', icon: '💻', color: '#a855f7', type: 'tool' });
  }
  if ((typeCounts['git.commit'] || 0) > 1) {
    skills.push({ id: 'sk-git', label: 'Git', icon: '🌿', color: '#3fb950', type: 'tool' });
  }
  if ((typeCounts['browse'] || 0) + (typeCounts['browser_activity'] || 0) > 3) {
    skills.push({ id: 'sk-web', label: '웹 리서치', icon: '🌐', color: '#58a6ff', type: 'skill' });
  }
  return skills.length >= 3 ? skills : _defaultCoreSkills;
}

// MY CREATIVE CORE 링 빌드 (Three.js 메시)
let _coreSkillMeshes = [];
let _coreSkillData   = [];

function buildCoreSkillRing(skills) {
  // 기존 스킬 메시 제거
  _coreSkillMeshes.forEach(m => scene.remove(m));
  _coreSkillMeshes = [];
  _coreSkillData   = [];

  const RING_R = 18;   // 중심으로부터 반지름
  const N      = skills.length;

  skills.forEach((sk, i) => {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle) * RING_R;
    const z = Math.sin(angle) * RING_R;

    const color   = new THREE.Color(sk.color);
    const geo     = new THREE.OctahedronGeometry(1.4, 0);
    const mat     = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.6,
      transparent: true, opacity: 0.9,
      roughness: 0.2, metalness: 0.7,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0, z);
    mesh.rotation.y = angle;
    mesh.userData = { type: 'coreSkill', skill: sk, baseY: 0, angle };
    scene.add(mesh);
    _coreSkillMeshes.push(mesh);

    // 링 연결선 (중심 → 스킬)
    const linePts = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(x, 0, z)];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 });
    const line    = new THREE.Line(lineGeo, lineMat);
    scene.add(line);
    _coreSkillMeshes.push(line);

    _coreSkillData.push({ mesh, x, z, color: sk.color, label: sk.label, icon: sk.icon, angle });
  });
}

// 애니메이션 루프에서 스킬 노드 부유 효과 적용 (orbit3d-loop에서 호출)
function animateCoreSkills(elapsed) {
  _coreSkillData.forEach((sk, i) => {
    if (!sk.mesh || sk.mesh.type === 'Line') return;
    sk.mesh.position.y = Math.sin(elapsed * 0.8 + i * 1.1) * 0.5;
    sk.mesh.rotation.y += 0.008;
    // 활성 노드는 에미시브 강도 펄스
    const pulseMat = sk.mesh.material;
    if (pulseMat) {
      pulseMat.emissiveIntensity = 0.4 + 0.3 * Math.sin(elapsed * 1.5 + i * 0.7);
    }
  });
}
window.animateCoreSkills   = animateCoreSkills;
window.buildCoreSkillRing  = buildCoreSkillRing;
window.deriveSkillsFromEvents = deriveSkillsFromEvents;
window._coreSkillData      = _coreSkillData;
window._coreSkillMeshes    = _coreSkillMeshes;
