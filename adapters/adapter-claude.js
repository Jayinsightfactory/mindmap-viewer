/**
 * adapter-claude.js
 * Anthropic Claude API 응답 → 표준 MindmapEvent 변환
 *
 * 지원:
 *   - messages API (Claude 3.5 Sonnet, Opus 등)
 *   - tool_use → tool.end 이벤트
 *
 * 사용 예:
 *   const claude = require('./adapters/adapter-claude');
 *   const evt = claude.fromApiResponse(completion, { sessionId });
 */

const { normalizeAiEvent, AI_SOURCES } = require('./ai-adapter-base');

/**
 * Claude messages API 응답 → MindmapEvent
 * @param {object} response  - Anthropic API 응답
 * @param {object} ctx       - { sessionId, parentEventId }
 * @returns {object|null}
 */
function fromApiResponse(response, ctx = {}) {
  const content = response?.content || [];
  if (content.length === 0) return null;

  const model = response.model || 'claude';
  const usage = response.usage || {};
  const tokenCount = (usage.input_tokens || 0) + (usage.output_tokens || 0);

  // tool_use 가 있으면 → tool.end 이벤트
  const toolUses = content.filter(c => c.type === 'tool_use');
  if (toolUses.length > 0) {
    const firstTool = toolUses[0];
    const toolName = firstTool?.name || 'unknown';
    const toolArgs = firstTool?.input || {};

    return normalizeAiEvent({
      aiSource:      AI_SOURCES.CLAUDE,
      sessionId:     ctx.sessionId || 'claude-default',
      type:          'tool.end',
      content:       `Tool: ${toolName}`,
      parentEventId: ctx.parentEventId || null,
      extra: {
        model,
        tokenCount,
        toolName,
        toolArgs,
        toolCallId:   firstTool?.id || null,
        allToolUses:  toolUses.map(t => t?.name).filter(Boolean),
        stopReason:   response?.stop_reason || null,
      },
    });
  }

  // 일반 텍스트 응답 → assistant.message
  const textBlocks = content.filter(c => c.type === 'text');
  const text = textBlocks.map(c => c.text || '').join('');

  return normalizeAiEvent({
    aiSource:      AI_SOURCES.CLAUDE,
    sessionId:     ctx.sessionId || 'claude-default',
    type:          'assistant.message',
    content:       text,
    parentEventId: ctx.parentEventId || null,
    extra: {
      model,
      tokenCount,
      inputTokens:   usage.input_tokens || 0,
      outputTokens:  usage.output_tokens || 0,
      stopReason:    response?.stop_reason || null,
    },
  });
}

/**
 * 사용자 질문 이벤트 생성
 */
function fromUserPrompt(messages, ctx = {}) {
  const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
  const content = Array.isArray(lastUser?.content)
    ? lastUser.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('')
    : (lastUser?.content || '');

  return normalizeAiEvent({
    aiSource:      AI_SOURCES.CLAUDE,
    sessionId:     ctx.sessionId || 'claude-default',
    type:          'user.message',
    content,
    parentEventId: ctx.parentEventId || null,
    extra:          { model: ctx.model || 'claude' },
  });
}

/**
 * Claude SDK 클라이언트 자동 추적 래퍼
 *
 * 사용 예:
 *   const { wrapClaudeClient } = require('./adapters/adapter-claude');
 *   const trackedClaude = wrapClaudeClient(new Anthropic({ apiKey }), {
 *     sessionId: 'my-session',
 *     onEvent: (evt) => console.log('Event:', evt)
 *   });
 */
function wrapClaudeClient(client, options = {}) {
  const { sessionId, onEvent } = options;

  const originalMessagesCreate = client.messages.create.bind(client);

  client.messages.create = async function(body, ...args) {
    // 사용자 메시지 이벤트 생성
    const userEvent = fromUserPrompt(body.messages, { sessionId, model: body.model });
    if (userEvent && onEvent) onEvent(userEvent);

    try {
      const response = await originalMessagesCreate(body, ...args);

      // AI 응답 이벤트 생성
      const aiEvent = fromApiResponse(response, { sessionId });
      if (aiEvent && onEvent) onEvent(aiEvent);

      return response;
    } catch (error) {
      // 에러 이벤트 생성
      const errorEvent = normalizeAiEvent({
        aiSource:  AI_SOURCES.CLAUDE,
        sessionId: sessionId || 'claude-default',
        type:      'error',
        content:   `Claude API Error: ${error.message}`,
        extra:     { error: error.toString() },
      });
      if (onEvent) onEvent(errorEvent);
      throw error;
    }
  };

  return client;
}

module.exports = {
  fromApiResponse,
  fromUserPrompt,
  wrapClaudeClient,
};