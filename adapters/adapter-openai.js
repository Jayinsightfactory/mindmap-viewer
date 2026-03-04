/**
 * adapter-openai.js
 * OpenAI API 응답 → 표준 MindmapEvent 변환
 *
 * 지원:
 *   - chat.completions (GPT-4o, GPT-4, GPT-3.5 등)
 *   - tool_calls → tool.end 이벤트
 *   - function_call (구형) → tool.end 이벤트
 *
 * 사용 예:
 *   const openai = require('./adapters/adapter-openai');
 *   const evt = openai.fromApiResponse(completion, { sessionId });
 */

const { normalizeAiEvent, AI_SOURCES } = require('./ai-adapter-base');

/**
 * OpenAI chat.completions 응답 → MindmapEvent
 * @param {object} response  - OpenAI API 응답
 * @param {object} ctx       - { sessionId, parentEventId }
 * @returns {object|null}
 */
function fromApiResponse(response, ctx = {}) {
  const choices = response?.choices || [];
  if (choices.length === 0) return null;

  const message = choices[0]?.message;
  const model   = response.model || 'openai';
  const usage   = response.usage || {};
  const tokenCount = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

  // tool_calls 가 있으면 → tool.end 이벤트
  const toolCalls = message?.tool_calls || [];
  if (toolCalls.length > 0) {
    const firstTool = toolCalls[0];
    const toolName  = firstTool?.function?.name || 'unknown';
    let toolArgs = {};
    try { toolArgs = JSON.parse(firstTool?.function?.arguments || '{}'); } catch {}

    return normalizeAiEvent({
      aiSource:      AI_SOURCES.OPENAI,
      sessionId:     ctx.sessionId || 'openai-default',
      type:          'tool.end',
      content:       `Tool: ${toolName}`,
      parentEventId: ctx.parentEventId || null,
      extra: {
        model,
        tokenCount,
        toolName,
        toolArgs,
        toolCallId:   firstTool?.id || null,
        allToolCalls: toolCalls.map(t => t?.function?.name).filter(Boolean),
        finishReason: choices[0]?.finish_reason || null,
      },
    });
  }

  // 일반 텍스트 응답 → assistant.message
  const text = message?.content || '';
  return normalizeAiEvent({
    aiSource:      AI_SOURCES.OPENAI,
    sessionId:     ctx.sessionId || 'openai-default',
    type:          'assistant.message',
    content:       text,
    parentEventId: ctx.parentEventId || null,
    extra: {
      model,
      tokenCount,
      promptTokens:     usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      finishReason:     choices[0]?.finish_reason || null,
    },
  });
}

/**
 * 사용자 질문 이벤트 생성
 */
function fromUserPrompt(messages, ctx = {}) {
  const lastUser = [...(messages || [])].reverse().find(m => m.role === 'user');
  const content  = typeof lastUser?.content === 'string'
    ? lastUser.content
    : JSON.stringify(lastUser?.content || '');

  return normalizeAiEvent({
    aiSource:      AI_SOURCES.OPENAI,
    sessionId:     ctx.sessionId || 'openai-default',
    type:          'user.message',
    content,
    parentEventId: ctx.parentEventId || null,
    extra:          { model: ctx.model || 'openai' },
  });
}

/**
 * OpenAI SDK 클라이언트 자동 추적 래퍼
 *
 * 사용 예:
 *   const { wrapOpenAIClient } = require('./adapters/adapter-openai');
 *   const trackedOpenAI = wrapOpenAIClient(new OpenAI({ apiKey }), {
 *     sessionId: 'my-session',
 *     endpoint: 'http://localhost:4747/api/ai-event',
 *   });
 *   const completion = await trackedOpenAI.chat.completions.create({...});
 */
function wrapOpenAIClient(client, opts = {}) {
  const endpoint = opts.endpoint || 'http://localhost:4747/api/ai-event';
  const ctx = { sessionId: opts.sessionId, model: opts.model };

  const originalCreate = client.chat.completions.create.bind(client.chat.completions);

  client.chat.completions.create = async function(params) {
    // 질문 이벤트
    const userEvt = fromUserPrompt(params.messages, { ...ctx, model: params.model });
    _postEvent(endpoint, userEvt).catch(() => {});

    // 실제 API 호출
    const result = await originalCreate(params);

    // 응답 이벤트
    const assistEvt = fromApiResponse(result, { ...ctx, parentEventId: userEvt.id, model: params.model });
    if (assistEvt) _postEvent(endpoint, assistEvt).catch(() => {});

    return result;
  };

  return client;
}

async function _postEvent(endpoint, event) {
  const http = endpoint.startsWith('https') ? require('https') : require('http');
  const url  = new URL(endpoint);
  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port || 80,
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

module.exports = { fromApiResponse, fromUserPrompt, wrapOpenAIClient };
