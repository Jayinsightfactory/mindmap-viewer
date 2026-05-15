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

// ── nenova 전용 system prompt ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 nenova ERP(화훼 유통 관리 프로그램) 사용자를 돕는 어시스턴트입니다.
간결하게 답하세요. 모르는 건 모른다고 하세요.
데이터 조회가 필요하면 어느 메뉴를 보면 되는지 안내하세요.
답변은 한국어로 합니다.`;

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

module.exports = router;
