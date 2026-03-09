// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Parallel task view, demo, helpers
// ══════════════════════════════════════════════════════════════════════════════
// ── buildParallelView ─────────────────────────────────────────────────────────
function buildParallelView(graphData) {
  clearScene();
  _teamNodes = [];
  _parallelMode = true;
  _teamMode     = false;
  _companyMode  = false;
  _activeSimData = null;
  if (typeof controls !== 'undefined') controls.enabled = true;

  const RING_R = 22;

  // 1. 황금 코어 — 요청 노드 (Y=+8)
  const reqPos = new THREE.Vector3(0, 8, 0);
  const coreMat = new THREE.MeshPhongMaterial({ color: 0xffd700, emissive: 0x7a5800, shininess: 200 });
  const core    = createWireNode(2.5, coreMat.color || 0xffd700, { wireOpacity: 0.35, glowOpacity: 0.06 });
  core.position.copy(reqPos);
  core.userData.isCore = true;
  scene.add(core);
  scene.add(createWireNode(5, 0xffd700, { wireOpacity: 0.06, glow: false, detail: 0 }));
  const reqNode = { type:'prequest', pos: reqPos.clone(), label: graphData.request.label,
    sublabel: graphData.request.sublabel, color: graphData.request.color, size:'xl' };
  _teamNodes.push(reqNode);

  // 2. 배치별 태스크 노드
  const batchCenterNodes = [];
  graphData.batches.forEach((batch, bi) => {
    const Y = batch.yLevel;
    const centerPos = new THREE.Vector3(0, Y, 0);

    // 배치 궤도 링
    const ring  = new THREE.RingGeometry(RING_R - 0.15, RING_R + 0.15, 128);
    const ringM = new THREE.MeshBasicMaterial({ color: 0x58a6ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide });
    const rm    = new THREE.Mesh(ring, ringM);
    rm.rotation.x = Math.PI / 2;
    rm.position.set(0, Y, 0);
    orbitRings.push(rm);
    scene.add(rm);

    const batchCenterNode = { pos: centerPos.clone() };
    batchCenterNodes.push(batchCenterNode);

    batch.tasks.forEach((task, ti) => {
      const angle = (ti / batch.tasks.length) * Math.PI * 2;
      const tPos  = new THREE.Vector3(
        centerPos.x + RING_R * Math.cos(angle),
        Y,
        centerPos.z + RING_R * Math.sin(angle)
      );

      const tObj = new THREE.Object3D();
      tObj.position.copy(tPos);
      tObj.userData = {
        isParallelTask: true,
        taskId:      task.id,
        batchId:     batch.id,
        orbitR:      RING_R,
        orbitAngle:  angle,
        orbitSpeed:  0.012 + ti * 0.004,
        orbitCenter: new THREE.Vector3(0, Y, 0),
      };
      scene.add(tObj);
      planetMeshes.push(tObj);

      const sc = STATUS_CFG[task.status] || STATUS_CFG.pending;
      const node = {
        type: 'ptask', pos: tPos.clone(), obj: tObj,
        label: task.label, sublabel: task.sublabel,
        color: sc.color, size:'lg',
        taskStatus: task.status, taskId: task.id,
        batchId: batch.id, agentType: task.agentType,
        progress: 0,
      };
      _teamNodes.push(node);
    });
  });

  // 3. 결과 노드 (Y=-24, 초기 hidden)
  const resNode = {
    type: 'presult', pos: new THREE.Vector3(0, -24, 0),
    label: graphData.result.label, sublabel: graphData.result.sublabel,
    color: graphData.result.color, size:'xl',
    hidden: true,
  };
  _teamNodes.push(resNode);

  // 4. 의존 라인 생성
  // 요청 → batch1 중심
  const batch1Center = { pos: new THREE.Vector3(0, graphData.batches[0].yLevel, 0) };
  addParallelDepLine(reqNode, batch1Center, false);
  // batch2 → 결과
  const batch2Center = { pos: new THREE.Vector3(0, graphData.batches[1].yLevel, 0) };
  addParallelDepLine(batch2Center, resNode, false);

  // 5. 카메라
  lerpCameraTo(70, 0, 0, 0, 900);

  // 6. HUD + 브레드크럼
  updateBreadcrumb('parallel');
  document.getElementById('h-sessions').textContent = '병렬';
  document.getElementById('h-tasks').textContent    = graphData.batches.reduce((s,b) => s + b.tasks.length, 0);
  document.getElementById('h-hours').textContent    = 'AI';
}

