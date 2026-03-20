'use strict';
/**
 * workflow-learner.js — 업무 워크플로우 자동 학습 엔진
 *
 * 목적: 사용자의 모든 행동을 시퀀스로 기록 → 반복 패턴 추출 → 자동화 템플릿 생성
 *
 * 데이터 수집 단계:
 * 1. Action Recording — 모든 행동을 원자 단위로 기록
 * 2. Sequence Building — 행동들을 작업 단위로 묶음
 * 3. Pattern Mining — 반복 시퀀스 추출
 * 4. Workflow Extraction — 플로우차트 생성
 * 5. Automation Template — 실행 가능한 자동화 스크립트 생성
 *
 * 저장: ~/.orbit/workflows.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKFLOWS_PATH = path.join(os.homedir(), '.orbit', 'workflows.json');
const ACTIONS_PATH = path.join(os.homedir(), '.orbit', 'action-log.jsonl');

let _workflows = { sequences: [], patterns: [], templates: [] };
let _currentSequence = null;
let _actionBuffer = [];

function _loadWorkflows() {
  try { _workflows = JSON.parse(fs.readFileSync(WORKFLOWS_PATH, 'utf8')); } catch { _workflows = { sequences: [], patterns: [], templates: [] }; }
}

function _saveWorkflows() {
  try {
    fs.mkdirSync(path.dirname(WORKFLOWS_PATH), { recursive: true });
    fs.writeFileSync(WORKFLOWS_PATH, JSON.stringify(_workflows, null, 2));
  } catch {}
}

_loadWorkflows();

// ═══════════════════════════════════════════════════════════════
// 1단계: Action Recording — 모든 행동을 원자 단위로 기록
// ═══════════════════════════════════════════════════════════════

/**
 * 행동 기록 (키로거/마우스/스크린 캡처에서 호출)
 */
function recordAction(action) {
  const entry = {
    ts: Date.now(),
    type: action.type,         // app_switch, click, type, scroll, shortcut, copy, paste, wait, screen_change
    app: action.app || '',
    window: action.window || '',
    detail: action.detail || '',  // 클릭 위치, 입력 내용 요약, 단축키 등
    region: action.region || '', // 화면 영역 (LT/RT/LB/RB)
    duration: action.duration || 0,
    visionContext: action.visionContext || '', // Vision 분석 결과
  };

  _actionBuffer.push(entry);

  // JSONL로 영구 기록 (원본 데이터)
  try {
    fs.appendFileSync(ACTIONS_PATH, JSON.stringify(entry) + '\n');
  } catch {}

  // 시퀀스 관리
  if (!_currentSequence) {
    _startNewSequence(entry);
  } else {
    // 앱 전환 또는 5분 공백 → 새 시퀀스
    const gap = entry.ts - (_currentSequence.lastActionTs || entry.ts);
    if (entry.type === 'app_switch' || gap > 5 * 60 * 1000) {
      _endSequence();
      _startNewSequence(entry);
    } else {
      _currentSequence.actions.push(entry);
      _currentSequence.lastActionTs = entry.ts;
      _currentSequence.actionCount++;
    }
  }

  // 100개 행동마다 패턴 분석
  if (_actionBuffer.length % 100 === 0) {
    _analyzePatterns();
  }
}

function _startNewSequence(firstAction) {
  _currentSequence = {
    id: `seq-${Date.now()}`,
    startTs: firstAction.ts,
    lastActionTs: firstAction.ts,
    app: firstAction.app,
    window: firstAction.window,
    actions: [firstAction],
    actionCount: 1,
  };
}

function _endSequence() {
  if (!_currentSequence || _currentSequence.actionCount < 3) return;

  // 시퀀스 요약
  const seq = _currentSequence;
  const summary = {
    id: seq.id,
    app: seq.app,
    startWindow: seq.actions[0]?.window || '',
    endWindow: seq.actions[seq.actions.length - 1]?.window || '',
    actionCount: seq.actionCount,
    duration: seq.lastActionTs - seq.startTs,
    startTs: new Date(seq.startTs).toISOString(),

    // 행동 시그니처 (자동화 매칭용)
    signature: _buildSignature(seq.actions),

    // 행동 요약
    actionSummary: _summarizeActions(seq.actions),

    // 원본 액션 (최대 50개)
    actions: seq.actions.slice(0, 50),
  };

  _workflows.sequences.push(summary);
  // 최근 200개만 유지
  if (_workflows.sequences.length > 200) {
    _workflows.sequences = _workflows.sequences.slice(-200);
  }

  _saveWorkflows();
  _currentSequence = null;
}

// ═══════════════════════════════════════════════════════════════
// 2단계: Signature — 행동 시퀀스의 지문 생성
// ═══════════════════════════════════════════════════════════════

/**
 * 행동 시퀀스 → 시그니처 문자열 (패턴 매칭용)
 * 예: "excel:click→type→click→shortcut:ctrl+c→app_switch:chrome→paste"
 */
