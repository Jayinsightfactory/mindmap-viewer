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

// ─── 1단계: 유니버스 뷰 (프로젝트=태양계, 세션=행성, 이벤트=위성) ─────────
// ME 노드 중심, 프로젝트를 태양계로 방사형 배치, 각 태양계 안에 세션 행성이 궤도
function drawCompactProjectView() {
  const projNames = Object.keys(_projectGroups);
  if (projNames.length === 0) return;

  const now = performance.now() / 1000;
  const ctx = _lctx;

  // ── 기준점: 2D 월드 팬 오프셋 기반 ────────────────────────────────────────
  const W = _labelCanvas2d.width, H = _labelCanvas2d.height;
  const _wPanX = window._worldPanX || 0;
  const _wPanY = window._worldPanY || 0;
  const _wScale = window._worldScale || 1.0;
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
    planets.forEach(p => { const c = p.userData.macroCat || 'general'; catCounts[c] = (catCounts[c] || 0) + 1; });
    const topCats = Object.entries(catCounts).sort((a,b) => b[1] - a[1]);
    const topCat = topCats[0]?.[0] || 'general';
    const topCfg = PROJECT_TYPES[topCat] || PROJECT_TYPES.general;
    const exts = {};
    planets.forEach(p => {
      const entry = _sessionMap[p.userData.clusterId]; if (!entry) return;
      for (const e of entry.events) { const f = (e.data?.filePath||e.data?.fileName||''); const m = f.match(/\.([a-z]{1,6})$/i); if (m) exts[m[1].toLowerCase()] = (exts[m[1].toLowerCase()]||0)+1; }
    });
    const topExts = Object.entries(exts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([e])=>e);
    const rawName = proj.name;
    let smartName;
    if (rawName && rawName !== '기타' && !/^세션-/.test(rawName)) {
      smartName = rawName.split(/[-_]/).filter(s=>s!=='session').map(s=>s.charAt(0).toUpperCase()+s.slice(1)).join(' ');
    } else {
      const stack = topExts.length>0 ? topExts.join('+').toUpperCase() : '';
      smartName = stack ? `${stack} ${topCfg.label}` : topCfg.label+' 프로젝트';
    }
    const allFiles = new Set();
    planets.forEach(p => { const entry = _sessionMap[p.userData.clusterId]; if (!entry) return; for (const e of entry.events) { const f=(e.data?.filePath||e.data?.fileName||''); if(f) allFiles.add(f.split(/[\\/]/).pop()); }});
    return { name: smartName.slice(0,24), icon: topCfg.icon, catBreakdown: topCats.slice(0,3).map(([k,v])=>{ const cfg=PROJECT_TYPES[k]||PROJECT_TYPES.general; return {key:k,label:cfg.label,icon:cfg.icon,count:v,color:cfg.color}; }), fileCount: allFiles.size, sessionCount: planets.length, techStack: topExts.join(' · ')||'' };
  }

  // ── 레이아웃: 태양계 간 거리 계산 ─────────────────────────────────────────
  const isDrillStage1 = _drillStage >= 1 && _drillProject;
  const baseAngle = -Math.PI / 2;
  const angleStep = (Math.PI * 2) / projects.length;

  // 태양계 크기: 세션 수에 따라 궤도 반경 결정
  const SUN_R = 32;                    // 태양(프로젝트) 반경
  const ORBIT_BASE = 70;               // 최소 궤도 반경
  const ORBIT_PER_PLANET = 18;         // 행성당 추가 궤도 반경
  const SOLAR_SYSTEM_GAP = 60;         // 태양계 간 간격

  // 각 태양계의 실제 반경 계산
  const solarRadii = projects.map(p => ORBIT_BASE + Math.min(p.planets.length, 8) * ORBIT_PER_PLANET);
  // 인접 태양계 간 겹침 방지를 위한 최소 거리
  const maxSolarR = Math.max(...solarRadii);
  let CENTER_DIST = maxSolarR * 2 + SOLAR_SYSTEM_GAP;
  if (projects.length > 1) {
    const sinHalf = Math.sin(angleStep / 2);
    if (sinHalf > 0) CENTER_DIST = Math.max(CENTER_DIST, (maxSolarR + SOLAR_SYSTEM_GAP / 2) / sinHalf);
  }

  // 드릴다운 시 시프트
  if (isDrillStage1) {
    const drillIdx = projects.findIndex(p => p.name === _drillProject.name);
    if (drillIdx >= 0) {
      const drillAngle = baseAngle + drillIdx * angleStep;
      const dX = Math.cos(drillAngle), dY = Math.sin(drillAngle);
      const totalExpand = (CENTER_DIST + solarRadii[drillIdx] + 100) * _wScale;
      const SIDEBAR_W = 210, marginR = 40, marginT = 80, marginB = 60;
      const availX = dX > 0 ? W - _txX - marginR : _txX - SIDEBAR_W;
      const availY = dY > 0 ? H - _txY - marginB : _txY - marginT;
      _txX -= dX * Math.max(0, Math.abs(dX) * totalExpand - availX);
      _txY -= dY * Math.max(0, Math.abs(dY) * totalExpand - availY);
    }
  }

  // ── 캔버스 월드 트랜스폼 적용 ──────────────────────────────────────────────
  ctx.save();
  ctx.translate(_txX, _txY);
  ctx.scale(_wScale, _wScale);

  // ── ME 노드 (유니버스 중심) ────────────────────────────────────────────────
  const meR2 = 36;
  ctx.save();
  // 글로우
  const meGrad = ctx.createRadialGradient(0, 0, meR2 * 0.3, 0, 0, meR2 * 1.8);
  meGrad.addColorStop(0, 'rgba(6,182,212,0.15)');
  meGrad.addColorStop(1, 'rgba(6,182,212,0)');
  ctx.fillStyle = meGrad;
  ctx.beginPath(); ctx.arc(0, 0, meR2 * 1.8, 0, Math.PI * 2); ctx.fill();
  // 코어
  const meCoreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, meR2);
  meCoreGrad.addColorStop(0, 'rgba(6,182,212,0.9)');
  meCoreGrad.addColorStop(0.7, 'rgba(6,182,212,0.4)');
  meCoreGrad.addColorStop(1, 'rgba(6,182,212,0.1)');
  ctx.fillStyle = meCoreGrad;
  ctx.beginPath(); ctx.arc(0, 0, meR2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(6,182,212,0.6)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, 0, meR2, 0, Math.PI * 2); ctx.stroke();
  ctx.font = "700 13px 'Inter',-apple-system,sans-serif";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('MY UNIVERSE', 0, 0);
  ctx.restore();

  // 라벨 별칭 맵
  const _aliases = (() => { try { return JSON.parse(localStorage.getItem('orbitLabelAliases') || '{}'); } catch { return {}; } })();

  // ── 태양계 렌더링 ─────────────────────────────────────────────────────────
  projects.forEach((proj, i) => {
    const angle = baseAngle + i * angleStep;
    const isThisDrilled = isDrillStage1 && _drillProject.name === proj.name;
    const sunCx = Math.cos(angle) * CENTER_DIST;
    const sunCy = Math.sin(angle) * CENTER_DIST;
    const isHover = _hoveredHit?.data?.type === 'constellation' && _hoveredHit?.data?.projName === proj.name;
    const color = proj.color;
    const info = analyzeProject(proj);
    const dimmed = isDrillStage1 && !isThisDrilled;
    const solarR = solarRadii[i];
    const numPlanets = Math.min(proj.planets.length, 12);

    if (dimmed) ctx.globalAlpha = 0.2;

    // ── ME → 태양계 연결선 (은하 링크) ──
    ctx.save();
    ctx.globalAlpha = (dimmed ? 0.05 : 0.12) * (ctx.globalAlpha || 1);
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(sunCx, sunCy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    if (dimmed) ctx.globalAlpha = 0.2;

    // ── 태양 (프로젝트 코어) ──
    ctx.save();
    // 태양 글로우
    const sunGlow = ctx.createRadialGradient(sunCx, sunCy, SUN_R * 0.2, sunCx, sunCy, SUN_R * 2.5);
    sunGlow.addColorStop(0, color + '40');
    sunGlow.addColorStop(0.5, color + '15');
    sunGlow.addColorStop(1, color + '00');
    ctx.fillStyle = sunGlow;
    ctx.beginPath(); ctx.arc(sunCx, sunCy, SUN_R * 2.5, 0, Math.PI * 2); ctx.fill();
    // 태양 코어
    const sunCore = ctx.createRadialGradient(sunCx, sunCy, 0, sunCx, sunCy, SUN_R);
    sunCore.addColorStop(0, '#fff');
    sunCore.addColorStop(0.3, color);
    sunCore.addColorStop(1, color + '80');
    ctx.fillStyle = sunCore;
    ctx.beginPath(); ctx.arc(sunCx, sunCy, SUN_R, 0, Math.PI * 2); ctx.fill();
    // 태양 테두리
    ctx.strokeStyle = isHover || isThisDrilled ? '#fff' : color;
    ctx.lineWidth = isHover ? 2 : isThisDrilled ? 2.5 : 1;
    ctx.beginPath(); ctx.arc(sunCx, sunCy, SUN_R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    // ── 태양 라벨 ──
    const projTitle = _aliases[proj.name] || `${info.icon} ${info.name}`;
    const projSub = `${info.sessionCount}세션 · ${info.fileCount}파일`;
    ctx.save();
    ctx.font = "700 12px 'Inter',-apple-system,sans-serif";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    let clippedTitle = projTitle;
    while (ctx.measureText(clippedTitle).width > SUN_R * 3.5 && clippedTitle.length > 1) clippedTitle = clippedTitle.slice(0, -1);
    if (clippedTitle !== projTitle) clippedTitle += '\u2026';
    ctx.fillText(clippedTitle, sunCx, sunCy - 5);
    ctx.font = "400 9px 'JetBrains Mono',monospace";
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(projSub, sunCx, sunCy + 8);
    ctx.restore();

    // 카드 내 버튼 (편집·숨기기)
    if (!dimmed && isHover) drawCardIcons(ctx, sunCx, sunCy, proj.name, projTitle, isHover, _hitAreas);

    // 히트 영역 (태양)
    registerHitArea({
      cx: sunCx, cy: sunCy, r: SUN_R + 8,
      obj: null,
      data: { type: 'constellation', projName: proj.name, planetCount: proj.planets.length, color, info },
    });

    // ── 궤도 링 + 행성 (세션) ──
    if (numPlanets > 0) {
      const planetAngleStep = (Math.PI * 2) / numPlanets;
      const orbitR = ORBIT_BASE + Math.min(numPlanets, 8) * (ORBIT_PER_PLANET * 0.6);

      // 궤도 링 (점선 원)
      ctx.save();
      ctx.globalAlpha = dimmed ? 0.08 : 0.15;
      ctx.strokeStyle = color; ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.arc(sunCx, sunCy, orbitR, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      if (dimmed) ctx.globalAlpha = 0.2;

      // 행성 렌더링
      const maxShow = isThisDrilled ? Math.min(numPlanets, 12) : Math.min(numPlanets, 6);
      for (let pi = 0; pi < maxShow; pi++) {
        const planet = proj.planets[pi];
        const pAngle = -Math.PI / 2 + pi * planetAngleStep + now * 0.05; // 느린 공전 애니메이션
        const px = sunCx + Math.cos(pAngle) * orbitR;
        const py = sunCy + Math.sin(pAngle) * orbitR;
        const evCnt = planet.userData.eventCount || 0;
        const pR = Math.max(6, Math.min(14, 6 + evCnt * 0.3)); // 이벤트 수에 비례한 크기
        const isSubHover = _hoveredHit?.obj === planet;
        const catKey = planet.userData.macroCat || 'general';
        const catCfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
        const pColor = catCfg.color || color;

        // 행성 본체
        ctx.save();
        if (isSubHover) {
          ctx.shadowColor = pColor; ctx.shadowBlur = 12;
        }
        const pGrad = ctx.createRadialGradient(px - pR * 0.3, py - pR * 0.3, 0, px, py, pR);
        pGrad.addColorStop(0, '#fff');
        pGrad.addColorStop(0.4, pColor);
        pGrad.addColorStop(1, pColor + '60');
        ctx.fillStyle = pGrad;
        ctx.beginPath(); ctx.arc(px, py, pR, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = isSubHover ? '#fff' : pColor + '80';
        ctx.lineWidth = isSubHover ? 1.5 : 0.8;
        ctx.beginPath(); ctx.arc(px, py, pR, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();

        // 행성 라벨 (드릴 시에만 또는 호버 시)
        if (isThisDrilled || isSubHover) {
          const sesKey = planet.userData.clusterId || planet.userData.sessionId || '';
          let sLabel = _aliases[sesKey] || normalizeLabel(planet.userData.intent || '', 18);
          if (!sLabel) sLabel = deriveDisplayLabel(planet.userData, 18);
          if (sLabel) {
            ctx.save();
            ctx.font = "500 9px 'Inter',-apple-system,sans-serif";
            ctx.textAlign = 'center';
            // 배경 pill
            const tw = ctx.measureText(sLabel).width;
            const pw = tw + 8, ph = 14;
            ctx.fillStyle = 'rgba(2,6,23,0.85)';
            roundRect(ctx, px - pw/2, py + pR + 3, pw, ph, 4); ctx.fill();
            ctx.fillStyle = '#e2e8f0';
            ctx.fillText(sLabel, px, py + pR + 12);
            if (evCnt > 0) {
              ctx.font = "400 7px monospace";
              ctx.fillStyle = '#6e7681';
              ctx.fillText(`${evCnt}작업`, px, py + pR + 22);
            }
            ctx.restore();
          }
        }

        // 행성 히트 영역
        registerHitArea({
          cx: px, cy: py, r: Math.max(pR + 4, 12),
          obj: planet,
          data: { type: 'drillSession', intent: planet.userData.intent,
                  clusterId: planet.userData.clusterId,
                  sessionId: planet.userData.sessionId,
                  eventCount: evCnt, hueHex: pColor,
                  catKey, catLabel: catCfg.label, catColor: catCfg.color, catIcon: catCfg.icon,
                  projName: proj.name, planets: proj.planets },
        });
      }

      // 추가 행성 표시
      if (proj.planets.length > maxShow) {
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.font = '500 10px -apple-system,sans-serif';
        ctx.fillStyle = color; ctx.textAlign = 'center';
        ctx.fillText(`+${proj.planets.length - maxShow}`, sunCx, sunCy + SUN_R + orbitR + 16);
        ctx.restore();
      }
    }

    ctx.globalAlpha = 1;
  });

  // ── 팀원 클러스터 ──
  if (_wScale < 0.75) _drawTeamClusters(ctx, _txX, _txY, W, H, _wScale);

  // ── 월드 트랜스폼 해제 + hitArea 스크린 변환 ──
  ctx.restore();
  _hitAreas.forEach(h => {
    h.cx = h.cx * _wScale + _txX;
    h.cy = h.cy * _wScale + _txY;
    h.r  = h.r  * _wScale;
  });
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
