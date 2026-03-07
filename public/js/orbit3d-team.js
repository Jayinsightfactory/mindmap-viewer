// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Team/Company simulation, market effects, demo data
// ══════════════════════════════════════════════════════════════════════════════
// ─── 팀 시뮬레이션 모드 ───────────────────────────────────────────────────────
// 핵심 레이아웃 원칙:
//   🌟 중심 (0,0,0)   = 팀 목표 (가장 크게)
//   🪐 오각형 링 R=40 = 팀원 행성 (72° 균등 배치)
//   🔵 내위성 R=16    = 개인 작업 (행성 주위 공전)
//   🔹 툴 라벨 R=8    = 사용 툴 (행성 가까이 고정)

let _teamMode  = false;
const _VIEW_MODE_KEY = 'orbitViewMode'; // 뷰 모드 저장 키
let _teamNodes = [];  // { type, pos, label, sublabel, color, size, emoji, progress, memberId, taskStatus, obj }
let _focusedMember = null;  // 현재 포커스된 팀원 노드
let _cameraLerp    = null;  // { startR, endR, startTx/y/z, endTx/y/z, startPhi, endPhi, duration, elapsed }
let _companyMode   = false;  // 회사 시뮬레이션 모드
let _activeSimData = null;   // 현재 활성 시뮬 데이터 (TEAM_DEMO or COMPANY_DEMO)
let _collabLines   = [];     // [{ line, mat, phase, fromNode, toNode }] — 협업 연결선
let _myMemberId    = localStorage.getItem('orbitMyMemberId') || null;  // 내 멤버 ID
let _parallelMode  = false;   // Claude 병렬 태스크 3D 뷰 모드
let _parallelDemoTimers = []; // 타이머 누수 방지용

// ─── 팀 거리 설정값 ──────────────────────────────────────────────────────────
const TEAM_CFG = { MEMBER_R: 40, TASK_R: 16, TOOL_R: 9 };

// ─── 병렬 태스크 데모 데이터 ──────────────────────────────────────────────────
const PARALLEL_DEMO = {
  request: { id:'req', label:'🧠 코드 리팩토링 요청', sublabel:'Claude에게 요청', color:'#ffd700' },
  batches: [
    {
      id: 'batch1', yLevel: 0,
      tasks: [
        { id:'t1', label:'📂 파일 구조 분석', sublabel:'Glob + Read', color:'#58a6ff', status:'pending', agentType:'Explore' },
        { id:'t2', label:'🔍 의존성 검색',    sublabel:'Grep 병렬',  color:'#bc8cff', status:'pending', agentType:'Bash' },
        { id:'t3', label:'🌐 문서 조회',       sublabel:'WebFetch',  color:'#39d2c0', status:'pending', agentType:'WebFetch' },
      ]
    },
    {
      id: 'batch2', yLevel: -16,
      tasks: [
        { id:'t4', label:'✏️ 코드 수정',  sublabel:'Edit × 3파일', color:'#3fb950', status:'pending', agentType:'Edit' },
        { id:'t5', label:'🧪 테스트 실행', sublabel:'Bash → Jest', color:'#f0883e', status:'pending', agentType:'Bash' },
      ]
    }
  ],
  result: { id:'result', label:'✅ 리팩토링 완료', sublabel:'3파일 수정 · 테스트 통과', color:'#3fb950' }
};

// ─── 마켓 이펙트 프리셋 ──────────────────────────────────────────────────────
const MARKET_EFFECTS = [
  { id: 'neon',   name: '네온 글로우',   icon: '💡', color: '#58a6ff', desc: '밝게 빛나는 네온 다중 테두리' },
  { id: 'matrix', name: '매트릭스',      icon: '🟩', color: '#3fb950', desc: '초록 코드 문자가 떨어지는 효과' },
  { id: 'dna',    name: 'DNA 헬릭스',    icon: '🧬', color: '#bc8cff', desc: '이중 나선이 회전하며 감싸는 효과' },
  { id: 'beam',   name: '에너지 빔',     icon: '⚡', color: '#ffd700', desc: '중심을 향한 빛의 줄기 효과' },
  { id: 'holo',   name: '홀로그램',      icon: '🔷', color: '#39d2c0', desc: '스캔 라인이 훑어 내리는 효과' },
  { id: 'burst',  name: '파티클 버스트', icon: '✨', color: '#f0883e', desc: '방사형 입자 폭발 효과' },
];
const _nodeEffects = {};  // nodeLabel → effectId (노드별 선택 이펙트)

// 마켓 이펙트 드로잉 함수
function drawEffect_neon(ctx, cx, cy, r, color, now) {
  for (let i = 3; i >= 0; i--) {
    const pulse = (Math.sin(now * 2.8 + i * 0.7) + 1) * 0.5;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 3 - i * 0.5;
    ctx.shadowColor = color;
    ctx.shadowBlur  = 12 + i * 8 + pulse * 10;
    ctx.globalAlpha = 0.55 + pulse * 0.35;
    ctx.beginPath(); ctx.arc(cx, cy, r + 6 + i * 7, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}
function drawEffect_matrix(ctx, cx, cy, r, color, now) {
  const chars = '01ABアイウエオ#$%';
  ctx.save();
  ctx.font = '600 10px monospace';
  ctx.textAlign = 'center';
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const fall  = ((now * 40 + i * 30) % (r * 2.5));
    const bx    = cx + Math.cos(angle) * (r + 8);
    const by    = cy + Math.sin(angle) * (r + 8) + fall * 0.5 - r * 0.3;
    ctx.globalAlpha = Math.max(0, 1 - fall / (r * 2.5));
    ctx.fillStyle   = color;
    ctx.shadowColor = color; ctx.shadowBlur = 4;
    ctx.fillText(chars[Math.floor(now * 8 + i) % chars.length], bx, by);
  }
  ctx.restore();
}
function drawEffect_dna(ctx, cx, cy, r, color, now) {
  ctx.save();
  for (let strand = 0; strand < 2; strand++) {
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t  = (i / 24) * Math.PI * 2;
      const rr = r + 8;
      const ox = cx + Math.cos(t + now * 1.2 + strand * Math.PI) * rr;
      const oy = cy + Math.sin(t * 2) * (rr * 0.4) + Math.sin(t + now * 1.2) * (rr * 0.35);
      i === 0 ? ctx.moveTo(ox, oy) : ctx.lineTo(ox, oy);
    }
    ctx.strokeStyle = strand === 0 ? color : color + 'aa';
    ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.stroke();
  }
  for (let i = 0; i < 6; i++) {
    const t  = (i / 6) * Math.PI * 2 + now * 1.2;
    const x1 = cx + Math.cos(t) * (r + 8);
    const x2 = cx + Math.cos(t + Math.PI) * (r + 8);
    const y  = cy + Math.sin(t * 2) * (r * 0.35);
    ctx.globalAlpha = 0.5; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  }
  ctx.restore();
}
function drawEffect_beam(ctx, cx, cy, r, color, now) {
  ctx.save();
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + now * 0.8;
    const blen  = r + 30 + Math.sin(now * 3 + i) * 12;
    const ex    = cx + Math.cos(angle) * blen;
    const ey    = cy + Math.sin(angle) * blen;
    const g     = ctx.createLinearGradient(cx, cy, ex, ey);
    g.addColorStop(0, color + 'cc'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.strokeStyle = g; ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.7 + Math.sin(now * 2.5 + i) * 0.2;
    ctx.shadowColor = color; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
  }
  ctx.restore();
}
function drawEffect_holo(ctx, cx, cy, r, color, now) {
  ctx.save();
  ctx.strokeStyle = color + '50'; ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    ctx.globalAlpha = 0.35 - i * 0.08;
    ctx.beginPath(); ctx.arc(cx, cy, r + 10 + i * 10, 0, Math.PI * 2); ctx.stroke();
  }
  const scanY = cy - r - 10 + ((now * 45) % ((r + 20) * 2));
  const g = ctx.createLinearGradient(cx, scanY - 12, cx, scanY + 4);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.6, color + '40');
  g.addColorStop(1, color + 'aa');
  ctx.fillStyle = g; ctx.globalAlpha = 0.7;
  ctx.fillRect(cx - r - 10, scanY - 12, (r + 10) * 2, 16);
  ctx.restore();
}
function drawEffect_burst(ctx, cx, cy, r, color, now) {
  ctx.save();
  for (let i = 0; i < 12; i++) {
    const baseAngle = (i / 12) * Math.PI * 2;
    const phase     = (now * 1.8 + i * 0.5) % 1;
    const dist      = r + 10 + phase * 36;
    const alpha     = (1 - phase) * 0.85;
    const sz        = 3 - phase * 2;
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = color; ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(baseAngle) * dist, cy + Math.sin(baseAngle) * dist, sz, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}
const EFFECT_FNS = { neon: drawEffect_neon, matrix: drawEffect_matrix, dna: drawEffect_dna, beam: drawEffect_beam, holo: drawEffect_holo, burst: drawEffect_burst };

let _nodeDensity  = 1;  // 1=멤버만 2=+태스크 3=+스킬/에이전트 4=모두
let _distDebounce = null;

function updateDist(key, input) {
  TEAM_CFG[key] = parseInt(input.value);
  const valMap = { MEMBER_R: 'v-member-r', TASK_R: 'v-task-r', TOOL_R: 'v-tool-r' };
  document.getElementById(valMap[key]).textContent = input.value;
  // 실시간 적용 (250ms 디바운스)
  clearTimeout(_distDebounce);
  _distDebounce = setTimeout(applyTeamCfg, 250);
}

function updateNodeLevel(input) {
  _nodeDensity = parseInt(input.value);
  const labels = ['멤버만', '멤버 + 태스크', '+ 스킬 / 에이전트', '모두 표시'];
  const hints  = [
    '팀원 + 목표만 표시',
    '태스크(작업) 추가 표시',
    '스킬 · 에이전트까지 표시',
    '툴 포함 모든 노드 표시',
  ];
  document.getElementById('v-node-level').textContent   = labels[_nodeDensity - 1];
  document.getElementById('node-level-hint').textContent = hints[_nodeDensity - 1];
}

function applyTeamCfg() {
  if (_companyMode && _activeSimData) buildCompanySystem(_activeSimData);
  else if (_teamMode && _activeSimData) buildTeamSystem(_activeSimData);
}
function toggleDistPanel() {
  // 통합 패널의 📐 노드 탭으로 이동
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    if (typeof switchUpTab === 'function') switchUpTab('node', document.querySelector('.up-tab[data-tab="node"]'));
  }
}
function closeDistPanel() {
  const panel = document.getElementById('unified-panel');
  if (panel) panel.classList.remove('open');
}

