/**
 * Orbit — content-ai.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ChatGPT / Claude.ai / Gemini / Perplexity / Copilot 대화 캡처
 *
 * 작동 방식:
 *   1. MutationObserver로 DOM 변화를 감시
 *   2. AI 응답이 완료되면 전체 대화를 추출
 *   3. chrome.runtime.sendMessage → background.js → localhost:4747 저장
 *
 * 프라이버시:
 *   - 데이터는 로컬(chrome.storage + localhost:4747)에만 저장
 *   - Railway 서버에는 요약/인사이트만 전송 (원문 없음)
 *   - 팝업에서 대화별 공개/비공개 설정 가능
 * ─────────────────────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  // ── 사이트 설정 ────────────────────────────────────────────────────────────
  const SITES = {
    'chat.openai.com': 'ChatGPT',
    'chatgpt.com':     'ChatGPT',
    'claude.ai':       'Claude',
    'gemini.google.com': 'Gemini',
    'www.perplexity.ai': 'Perplexity',
    'perplexity.ai':   'Perplexity',
    'copilot.microsoft.com': 'Copilot',
  };

  const host     = location.hostname;
  const siteName = SITES[host];
  if (!siteName) return;

  // ── 사이트별 DOM 선택자 ────────────────────────────────────────────────────
  const SELECTORS = {
    ChatGPT: {
      // 각 대화 턴 컨테이너 (role 속성으로 구분)
      turnAttr:  '[data-message-author-role]',
      userRole:  'user',
      aiRole:    'assistant',
      textSels:  [
        '.whitespace-pre-wrap',         // 사용자 입력
        '.markdown.prose',              // AI 응답 (마크다운)
        '.text-message .whitespace-pre-wrap',
        'p', '[data-message-content]',
      ],
    },
    Claude: {
      // Claude.ai 구조: human-turn / assistant-turn
      userSel:  '[data-testid="human-turn"], .human-turn, [class*="human"]',
      aiSel:    '[data-testid="assistant-turn"], .assistant-turn, [class*="assistant"]',
      textSels: [
        '.font-user-message', '.font-claude-message',
        '.prose', 'p',
      ],
    },
    Gemini: {
      userSel: '.query-text, [data-query], .user-query',
      aiSel:   '.response-container-scrollable, .response-content, model-response',
      textSels: [
        '.query-text-line', '.response-text',
        '.markdown-main-panel p', 'p',
      ],
    },
    Perplexity: {
      userSel: '[data-testid="query"] .font-display, .col-span-8 .break-words, .user-query',
      aiSel:   '.prose, [data-testid="answer"] .prose, .answer-text',
      textSels: ['p', 'li'],
    },
    Copilot: {
      userSel: '[data-content="user-message"], .user-message',
      aiSel:   '[data-content="bot-message"], .bot-message, [class*="bot"]',
      textSels: ['p', '.text-body-l', '[class*="message-text"]'],
    },
  };

  // ── 텍스트 추출 헬퍼 ──────────────────────────────────────────────────────
  function getText(el, selectors) {
    for (const sel of selectors) {
      const found = el.querySelectorAll(sel);
      if (found.length > 0) {
        return Array.from(found).map(e => e.textContent.trim()).join('\n').trim();
      }
    }
    return el.textContent.trim();
  }

  const MAX_CONTENT = 8000; // 메시지당 최대 8000자 (토큰 절약)

  // ── 대화 추출 ─────────────────────────────────────────────────────────────
  function extractConversation() {
    const cfg  = SELECTORS[siteName];
    const msgs = [];

    if (siteName === 'ChatGPT') {
      // ChatGPT: data-message-author-role 속성으로 구분
      const turns = document.querySelectorAll(cfg.turnAttr);
      for (const turn of turns) {
        const role = turn.getAttribute('data-message-author-role');
        if (!role) continue;
        const text = getText(turn, cfg.textSels);
        if (text) {
          msgs.push({
            role:    role === cfg.userRole ? 'user' : 'assistant',
            content: text.slice(0, MAX_CONTENT),
          });
        }
      }
    } else {
      // Claude / Gemini / Perplexity / Copilot: user/ai 선택자 분리
      const userEls = Array.from(document.querySelectorAll(cfg.userSel) || []);
      const aiEls   = Array.from(document.querySelectorAll(cfg.aiSel)   || []);
      const maxLen  = Math.max(userEls.length, aiEls.length);

      for (let i = 0; i < maxLen; i++) {
        if (userEls[i]) {
          const text = getText(userEls[i], cfg.textSels);
          if (text) msgs.push({ role: 'user',      content: text.slice(0, MAX_CONTENT) });
        }
        if (aiEls[i]) {
          const text = getText(aiEls[i], cfg.textSels);
          if (text) msgs.push({ role: 'assistant', content: text.slice(0, MAX_CONTENT) });
        }
      }
    }

    return msgs;
  }

  // ── 중복 방지: 마지막 전송 해시 ───────────────────────────────────────────
  let lastHash = '';
  function simpleHash(msgs) {
    const s = msgs.map(m => m.role[0] + m.content.slice(0, 40)).join('|');
    return s;
  }

  // ── 캡처 + 전송 ───────────────────────────────────────────────────────────
  function capture() {
    const msgs = extractConversation();

    // 최소 1쌍 (질문+답변) 있어야 전송
    if (msgs.length < 2) return;
    // AI 응답이 마지막이어야 완성된 대화 (생성 중 스킵)
    if (msgs[msgs.length - 1]?.role !== 'assistant') return;

    const hash = simpleHash(msgs);
    if (hash === lastHash) return; // 동일 내용 중복 방지
    lastHash = hash;

    const payload = {
      type:      'ai_conversation',
      site:      siteName,
      url:       location.href,
      title:     document.title,
      messages:  msgs,
      msgCount:  msgs.length,
      capturedAt: new Date().toISOString(),
      // 기본값: 비공개 (로컬 저장만)
      shared: false,
    };

    chrome.runtime.sendMessage(payload).catch(() => {}); // background.js로 전달
  }

  // ── 디바운스 ──────────────────────────────────────────────────────────────
  let debTimer = null;
  function debouncedCapture() {
    clearTimeout(debTimer);
    debTimer = setTimeout(capture, 2500); // AI 응답 완료 후 2.5초 대기
  }

  // ── MutationObserver: DOM 변화 감시 ──────────────────────────────────────
  const observer = new MutationObserver(debouncedCapture);
  observer.observe(document.body, {
    childList:     true,
    subtree:       true,
    characterData: true,  // 텍스트 노드 변화도 감지 (스트리밍 출력)
  });

  // ── SPA 페이지 전환 감지 (새 대화 시작 시 리셋) ───────────────────────────
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl  = location.href;
      lastHash = ''; // 새 URL = 새 대화 → 해시 리셋
    }
  }, 1000);

  // ── 초기 캡처 (페이지 새로고침 시 이미 로드된 대화) ─────────────────────
  setTimeout(capture, 3000);

  console.log(`[Orbit] ${siteName} 대화 캡처 시작`);
})();
