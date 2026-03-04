/**
 * event-normalizer.test.js
 * TDD: 훅 데이터 → 표준 이벤트 변환 테스트
 */

const { normalize, STRATEGY_MAP } = require('../../src/event-normalizer.js');

const makeHook = (type, data = {}) => ({
  hook: type,
  session_id: 'sess_test',
  ...data,
});

describe('normalize', () => {
  test('UserPromptSubmit → user.message 이벤트', () => {
    const hook = makeHook('UserPromptSubmit', { prompt: '안녕하세요' });
    const event = normalize(hook);
    expect(event.type).toBe('user.message');
    expect(event.data.contentPreview).toBeDefined();
  });

  test('Stop → assistant.message 이벤트', () => {
    const hook = makeHook('Stop', { last_assistant_message: '완료했습니다.' });
    const event = normalize(hook);
    expect(event.type).toBe('assistant.message');
  });

  test('PostToolUse (Read) → tool.end 이벤트', () => {
    const hook = makeHook('PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/src/server.js' },
      tool_response: 'file content...',
    });
    const event = normalize(hook);
    expect(event.type).toBe('tool.end');
    expect(event.data.toolName).toBe('Read');
  });

  test('PostToolUse (Read) → files 배열에 파일 경로 포함', () => {
    const hook = makeHook('PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/src/db.js' },
      tool_response: '',
    });
    const event = normalize(hook);
    expect(event.data.files).toContain('/src/db.js');
  });

  test('SessionStart → session.start 이벤트', () => {
    const hook = makeHook('SessionStart');
    const event = normalize(hook);
    expect(event.type).toBe('session.start');
  });

  test('SessionEnd → session.end 이벤트', () => {
    const hook = makeHook('SessionEnd');
    const event = normalize(hook);
    expect(event.type).toBe('session.end');
  });

  test('SubagentStart → subagent.start 이벤트', () => {
    const hook = makeHook('SubagentStart', { agent_type: 'Bash' });
    const event = normalize(hook);
    expect(event.type).toBe('subagent.start');
  });

  test('이벤트에 항상 id(ULID), timestamp, sessionId 존재', () => {
    const hook = makeHook('UserPromptSubmit', { prompt: '테스트' });
    const event = normalize(hook);
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
    expect(event.sessionId).toBe('sess_test');
  });

  test('알 수 없는 훅 타입 → null 반환 (무시)', () => {
    const hook = makeHook('UnknownHookType');
    const result = normalize(hook);
    expect(result).toBeNull();
  });

  test('PostToolUse 오류 시 → tool.error 이벤트', () => {
    const hook = makeHook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      tool_response: 'Error: permission denied',
      is_error: true,
    });
    const event = normalize(hook);
    expect(event.type).toBe('tool.error');
  });
});

describe('STRATEGY_MAP', () => {
  test('10개 이상의 훅 타입 전략 존재 (PreToolUse 포함)', () => {
    const keys = Object.keys(STRATEGY_MAP);
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  test('각 전략은 함수', () => {
    Object.values(STRATEGY_MAP).forEach(strategy => {
      expect(typeof strategy).toBe('function');
    });
  });

  test('PreToolUse 전략 존재', () => {
    expect(STRATEGY_MAP['PreToolUse']).toBeDefined();
    expect(typeof STRATEGY_MAP['PreToolUse']).toBe('function');
  });
});

// ─── PreToolUse 훅 ──────────────────────────────────
describe('PreToolUse 훅 (작업 시작 즉시 노드 생성)', () => {
  test('PreToolUse → tool.start 이벤트 반환', () => {
    const hook = makeHook('PreToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/src/db.js' },
    });
    const event = normalize(hook);
    expect(event).not.toBeNull();
    expect(event.type).toBe('tool.start');
  });

  test('tool.start 이벤트에 toolName 포함', () => {
    const hook = makeHook('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
    const event = normalize(hook);
    expect(event.data.toolName).toBe('Bash');
  });

  test('tool.start 이벤트에 inputPreview 포함', () => {
    const hook = makeHook('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: '/src/server.js', old_string: 'a', new_string: 'b' },
    });
    const event = normalize(hook);
    expect(event.data.inputPreview).toBeTruthy();
    expect(event.data.inputPreview).toContain('Edit');
  });

  test('tool.start 이벤트에 status: pending 포함', () => {
    const hook = makeHook('PreToolUse', {
      tool_name: 'Write',
      tool_input: { file_path: '/src/new.js' },
    });
    const event = normalize(hook);
    expect(event.data.status).toBe('pending');
  });

  test('파일 경로가 있으면 files 배열 포함', () => {
    const hook = makeHook('PreToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/src/index.js' },
    });
    const event = normalize(hook);
    expect(event.data.files).toContain('/src/index.js');
  });

  test('tool_use_id 가 있으면 metadata에 포함', () => {
    const hook = makeHook('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 'tu_abc123',
    });
    const event = normalize(hook);
    expect(event.metadata?.toolUseId).toBe('tu_abc123');
  });
});

// ─── PostAssistantTurn 훅 ────────────────────────────
describe('PostAssistantTurn 훅 (Claude 응답 완료 즉시)', () => {
  test('PostAssistantTurn → assistant.message 이벤트 반환', () => {
    const hook = makeHook('PostAssistantTurn', {
      assistant_message: '작업을 완료했습니다.',
    });
    const event = normalize(hook);
    expect(event).not.toBeNull();
    expect(event.type).toBe('assistant.message');
  });

  test('assistant.message에 contentPreview 포함', () => {
    const hook = makeHook('PostAssistantTurn', {
      assistant_message: '안녕하세요, 저는 Claude입니다. 무엇을 도와드릴까요?',
    });
    const event = normalize(hook);
    expect(event.data.contentPreview).toBeDefined();
    expect(event.data.contentPreview.length).toBeLessThanOrEqual(200);
  });

  test('assistant_message 가 없으면 빈 문자열로 처리', () => {
    const hook = makeHook('PostAssistantTurn', {});
    const event = normalize(hook);
    expect(event).not.toBeNull();
    expect(event.type).toBe('assistant.message');
    expect(event.data.contentPreview).toBe('');
  });

  test('metadata에 hookName: PostAssistantTurn 포함', () => {
    const hook = makeHook('PostAssistantTurn', {
      assistant_message: '완료',
    });
    const event = normalize(hook);
    expect(event.metadata.hookName).toBe('PostAssistantTurn');
  });

  test('STRATEGY_MAP에 PostAssistantTurn 전략 존재', () => {
    expect(STRATEGY_MAP['PostAssistantTurn']).toBeDefined();
    expect(typeof STRATEGY_MAP['PostAssistantTurn']).toBe('function');
  });

  test('200자 초과 메시지는 contentPreview가 200자로 잘림', () => {
    const longMsg = 'A'.repeat(500);
    const hook = makeHook('PostAssistantTurn', { assistant_message: longMsg });
    const event = normalize(hook);
    expect(event.data.contentPreview.length).toBeLessThanOrEqual(200);
  });
});
