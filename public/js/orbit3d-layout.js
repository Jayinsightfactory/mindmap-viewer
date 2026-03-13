/* orbit3d-layout.js — Layout & positioning logic (extracted from render) */

// ─── 팀원 클러스터 렌더링 (월드 줌아웃 시 등장) ──────────────────────────────
// 월드 좌표 오프셋에 각 팀원의 작업 허브를 그림
// worldScale < 0.85 에서 서서히 등장 (페이드인)
// 팀원 월드 오프셋 (px, scale=1.0 기준)
// 줌아웃(scale≈0.5)에서 화면 가장자리에 등장하도록 설정
const _TEAM_WORLD_POS = [
  [ 480,    0], [-480,    0],
  [ 240,  380], [-240,  380],
  [ 240, -380], [-240, -380],
  [ 520,  300], [-520,  300],
];

// ctx는 이미 월드 트랜스폼(translate+scale)이 적용된 상태로 호출됨
// 모든 드로잉은 월드 좌표계, hitArea는 월드 좌표 (함수 끝에서 일괄 스크린 변환)
function _drawTeamClusters(ctx, txX, txY, W, H, scale) {
  const data = window._teamWorldData;

  // 페이드인: scale 0.75→0.5 구간에서 0→1 알파
  const fadeAlpha = Math.min(1, Math.max(0, (0.75 - scale) / 0.25));
  if (fadeAlpha <= 0) return;

  // 팀 데이터 없으면 초대 플레이스홀더 표시
  if (!data?.members?.length) {
    _TEAM_WORLD_POS.slice(0, 2).forEach(([wox, woy]) => {
      const scx = wox * scale + txX, scy = woy * scale + txY;
      if (scx < -200 || scx > W + 200 || scy < -200 || scy > H + 200) return;
      ctx.save();
      ctx.globalAlpha = fadeAlpha * 0.45;
      drawUnifiedCard(ctx, wox, woy, '#4a5568', '+ 팀원 초대', '워크스페이스에 팀원 추가', false, false, false);
      ctx.restore();
    });
    return;
  }

  data.members.forEach((m, i) => {
    const [wox, woy] = _TEAM_WORLD_POS[i] || [900 + i * 200, 0];
    const scx = wox * scale + txX, scy = woy * scale + txY;

    // 화면 밖이면 스킵
    if (scx < -200 || scx > W + 200 || scy < -200 || scy > H + 200) return;

    const color = m.color || '#58a6ff';
    const name  = m.name  || '팀원';
    const activeTasks = (m.tasks || []).filter(t => t.status === 'active').length;
    const totalTasks  = (m.tasks || []).length;

    ctx.save();
    ctx.globalAlpha = fadeAlpha;

    // ── 허브 카드 (월드 좌표) ──
    drawUnifiedCard(ctx, wox, woy, color, `👤 ${name}`, `${activeTasks}개 진행 · ${totalTasks}개 총`, activeTasks > 0, false, false);

    // ── 미니 작업 카드 (최대 3개) ──
    const tasks = (m.tasks || []).slice(0, 3);
    tasks.forEach((task, ti) => {
      const tAngle = -Math.PI / 2 + (ti - (tasks.length - 1) / 2) * 0.65;
      const tDist  = 110;
      const tx = wox + Math.cos(tAngle) * tDist;
      const ty = woy + Math.sin(tAngle) * tDist;
      const tColor = task.status === 'active' ? '#3fb950' : task.status === 'done' ? '#58a6ff' : '#6e7681';
      const tName  = (task.name || '작업').slice(0, 12) + ((task.name || '').length > 12 ? '…' : '');

      // 연결선
      ctx.globalAlpha = fadeAlpha * 0.2;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(wox, woy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = fadeAlpha * 0.85;
      drawUnifiedCard(ctx, tx, ty, tColor, tName, task.status === 'active' ? '진행중' : '완료', task.status === 'active', false, false);
    });

    // 히트 영역 (월드 좌표 → drawCompactProjectView 끝에서 스크린 좌표 변환)
    registerHitArea({
      cx: wox, cy: woy, r: 60,
      obj: null,
      data: { type: 'teamMember', memberId: m.userId || m.id, memberName: name, color, member: m },
    });

    ctx.restore();
  });
}

// ─── 1단계: 프로젝트 노드 뷰 (방사형 + 밝은 테마) ──────────────────────────
// ME 노드 중심, 프로젝트를 원형 배치, 클릭 시 2단계 카테고리 링 전개
function drawCompactProjectView() {
  const projNames = Object.keys(_projectGroups);
  if (projNames.length === 0) return;

  const now = performance.now() / 1000;
  const ctx = _lctx;

  // ── 기준점: 2D 월드 팬 오프셋 기반 (좌클릭 드래그로 탐색) ────────────────
  const W = _labelCanvas2d.width, H = _labelCanvas2d.height;
  const _wPanX = window._worldPanX || 0;
  const _wPanY = window._worldPanY || 0;
  const _wScale = window._worldScale || 1.0;
  // 월드 원점의 스크린 좌표 (드릴다운 시프트로 조정됨)
  let _txX = W / 2 + _wPanX;
  let _txY = H / 2 + _wPanY;

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
  }).filter(p => p.eventCount > 0 && !_hiddenNodes[p.name]).sort((a,b) => b.eventCount - a.eventCount);

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

  // ── 레이아웃 계산 (드릴다운 시프트 포함, 드로잉 전) ─────────────────────
  const meW = 130, meH = 48, meR = meH / 2;
  const NODE_GAP = 6;
  const LAYER_OFFSET = UNI_CARD_W + 8;
  const isDrillStage1 = _drillStage >= 1 && _drillProject;
  const baseAngle = -Math.PI / 2;
  const angleStep = (Math.PI * 2) / projects.length;

  // ── 균일 거리 배치: ME 노드 원형 취급 + 카드 대각선 반경 고정 ──
  // 기존: 각도별 사각형 edge 계산 → 불균일 거리
  // 수정: 모든 각도에서 동일 거리 (시각적 균일성 보장)
  const ME_RADIUS = Math.max(meW, meH) / 2;            // ME 외접원
  const CARD_RADIUS = Math.sqrt(UNI_CARD_W * UNI_CARD_W + UNI_CARD_H * UNI_CARD_H) / 2; // 카드 대각선/2
  const CARD_GAP_MIN = 10;
  let _minRadius = 0;
  if (projects.length > 1) {
    const sinHalf = Math.sin(angleStep / 2);
    if (sinHalf > 0) _minRadius = (CARD_RADIUS + CARD_GAP_MIN / 2) / sinHalf;
  }
  const FIXED_NODE_DIST = Math.max(ME_RADIUS + NODE_GAP + CARD_RADIUS, _minRadius);
  function getNodeDist(/* theta */) {
    return FIXED_NODE_DIST;
  }

  // ── 드릴다운 시 월드 원점 이동 (드릴 방향 반대로 밀어 체인이 화면 안에 들어오게) ──
  if (isDrillStage1) {
    const drillIdx = projects.findIndex(p => p.name === _drillProject.name);
    if (drillIdx >= 0) {
      const drillAngle = baseAngle + drillIdx * angleStep;
      const dX = Math.cos(drillAngle), dY = Math.sin(drillAngle);
      // 화면 픽셀 기준 필요 전개 거리
      const totalExpand = (getNodeDist(drillAngle) + 200 + (UNI_CARD_H + 8) * 2) * _wScale;
      const SIDEBAR_W = 210, marginR = 40, marginT = 80, marginB = 60;
      const availX = dX > 0 ? W - _txX - marginR : _txX - SIDEBAR_W;
      const availY = dY > 0 ? H - _txY - marginB : _txY - marginT;
      _txX -= dX * Math.max(0, Math.abs(dX) * totalExpand - availX);
      _txY -= dY * Math.max(0, Math.abs(dY) * totalExpand - availY);
    }
  }

  // ── 캔버스 월드 트랜스폼 적용 (이하 모든 드로잉이 월드 좌표계로 동작) ─────
  // 효과: 줌아웃 시 카드 크기도 함께 축소 → 겹침 완전 방지
  ctx.save();
  ctx.translate(_txX, _txY);
  ctx.scale(_wScale, _wScale);

  // ── ME 노드 (월드 원점 = 0, 0) ─────────────────────────────────────────────
  const meLx = -meW / 2, meLy = -meH / 2;
  ctx.save();
  ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
  ctx.shadowColor = 'rgba(6,182,212,0.15)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 0;
  roundRect(ctx, meLx, meLy, meW, meH, meR); ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
  ctx.restore();
  drawWireframeGrid(ctx, meLx, meLy, meW, meH, meR, 'rgba(6,182,212,1)', 0.22);
  ctx.strokeStyle = 'rgba(6,182,212,0.5)'; ctx.lineWidth = 1.5;
  roundRect(ctx, meLx, meLy, meW, meH, meR); ctx.stroke();
  ctx.font = "700 16px 'Inter',-apple-system,sans-serif";
  ctx.textAlign = 'center';
  ctx.fillStyle = '#e2e8f0';
  ctx.fillText('나의 작업', 0, 6);

  // 라벨 별칭 맵 (인라인 편집 저장본)
  const _aliases = (() => { try { return JSON.parse(localStorage.getItem('orbitLabelAliases') || '{}'); } catch { return {}; } })();

  projects.forEach((proj, i) => {
    // 360도 방사형: ME 박스 테두리에 밀착 (월드 좌표계, 트랜스폼이 스케일 적용)
    const angle = baseAngle + i * angleStep;
    const isThisDrilled = isDrillStage1 && _drillProject.name === proj.name;
    const nodeDist = getNodeDist(angle);
    const cx = Math.cos(angle) * nodeDist;
    const cy = Math.sin(angle) * nodeDist;
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

    // 카드 내 버튼 (편집·숨기기) — hover 시에만 표시
    if (!dimmed) drawCardIcons(ctx, cx, cy, proj.name, projTitle, isHover, _hitAreas);

    // ME → 프로젝트 연결선
    {
      ctx.save();
      ctx.globalAlpha = dimmed ? 0.1 : 0.18;
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(cx, cy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 히트 영역 (카드 전체 — 버튼 히트 영역은 drawCardIcons에서 이미 추가)
    registerHitArea({
      cx, cy, r: Math.max(UNI_CARD_W, UNI_CARD_H) / 2 + 6,
      obj: null,
      data: { type: 'constellation', projName: proj.name, planetCount: proj.planets.length, color, info },
    });

    // ══ 2단계: 카테고리 + 세션 — outward 방향 순차 스택 ══════════════════════
    if (isThisDrilled && proj.planets.length > 0) {
      const catGroups = {};
      proj.planets.forEach(planet => {
        const cat = planet.userData.macroCat || 'general';
        if (!catGroups[cat]) catGroups[cat] = [];
        catGroups[cat].push(planet);
      });
      const sortedCats = Object.entries(catGroups).sort((a, b) => b[1].length - a[1].length);

      // 프로젝트 → ME 방향 단위 벡터 (월드 원점 = 0,0)
      const dx = cx, dy = cy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const dirX = dx / dist, dirY = dy / dist;  // outward 방향
      const perpX = -dirY, perpY = dirX;          // 수직(perp) 방향

      // 균일 간격: 방향 무관 고정값 (카드 대각선 기준)
      const outwardStep = CARD_RADIUS * 2;
      const perpStep    = CARD_RADIUS * 2;
      const CARD_GAP = 8;

      // ── 카테고리: 부채꼴(fan) 배치 — dirAngle 기준 ±각도로 균등 배분 ──────
      const numCatsNow = sortedCats.length;
      const dirAngle = Math.atan2(dirY, dirX);
      const CAT_DIST = 200;  // 프로젝트 카드 → 카테고리 카드 거리 (월드 좌표, 트랜스폼이 스케일 적용)
      // 비겹침 최소 각도: 카드 edge 간 간격 확보
      const catAngleStep = Math.max(
        2 * Math.asin(Math.min((UNI_CARD_W + CARD_GAP) / (2 * CAT_DIST), 1)),
        Math.PI / 8  // 최소 22.5°
      );
      // 최대 halfSpan 150° 캡 — 8개 이상 카테고리에서 wrap-around 방지
      const catHalfSpan = Math.min((numCatsNow - 1) / 2 * catAngleStep, Math.PI * 5 / 6);

      sortedCats.forEach(([catKey, catPlanets], ci) => {
        const cfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
        // 카테고리 각도: dirAngle ± catHalfSpan에서 균등 배분
        const catAngle = numCatsNow === 1 ? dirAngle : dirAngle - catHalfSpan + ci * catAngleStep;
        const catDirX = Math.cos(catAngle), catDirY = Math.sin(catAngle);
        const catCx = cx + catDirX * CAT_DIST;
        const catCy = cy + catDirY * CAT_DIST;

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

        registerHitArea({
          cx: catCx, cy: catCy, r: Math.max(UNI_CARD_W, UNI_CARD_H) / 2 + 4,
          obj: null,
          data: {
            type: 'drillCategory', catKey,
            catLabel: cfg.label, catColor: cfg.color, catIcon: cfg.icon,
            projName: proj.name, planets: catPlanets, sessionCount: catSessionCount,
          },
        });

        // ── 세션: 카테고리 카드 아래로 수직 정렬 — 카테고리 카드와 겹침 방지 ──
        const sesStep = UNI_CARD_H + CARD_GAP;  // 51 + 8 = 59px 고정 간격
        const maxShow = Math.min(catPlanets.length, 3);
        // 카테고리 카드 아래쪽에서 시작 (catCy + UNI_CARD_H/2 + CARD_GAP)
        const sesStartY = catCy + UNI_CARD_H / 2 + CARD_GAP + UNI_CARD_H / 2;
        for (let si = 0; si < maxShow; si++) {
          const planet = catPlanets[si];
          const sx = catCx;                // 카테고리와 같은 X (수직 정렬)
          const sy = sesStartY + si * sesStep;  // 카테고리 아래로 일렬 배치

          const evCnt = planet.userData.eventCount || 0;
          const isSubHover = _hoveredHit?.obj === planet;
          const sesKey = planet.userData.clusterId || planet.userData.sessionId || '';
          // Label — alias override or derive from userData (label-rules.js)
          let sLabel = _aliases[sesKey] || normalizeLabel(planet.userData.intent || '', 26);
          if (!sLabel) sLabel = deriveDisplayLabel(planet.userData, 26);
          const sesSub = evCnt > 0 ? `${evCnt}개 작업` : '';

          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = cfg.color; ctx.lineWidth = 0.8;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(catCx, catCy); ctx.lineTo(sx, sy); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          drawUnifiedCard(ctx, sx, sy, cfg.color, sLabel, sesSub, false, isSubHover, false);

          registerHitArea({
            cx: sx, cy: sy, r: Math.max(UNI_CARD_W, UNI_CARD_H) / 2 + 4,
            obj: planet,
            data: { type: 'drillSession', intent: planet.userData.intent,
                    clusterId: planet.userData.clusterId,
                    sessionId: planet.userData.sessionId,
                    eventCount: evCnt, hueHex: cfg.color,
                    catKey, catLabel: cfg.label, catColor: cfg.color, catIcon: cfg.icon,
                    projName: proj.name, planets: catPlanets },
          });
        }

        if (catPlanets.length > maxShow) {
          const mx = catCx;
          const my = sesStartY + (maxShow - 1) * sesStep + UNI_CARD_H / 2 + 10;  // 마지막 세션 아래
          ctx.globalAlpha = 0.6;
          ctx.font = '400 10px -apple-system,sans-serif';
          ctx.fillStyle = cfg.color; ctx.textAlign = 'center';
          ctx.fillText(`+${catPlanets.length - maxShow}개`, mx, my + 4);
          ctx.globalAlpha = 1;
        }
      });
    }
  });

  // ── 팀원 클러스터 (worldScale < 0.75에서 페이드인, 월드 좌표계에서 렌더링) ─
  if (_wScale < 0.75) _drawTeamClusters(ctx, _txX, _txY, W, H, _wScale);

  // ── 월드 트랜스폼 해제 + hitArea 스크린 좌표 변환 ──────────────────────────
  ctx.restore();
  _hitAreas.forEach(h => {
    h.cx = h.cx * _wScale + _txX;
    h.cy = h.cy * _wScale + _txY;
    h.r  = h.r  * _wScale;
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

    // Label determination — single source of truth: orbit3d-label-rules.js
    const text = deriveDisplayLabel(p.userData, 26);
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
    registerHitArea({
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
const LABEL_PADDING = 12; // 라벨 간 최소 간격

function rectOverlaps(x, y, w, h) {
  for (const r of _usedRects) {
    // 패딩을 포함한 엄격한 겹침 검사
    if (x < r.x + r.w + LABEL_PADDING &&
        x + w + LABEL_PADDING > r.x &&
        y < r.y + r.h + LABEL_PADDING &&
        y + h + LABEL_PADDING > r.y) {
      return true;
    }
  }
  return false;
}

function reserveRect(x, y, w, h) {
  _usedRects.push({ x, y, w, h });
}
