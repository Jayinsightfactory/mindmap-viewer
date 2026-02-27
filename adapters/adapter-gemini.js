/**
 * adapter-gemini.js
 * Google Gemini API 응답 → 표준 MindmapEvent 변환
 *
 * 지원 형식:
 *   - Gemini generateContent API (REST/SDK)
 *   - 스트리밍 청크 누적 결과
 *
 * 사용 예:
 *   const gemini = require('./adapters/adapter-gemini');
 *   const evt = gemini.fromApiResponse(apiResponse, { sessionId, model });
 *   // → POST http://localhost:4747/api/ai-event 로 전송
 */

const { normalizeAiEvent, AI_SOURCES } = require('./ai-adapter-base');

/**
 * Gemini generateContent 응답 → MindmapEvent
 * @param {object} response  - Gemini API 응답 객체
 * @param {object} ctx       - { sessionId, model, parentEventId }
 * @returns {object|null}
 */
function fromApiResponse(response, ctx = {}) {
  const candidates = response?.candidates || [];
  if (candidates.length === 0) return null;

  // 첫 번째 후보의 텍스트 추출
  const parts = candidates[0]?.content?.parts || [];
  const text = parts
    .filter(p => p.text)
    .map(p => p.text)
    .join('');

  if (!text && !parts.length) return null;

  // 토큰 사용량
  const usage = response.usageMetadata || {};
  const tokenCount = (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);

  // 인라인 파일 참조 추출 (fileParts)
  const files = parts
    .filter(p => p.fileData?.fileUri)
    .map(p => p.fileData.fileUri);

  return normalizeAiEvent({
    aiSource:      AI_SOURCES.GEMINI,
    sessionId:     ctx.sessionId || 'gemini-default',
    type:          'assistant.message',
    content:       text,
    files,
    parentEventId: ctx.parentEventId || null,
    extra: {
      model:              ctx.model || response.modelVersion || 'gemini',
      tokenCount,
      promptTokenCount:   usage.promptTokenCount || 0,
      responseTokenCount: usage.candidatesTokenCount || 0,
      finishReason:       candidates[0]?.finishReason || null,
      safetyRatings:      candidates[0]?.safetyRatings || [],
    },
  });
}

/**
 * 사용자 질문 이벤트 생성 (Gemini에 보내기 전 질문 기록용)
 * @param {string} prompt
 * @param {object} ctx
 */
function fromUserPrompt(prompt, ctx = {}) {
  return normalizeAiEvent({
    aiSource:      AI_SOURCES.GEMINI,
    sessionId:     ctx.sessionId || 'gemini-default',
    type:          'user.message',
    content:       prompt,
    parentEventId: ctx.parentEventId || null,
    extra:          { model: ctx.model || 'gemini' },
  });
}

/**
 * SDK 클라이언트 래퍼 (선택적 자동 추적)
 * Gemini SDK의 generateContent 를 감싸서 자동으로 이벤트 POST
 *
 * 사용 예:
 *   const { wrapGeminiClient } = require('./adapters/adapter-gemini');
 *   const trackedModel = wrapGeminiClient(genAI.getGenerativeModel(...), {
 *     sessionId: 'my-session',
 *     endpoint: 'http://localhost:4747/api/ai-event',
 *   });
 *   const result = await trackedModel.generateContent(prompt); // 자동 기록
 */
function wrapGeminiClient(model, opts = {}) {
  const endpoint = opts.endpoint || 'http://localhost:4747/api/ai-event';
  const ctx = { sessionId: opts.sessionId, model: opts.model };

  return {
    ...model,
    async generateContent(prompt) {
      // 질문 이벤트 전송
      const userEvt = fromUserPrompt(typeof prompt === 'string' ? prompt : JSON.stringify(prompt), ctx);
      _postEvent(endpoint, userEvt).catch(() => {});

      // 실제 API 호출
      const result = await model.generateContent(prompt);
      const response = result.response;

      // 응답 이벤트 전송
      const assistEvt = fromApiResponse(response, { ...ctx, parentEventId: userEvt.id });
      if (assistEvt) _postEvent(endpoint, assistEvt).catch(() => {});

      return result;
    },
  };
}

async function _postEvent(endpoint, event) {
  const http = endpoint.startsWith('https') ? require('https') : require('http');
  const url = new URL(endpoint);
  const body = JSON.stringify(event);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

module.exports = { fromApiResponse, fromUserPrompt, wrapGeminiClient };
