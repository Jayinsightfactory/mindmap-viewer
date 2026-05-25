'use strict';

const CAPABILITIES = [
  {
    id: 'ocr',
    label: 'OCR / Vision Text',
    role: '화면의 텍스트, 필드, 표, 오류 메시지를 읽어 업무 상태로 바꾼다.',
    currentStage: 'evidence-model',
    requiredEvidence: ['screen.analyzed.visibleText', 'screen.analyzed.fields', 'screen.capture'],
  },
  {
    id: 'claude_in_chrome',
    label: 'Claude in Chrome',
    role: 'Chrome에서 사람이 하던 조사, 비교, 입력 보조 흐름을 업무 단위로 모델링한다.',
    currentStage: 'design-model',
    requiredEvidence: ['browser.navigation', 'windowTitle', 'clipboard.change', 'screen.analyzed'],
  },
  {
    id: 'gui',
    label: 'Native GUI Understanding',
    role: 'Nenova.exe, Excel, KakaoTalk 같은 네이티브 앱의 버튼/필드/좌표 신뢰도를 추정한다.',
    currentStage: 'evidence-model',
    requiredEvidence: ['pad_mouse_map', 'mousePositions', 'screen.analyzed.fields'],
  },
  {
    id: 'playwright',
    label: 'Nenova Web / Playwright',
    role: 'Nenova Web을 테스트 가능한 웹 운영 UI로 검증한다. 직원 PC 실행과 분리한다.',
    currentStage: 'test-model',
    requiredEvidence: ['nenovaweb selectors', 'autotest.result', 'http route map'],
  },
  {
    id: 'computer_use',
    label: 'Computer Use Orchestrator',
    role: '인지, 목표, 행동 계획, 검증, 롤백 조건을 묶어 사람보다 안전한지 판단한다.',
    currentStage: 'promotion-gate',
    requiredEvidence: ['perceptionScore', 'targetingScore', 'verificationScore', 'baselineComparison'],
  },
];

const PROMOTION_REQUIREMENTS = {
  minimumReadiness: 0.85,
  minimumPerception: 0.8,
  minimumTargeting: 0.8,
  minimumVerification: 0.8,
  minimumReplayCases: 50,
  rule: 'Nenova.exe/Nenova Web보다 증거 기반 정확도와 재현성이 높을 때만 직원 제공 단계로 승격한다.',
};

function asData(row) {
  if (!row) return {};
  const raw = row.data_json || row.data || {};
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function ratio(value, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(1, value / total));
}

function scoreFromSignals(signals) {
  const values = Object.values(signals).filter((v) => Number.isFinite(v));
  if (!values.length) return 0;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(3));
}

