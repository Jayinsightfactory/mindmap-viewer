/**
 * graph-engine.js
 * 이벤트 → 노드/엣지 투영, 활동 점수 계산
 */

// ─── 노드 색상/형태 정의 ────────────────────────────
const NODE_STYLES = {
  'session.start':       { shape: 'hexagon', color: '#8b5cf6', icon: '🚀', label: '시작' },
  'session.end':         { shape: 'hexagon', color: '#6b7280', icon: '⏹', label: '종료' },
  'user.message':        { shape: 'box',     color: '#388bfd', icon: '👤', label: 'User' },
  'assistant.message':   { shape: 'box',     color: '#3fb950', icon: '🤖', label: 'Assistant' },
  // tool.start: PreToolUse — 깜박이는 주황 테두리로 "진행 중" 표시
  'tool.start':          { shape: 'diamond', color: '#ff9500', icon: '⚡', label: 'Working' },
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
  'keyboard.chunk':      { shape: 'dot',     color: '#58a6ff', icon: '⌨️', label: '입력' },
  'screen.capture':      { shape: 'dot',     color: '#f0883e', icon: '📸', label: '캡처' },
  'screen.analyzed':     { shape: 'circle',  color: '#3fb950', icon: '🔍', label: '분석' },
  'idle':                { shape: 'dot',     color: '#484f58', icon: '💤', label: '대기' },
  'file.change':         { shape: 'ellipse', color: '#d2a8ff', icon: '📁', label: '파일' },
  'clipboard.change':    { shape: 'dot',     color: '#79c0ff', icon: '📋', label: '클립보드' },
  'bank.security.active':{ shape: 'dot',     color: '#f85149', icon: '🏦', label: '은행보안' },
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

// ─── 파일 역할 추론 맵 (경로/파일명 → 한국어 모듈 라벨) ──────────────────────
const FILE_ROLE_MAP = [
  [/auth|login|oauth|jwt|token|password|credential|signin|signup/i, '인증'],
  [/route|router|api|endpoint|controller|handler/i, 'API'],
  [/service|manager|provider|helper|util/i, '서비스 로직'],
  [/component|widget|view|page|screen|activity|fragment/i, 'UI'],
  [/model|schema|entity|dto|type/i, '데이터 모델'],
  [/test|spec|mock|fixture|__test__/i, '테스트'],
  [/config|setting|env|\.yml$|\.yaml$|\.gradle|\.toml$|\.properties$/i, '설정'],
  [/style|css|scss|sass|theme|color|tailwind/i, '스타일'],
  [/migration|seed|\.sql$/i, 'DB'],
  [/deploy|docker|ci|cd|workflow|\.github/i, '배포'],
  [/readme|doc|guide|tutorial|changelog/i, '문서'],
  [/receiver|listener|observer|broadcast/i, '이벤트 수신기'],
  [/middleware|interceptor|filter|guard/i, '미들웨어'],
  [/store|reducer|state|context|redux|zustand|recoil/i, '상태관리'],
  [/hook|use[A-Z]/i, '커스텀 훅'],
  [/\.json$/i, '설정'],         // fallback for .json (package.json etc.)
];

// 파일 확장자 → 기술 스택 추론
const EXT_TO_TECH = {
  '.kt': 'Kotlin', '.java': 'Java', '.py': 'Python', '.rs': 'Rust', '.go': 'Go',
  '.js': 'JavaScript', '.ts': 'TypeScript', '.jsx': 'React', '.tsx': 'React',
  '.swift': 'Swift', '.dart': 'Dart', '.rb': 'Ruby', '.php': 'PHP',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue',
  '.gradle': 'Gradle', '.toml': 'TOML', '.yml': 'YAML', '.yaml': 'YAML',
  '.sql': 'SQL', '.sh': 'Shell', '.bat': 'Batch', '.ps1': 'PowerShell',
  '.md': 'Markdown', '.json': 'JSON', '.xml': 'XML',
  '.c': 'C', '.cpp': 'C++', '.h': 'C/C++', '.cs': 'C#',
};

// 시스템 경로 세그먼트 (프로젝트명 추출 시 무시)
const SYSTEM_PATH_SEGMENTS = new Set([
  'users', 'home', 'usr', 'var', 'tmp', 'temp', 'opt', 'etc',
  'windows', 'system32', 'program files', 'program files (x86)',
  'appdata', 'local', 'roaming', 'library', 'application support',
  'node_modules', '.git', '.gradle', 'build', 'dist', 'out', 'target',
  'bin', 'obj', 'packages', '.pub-cache', '.m2', '.npm',
  'src', 'main', 'java', 'kotlin', 'res', 'app',  // Android/JVM inner dirs
  'c', 'd', 'e',  // drive letters
  'documents', 'desktop', 'downloads',
  'cloudStorage', 'googledrive', 'google drive',
]);

// 도구명 → 행동 동사
const _ACTION_VERB = {
  Write: '작성', Edit: '수정', Read: '분석', Grep: '검색', Glob: '탐색',
  Bash: '실행', WebSearch: '웹조사', WebFetch: '참고', Task: '하위작업',
};

// 무시할 짧은/일반적 assistant 응답
const _GENERIC_RESPONSES = /^(네|알겠습니다|확인했습니다|완료|understood|ok|sure|done|yes|알겠어요|넵|감사합니다|좋습니다|이해했습니다|물론입니다|그렇게 하겠습니다|알려드리겠습니다)[\.\!\s]*$/i;

// AI 도구 사이트 감지 패턴
const _AI_TOOL_PATTERNS = [
  [/claude\.ai|anthropic/i, 'Claude'],
  [/chatgpt|openai/i, 'ChatGPT'],
  [/gemini|bard|google.*ai/i, 'Gemini'],
  [/copilot|github.*copilot/i, 'Copilot'],
  [/perplexity/i, 'Perplexity'],
  [/cursor/i, 'Cursor'],
  [/v0\.dev|vercel.*v0/i, 'v0'],
  [/midjourney/i, 'Midjourney'],
  [/notion.*ai/i, 'Notion AI'],
];

// ─── 파일 역할 추론 함수 ─────────────────────────────────
function _inferFileRole(filePath) {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, '/');
  for (const [pattern, role] of FILE_ROLE_MAP) {
    if (pattern.test(norm)) return role;
  }
  return null;
}

