'use strict';

/**
 * routes/nenova-ai.js
 * ─────────────────────────────────────────────────────────────────────────────
 * nenova 대시보드 챗봇 AI 응답 API
 *
 * 마운트: app.use('/api/nenova/ai', require('./routes/nenova-ai'))
 *
 * 엔드포인트:
 *   POST /api/nenova/ai/ask  — 사용자 질문 → LLM 답변
 *     Body: { question: string, context?: object }
 *     Auth: Bearer 토큰 (JWT)
 *     Response: { answer: string }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');
const https   = require('https');
const router  = express.Router();

// ── Bearer 토큰 인증 미들웨어 ──────────────────────────────────────────────────
function bearerAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { verifyToken } = require('../src/auth');
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'invalid token' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// ── nenova 전용 system prompt (기존 /ask용) ──────────────────────────────────
const SYSTEM_PROMPT = `당신은 nenova ERP(화훼 유통 관리 프로그램) 사용자를 돕는 어시스턴트입니다.
간결하게 답하세요. 모르는 건 모른다고 하세요.
데이터 조회가 필요하면 어느 메뉴를 보면 되는지 안내하세요.
답변은 한국어로 합니다.`;

// ── nenova 멀티턴 챗봇 system prompt (Tool Use 포함) ─────────────────────────
const CHAT_SYSTEM_PROMPT = `당신은 nenova 화훼 도매업 영업/수입 담당자를 돕는 AI입니다.

[도메인 지식]
- 차수(OrderWeek): "20-01" 형식. 사용자가 "20차"라고 하면 20-01과 20-02를 합산해서 답하세요.
- 분배 = 출고. "미분배", "미출고" 같은 개념은 없습니다.
- 재고는 ProductStock에 이미 입고-분배가 반영된 스냅샷 값입니다.
- 수량 체계: Box → Bunch → Stem (1 Box ≈ 15~16 Bunch, 1 Bunch ≈ 10 Stems)

[답변 규칙]
- 답변은 한국어로, 간결하게 작성하세요.
- 숫자 답변 끝에는 다음 액션 옵션을 "[옵션1][옵션2]" 형식으로 제안하세요.
  예: "[20-01만 보기][20-02만 보기][업체별 분해][품목별 분해]"
- 데이터가 필요하면 반드시 도구(tool)를 호출하고, 도구 없이 숫자를 추측하지 마세요.
- 모호한 질문(어느 업체인지 불명확 등)은 되물으세요.
- 합산이 자연스러운 경우(예: "20차")는 합계로 답하고 분해 옵션 칩을 제공하세요.
- 업체 key를 모를 때는 list_my_vendors 도구로 목록을 먼저 조회하세요.`;

// ── POST /ask ─────────────────────────────────────────────────────────────────
router.post('/ask', bearerAuth, async (req, res) => {
  const { question, context } = req.body || {};
  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: '질문을 입력해주세요.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ answer: 'AI 키 미설정 (관리자에게 문의)' });
  }

  try {
    const { generate } = require('../src/llm-gateway');
    const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-20241022';

    // context가 있으면 프롬프트에 포함
    let contextStr = '';
    if (context && typeof context === 'object') {
      try {
        contextStr = `\n\n[현재 화면 컨텍스트]\n${JSON.stringify(context, null, 2)}`;
      } catch { /* 직렬화 실패 시 무시 */ }
    }

    const prompt = `${SYSTEM_PROMPT}${contextStr}\n\n사용자: ${question.trim()}\n어시스턴트:`;

    const answer = await generate({ provider: 'anthropic', model, prompt, apiKey });
    return res.json({ answer: answer || '죄송해요, 지금 답변하기 어려워요.' });
  } catch (e) {
    console.error('[nenova-ai/ask]', e.message);
    return res.status(200).json({ answer: 'AI 응답 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
  }
});

// ── Anthropic Messages API 직접 호출 (Tool Use 포함) ─────────────────────────
function anthropicMessages({ apiKey, model, system, messages, tools }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages,
      tools: tools || undefined,
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers:  {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.error?.message || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
          } else {
            try { require('../src/llm-usage').record('nenova-ai(chatbot)', model, parsed.usage); } catch {}
            resolve(parsed);
          }
        } catch {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(body);
    req.end();
  });
}

// ── POST /chat — 멀티턴 + Tool Use ────────────────────────────────────────────
router.post('/chat', bearerAuth, async (req, res) => {
  const { messages, system } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 배열이 필요합니다.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(200).json({
      messages,
      error: 'AI 키 미설정',
      answer: 'AI 키가 설정되지 않았습니다. 관리자에게 문의하세요.',
    });
  }

  // 모델: 환경변수 → claude-sonnet-4-5 → fallback
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const systemPrompt = system || CHAT_SYSTEM_PROMPT;

  // bearer 토큰 pass-through (내부 ERP API 호출용)
  const bearerToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  // Tool Use 도구 로드
  const { TOOLS, dispatch } = require('../src/ai-tools/nenova-erp');

  let conversationMessages = [...messages];
  const MAX_TOOL_ROUNDS = 5;
  let finalText = null;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await anthropicMessages({
        apiKey,
        model,
        system:   systemPrompt,
        messages: conversationMessages,
        tools:    TOOLS,
      });

      const stopReason = response.stop_reason;
      const content    = response.content || [];

      // 어시스턴트 응답을 대화에 추가
      conversationMessages.push({ role: 'assistant', content });

      if (stopReason !== 'tool_use') {
        // 텍스트 응답 — 종료
        finalText = content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
        break;
      }

      // Tool Use 블록 처리
      const toolUseBlocks = content.filter(b => b.type === 'tool_use');
      const toolResults   = await Promise.all(
        toolUseBlocks.map(async block => {
          let toolContent;
          try {
            const result = await dispatch(block.name, block.input, bearerToken);
            toolContent  = JSON.stringify(result);
          } catch (e) {
            console.error(`[nenova-ai/chat] tool error (${block.name}):`, e.message);
            toolContent = JSON.stringify({ error: e.message });
          }
          return {
            type:        'tool_result',
            tool_use_id: block.id,
            content:     toolContent,
          };
        })
      );

      // tool_result를 user 메시지로 추가
      conversationMessages.push({
        role:    'user',
        content: toolResults,
      });
    }

    if (!finalText) {
      // 루프 한도 초과 — 마지막 어시스턴트 텍스트 추출
      const lastAssistant = [...conversationMessages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant && Array.isArray(lastAssistant.content)) {
        finalText = lastAssistant.content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join('');
      }
      finalText = finalText || '처리 중 오류가 발생했습니다. 다시 시도해주세요.';
    }

    return res.json({ messages: conversationMessages, answer: finalText });
  } catch (e) {
    console.error('[nenova-ai/chat]', e.message);
    return res.status(200).json({
      messages: conversationMessages,
      error:    e.message,
      answer:   'AI 응답 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
    });
  }
});

module.exports = router;
