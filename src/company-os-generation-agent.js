'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateComputerUseReadiness } = require('./computer-use-capability-model');

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'coverage',
  'data',
  'artifacts',
  'screenshots',
  '__pycache__',
]);

const GENERATION_AGENT = {
  id: 'nenova-company-os-generator',
  label: 'Nenova Company OS Generation Agent',
  stage: 'structure_only',
  employeeFacing: false,
  executionEnabled: false,
  purpose:
    'Nenova.exe, Nenova Web, Kakao, PC activity, Vision, workflow mining을 이해해 회사 전체 업무를 하나의 운영 UI로 설계한다.',
  responsibilities: [
    '현재 코드/문서/라우트/데이터 파이프라인을 읽기 전용으로 인벤토리화한다.',
    '새로 생성되거나 변경된 기능이 어떤 업무 운영 능력에 연결되는지 추적한다.',
    'Nenova.exe/Nenova Web보다 나은지 테스트 모델로 검증하기 전에는 직원 제공 기능으로 승격하지 않는다.',
    '회사 OS UI, 에이전트 역할, 데이터 증거, 자동화 후보를 하나의 생성 브리프로 만든다.',
  ],
};

const OS_LAYERS = [
  {
    id: 'evidence_fusion',
    label: 'Evidence Fusion',
    role: 'PC 작업, 카톡, Nenova ERP, 파일/클립보드, Vision을 Work Unit으로 합친다.',
  },
  {
    id: 'operation_ui',
    label: 'Unified Operation UI',
    role: '사장/관리자/직원이 같은 업무 흐름을 한 화면에서 본다.',
  },
  {
    id: 'agent_algorithm',
    label: 'Agent Algorithm Development',
    role: '업무 해석, 예측, 검증, 보완 행동을 계속 개선한다.',
  },
  {
    id: 'computer_use_lab',
    label: 'Computer Use Lab',
    role: 'OCR, GUI, Chrome, Playwright, Computer Use를 테스트 모델로 평가한다.',
  },
  {
    id: 'commercialization',
    label: 'Sellable System Proof',
    role: '컨설팅/플랫폼/교육 판매용 증거를 정확도, 시간 절감, 업무 재현성으로 만든다.',
  },
];

function scanWorkspace(rootDir, options = {}) {
  const maxFiles = Number(options.maxFiles || 800);
  const maxDepth = Number(options.maxDepth || 4);
  const root = path.resolve(rootDir || process.cwd());
  const files = [];

  function walk(dir, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => priorityRank(a.name) - priorityRank(b.name) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (/recorder\/screenshots/i.test(rel)) continue;
        walk(full, depth + 1);
      } else {
        files.push(rel);
      }
    }
  }

  walk(root, 0);
  return summarizeWorkspace(files);
}

function priorityRank(name) {
  const ranks = {
    'server.js': 0,
    docs: 1,
    routes: 2,
    src: 3,
    daemon: 4,
    scripts: 5,
    tests: 6,
    'nenova-erp-ui': 7,
    public: 8,
  };
  return ranks[name] ?? 50;
}

function summarizeWorkspace(files) {
  const buckets = {
    routes: files.filter((f) => f.startsWith('routes/')),
    source: files.filter((f) => f.startsWith('src/')),
    publicUi: files.filter((f) => f.startsWith('public/')),
    nenovaWeb: files.filter((f) => f.startsWith('nenova-erp-ui/')),
    daemon: files.filter((f) => f.startsWith('daemon/')),
    docs: files.filter((f) => f.startsWith('docs/')),
    scripts: files.filter((f) => f.startsWith('scripts/')),
    tests: files.filter((f) => f.startsWith('tests/')),
  };

  const allText = files.join('\n').toLowerCase();
  const repositorySignals = {
    hasNenovaWeb: buckets.nenovaWeb.length > 0,
    hasAutotest: files.some((f) => /autotest|playwright|e2e/i.test(f)),
    hasVision: /vision|screen-capture|ocr/.test(allText),
    hasKakao: /kakao|카카오/.test(allText),
    hasDaemon: buckets.daemon.length > 0,
    hasRpa: /rpa|pad|automation|playwright/.test(allText),
    routeCount: buckets.routes.length,
    docCount: buckets.docs.length,
  };

  return {
    scannedAt: new Date().toISOString(),
    fileCount: files.length,
    buckets: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])),
    importantFiles: pickImportantFiles(files),
    repositorySignals,
    awareness: buildAwareness(repositorySignals, buckets),
  };
}