function _buildSignature(actions) {
  return actions.slice(0, 20).map(a => {
    const app = (a.app || '').split('.')[0];
    switch (a.type) {
      case 'app_switch': return `→${app}`;
      case 'click': return `${app}:click${a.region ? ':' + a.region : ''}`;
      case 'type': return `${app}:type`;
      case 'shortcut': return `${app}:${a.detail || 'key'}`;
      case 'copy': return 'copy';
      case 'paste': return 'paste';
      case 'scroll': return `${app}:scroll`;
      case 'screen_change': return `${app}:change`;
      default: return a.type;
    }
  }).join('|');
}

// ═══════════════════════════════════════════════════════════════
// 3단계: Pattern Mining — 반복 시퀀스 추출
// ═══════════════════════════════════════════════════════════════

function _analyzePatterns() {
  const sequences = _workflows.sequences;
  if (sequences.length < 5) return;

  // 시그니처 기반 패턴 매칭
  const sigCounts = {};
  sequences.forEach(seq => {
    const sig = seq.signature;
    if (!sig || sig.length < 10) return;

    // 3~8 단계 서브시퀀스 추출
    const parts = sig.split('|');
    for (let len = 3; len <= Math.min(8, parts.length); len++) {
      for (let i = 0; i <= parts.length - len; i++) {
        const sub = parts.slice(i, i + len).join('|');
        if (!sigCounts[sub]) sigCounts[sub] = { count: 0, apps: new Set(), examples: [] };
        sigCounts[sub].count++;
        sigCounts[sub].apps.add(sequences[0]?.app || '');
        if (sigCounts[sub].examples.length < 3) {
          sigCounts[sub].examples.push(seq.id);
        }
      }
    }
  });

  // 2회 이상 반복된 패턴
  const patterns = Object.entries(sigCounts)
    .filter(([_, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([sig, data]) => ({
      signature: sig,
      count: data.count,
      steps: sig.split('|').length,
      apps: [...data.apps],
      examples: data.examples,
      automatable: _assessAutomatability(sig),
      description: _describePattern(sig),
    }));

  _workflows.patterns = patterns;
  _saveWorkflows();

  // 자동화 가능 패턴이 있으면 템플릿 생성
  patterns.filter(p => p.automatable.score > 0.7).forEach(p => {
    if (!_workflows.templates.find(t => t.signature === p.signature)) {
      _generateTemplate(p);
    }
  });
}

/**
 * 패턴의 자동화 가능성 평가
 */
function _assessAutomatability(signature) {
  const steps = signature.split('|');
  let score = 0;
  const reasons = [];

  // 반복적 클릭 패턴 → 자동화 가능
  const clickCount = steps.filter(s => s.includes('click')).length;
  if (clickCount > 3) { score += 0.3; reasons.push(`반복 클릭 ${clickCount}회`); }

  // 복사→붙여넣기 패턴 → 높은 자동화
  if (signature.includes('copy') && signature.includes('paste')) {
    score += 0.4; reasons.push('복사-붙여넣기 워크플로우');
  }

  // 앱 전환 패턴 → 데이터 연동 자동화
  const appSwitches = steps.filter(s => s.startsWith('→')).length;
  if (appSwitches >= 2) { score += 0.3; reasons.push(`${appSwitches}회 앱 전환 (데이터 연동)`); }

  // 입력→클릭 반복 → 폼 자동화
  const typeClickPattern = signature.match(/type\|.*?click/g);
  if (typeClickPattern && typeClickPattern.length >= 2) {
    score += 0.3; reasons.push('폼 입력 패턴');
  }

  // 단축키 사용 → 이미 반자동화된 작업
  const shortcuts = steps.filter(s => s.includes('ctrl') || s.includes('cmd')).length;
  if (shortcuts > 0) { score += 0.1; reasons.push(`단축키 ${shortcuts}회`); }

  return { score: Math.min(1.0, score), reasons };
}

/**
 * 패턴을 사람이 읽을 수 있는 설명으로 변환
 */
function _describePattern(signature) {
  const steps = signature.split('|');
  const descriptions = [];

  steps.forEach(s => {
    if (s.startsWith('→')) descriptions.push(`${s.slice(1)}으로 전환`);
    else if (s.includes(':click')) descriptions.push('클릭');
    else if (s.includes(':type')) descriptions.push('입력');
    else if (s === 'copy') descriptions.push('복사');
    else if (s === 'paste') descriptions.push('붙여넣기');
    else if (s.includes(':scroll')) descriptions.push('스크롤');
    else if (s.includes('ctrl+c') || s.includes('cmd+c')) descriptions.push('복사(단축키)');
    else if (s.includes('ctrl+v') || s.includes('cmd+v')) descriptions.push('붙여넣기(단축키)');
    else if (s.includes('ctrl+s') || s.includes('cmd+s')) descriptions.push('저장');
  });

  return descriptions.join(' → ');
}

// ═══════════════════════════════════════════════════════════════
// 4단계: Workflow Extraction — 플로우차트 생성
// ═══════════════════════════════════════════════════════════════

function _summarizeActions(actions) {
  const apps = [...new Set(actions.map(a => a.app).filter(Boolean))];
  const types = {};
  actions.forEach(a => { types[a.type] = (types[a.type] || 0) + 1; });

  const windows = [...new Set(actions.map(a => a.window).filter(Boolean))].slice(0, 5);

  // Vision 인사이트 수집
  const visionInsights = actions
    .filter(a => a.visionContext)
    .map(a => a.visionContext)
    .slice(0, 5);

  return {
    apps,
    windows,
    actionTypes: types,
    visionInsights,
    totalActions: actions.length,
  };
}

// ═══════════════════════════════════════════════════════════════
// 5단계: Automation Template 생성
// ═══════════════════════════════════════════════════════════════

function _generateTemplate(pattern) {
  const template = {
    id: `tpl-${Date.now()}`,
    signature: pattern.signature,
    description: pattern.description,
    steps: pattern.signature.split('|').map((step, i) => ({
      order: i + 1,
      action: step,
      description: _describeStep(step),
      automationType: _getAutomationType(step),
    })),
    repeatCount: pattern.count,
    automatable: pattern.automatable,
    createdAt: new Date().toISOString(),
    status: 'learned', // learned → suggested → approved → active
  };

  _workflows.templates.push(template);
  if (_workflows.templates.length > 50) {
    _workflows.templates = _workflows.templates.slice(-50);
  }
  _saveWorkflows();

  console.log(`[workflow-learner] 자동화 템플릿 생성: ${pattern.description} (${pattern.count}회 반복)`);
  return template;
}

function _describeStep(step) {
  if (step.startsWith('→')) return `${step.slice(1)} 앱 실행`;
  if (step.includes(':click:LT')) return '화면 좌측 상단 클릭';
  if (step.includes(':click:RT')) return '화면 우측 상단 클릭';
  if (step.includes(':click:LB')) return '화면 좌측 하단 클릭';
  if (step.includes(':click:RB')) return '화면 우측 하단 클릭';
  if (step.includes(':click')) return '클릭';
  if (step.includes(':type')) return '텍스트 입력';
  if (step === 'copy') return '클립보드에 복사';
  if (step === 'paste') return '클립보드에서 붙여넣기';
  if (step.includes(':scroll')) return '스크롤';
  if (step.includes('ctrl+s') || step.includes('cmd+s')) return '파일 저장';
  if (step.includes('ctrl+z') || step.includes('cmd+z')) return '실행 취소';
  return step;
}

function _getAutomationType(step) {
  if (step.startsWith('→')) return 'app_launch';
  if (step.includes(':click')) return 'ui_click';
  if (step.includes(':type')) return 'keyboard_input';
  if (step === 'copy' || step === 'paste') return 'clipboard';
  if (step.includes('ctrl') || step.includes('cmd')) return 'shortcut';
  return 'other';
}

// ═══════════════════════════════════════════════════════════════
// 외부 API
// ═══════════════════════════════════════════════════════════════

/**
 * 현재 학습 상태 반환
 */
function getStatus() {
  return {
    totalActions: _actionBuffer.length,
    totalSequences: _workflows.sequences.length,
    totalPatterns: _workflows.patterns.length,
    totalTemplates: _workflows.templates.length,
    currentSequence: _currentSequence ? {
      app: _currentSequence.app,
      actionCount: _currentSequence.actionCount,
      duration: Date.now() - _currentSequence.startTs,
    } : null,
    topPatterns: _workflows.patterns.slice(0, 5).map(p => ({
      description: p.description,
      count: p.count,
      automatable: p.automatable.score,
    })),
    templates: _workflows.templates.slice(-5).map(t => ({
      description: t.description,
      status: t.status,
      repeatCount: t.repeatCount,
    })),
  };
}

/**
 * 전체 워크플로우 데이터 반환
 */
function getWorkflows() {
  return _workflows;
}

/**
 * 주기적 분석 실행 (데몬에서 호출)
 */
function runAnalysis() {
  _endSequence(); // 현재 시퀀스 마감
  _analyzePatterns();
  _reportToServer(); // 서버에 패턴 전송
  return getStatus();
}

// ═══════════════════════════════════════════════════════════════
// 서버 전송 — 워크플로우 패턴/템플릿을 서버에 주기적 업로드
// ═══════════════════════════════════════════════════════════════

let _reportCallback = null;

function setReporter(callback) {
  _reportCallback = callback;
}

function _reportToServer() {
  if (!_reportCallback) return;
  if (_workflows.patterns.length === 0 && _workflows.templates.length === 0) return;
  try {
    _reportCallback({
      type: 'workflow.patterns',
      patterns: _workflows.patterns.slice(-20),
      templates: _workflows.templates.slice(-10),
      sequenceCount: _workflows.sequences.length,
      timestamp: new Date().toISOString(),
    });
  } catch {}
}

module.exports = {
  recordAction,
  getStatus,
  getWorkflows,
  runAnalysis,
  setReporter,
};
