'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — 라벨 렌더링 + 기능목록 + 줌요약 + 학습위젯 + 스킬링
// [orbit3d-render.js에서 분할]
// ══════════════════════════════════════════════════════════════════════════════

function drawLabels() {
  _lctx.clearRect(0, 0, innerWidth, innerHeight);
  clearHitAreas();
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

  // 행성 위치 보간: 개인 모드에서는 2D 캔버스 뷰이므로 3D 위치 이동 스킵
  if (!isPersonalMode) {
    planetMeshes.forEach(p => {
      const inFocusedCat  = focusedCat && p.userData.macroCat === focusedCat;
      const inFocusedProj = focusedProj && p.userData.projectName === focusedProj;
      const inSelectedProj = selectedProj && p.userData.projectName === selectedProj;
      const targetExpanded = inFocusedCat || inFocusedProj || inSelectedProj;

      let target;
      if (targetExpanded && p.userData._levelPositions) {
        const currentLevel = p.userData._currentLevel || 0;
        if (currentLevel === 0) {
          target = p.userData._levelPositions.compact;
        } else {
          target = p.userData._levelPositions[`level${currentLevel}`] || p.userData._levelPositions.compact;
        }
      } else {
        target = p.userData._compactPos;
      }

      if (target) p.position.lerp(target, 0.08);
    });
  }

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

    // ── 텍스트 겹침 방지 — 지능형 위치 조정 ───────────────────────────────
    // 여러 방향과 거리를 시도해서 최적의 위치 찾기
    let bestOffX = 0, bestOffY = 0;
    let foundNoOverlap = !rectOverlaps(lx - 4, ly - 4, pw + 8, ph + 30);

    if (!foundNoOverlap) {
      // 화면 중심에서의 거리와 각도
      const ndx = sc.x - innerWidth / 2, ndy = sc.y - innerHeight / 2;
      const nDist = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
      const baseStepSize = Math.max(ph, pw) * 0.8;

      // 8방향 + 거리 조정 시도
      const directions = [
        { x: ndx/nDist, y: ndy/nDist },  // 바깥쪽
        { x: -ndy/nDist, y: ndx/nDist }, // 우측
        { x: ndy/nDist, y: -ndx/nDist }, // 좌측
        { x: -ndx/nDist, y: -ndy/nDist }, // 안쪽
        { x: 1, y: 0 }, // 우측
        { x: -1, y: 0 }, // 좌측
        { x: 0, y: -1 }, // 위
        { x: 0, y: 1 }   // 아래
      ];

      // 각 방향별로 여러 거리 시도
      for (const dir of directions) {
        for (let dist = 1; dist <= 6; dist++) {
          const testX = dir.x * baseStepSize * dist;
          const testY = dir.y * baseStepSize * dist;

          if (!rectOverlaps(lx + testX - 4, ly + testY - 4, pw + 8, ph + 30)) {
            bestOffX = testX;
            bestOffY = testY;
            foundNoOverlap = true;
            break;
          }
        }
        if (foundNoOverlap) break;
      }
    }

    // 겹침 방지 - 오프셋을 적용했으면 기록
    if (foundNoOverlap || rectOverlaps(lx + bestOffX - 4, ly + bestOffY - 4, pw + 8, ph + 30)) {
      reserveRect(lx + bestOffX - 4, ly + bestOffY - 4, pw + 8, ph + 30);
    }

    // 오프셋 적용
    sc.x += bestOffX; sc.y += bestOffY;
    const _lx = lx + bestOffX, _ly = ly + bestOffY;

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
    registerHitArea({
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
    registerHitArea({
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
    }).catch(e => console.warn('[speech] 음성 데이터 전송 실패:', e.message));
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
