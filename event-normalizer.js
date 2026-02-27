/**
 * event-normalizer.js
 * 훅 데이터 → 표준 MindmapEvent 변환
 */
const { ulid } = require('ulid');

// ─── 이벤트 타입 상수 ──────────────────────────────
const EventType = {
  SESSION_START: 'session.start',
  SESSION_END: 'session.end',
  USER_MESSAGE: 'user.message',
  ASSISTANT_MESSAGE: 'assistant.message',
  TOOL_START: 'tool.start',
  TOOL_END: 'tool.end',
  TOOL_ERROR: 'tool.error',
  FILE_READ: 'file.read',
  FILE_WRITE: 'file.write',
  FILE_CREATE: 'file.create',
  SUBAGENT_START: 'subagent.start',
  SUBAGENT_STOP: 'subagent.stop',
  NOTIFICATION: 'notification',
  TASK_COMPLETE: 'task.complete',
  ANNOTATION_ADD: 'annotation.add',
  ANNOTATION_LINK: 'annotation.link',
  BOOKMARK: 'bookmark',
};

// ─── 파일 경로 추출 ─────────────────────────────────
function extractFiles(toolName, toolInput) {
  const files = [];
  if (!toolInput) return files;

  if (toolInput.file_path) files.push(toolInput.file_path);
  if (toolInput.path) files.push(toolInput.path);
  if (toolInput.notebook_path) files.push(toolInput.notebook_path);

  if (toolInput.pattern) {
    files.push(`[glob:${toolInput.pattern}]`);
  }
  if (toolInput.command) {
    const cmd = String(toolInput.command).substring(0, 80);
    files.push(`[cmd:${cmd}]`);
  }

  return files;
}

// ─── 도구 입력 요약 ─────────────────────────────────
function summarizeToolInput(toolName, toolInput) {
  if (!toolInput) return toolName;

  switch (toolName) {
    case 'Read':
      return `Read: ${shortPath(toolInput.file_path)}`;
    case 'Write':
      return `Write: ${shortPath(toolInput.file_path)}`;
    case 'Edit':
      return `Edit: ${shortPath(toolInput.file_path)}`;
    case 'Bash':
      return `Bash: ${String(toolInput.command || '').substring(0, 60)}`;
    case 'Glob':
      return `Glob: ${toolInput.pattern || ''}`;
    case 'Grep':
      return `Grep: ${toolInput.pattern || ''}`;
    case 'Task':
      return `Task: ${toolInput.description || toolInput.subagent_type || ''}`;
    case 'WebSearch':
      return `Search: ${toolInput.query || ''}`;
    case 'WebFetch':
      return `Fetch: ${toolInput.url || ''}`;
    case 'TodoWrite':
      return 'TodoWrite';
    default:
      return toolName;
  }
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).replace(/\\/g, '/').split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : p;
}

// ─── 파일 조작 타입 판별 ────────────────────────────
function getFileOperation(toolName) {
  switch (toolName) {
    case 'Read': return 'read';
    case 'Write': return 'create';
    case 'Edit': return 'write';
    case 'NotebookEdit': return 'write';
    default: return null;
  }
}

// ─── 언어 감지 ──────────────────────────────────────
function detectLanguage(filePath) {
  if (!filePath) return null;
  const ext = String(filePath).split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    html: 'html', css: 'css', json: 'json', md: 'markdown',
    sql: 'sql', sh: 'shell', yml: 'yaml', yaml: 'yaml',
    xml: 'xml', txt: 'text', csv: 'csv',
  };
  return map[ext] || null;
}

