/**
 * graph-engine.js
 * 이벤트 → 노드/엣지 투영, 활동 점수 계산
 */

// ─── 노드 색상/형태 정의 ────────────────────────────
const NODE_STYLES = {
  'session.start':       { shape: 'hexagon', color: '#8b5cf6', icon: '🔌', label: 'Session' },
  'session.end':         { shape: 'hexagon', color: '#6b7280', icon: '⏹', label: 'End' },
  'user.message':        { shape: 'box',     color: '#388bfd', icon: '👤', label: 'User' },
  'assistant.message':   { shape: 'box',     color: '#3fb950', icon: '🤖', label: 'Assistant' },
  'tool.end':            { shape: 'diamond', color: '#d29922', icon: '🔧', label: 'Tool' },
  'tool.error':          { shape: 'diamond', color: '#f85149', icon: '❌', label: 'Error' },
  'file.read':           { shape: 'ellipse', color: '#bc8cff', icon: '📄', label: 'File' },
  'file.write':          { shape: 'ellipse', color: '#f778ba', icon: '✏️', label: 'File' },
  'file.create':         { shape: 'ellipse', color: '#f778ba', icon: '📝', label: 'File' },
  'subagent.start':      { shape: 'box',     color: '#79c0ff', icon: '🤖', label: 'Subagent' },
  'subagent.stop':       { shape: 'box',     color: '#6b7280', icon: '🤖', label: 'Subagent' },
  'notification':        { shape: 'circle',  color: '#ffa657', icon: '🔔', label: 'Notify' },
  'task.complete':       { shape: 'circle',  color: '#3fb950', icon: '✅', label: 'Done' },
  'annotation.add':      { shape: 'box',     color: '#f0c674', icon: '📌', label: 'Note' },
  'bookmark':            { shape: 'star',    color: '#ffd700', icon: '⭐', label: 'Bookmark' },
};

const DEFAULT_STYLE = { shape: 'dot', color: '#8b949e', icon: '?', label: 'Event' };

// ─── AI 소스별 스타일 오버라이드 (멀티 AI 지원) ────────
// ai-adapter-base 와 동일 값 인라인 (서버 의존 없이 독립 동작)
const AI_SOURCE_STYLES = {
  claude:     { color: '#3fb950', shape: 'box',     borderColor: '#2ea043', icon: '🟢' },
  gemini:     { color: '#4285f4', shape: 'diamond', borderColor: '#2b6bd6', icon: '🔵' },
  perplexity: { color: '#bc8cff', shape: 'hexagon', borderColor: '#a070e0', icon: '🟣' },
  openai:     { color: '#8b949e', shape: 'box',     borderColor: '#6e7681', icon: '⚪' },
  vscode:     { color: '#f85149', shape: 'ellipse', borderColor: '#da3633', icon: '🔴' },
};

