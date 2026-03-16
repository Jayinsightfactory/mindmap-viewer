// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Scene Build (planets, orbits, satellites)
// ══════════════════════════════════════════════════════════════════════════════

// ─── 다단계 계층 노드 위치 계산 (6-level hierarchy) ──────────────────────────
/**
 * 레벨별 노드 위치 계산
 * Level 0: Compact (기본 위치)
 * Level 1: Personal Work (확장)
 * Level 2: Team Project (더블 확장)
 * Level 3: Collaboration (트리플 확장)
 * Level 4: Department (쿼드러플 확장)
 * Level 5: Company (퀸터플 확장)
 * Level 6: Universe (최대 확장)
 */
function computeMultiLevelPositions(baseR, ring, cap, posInRing) {
  const positions = {};

  // ── Level 0: Compact (기본 부채꼴 배치) ────────────────────────
  const COMPACT_RING_SPACING = 5.5;
  const COMPACT_FAN_SPAN = Math.PI * 1.0;  // 180°
  const COMPACT_FAN_START = -COMPACT_FAN_SPAN / 2;
  const compactR = baseR + ring * COMPACT_RING_SPACING;
  const compactAngle = cap <= 1 ? 0 :
    COMPACT_FAN_START + (posInRing / (cap - 1)) * COMPACT_FAN_SPAN;

  positions.compact = new THREE.Vector3(
    Math.cos(compactAngle) * compactR,
    0,
    Math.sin(compactAngle) * compactR
  );

  // ── Level 1~6: 동적 확장 (레벨별 다른 반지름 & 부채꼴) ────────────
  // 각 레벨마다 더 넓은 각도와 더 큰 반지름 사용
  const expansionConfigs = [
    // [FAN_SPAN_MULTIPLIER, RADIUS_BONUS]
    [1.8,  15],   // Level 1: 324° = 180 * 1.8
    [2.2,  22],   // Level 2: 396° = 180 * 2.2
    [2.6,  33],   // Level 3: 468° = 180 * 2.6
    [3.0,  45],   // Level 4: 540° = 180 * 3.0
    [3.4,  60],   // Level 5: 612° = 180 * 3.4
    [3.8,  77],   // Level 6: 684° = 180 * 3.8 (Universe - 최대 확장)
  ];

  expansionConfigs.forEach((config, idx) => {
    const level = idx + 1;
    const [spanMult, radiusBonus] = config;
    const expandFanSpan = Math.PI * spanMult;
    const expandFanStart = -expandFanSpan / 2;
    const expandR = baseR + radiusBonus + ring * 10;
    const expandAngle = cap <= 1 ? 0 :
      expandFanStart + (posInRing / (cap - 1)) * expandFanSpan;

    positions[`level${level}`] = new THREE.Vector3(
      Math.cos(expandAngle) * expandR,
      0,
      Math.sin(expandAngle) * expandR
    );
  });

  return positions;
}

// ─── 프로젝트명 추출 헬퍼 (파일 경로에서 의미있는 디렉터리 추출) ────────────────
const _SYSTEM_SEGS = new Set([
  'users','home','usr','var','tmp','temp','opt','etc',
  'windows','system32','program files','program files (x86)',
  'appdata','local','roaming','library','application support',
  'node_modules','.git','.gradle','build','dist','out','target',
  'bin','obj','packages','.pub-cache','.m2','.npm',
  'src','main','java','kotlin','res','app',
  'c','d','e','documents','desktop','downloads',
  'cloudstorage','googledrive','google drive',
]);

function _smartProjectFromPath(filePath) {
  if (!filePath) return null;
  var segs = filePath.replace(/\\/g,'/').split('/').filter(Boolean);
  for (var i = segs.length - 2; i >= 0; i--) {
    var seg = segs[i];
    var low = seg.toLowerCase();
    if (_SYSTEM_SEGS.has(low)) continue;
    if (low.startsWith('.')) continue;
    if (/^\d+$/.test(seg)) continue;
    if (low.length < 2) continue;
    if (/^(내 드라이브|my drive|shared drives)$/i.test(seg)) continue;
    return seg;
  }
  return null;
}

