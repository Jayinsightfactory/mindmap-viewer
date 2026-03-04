/**
 * adapter-vscode.js
 * VS Code 활동 이벤트 → 표준 MindmapEvent 변환
 *
 * VS Code Extension에서 아래 이벤트를 POST로 전송:
 *   { eventType, filePath?, command?, message?, sessionId }
 *
 * 지원 이벤트:
 *   fileOpen   → file.read
 *   fileSave   → file.write
 *   fileCreate → file.write
 *   terminal   → tool.end (Terminal)
 *   gitCommit  → tool.end (Git)
 *   gitPush    → tool.end (Git)
 *   debug      → tool.end (Debug)
 *   extension  → tool.end (Extension)
 *
 * VS Code Extension 측 연동 코드 예:
 *   // extension.ts
 *   vscode.workspace.onDidSaveTextDocument(doc => {
 *     fetch('http://localhost:4747/api/ai-event', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({
 *         eventType: 'fileSave',
 *         filePath: doc.uri.fsPath,
 *         sessionId: getSessionId(),
 *       }),
 *     });
 *   });
 */

const { normalizeAiEvent, AI_SOURCES } = require('./ai-adapter-base');

// ─── 이벤트 타입 → MindmapEvent 타입 전략 맵 ───────────
const EVENT_STRATEGY = {
  fileOpen:   (raw) => ({
    type:    'file.read',
    content: `파일 열기: ${_fileName(raw.filePath)}`,
    files:   [raw.filePath].filter(Boolean),
    extra:   { toolName: 'FileOpen', filePath: raw.filePath, language: _lang(raw.filePath) },
  }),
  fileSave:   (raw) => ({
    type:    'file.write',
    content: `파일 저장: ${_fileName(raw.filePath)}`,
    files:   [raw.filePath].filter(Boolean),
    extra:   { toolName: 'FileSave', filePath: raw.filePath, language: _lang(raw.filePath) },
  }),
  fileCreate: (raw) => ({
    type:    'file.write',
    content: `파일 생성: ${_fileName(raw.filePath)}`,
    files:   [raw.filePath].filter(Boolean),
    extra:   { toolName: 'FileCreate', filePath: raw.filePath, language: _lang(raw.filePath) },
  }),
  fileDelete: (raw) => ({
    type:    'tool.end',
    content: `파일 삭제: ${_fileName(raw.filePath)}`,
    files:   [raw.filePath].filter(Boolean),
    extra:   { toolName: 'FileDelete', filePath: raw.filePath },
  }),
  terminal:   (raw) => ({
    type:    'tool.end',
    content: `터미널: ${(raw.command || '').substring(0, 80)}`,
    extra:   { toolName: 'Terminal', command: raw.command || '', exitCode: raw.exitCode ?? null },
  }),
  gitCommit:  (raw) => ({
    type:    'tool.end',
    content: `Git commit: ${(raw.message || '').substring(0, 80)}`,
    extra:   { toolName: 'Git', gitOp: 'commit', message: raw.message || '', branch: raw.branch || null },
  }),
  gitPush:    (raw) => ({
    type:    'tool.end',
    content: `Git push → ${raw.remote || 'origin'}`,
    extra:   { toolName: 'Git', gitOp: 'push', remote: raw.remote || 'origin', branch: raw.branch || null },
  }),
  gitPull:    (raw) => ({
    type:    'tool.end',
    content: `Git pull ← ${raw.remote || 'origin'}`,
    extra:   { toolName: 'Git', gitOp: 'pull', remote: raw.remote || 'origin', branch: raw.branch || null },
  }),
  debug:      (raw) => ({
    type:    'tool.end',
    content: `디버그 세션: ${raw.program || ''}`,
    extra:   { toolName: 'Debug', program: raw.program || '', stopped: raw.stopped || false },
  }),
  extension:  (raw) => ({
    type:    'tool.end',
    content: `Extension: ${raw.extensionId || ''}`,
    extra:   { toolName: 'Extension', extensionId: raw.extensionId || '' },
  }),
};

/**
 * VS Code 이벤트 → MindmapEvent
 * @param {object} raw - { eventType, sessionId, filePath?, command?, message?, ... }
 * @returns {object|null}
 */
function fromEvent(raw) {
  const strategy = EVENT_STRATEGY[raw.eventType];
  if (!strategy) return null;

  const mapped = strategy(raw);
  return normalizeAiEvent({
    aiSource:      AI_SOURCES.VSCODE,
    sessionId:     raw.sessionId || 'vscode-default',
    type:          mapped.type,
    content:       mapped.content || '',
    files:         mapped.files || [],
    parentEventId: raw.parentEventId || null,
    timestamp:     raw.timestamp || new Date().toISOString(),
    extra: {
      vscodeWorkspace: raw.workspace || null,
      ...mapped.extra,
    },
  });
}

// ─── 유틸 ──────────────────────────────────────────────
function _fileName(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/\\/g, '/').split('/').pop();
}

const LANG_MAP = {
  js: 'JavaScript', ts: 'TypeScript', jsx: 'React JSX', tsx: 'React TSX',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', cs: 'C#',
  html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON',
  md: 'Markdown', sh: 'Shell', yml: 'YAML', yaml: 'YAML',
};

function _lang(filePath) {
  if (!filePath) return null;
  const ext = String(filePath).split('.').pop().toLowerCase();
  return LANG_MAP[ext] || null;
}

module.exports = { fromEvent, EVENT_STRATEGY };
