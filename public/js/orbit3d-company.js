// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — Company Mode: 3D 회사 구조 시각화
// 태양 = 회사, 행성 = 부서, 위성 = 프로세스, 직원 = 입자
// ══════════════════════════════════════════════════════════════════════════════

let _companyData = null;       // 현재 로드된 회사 데이터
let _companyNodes = [];        // 회사 3D 노드들
let _companyEdges = [];        // 연결선들
let _diagnosisData = null;     // 최신 진단 결과
let _companyMeshes = [];       // Three.js 메시 목록
let _companyLabels = [];       // 라벨 데이터
let _companyLines = [];        // 부서 간 연결선
let _selectedCompanyNode = null;

// ── 회사 데이터 로드 ────────────────────────────────────────────────────────

async function loadCompanyData(companyId) {
  try {
    const [graphRes, diagRes, statsRes] = await Promise.all([
      fetch(`/api/company/${companyId}/graph`),
      fetch(`/api/diagnosis/${companyId}/latest`),
      fetch(`/api/company/${companyId}/stats`),
    ]);

    const graph = await graphRes.json();
    const diag = await diagRes.json();
    const stats = await statsRes.json();

    _companyData = graph;
    _diagnosisData = diag.diagnosis;

    return { graph, diagnosis: diag.diagnosis, stats };
  } catch (e) {
    console.warn('[company-mode] 데이터 로드 실패:', e.message);
    return null;
  }
}

// ── 회사 구조 3D 빌드 ──────────────────────────────────────────────────────