// ── 마켓 이펙트 패널 ─────────────────────────────────────────────────────────
let _selectedEffectId = null;

// 미니 프리뷰 캔버스 애니메이션 루프
let _previewRAF = null;
const _previewCtxMap = {};  // effectId → CanvasRenderingContext2D

function tickPreviewCanvases() {
  const now = performance.now() * 0.001;
  for (const [id, ctx] of Object.entries(_previewCtxMap)) {
    const fn = EFFECT_FNS[id];
    if (!fn) continue;
    const ef = MARKET_EFFECTS.find(e => e.id === id);
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, 64, 64);
    fn(ctx, 32, 32, 16, ef?.color || '#58a6ff', now);
  }
  _previewRAF = requestAnimationFrame(tickPreviewCanvases);
}

function initEffectsPanel() {
  const grid = document.getElementById('effects-grid');
  if (!grid) return;

  // 기존 프리뷰 루프 정리
  if (_previewRAF) { cancelAnimationFrame(_previewRAF); _previewRAF = null; }
  for (const k of Object.keys(_previewCtxMap)) delete _previewCtxMap[k];

  grid.innerHTML = MARKET_EFFECTS.map(e => `
    <div class="effect-card" id="ec-${e.id}" style="--ec:${e.color}" onclick="selectEffect('${e.id}')">
      <canvas id="ecv-${e.id}" width="64" height="64"></canvas>
      <div class="ec-name">${e.icon} ${e.name}</div>
      <div class="ec-desc">${e.desc}</div>
    </div>`).join('');

  // 각 카드에 캔버스 컨텍스트 등록
  MARKET_EFFECTS.forEach(e => {
    const cvs = document.getElementById('ecv-' + e.id);
    if (cvs) _previewCtxMap[e.id] = cvs.getContext('2d');
  });

  // 프리뷰 루프 시작
  tickPreviewCanvases();
}

function selectEffect(id) {
  _selectedEffectId = id;
  document.querySelectorAll('.effect-card').forEach(el => el.classList.remove('selected'));
  document.getElementById('ec-' + id)?.classList.add('selected');
}

function applySelectedEffect() {
  if (!_selectedEffectId) return;
  const node = _selectedHit?.data || _currentPanelData;
  if (!node) { alert('먼저 노드를 클릭하세요'); return; }
  _nodeEffects[node.label] = _selectedEffectId;
  if (typeof track === 'function') track('node.effect_apply', { effect: _selectedEffectId });
  showApplyEffect(`이펙트 적용: ✨ ${_selectedEffectId} → ${node.label || node.intent || '노드'}`);
}

function clearNodeEffect() {
  const node = _selectedHit?.data || _currentPanelData;
  if (!node) return;
  delete _nodeEffects[node.label];
}

function toggleEffectsPanel() {
  // 통합 패널의 ✨ 이펙트 탭으로 이동
  const panel = document.getElementById('unified-panel');
  if (panel) {
    panel.classList.add('open');
    if (typeof switchUpTab === 'function') switchUpTab('fx', document.querySelector('.up-tab[data-tab="fx"]'));
  }
  if (typeof track === 'function') track('view.panel_open', { panel: 'effects' });
  initEffectsPanel();
  updateEffectsPanelNode();
}

function closeEffectsPanel() {
  // 통합 패널 닫기
  const panel = document.getElementById('unified-panel');
  if (panel) panel.classList.remove('open');
}

function updateEffectsPanelNode() {
  const el = document.getElementById('effects-selected-node');
  if (!el) return;
  const node = _selectedHit?.data || _currentPanelData;
  el.textContent = node ? `선택: ${node.label}` : '(노드 미선택)';
}

window.updateDist = updateDist;
window.applyTeamCfg = applyTeamCfg;
window.toggleDistPanel = toggleDistPanel;
window.closeDistPanel = closeDistPanel;
window.toggleEffectsPanel = toggleEffectsPanel;
window.closeEffectsPanel = closeEffectsPanel;
window.selectEffect = selectEffect;
window.applySelectedEffect = applySelectedEffect;
window.clearNodeEffect = clearNodeEffect;

const STATUS_CFG = {
  done:    { emoji: '✅', color: '#3fb950' },
  active:  { emoji: '⚡', color: '#58a6ff' },
  blocked: { emoji: '🚧', color: '#f0883e' },
  pending: { emoji: '⏳', color: '#6e7681' },
};