function evaluateComputerUseReadiness(events = [], mouseMapRows = [], repositorySignals = {}) {
  const rows = Array.isArray(events) ? events : [];
  const dataRows = rows.map((row) => ({ row, data: asData(row), type: row.type }));

  const screenAnalyzed = dataRows.filter((r) => r.type === 'screen.analyzed');
  const screenCaptured = dataRows.filter((r) => r.type === 'screen.capture');
  const keyboardChunks = dataRows.filter((r) => r.type === 'keyboard.chunk');
  const browserEvents = dataRows.filter((r) =>
    r.type === 'browser.navigation' ||
    /chrome|edge|browser/i.test(`${r.data.app || ''} ${r.data.windowTitle || ''} ${r.data.title || ''}`)
  );
  const verificationEvents = dataRows.filter((r) =>
    /result|verified|outcome|test/i.test(r.type || '') ||
    r.data.verification ||
    r.data.outcome
  );

  const withVisibleText = screenAnalyzed.filter((r) => {
    const text = r.data.visibleText || r.data.text || r.data.dataVisible || '';
    return typeof text === 'string' && text.trim().length >= 20;
  });
  const withFields = screenAnalyzed.filter((r) => Array.isArray(r.data.fields) && r.data.fields.length > 0);
  const withAutomationHints = screenAnalyzed.filter((r) =>
    r.data.automationHint || r.data.automatable === true || r.data.automatable === 'true'
  );
  const withMousePositions = keyboardChunks.filter((r) =>
    Array.isArray(r.data.mousePositions) && r.data.mousePositions.length > 0
  );
  const confidentMouseTargets = (mouseMapRows || []).filter((r) => Number(r.confidence || 0) >= 0.5);

  const ocrSignals = {
    analyzedCoverage: ratio(screenAnalyzed.length, Math.max(screenCaptured.length, screenAnalyzed.length, 1)),
    visibleTextCoverage: ratio(withVisibleText.length, screenAnalyzed.length || 1),
    fieldCoverage: ratio(withFields.length, screenAnalyzed.length || 1),
  };
  const guiSignals = {
    mouseTraceCoverage: ratio(withMousePositions.length, keyboardChunks.length || 1),
    learnedTargetCoverage: ratio(confidentMouseTargets.length, Math.max(mouseMapRows.length, 1)),
    fieldTargetCoverage: ratio(withFields.length, screenAnalyzed.length || 1),
  };
  const playwrightSignals = {
    webStructureKnown: repositorySignals.hasNenovaWeb ? 0.65 : 0.25,
    testHarnessKnown: repositorySignals.hasAutotest ? 0.65 : 0.2,
    routeCoverageKnown: repositorySignals.routeCount ? Math.min(1, repositorySignals.routeCount / 50) : 0.2,
  };
  const chromeSignals = {
    browserEvidenceCoverage: ratio(browserEvents.length, rows.length || 1),
    browserContextPresent: browserEvents.length > 0 ? 0.7 : 0.15,
    clipboardBridgePresent: dataRows.some((r) => r.type === 'clipboard.change') ? 0.65 : 0.2,
  };
  const verificationSignals = {
    verificationEvidence: ratio(verificationEvents.length, rows.length || 1),
    automationHintEvidence: ratio(withAutomationHints.length, screenAnalyzed.length || 1),
    replayCaseVolume: Math.min(1, rows.length / PROMOTION_REQUIREMENTS.minimumReplayCases),
  };

  const scores = {
    ocr: scoreFromSignals(ocrSignals),
    gui: scoreFromSignals(guiSignals),
    playwright: scoreFromSignals(playwrightSignals),
    claude_in_chrome: scoreFromSignals(chromeSignals),
    verification: scoreFromSignals(verificationSignals),
  };
  scores.computer_use = scoreFromSignals({
    perception: scoreFromSignals({ ocr: scores.ocr, chrome: scores.claude_in_chrome }),
    targeting: scoreFromSignals({ gui: scores.gui, playwright: scores.playwright }),
    verification: scores.verification,
  });

  const promotionGate = {
    passed:
      scores.computer_use >= PROMOTION_REQUIREMENTS.minimumReadiness &&
      scores.ocr >= PROMOTION_REQUIREMENTS.minimumPerception &&
      scoreFromSignals({ gui: scores.gui, playwright: scores.playwright }) >= PROMOTION_REQUIREMENTS.minimumTargeting &&
      scores.verification >= PROMOTION_REQUIREMENTS.minimumVerification &&
      rows.length >= PROMOTION_REQUIREMENTS.minimumReplayCases,
    requirements: PROMOTION_REQUIREMENTS,
  };
  promotionGate.reason = promotionGate.passed
    ? '테스트 모델 기준상 직원 제공 후보로 승격 가능하다.'
    : '아직 직원 제공 단계가 아니다. 증거량, 검증 이벤트, UI 타겟 신뢰도 중 하나 이상이 부족하다.';

  return {
    stage: 'structure_only',
    employeeFacing: false,
    executionEnabled: false,
    scores,
    signals: { ocrSignals, guiSignals, playwrightSignals, chromeSignals, verificationSignals },
    evidenceCounts: {
      totalEvents: rows.length,
      screenCaptured: screenCaptured.length,
      screenAnalyzed: screenAnalyzed.length,
      visibleText: withVisibleText.length,
      fields: withFields.length,
      keyboardChunks: keyboardChunks.length,
      mouseMapTargets: mouseMapRows.length,
      confidentMouseTargets: confidentMouseTargets.length,
      browserEvents: browserEvents.length,
      verificationEvents: verificationEvents.length,
    },
    capabilities: CAPABILITIES.map((cap) => ({
      ...cap,
      score: scores[cap.id] ?? scores.verification,
      status: promotionGate.passed ? 'candidate' : 'test-only',
    })),
    promotionGate,
    baselines: {
      nenovaExe: '실제 직원 업무 데이터와 네이티브 GUI 증거를 기준선으로 사용한다.',
      nenovaWeb: '웹 UI 테스트 가능성과 selector/replay 재현성을 기준선으로 사용한다.',
      requiredToBeat: '기존 기능보다 정확도, 재현성, 검증 가능성이 높아야 한다.',
    },
    recommendations: buildRecommendations(scores, rows.length),
  };
}