function buildCompanyPlanetSystem(data) {
  if (!data || !data.nodes) return;

  // 기존 회사 메시 정리
  clearCompanyMeshes();

  const nodes = data.nodes;
  const edges = data.edges;

  // 색상 매핑
  const COLOR_MAP = {
    company:    0xffd080,  // 금색 (태양)
    department: 0x58a6ff,  // 파란색 (행성)
    employee:   0x3fb950,  // 초록색 (작은 점)
    process:    0xffa657,  // 주황색 (위성)
    system:     0xbc8cff,  // 보라색
  };

  const companyNode = nodes.find(n => n.type === 'company');
  const deptNodes = nodes.filter(n => n.type === 'department');
  const empNodes = nodes.filter(n => n.type === 'employee');
  const procNodes = nodes.filter(n => n.type === 'process');
  const sysNodes = nodes.filter(n => n.type === 'system');

  // ── 회사 (태양) ──────────────────────────────────────────────────────
  if (companyNode) {
    const sunGeo = new THREE.SphereGeometry(3.5, 32, 32);
    const sunMat = new THREE.MeshStandardMaterial({
      color: COLOR_MAP.company,
      emissive: COLOR_MAP.company,
      emissiveIntensity: 0.6,
      roughness: 0.3,
    });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.position.set(0, 0, 0);
    sunMesh.userData = { nodeId: companyNode.id, type: 'company', data: companyNode.data };
    scene.add(sunMesh);
    _companyMeshes.push(sunMesh);

    // 글로우 이펙트
    const glowGeo = new THREE.SphereGeometry(4.5, 16, 16);
    const glowMat = new THREE.MeshBasicMaterial({
      color: COLOR_MAP.company, transparent: true, opacity: 0.15,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    sunMesh.add(glow);
  }

  // ── 부서 (행성) ──────────────────────────────────────────────────────
  const deptPositions = {};
  deptNodes.forEach((dept, i) => {
    const angle = (i / deptNodes.length) * Math.PI * 2;
    const radius = 15 + (i % 3) * 5;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const y = (Math.random() - 0.5) * 4;

    const size = 1.0 + Math.min((dept.data?.head_count || 0) / 10, 2);
    const score = dept.data?.automation_score || 0;

    // 점수에 따른 색상 보간
    const baseColor = new THREE.Color(COLOR_MAP.department);
    const badColor = new THREE.Color(0xf85149);
    const goodColor = new THREE.Color(0x3fb950);
    const color = score > 50 ? goodColor.clone().lerp(baseColor, 0.5) : badColor.clone().lerp(baseColor, 0.5);

    const geo = new THREE.SphereGeometry(size, 24, 24);
    const mat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.3, roughness: 0.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.userData = { nodeId: dept.id, type: 'department', data: dept.data, angle, radius };
    scene.add(mesh);
    _companyMeshes.push(mesh);

    deptPositions[dept.data?.id || dept.id] = { x, y, z, mesh };

    // 궤도 링
    const orbitGeo = new THREE.BufferGeometry();
    const orbitPts = [];
    for (let a = 0; a <= 64; a++) {
      orbitPts.push(new THREE.Vector3(
        Math.cos((a / 64) * Math.PI * 2) * radius, 0,
        Math.sin((a / 64) * Math.PI * 2) * radius
      ));
    }
    orbitGeo.setFromPoints(orbitPts);
    const orbitMat = new THREE.LineBasicMaterial({ color: 0x1a2332, transparent: true, opacity: 0.3 });
    const orbitLine = new THREE.Line(orbitGeo, orbitMat);
    scene.add(orbitLine);
    _companyMeshes.push(orbitLine);

    // 라벨 데이터
    _companyLabels.push({
      mesh, label: dept.data?.name || dept.label,
      sub: `${dept.data?.head_count || 0}명`,
      type: 'department',
    });
  });

  // ── 프로세스 (위성) ──────────────────────────────────────────────────
  const procsByDept = {};
  procNodes.forEach(p => {
    const deptId = p.data?.department_id || '';
    if (!procsByDept[deptId]) procsByDept[deptId] = [];
    procsByDept[deptId].push(p);
  });

  for (const [deptId, procs] of Object.entries(procsByDept)) {
    const parent = deptPositions[deptId];
    if (!parent) continue;

    procs.forEach((proc, i) => {
      const angle = (i / procs.length) * Math.PI * 2;
      const dist = 3 + Math.random() * 2;
      const x = parent.x + Math.cos(angle) * dist;
      const z = parent.z + Math.sin(angle) * dist;
      const y = parent.y + (Math.random() - 0.5) * 2;

      const bottleneck = proc.data?.bottleneck_score || 0;
      const size = 0.3 + bottleneck * 0.5;
      const color = bottleneck > 0.6 ? 0xf85149 : bottleneck > 0.3 ? 0xffa657 : 0x3fb950;

      const geo = new THREE.SphereGeometry(size, 12, 12);
      const mat = new THREE.MeshStandardMaterial({
        color, emissive: color, emissiveIntensity: bottleneck * 0.5, roughness: 0.4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.userData = {
        nodeId: proc.id, type: 'process', data: proc.data,
        parentMesh: parent.mesh, orbitAngle: angle, orbitDist: dist,
      };
      scene.add(mesh);
      _companyMeshes.push(mesh);

      _companyLabels.push({
        mesh, label: proc.data?.name || proc.label,
        sub: bottleneck > 0.5 ? '⚠️ 병목' : `자동화 ${Math.round((proc.data?.automation_potential || 0) * 100)}%`,
        type: 'process',
      });
    });
  }

  // ── 직원 (입자) ──────────────────────────────────────────────────────
  empNodes.forEach(emp => {
    const deptId = emp.data?.department_id || '';
    const parent = deptPositions[deptId];
    const base = parent || { x: 0, y: 0, z: 0 };

    const angle = Math.random() * Math.PI * 2;
    const dist = 1.5 + Math.random() * 2;
    const x = base.x + Math.cos(angle) * dist;
    const z = base.z + Math.sin(angle) * dist;
    const y = base.y + (Math.random() - 0.5) * 1.5;

    const active = emp.data?.tracker_active;
    const color = active ? 0x3fb950 : 0x484f58;

    const geo = new THREE.SphereGeometry(0.2, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.userData = { nodeId: emp.id, type: 'employee', data: emp.data };
    scene.add(mesh);
    _companyMeshes.push(mesh);
  });

  // ── 시스템 (외곽 노드) ───────────────────────────────────────────────
  sysNodes.forEach((sys, i) => {
    const angle = (i / sysNodes.length) * Math.PI * 2 + 0.3;
    const x = Math.cos(angle) * 28;
    const z = Math.sin(angle) * 28;

    const geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_MAP.system, emissive: COLOR_MAP.system, emissiveIntensity: 0.2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 2, z);
    mesh.userData = { nodeId: sys.id, type: 'system', data: sys.data };
    scene.add(mesh);
    _companyMeshes.push(mesh);

    _companyLabels.push({
      mesh, label: sys.data?.name || sys.label,
      sub: sys.data?.category || '',
      type: 'system',
    });
  });

  // ── 부서 간 연결선 ───────────────────────────────────────────────────
  for (const edge of edges) {
    const fromKey = edge.source.replace(/^[^:]+:/, '');
    const toKey = edge.target.replace(/^[^:]+:/, '');
    const fromPos = deptPositions[fromKey];
    const toPos = deptPositions[toKey];
    if (!fromPos || !toPos) continue;

    const points = [
      new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z),
      new THREE.Vector3(toPos.x, toPos.y, toPos.z),
    ];
    const lineGeo = new THREE.BufferGeometry().setFromPoints(points);
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x58a6ff, transparent: true, opacity: 0.15,
    });
    const line = new THREE.Line(lineGeo, lineMat);
    scene.add(line);
    _companyMeshes.push(line);
    _companyLines.push({ line, mat: lineMat, from: fromPos, to: toPos });
  }

  console.log(`[company-mode] 빌드 완료: ${deptNodes.length}부서, ${procNodes.length}프로세스, ${empNodes.length}직원`);
}

// ── 회사 모드 애니메이션 ────────────────────────────────────────────────────

function updateCompanyOrbits(dt) {
  const speed = 0.0003;
  for (const mesh of _companyMeshes) {
    if (mesh.userData?.type === 'department') {
      const angle = (mesh.userData.angle || 0) + speed * (dt || 16);
      mesh.userData.angle = angle;
      const r = mesh.userData.radius || 15;
      mesh.position.x = Math.cos(angle) * r;
      mesh.position.z = Math.sin(angle) * r;
    }
    if (mesh.userData?.type === 'process' && mesh.userData.parentMesh) {
      const parent = mesh.userData.parentMesh;
      const a = (mesh.userData.orbitAngle || 0) + speed * 2 * (dt || 16);
      mesh.userData.orbitAngle = a;
      const d = mesh.userData.orbitDist || 3;
      mesh.position.x = parent.position.x + Math.cos(a) * d;
      mesh.position.z = parent.position.z + Math.sin(a) * d;
      mesh.position.y = parent.position.y + Math.sin(a * 0.5) * 0.5;
    }
  }

  // 연결선 업데이트
  for (const cl of _companyLines) {
    if (cl.from?.mesh && cl.to?.mesh) {
      const pts = [cl.from.mesh.position.clone(), cl.to.mesh.position.clone()];
      cl.line.geometry.setFromPoints(pts);
      cl.line.geometry.attributes.position.needsUpdate = true;
    }
  }
}

// ── 회사 모드 라벨 그리기 ───────────────────────────────────────────────────

function drawCompanyLabels() {
  if (!_labelCanvas2d) return;
  const ctx = _labelCanvas2d.getContext('2d');

  for (const item of _companyLabels) {
    if (!item.mesh) continue;
    const pos = item.mesh.position.clone();
    pos.project(camera);
    const x = (pos.x * 0.5 + 0.5) * _labelCanvas2d.width;
    const y = (-pos.y * 0.5 + 0.5) * _labelCanvas2d.height;

    if (pos.z > 1) continue; // 카메라 뒤

    const fontSize = item.type === 'department' ? 13 : 10;
    ctx.font = `${fontSize}px 'Inter', sans-serif`;
    ctx.fillStyle = item.type === 'department' ? '#58a6ff'
      : item.type === 'process' ? '#ffa657' : '#bc8cff';
    ctx.textAlign = 'center';
    ctx.fillText(item.label, x, y - 12);

    if (item.sub) {
      ctx.font = `${fontSize - 2}px 'Inter', sans-serif`;
      ctx.fillStyle = '#8b949e';
      ctx.fillText(item.sub, x, y + 2);
    }
  }
}

// ── 정리 ────────────────────────────────────────────────────────────────────

function clearCompanyMeshes() {
  for (const mesh of _companyMeshes) {
    scene.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
      else mesh.material.dispose();
    }
  }
  _companyMeshes = [];
  _companyLabels = [];
  _companyLines = [];
}