// ─── 파일 확장자에서 기술 스택 추론 ─────────────────────────
function _inferTech(filePath) {
  if (!filePath) return null;
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  for (const [ext, tech] of Object.entries(EXT_TO_TECH)) {
    if (norm.endsWith(ext)) return tech;
  }
  return null;
}

// ─── 파일 경로에서 프로젝트명 추출 ─────────────────────────
function _extractProjectName(filePath) {
  if (!filePath) return null;
  const segments = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  // 뒤에서부터 탐색, 의미 있는 가장 깊은 디렉토리 찾기
  // 마지막 세그먼트 = 파일명이므로 제외, 뒤에서 두 번째부터
  let bestCandidate = null;
  let bestDepth = -1;
  for (let i = segments.length - 2; i >= 0; i--) {
    const seg = segments[i];
    const segLower = seg.toLowerCase();
    if (SYSTEM_PATH_SEGMENTS.has(segLower)) continue;
    if (segLower.startsWith('.')) continue; // hidden dirs
    if (/^\d+$/.test(seg)) continue;       // pure numbers
    // 첫 번째 non-system 디렉토리 (가장 깊은) = 프로젝트명
    if (bestDepth === -1) {
      bestCandidate = seg;
      bestDepth = i;
    }
    // 더 깊은 것이 있으면 그게 프로젝트명 가능성 높음
    // 그러나 너무 깊은 내부 폴더는 프로젝트명이 아님
    // 적절한 후보: 깊이 2~5 사이
    break;
  }
  return bestCandidate;
}