// ─── 이벤트 → 그래프 빌드 ──────────────────────────
function buildGraph(events) {
  const nodes = [];
  const edges = [];
  const fileNodes = new Map(); // path → nodeId (파일 중복 제거)
  const nodeSet = new Set();

  for (const event of events) {
    const style = NODE_STYLES[event.type] || DEFAULT_STYLE;
    const nodeId = event.id;

    // 노드 라벨 생성
    const label = buildLabel(event);

    // ── AI 소스별 스타일 오버라이드 ──
    // event._style (어댑터 주입) > AI_SOURCE_STYLES > 기본 NODE_STYLES
    const aiSrc = event.aiSource;
    const aiOverride = event._style || (aiSrc && AI_SOURCE_STYLES[aiSrc]
      ? {
          color: {
            background: AI_SOURCE_STYLES[aiSrc].color,
            border:     AI_SOURCE_STYLES[aiSrc].borderColor,
            highlight:  { background: lighten(AI_SOURCE_STYLES[aiSrc].color), border: AI_SOURCE_STYLES[aiSrc].borderColor },
            hover:      { background: lighten(AI_SOURCE_STYLES[aiSrc].color), border: AI_SOURCE_STYLES[aiSrc].borderColor },
          },
          shape: AI_SOURCE_STYLES[aiSrc].shape,
        }
      : null);

    const nodeColor = aiOverride?.color || {
      background: style.color,
      border: style.color,
      highlight: { background: lighten(style.color), border: style.color },
      hover: { background: lighten(style.color), border: style.color },
    };
    const nodeShape = aiOverride?.shape || style.shape;

    const node = {
      id: nodeId,
      eventId: event.id,
      type: event.type,
      label,
      fullContent: event.data.content || event.data.inputPreview || JSON.stringify(event.data),
      shape: nodeShape,
      color: nodeColor,
      font: { color: '#ffffff', size: 13, face: 'Inter, Pretendard, sans-serif', bold: { color: '#ffffff' } },
      size: getNodeSize(event),
      level: getNodeLevel(event),
      group: event.sessionId,
      borderWidth: 2,
      shadow: false,
      // 활동 시각화 데이터
      activityScore: 0,
      lastActiveAt: event.timestamp,
      accessCount: 1,
      // 메타
      sessionId: event.sessionId,
      eventType: event.type,
      timestamp: event.timestamp,
      // 멀티 AI 메타
      aiSource:   aiSrc || 'claude',
      aiIcon:     (aiSrc && AI_SOURCE_STYLES[aiSrc]?.icon) || event.data?.aiIcon || null,
      aiLabel:    event.data?.aiLabel || null,
      citations:  event.data?.citations || null,
    };

    nodes.push(node);
    nodeSet.add(nodeId);

    // 부모 연결 엣지
    if (event.parentEventId && nodeSet.has(event.parentEventId)) {
      edges.push({
        id: `e_${event.parentEventId}_${nodeId}`,
        from: event.parentEventId,
        to: nodeId,
        ...getEdgeStyle(event),
      });
    }

    // 파일 노드 (중복 제거)
    if (event.type === 'tool.end' && event.data.files) {
      for (const filePath of event.data.files) {
        if (!filePath || filePath.startsWith('[')) continue; // cmd, glob 제외
        const fileId = `file_${hashPath(filePath)}`;

        if (!fileNodes.has(filePath)) {
          fileNodes.set(filePath, fileId);
          const fileName = filePath.replace(/\\/g, '/').split('/').pop();
          nodes.push({
            id: fileId,
            eventId: null,
            type: 'file',
            label: `📄 ${fileName}`,
            fullContent: filePath,
            shape: 'ellipse',
            color: {
              background: '#bc8cff',
              border: '#bc8cff',
              highlight: { background: '#d4b3ff', border: '#bc8cff' },
              hover: { background: '#d4b3ff', border: '#bc8cff' },
            },
            font: { color: '#ffffff', size: 11, face: 'Inter, Pretendard, sans-serif' },
            size: 15,
            level: getNodeLevel(event) + 1,
            group: 'files',
            borderWidth: 1,
            shadow: false,
            activityScore: 0,
            lastActiveAt: event.timestamp,
            accessCount: 1,
            sessionId: event.sessionId,
            eventType: 'file',
            timestamp: event.timestamp,
          });
          nodeSet.add(fileId);
        } else {
          // 기존 파일 노드 접근 횟수 증가
          const existingNode = nodes.find(n => n.id === fileNodes.get(filePath));
          if (existingNode) {
            existingNode.accessCount++;
            existingNode.lastActiveAt = event.timestamp;
            existingNode.size = Math.min(30, 15 + existingNode.accessCount * 2);
          }
        }

        // 도구 → 파일 엣지
        const fId = fileNodes.get(filePath);
        const edgeId = `e_${nodeId}_${fId}`;
        if (!edges.find(e => e.id === edgeId)) {
          edges.push({
            id: edgeId,
            from: nodeId,
            to: fId,
            dashes: true,
            width: 1,
            color: { color: '#bc8cff55', highlight: '#bc8cff', hover: '#bc8cff' },
            arrows: { to: { enabled: true, scaleFactor: 0.5 } },
            smooth: { type: 'curvedCW', roundness: 0.2 },
          });
        }
      }
    }
  }

  return { nodes, edges };
}

// ─── 도구명 → 자연어 매핑 ────────────────────────────
const TOOL_LABELS = {
  'Read': '파일 읽기', 'Write': '파일 작성', 'Edit': '파일 수정',
  'Bash': '명령어 실행', 'Glob': '파일 찾기', 'Grep': '내용 검색',
  'WebSearch': '웹 검색', 'WebFetch': '웹 페이지 확인',
  'Task': '하위 작업', 'TodoWrite': '할일 정리',
  'AskUserQuestion': '사용자에게 질문', 'EnterPlanMode': '계획 수립',
  'ExitPlanMode': '계획 확정', 'NotebookEdit': '노트북 수정',
};

