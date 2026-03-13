'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// Orbit AI — O3D State Bus (전역 상태 단일 관리)
// ══════════════════════════════════════════════════════════════════════════════
//
// 모든 orbit3d-*.js 파일이 공유하는 상태를 하나의 네임스페이스로 통합.
// 다른 파일에서 window._worldScale 대신 O3D.worldScale 사용.
//
// 마이그레이션 중에는 window.xxx와 O3D.xxx 양방향 동기화 유지.
// 마이그레이션 완료 후 Object.defineProperty 심들 제거.
//
// ═══════════════════════════════════════════════════════════════════════════════

window.O3D = {
  // ── Three.js 코어 (orbit3d-core.js에서 설정) ───────────────────────────────
  renderer: null,
  scene: null,
  camera: null,
  controls: null,

  // ── 모드 플래그 (orbit3d-team.js, orbit3d-parallel.js, orbit3d-company.js) ─
  teamMode: false,
  companyMode: false,
  parallelMode: false,

  // ── 2D 월드 네비게이션 (orbit3d-core.js) ──────────────────────────────────
  worldPanX: 0,
  worldPanY: 0,
  worldScale: 1.0,

  // ── 씬 컬렉션 (orbit3d-core.js, orbit3d-scene.js) ────────────────────────
  planetMeshes: [],
  satelliteMeshes: [],
  orbitRings: [],
  connections: [],
  allNodes: [],
  sessionMap: {},     // sessionId → { planet, fileSats, events }
  nodeDataMap: {},    // uuid → data

  // ── 렌더링 상태 (orbit3d-render.js) ───────────────────────────────────────
  labelCanvas2d: null,
  lctx: null,
  hiddenNodes: {},
  activeGlow: {},

  // ── 애니메이션 (orbit3d-core.js, orbit3d-loop.js) ────────────────────────
  orbitAnimOn: true,
  clock: 0,
  starField: null,

  // ── 프로젝트/카테고리 (orbit3d-core.js) ───────────────────────────────────
  projectGroups: {},
  focusedProject: null,
  categoryGroups: {},
  focusedCategory: null,
  activeProjectTypes: [],
  activeFilter: 'all',

  // ── 인터랙션 (orbit3d-canvas2d-hit.js) ───────────────────────────────────
  selectedHit: null,
  hoveredHit: null,

  // ── 중앙 행성 (orbit3d-core.js) ──────────────────────────────────────────
  corePlanet: null,

  // ── 드릴다운 (orbit3d-drilldown.js) ──────────────────────────────────────
  drillStage: 0,
  drillProject: null,
  drillCategory: null,
  drillTimelineEvent: null,

  // ── 팀 뷰 (orbit3d-team.js) ──────────────────────────────────────────────
  focusedMember: null,
  teamClusters: [],

  // ── 사용자 인증 ──────────────────────────────────────────────────────────
  currentUserId: null,
  authToken: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 하위 호환 브릿지: window._xxx ↔ O3D.xxx 양방향 동기화
// 마이그레이션 완료 후 이 섹션 전체 삭제
// ═══════════════════════════════════════════════════════════════════════════════

const _BRIDGE_MAP = {
  // window property → O3D property
  '_worldPanX':   'worldPanX',
  '_worldPanY':   'worldPanY',
  '_worldScale':  'worldScale',
  '_teamMode':    'teamMode',
  '_companyMode': 'companyMode',
  '_allNodes':    'allNodes',
  '_sessionMap':  'sessionMap',
  '_nodeDataMap': 'nodeDataMap',
  '_clock':       'clock',
  '_starField':   'starField',
  '_projectGroups':     'projectGroups',
  '_focusedProject':    'focusedProject',
  '_categoryGroups':    'categoryGroups',
  '_focusedCategory':   'focusedCategory',
  '_activeProjectTypes':'activeProjectTypes',
  '_activeFilter':      'activeFilter',
  '_selectedHit':       'selectedHit',
  '_hoveredHit':        'hoveredHit',
  '_hiddenNodes':       'hiddenNodes',
  '_activeGlow':        'activeGlow',
  '_corePlanet':        'corePlanet',
  '_drillStage':        'drillStage',
  '_drillProject':      'drillProject',
  '_drillCategory':     'drillCategory',
  '_drillTimelineEvent':'drillTimelineEvent',
  // Three.js 코어 (이름 동일)
  'scene':    'scene',
  'camera':   'camera',
  'renderer': 'renderer',
  'controls': 'controls',
};

for (const [winProp, o3dProp] of Object.entries(_BRIDGE_MAP)) {
  // 이미 정의된 것 건너뜀 (const renderer 등)
  const descriptor = Object.getOwnPropertyDescriptor(window, winProp);
  if (descriptor && !descriptor.configurable) continue;

  try {
    Object.defineProperty(window, winProp, {
      get() { return O3D[o3dProp]; },
      set(v) { O3D[o3dProp] = v; },
      configurable: true,
      enumerable: true,
    });
  } catch {
    // 일부 속성은 재정의 불가 — 무시
  }
}

console.log('[O3D] State Bus initialized');
