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

// 팔로잉 월드 오프셋 — 팀원보다 더 바깥 (scale≈0.4 에서 화면 가장자리)
const _FOLLOW_WORLD_POS = [
  [ 550,  120], [-550,  120],
  [ 550, -120], [-550, -120],
  [ 350,  420], [-350,  420],
  [ 350, -420], [-350, -420],
  [ 600,  320], [-600,  320],
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

    // ── 팀원 와이어프레임 구체 ──
    const now = performance.now() / 1000;
    const sphereR = 55;
    _drawWireSphere(ctx, wox, woy, sphereR, color, {
      alpha: 0.3, lineW: 0.8, meridians: 2, parallels: 1,
      glow: true, rotation: now * 0.15 + i * 0.5,
    });
    _drawSphereLabel(ctx, wox, woy, sphereR, `👤 ${name}`, `${activeTasks}개 진행 · ${totalTasks}개`, color, false);

    // 히트 영역 (월드 좌표 → drawCompactProjectView 끝에서 스크린 좌표 변환)
    registerHitArea({
      cx: wox, cy: woy, r: 60,
      obj: null,
      data: { type: 'teamMember', memberId: m.userId || m.id, memberName: name, color, member: m },
    });

    ctx.restore();
  });
}

// ─── 팔로잉 클러스터 렌더링 (월드 줌아웃 시 등장, 팀원 뒤쪽) ────────────────
// ctx는 이미 월드 트랜스폼(translate+scale)이 적용된 상태로 호출됨
function _drawFollowingClusters(ctx, txX, txY, W, H, scale) {
  const fData = window._followingData;
  if (!fData || !Array.isArray(fData) || fData.length === 0) return;

  // 페이드인: scale 0.65→0.40 구간에서 0→1 알파 (팀원보다 더 줌아웃해야 표시)
  const fadeAlpha = Math.min(1, Math.max(0, (0.65 - scale) / 0.25));
  if (fadeAlpha <= 0) return;

  const now = performance.now() / 1000;
  const FOLLOW_COLOR = '#a78bfa'; // 보라색 — 팔로잉 구분용

  fData.forEach((f, i) => {
    const [wox, woy] = _FOLLOW_WORLD_POS[i] || [900 + i * 180, 200];
    const scx = wox * scale + txX, scy = woy * scale + txY;

    // 화면 밖이면 스킵
    if (scx < -200 || scx > W + 200 || scy < -200 || scy > H + 200) return;

    const color = FOLLOW_COLOR;
    const name = f.name || f.email?.split('@')[0] || '사용자';
    const headline = f.headline || '';
    const sub = headline ? headline.slice(0, 20) : '팔로잉';

    ctx.save();
    ctx.globalAlpha = fadeAlpha;

    // 와이어프레임 구체 (팀원의 drawUnifiedCard 대신 3D 스타일)
    const isHover = _hoveredHit?.data?.type === 'follower' && _hoveredHit?.data?.userId === f.user_id;
    const sphereR = 55;
    _drawWireSphere(ctx, wox, woy, sphereR, color, {
      alpha: 0.3, lineW: 0.8, meridians: 2, parallels: 1,
      glow: true, hover: isHover, rotation: now * 0.12 + i * 0.7,
    });
    _drawSphereLabel(ctx, wox, woy, sphereR, name, sub, color, false);

    // 히트 영역 (월드 좌표)
    registerHitArea({
      cx: wox, cy: woy, r: sphereR + 6,
      obj: null,
      data: {
        type: 'follower',
        userId: f.user_id,
        userName: name,
        headline,
        color,
        avatarUrl: f.avatar_url,
      },
    });

    ctx.restore();
  });
}