function addParallelDepLine(fromNode, toNode, isMerge) {
  const lg = new THREE.BufferGeometry().setFromPoints([fromNode.pos.clone(), toNode.pos.clone()]);
  const lm = new THREE.LineBasicMaterial({
    color: isMerge ? 0xff6e00 : 0x58a6ff,
    transparent: true,
    opacity: isMerge ? 0.0 : 0.25,
  });
  const ln = new THREE.Line(lg, lm);
  scene.add(ln);
  connections.push(ln);
  _collabLines.push({
    line: ln, mat: lm,
    phase: Math.random() * Math.PI * 2,
    fromNode, toNode,
    crossDept: isMerge,
    isMergeLine: isMerge,
  });
}

// ── 병렬 태스크 상태 헬퍼 ────────────────────────────────────────────────────
function setPtaskStatus(taskId, status) {
  const node = _teamNodes.find(n => n.taskId === taskId);
  if (!node) return;
  const sc = STATUS_CFG[status] || STATUS_CFG.pending;
  node.taskStatus = status;
  node.color = sc.color;
}

function setPtaskProgress(taskId, progress) {
  const node = _teamNodes.find(n => n.taskId === taskId);
  if (node) node.progress = progress;
}

function showMergeLine(batchId) {
  _collabLines.forEach(cl => {
    if (cl.isMergeLine && cl.fromNode?.batchCenter === batchId) {
      cl.mat.opacity = 0.6;
      cl.crossDept = true;
    }
  });
}

// ── runParallelDemo() — 타임라인 기반 상태 애니메이션 ─────────────────────────
function runParallelDemo() {
  // 타이머 초기화
  _parallelDemoTimers.forEach(t => clearTimeout(t));
  _parallelDemoTimers = [];

  const T = (ms, fn) => {
    const id = setTimeout(fn, ms);
    _parallelDemoTimers.push(id);
  };

  // 0ms: 요청 노드 active
  T(0, () => {
    const req = _teamNodes.find(n => n.type === 'prequest');
    if (req) { req.taskStatus = 'active'; req.color = STATUS_CFG.active.color; }
  });

  // batch1 태스크 순차 점화 (800ms 간격)
  T(600,  () => setPtaskStatus('t1', 'active'));
  T(800,  () => setPtaskStatus('t2', 'active'));
  T(1000, () => setPtaskStatus('t3', 'active'));

  // 진행률 증가 시뮬 (1000ms ~ 3500ms)
  let prog = 0;
  const progInterval = setInterval(() => {
    if (!_parallelMode) { clearInterval(progInterval); return; }
    prog = Math.min(prog + 0.06, 1);
    setPtaskProgress('t1', Math.min(prog * 1.1, 1));
    setPtaskProgress('t2', Math.min(prog * 0.9, 1));
    setPtaskProgress('t3', prog);
    if (prog >= 1) clearInterval(progInterval);
  }, 150);
  _parallelDemoTimers.push(progInterval);

  // 3500ms: t1, t3 완료 → merge 라인 등장
  T(3500, () => {
    setPtaskStatus('t1', 'done');
    setPtaskProgress('t1', 1);
    setPtaskStatus('t3', 'done');
    setPtaskProgress('t3', 1);
    // batch1 → batch2 merge 라인 활성화
    _collabLines.forEach(cl => {
      if (cl.isMergeLine) { cl.mat.opacity = 0.6; cl.crossDept = true; }
    });
  });

  // 4500ms: t2 완료 → batch1 전체 done
  T(4500, () => {
    setPtaskStatus('t2', 'done');
    setPtaskProgress('t2', 1);
  });

  // 4800ms: batch2 시작
  T(4800, () => {
    setPtaskStatus('t4', 'active');
    setPtaskStatus('t5', 'active');
  });

  // batch2 진행률 증가
  let prog2 = 0;
  T(5000, () => {
    const prog2Interval = setInterval(() => {
      if (!_parallelMode) { clearInterval(prog2Interval); return; }
      prog2 = Math.min(prog2 + 0.07, 1);
      setPtaskProgress('t4', Math.min(prog2 * 1.15, 1));
      setPtaskProgress('t5', prog2);
      if (prog2 >= 1) clearInterval(prog2Interval);
    }, 120);
    _parallelDemoTimers.push(prog2Interval);
  });

  // 6500ms: t4 완료
  T(6500, () => {
    setPtaskStatus('t4', 'done');
    setPtaskProgress('t4', 1);
  });

  // 7000ms: t5 완료 → 결과 노드 등장
  T(7000, () => {
    setPtaskStatus('t5', 'done');
    setPtaskProgress('t5', 1);

    // 결과 노드 표시
    const resNode = _teamNodes.find(n => n.type === 'presult');
    if (resNode) {
      resNode.hidden = false;
      resNode.taskStatus = 'done';
      // 결과 → 요청 merge 라인 추가
      const reqNode = _teamNodes.find(n => n.type === 'prequest');
      if (reqNode) addParallelDepLine({ pos: new THREE.Vector3(0, -16, 0) }, resNode, true);
    }

    // 요청 노드 done
    const req = _teamNodes.find(n => n.type === 'prequest');
    if (req) { req.taskStatus = 'done'; req.color = STATUS_CFG.done.color; }
  });
}