function pickImportantFiles(files) {
  const wanted = [
    'server.js',
    'docs/nenova-agent-algorithm-development.md',
    'docs/nenova-work-unit-cross-validation.md',
    'routes/data-intelligence.js',
    'routes/vision-learning.js',
    'routes/process-mining.js',
    'routes/automation-scorer.js',
    'routes/pad-connector.js',
    'routes/script-generator.js',
    'src/screen-capture.js',
    'src/server-vision-worker.js',
    'src/capture-timing-learner.js',
    'daemon/personal-agent.js',
    'public/orbit3d.html',
    'nenova-erp-ui/package.json',
  ];
  return wanted.filter((file) => files.includes(file));
}

function buildAwareness(signals, buckets) {
  const strengths = [];
  const gaps = [];

  if (signals.hasDaemon) strengths.push('직원 PC 작업 데이터 수집 구조가 있다.');
  else gaps.push('직원 PC 작업 데이터 수집 구조가 보이지 않는다.');
  if (signals.hasVision) strengths.push('화면 Vision/OCR 계층이 있다.');
  else gaps.push('화면 인지 계층이 부족하다.');
  if (signals.hasNenovaWeb) strengths.push('Nenova Web UI 코드베이스가 있다.');
  else gaps.push('회사 운영 UI 후보가 부족하다.');
  if (signals.hasKakao) strengths.push('카톡/카카오워크 증거 계층이 있다.');
  else gaps.push('대화 증거 계층이 부족하다.');
  if (buckets.docs.length > 0) strengths.push('기획/알고리즘 문서가 코드와 함께 존재한다.');

  return { strengths, gaps };
}

function buildGenerationBrief({ workspaceSummary, readiness, objective = '' }) {
  const summary = workspaceSummary || { repositorySignals: {}, awareness: { strengths: [], gaps: [] } };
  const computerUse = readiness || evaluateComputerUseReadiness([], [], summary.repositorySignals);
  const layerStatus = OS_LAYERS.map((layer) => {
    let status = 'needs-design';
    if (layer.id === 'evidence_fusion' && summary.repositorySignals.hasDaemon && summary.repositorySignals.hasKakao) status = 'active';
    if (layer.id === 'operation_ui' && summary.repositorySignals.hasNenovaWeb) status = 'prototype';
    if (layer.id === 'agent_algorithm' && summary.importantFiles?.includes('docs/nenova-agent-algorithm-development.md')) status = 'contracted';
    if (layer.id === 'computer_use_lab') status = computerUse.promotionGate?.passed ? 'candidate' : 'test-only';
    if (layer.id === 'commercialization') status = 'proof-building';
    return { ...layer, status };
  });

  return {
    agent: GENERATION_AGENT,
    objective,
    generatedAt: new Date().toISOString(),
    employeeFacing: false,
    executionEnabled: false,
    designPrinciple:
      '생성 에이전트는 먼저 전체 구조를 이해하고, 증거 기반 테스트 모델로 기존 Nenova 기능을 이긴 뒤에만 실제 제공 기능을 만든다.',
    workspaceAwareness: summary.awareness,
    layerStatus,
    computerUseReadiness: computerUse.scores,
    promotionGate: computerUse.promotionGate,
    nextBlueprint: [
      {
        name: 'Company Work Unit Graph',
        description: '직원/고객/주문/대화/PC 작업을 하나의 업무 단위 그래프로 연결한다.',
        requiredEvidence: ['Kakao intent', 'PC activity', 'Nenova ERP confirmation', 'Vision verification'],
      },
      {
        name: 'Unified Operations UI',
        description: '사장이 하루 업무, 병목, 누락, 자동화 후보, 직원별 지원 필요 상태를 한 화면에서 운영한다.',
        requiredEvidence: ['Work Unit confidence', 'validationStatus', 'nextAction', 'outcome'],
      },
      {
        name: 'Generator Evaluation Gate',
        description: '새 UI/자동화/에이전트 제안은 Nenova.exe/Nenova Web 기준선보다 나은지 먼저 점수화한다.',
        requiredEvidence: ['baselineComparison', 'replayResult', 'humanCorrection', 'rollbackPlan'],
      },
      {
        name: 'Agent Memory & Change Awareness',
        description: '파일/문서/라우트/데이터 구조 변경을 인지하고 어떤 운영 능력이 강화됐는지 기록한다.',
        requiredEvidence: ['workspace inventory', 'git/change artifact', 'validation packet'],
      },
    ],
    blockedCapabilities: [
      '직원 PC 직접 실행',
      '강제 배포',
      '무검증 자동 클릭/입력',
      '사람 검토 없는 고객/주문 데이터 변경',
    ],
  };
}

module.exports = {
  GENERATION_AGENT,
  OS_LAYERS,
  scanWorkspace,
  buildGenerationBrief,
};
