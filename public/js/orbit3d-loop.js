// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Animation loop, resize handler
// ══════════════════════════════════════════════════════════════════════════════
// ─── 애니메이션 루프 ──────────────────────────────────────────────────────────
let _lastNow = 0;
let _fpsBuf  = [];

function _orbitAnimLoop(now) {
  const dt = now - _lastNow; _lastNow = now;
  _fpsBuf.push(1000/(dt||16));
  if (_fpsBuf.length>30) _fpsBuf.shift();
  if (now % 600 < 20) {
    document.getElementById('h-fps').textContent = Math.round(_fpsBuf.reduce((a,b)=>a+b,0)/_fpsBuf.length);
  }

  updateCameraLerp(dt);

  if (_teamMode) {
    updateTeamOrbits(dt);
    pulseSun();
    updateRaycast();
    _labelCanvas2d.style.opacity = '1';
    drawLabels();
  } else if (_parallelMode) {
    updateParallelOrbits(dt);
    pulseSun();
    updateRaycast();
    _labelCanvas2d.style.opacity = '1';
    drawLabels();
  } else {
    updateOrbits(dt);
    pulseSun();
    updateRaycast();
    const isPersonal = !_teamMode && !_companyMode && !_parallelMode;
    if (!isPersonal) {
      updateZoomSummary();
      _labelCanvas2d.style.opacity = _zoomSummaryVisible ? '0.15' : '1';
    } else {
      _labelCanvas2d.style.opacity = '1';
    }
    drawLabels();
    // ── 라이브 브랜치 노드 확장 애니메이션 ──────────────────────────────
    if (typeof _animateLiveBranches === 'function') _animateLiveBranches();
  }
  renderer.render(scene, camera);
  if (typeof updateTweens === "function") updateTweens();
  if (typeof animateCoreSkills === "function") animateCoreSkills(Date.now() / 1000);
  // ── Futuristic Space Dashboard: 와이어프레임 행성 + 별 회전 ──────────────
  if (window._corePlanet) {
    const cp = window._corePlanet;
    const t  = now / 1000;
    if (cp.wireMesh)  { cp.wireMesh.rotation.y += 0.002; cp.wireMesh.rotation.x += 0.0005; }
    if (cp.glowMesh)  { cp.glowMesh.scale.setScalar(1.0 + 0.04 * Math.sin(t * 0.8)); }
    if (cp.dustCloud) { cp.dustCloud.rotation.y += 0.001; }
    if (cp.orbitMeshes) { cp.orbitMeshes.forEach((r,i) => { r.rotation.y += 0.0008 * (i+1); }); }
  }
  if (window._starField) { window._starField.rotation.y += 0.0001; }
  // 목표 HUD 업데이트 (Ollama 분석 결과)
  if (window._lastOllamaGoal && now % 2000 < 20) {
    const g = window._lastOllamaGoal;
    const hud = document.getElementById('goal-hud');
    if (hud && g.goal) {
      hud.style.display = 'block';
      document.getElementById('goal-text').textContent = g.goal;
      document.getElementById('phase-text').textContent = g.phase ? '→ ' + g.phase : '';
      const pMap = { '초기': 15, '진행중': 50, '마무리': 85, '완료': 100 };
      document.getElementById('goal-bar').style.width = (pMap[g.progress] || 30) + '%';
    }
  }
  if (typeof updateZoomDisplay === 'function') updateZoomDisplay();
  if (typeof updateZoomLOD === 'function') updateZoomLOD();
  if (typeof drawMinimap3d === 'function') drawMinimap3d();
  // 협업 라인 애니메이션
  if (typeof _collabLines !== 'undefined' && _collabLines.length > 0) {
    const t = now / 1000;
    _collabLines.forEach(cl => {
      // 팀원 이동에 따라 라인 위치 업데이트
      const pts = cl.fromNode?.obj && cl.toNode?.obj
        ? [cl.fromNode.obj.position.clone(), cl.toNode.obj.position.clone()]
        : null;
      if (pts) {
        cl.line.geometry.setFromPoints(pts);
        cl.line.geometry.attributes.position.needsUpdate = true;
        if (cl.outerLine) {
          cl.outerLine.geometry.setFromPoints(pts);
          cl.outerLine.geometry.attributes.position.needsUpdate = true;
        }
      }
      // 포커스 페이드
      const focusId = _focusedMember?.memberId;
      const lineRelated = !focusId ||
        cl.fromNode?.memberId === focusId ||
        cl.toNode?.memberId   === focusId;

      if (cl.crossDept) {
        // 크로스-부서 이펙트: 빠른 고진폭 파동 + 랜덤 플리커
        const flicker = 0.7 + 0.3 * Math.sin(t * 9.5 + cl.phase * 1.7);
        const wave    = 0.55 + 0.45 * Math.sin(t * 4.0 + cl.phase);
        const fire    = flicker * wave;
        cl.mat.opacity     = lineRelated ? 0.4 + 0.55 * fire : 0.05;
        if (cl.outerMat) cl.outerMat.opacity = lineRelated ? 0.15 + 0.25 * fire : 0.02;
      } else {
        // 일반 협업: 느린 사인파 맥박
        const basePulse = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 1.8 + cl.phase));
        cl.mat.opacity = lineRelated ? basePulse : 0.04;
      }
    });
  }
}

renderer.setAnimationLoop(_orbitAnimLoop);

// ─── 탭 비활성 시 렌더링 일시 정지 (CPU/GPU 절약) ──────────────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    renderer.setAnimationLoop(null); // 렌더링 정지 → CPU/GPU 해방
  } else {
    _lastNow = performance.now();
    renderer.setAnimationLoop(_orbitAnimLoop); // 렌더링 재개
  }
});

// ─── 리사이즈 ─────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  resizeRendererToSidebar();
  resizeLabelCanvas();
});