// ─── 1단계: 프로젝트 노드 뷰 (3D 와이어프레임 구체 + 양파형 동심원) ─────────
// ME 노드 중심, 프로젝트를 동심원 배치, 3D 카메라 회전으로 탐색
// 클릭 시 2단계 카테고리 링 전개
function drawCompactProjectView() {
  const projNames = Object.keys(_projectGroups);
  if (projNames.length === 0) return;

  const now = performance.now() / 1000;
  const ctx = _lctx;
  const W = _labelCanvas2d.width, H = _labelCanvas2d.height;

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

  // ── 양파형 동심원 배치 (3D 월드 좌표 X-Z 평면) ────────────────────────────
  const isDrillStage1 = _drillStage >= 1 && _drillProject;
  const baseAngle = -Math.PI / 2;
  const WORLD_NODE_SEP = 6;   // 노드 간 최소 월드 거리
  const WORLD_RING_BASE = 12; // 1번째 링 시작 반경
  const WORLD_RING_GAP = 10;  // 링 간 간격

  // 프로젝트를 링별로 분배 (5, 10, 15, 20…)
  const rings = [];
  let placed = 0, rIdx = 0;
  while (placed < projects.length) {
    const capacity = Math.min(5 + rIdx * 5, projects.length - placed);
    rings.push(projects.slice(placed, placed + capacity));
    placed += capacity; rIdx++;
  }

  // 각 링 반경 (월드 단위)
  const ringRadii = [];
  let prevR = WORLD_RING_BASE;
  rings.forEach((ring) => {
    const count = ring.length;
    const sinHalf = Math.sin(Math.PI / count);
    const minR = sinHalf > 0 ? WORLD_NODE_SEP / sinHalf : prevR;
    const ringR = Math.max(prevR, minR);
    ringRadii.push(ringR);
    prevR = ringR + WORLD_RING_GAP;
  });

  // 프로젝트 → 3D 월드 좌표 + 스크린 좌표
  const projLayout = [];
  if (!window._projWorldPositions) window._projWorldPositions = {};
  rings.forEach((ring, ri) => {
    const count = ring.length;
    const step = (Math.PI * 2) / count;
    ring.forEach((proj, pi) => {
      const angle = baseAngle + pi * step;
      const r = ringRadii[ri];
      const pos3d = new THREE.Vector3(Math.cos(angle) * r, 0, Math.sin(angle) * r);
      const sc = toScreen(pos3d);
      projLayout.push({ proj, pos3d, sc, angle, dist: r, ringIdx: ri });
      // 드릴다운 줌인용 월드 좌표 저장
      window._projWorldPositions[proj.name] = pos3d;
    });
  });

  // ── 동심원 가이드라인 (3D 투영) ──────────────────────────────────────────
  ringRadii.forEach(rr => {
    ctx.save();
    ctx.strokeStyle = 'rgba(148,163,184,0.08)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    const RING_PTS = 64;
    for (let i = 0; i <= RING_PTS; i++) {
      const a = (i / RING_PTS) * Math.PI * 2;
      const pt = toScreen(new THREE.Vector3(Math.cos(a) * rr, 0, Math.sin(a) * rr));
      if (pt.z > 1) continue;
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  });

  // ── ME 노드 (월드 원점 = 0,0,0) — 와이어프레임 구체 ───────────────────────
  const mePos = new THREE.Vector3(0, 0, 0);
  const meSc = toScreen(mePos);
  if (meSc.z <= 1) {
    const meScale = screenScale(mePos);
    const meR = Math.max(40, Math.min(70, meScale * 9));
    _drawWireSphere(ctx, meSc.x, meSc.y, meR, '#06b6d4', {
      meridians: 3, parallels: 2, rotation: now * 0.15, glow: true,
    });
    _drawSphereLabel(ctx, meSc.x, meSc.y, meR, '나의 작업', `${projects.length} 프로젝트`, '#06b6d4', false);
  }

  // 라벨 별칭 맵
  const _aliases = (() => { try { return JSON.parse(localStorage.getItem('orbitLabelAliases') || '{}'); } catch { return {}; } })();

  projLayout.forEach(({ proj, pos3d, sc, angle, dist: wDist }, i) => {
    if (sc.z > 1) return; // 카메라 뒤

    const isThisDrilled = isDrillStage1 && _drillProject.name === proj.name;
    const isHover = _hoveredHit?.data?.type === 'constellation' && _hoveredHit?.data?.projName === proj.name;
    const dimmed = isDrillStage1 && !isThisDrilled;
    const color = proj.color;
    const info = analyzeProject(proj);
    const scale = screenScale(pos3d);
    const nodeR = Math.max(28, Math.min(56, scale * 7));

    if (dimmed) ctx.globalAlpha = 0.3;

    // 와이어프레임 구체
    _drawWireSphere(ctx, sc.x, sc.y, nodeR, color, {
      alpha: isThisDrilled ? 0.5 : 0.35,
      lineW: isThisDrilled ? 1.2 : 0.8,
      meridians: 2, parallels: 1,
      glow: true, hover: isHover, drilled: isThisDrilled,
      rotation: now * 0.2 + i * 0.5,
    });

    // 활성 표시
    if (proj.hasActive) {
      ctx.save();
      ctx.fillStyle = '#22c55e'; ctx.shadowColor = '#22c55e'; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(sc.x + nodeR - 4, sc.y - nodeR + 4, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // 라벨 + 심층 세션 요약 (PURPOSE + WHAT + RESULT + 추가 컨텍스트)
    const projTitle = _aliases[proj.name] || `${info.icon} ${info.name}`;
    const projSub = '';
    // 프로젝트 내 행성들의 요약 집계
    let projWhat = '', projResult = '', projPurpose = '', projTech = '', projDuration = '', projAiTools = '';
    for (const p of proj.planets) {
      if (!projPurpose && p.userData.purpose) projPurpose = p.userData.purpose;
      if (!projWhat && p.userData.whatSummary) projWhat = p.userData.whatSummary;
      if (!projResult && p.userData.resultSummary) projResult = p.userData.resultSummary;
      if (!projTech && p.userData.techStack) projTech = p.userData.techStack;
      if (!projDuration && p.userData.sessionDuration) projDuration = p.userData.sessionDuration;
      if (!projAiTools && p.userData.aiToolsUsed) projAiTools = p.userData.aiToolsUsed;
      if (projWhat && projResult && projPurpose) break;
    }
    // 프로젝트 레벨: purpose 제외 (projTitle과 중복됨), 기술스택만 표시
    _drawSphereLabel(ctx, sc.x, sc.y, nodeR, projTitle, projTech || '', color, dimmed, projWhat, '', null);

    ctx.globalAlpha = 1;

    // ME → 프로젝트 연결선
    if (meSc.z <= 1) {
      ctx.save();
      ctx.globalAlpha = dimmed ? 0.1 : 0.18;
      ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(meSc.x, meSc.y); ctx.lineTo(sc.x, sc.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 히트 영역 (스크린 좌표 — 변환 불필요)
    registerHitArea({
      cx: sc.x, cy: sc.y, r: nodeR + 6,
      obj: null,
      data: { type: 'constellation', projName: proj.name, planetCount: proj.planets.length, color, info },
    });

    // ══ 2단계: 카테고리 + 세션 (드릴다운) ════════════════════════════════════
    if (isThisDrilled && proj.planets.length > 0) {
      const catGroups = {};
      proj.planets.forEach(planet => {
        const cat = planet.userData.macroCat || 'general';
        if (!catGroups[cat]) catGroups[cat] = [];
        catGroups[cat].push(planet);
      });
      const sortedCats = Object.entries(catGroups).sort((a, b) => b[1].length - a[1].length);

      // 카테고리: 프로젝트 외곽 방향 부채꼴 배치 (3D)
      const numCatsNow = sortedCats.length;
      const dirAngle = angle;
      const CAT_WORLD_DIST = 14;
      const catAngleStep = Math.max(Math.PI / 3, Math.PI * 2 / Math.max(numCatsNow * 2, 4)); // 60도 최소간격
      const catHalfSpan = Math.min((numCatsNow - 1) / 2 * catAngleStep, Math.PI);

      sortedCats.forEach(([catKey, catPlanets], ci) => {
        const cfg = PROJECT_TYPES[catKey] || PROJECT_TYPES.general;
        const catAngle = numCatsNow === 1 ? dirAngle : dirAngle - catHalfSpan + ci * catAngleStep;
        const catPos3d = new THREE.Vector3(
          pos3d.x + Math.cos(catAngle) * CAT_WORLD_DIST,
          0,
          pos3d.z + Math.sin(catAngle) * CAT_WORLD_DIST,
        );
        const catSc = toScreen(catPos3d);
        if (catSc.z > 1) return;

        const catScale = screenScale(catPos3d);
        const catR = Math.max(24, Math.min(44, catScale * 6));
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
        ctx.beginPath(); ctx.moveTo(sc.x, sc.y); ctx.lineTo(catSc.x, catSc.y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // 카테고리 와이어프레임 구체
        _drawWireSphere(ctx, catSc.x, catSc.y, catR, cfg.color, {
          meridians: 2, parallels: 1, glow: true, hover: isCatHover, drilled: isCatDrilled,
          rotation: now * 0.25 + ci,
        });
        _drawSphereLabel(ctx, catSc.x, catSc.y, catR, catTitle, catSub, cfg.color, false);

        registerHitArea({
          cx: catSc.x, cy: catSc.y, r: catR + 4,
          obj: null,
          data: {
            type: 'drillCategory', catKey,
            catLabel: cfg.label, catColor: cfg.color, catIcon: cfg.icon,
            projName: proj.name, planets: catPlanets, sessionCount: catSessionCount,
          },
        });

        // ── 세션: 카테고리 아래 세로 배치 (소형 와이어프레임 구체) ────────────
        const maxShow = Math.min(catPlanets.length, 3);
        const SES_WORLD_STEP = 7;
        for (let si = 0; si < maxShow; si++) {
          const planet = catPlanets[si];
          const sesPos3d = new THREE.Vector3(
            catPos3d.x + Math.cos(catAngle) * (SES_WORLD_STEP * (si + 1)),
            0,
            catPos3d.z + Math.sin(catAngle) * (SES_WORLD_STEP * (si + 1)),
          );
          const sesSc = toScreen(sesPos3d);
          if (sesSc.z > 1) continue;

          const sesScale = screenScale(sesPos3d);
          const sesR = Math.max(20, Math.min(36, sesScale * 5)); // 카테고리보다 작게
          const evCnt = planet.userData.eventCount || 0;
          const isSubHover = _hoveredHit?.obj === planet;
          const sesKey = planet.userData.clusterId || planet.userData.sessionId || '';
          let sLabel = _aliases[sesKey] || normalizeLabel(planet.userData.intent || '', 22);
          if (!sLabel) sLabel = deriveDisplayLabel(planet.userData, 22);
          const sesSub = '';

          // 연결선
          ctx.save();
          ctx.globalAlpha = 0.12;
          ctx.strokeStyle = cfg.color; ctx.lineWidth = 0.8;
          ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(catSc.x, catSc.y); ctx.lineTo(sesSc.x, sesSc.y); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();

          _drawWireSphere(ctx, sesSc.x, sesSc.y, sesR, cfg.color, {
            meridians: 1, parallels: 1, glow: false, hover: isSubHover,
            rotation: now * 0.3 + si,
          });
          const sesWhat = planet.userData.whatSummary || '';
          const sesResult = planet.userData.resultSummary || '';
          const sesExtraCtx = {
            purpose: planet.userData.purpose || '',
            techStack: planet.userData.techStack || '',
            duration: planet.userData.sessionDuration || '',
            aiTools: planet.userData.aiToolsUsed || '',
          };
          _drawSphereLabel(ctx, sesSc.x, sesSc.y, sesR, sLabel, sesSub, cfg.color, false, sesWhat, sesResult, sesExtraCtx);

          registerHitArea({
            cx: sesSc.x, cy: sesSc.y, r: sesR + 4,
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
          const morePos = new THREE.Vector3(
            catPos3d.x + Math.cos(catAngle) * (SES_WORLD_STEP * (maxShow + 1)),
            0,
            catPos3d.z + Math.sin(catAngle) * (SES_WORLD_STEP * (maxShow + 1)),
          );
          const moreSc = toScreen(morePos);
          if (moreSc.z <= 1) {
            ctx.globalAlpha = 0.6;
            ctx.font = '400 10px -apple-system,sans-serif';
            ctx.fillStyle = cfg.color; ctx.textAlign = 'center';
            ctx.fillText(`+${catPlanets.length - maxShow}개`, moreSc.x, moreSc.y + 4);
            ctx.globalAlpha = 1;
          }
        }
      });
    }
  });

  // ── 팀원 클러스터 (줌아웃 시 페이드인) ────────────────────────────────────
  const _wScale = window._worldScale || 1.0;
  if (_wScale < 0.75) {
    // 팀 클러스터는 스크린 좌표 기반이므로 별도 처리
    const _txX = W / 2, _txY = H / 2;
    ctx.save();
    ctx.translate(_txX, _txY);
    ctx.scale(_wScale, _wScale);
    _drawTeamClusters(ctx, _txX, _txY, W, H, _wScale);
    // 팔로잉 클러스터 (팀원보다 더 바깥에 표시)
    _drawFollowingClusters(ctx, _txX, _txY, W, H, _wScale);
    ctx.restore();
  }

  // ── hitArea 우선순위 정렬 ─────────────────────────────────────────────────
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

  (typeof planetMeshes !== 'undefined' ? planetMeshes : []).forEach(p => {
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