// ─── 훅 이벤트 → MindmapEvent 변환 ─────────────────
function normalizeHookEvent(hookData, sessionState) {
  const events = [];
  const sessionId = hookData.session_id || 'unknown';
  const ts = new Date().toISOString();

  switch (hookData.hook_event_name) {
    case 'SessionStart': {
      events.push({
        id: ulid(),
        type: EventType.SESSION_START,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: null,
        timestamp: ts,
        data: {
          source: hookData.source || 'startup',
          modelId: hookData.model || null,
          projectDir: hookData.cwd || null,
        },
        metadata: { hookName: 'SessionStart' },
      });
      break;
    }

    case 'SessionEnd': {
      events.push({
        id: ulid(),
        type: EventType.SESSION_END,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.sessionStartId || null,
        timestamp: ts,
        data: {},
        metadata: { hookName: 'SessionEnd' },
      });
      break;
    }

    case 'UserPromptSubmit': {
      const content = hookData.prompt || '';
      const preview = content.substring(0, 200);
      events.push({
        id: ulid(),
        type: EventType.USER_MESSAGE,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.lastAssistantId || sessionState.sessionStartId || null,
        timestamp: ts,
        data: {
          content: content.substring(0, 8000),
          contentPreview: preview,
          wordCount: content.split(/\s+/).filter(Boolean).length,
        },
        metadata: { hookName: 'UserPromptSubmit' },
      });
      break;
    }

    case 'PostToolUse': {
      const toolName = hookData.tool_name || 'Unknown';
      const toolInput = hookData.tool_input || {};
      const toolResponse = hookData.tool_response;
      const files = extractFiles(toolName, toolInput);
      const ok = toolResponse ? !toolResponse.error : true;

      // 도구 이벤트
      const toolEventId = ulid();
      events.push({
        id: toolEventId,
        type: ok ? EventType.TOOL_END : EventType.TOOL_ERROR,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.lastAssistantId || sessionState.lastUserId || null,
        timestamp: ts,
        data: {
          toolName,
          input: truncateObj(toolInput, 2000),
          inputPreview: summarizeToolInput(toolName, toolInput),
          output: typeof toolResponse === 'string'
            ? toolResponse.substring(0, 1000)
            : JSON.stringify(toolResponse || '').substring(0, 1000),
          success: ok,
          files,
        },
        metadata: {
          hookName: 'PostToolUse',
          toolUseId: hookData.tool_use_id || null,
        },
      });

      // 파일 이벤트 (Read, Write, Edit 등)
      const fileOp = getFileOperation(toolName);
      if (fileOp && toolInput.file_path) {
        events.push({
          id: ulid(),
          type: fileOp === 'read' ? EventType.FILE_READ : EventType.FILE_WRITE,
          source: 'claude-hook',
          sessionId,
          userId: 'local',
          channelId: 'default',
          parentEventId: toolEventId,
          timestamp: ts,
          data: {
            filePath: toolInput.file_path,
            fileName: String(toolInput.file_path).replace(/\\/g, '/').split('/').pop(),
            language: detectLanguage(toolInput.file_path),
            operation: fileOp,
          },
          metadata: { hookName: 'PostToolUse' },
        });
      }
      break;
    }

    case 'Stop': {
      const lastMsg = hookData.last_assistant_message || '';
      const preview = lastMsg.substring(0, 200);
      events.push({
        id: ulid(),
        type: EventType.ASSISTANT_MESSAGE,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.lastUserId || null,
        timestamp: ts,
        data: {
          content: lastMsg.substring(0, 8000),
          contentPreview: preview,
          toolCalls: sessionState.pendingTools || [],
        },
        metadata: { hookName: 'Stop' },
      });
      break;
    }

    case 'SubagentStart': {
      events.push({
        id: ulid(),
        type: EventType.SUBAGENT_START,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.lastAssistantId || null,
        timestamp: ts,
        data: {
          agentId: hookData.agent_id || null,
          agentType: hookData.agent_type || null,
          taskDescription: hookData.task_description || null,
          status: 'started',
        },
        metadata: { hookName: 'SubagentStart' },
      });
      break;
    }

    case 'SubagentStop': {
      events.push({
        id: ulid(),
        type: EventType.SUBAGENT_STOP,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.subagentStartIds?.[hookData.agent_id] || null,
        timestamp: ts,
        data: {
          agentId: hookData.agent_id || null,
          agentType: hookData.agent_type || null,
          lastMessage: (hookData.last_assistant_message || '').substring(0, 2000),
          status: 'stopped',
        },
        metadata: { hookName: 'SubagentStop' },
      });
      break;
    }

    case 'Notification': {
      events.push({
        id: ulid(),
        type: EventType.NOTIFICATION,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: null,
        timestamp: ts,
        data: {
          message: hookData.message || '',
          title: hookData.title || '',
          notificationType: hookData.notification_type || '',
        },
        metadata: { hookName: 'Notification' },
      });
      break;
    }

    case 'TaskCompleted': {
      events.push({
        id: ulid(),
        type: EventType.TASK_COMPLETE,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: sessionState.lastAssistantId || null,
        timestamp: ts,
        data: {},
        metadata: { hookName: 'TaskCompleted' },
      });
      break;
    }

    default:
      // 알 수 없는 훅 → 무시하지 않고 일반 이벤트로 기록
      events.push({
        id: ulid(),
        type: `hook.${hookData.hook_event_name || 'unknown'}`,
        source: 'claude-hook',
        sessionId,
        userId: 'local',
        channelId: 'default',
        parentEventId: null,
        timestamp: ts,
        data: { raw: truncateObj(hookData, 2000) },
        metadata: { hookName: hookData.hook_event_name },
      });
  }

  return events;
}

// ─── 수동 주석 이벤트 생성 ──────────────────────────
function createAnnotationEvent(data, sessionId) {
  return {
    id: ulid(),
    type: EventType.ANNOTATION_ADD,
    source: 'manual',
    sessionId: sessionId || 'manual',
    userId: 'local',
    channelId: 'default',
    parentEventId: data.linkedEventId || null,
    timestamp: new Date().toISOString(),
    data: {
      label: data.label || 'Note',
      description: data.description || '',
      color: data.color || '#f0c674',
      icon: data.icon || null,
      linkedEventIds: data.linkedEventIds || [],
    },
    metadata: {},
  };
}

// ─── 유틸 ───────────────────────────────────────────
function truncateObj(obj, maxLen) {
  if (!obj) return obj;
  const str = JSON.stringify(obj);
  if (str.length <= maxLen) return obj;
  try {
    return JSON.parse(str.substring(0, maxLen) + '..."}}');
  } catch {
    return { _truncated: str.substring(0, maxLen) };
  }
}

module.exports = {
  EventType,
  normalizeHookEvent,
  createAnnotationEvent,
  extractFiles,
  summarizeToolInput,
  detectLanguage,
  shortPath,
};
