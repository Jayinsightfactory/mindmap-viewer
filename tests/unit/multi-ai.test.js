/**
 * multi-ai.test.js
 * TDD: 멀티 AI 어댑터 + AI 소스 분류 테스트
 */

const { normalizeAiEvent, AI_SOURCES, getAiStyle } = require('../../adapters/ai-adapter-base.js');
const gemini    = require('../../adapters/adapter-gemini.js');
const perplexity = require('../../adapters/adapter-perplexity.js');
const openai    = require('../../adapters/adapter-openai.js');
const vscode    = require('../../adapters/adapter-vscode.js');

// ── AI_SOURCES 상수 ──────────────────────────────────────
describe('AI_SOURCES', () => {
  test('claude, gemini, perplexity, openai, vscode 포함', () => {
    expect(AI_SOURCES.CLAUDE).toBe('claude');
    expect(AI_SOURCES.GEMINI).toBe('gemini');
    expect(AI_SOURCES.PERPLEXITY).toBe('perplexity');
    expect(AI_SOURCES.OPENAI).toBe('openai');
    expect(AI_SOURCES.VSCODE).toBe('vscode');
  });
});

// ── getAiStyle ────────────────────────────────────────────
describe('getAiStyle', () => {
  test('각 AI 소스마다 color, shape, icon 존재', () => {
    Object.values(AI_SOURCES).forEach(src => {
      const style = getAiStyle(src);
      expect(style.color).toMatch(/^#[0-9a-fA-F]{6}/);
      expect(style.shape).toBeDefined();
      expect(style.icon).toBeDefined();
    });
  });

  test('claude → 초록 계열 (#3fb950)', () => {
    expect(getAiStyle('claude').color).toBe('#3fb950');
  });

  test('gemini → 파랑 계열', () => {
    const color = getAiStyle('gemini').color;
    // 파란 계열 hex
    const r = parseInt(color.slice(1,3),16);
    const b = parseInt(color.slice(5,7),16);
    expect(b).toBeGreaterThan(r);
  });

  test('알 수 없는 소스 → 기본 스타일 반환', () => {
    const style = getAiStyle('unknown_ai');
    expect(style).toBeDefined();
    expect(style.color).toBeDefined();
  });
});

// ── normalizeAiEvent ──────────────────────────────────────
describe('normalizeAiEvent', () => {
  const base = {
    aiSource: 'gemini',
    sessionId: 'sess_test',
    type: 'assistant.message',
    content: '안녕하세요, 저는 Gemini입니다.',
    timestamp: new Date().toISOString(),
  };

  test('표준 이벤트 필드 모두 포함', () => {
    const evt = normalizeAiEvent(base);
    expect(evt.id).toBeDefined();
    expect(evt.type).toBe('assistant.message');
    expect(evt.aiSource).toBe('gemini');
    expect(evt.sessionId).toBe('sess_test');
    expect(evt.timestamp).toBeDefined();
    expect(evt.data).toBeDefined();
  });

  test('content → data.contentPreview (200자 제한)', () => {
    const long = 'x'.repeat(300);
    const evt = normalizeAiEvent({ ...base, content: long });
    expect(evt.data.contentPreview.length).toBeLessThanOrEqual(200);
  });

  test('aiSource 없으면 에러 throw', () => {
    expect(() => normalizeAiEvent({ ...base, aiSource: undefined })).toThrow();
  });

  test('files 배열 포함 시 data.files 에 저장', () => {
    const evt = normalizeAiEvent({ ...base, files: ['/src/main.js'] });
    expect(evt.data.files).toContain('/src/main.js');
  });
});

// ── Gemini 어댑터 ────────────────────────────────────────
describe('adapter-gemini', () => {
  test('fromApiResponse → 표준 이벤트 변환', () => {
    const resp = {
      candidates: [{ content: { parts: [{ text: 'Gemini 응답입니다.' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    };
    const evt = gemini.fromApiResponse(resp, { sessionId: 'sess_g1' });
    expect(evt.aiSource).toBe('gemini');
    expect(evt.type).toBe('assistant.message');
    expect(evt.data.contentPreview).toContain('Gemini');
    expect(evt.data.tokenCount).toBeDefined();
  });

  test('빈 candidates → null 반환', () => {
    const evt = gemini.fromApiResponse({ candidates: [] }, { sessionId: 'sess_g2' });
    expect(evt).toBeNull();
  });

  test('model 정보 포함', () => {
    const resp = { candidates: [{ content: { parts: [{ text: '답변' }] } }] };
    const evt = gemini.fromApiResponse(resp, { sessionId: 's', model: 'gemini-1.5-pro' });
    expect(evt.data.model).toBe('gemini-1.5-pro');
  });
});

// ── Perplexity 어댑터 ────────────────────────────────────
describe('adapter-perplexity', () => {
  test('fromApiResponse → 표준 이벤트 변환', () => {
    const resp = {
      choices: [{ message: { content: 'Perplexity 검색 결과입니다.' } }],
      citations: ['https://example.com'],
      model: 'llama-3-sonar-large',
    };
    const evt = perplexity.fromApiResponse(resp, { sessionId: 'sess_p1' });
    expect(evt.aiSource).toBe('perplexity');
    expect(evt.type).toBe('assistant.message');
    expect(evt.data.citations).toHaveLength(1);
  });

  test('citations → data.citations 배열', () => {
    const resp = {
      choices: [{ message: { content: '답변' } }],
      citations: ['https://a.com', 'https://b.com'],
    };
    const evt = perplexity.fromApiResponse(resp, { sessionId: 's' });
    expect(evt.data.citations).toHaveLength(2);
  });

  test('빈 choices → null 반환', () => {
    const evt = perplexity.fromApiResponse({ choices: [] }, { sessionId: 's' });
    expect(evt).toBeNull();
  });
});

// ── OpenAI 어댑터 ────────────────────────────────────────
describe('adapter-openai', () => {
  test('fromApiResponse → 표준 이벤트 변환', () => {
    const resp = {
      choices: [{ message: { role: 'assistant', content: 'GPT 응답입니다.' } }],
      model: 'gpt-4o',
      usage: { prompt_tokens: 15, completion_tokens: 30 },
    };
    const evt = openai.fromApiResponse(resp, { sessionId: 'sess_o1' });
    expect(evt.aiSource).toBe('openai');
    expect(evt.type).toBe('assistant.message');
    expect(evt.data.model).toBe('gpt-4o');
    expect(evt.data.tokenCount).toBe(45);
  });

  test('tool_calls 포함 시 type → tool.end', () => {
    const resp = {
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ function: { name: 'search' } }] } }],
      model: 'gpt-4o',
    };
    const evt = openai.fromApiResponse(resp, { sessionId: 's' });
    expect(evt.type).toBe('tool.end');
    expect(evt.data.toolName).toBe('search');
  });

  test('빈 choices → null 반환', () => {
    const evt = openai.fromApiResponse({ choices: [] }, { sessionId: 's' });
    expect(evt).toBeNull();
  });
});

// ── VS Code 어댑터 ───────────────────────────────────────
describe('adapter-vscode', () => {
  test('파일 저장 이벤트 → file.write 타입', () => {
    const raw = { eventType: 'fileSave', filePath: '/src/app.js', sessionId: 'vsc_01' };
    const evt = vscode.fromEvent(raw);
    expect(evt.aiSource).toBe('vscode');
    expect(evt.type).toBe('file.write');
    expect(evt.data.files).toContain('/src/app.js');
  });

  test('파일 열기 이벤트 → file.read 타입', () => {
    const raw = { eventType: 'fileOpen', filePath: '/src/db.js', sessionId: 'vsc_01' };
    const evt = vscode.fromEvent(raw);
    expect(evt.type).toBe('file.read');
  });

  test('터미널 명령 이벤트 → tool.end 타입', () => {
    const raw = { eventType: 'terminal', command: 'npm test', sessionId: 'vsc_01' };
    const evt = vscode.fromEvent(raw);
    expect(evt.type).toBe('tool.end');
    expect(evt.data.toolName).toBe('Terminal');
  });

  test('git commit 이벤트 → tool.end + git 라벨', () => {
    const raw = { eventType: 'gitCommit', message: 'fix: 버그수정', sessionId: 'vsc_01' };
    const evt = vscode.fromEvent(raw);
    expect(evt.type).toBe('tool.end');
    expect(evt.data.toolName).toBe('Git');
  });

  test('알 수 없는 이벤트 → null', () => {
    const raw = { eventType: 'unknown_xyz', sessionId: 'vsc_01' };
    const evt = vscode.fromEvent(raw);
    expect(evt).toBeNull();
  });
});