// ─── 노드 라벨 생성 ────────────────────────────────
function buildLabel(event) {
  switch (event.type) {
    case 'session.start':
      return `세션 시작 ${formatTime(event.timestamp)}`;
    case 'session.end':
      return '세션 종료';
    case 'user.message':
      return truncate(event.data.contentPreview || event.data.content || '질문', 28);
    case 'assistant.message':
      return truncate(event.data.contentPreview || event.data.content || '답변', 28);
    case 'tool.end':
      return TOOL_LABELS[event.data.toolName] || event.data.toolName || '작업';
    case 'tool.error':
      return `실패: ${TOOL_LABELS[event.data.toolName] || event.data.toolName || '작업'}`;
    case 'file.read':
    case 'file.write':
    case 'file.create':
      return truncate(event.data.fileName || '파일', 20);
    case 'subagent.start':
      return `하위작업: ${event.data.agentType || '진행 중'}`;
    case 'subagent.stop':
      return '하위작업 완료';
    case 'notification':
      return truncate(event.data.message || '알림', 20);
    case 'task.complete':
      return '작업 완료';
    case 'annotation.add':
      return truncate(event.data.label || '메모', 20);
    default:
      return event.type;
  }
}

// ─── 엣지 스타일 ────────────────────────────────────
function getEdgeStyle(event) {
  const base = {
    width: 1.5,
    dashes: false,
    arrows: { to: { enabled: true, scaleFactor: 0.6 } },
    smooth: { type: 'cubicBezier', roundness: 0.4 },
  };

  switch (event.type) {
    case 'user.message':
      return { ...base, color: { color: '#388bfd55', highlight: '#388bfd' }, width: 2 };
    case 'assistant.message':
      return { ...base, color: { color: '#3fb95055', highlight: '#3fb950' }, width: 2 };
    case 'tool.end':
    case 'tool.error':
      return { ...base, color: { color: '#d2992255', highlight: '#d29922' }, width: 1, dashes: false };
    case 'subagent.start':
    case 'subagent.stop':
      return { ...base, color: { color: '#79c0ff55', highlight: '#79c0ff' }, dashes: [5, 5] };
    case 'annotation.add':
      return { ...base, color: { color: '#f0c67455', highlight: '#f0c674' }, dashes: [3, 3] };
    default:
      return { ...base, color: { color: '#8b949e33', highlight: '#8b949e' } };
  }
}

// ─── 노드 크기/레벨 ────────────────────────────────
function getNodeSize(event) {
  switch (event.type) {
    case 'session.start': return 30;
    case 'user.message': return 22;
    case 'assistant.message': return 25;
    case 'tool.end': return 16;
    case 'tool.error': return 16;
    case 'subagent.start': return 20;
    case 'annotation.add': return 18;
    default: return 14;
  }
}

function getNodeLevel(event) {
  switch (event.type) {
    case 'session.start': return 0;
    case 'session.end': return 0;
    case 'user.message': return 1;
    case 'assistant.message': return 1;
    case 'tool.end':
    case 'tool.error': return 2;
    case 'file.read':
    case 'file.write':
    case 'file.create': return 3;
    case 'subagent.start':
    case 'subagent.stop': return 2;
    default: return 2;
  }
}

// ─── 활동 점수 계산 ────────────────────────────────
function computeActivityScores(nodes, now) {
  const nowMs = now || Date.now();
  const HALF_LIFE_MS = 5 * 60 * 1000; // 5분 반감기
  const DECAY = 0.693 / HALF_LIFE_MS;

  for (const node of nodes) {
    const lastActive = new Date(node.lastActiveAt).getTime();
    const ageMs = nowMs - lastActive;

    // 지수 감쇠
    const recencyScore = Math.exp(-DECAY * ageMs);

    // 빈도 보정 (log 스케일)
    const frequencyScore = Math.min(1, Math.log2((node.accessCount || 1) + 1) / 5);

    // 합산: 최근성 70% + 빈도 30%
    node.activityScore = Math.min(1, recencyScore * 0.7 + frequencyScore * 0.3);
  }
}

// ─── 활동 점수 → 시각 속성 변환 ────────────────────
function applyActivityVisualization(nodes) {
  for (const node of nodes) {
    const score = node.activityScore || 0;

    // 테두리 밝기
    if (score > 0.1) {
      const glowAlpha = Math.round(score * 255).toString(16).padStart(2, '0');
      node.borderWidth = 2 + score * 4;
      node.shadow = {
        enabled: true,
        color: `${(node.color?.background || '#ffffff')}${glowAlpha}`,
        size: score * 20,
        x: 0,
        y: 0,
      };
    }

    // 크기 스케일 (1x ~ 1.5x)
    node.size = (node.size || 16) * (1 + score * 0.5);
  }
}

