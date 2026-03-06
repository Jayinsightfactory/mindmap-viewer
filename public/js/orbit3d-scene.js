// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Scene Build (planets, orbits, satellites)
// ══════════════════════════════════════════════════════════════════════════════
// ─── 씬 빌드 ──────────────────────────────────────────────────────────────────
function clearScene() {
  [...planetMeshes, ...satelliteMeshes, ...orbitRings, ...connections].forEach(o => scene.remove(o));
  if (typeof _collabLines !== 'undefined') {
    _collabLines.forEach(cl => { scene.remove(cl.line); if (cl.outerLine) scene.remove(cl.outerLine); });
    _collabLines = [];
  }
  planetMeshes=[]; satelliteMeshes=[]; orbitRings=[]; connections=[]; labelSprites=[];
  _nodeDataMap = {}; _hitAreas = []; _projectGroups = {};
  _topicLinksBuilt = false; _topicLinks.length = 0; _topicLinksLastBuilt = 0;
}

function buildPlanetSystem(nodeList) {
  clearScene();
  _allNodes = nodeList;

  // ── 세션별 그룹화 ─────────────────────────────────────────────────────────
  const sessions = {};
  for (const n of nodeList) {
    if (!n.type || n.type === 'session.start' || n.type === 'session.end') continue;
    const sid = n.sessionId || 'default';
    if (!sessions[sid]) sessions[sid] = [];
    sessions[sid].push(n);
  }

  const filterCats = FILTER_CATS[_activeFilter];
  const sessKeys   = Object.keys(sessions);

  // ── 행성 단위 생성 (클러스터 기반) ────────────────────────────────────────
  // 세션이 1개여도 목적 클러스터로 분해해 복수 행성 생성
  const planets = []; // { clusterId, sessionId, domain, label, events }

  for (const sid of sessKeys) {
    const rawEvents = sessions[sid];
    const filtered  = filterCats
      ? rawEvents.filter(e => filterCats.includes(typeCfg(e.type).cat))
      : rawEvents;
    if (filtered.length === 0) continue;

    // ── 프로젝트명 추출 ─────────────────────────────────────────────────
    const startEv = rawEvents.find(e => e.type === 'session.start');
    const pd      = startEv?.data?.projectDir || startEv?.data?.cwd || '';
    let projName;
    if (pd) {
      // projectDir 있으면 마지막 폴더명
      projName = pd.replace(/\\/g,'/').split('/').filter(Boolean).pop();
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(sid)) {
      // UUID 세션 → 가장 많이 등장한 파일의 디렉터리명으로 추론
      const fileCounts = {};
      rawEvents.forEach(e => {
        const fp = (e.data?.filePath||e.data?.fileName||'').replace(/\\/g,'/');
        const dir = fp.split('/').filter(Boolean).slice(-2,-1)[0];
        if (dir && dir !== '.') fileCounts[dir] = (fileCounts[dir]||0) + 1;
      });
      const topDir = Object.entries(fileCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
      projName = topDir || `세션-${sid.slice(0,6)}`;
    } else {
      // session-{name}-{timestamp} → {name}
      const mSession = sid.match(/^session-([a-zA-Z][a-zA-Z0-9_-]*?)(?:-\d{10,})?$/);
      if (mSession) { projName = mSession[1]; }
      // wf{N}-{timestamp} → 워크플로우
      else if (/^wf\d+-\d/.test(sid)) { projName = '워크플로우'; }
      // 짧고 숫자 없는 이름은 그대로
      else if (sid.length <= 24 && !/\d{8,}/.test(sid)) { projName = sid; }
      else { projName = sid.slice(0,12) + '…'; }
    }

    const clusters = clusterByIntent(sid, filtered);
    // 클러스터가 1개뿐이면 전체 세션을 1개 행성으로
    if (clusters.length <= 1) {
      const cl = clusters[0];
      // 도메인 라벨 + 메시지 프리뷰 조합 (세션 ID 대신 의미있는 라벨)
      const domainLabel = cl?.label || sessionIntent(rawEvents);
      planets.push({
        clusterId:   sid,
        sessionId:   sid,
        domain:      cl?.domain || 'general',
        label:       domainLabel,
        icon:        cl?.icon || '',
        msgPreview:  cl?.msgPreview || '',
        events:      filtered,
        isFullSession: true,
        projectName: projName,
      });
    } else {
      for (const c of clusters) {
        planets.push({ ...c, isFullSession: false, projectName: projName });
      }
    }
  }

  const N = planets.length;

  // ── 중심 코어 — 스킨 시스템으로 위임 ──────────────────────────────────
  buildCoreMesh();

  let totalTasks = 0, totalHours = 0;

  // 같은 sessionId 내 클러스터끼리 색조를 가깝게 (sesIdx 기반 색조, domain으로 명도 조절)
  const SESSION_HUES = {};
  sessKeys.forEach((sid, si) => { SESSION_HUES[sid] = (si / Math.max(sessKeys.length,1)) * 0.72 + 0.55; });

  // 클러스터별 색조 변화 (같은 세션 내 클러스터는 유사색)
  const DOMAIN_HUE_OFFSET = {
    auth:0.00, api:0.04, data:0.08, ui:0.12, test:0.16,
    server:0.20, infra:0.24, docs:0.28, design:0.32, fix:0.36,
    git:0.40, research:0.44, chat:0.48, general:0.52,
  };

  // ── 매크로 카테고리 할당 (색상 참조용) ───────────────────────────────────
  planets.forEach(pl => {
    pl.macroCat = classifyMacroCategory(pl.events);
  });
  const catBuckets = { dev: [], research: [], ops: [] };
  planets.forEach(pl => catBuckets[pl.macroCat].push(pl));

  // ── 프로젝트 단위로 그룹화 → 클러스터 배치 ───────────────────────────────
  const projBuckets = {};                                          // projectName → [planet]
  planets.forEach(pl => {
    const proj = pl.projectName || '기타';
    if (!projBuckets[proj]) projBuckets[proj] = [];
    projBuckets[proj].push(pl);
  });
  const projNames = Object.keys(projBuckets);                      // 프로젝트 이름 목록
  const projCount = projNames.length;                               // 프로젝트 수

  // 프로젝트별 인덱스 맵 (행성 → 프로젝트 내 순번)
  const projIndexOf = {};                                           // clusterId → { projIdx, innerIdx }
  projNames.forEach((pn, pi) => {
    projBuckets[pn].forEach((pl, ii) => {
      projIndexOf[pl.clusterId] = { projIdx: pi, innerIdx: ii, projSize: projBuckets[pn].length };
    });
  });

  planets.forEach((pl, pi) => {
    const { clusterId, sessionId: sid, domain, label, events } = pl;
    const rawEvents = events;

    // ── 행성 위치 — 프로젝트 클러스터 기반 배치 ──────────────────────────
    const pInfo    = projIndexOf[clusterId];                        // 프로젝트 내 위치 정보
    const projIdx  = pInfo.projIdx;                                 // 프로젝트 순번 (0,1,2...)
    const innerIdx = pInfo.innerIdx;                                // 프로젝트 내 행성 순번
    const projSize = pInfo.projSize;                                // 프로젝트 내 행성 수

    // 프로젝트 그룹 중심 위치 — 원형 배치 (중심에서 바깥으로)
    const projAngle = (projIdx / Math.max(projCount, 1)) * Math.PI * 2; // 프로젝트별 각도
    const BASE_R    = 14 + Math.floor(projIdx / 6) * 12;           // 프로젝트 수 많으면 바깥 링으로
    const projCX    = Math.cos(projAngle) * BASE_R;                // 프로젝트 그룹 중심 X
    const projCZ    = Math.sin(projAngle) * BASE_R;                // 프로젝트 그룹 중심 Z

    // 프로젝트 내 행성들 — 작은 그리드 배치
    const INNER_COLS = Math.min(3, Math.ceil(Math.sqrt(projSize))); // 내부 열 수 (최대 3)
    const iCol       = innerIdx % INNER_COLS;                       // 내부 열
    const iRow       = Math.floor(innerIdx / INNER_COLS);           // 내부 행
    const INNER_W    = 5;                                           // 내부 셀 너비
    const INNER_H    = 4;                                           // 내부 셀 높이
    const innerTotalCols = Math.min(projSize, INNER_COLS);

    // 프로젝트 방향 벡터 (중심→프로젝트 방향)
    const dirX  = Math.cos(projAngle);
    const dirZ  = Math.sin(projAngle);
    const perpX = -dirZ;                                            // 직교 방향
    const perpZ = dirX;

    // 내부 오프셋 (그리드 중앙 정렬)
    const colOff = (iCol - (innerTotalCols - 1) / 2) * INNER_W;
    const rowOff = iRow * INNER_H;

    const px = projCX + perpX * colOff + dirX * rowOff;
    const py = 0;
    const pz = projCZ + perpZ * colOff + dirZ * rowOff;
    const COMPACT_R = Math.sqrt(px * px + pz * pz);
    const subAngle  = Math.atan2(pz, px);
    const planetPos = new THREE.Vector3(px, py, pz);

    // 확장: 프로젝트 클릭 시 펼쳐지는 위치
    const EXP_BASE_R = BASE_R + 10;
    const EXP_INNER_W = 8;
    const EXP_INNER_H = 7;
    const expCX  = Math.cos(projAngle) * EXP_BASE_R;
    const expCZ  = Math.sin(projAngle) * EXP_BASE_R;
    const expColOff = (iCol - (innerTotalCols - 1) / 2) * EXP_INNER_W;
    const expRowOff = iRow * EXP_INNER_H;
    const yOffset = 0;

    // ── 행성 의도 & 색상 — 프로젝트별 색상 기반 ─────────────────────────────
    let hueHex;
    if (pl.color) {
      hueHex = pl.color;                                     // purposeColor 직접 사용
    } else {
      // 프로젝트별 고유 색상 (프로젝트 인덱스로 색조 분배)
      const projHue = (projIdx / Math.max(projCount, 1)) * 0.85 + 0.05; // 프로젝트별 색조
      const variation = (innerIdx * 0.03) % 0.1;             // 프로젝트 내 미세한 변화
      hueHex = '#' + new THREE.Color(0).setHSL(
        projHue + variation, 0.7, 0.55 + (innerIdx % 2) * 0.06
      ).getHexString();
    }
    const hue = new THREE.Color(hueHex).getHSL({}).h;

    // intent: 아이콘 + 도메인 라벨 + 첫 메시지 프리뷰 조합 (label에 이미 최적화된 의도 포함)
    const msgPreview = pl.msgPreview || '';
    // label이 이미 아이콘으로 시작하면 iconPrefix 생략 (⚙️ ⚙️ 기타 중복 방지)
    const iconPrefix = (pl.icon && !label.startsWith(pl.icon)) ? `${pl.icon} ` : '';
    const intent = msgPreview
      ? `${iconPrefix}${label}  ${msgPreview}`
      : `${iconPrefix}${label}`;

    // ── 행성 = 보이지 않는 Object3D ──────────────────────────────────────
    const planet = new THREE.Object3D();
    planet.position.copy(planetPos);
    planet.userData.isPlanet    = true;
    planet.userData.clusterId   = clusterId;
    planet.userData.sessionId   = sid;
    planet.userData.domain      = domain;
    planet.userData.intent      = intent;
    planet.userData.hue         = hue;
    planet.userData.hueHex      = hueHex;
    planet.userData.eventCount  = rawEvents.length;
    planet.userData._treeBasePos = planetPos.clone();
    // 2단계 확장 위치 저장 (카테고리 클릭 시 넓게 펼쳐진 그리드)
    const epx = expCX + perpX * expColOff + dirX * expRowOff;
    const epy = 0;
    const epz = expCZ + perpZ * expColOff + dirZ * expRowOff;
    planet.userData._expandedPos = new THREE.Vector3(epx, epy, epz);
    planet.userData._compactPos  = planetPos.clone();
    planet.userData._isExpanded  = false;
    planet.userData.orbitSpeed  = 0;                         // 고정 위치 (회전 없음)
    planet.userData.orbitR      = COMPACT_R;
    planet.userData.orbitθ      = subAngle;
    planet.userData.orbitφ      = 0;
    planet.userData.orbitCenter  = new THREE.Vector3(0,0,0);
    planet.userData.projectName  = pl.projectName || '기타';
    planet.userData.macroCat     = pl.macroCat;              // 매크로 카테고리
    // LOD0 줌인 세부 정보용
    const _fmsg = rawEvents.find(e => e.type === 'user.message');
    planet.userData.firstMsg = (_fmsg?.data?.contentPreview || _fmsg?.data?.content || _fmsg?.label || '').slice(0, 40);
    planet.userData.msgPreview = pl.msgPreview || '';
    scene.add(planet);
    planetMeshes.push(planet);

    // ── 중심→행성 곡선 브랜치 연결선 ──────────────────────────────────────
    {
      const mid = planetPos.clone().multiplyScalar(0.5);
      mid.y += 2; // 약간 위로 꺾여서 자연스러운 가지 느낌
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(0, 0, 0), mid, planetPos.clone()
      );
      const pts = curve.getPoints(20);
      const lg = new THREE.BufferGeometry().setFromPoints(pts);
      const lm = new THREE.LineBasicMaterial({
        color: new THREE.Color(hueHex), transparent: true, opacity: 0.6, linewidth: 2
      });
      const branchLine = new THREE.Line(lg, lm);
      branchLine.userData.isBranch = true;
      branchLine.userData.planetObj = planet;
      branchLine.visible = false;           // 기본 숨김 — 2단계 확장 시 표시
      connections.push(branchLine);
      scene.add(branchLine);
    }

    // ── 파일 위성 집계 (텍스트 태그로 표시) ──────────────────────────────
    const fileSats   = buildFileSatellites(rawEvents);
    const satObjects = [];

    // 부모→중심 방향의 반대(바깥)로 뻗어나감
    const parentDir = new THREE.Vector3(px, 0, pz).normalize();
    const perpDir   = new THREE.Vector3(-parentDir.z, 0, parentDir.x); // 수직방향

    fileSats.forEach((fs, fi) => {
      const SAT_DIST = 4 + fi * 1.5;
      const lateralOffset = (fi - (fileSats.length - 1) / 2) * 2;
      const yOff = (fi % 3 - 1) * 1;

      const sx = px + parentDir.x * SAT_DIST + perpDir.x * lateralOffset;
      const sy = py + yOff;
      const sz = pz + parentDir.z * SAT_DIST + perpDir.z * lateralOffset;

      const sat = new THREE.Object3D();
      sat.position.set(sx, sy, sz);
      sat.userData.isFileSat  = true;
      sat.userData.clusterId  = clusterId;
      sat.userData.sessionId  = sid;
      sat.userData.fileLabel  = fs.label;
      sat.userData.filename   = fs.filename;
      sat.userData.count      = fs.count;
      sat.userData.isWrite    = fs.isWrite;
      sat.userData.planetHex  = hueHex;   // ← 부모 행성 색 상속
      sat.userData._treeBasePos = new THREE.Vector3(sx, sy, sz);
      sat.userData.orbitR     = SAT_DIST;
      sat.userData.orbitθ0    = 0;
      sat.userData.orbitφ0    = 0;
      sat.userData.orbitSpeed = 0.12;
      sat.userData.orbitCenter= planetPos;
      scene.add(sat);
      satelliteMeshes.push(sat);
      satObjects.push(sat);

      // 행성→위성 연결선
      const lg = new THREE.BufferGeometry().setFromPoints([planetPos.clone(), new THREE.Vector3(sx,sy,sz)]);
      const lm = new THREE.LineBasicMaterial({ color: new THREE.Color(hueHex), transparent:true, opacity:0.55 });
      const conn = new THREE.Line(lg, lm);
      conn.userData.satObj = sat;
      conn.visible = false;                 // 기본 숨김 — 3단계 확장 시 표시
      connections.push(conn); scene.add(conn);
    });

    // 이벤트 ROI 누적
    totalTasks += rawEvents.length;
    const MINS = { 'tool.end':0.5,'file.write':2,'file.read':0.5,'git.commit':5,'task.complete':10,'assistant.message':1 };
    for (const e of rawEvents) totalHours += (MINS[e.type]||0) / 60;

    _sessionMap[clusterId] = { planet, fileSats: satObjects, events: rawEvents };
    loadSessionContext(sid);
  });

  document.getElementById('h-sessions').textContent = sessKeys.length;
  document.getElementById('h-tasks').textContent    = totalTasks;
  document.getElementById('h-hours').textContent    = totalHours.toFixed(0)+'h';

  // ── 프로젝트별 그룹화 빌드 ──────────────────────────────────────────────
  _projectGroups = {};
  planetMeshes.forEach(p => {
    const proj = p.userData.projectName || '기타';
    if (!_projectGroups[proj]) {
      _projectGroups[proj] = { planetMeshes: [], color: p.userData.hueHex || '#58a6ff' };
    }
    _projectGroups[proj].planetMeshes.push(p);
  });

  // ── 카테고리별 그룹화 빌드 (기능구현 / 조사분석 / 배포운영) ──────────────
  _categoryGroups = {};
  for (const cat of ['dev', 'research', 'ops']) {
    _categoryGroups[cat] = { planets: [], projects: {}, color: MACRO_CATS[cat].color };
  }
  planetMeshes.forEach(p => {
    const cat  = p.userData.macroCat || 'dev';
    const proj = p.userData.projectName || '기타';
    _categoryGroups[cat].planets.push(p);
    if (!_categoryGroups[cat].projects[proj]) {
      _categoryGroups[cat].projects[proj] = [];
    }
    _categoryGroups[cat].projects[proj].push(p);
  });
}

