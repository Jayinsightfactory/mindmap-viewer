/* orbit3d-layout.js — Layout & positioning logic (extracted from render) */

// ─── 와이어프레임 구체 그리기 유틸 ─────────────────────────────────────────────
// 투명 구체 + 위경선 라인 → 3D 느낌, 텍스트 시인성 확보
function _drawWireSphere(ctx, cx, cy, R, color, opts) {
  const { alpha, lineW, meridians, parallels, glow, hover, rotation } = Object.assign(
    { alpha: 0.35, lineW: 0.8, meridians: 3, parallels: 2, glow: true, hover: false, rotation: 0 },
    opts || {}
  );
  ctx.save();

  // 글로우 (외부 빛)
  if (glow) {
    const g = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 1.6);
    g.addColorStop(0, color + '18');
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, Math.PI * 2); ctx.fill();
  }

  // 미세 투명 채움 (유리 느낌)
  ctx.globalAlpha = hover ? 0.12 : 0.05;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

  // 적도 (외곽 원)
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = hover ? lineW * 1.8 : lineW;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  // 경선 (세로 타원 — 회전 적용)
  for (let m = 0; m < meridians; m++) {
    const angle = (m / meridians) * Math.PI + rotation;
    const scaleX = Math.abs(Math.cos(angle));
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R * Math.max(scaleX, 0.08), R, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 위선 (가로 타원)
  for (let p = 1; p <= parallels; p++) {
    const lat = (p / (parallels + 1));
    const y = cy + R * (lat * 2 - 1) * 0.7;
    const rX = R * Math.cos(Math.asin(lat * 2 - 1) * 0.7);
    if (rX > 2) {
      ctx.globalAlpha = alpha * 0.35;
      ctx.beginPath();
      ctx.ellipse(cx, y, rX, rX * 0.25, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // 호버 시 밝은 림
  if (hover) {
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R + 1, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();
}

// ─── 별 모양 경로 유틸 ────────────────────────────────────────────────────────
function _starPath(ctx, cx, cy, spikes, outerR, innerR, rotation) {
  const rot0 = (rotation || 0) - Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = rot0 + i * step;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    else ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
}

// ─── 팀원 클러스터 렌더링 (월드 줌아웃 시 등장) ──────────────────────────────
const _TEAM_WORLD_POS = [
  [ 380,    0], [-380,    0],
  [ 200,  300], [-200,  300],
  [ 200, -300], [-200, -300],
  [ 420,  240], [-420,  240],
];

function _drawTeamClusters(ctx, txX, txY, W, H, scale) {
  const data = window._teamWorldData;

  // 더 일찍 등장: scale 0.85→0.55 구간에서 0→1 알파
  const fadeAlpha = Math.min(1, Math.max(0, (0.85 - scale) / 0.30));
  if (fadeAlpha <= 0) return;

  // 팀 데이터 없으면 별 모양 초대 플레이스홀더
  if (!data?.members?.length) {
    const now = performance.now() / 1000;
    _TEAM_WORLD_POS.slice(0, 2).forEach(([wox, woy], idx) => {
      const scx = wox * scale + txX, scy = woy * scale + txY;
      if (scx < -200 || scx > W + 200 || scy < -200 || scy > H + 200) return;
      ctx.save();
      ctx.globalAlpha = fadeAlpha * 0.55;

      const starR = 32;
      const pulse = 1 + Math.sin(now * 1.5 + idx * Math.PI) * 0.06;
      const rot = now * 0.15 + idx * 0.5;

      // 별 와이어프레임
      _starPath(ctx, wox, woy, 5, starR * pulse, starR * 0.45 * pulse, rot);
      ctx.fillStyle = 'rgba(100,160,255,0.04)';
      ctx.fill();
      _starPath(ctx, wox, woy, 5, starR * pulse, starR * 0.45 * pulse, rot);
      ctx.strokeStyle = 'rgba(140,180,255,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 라벨
      ctx.font = "600 13px 'Inter',-apple-system,sans-serif";
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(180,210,255,0.85)';
      ctx.fillText('+ 팀원 초대', wox, woy);
      ctx.font = "400 10px 'JetBrains Mono',monospace";
      ctx.fillStyle = 'rgba(140,170,220,0.5)';
      ctx.fillText('워크스페이스에 추가', wox, woy + 16);

      ctx.restore();

      registerHitArea({
        cx: wox, cy: woy, r: starR + 8,
        obj: null,
        data: { type: 'teamInvite' },
      });
    });
    return;
  }

  data.members.forEach((m, i) => {
    const [wox, woy] = _TEAM_WORLD_POS[i] || [900 + i * 200, 0];
    const scx = wox * scale + txX, scy = woy * scale + txY;
    if (scx < -200 || scx > W + 200 || scy < -200 || scy > H + 200) return;

    const color = m.color || '#58a6ff';
    const name  = m.name  || '팀원';
    const activeTasks = (m.tasks || []).filter(t => t.status === 'active').length;
    const totalTasks  = (m.tasks || []).length;

    ctx.save();
    ctx.globalAlpha = fadeAlpha;

    // 팀원 와이어프레임 구체
    _drawWireSphere(ctx, wox, woy, 40, color, { alpha: 0.3, meridians: 2, parallels: 1 });

    // 텍스트 (구체 중심에)
    ctx.font = "700 13px 'Inter',-apple-system,sans-serif";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`👤 ${name}`, wox, woy - 4);
    ctx.font = "500 10px 'JetBrains Mono',monospace";
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(`${activeTasks}개 진행 · ${totalTasks}개 총`, wox, woy + 12);

    // 미니 작업 카드
    const tasks = (m.tasks || []).slice(0, 3);
    tasks.forEach((task, ti) => {
      const tAngle = -Math.PI / 2 + (ti - (tasks.length - 1) / 2) * 0.65;
      const tDist  = 80;
      const tx = wox + Math.cos(tAngle) * tDist;
      const ty = woy + Math.sin(tAngle) * tDist;
      const tColor = task.status === 'active' ? '#3fb950' : task.status === 'done' ? '#58a6ff' : '#6e7681';
      const tName  = (task.name || '작업').slice(0, 14) + ((task.name || '').length > 14 ? '…' : '');

      ctx.globalAlpha = fadeAlpha * 0.2;
      ctx.strokeStyle = color; ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(wox, woy); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = fadeAlpha * 0.85;
      _drawWireSphere(ctx, tx, ty, 20, tColor, { alpha: 0.25, meridians: 1, parallels: 0, glow: false });
      ctx.font = "500 10px 'Inter',sans-serif";
      ctx.textAlign = 'center'; ctx.fillStyle = '#cbd5e1';
      ctx.fillText(tName, tx, ty);
    });

    registerHitArea({
      cx: wox, cy: woy, r: 50,
      obj: null,
      data: { type: 'teamMember', memberId: m.userId || m.id, memberName: name, color, member: m },
    });

    ctx.restore();
  });
}

// ─── 조작법 힌트 오버레이 ─────────────────────────────────────────────────────
let _controlsHintAlpha = 1.0;
let _controlsHintFadeStart = 0;
function _drawControlsHint(ctx, W, H, _wScale) {
  if (!_controlsHintFadeStart) _controlsHintFadeStart = performance.now();
  const elapsed = (performance.now() - _controlsHintFadeStart) / 1000;
  if (elapsed < 10) _controlsHintAlpha = 0.65;
  else if (elapsed < 12) _controlsHintAlpha = 0.65 * (1 - (elapsed - 10) / 2);
  else { _controlsHintAlpha = 0; return; }

  ctx.save();
  ctx.globalAlpha = _controlsHintAlpha;

  // 줌 레벨 표시
  const zoomLabel = _wScale > 0.85 ? '개인 유니버스' :
                    _wScale > 0.45 ? '팀 유니버스' :
                    _wScale > 0.15 ? '회사 유니버스' : '전체 유니버스';

  const hints = [
    `🔭 ${zoomLabel} (×${_wScale.toFixed(1)})`,
    '🖱 배경 드래그: 탐색 이동',
    '⚙ 스크롤: 줌인/줌아웃',
    '👆 클릭: 프로젝트 상세',
  ];
  const lineH = 20;
  const padX = 14, padY = 10;
  const boxW = 200, boxH = hints.length * lineH + padY * 2;
  const bx = W - boxW - 16, by = H - boxH - 16;

  ctx.fillStyle = 'rgba(2,6,23,0.7)';
  roundRect(ctx, bx, by, boxW, boxH, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(100,116,139,0.25)';
  ctx.lineWidth = 0.6;
  roundRect(ctx, bx, by, boxW, boxH, 8); ctx.stroke();

  ctx.font = "400 11px 'Inter',-apple-system,sans-serif";
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  hints.forEach((h, i) => {
    ctx.fillStyle = i === 0 ? '#06b6d4' : '#94a3b8';
    ctx.fillText(h, bx + padX, by + padY + i * lineH + lineH / 2);
  });

  ctx.restore();
}

// ─── 1단계: 유니버스 뷰 (와이어프레임 구체 기반) ───────────────────────────────
function drawCompactProjectView() {
  const projNames = Object.keys(_projectGroups);
  if (projNames.length === 0) return;

  const now = performance.now() / 1000;
  const ctx = _lctx;

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

  // ── 레이아웃 ──────────────────────────────────────────────────────────────
  const isDrillStage1 = _drillStage >= 1 && _drillProject;
  const baseAngle = -Math.PI / 2;
  const angleStep = (Math.PI * 2) / projects.length;

  const SUN_R = 30;
  const ORBIT_BASE = 50;
  const ORBIT_PER_PLANET = 12;
  const SOLAR_SYSTEM_GAP = 25;

  const solarRadii = projects.map(p => ORBIT_BASE + Math.min(p.planets.length, 8) * ORBIT_PER_PLANET);
  const maxSolarR = Math.max(...solarRadii);
  let CENTER_DIST = maxSolarR + SUN_R + SOLAR_SYSTEM_GAP;
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

  const _aliases = (() => { try { return JSON.parse(localStorage.getItem('orbitLabelAliases') || '{}'); } catch { return {}; } })();
  const _sunScreenCoords = [];

  // ── 월드 트랜스폼 ──────────────────────────────────────────────────────────
  ctx.save();
  ctx.translate(_txX, _txY);
  ctx.scale(_wScale, _wScale);

  // ── 태양계 렌더링 ──────────────────────────────────────────────────────────
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

    _sunScreenCoords.push({ sx: sunCx * _wScale + _txX, sy: sunCy * _wScale + _txY, color });

    if (dimmed) ctx.globalAlpha = 0.15;

    // ── 태양 와이어프레임 구체 ──
    _drawWireSphere(ctx, sunCx, sunCy, SUN_R, color, {
      alpha: 0.45, lineW: 1, meridians: 3, parallels: 2,
      hover: isHover || isThisDrilled, rotation: now * 0.1,
    });

    // ── 태양 라벨 (텍스트 중심, 밝고 크게) ──
    const projTitle = _aliases[proj.name] || `${info.icon} ${info.name}`;
    const projSub = `${info.sessionCount}세션 · ${info.fileCount}파일`;
    ctx.save();
    ctx.font = "700 15px 'Inter',-apple-system,sans-serif";
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    let clippedTitle = projTitle;
    while (ctx.measureText(clippedTitle).width > SUN_R * 4.5 && clippedTitle.length > 1) clippedTitle = clippedTitle.slice(0, -1);
    if (clippedTitle !== projTitle) clippedTitle += '\u2026';
    ctx.fillText(clippedTitle, sunCx, sunCy - 5);
    ctx.font = "500 11px 'JetBrains Mono',monospace";
    ctx.fillStyle = '#cbd5e1';
    ctx.fillText(projSub, sunCx, sunCy + 12);
    ctx.restore();

    if (!dimmed && isHover) drawCardIcons(ctx, sunCx, sunCy, proj.name, projTitle, isHover, _hitAreas);

    registerHitArea({
      cx: sunCx, cy: sunCy, r: SUN_R + 10,
      obj: null,
      data: { type: 'constellation', projName: proj.name, planetCount: proj.planets.length, color, info },
    });

    // ── 궤도 링 + 행성 ──
    if (numPlanets > 0) {
      const planetAngleStep = (Math.PI * 2) / numPlanets;
      const orbitR = ORBIT_BASE + Math.min(numPlanets, 8) * (ORBIT_PER_PLANET * 0.6);

      // 궤도 링
      ctx.save();
      ctx.globalAlpha = dimmed ? 0.06 : 0.2;
      ctx.strokeStyle = color; ctx.lineWidth = 0.6;
      ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.arc(sunCx, sunCy, orbitR, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      if (dimmed) ctx.globalAlpha = 0.15;

      const maxShow = isThisDrilled ? Math.min(numPlanets, 12) : Math.min(numPlanets, 6);
      for (let pi = 0; pi < maxShow; pi++) {
        const planet = proj.planets[pi];
        const pAngle = -Math.PI / 2 + pi * planetAngleStep + now * 0.05;
        const px = sunCx + Math.cos(pAngle) * orbitR;
        const py = sunCy + Math.sin(pAngle) * orbitR;
        const evCnt = planet.userData.eventCount || 0;
        const pR = Math.max(10, Math.min(18, 10 + evCnt * 0.3));
        const isSubHover = _hoveredHit?.obj === planet;
        const catKey = planet.userData.macroCat || 'general';
        const catCfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
        const pColor = catCfg.color || color;

        // 행성 와이어프레임 구체
        _drawWireSphere(ctx, px, py, pR, pColor, {
          alpha: 0.4, lineW: 0.7, meridians: 2, parallels: 1,
          hover: isSubHover, rotation: now * 0.2 + pi,
        });

        // 행성 라벨 (항상 표시 — 짧은 텍스트)
        const sesKey = planet.userData.clusterId || planet.userData.sessionId || '';
        let sLabel = _aliases[sesKey] || normalizeLabel(planet.userData.intent || '', 16);
        if (!sLabel) sLabel = deriveDisplayLabel(planet.userData, 16);
        if (sLabel) {
          ctx.save();
          const showFull = isThisDrilled || isSubHover;
          const fontSize = showFull ? 12 : 10;
          ctx.font = `${showFull ? '600' : '500'} ${fontSize}px 'Inter',-apple-system,sans-serif`;
          ctx.textAlign = 'center';

          // 텍스트 배경 (가독성)
          const tw = ctx.measureText(sLabel).width;
          const pw = tw + 8, ph = fontSize + 6;
          ctx.fillStyle = 'rgba(2,6,23,0.75)';
          roundRect(ctx, px - pw/2, py + pR + 3, pw, ph, 4); ctx.fill();

          ctx.fillStyle = showFull ? '#fff' : '#cbd5e1';
          ctx.fillText(sLabel, px, py + pR + 3 + ph * 0.6);

          if (showFull && evCnt > 0) {
            ctx.font = "500 8px 'JetBrains Mono',monospace";
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(`${evCnt}개 작업`, px, py + pR + ph + 10);
          }
          ctx.restore();
        }

        registerHitArea({
          cx: px, cy: py, r: Math.max(pR + 6, 16),
          obj: planet,
          data: { type: 'drillSession', intent: planet.userData.intent,
                  clusterId: planet.userData.clusterId,
                  sessionId: planet.userData.sessionId,
                  eventCount: evCnt, hueHex: pColor,
                  catKey, catLabel: catCfg.label, catColor: catCfg.color, catIcon: catCfg.icon,
                  projName: proj.name, planets: proj.planets },
        });
      }

      if (proj.planets.length > maxShow) {
        ctx.save();
        ctx.globalAlpha = 0.7;
        ctx.font = '600 11px -apple-system,sans-serif';
        ctx.fillStyle = '#cbd5e1'; ctx.textAlign = 'center';
        ctx.fillText(`+${proj.planets.length - maxShow}`, sunCx, sunCy + SUN_R + orbitR + 18);
        ctx.restore();
      }
    }

    ctx.globalAlpha = 1;
  });

  // ── 팀원 클러스터 (줌아웃 시 등장) ──
  if (_wScale < 0.85) _drawTeamClusters(ctx, _txX, _txY, W, H, _wScale);

  ctx.restore();

  // ── hitArea 스크린 변환 ──
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

  // ── ME → 태양 연결선 (스크린 좌표) ─────────────────────────────────────────
  const meCx = W / 2, meCy = H / 2;
  ctx.save();
  _sunScreenCoords.forEach(s => {
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = s.color; ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 8]);
    ctx.beginPath(); ctx.moveTo(meCx, meCy); ctx.lineTo(s.sx, s.sy); ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.restore();

  // ── MY UNIVERSE 고정 HUD (화면 중앙, 와이어프레임) ─────────────────────────
  ctx.save();
  const meR = 42;

  // 와이어프레임 구체
  _drawWireSphere(ctx, meCx, meCy, meR, '#06b6d4', {
    alpha: 0.5, lineW: 1.2, meridians: 4, parallels: 2,
    glow: true, rotation: now * 0.08,
  });

  // 텍스트 (구체 내부, 크고 밝게)
  ctx.font = "700 15px 'Inter',-apple-system,sans-serif";
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText('MY UNIVERSE', meCx, meCy - 3);
  ctx.font = "500 10px 'JetBrains Mono',monospace";
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(`${projects.length} 프로젝트`, meCx, meCy + 14);

  // 줌 레벨 인디케이터
  const zoomLabel = _wScale > 0.85 ? '' :
                    _wScale > 0.45 ? '🔭 팀 뷰' :
                    _wScale > 0.15 ? '🏢 회사 뷰' : '🌌 전체 뷰';
  if (zoomLabel) {
    ctx.font = "600 11px 'Inter',sans-serif";
    ctx.fillStyle = '#06b6d4';
    ctx.fillText(zoomLabel, meCx, meCy + meR + 18);
  }

  ctx.restore();

  registerHitArea({
    cx: meCx, cy: meCy, r: meR + 5,
    obj: null,
    data: { type: 'meNode' },
  });

  // ── 조작법 힌트 ──
  _drawControlsHint(ctx, W, H, _wScale);
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

    _lctx.save();
    _lctx.shadowColor = isSelected ? 'rgba(6,182,212,0.2)' : 'rgba(0,0,0,0.3)';
    _lctx.shadowBlur = isSelected ? 12 : 6; _lctx.shadowOffsetY = 1;
    _lctx.fillStyle = isSelected ? 'rgba(6,182,212,0.12)' : 'rgba(2,6,23,0.78)';
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.fill();
    _lctx.shadowBlur = 0; _lctx.shadowOffsetY = 0;
    _lctx.restore();

    _lctx.strokeStyle = isSelected ? hex : isHovered ? 'rgba(6,182,212,0.35)' : 'rgba(255,255,255,0.10)';
    _lctx.lineWidth = isSelected ? 1.5 : isHovered ? 1 : 0.8;
    roundRect(_lctx, lx, ly, pw, ph, ph / 2); _lctx.stroke();

    _lctx.fillStyle = isSelected ? '#e2e8f0' : isHovered ? '#cbd5e1' : '#94a3b8';
    _lctx.fillText(text, sc.x, ly + ph * 0.68);

    if (evCnt > 0 && pxSize >= 13) {
      const sub = Math.max(9, pxSize * 0.5);
      _lctx.font = `500 ${sub}px 'JetBrains Mono','Fira Code',monospace`;
      _lctx.fillStyle = '#475569';
      _lctx.fillText(`${evCnt}개 작업`, sc.x, ly + ph + sub + 1);
    }

    registerHitArea({
      cx: sc.x, cy: sc.y, r: Math.max(pw, ph) / 2 + 4,
      obj: p,
      data: { type: 'session', intent: text, clusterId: p.userData.clusterId,
              sessionId: p.userData.sessionId, eventCount: evCnt, hueHex: hex },
    });
  });

  _lctx.globalAlpha = 1;
}

// ─── drawLabels ──────────────────────────────────────────────────────────────
const _usedRects = [];
const LABEL_PADDING = 12;

function rectOverlaps(x, y, w, h) {
  for (const r of _usedRects) {
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