// ─── 유틸 ───────────────────────────────────────────
function truncate(str, len) {
  if (!str) return '';
  str = str.replace(/\n/g, ' ').trim();
  return str.length > len ? str.substring(0, len) + '...' : str;
}

function formatTime(ts) {
  try {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  } catch { return ''; }
}

function lighten(hex) {
  if (!hex || hex.length < 7) return hex;
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 40);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 40);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 40);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function hashPath(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ─── AI 라벨 제안 엔진 ──────────────────────────────
// 문맥 기반으로 노드에 의미 있는 라벨을 자동 제안

// 파일 확장자 → 작업 의도 매핑
const FILE_INTENT = {
  '.js': '코드 작업', '.ts': '코드 작업', '.jsx': '컴포넌트 작업', '.tsx': '컴포넌트 작업',
  '.py': '파이썬 코드 작업', '.rs': 'Rust 코드 작업', '.go': 'Go 코드 작업',
  '.html': 'UI 작업', '.css': '스타일 작업', '.scss': '스타일 작업',
  '.json': '설정 작업', '.yaml': '설정 작업', '.yml': '설정 작업',
  '.md': '문서 작업', '.txt': '텍스트 작업',
  '.sql': 'DB 작업', '.sh': '스크립트 작업',
  '.test.js': '테스트 작업', '.spec.ts': '테스트 작업', '.test.ts': '테스트 작업',
};

// 도구 + 문맥 → 의도 기반 라벨
const TOOL_INTENT = {
  'Read': { verb: '분석', icon: '🔍' },
  'Write': { verb: '작성', icon: '✍️' },
  'Edit': { verb: '수정', icon: '📝' },
  'Bash': { verb: '실행', icon: '⚡' },
  'Glob': { verb: '탐색', icon: '🔎' },
  'Grep': { verb: '검색', icon: '🔍' },
  'WebSearch': { verb: '조사', icon: '🌐' },
  'WebFetch': { verb: '참고', icon: '📖' },
  'Task': { verb: '위임', icon: '🤖' },
  'TodoWrite': { verb: '계획 정리', icon: '📋' },
  'AskUserQuestion': { verb: '확인 요청', icon: '💬' },
  'EnterPlanMode': { verb: '설계 시작', icon: '📐' },
  'ExitPlanMode': { verb: '설계 완료', icon: '✅' },
  'NotebookEdit': { verb: '노트북 편집', icon: '📓' },
};

// Bash 명령어 패턴 → 의도
const BASH_PATTERNS = [
  { re: /npm (run |)(test|jest)/i, label: '테스트 실행' },
  { re: /npm (run |)(build|compile)/i, label: '빌드 실행' },
  { re: /npm (run |)(dev|start)/i, label: '개발 서버 시작' },
  { re: /npm install/i, label: '패키지 설치' },
  { re: /git (add|commit|push|pull|merge|rebase)/i, label: (m) => `Git ${m[1]}` },
  { re: /git (status|diff|log)/i, label: (m) => `Git 상태 확인` },
  { re: /docker/i, label: '도커 작업' },
  { re: /curl|wget|fetch/i, label: '외부 API 호출' },
  { re: /mkdir|rmdir|cp|mv|rm/i, label: '파일 시스템 작업' },
  { re: /kill|Stop-Process/i, label: '프로세스 정리' },
  { re: /powershell|pwsh/i, label: '시스템 명령' },
  { re: /cd\s/i, label: '디렉토리 이동' },
  { re: /ls|dir/i, label: '파일 목록 확인' },
];

function getFileIntent(filePath) {
  if (!filePath) return null;
  const p = String(filePath).toLowerCase();
  // 테스트 파일 우선 체크
  if (p.includes('.test.') || p.includes('.spec.') || p.includes('__test__')) return '테스트 작업';
  if (p.includes('/test/') || p.includes('/tests/')) return '테스트 관련';
  // 설정 파일
  if (p.includes('config') || p.includes('settings') || p.includes('.env')) return '설정 작업';
  if (p.includes('package.json') || p.includes('tsconfig')) return '프로젝트 설정';
  // 확장자 기반
  for (const [ext, intent] of Object.entries(FILE_INTENT)) {
    if (p.endsWith(ext)) return intent;
  }
  return null;
}

function suggestLabel(event, allEvents) {
  const suggestions = { header: null, body: null, intent: null, confidence: 0 };

  switch (event.type) {
    case 'user.message': {
      const content = event.data.content || event.data.contentPreview || '';
      // 질문 유형 분석
      if (/구현|만들|추가|개발|작성/u.test(content)) {
        suggestions.intent = '기능 구현 요청';
        suggestions.header = '🛠 구현 요청';
      } else if (/수정|변경|바꿔|고쳐|fix/iu.test(content)) {
        suggestions.intent = '수정/버그 수정 요청';
        suggestions.header = '🔧 수정 요청';
      } else if (/설명|알려|뭐|어떻게|왜/u.test(content)) {
        suggestions.intent = '질문/설명 요청';
        suggestions.header = '❓ 질문';
      } else if (/확인|검토|리뷰|review/iu.test(content)) {
        suggestions.intent = '검토 요청';
        suggestions.header = '🔍 검토 요청';
      } else if (/삭제|제거|remove|delete/iu.test(content)) {
        suggestions.intent = '삭제 요청';
        suggestions.header = '🗑 삭제 요청';
      } else if (/테스트|test/iu.test(content)) {
        suggestions.intent = '테스트 요청';
        suggestions.header = '🧪 테스트 요청';
      }
      suggestions.body = content.substring(0, 60).replace(/\n/g, ' ').trim();
      suggestions.confidence = suggestions.intent ? 0.7 : 0.3;
      break;
    }

    case 'assistant.message': {
      const content = event.data.content || event.data.contentPreview || '';
      const toolCalls = event.data.toolCalls || [];
      if (toolCalls.length > 3) {
        suggestions.intent = '대규모 작업 수행';
        suggestions.header = '🚀 복합 작업';
      } else if (toolCalls.length > 0) {
        suggestions.intent = '작업 수행';
        suggestions.header = '⚡ 작업 수행';
      } else {
        suggestions.intent = '응답';
        suggestions.header = '💬 설명/응답';
      }
      suggestions.body = content.substring(0, 60).replace(/\n/g, ' ').trim();
      suggestions.confidence = 0.5;
      break;
    }

    case 'tool.end':
    case 'tool.error': {
      const toolName = event.data.toolName || '';
      const intent = TOOL_INTENT[toolName];
      const filePath = event.data.files?.[0] || event.data.input?.file_path;
      const fileIntent = getFileIntent(filePath);

      if (toolName === 'Bash') {
        const cmd = event.data.input?.command || event.data.inputPreview || '';
        for (const pat of BASH_PATTERNS) {
          const m = cmd.match(pat.re);
          if (m) {
            suggestions.header = `⚡ ${typeof pat.label === 'function' ? pat.label(m) : pat.label}`;
            suggestions.body = cmd.substring(0, 60);
            suggestions.intent = typeof pat.label === 'function' ? pat.label(m) : pat.label;
            suggestions.confidence = 0.8;
            break;
          }
        }
        if (!suggestions.intent) {
          suggestions.header = '⚡ 명령어 실행';
          suggestions.body = cmd.substring(0, 60);
          suggestions.confidence = 0.4;
        }
      } else if (intent && filePath) {
        const fileName = String(filePath).replace(/\\/g, '/').split('/').pop();
        suggestions.header = `${intent.icon} ${fileIntent || intent.verb}`;
        suggestions.body = fileName;
        suggestions.intent = `${intent.verb}: ${fileName}`;
        suggestions.confidence = 0.8;
      } else if (intent) {
        suggestions.header = `${intent.icon} ${intent.verb}`;
        suggestions.body = event.data.inputPreview || toolName;
        suggestions.intent = intent.verb;
        suggestions.confidence = 0.6;
      }

      if (event.type === 'tool.error') {
        suggestions.header = `❌ ${suggestions.header || '실패'}`;
        suggestions.intent = `실패: ${suggestions.intent || toolName}`;
      }
      break;
    }

    case 'subagent.start': {
      const desc = event.data.taskDescription || event.data.agentType || '';
      suggestions.header = '🤖 하위 에이전트';
      suggestions.body = desc.substring(0, 60);
      suggestions.intent = `하위 작업: ${desc.substring(0, 30)}`;
      suggestions.confidence = 0.6;
      break;
    }

    case 'session.start': {
      suggestions.header = '🟢 새 세션';
      suggestions.body = '대화 시작';
      suggestions.confidence = 0.9;
      break;
    }

    default: {
      suggestions.confidence = 0.1;
    }
  }

  return suggestions;
}

module.exports = {
  buildGraph,
  computeActivityScores,
  applyActivityVisualization,
  suggestLabel,
  NODE_STYLES,
};