// ─── 시간 포맷 (duration) ─────────────────────────────────
function _formatDuration(ms) {
  if (!ms || ms <= 0) return '';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '1분 미만';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// ─── 세션별 심층 분석 요약 ──────────────────────────────────
// WHY(purpose) + WHAT(module-level) + RESULT + context
function computeSessionSummaries(events) {
  const sessionMap = {};

  for (const event of events) {
    const sid = event.sessionId;
    if (!sid) continue;
    if (!sessionMap[sid]) sessionMap[sid] = {
      // user.message tracking
      userMessages: [],
      // assistant.message tracking
      assistantMessages: [],
      // tool.end file tracking (full paths for deep analysis)
      toolFiles: {},        // fullPath → { role, action, count, tech }
      commits: [],          // git commit messages
      bashCmds: [],         // non-git bash commands
      webSearches: 0,
      // keyboard.chunk tracking
      activities: [],       // { activity, app, window, keywords }
      // browser/extension tracking
      browseSites: [],      // { site, title }
      // git.commit events
      gitCommits: [],       // commit messages from git.commit event type
      // AI source tracking (from event.aiSource field)
      aiSources: new Set(),
      // timestamps for duration
      firstTs: null,
      lastTs: null,
    };
    const s = sessionMap[sid];

    // ── 타임스탬프 추적 ──
    const ts = event.timestamp ? new Date(event.timestamp).getTime() : 0;
    if (ts > 0) {
      if (!s.firstTs || ts < s.firstTs) s.firstTs = ts;
      if (!s.lastTs || ts > s.lastTs) s.lastTs = ts;
    }

    // ── AI 소스 수집 ──
    if (event.aiSource) s.aiSources.add(event.aiSource);

    // ── user.message → 의도(WHY) 추출 ──
    if (event.type === 'user.message') {
      const content = (event.data?.contentPreview || event.data?.content || '').replace(/[\n\r]+/g, ' ').trim();
      if (content.length > 2) {
        s.userMessages.push(content);
      }
    }

    // ── assistant.message → 결과 요약 후보 ──
    if (event.type === 'assistant.message') {
      const content = (event.data?.contentPreview || event.data?.content || '').replace(/[\n\r]+/g, ' ').trim();
      if (content.length > 5 && !_GENERIC_RESPONSES.test(content)) {
        s.assistantMessages.push(content);
      }
    }

    // ── tool.end → 파일/모듈 분석 ──
    if (event.type === 'tool.end') {
      const toolName = event.data?.toolName || '';
      const filePath = event.data?.filePath || event.data?.input?.file_path || event.data?.files?.[0] || '';

      if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && filePath) {
        const norm = filePath.replace(/\\/g, '/');
        if (!s.toolFiles[norm]) {
          s.toolFiles[norm] = {
            role: _inferFileRole(norm),
            tech: _inferTech(norm),
            project: _extractProjectName(norm),
            actions: {},
          };
        }
        const action = _ACTION_VERB[toolName] || toolName;
        s.toolFiles[norm].actions[action] = (s.toolFiles[norm].actions[action] || 0) + 1;
      } else if (toolName === 'WebSearch' || toolName === 'WebFetch') {
        s.webSearches++;
      } else if (toolName === 'Bash') {
        const cmd = String(event.data?.inputPreview || event.data?.input?.command || '');
        const commitMatch = cmd.match(/git commit.*-m\s+["'](.+?)["']/i);
        if (commitMatch) {
          s.commits.push(commitMatch[1].slice(0, 80));
        } else if (cmd.length > 3) {
          s.bashCmds.push(cmd.slice(0, 40));
        }
      } else if (toolName === 'Grep' || toolName === 'Glob') {
        // search commands: just count
        if (filePath) {
          const norm = filePath.replace(/\\/g, '/');
          if (!s.toolFiles[norm]) {
            s.toolFiles[norm] = {
              role: _inferFileRole(norm),
              tech: _inferTech(norm),
              project: _extractProjectName(norm),
              actions: {},
            };
          }
          const action = _ACTION_VERB[toolName] || toolName;
          s.toolFiles[norm].actions[action] = (s.toolFiles[norm].actions[action] || 0) + 1;
        }
      }
    }

    // ── keyboard.chunk → 활동 분석 ──
    if (event.type === 'keyboard.chunk') {
      const d = event.data || {};
      s.activities.push({
        activity: d.activity || d.category || '',
        app: d.app || '',
        window: d.window || d.title || '',
        keywords: d.keywords || d.text || '',
      });
    }

    // ── browse/app_switch → 브라우저/AI 도구 감지 ──
    if (event.type === 'browse' || event.type === 'app.activity' || event.type === 'app_switch') {
      const d = event.data || {};
      const site = d.site || d.url || d.app || '';
      const title = d.title || d.window || '';
      if (site || title) {
        s.browseSites.push({ site, title });
      }
    }

    // ── git.commit 이벤트 ──
    if (event.type === 'git.commit') {
      const msg = event.data?.message || event.data?.summary || event.data?.commitMessage || '';
      if (msg) s.gitCommits.push(msg.slice(0, 80));
    }
  }

  // ── 세션별 심층 요약 생성 ──────────────────────────────────
  const result = {};
  for (const [sid, s] of Object.entries(sessionMap)) {

    // ── PURPOSE (WHY): 첫 user.message = 세션 목적 ──
    // Skip CLI commands that aren't real user intent
    const CLI_NOISE = /^(dangerously[-\s]?skip[-\s]?permission|--?[\w-]+|y|n|yes|no|exit|quit|\/\w+|npm |git |cd |ls |cat )$/i;
    let purpose = '';
    if (s.userMessages.length > 0) {
      // 노이즈가 아닌 첫 번째 메시지 찾기
      const firstMsg = s.userMessages.find(m => !CLI_NOISE.test(m.trim()));
      if (firstMsg) {
        const sentenceMatch = firstMsg.match(/^(.+?[.!?。！？])\s/);
        purpose = sentenceMatch ? sentenceMatch[1] : firstMsg;
        if (purpose.length > 60) purpose = purpose.slice(0, 57) + '...';
      }
    }

    // ── WHAT: 모듈 단위 행동 요약 ──
    // 파일들을 역할(모듈)별로 그룹화
    const moduleGroups = {}; // role → { actions: {action: count}, count }
    const allTechs = new Set();
    const allProjects = {};  // projectName → count

    for (const [fp, info] of Object.entries(s.toolFiles)) {
      const role = info.role || '기타';
      if (!moduleGroups[role]) moduleGroups[role] = { actions: {}, fileCount: 0 };
      moduleGroups[role].fileCount++;
      for (const [action, cnt] of Object.entries(info.actions)) {
        moduleGroups[role].actions[action] = (moduleGroups[role].actions[action] || 0) + cnt;
      }
      if (info.tech) allTechs.add(info.tech);
      if (info.project) allProjects[info.project] = (allProjects[info.project] || 0) + 1;
    }

    // 모듈별 요약 (파일 수와 주된 행동)
    const whatParts = [];
    const sortedModules = Object.entries(moduleGroups)
      .sort((a, b) => b[1].fileCount - a[1].fileCount);

    for (const [role, group] of sortedModules) {
      // 주된 행동 (가장 많은 액션)
      const topAction = Object.entries(group.actions)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      if (group.fileCount === 1) {
        whatParts.push(`${role} ${topAction}`);
      } else {
        whatParts.push(`${role} ${group.fileCount}파일 ${topAction}`);
      }
    }
    if (s.webSearches > 0) whatParts.push(`웹 조사 ${s.webSearches}건`);
    if (whatParts.length === 0 && s.bashCmds.length > 0) {
      whatParts.push(`명령어 ${s.bashCmds.length}건 실행`);
    }
    const whatSummary = whatParts.slice(0, 3).join(', ');

    // ── RESULT: 결과 요약 ──
    // 우선순위: git.commit 이벤트 > bash git commit > 마지막 assistant 요약
    let resultSummary = '';
    if (s.gitCommits.length > 0) {
      resultSummary = s.gitCommits[s.gitCommits.length - 1];
    } else if (s.commits.length > 0) {
      resultSummary = s.commits[s.commits.length - 1];
    } else if (s.assistantMessages.length > 0) {
      // 마지막 assistant 메시지의 첫 문장
      const lastAssistant = s.assistantMessages[s.assistantMessages.length - 1];
      const sentenceMatch = lastAssistant.match(/^(.+?[.!?。！？])/);
      resultSummary = sentenceMatch ? sentenceMatch[1] : lastAssistant;
      if (resultSummary.length > 60) resultSummary = resultSummary.slice(0, 57) + '...';
    } else {
      // 변경 통계 fallback
      const totalFiles = Object.keys(s.toolFiles).length;
      if (totalFiles > 0) {
        const writeCount = Object.values(s.toolFiles).filter(f =>
          f.actions['작성'] || f.actions['Write']
        ).length;
        const editCount = Object.values(s.toolFiles).filter(f =>
          f.actions['수정'] || f.actions['Edit']
        ).length;
        const rp = [];
        if (editCount > 0) rp.push(`${editCount}개 파일 수정`);
        if (writeCount > 0) rp.push(`${writeCount}개 파일 생성`);
        resultSummary = rp.join(', ');
      }
    }

    // ── 프로젝트명: 가장 많이 등장한 프로젝트 경로 ──
    const projectName = Object.entries(allProjects)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || '';

    // ── 기술 스택: 확장자에서 추론된 고유 기술들 ──
    const techStack = [...allTechs].slice(0, 4).join(', ');

    // ── 사용 앱: keyboard.chunk에서 ──
    const appSet = new Set();
    for (const act of s.activities) {
      if (act.app) {
        const appName = act.app.replace(/\.exe$/i, '').replace(/^com\.\w+\./i, '');
        if (appName.length > 1 && appName.length < 30) appSet.add(appName);
      }
    }
    const appsUsed = [...appSet].slice(0, 4).join(', ');

    // ── AI 도구 감지: 브라우저/앱 + event.aiSource ──
    const aiToolSet = new Set();
    for (const browse of s.browseSites) {
      const combined = `${browse.site} ${browse.title}`;
      for (const [pattern, name] of _AI_TOOL_PATTERNS) {
        if (pattern.test(combined)) { aiToolSet.add(name); break; }
      }
    }
    // AI source (수집 단계에서 이미 set에 모음)
    const _AI_SRC_LABEL = { claude: 'Claude', gemini: 'Gemini', openai: 'ChatGPT', perplexity: 'Perplexity', vscode: 'VS Code' };
    for (const src of s.aiSources) {
      if (_AI_SRC_LABEL[src]) aiToolSet.add(_AI_SRC_LABEL[src]);
    }
    const aiTools = [...aiToolSet].slice(0, 3).join(', ');

    // ── 세션 지속 시간 ──
    const duration = (s.firstTs && s.lastTs) ? _formatDuration(s.lastTs - s.firstTs) : '';

    result[sid] = {
      purpose,
      whatSummary,
      resultSummary,
      projectName,
      techStack,
      appsUsed,
      aiTools,
      duration,
    };
  }
  return result;
}

// ─── 이벤트 → 그래프 빌드 ──────────────────────────
function buildGraph(events) {
  const nodes = [];
  const edges = [];
  const fileNodes = new Map(); // path → nodeId (파일 중복 제거)
  const nodeSet = new Set();

  // 세션별 WHAT/RESULT 사전 계산
  const sessionSummaries = computeSessionSummaries(events);

  // 시스템/노이즈 이벤트 제외 (사용자 활동 이벤트는 모두 표시)
  const NOISE_TYPES = new Set([
    'install.progress', 'install.diag', 'daemon.update', 'daemon.error',
  ]);

  for (const event of events) {
    if (NOISE_TYPES.has(event.type)) continue;

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
      // 멀티 AI 메타 (showDetail 에서 n.tokenCount, n.model 로 직접 접근)
      aiSource:     aiSrc || null,
      aiIcon:       (aiSrc && AI_SOURCE_STYLES[aiSrc]?.icon) || event.data?.aiIcon || null,
      aiLabel:      event.data?.aiLabel || null,
      citations:    event.data?.citations || null,
      tokenCount:   event.data?.tokenCount  ?? null,
      model:        event.data?.model       || null,
      // 목적 분류 (purpose-classifier.js 가 주입)
      purposeId:    event.purposeId    || null,
      purposeLabel: event.purposeLabel || null,
      purposeColor: event.purposeColor || null,
      purposeIcon:  event.purposeIcon  || null,
      // 프로젝트 메타 (mywork-renderer에서 "프로젝트명 — 목적" 라벨용)
      projectName:  event.data?.projectName || event.data?.project || event.data?.repo || null,
      firstMsg:     event.data?.firstMsg    || null,
      msgPreview:   event.data?.inputPreview || event.data?.content?.slice?.(0, 50) || null,
      autoTitle:    event.autoTitle || null,
      domain:       event.domain   || null,
      // 세션 요약 (WHY+WHAT+RESULT + 추가 컨텍스트)
      purpose:        sessionSummaries[event.sessionId]?.purpose || null,
      whatSummary:    sessionSummaries[event.sessionId]?.whatSummary || null,
      resultSummary:  sessionSummaries[event.sessionId]?.resultSummary || null,
      sessionProjectName: sessionSummaries[event.sessionId]?.projectName || null,
      techStack:      sessionSummaries[event.sessionId]?.techStack || null,
      appsUsed:       sessionSummaries[event.sessionId]?.appsUsed || null,
      aiToolsUsed:    sessionSummaries[event.sessionId]?.aiTools || null,
      sessionDuration: sessionSummaries[event.sessionId]?.duration || null,
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
            filePath,          // 파일 경로 — 코드 분석 자동 실행용
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
  'Bash': '명령 실행', 'Glob': '파일 탐색', 'Grep': '코드 검색',
  'WebSearch': '웹 검색', 'WebFetch': '페이지 분석',
  'Task': '하위 에이전트', 'TodoWrite': '할일 업데이트',
  'AskUserQuestion': '사용자 질문', 'EnterPlanMode': '계획 수립 중',
  'ExitPlanMode': '계획 확정', 'NotebookEdit': '노트북 수정',
  // n8n
  'HTTP Request': 'HTTP 요청', 'Slack Message': 'Slack 전송',
  'Railway Deploy': 'Railway 배포', 'GitHub Webhook': 'GitHub 알림',
  'Database': 'DB 쿼리', 'Schedule': '스케줄 실행', 'Code': '코드 실행',
  'Send Email': '이메일 전송', 'Google Sheets': '시트 업데이트',
  // VS Code
  'FileSave': '파일 저장', 'FileCreate': '파일 생성', 'FileOpen': '파일 열기',
  'FileDelete': '파일 삭제', 'Terminal': '터미널', 'Git': 'Git 작업',
  'Debug': '디버그', 'Extension': 'Extension',
};

// ─── 노드 라벨 생성 ────────────────────────────────
function buildLabel(event) {
  const d = event.data || {};
  const who = d.aiLabel || event.aiSource || null;
  const whoPrefix = who ? `[${who}] ` : '';

  switch (event.type) {
    case 'session.start': {
      // "dlaww 작업 시작" 또는 "n8n 자동화 시작"
      const name = d.memberName || event.userId || who || '세션';
      const src  = d.source ? ` (${d.source})` : '';
      return `${name} 시작${src}`;
    }
    case 'session.end': {
      const name = event.userId || who || '세션';
      return `${name} 종료`;
    }
    case 'user.message': {
      // 메시지 앞부분이 가장 직관적
      const preview = d.contentPreview || d.content || '';
      return whoPrefix + truncate(preview || '질문', 30);
    }
    case 'assistant.message': {
      const preview = d.contentPreview || d.content || '';
      return whoPrefix + truncate(preview || '답변', 30);
    }
    case 'tool.start': {
      const toolLabel = TOOL_LABELS[d.toolName] || d.toolName || '작업';
      // 파일명이 있으면 포함
      const fileName = _getFileName(d.inputPreview || d.filePath || '');
      return `⚡ ${toolLabel}${fileName ? `: ${fileName}` : ''}`;
    }
    case 'tool.end': {
      const toolLabel = TOOL_LABELS[d.toolName] || d.toolName || '작업';
      const success   = d.success === false ? ' ✗' : '';
      // Bash: 실제 명령어 앞부분 표시
      if (d.toolName === 'Bash') {
        const cmd = (d.input?.command || d.inputPreview || '').trim();
        if (cmd) return `${toolLabel}: ${truncate(cmd, 35)}${success}`;
      }
      // 파일 경로 다양한 필드에서 시도
      const rawPath = d.filePath || d.input?.file_path || d.inputPreview || '';
      const fileName = _getFileName(rawPath);
      return `${toolLabel}${fileName ? `: ${fileName}` : ''}${success}`;
    }
    case 'tool.error': {
      const toolLabel = TOOL_LABELS[d.toolName] || d.toolName || '작업';
      return `❌ ${toolLabel} 실패`;
    }
    case 'file.read':
    case 'file.write':
    case 'file.create': {
      const icon = event.type === 'file.read' ? '📄' : '✏️';
      return `${icon} ${truncate(d.fileName || _getFileName(d.filePath || '') || '파일', 22)}`;
    }
    case 'subagent.start':
      return `🤖 하위 에이전트${d.agentType ? `: ${d.agentType}` : ''}`;
    case 'subagent.stop':
      return '🤖 에이전트 완료';
    case 'notification':
      return `🔔 ${truncate(d.message || '알림', 22)}`;
    case 'task.complete':
      return `✅ ${truncate(d.taskName || '작업 완료', 22)}`;
    case 'annotation.add':
      return `📌 ${truncate(d.label || '메모', 22)}`;
    case 'keyboard.chunk': {
      const app = d.app || d.activeApp || '';
      const title = d.windowTitle || '';
      return `⌨️ ${truncate(app ? `${app}: ${title}` : title || '입력', 30)}`;
    }
    case 'screen.capture': {
      const app = d.app || '';
      const title = d.windowTitle || '';
      const trigger = d.trigger || '';
      return `📸 ${truncate(app ? `${app}: ${title}` : trigger || '캡처', 30)}`;
    }
    case 'screen.analyzed': {
      const app = d.app || '';
      const activity = d.activity || '';
      return `🔍 ${truncate(app ? `${app}: ${activity}` : '분석', 30)}`;
    }
    case 'idle':
      return '💤 대기';
    case 'file.change':
      return `📁 ${truncate(d.fileName || d.filePath || '파일 변경', 22)}`;
    case 'clipboard.change':
      return `📋 클립보드`;
    case 'bank.security.active':
      return '🏦 은행 보안 활성';
    default:
      // 알 수 없는 타입도 의미 있게
      return whoPrefix + (d.toolName || d.contentPreview || event.type).slice(0, 28);
  }
}

// 경로에서 파일명만 추출
function _getFileName(pathOrPreview) {
  if (!pathOrPreview) return '';
  // 경로처럼 생긴 경우만
  if (pathOrPreview.includes('/') || pathOrPreview.includes('\\')) {
    return pathOrPreview.replace(/\\/g, '/').split('/').pop();
  }
  return '';
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
    case 'tool.start': return 18;  // 진행 중: 약간 크게
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
