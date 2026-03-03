/**
 * adapter-perplexity.js
 * Perplexity API 응답 → 표준 MindmapEvent 변환
 *
 * Perplexity는 OpenAI 호환 형식이지만
 * citations(출처 URL 배열) 가 추가로 포함됨
 *
 * 사용 예:
 *   const perplexity = require('./adapters/adapter-perplexity');
 *   const evt = perplexity.fromApiResponse(apiResponse, { sessionId });
 */

const { normalizeAiEvent, AI_SOURCES } = require('./ai-adapter-base');

/**
 * Perplexity API 응답 → MindmapEvent
 * @param {object} response  - Perplexity API 응답 (OpenAI 호환 + citations)
 * @param {object} ctx       - { sessionId, parentEventId }
 * @returns {object|null}
 */
function fromApiResponse(response, ctx = {}) {
  const choices = response?.choices || [];
  if (choices.length === 0) return null;

  const message = choices[0]?.message;
  const text = message?.content || '';
  const citations = response.citations || [];     // Perplexity 전용: 출처 URL 배열
  const model = response.model || 'perplexity';

  // 토큰 사용량
  const usage = response.usage || {};
  const tokenCount = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

  return normalizeAiEvent({
    aiSource:      AI_SOURCES.PERPLEXITY,
    sessionId:     ctx.sessionId || 'perplexity-default',
    type:          'assistant.message',
    content:       text,
    parentEventId: ctx.parentEventId || null,
    extra: {
      model,
      tokenCount,
      citations,                              // 🔑 Perplexity 핵심: 출처 URL
      citationCount: citations.length,
      finishReason: choices[0]?.finish_reason || null,
    },
  });
}

/**
 * 사용자 질문 이벤트 생성
 */
function fromUserPrompt(prompt, ctx = {}) {
  return normalizeAiEvent({
    aiSource:      AI_SOURCES.PERPLEXITY,
    sessionId:     ctx.sessionId || 'perplexity-default',
    type:          'user.message',
    content:       typeof prompt === 'string' ? prompt : (prompt?.content || JSON.stringify(prompt)),
    parentEventId: ctx.parentEventId || null,
    extra:          { model: ctx.model || 'perplexity' },
  });
}

/**
 * fetch 기반 자동 추적 래퍼
 * 기존 fetch 코드에 wrap만 하면 자동으로 마인드맵에 기록
 *
 * 사용 예:
 *   const { trackedFetch } = require('./adapters/adapter-perplexity');
 *   // 기존: const res = await fetch('https://api.perplexity.ai/chat/completions', opts);
 *   // 변경: const res = await trackedFetch('https://api.perplexity.ai/...', opts, { sessionId });
 */
async function trackedFetch(url, fetchOpts, trackOpts = {}) {
  const endpoint = trackOpts.endpoint || 'http://localhost:4747/api/ai-event';
  const ctx = { sessionId: trackOpts.sessionId };

  // 질문 추출
  let prompt = '';
  try {
    const body = JSON.parse(fetchOpts.body || '{}');
    const msgs = body.messages || [];
    const lastUser = [...msgs].reverse().find(m => m.role === 'user');
    if (lastUser) prompt = lastUser.content;
  } catch {}

  const userEvt = fromUserPrompt(prompt, ctx);
  _postEvent(endpoint, userEvt).catch(() => {});

  // 실제 fetch
  const res = await fetch(url, fetchOpts);
  const clone = res.clone();
  clone.json().then(data => {
    const assistEvt = fromApiResponse(data, { ...ctx, parentEventId: userEvt.id });
    if (assistEvt) _postEvent(endpoint, assistEvt).catch(() => {});
  }).catch(() => {});

  return res;
}

async function _postEvent(endpoint, event) {
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch {}
}

module.exports = { fromApiResponse, fromUserPrompt, trackedFetch };