// ── 진단 HUD 오버레이 ──────────────────────────────────────────────────────

function renderDiagnosisHUD(ctx, w, h) {
  if (!_diagnosisData) return;

  const scores = typeof _diagnosisData.scores_json === 'string'
    ? JSON.parse(_diagnosisData.scores_json) : _diagnosisData.scores;
  if (!scores) return;

  const areas = [
    { key: 'digitalization', name: '디지털화', icon: '💻' },
    { key: 'processEfficiency', name: '프로세스', icon: '⚙️' },
    { key: 'dataUtilization', name: '데이터', icon: '📊' },
    { key: 'humanCapability', name: '인력', icon: '👥' },
    { key: 'costStructure', name: '비용', icon: '💰' },
    { key: 'growthPotential', name: '성장', icon: '📈' },
  ];

  // 좌하단 진단 패널
  const px = 20;
  const py = h - 200;

  ctx.fillStyle = 'rgba(13,17,23,0.85)';
  ctx.roundRect(px, py, 200, 180, 8);
  ctx.fill();

  ctx.fillStyle = '#c9d1d9';
  ctx.font = 'bold 13px Inter, sans-serif';
  ctx.fillText(`진단: ${_diagnosisData.overall_grade || '-'}등급 (${_diagnosisData.overall_score || 0}점)`, px + 10, py + 22);

  areas.forEach((area, i) => {
    const score = scores[area.key]?.score ?? scores[area.key] ?? 0;
    const barY = py + 35 + i * 24;

    ctx.font = '11px Inter, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(`${area.icon} ${area.name}`, px + 10, barY + 4);

    // 바
    const barX = px + 90;
    const barW = 100;
    ctx.fillStyle = '#21262d';
    ctx.fillRect(barX, barY - 6, barW, 10);
    const color = score >= 60 ? '#3fb950' : score >= 40 ? '#ffa657' : '#f85149';
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY - 6, barW * (score / 100), 10);

    ctx.fillStyle = '#c9d1d9';
    ctx.font = '10px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`${score}`, px + 200, barY + 4);
    ctx.textAlign = 'left';
  });
}

// ── 전역 export ─────────────────────────────────────────────────────────────
// orbit3d-loop.js에서 호출
window._companyMode3d = {
  loadCompanyData,
  buildCompanyPlanetSystem,
  updateCompanyOrbits,
  drawCompanyLabels,
  renderDiagnosisHUD,
  clearCompanyMeshes,
  get data() { return _companyData; },
  get diagnosis() { return _diagnosisData; },
};