function buildRecommendations(scores, evidenceCount) {
  const recs = [];
  if (evidenceCount < PROMOTION_REQUIREMENTS.minimumReplayCases) {
    recs.push('먼저 과거 데이터 리플레이 케이스를 충분히 쌓아야 한다.');
  }
  if (scores.ocr < 0.8) {
    recs.push('Vision 분석 결과에 visibleText, fields, business identifiers를 더 안정적으로 남긴다.');
  }
  if (scores.gui < 0.8) {
    recs.push('pad_mouse_map과 mousePositions를 화면/필드명 기준으로 더 촘촘히 연결한다.');
  }
  if (scores.verification < 0.8) {
    recs.push('행동 전후 스크린샷, 결과 이벤트, 사람이 수정한 내역을 검증 이벤트로 남긴다.');
  }
  if (!recs.length) recs.push('승격 전 Nenova.exe/Nenova Web 기준선과 같은 업무 샘플로 A/B 리플레이를 진행한다.');
  return recs;
}

function buildNonExecutableSimulation({ intent = '', target = 'nenova.exe', evidence = [] } = {}) {
  const normalizedTarget = String(target || 'nenova.exe').toLowerCase();
  const needsWeb = /web|browser|chrome|playwright/.test(normalizedTarget);
  const needsNative = /exe|nenova|excel|kakao|gui/.test(normalizedTarget);
  const requiredCapabilities = [
    'ocr',
    needsWeb ? 'playwright' : null,
    needsWeb ? 'claude_in_chrome' : null,
    needsNative ? 'gui' : null,
    'computer_use',
  ].filter(Boolean);

  return {
    stage: 'simulation_only',
    employeeFacing: false,
    executionEnabled: false,
    intent,
    target,
    requiredCapabilities,
    plan: [
      '업무 의도를 Work Unit으로 정규화한다.',
      '화면/대화/ERP 증거가 충분한지 확인한다.',
      '필드와 버튼 후보를 식별하되 실제 클릭/입력 명령은 만들지 않는다.',
      'Nenova.exe 또는 Nenova Web 기준선과 성공 조건을 비교한다.',
      '검증 가능성이 기준선보다 높을 때만 별도 승인 단계로 넘긴다.',
    ],
    evidenceSupplied: Array.isArray(evidence) ? evidence.length : 0,
    canGenerateEmployeeAction: false,
    blockedReason: '현재 단계는 구조/평가 모델이다. 직원 PC 실행 또는 배포는 승격 조건을 통과한 뒤 별도 승인해야 한다.',
  };
}

module.exports = {
  CAPABILITIES,
  PROMOTION_REQUIREMENTS,
  evaluateComputerUseReadiness,
  buildNonExecutableSimulation,
};