// ── 팀 데모 데이터 ──────────────────────────────────────────────────────────
const TEAM_DEMO = {
  // 계층 구조: Universe → Company → Team → Member → Task
  universe: { name: '🌌 AI 스타트업 생태계', teamCount: 8, memberCount: 34, desc: '8개 팀 · 34명 · 120+ 프로젝트 동시 진행 중' },
  company:  { name: '🏢 Orbit AI Inc.', teams: ['제품팀', 'DevOps팀', '마케팅팀'], desc: '3개 팀 · 12명 · Series-A 준비 중' },
  name: 'Orbit AI 제품팀',
  goal: '🚀 Q1 SaaS MVP 런칭',
  goalColor: '#ffd700',
  members: [
    {
      id: 'm0', name: '김민준', role: '백엔드 개발', color: '#3fb950',
      collab: ['m1', 'm2'],   // 협업 관계
      tools: ['VS Code', 'Docker', 'PostgreSQL'],
      tasks: [
        { name: '🔐 인증 시스템', status: 'active', progress: 0.75, dueDate: '03-18', blocker: false,
          subtasks: ['JWT 토큰 구현', 'OAuth Google/GitHub', 'bcrypt 해시 적용', '세션 관리 미들웨어'],
          completedSubtasks: 3 },
        { name: '🌐 API 서버 구축', status: 'done', progress: 1.0, dueDate: '02-28', blocker: false,
          subtasks: ['Express 라우터 설계', 'WebSocket 연동', 'Rate Limiter 적용'],
          completedSubtasks: 3 },
        { name: '🚀 MVP 런칭 준비', status: 'active', progress: 0.4, dueDate: '03-10', blocker: true,
          subtasks: ['스테이징 환경 구축', '성능 테스트', '버그 수정'],
          completedSubtasks: 1, collab: true },
      ],
    },
    {
      id: 'm1', name: '이서연', role: '프론트엔드', color: '#58a6ff',
      collab: ['m0', 'm4'],   // 협업 관계
      tools: ['Cursor', 'React', 'Figma'],
      tasks: [
        { name: '🪐 3D 뷰 개발', status: 'active', progress: 0.6, dueDate: '03-20', blocker: false,
          subtasks: ['Three.js 렌더러', 'Canvas2D 오버레이', 'LOD 시스템', '팀 시뮬레이션'],
          completedSubtasks: 2 },
        { name: '🎨 UI 컴포넌트', status: 'done', progress: 1.0, dueDate: '02-25', blocker: false,
          subtasks: ['디자인 시스템 정의', '공통 버튼/폼', '다크모드'],
          completedSubtasks: 3 },
        { name: '🚀 MVP 런칭 준비', status: 'active', progress: 0.55, dueDate: '03-10', blocker: false,
          subtasks: ['랜딩페이지 완성', '온보딩 플로우', 'A/B 테스트'],
          completedSubtasks: 2, collab: true },
      ],
    },
    {
      id: 'm2', name: '박지훈', role: 'AI 엔지니어', color: '#bc8cff',
      collab: ['m0', 'm3'],   // 협업 관계
      tools: ['Claude Code', 'Ollama', 'Python'],
      tasks: [
        { name: '⚡ signal-engine', status: 'done', progress: 1.0, dueDate: '02-28', blocker: false,
          subtasks: ['6차원 벡터 설계', '상태 분류기 로직', 'API /api/signal 엔드포인트'],
          completedSubtasks: 3 },
        { name: '🤖 커스텀 모델 학습', status: 'active', progress: 0.45, dueDate: '03-25', blocker: true,
          subtasks: ['데이터셋 전처리', 'Fine-tuning 실행', '평가 지표 설계', 'Ollama 배포'],
          completedSubtasks: 1 },
        { name: '🔐 인증 시스템', status: 'pending', progress: 0.1, dueDate: '03-10', blocker: false,
          subtasks: ['AI 사용자 행동 분석', '이상 탐지 모델'],
          completedSubtasks: 0, collab: true },
      ],
    },
    {
      id: 'm3', name: '최유나', role: 'DevOps', color: '#f0883e',
      collab: ['m2', 'm4'],   // 협업 관계
      tools: ['Windsurf', 'Railway', 'GitHub Actions'],
      tasks: [
        { name: '🚂 Railway 배포', status: 'active', progress: 0.5, dueDate: '03-08', blocker: true,
          subtasks: ['환경변수 .env 설정', 'PostgreSQL 연결', '커스텀 도메인', '헬스체크 모니터링'],
          completedSubtasks: 2 },
        { name: '⚙️ CI/CD 파이프라인', status: 'done', progress: 1.0, dueDate: '02-20', blocker: false,
          subtasks: ['GitHub Actions 워크플로우', '자동 테스트 실행', '자동 배포 트리거'],
          completedSubtasks: 3 },
        { name: '🚀 MVP 런칭 준비', status: 'active', progress: 0.7, dueDate: '03-10', blocker: false,
          subtasks: ['프로덕션 배포', '모니터링 설정', 'On-call 플랜'],
          completedSubtasks: 2, collab: true },
      ],
    },
    {
      id: 'm4', name: '장현우', role: '기획/PM', color: '#f85149',
      collab: ['m1', 'm3'],   // 협업 관계
      tools: ['Notion', 'n8n', 'ChatGPT'],
      tasks: [
        { name: '🏢 기업별 특화 기획', status: 'active', progress: 0.65, dueDate: '03-22', blocker: false,
          subtasks: ['생산업 버전 설계', '금융업 버전 설계', '엔터프라이즈 로드맵', '고객 인터뷰'],
          completedSubtasks: 2 },
        { name: '🛒 솔루션 마켓 정책', status: 'done', progress: 1.0, dueDate: '02-22', blocker: false,
          subtasks: ['수익 쉐어 모델 70/30', '판매자 온보딩 정책', '리뷰 시스템 설계'],
          completedSubtasks: 3 },
        { name: '🚀 MVP 런칭 준비', status: 'active', progress: 0.8, dueDate: '03-10', blocker: false,
          subtasks: ['고객 인터뷰 5건', 'GTM 전략 확정', '프레스킷 작성'],
          completedSubtasks: 3, collab: true },
      ],
      skills: [{ alias: '회의요약', type: 'skill', config: { trigger: '/meeting', model: 'claude-sonnet-4-6' } }],
      agents: [{ alias: '기획도우미', type: 'agent', config: { model: 'claude-sonnet-4-6', task: '제품 기획 및 요구사항 정리', autoRun: false } }],
    },
  ],
};