// ─── 씬 빌드 ──────────────────────────────────────────────────────────────────
function clearScene() {
  [...planetMeshes, ...satelliteMeshes, ...orbitRings, ...connections].forEach(o => scene.remove(o));
  if (typeof _collabLines !== 'undefined') {
    _collabLines.forEach(cl => { scene.remove(cl.line); if (cl.outerLine) scene.remove(cl.outerLine); });
    _collabLines = [];
  }
  planetMeshes=[]; satelliteMeshes=[]; orbitRings=[]; connections=[]; labelSprites=[];
  _nodeDataMap = {}; clearHitAreas(); _projectGroups = {};
  _topicLinksBuilt = false; _topicLinks.length = 0; _topicLinksLastBuilt = 0;
}

function buildPlanetSystem(nodeList) {
  try { return _buildPlanetSystemInner(nodeList); }
  catch (e) { console.error('[buildPlanetSystem] CRASH:', e.message, e.stack?.split('\n')[1]); }
}
function _buildPlanetSystemInner(nodeList) {
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

    // ── 프로젝트명 추출 (심층 경로 분석) ──────────────────────────────────

    const startEv = rawEvents.find(e => e.type === 'session.start');
    const pd      = startEv?.data?.projectDir || startEv?.data?.cwd || '';
    let projName;
    if (pd) {
      // projectDir/cwd에서도 스마트 추출 시도
      projName = _smartProjectFromPath(pd + '/dummy') || pd.replace(/\\/g,'/').split('/').filter(Boolean).pop();
    } else {
      // 1순위: 파일 경로 분석 — 모든 파일 경로에서 공통 프로젝트명 추출
      const projCounts = {};
      rawEvents.forEach(e => {
        const fps = [
          e.data?.filePath, e.data?.input?.file_path,
          ...(e.data?.files || []),
        ].filter(Boolean);
        fps.forEach(fp => {
          const proj = _smartProjectFromPath(fp);
          if (proj) projCounts[proj] = (projCounts[proj] || 0) + 1;
        });
      });
      const topProj = Object.entries(projCounts).sort((a,b) => b[1] - a[1])[0]?.[0];

      // 2순위: 노드에 이미 주입된 sessionProjectName (graph-engine에서 계산)
      const _nodeProj = rawEvents[0]?.sessionProjectName;

      // 3순위: 첫 user.message
      const _firstUserMsg = rawEvents.find(e => e.type === 'user.message');
      const _msgText = (_firstUserMsg?.data?.contentPreview || _firstUserMsg?.data?.content || '').replace(/[\n\r]/g, ' ').trim();

      if (topProj) {
        projName = topProj;
      } else if (_nodeProj) {
        projName = _nodeProj;
      } else if (_msgText.length > 3) {
        projName = _msgText.slice(0, 30);
      } else if (/^session-([a-zA-Z][a-zA-Z0-9_-]*?)(?:-\d{10,})?$/.test(sid)) {
        projName = sid.match(/^session-([a-zA-Z][a-zA-Z0-9_-]*?)(?:-\d{10,})?$/)[1];
      } else if (/^wf\d+-\d/.test(sid)) {
        projName = '워크플로우';
      } else if (sid === 'default') {
        projName = '기본 작업';
      } else if (sid.length <= 24 && !/\d{8,}/.test(sid)) {
        projName = sid;
      } else {
        projName = '작업 세션';
      }
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
  if (typeof buildCoreMesh === 'function') buildCoreMesh();

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

  // ── 스마트 프로젝트 타입 감지 (활동 패턴 기반) ───────────────────────────
  planets.forEach(pl => {
    pl.macroCat = detectProjectType(pl.events);
  });
  // 동적 카테고리 버킷: 감지된 타입만 생성
  const catBuckets = {};
  planets.forEach(pl => {
    if (!catBuckets[pl.macroCat]) catBuckets[pl.macroCat] = [];
    catBuckets[pl.macroCat].push(pl);
  });

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

    // ── 행성 위치 — 부채꼴 방사형 배치 (노드 간격 최소화) ────
    const pInfo    = projIndexOf[clusterId];
    const projIdx  = pInfo.projIdx;
    const innerIdx = pInfo.innerIdx;
    const projSize = pInfo.projSize;

    // 부채꼴 방사형: 동심 링 + 제한된 각도 범위
    const RING_BASE_CAP  = 10;
    const RING_CAP_INC   = 8;
    const BASE_R         = 10;

    const ringCap = (r) => RING_BASE_CAP + r * RING_CAP_INC;
    let ring = 0, cumulative = 0;
    while (cumulative + ringCap(ring) <= pi) {
      cumulative += ringCap(ring);
      ring++;
    }
    const posInRing   = pi - cumulative;
    const cap         = ringCap(ring);

    // 다단계 계층 위치 계산 (Level 0~6)
    const levelPositions = computeMultiLevelPositions(BASE_R, ring, cap, posInRing);
    const planetPos = levelPositions.compact;  // 기본 위치

    const px = planetPos.x;
    const py = planetPos.y;
    const pz = planetPos.z;

    // 컴팩트 모드 좌표 저장 (카메라 포커싱 용)
    const COMPACT_R = Math.sqrt(px*px + pz*pz);
    const subAngle  = Math.atan2(pz, px);

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

    // 다단계 계층 위치 저장 (Level 0~6)
    planet.userData._levelPositions = levelPositions;
    planet.userData._currentLevel   = 0;  // 현재 표시 중인 레벨 (0=Compact)
    planet.userData._expandedPos    = levelPositions.level1;  // 하위호환성 (기본 확장 = Level 1)
    planet.userData._compactPos     = planetPos.clone();
    planet.userData._isExpanded     = false;

    // 계층 정보 저장
    planet.userData.hierarchyLevel = 0;  // 0=top-level, 1=child, 2=grandchild...
    planet.userData.hierarchyLabel = 'Personal Work';  // 계층 라벨 (필요시 수정)

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
    // 세션 요약 (graph-engine.js computeSessionSummaries 에서 미리 계산됨)
    // 노드에 이미 주입된 심층 분석 필드를 행성에 전파
    const _firstNode = rawEvents[0];
    planet.userData.purpose       = _firstNode?.purpose || '';
    planet.userData.whatSummary   = _firstNode?.whatSummary || '';
    planet.userData.resultSummary = _firstNode?.resultSummary || '';
    planet.userData.techStack     = _firstNode?.techStack || '';
    planet.userData.appsUsed      = _firstNode?.appsUsed || '';
    planet.userData.aiToolsUsed   = _firstNode?.aiToolsUsed || '';
    planet.userData.sessionDuration = _firstNode?.sessionDuration || '';
    // 프로젝트명: session 분석 결과로 보강
    const _curProj = planet.userData.projectName || '';
    if (_firstNode?.sessionProjectName && (_curProj === '작업 세션' || _curProj === '기본 작업' || !_curProj)) {
      planet.userData.projectName = _firstNode.sessionProjectName;
    }
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
      const SAT_DIST = 2.5 + fi * 1.0;                           // 간격 축소 → 밀착 배치
      const lateralOffset = (fi - (fileSats.length - 1) / 2) * 1.2;
      const yOff = (fi % 3 - 1) * 0.6;

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

  try {
    const _hS = document.getElementById('h-sessions');
    const _hT = document.getElementById('h-tasks');
    const _hH = document.getElementById('h-hours');
    if (_hS) _hS.textContent = sessKeys.length;
    if (_hT) _hT.textContent = totalTasks;
    if (_hH) _hH.textContent = totalHours.toFixed(0)+'h';
  } catch {}


  // ── 프로젝트별 그룹화 빌드 ──────────────────────────────────────────────
  _projectGroups = {};
  planetMeshes.forEach(p => {
    const proj = p.userData.projectName || '기타';
    if (!_projectGroups[proj]) {
      _projectGroups[proj] = { planetMeshes: [], color: p.userData.hueHex || '#58a6ff' };
    }
    _projectGroups[proj].planetMeshes.push(p);
  });

  // ── 카테고리별 그룹화 빌드 (동적 프로젝트 타입) ─────────────────────────
  _categoryGroups = {};
  planetMeshes.forEach(p => {
    const cat  = p.userData.macroCat || 'general';
    const proj = p.userData.projectName || '기타';
    if (!_categoryGroups[cat]) {
      const typeCfg = PROJECT_TYPES[cat] || PROJECT_TYPES.general;
      _categoryGroups[cat] = { planets: [], projects: {}, color: typeCfg.color };
    }
    _categoryGroups[cat].planets.push(p);
    if (!_categoryGroups[cat].projects[proj]) {
      _categoryGroups[cat].projects[proj] = [];
    }
    _categoryGroups[cat].projects[proj].push(p);
  });
  // 활성 프로젝트 타입 목록 업데이트 (이벤트 수 기준 정렬)
  _activeProjectTypes = Object.keys(_categoryGroups)
    .filter(k => _categoryGroups[k].planets.length > 0)
    .sort((a, b) => _categoryGroups[b].planets.length - _categoryGroups[a].planets.length);
}