// 데모용 인재 보드 초기 시드 (실제 환경에서는 서버 API 호출)
function seedDemoTalentBoard(mode) {
  // 이미 시드된 경우 스킵
  if (localStorage.getItem(_TALENT_KEY + '_seeded_' + mode)) return;
  const demoEntries = mode === 'team' ? [
    { memberId:'m2', name:'박지훈', role:'AI 엔지니어', color:'#bc8cff',
      skills:['Python', 'Ollama', 'Fine-tuning', 'Claude Code'],
      tagline:'커스텀 모델 학습·배포 경험 공유 가능', status:'open', published:true, publishedAt:Date.now()-3600000 },
    { memberId:'m4', name:'장현우', role:'기획/PM', color:'#f0883e',
      skills:['Notion', 'Figma', '로드맵', '요구사항'],
      tagline:'스타트업 PM 경험, 협업 구조 설계 도움 가능', status:'ask', published:true, publishedAt:Date.now()-7200000 },
  ] : [
    { memberId:'c10', name:'김기획', role:'PM팀장', color:'#58a6ff',
      skills:['Notion', 'Figma', '로드맵', 'PRD'],
      tagline:'신제품 기획 프로세스 경험 공유', status:'open', published:true, publishedAt:Date.now()-3600000 },
    { memberId:'c40', name:'윤디자인', role:'디자인팀장', color:'#79c0ff',
      skills:['Figma', 'Illustrator', 'UX리뷰', 'Adobe XD'],
      tagline:'브랜드 디자인·UX 피드백 가능', status:'ask', published:true, publishedAt:Date.now()-5400000 },
  ];
  localStorage.setItem(_TALENT_KEY + '_demo', JSON.stringify(demoEntries));
  localStorage.setItem(_TALENT_KEY + '_seeded_' + mode, '1');
}

function exitTeamMode() {
  if (typeof track === 'function') track('view.mode_switch', { from: _companyMode ? 'company' : 'team', to: 'personal' });
  _teamMode = false; _companyMode = false; _teamNodes = [];
  _focusedMember = null; _cameraLerp = null; _activeSimData = null;
  document.getElementById('team-mode-badge').style.display = 'none';
  document.querySelector('.tm-label').textContent = '👥 팀 시뮬레이션';
  updateBreadcrumb('personal');
  localStorage.setItem('orbitViewMode', 'personal');
  loadData();
}
window.exitTeamMode = exitTeamMode;

function exitParallelMode() {
  if (typeof track === 'function') track('view.mode_switch', { from: 'parallel', to: 'personal' });
  _parallelDemoTimers.forEach(t => clearTimeout(t));
  _parallelDemoTimers = [];
  _parallelMode = false;
  _teamNodes = [];
  document.getElementById('parallel-mode-badge').style.display = 'none';
  updateBreadcrumb('personal');
  loadData();
}
window.exitParallelMode = exitParallelMode;