// TEAM_DEMO 각 멤버에 skills/agents 보강
TEAM_DEMO.members[0].skills = [{ alias: 'SQL최적화', type: 'skill', config: { trigger: '/sql', model: 'claude-haiku-4-5' } }];
TEAM_DEMO.members[0].agents = [{ alias: '코드리뷰어', type: 'agent', config: { model: 'claude-sonnet-4-6', task: 'PR 코드 자동 리뷰 및 버그 감지', autoRun: true } }];
TEAM_DEMO.members[1].skills = [{ alias: 'CSS마법사', type: 'skill', config: { trigger: '/style', model: 'claude-haiku-4-5' } }];
TEAM_DEMO.members[1].agents = [{ alias: 'UI피드백봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: 'UI/UX 접근성 & 반응형 자동 점검', autoRun: false } }];
TEAM_DEMO.members[2].skills = [{ alias: '데이터분석', type: 'skill', config: { trigger: '/analyze', model: 'claude-opus-4-6' } }];
TEAM_DEMO.members[2].agents = [{ alias: '학습자동화', type: 'agent', config: { model: 'claude-opus-4-6', task: 'Ollama 모델 파인튜닝 파이프라인 실행', autoRun: true } }];
TEAM_DEMO.members[3].skills = [{ alias: '배포체크', type: 'skill', config: { trigger: '/deploy', model: 'claude-haiku-4-5' } }];
TEAM_DEMO.members[3].agents = [{ alias: 'CI모니터', type: 'agent', config: { model: 'claude-haiku-4-5', task: 'GitHub Actions 실패 감지 및 Slack 알림', autoRun: true } }];

// ── 회사 시뮬 데이터 (중소/중견기업) ─────────────────────────────────────────
const COMPANY_DEMO = {
  name: '(주)한국중견 코퍼레이션',
  goal: '📈 2026년 매출 20% 성장',
  goalColor: '#ffd700',
  universe: { name: '🌏 대한민국 기업 생태계', desc: '중견기업 1,200개사 · 임직원 85만명 · GDP 15% 기여' },
  company:  { name: '🏢 (주)한국중견 코퍼레이션', desc: '8개 팀 · 47명 · 창립 15년 종합 제조·서비스 기업' },
  departments: [
    {
      id: 'd0', name: '경영진', icon: '👔', color: '#ffd700',
      members: [
        { id: 'c00', name: '이철수', role: 'CEO', color: '#ffd700',
          tools: ['Word', 'PowerPoint', 'Excel'],
          tasks: [
            { name: '📊 분기 이사회 보고서', status: 'active', progress: 0.7,
              subtasks: ['재무현황 취합', 'KPI 달성률 분석', '차기 전략 초안 작성', '경영진 사전 검토'],
              completedSubtasks: 2 },
            { name: '📋 임원 주간회의', status: 'done', progress: 1.0,
              subtasks: ['안건 준비', '회의록 작성'], completedSubtasks: 2 },
          ],
          skills: [{ alias: '보고서요약', type: 'skill', config: { trigger: '/summarize', model: 'claude-opus-4-6' } }],
          agents: [{ alias: 'KPI모니터', type: 'agent', config: { model: 'claude-sonnet-4-6', task: '월간 KPI 자동 집계 및 경영진 이메일 발송', autoRun: true } }],
        },
        { id: 'c01', name: '박재무', role: 'CFO', color: '#e6b800',
          tools: ['Excel', 'SAP ERP', 'Word'],
          tasks: [
            { name: '💰 월간 재무제표 작성', status: 'active', progress: 0.85,
              subtasks: ['손익계산서', '대차대조표', '현금흐름표', '감사법인 제출'],
              completedSubtasks: 3 },
            { name: '📑 세금계산서 처리', status: 'done', progress: 1.0,
              subtasks: ['매출 세금계산서', '매입 세금계산서', '부가세 신고'], completedSubtasks: 3 },
          ],
          skills: [{ alias: '재무분석', type: 'skill', config: { trigger: '/finance', model: 'claude-sonnet-4-6' } }],
          agents: [],
        },
      ],
    },
    {
      id: 'd1', name: '기획/PM팀', icon: '📐', color: '#58a6ff',
      members: [
        { id: 'c10', name: '김기획', role: 'PM팀장', color: '#58a6ff',
          collab: ['c20', 'c40'],  // 마케팅팀장·디자인팀장과 크로스-부서 협업
          tools: ['Notion', 'Figma', 'Excel'],
          tasks: [
            { name: '📋 신제품 로드맵 수립', status: 'active', progress: 0.6,
              subtasks: ['시장조사 분석', '경쟁사 벤치마킹', '개발일정 조율', '경영진 승인'],
              completedSubtasks: 2 },
            { name: '📄 기능 요구사항 문서', status: 'active', progress: 0.75,
              subtasks: ['사용자 스토리 작성', 'Figma 와이어프레임', '개발팀 리뷰'], completedSubtasks: 2 },
          ],
          skills: [{ alias: '요구사항정리', type: 'skill', config: { trigger: '/prd', model: 'claude-sonnet-4-6' } }],
          agents: [{ alias: '일정봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: '프로젝트 일정 자동 리마인더 및 지연 감지', autoRun: true } }],
        },
        { id: 'c11', name: '정어시', role: 'PA', color: '#4d9fd6',
          tools: ['Word', 'Excel', 'Google Meet'],
          tasks: [
            { name: '📝 회의록 작성', status: 'done', progress: 1.0,
              subtasks: ['회의 녹취 요약', '액션 아이템 정리', '팀 배포'], completedSubtasks: 3 },
            { name: '📊 업무현황 보고서', status: 'active', progress: 0.5,
              subtasks: ['팀별 현황 취합', 'Excel 정리', '주간 리포트 발송'], completedSubtasks: 1 },
          ],
          skills: [],
          agents: [{ alias: '회의록봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: '회의 녹취 자동 요약 및 액션 아이템 추출', autoRun: false } }],
        },
      ],
    },
    {
      id: 'd2', name: '마케팅팀', icon: '📣', color: '#bc8cff',
      members: [
        { id: 'c20', name: '이마케터', role: '마케팅팀장', color: '#bc8cff',
          collab: ['c10', 'c30'],  // 기획팀장·영업팀장과 크로스-부서 협업
          tools: ['Canva', 'Meta Ads', 'Google Analytics'],
          tasks: [
            { name: '📱 SNS 카드뉴스 제작', status: 'active', progress: 0.8,
              subtasks: ['콘텐츠 기획', 'Canva 디자인', '카피라이팅', '스케줄 예약'],
              completedSubtasks: 3 },
            { name: '📈 Meta 광고 캠페인', status: 'active', progress: 0.55,
              subtasks: ['타겟 오디언스 설정', '소재 A/B 테스트', '예산 최적화'], completedSubtasks: 1 },
          ],
          skills: [{ alias: '카피라이터', type: 'skill', config: { trigger: '/copy', model: 'claude-sonnet-4-6' } }],
          agents: [{ alias: '광고최적화봇', type: 'agent', config: { model: 'claude-sonnet-4-6', task: 'Meta Ads ROAS 분석 및 예산 재배분 제안', autoRun: true } }],
        },
        { id: 'c21', name: '최콘텐츠', role: '콘텐츠 크리에이터', color: '#9d6fe8',
          tools: ['Premiere Pro', 'Photoshop', 'CapCut'],
          tasks: [
            { name: '🎬 유튜브 홍보영상 편집', status: 'active', progress: 0.65,
              subtasks: ['Premiere Pro 컷편집', '자막 삽입', '색보정', '유튜브 업로드'],
              completedSubtasks: 2 },
            { name: '🖼️ 제품 썸네일 디자인', status: 'done', progress: 1.0,
              subtasks: ['Photoshop 작업', 'A/B 테스트 2종', 'SNS 포맷 최적화'], completedSubtasks: 3 },
          ],
          skills: [],
          agents: [{ alias: '영상분석봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: '유튜브 조회수 패턴 분석 및 최적 업로드 시간 추천', autoRun: false } }],
        },
      ],
    },
    {
      id: 'd3', name: '영업팀', icon: '💼', color: '#f0883e',
      members: [
        { id: 'c30', name: '한영업', role: '영업팀장', color: '#f0883e',
          collab: ['c20'],  // 마케팅팀장과 크로스-부서 협업
          tools: ['Excel', 'CRM', 'Zoom'],
          tasks: [
            { name: '📊 고객 파이프라인 관리', status: 'active', progress: 0.7,
              subtasks: ['CRM 데이터 업데이트', '리드 스코어링', '우선순위 정렬', '팀 배분'],
              completedSubtasks: 2 },
            { name: '🤝 B2B 영업 제안', status: 'active', progress: 0.4,
              subtasks: ['고객사 니즈 파악', 'Word 제안서 작성', '가격 협상 준비'], completedSubtasks: 1 },
          ],
          skills: [{ alias: '제안서작성', type: 'skill', config: { trigger: '/proposal', model: 'claude-sonnet-4-6' } }],
          agents: [{ alias: 'CRM봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: '영업 파이프라인 이상 감지 및 팔로업 리마인더', autoRun: true } }],
        },
        { id: 'c31', name: '조영업', role: '영업사원', color: '#d4733a',
          tools: ['Word', 'Excel', 'KakaoWork'],
          tasks: [
            { name: '📋 월간 영업 실적 보고', status: 'done', progress: 1.0,
              subtasks: ['Excel 실적 집계', '목표 달성률 계산', '팀장 보고'], completedSubtasks: 3 },
            { name: '📞 고객사 미팅 준비', status: 'pending', progress: 0.2,
              subtasks: ['미팅 자료 PPT', '샘플 준비', '방문 일정 확정'], completedSubtasks: 0 },
          ],
          skills: [],
          agents: [],
        },
      ],
    },
    {
      id: 'd4', name: '디자인팀', icon: '🎨', color: '#79c0ff',
      members: [
        { id: 'c40', name: '윤디자인', role: '디자인팀장', color: '#79c0ff',
          collab: ['c10', 'c20'],  // 기획팀장·마케팅팀장과 크로스-부서 협업
          tools: ['Figma', 'Illustrator', 'Adobe XD'],
          tasks: [
            { name: '🖌️ 브랜드 BI 리뉴얼', status: 'active', progress: 0.5,
              subtasks: ['로고 시안 3종', '컬러 시스템 정의', '서체 가이드라인', '브랜드북 제작'],
              completedSubtasks: 2 },
            { name: '📱 앱 UI/UX 개선', status: 'blocked', progress: 0.35,
              subtasks: ['사용자 인터뷰 분석', 'Figma 프로토타입', '개발팀 핸드오프'], completedSubtasks: 1 },
          ],
          skills: [{ alias: 'UI평가', type: 'skill', config: { trigger: '/ux-review', model: 'claude-sonnet-4-6' } }],
          agents: [{ alias: '디자인피드백봇', type: 'agent', config: { model: 'claude-sonnet-4-6', task: 'Figma 프로토타입 접근성 자동 평가', autoRun: false } }],
        },
        { id: 'c41', name: '강포토', role: '그래픽 디자이너', color: '#5da8d8',
          tools: ['Photoshop', 'Premiere Pro', 'After Effects'],
          tasks: [
            { name: '🖼️ 제품 상세페이지 이미지', status: 'active', progress: 0.9,
              subtasks: ['Photoshop 보정', '배경 제거', '텍스트 합성', '최종 저장'], completedSubtasks: 3 },
            { name: '🎞️ 사내 홍보영상 편집', status: 'active', progress: 0.6,
              subtasks: ['After Effects 인트로', 'Premiere 본편집', '음악 삽입', '색보정'], completedSubtasks: 2 },
          ],
          skills: [],
          agents: [{ alias: '이미지분석봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: '이미지 품질 자동 검수 및 최적화 제안', autoRun: false } }],
        },
      ],
    },
    {
      id: 'd5', name: 'IT/개발팀', icon: '💻', color: '#3fb950',
      members: [
        { id: 'c50', name: '박개발', role: '개발팀장', color: '#3fb950',
          tools: ['VS Code', 'Git', 'Jira'],
          tasks: [
            { name: '⚙️ 사내 ERP 연동 API', status: 'active', progress: 0.55,
              subtasks: ['SAP REST API 분석', 'Node.js 미들웨어 작성', '테스트 코드', '운영 배포'],
              completedSubtasks: 2 },
            { name: '🔒 보안 취약점 패치', status: 'done', progress: 1.0,
              subtasks: ['OWASP 점검', 'SQL Injection 수정', '보안 리포트 제출'], completedSubtasks: 3 },
          ],
          skills: [{ alias: '코드리뷰', type: 'skill', config: { trigger: '/review', model: 'claude-sonnet-4-6' } }],
          agents: [{ alias: '배포자동화봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: 'Git push 감지 → 자동 빌드/테스트/슬랙 알림', autoRun: true } }],
        },
        { id: 'c51', name: '류주니어', role: '개발사원', color: '#2ea043',
          tools: ['VS Code', 'Docker', 'Postman'],
          tasks: [
            { name: '🌐 관리자 웹 페이지', status: 'active', progress: 0.45,
              subtasks: ['로그인 화면 개발', '대시보드 UI', 'API 연동', '크로스브라우저 테스트'],
              completedSubtasks: 2 },
            { name: '🐛 버그 수정 이슈 처리', status: 'active', progress: 0.8,
              subtasks: ['Jira 이슈 분류', '재현 및 원인 파악', '코드 수정', 'PR 제출'], completedSubtasks: 3 },
          ],
          skills: [],
          agents: [{ alias: '이슈분류봇', type: 'agent', config: { model: 'claude-haiku-4-5', task: 'Jira 이슈 자동 분류 및 담당자 배정', autoRun: false } }],
        },
      ],
    },
    {
      id: 'd6', name: '총무/인사팀', icon: '🗂️', color: '#39d2c0',
      members: [
        { id: 'c60', name: '서총무', role: '총무팀장', color: '#39d2c0',
          tools: ['Word', 'Excel', 'SAP ERP'],
          tasks: [
            { name: '📄 근로계약서 갱신', status: 'active', progress: 0.6,
              subtasks: ['계약서 양식 업데이트', '법무팀 검토', '전자서명 발송', '파일 보관'],
              completedSubtasks: 2 },
            { name: '💳 월간 급여 정산', status: 'done', progress: 1.0,
              subtasks: ['근태 데이터 취합', 'Excel 급여대장 작성', '세금 공제 계산', '이체 완료'],
              completedSubtasks: 4 },
          ],
          skills: [{ alias: '법무검토', type: 'skill', config: { trigger: '/legal', model: 'claude-sonnet-4-6' } }],
          agents: [],
        },
        { id: 'c61', name: '임인사', role: '인사담당자', color: '#2db8a8',
          tools: ['Word', 'Excel', 'LinkedIn'],
          tasks: [
            { name: '👥 신규 채용 공고', status: 'active', progress: 0.7,
              subtasks: ['채용 요건 정의', 'JD 작성', '채용 플랫폼 등록', '서류 검토'],
              completedSubtasks: 3 },
            { name: '📚 신입사원 교육자료', status: 'pending', progress: 0.15,
              subtasks: ['온보딩 PPT 제작', '사내 규정 문서화', '멘토 배정'], completedSubtasks: 0 },
          ],
          skills: [],
          agents: [{ alias: 'JD작성봇', type: 'agent', config: { model: 'claude-sonnet-4-6', task: '채용 공고(JD) 자동 초안 생성 및 맞춤 최적화', autoRun: false } }],
        },
      ],
    },
    {
      id: 'd7', name: '생산/QA팀', icon: '🏭', color: '#f85149',
      members: [
        { id: 'c70', name: '고생산', role: '생산팀장', color: '#f85149',
          tools: ['Excel', 'MES', 'SAP ERP'],
          tasks: [
            { name: '📋 주간 생산계획 수립', status: 'done', progress: 1.0,
              subtasks: ['수주량 확인', 'MES 투입 계획', '자재 발주 확인', '라인 배치'], completedSubtasks: 4 },
            { name: '📦 재고 현황 관리', status: 'active', progress: 0.75,
              subtasks: ['ERP 재고 조회', '부족 자재 발주', '창고 실사', 'Excel 보고'], completedSubtasks: 2 },
          ],
          skills: [{ alias: '재고분석', type: 'skill', config: { trigger: '/inventory', model: 'claude-haiku-4-5' } }],
          agents: [{ alias: '생산모니터', type: 'agent', config: { model: 'claude-haiku-4-5', task: 'MES 생산 지연 감지 및 긴급 알림 발송', autoRun: true } }],
        },
        { id: 'c71', name: '문QA', role: 'QA 담당자', color: '#d4403d',
          tools: ['Excel', 'Word', 'ERP'],
          tasks: [
            { name: '🔍 불량품 보고서 작성', status: 'active', progress: 0.8,
              subtasks: ['불량 원인 분석', 'Excel 데이터 정리', '8D 리포트 작성', '공정 개선안'],
              completedSubtasks: 3 },
            { name: '📖 품질 매뉴얼 업데이트', status: 'pending', progress: 0.0,
              subtasks: ['ISO 9001 기준 검토', 'Word 문서 작성', '경영진 승인'], completedSubtasks: 0 },
          ],
          skills: [],
          agents: [{ alias: '불량분석봇', type: 'agent', config: { model: 'claude-sonnet-4-6', task: '불량 패턴 통계 분석 및 예방 조치 제안', autoRun: false } }],
        },
      ],
    },
  ],
};

// ── buildTeamSystem ──────────────────────────────────────────────────────────
function buildTeamSystem(teamData) {
  clearScene();
  _teamNodes = [];
  _teamMode  = true;
  _companyMode = false;
  _activeSimData = teamData;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const { name, goal, goalColor, members } = teamData;

  // 중심 코어 (팀 목표 — 골드 구체)
  const coreMat = new THREE.MeshPhongMaterial({ color: 0xffd700, emissive: 0x7a5800, shininess: 200 });
  const core    = new THREE.Mesh(new THREE.SphereGeometry(3.5, 32, 32), coreMat);
  core.userData.isCore = true;
  scene.add(core);
  scene.add(new THREE.Mesh(
    new THREE.SphereGeometry(7, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.08, side: THREE.BackSide })
  ));

  // 팀 목표 노드 (Canvas2D 라벨)
  _teamNodes.push({ type: 'goal', pos: new THREE.Vector3(0, 0, 0),
    label: goal, sublabel: name, color: goalColor, size: 'xl' });

  const MEMBER_R = TEAM_CFG.MEMBER_R;
  const TASK_R   = TEAM_CFG.TASK_R;
  const TOOL_R   = TEAM_CFG.TOOL_R;

  // 전체 궤도 링 (팀원 공전 궤도)
  {
    const ring  = new THREE.RingGeometry(MEMBER_R - 0.12, MEMBER_R + 0.12, 128);
    const ringM = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.06, side: THREE.DoubleSide });
    const rm    = new THREE.Mesh(ring, ringM);
    rm.rotation.x = Math.PI / 2;
    orbitRings.push(rm); scene.add(rm);
  }

  members.forEach((member, mi) => {
    // 오각형 배치: 72° 간격, 상단(-90°)부터 시작
    const angle = (mi / members.length) * Math.PI * 2 - Math.PI / 2;
    const mx    = MEMBER_R * Math.cos(angle);
    const my    = 0;
    const mz    = MEMBER_R * Math.sin(angle);
    const mPos  = new THREE.Vector3(mx, my, mz);

    // 팀원 Object3D
    const mObj = new THREE.Object3D();
    mObj.position.copy(mPos);
    mObj.userData = {
      isTeamMember: true, memberId: member.id,
      name: member.name, role: member.role, color: member.color,
      orbitR: MEMBER_R, orbitAngle: angle, orbitSpeed: 0.016 + mi * 0.003,
      orbitCenter: new THREE.Vector3(0, 0, 0),
    };
    scene.add(mObj);
    planetMeshes.push(mObj);

    _teamNodes.push({
      type: 'member', pos: mPos.clone(), obj: mObj,
      label: member.name, sublabel: member.role, color: member.color, size: 'lg',
      memberId: member.id,
    });

    // 중심 → 팀원 연결선 (컬러, 굵게)
    {
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), mPos.clone()]);
      const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.45 });
      const ln = new THREE.Line(lg, lm);
      connections.push(ln); scene.add(ln);
    }

    // 팀원 궤도 링 (개인 작업 공전 궤도, 얇게)
    {
      const ring  = new THREE.RingGeometry(TASK_R - 0.06, TASK_R + 0.06, 64);
      const ringM = new THREE.MeshBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.10, side: THREE.DoubleSide });
      const rm    = new THREE.Mesh(ring, ringM);
      // 궤도면을 팀원 위치를 향해 약간 기울임
      rm.position.copy(mPos);
      rm.rotation.x = Math.PI / 2;
      orbitRings.push(rm); scene.add(rm);
    }

    // ── 작업 위성 ─────────────────────────────────────────────────────────
    member.tasks.forEach((task, ti) => {
      const tAngle = (ti / member.tasks.length) * Math.PI * 2 + (mi * 1.26);
      const tx = mPos.x + TASK_R * Math.cos(tAngle);
      const ty = mPos.y + TASK_R * 0.25 * Math.sin(tAngle + 1.0);
      const tz = mPos.z + TASK_R * Math.sin(tAngle);
      const tPos = new THREE.Vector3(tx, ty, tz);

      const tObj = new THREE.Object3D();
      tObj.position.copy(tPos);
      tObj.userData = {
        isTeamTask: true, memberId: member.id,
        taskName: task.name, taskStatus: task.status, taskProgress: task.progress,
        color: STATUS_CFG[task.status]?.color || '#6e7681',
        orbitR: TASK_R, orbitAngle: tAngle, orbitSpeed: 0.038 + mi * 0.004 + ti * 0.003,
        orbitCenter: mPos.clone(),
      };
      scene.add(tObj);
      satelliteMeshes.push(tObj);

      const sc = STATUS_CFG[task.status] || STATUS_CFG.pending;
      _teamNodes.push({
        type: 'task', pos: tPos.clone(), obj: tObj,
        label: task.name, emoji: sc.emoji, color: sc.color,
        progress: task.progress, size: 'sm',
        memberId: member.id, taskStatus: task.status,
      });

      // 팀원 → 작업 연결선
      {
        const lg = new THREE.BufferGeometry().setFromPoints([mPos.clone(), tPos.clone()]);
        const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.18 });
        const ln = new THREE.Line(lg, lm);
        connections.push(ln); scene.add(ln);
      }
    });

    // ── 툴 라벨 ───────────────────────────────────────────────────────────
    member.tools.forEach((tool, tli) => {
      const tlAngle = angle + Math.PI + (tli - 1) * 0.55;
      const tx = mPos.x + TOOL_R * Math.cos(tlAngle);
      const ty = mPos.y + 3.5 + tli * 2.2;
      const tz = mPos.z + TOOL_R * Math.sin(tlAngle);
      const tlPos = new THREE.Vector3(tx, ty, tz);

      const tlObj = new THREE.Object3D();
      tlObj.position.copy(tlPos);
      tlObj.userData = {
        isTeamTool: true, memberId: member.id, toolName: tool,
        color: member.color, relAngle: tlAngle, relY: 3.5 + tli * 2.2, relR: TOOL_R,
      };
      scene.add(tlObj);
      satelliteMeshes.push(tlObj);

      _teamNodes.push({
        type: 'tool', pos: tlPos.clone(), obj: tlObj,
        label: tool, color: member.color, size: 'xs',
      });
    });

    // ── 스킬 노드 ───────────────────────────────────────────────────────────
    const SKILL_R = TOOL_R * 0.65;
    (member.skills || []).forEach((sk, ski) => {
      const skAngle = angle - Math.PI * 0.6 + ski * 0.8;
      const skPos   = new THREE.Vector3(
        mPos.x + SKILL_R * Math.cos(skAngle),
        mPos.y - 4 - ski * 2.5,
        mPos.z + SKILL_R * Math.sin(skAngle),
      );
      const skObj = new THREE.Object3D();
      skObj.position.copy(skPos);
      skObj.userData = { isTeamSkill: true, memberId: member.id, alias: sk.alias, skillType: sk.type, config: sk.config, color: '#d2a8ff', relAngle: skAngle, relY: -4 - ski * 2.5, relR: SKILL_R };
      scene.add(skObj); satelliteMeshes.push(skObj);
      _teamNodes.push({ type: 'skill', pos: skPos.clone(), obj: skObj, label: sk.alias, color: '#d2a8ff', size: 'xs', memberId: member.id, config: sk.config, skillType: sk.type });
    });

    // ── 에이전트 노드 ────────────────────────────────────────────────────────
    const AGENT_R = TOOL_R * 0.8;
    (member.agents || []).forEach((ag, agi) => {
      const agAngle = angle + Math.PI * 0.6 + agi * 0.9;
      const agPos   = new THREE.Vector3(
        mPos.x + AGENT_R * Math.cos(agAngle),
        mPos.y - 5 - agi * 2.8,
        mPos.z + AGENT_R * Math.sin(agAngle),
      );
      const agObj = new THREE.Object3D();
      agObj.position.copy(agPos);
      agObj.userData = { isTeamAgent: true, memberId: member.id, alias: ag.alias, agentType: ag.type, config: ag.config, color: '#39d2c0', relAngle: agAngle, relY: -5 - agi * 2.8, relR: AGENT_R };
      scene.add(agObj); satelliteMeshes.push(agObj);
      _teamNodes.push({ type: 'agent', pos: agPos.clone(), obj: agObj, label: ag.alias, color: '#39d2c0', size: 'xs', memberId: member.id, config: ag.config, agentType: ag.type, autoRun: ag.config?.autoRun });
    });
  });

  // ── 협업 라인 생성 ─────────────────────────────────────────────────────────
  // collab 필드에 명시된 멤버 쌍 사이에 애니메이션 선 그리기 (중복 방지)
  _collabLines.forEach(l => { scene.remove(l.line); });
  _collabLines = [];
  const drawnPairs = new Set();

  members.forEach((member, mi) => {
    const mNode = _teamNodes.find(n => n.type === 'member' && n.memberId === member.id);
    if (!mNode) return;
    (member.collab || []).forEach(targetId => {
      const pairKey = [member.id, targetId].sort().join('-');
      if (drawnPairs.has(pairKey)) return;
      drawnPairs.add(pairKey);

      const targetNode = _teamNodes.find(n => n.type === 'member' && n.memberId === targetId);
      if (!targetNode) return;

      // 협업 라인 (청록색, 반짝임 애니메이션)
      const lg = new THREE.BufferGeometry().setFromPoints([mNode.pos.clone(), targetNode.pos.clone()]);
      const lm = new THREE.LineBasicMaterial({ color: 0x39d2c0, transparent: true, opacity: 0.55 });
      const ln = new THREE.Line(lg, lm);
      scene.add(ln);
      _collabLines.push({ line: ln, mat: lm, phase: Math.random() * Math.PI * 2, fromNode: mNode, toNode: targetNode });
    });
  });

  // HUD 업데이트
  document.getElementById('h-sessions').textContent = members.length;
  document.getElementById('h-tasks').textContent    = members.reduce((s, m) => s + m.tasks.length, 0);
  document.getElementById('h-hours').textContent    = '팀';
  document.getElementById('team-mode-badge').style.display = 'flex';

  // 뷰 자동 맞춤
  autoFitView(_teamNodes);

  // 사이드바 업데이트
  updateMyTaskSidebar();
}

// ── buildCompanySystem ───────────────────────────────────────────────────────
function buildCompanySystem(companyData) {
  clearScene();
  _teamNodes = [];
  _teamMode  = true;
  _companyMode = true;
  _activeSimData = companyData;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const { name, goal, goalColor, departments } = companyData;
  const DEPT_R   = 72;
  const MBR_R    = 20;
  const CTASK_R  = 9;
  const SKILL_R  = 5;
  const AGENT_R  = 6;

  // 코어 (회사 목표)
  const coreMat = new THREE.MeshPhongMaterial({ color: 0xffd700, emissive: 0x7a5800, shininess: 200 });
  const core    = new THREE.Mesh(new THREE.SphereGeometry(4, 32, 32), coreMat);
  core.userData.isCore = true; scene.add(core);
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(8, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.06, side: THREE.BackSide })));

  _teamNodes.push({ type: 'goal', pos: new THREE.Vector3(0, 0, 0), label: goal, sublabel: name, color: goalColor || '#ffd700', size: 'xl' });

  // 부서 궤도 링
  { const r = new THREE.Mesh(new THREE.RingGeometry(DEPT_R - 0.15, DEPT_R + 0.15, 128), new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.04, side: THREE.DoubleSide })); r.rotation.x = Math.PI / 2; orbitRings.push(r); scene.add(r); }

  departments.forEach((dept, di) => {
    const dAngle = (di / departments.length) * Math.PI * 2 - Math.PI / 2;
    const dy     = (di % 2 === 0 ? 1 : -1) * 4;
    const dPos   = new THREE.Vector3(DEPT_R * Math.cos(dAngle), dy, DEPT_R * Math.sin(dAngle));

    // 부서 Object3D
    const dObj = new THREE.Object3D();
    dObj.position.copy(dPos);
    dObj.userData = { isDept: true, deptId: dept.id, deptName: dept.name, color: dept.color, icon: dept.icon, orbitR: DEPT_R, orbitAngle: dAngle, orbitSpeed: 0.010 + di * 0.002, orbitCenter: new THREE.Vector3(0,0,0) };
    scene.add(dObj); planetMeshes.push(dObj);

    _teamNodes.push({ type: 'department', pos: dPos.clone(), obj: dObj, label: `${dept.icon} ${dept.name}`, sublabel: `${dept.members.length}명`, color: dept.color, size: 'lg', deptId: dept.id, deptData: dept });

    // 중심→부서 연결선
    { const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), dPos.clone()]); const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(dept.color), transparent: true, opacity: 0.35 }); connections.push(new THREE.Line(lg, lm)); scene.add(connections[connections.length-1]); }

    // 부서 궤도 링 (팀원)
    { const r = new THREE.Mesh(new THREE.RingGeometry(MBR_R - 0.06, MBR_R + 0.06, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(dept.color), transparent: true, opacity: 0.08, side: THREE.DoubleSide })); r.position.copy(dPos); r.rotation.x = Math.PI / 2; orbitRings.push(r); scene.add(r); }

    dept.members.forEach((member, mi) => {
      const mAng = (mi / dept.members.length) * Math.PI * 2 + (di * 1.1);
      const my   = (mi % 2 === 0 ? 1 : -1) * 1.2;
      const mPos = new THREE.Vector3(dPos.x + MBR_R * Math.cos(mAng), dPos.y + my, dPos.z + MBR_R * Math.sin(mAng));

      const mObj = new THREE.Object3D();
      mObj.position.copy(mPos);
      mObj.userData = { isTeamMember: true, isDeptMember: true, memberId: member.id, deptId: dept.id, name: member.name, role: member.role, color: member.color, orbitR: MBR_R, orbitAngle: mAng, orbitSpeed: 0.022 + mi * 0.005, orbitCenter: dPos.clone() };
      scene.add(mObj); satelliteMeshes.push(mObj);

      _teamNodes.push({ type: 'member', pos: mPos.clone(), obj: mObj, label: member.name, sublabel: member.role, color: member.color, size: 'md', memberId: member.id, deptId: dept.id });

      // 부서→팀원 연결선
      { const lg = new THREE.BufferGeometry().setFromPoints([dPos.clone(), mPos.clone()]); const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.3 }); connections.push(new THREE.Line(lg, lm)); scene.add(connections[connections.length-1]); }

      // 작업 위성
      member.tasks.forEach((task, ti) => {
        const tAng = (ti / member.tasks.length) * Math.PI * 2 + (mi * 1.3 + di * 0.8);
        const tPos = new THREE.Vector3(mPos.x + CTASK_R * Math.cos(tAng), mPos.y + CTASK_R * 0.3 * Math.sin(tAng + 0.8), mPos.z + CTASK_R * Math.sin(tAng));
        const tObj = new THREE.Object3D(); tObj.position.copy(tPos);
        tObj.userData = { isTeamTask: true, memberId: member.id, deptId: dept.id, taskName: task.name, taskStatus: task.status, taskProgress: task.progress, color: STATUS_CFG[task.status]?.color || '#6e7681', orbitR: CTASK_R, orbitAngle: tAng, orbitSpeed: 0.05 + ti * 0.01, orbitCenter: mPos.clone() };
        scene.add(tObj); satelliteMeshes.push(tObj);
        const sc = STATUS_CFG[task.status] || STATUS_CFG.pending;
        _teamNodes.push({ type: 'task', pos: tPos.clone(), obj: tObj, label: task.name, emoji: sc.emoji, color: sc.color, progress: task.progress, size: 'xs', memberId: member.id, deptId: dept.id, taskStatus: task.status });
        { const lg = new THREE.BufferGeometry().setFromPoints([mPos.clone(), tPos.clone()]); const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(member.color), transparent: true, opacity: 0.14 }); connections.push(new THREE.Line(lg, lm)); scene.add(connections[connections.length-1]); }
      });

      // 스킬 위성
      (member.skills || []).forEach((sk, ski) => {
        const skAng = mAng - 0.6 + ski * 0.7;
        const skPos = new THREE.Vector3(mPos.x + SKILL_R * Math.cos(skAng), mPos.y - 2.5 - ski * 2, mPos.z + SKILL_R * Math.sin(skAng));
        const skObj = new THREE.Object3D(); skObj.position.copy(skPos);
        skObj.userData = { isTeamSkill: true, memberId: member.id, alias: sk.alias, config: sk.config, color: '#d2a8ff', relAngle: skAng, relY: -2.5 - ski * 2, relR: SKILL_R };
        scene.add(skObj); satelliteMeshes.push(skObj);
        _teamNodes.push({ type: 'skill', pos: skPos.clone(), obj: skObj, label: sk.alias, color: '#d2a8ff', size: 'xs', memberId: member.id, config: sk.config });
      });

      // 에이전트 위성
      (member.agents || []).forEach((ag, agi) => {
        const agAng = mAng + 0.6 + agi * 0.7;
        const agPos = new THREE.Vector3(mPos.x + AGENT_R * Math.cos(agAng), mPos.y - 3 - agi * 2.2, mPos.z + AGENT_R * Math.sin(agAng));
        const agObj = new THREE.Object3D(); agObj.position.copy(agPos);
        agObj.userData = { isTeamAgent: true, memberId: member.id, alias: ag.alias, config: ag.config, color: '#39d2c0', relAngle: agAng, relY: -3 - agi * 2.2, relR: AGENT_R };
        scene.add(agObj); satelliteMeshes.push(agObj);
        _teamNodes.push({ type: 'agent', pos: agPos.clone(), obj: agObj, label: ag.alias, color: '#39d2c0', size: 'xs', memberId: member.id, config: ag.config, autoRun: ag.config?.autoRun });
      });
    });
  });

  // ── 크로스-부서 협업 라인 (불타오르는 이펙트) ───────────────────────────────
  _collabLines.forEach(l => { scene.remove(l.line); if(l.outerLine) scene.remove(l.outerLine); });
  _collabLines = [];
  const crossDrawn = new Set();
  departments.forEach(dept => {
    (dept.members || []).forEach(member => {
      const mNode = _teamNodes.find(n => n.type === 'member' && n.memberId === member.id);
      if (!mNode) return;
      (member.collab || []).forEach(targetId => {
        const pairKey = [member.id, targetId].sort().join('-');
        if (crossDrawn.has(pairKey)) return;
        crossDrawn.add(pairKey);
        const targetNode = _teamNodes.find(n => n.type === 'member' && n.memberId === targetId);
        if (!targetNode) return;
        const isCrossDept = mNode.deptId !== targetNode.deptId;

        // 외곽 글로우 (굵음, 낮은 투명도, 덧셈 블렌딩)
        const outerGeo = new THREE.BufferGeometry().setFromPoints([mNode.pos.clone(), targetNode.pos.clone()]);
        const outerMat = new THREE.LineBasicMaterial({
          color: isCrossDept ? 0xff6e00 : 0x39d2c0,
          transparent: true, opacity: isCrossDept ? 0.35 : 0.25,
          blending: isCrossDept ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const outerLine = new THREE.Line(outerGeo, outerMat);
        scene.add(outerLine);

        // 내부 코어 라인
        const lg = new THREE.BufferGeometry().setFromPoints([mNode.pos.clone(), targetNode.pos.clone()]);
        const lm = new THREE.LineBasicMaterial({
          color: isCrossDept ? 0xffcc44 : 0x39d2c0,
          transparent: true, opacity: isCrossDept ? 0.75 : 0.55,
          blending: isCrossDept ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const ln = new THREE.Line(lg, lm);
        scene.add(ln);
        _collabLines.push({
          line: ln, mat: lm, outerLine, outerMat,
          phase: Math.random() * Math.PI * 2,
          fromNode: mNode, toNode: targetNode, crossDept: isCrossDept,
        });
      });
    });
  });

  const totalMembers = departments.reduce((s, d) => s + d.members.length, 0);
  const totalTasks   = departments.reduce((s, d) => s + d.members.reduce((ss, m) => ss + m.tasks.length, 0), 0);
  document.getElementById('h-sessions').textContent = departments.length;
  document.getElementById('h-tasks').textContent    = totalTasks;
  document.getElementById('h-hours').textContent    = '회사';
  document.getElementById('team-mode-badge').style.display = 'flex';
  document.querySelector('.tm-label').textContent = '🏢 회사 시뮬레이션';

  // 뷰 자동 맞춤 + 사이드바
  autoFitView(_teamNodes);
  updateMyTaskSidebar();
}

async function loadTeamDemo() {
  if (typeof track === 'function') track('view.mode_switch', { from: 'personal', to: 'team' });

  // orbitUser JSON에서 토큰 추출 (로그인 시 저장되는 형식에 맞게)
  const _u = typeof _orbitUser !== 'undefined' ? _orbitUser : JSON.parse(localStorage.getItem('orbitUser') || 'null');
  const token = _u?.token;

  // ── 비로그인 → 로그인 요청 (샘플 표시 안 함) ──────────────────────────
  if (!token) {
    showToast('👥 팀 화면은 로그인 후 이용 가능합니다');
    setTimeout(() => openLoginModal(), 400);
    return;
  }

  // ── 로그인 → 실제 워크스페이스 데이터 시도 ───────────────────────────
  try {
    const res = await fetch('/api/workspace/team-view', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.members && data.members.length > 0) {
        buildTeamSystem(data);
        updateBreadcrumb('team');
        document.querySelector('.tm-label').textContent = '👥 실제 팀 데이터';
        localStorage.setItem(_VIEW_MODE_KEY, 'team');
        return;
      }
    }
  } catch {}

  // 로그인 상태인데 팀 데이터 없음 → 팀 초대 안내
  _showNoTeamDataToast('team');
}
window.loadTeamDemo = loadTeamDemo;

async function loadCompanyDemo() {
  if (typeof track === 'function') track('view.mode_switch', { from: 'team', to: 'company' });

  const _u = typeof _orbitUser !== 'undefined' ? _orbitUser : JSON.parse(localStorage.getItem('orbitUser') || 'null');
  const token = _u?.token;

  // ── 비로그인 → 로그인 요청 (샘플 표시 안 함) ──────────────────────────
  if (!token) {
    showToast('🏢 전사 화면은 로그인 후 이용 가능합니다');
    setTimeout(() => openLoginModal(), 400);
    return;
  }

  // ── 로그인 → 실제 워크스페이스 데이터 시도 ───────────────────────────
  try {
    const res = await fetch('/api/workspace/company-view', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.departments && data.departments.length > 0) {
        buildCompanySystem(data);
        updateBreadcrumb('company');
        document.querySelector('.tm-label').textContent = '🏢 실제 회사 데이터';
        localStorage.setItem(_VIEW_MODE_KEY, 'company');
        return;
      }
    }
  } catch {}

  // 로그인 상태인데 회사 데이터 없음 → 안내
  _showNoTeamDataToast('company');
}
window.loadCompanyDemo = loadCompanyDemo;

// 로그인 상태에서 팀/회사 데이터 없을 때 안내
function _showNoTeamDataToast(type) {
  const msg = type === 'team'
    ? '👥 팀 데이터 없음 — 팀원을 초대하거나 팀에 합류하세요'
    : '🏢 회사 데이터 없음 — 팀장에게 초대를 요청하세요';
  // showToast 함수로 안내
  if (typeof showToast === 'function') showToast(msg, 4000);
  // 가이드 팝업 열기 유도 (샘플 체험 버튼 포함)
  setTimeout(() => openGuidePopup(), 500);
}

// 가이드에서만 사용하는 샘플 강제 로드 함수 (로그인 무관)
function _loadSampleTeam() {
  buildTeamSystem(TEAM_DEMO);
  updateBreadcrumb('team');
  seedDemoTalentBoard('team');
  document.querySelector('.tm-label').textContent = '👥 팀 샘플 (가이드)';
  setTimeout(checkHelperSuggestions, 2500);
}
window._loadSampleTeam = _loadSampleTeam;

function _loadSampleCompany() {
  buildCompanySystem(COMPANY_DEMO);
  updateBreadcrumb('company');
  seedDemoTalentBoard('company');
  document.querySelector('.tm-label').textContent = '🏢 전사 샘플 (가이드)';
}
window._loadSampleCompany = _loadSampleCompany;

function loadParallelDemo() {
  if (typeof track === 'function') track('view.mode_switch', { from: 'personal', to: 'parallel' });
  buildParallelView(PARALLEL_DEMO);
  document.getElementById('parallel-mode-badge').style.display = 'flex';
  runParallelDemo();
  localStorage.setItem(_VIEW_MODE_KEY, 'parallel');
}
window.loadParallelDemo = loadParallelDemo;

