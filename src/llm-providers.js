'use strict';

/**
 * LLM 프로바이더 레지스트리
 * 새 프로바이더 추가: 이 객체에 항목 하나만 추가하면 전체 시스템에 자동 반영
 */
const PROVIDERS = {

  // ── 기본값 (설치 즉시 작동, API 키 불필요) ──────────────────────────────────
  ollama: {
    icon:         '🟡',
    name:         'Ollama (로컬)',
    requiresKey:  false,
    baseUrl:      'http://localhost:11434',
    models:       'dynamic',   // /api/llm-settings/ollama-models 에서 자동 조회
    defaultModel: 'orbit-insight:v1',
    description:  '로컬 실행, 무료, 인터넷 불필요',
  },

  // ── 선택적 클라우드 프로바이더 ────────────────────────────────────────────────
  anthropic: {
    icon:         '🟠',
    name:         'Claude',
    requiresKey:  true,
    baseUrl:      'https://api.anthropic.com',
    keyPrefix:    'sk-ant-',
    keyHint:      'sk-ant-api03-...',
    models: [
      { id: 'claude-opus-4-5',          label: 'Opus 4.5',        tier: 'best'  },
      { id: 'claude-sonnet-4-5',        label: 'Sonnet 4.5',      tier: 'smart' },
      { id: 'claude-haiku-3-5',         label: 'Haiku 3.5',       tier: 'fast'  },
      { id: 'claude-opus-4-0',          label: 'Opus 4',          tier: 'best'  },
      { id: 'claude-sonnet-4-0',        label: 'Sonnet 4',        tier: 'smart' },
    ],
    defaultModel: 'claude-sonnet-4-5',
    description:  '최고 품질, Anthropic',
  },

  openai: {
    icon:         '🟢',
    name:         'ChatGPT',
    requiresKey:  true,
    baseUrl:      'https://api.openai.com',
    keyPrefix:    'sk-',
    keyHint:      'sk-proj-...',
    models: [
      { id: 'gpt-4o',           label: 'GPT-4o',        tier: 'best'  },
      { id: 'gpt-4o-mini',      label: 'GPT-4o Mini',   tier: 'fast'  },
      { id: 'o1',               label: 'o1',             tier: 'think' },
      { id: 'o1-mini',          label: 'o1 Mini',        tier: 'think' },
      { id: 'o3-mini',          label: 'o3 Mini',        tier: 'think' },
    ],
    defaultModel: 'gpt-4o',
    description:  '범용 AI, OpenAI',
  },

  google: {
    icon:         '🔵',
    name:         'Gemini',
    requiresKey:  true,
    baseUrl:      'https://generativelanguage.googleapis.com',
    keyPrefix:    'AIza',
    keyHint:      'AIzaSy...',
    models: [
      { id: 'gemini-2.0-flash',              label: 'Flash 2.0',        tier: 'fast'  },
      { id: 'gemini-2.0-flash-thinking-exp', label: 'Flash Thinking',   tier: 'think' },
      { id: 'gemini-1.5-pro',                label: 'Pro 1.5',          tier: 'best'  },
      { id: 'gemini-1.5-flash',              label: 'Flash 1.5',        tier: 'fast'  },
    ],
    defaultModel: 'gemini-2.0-flash',
    description:  '멀티모달, Google',
  },

  xai: {
    icon:         '⚫',
    name:         'Grok',
    requiresKey:  true,
    baseUrl:      'https://api.x.ai',
    keyPrefix:    'xai-',
    keyHint:      'xai-...',
    models: [
      { id: 'grok-3',         label: 'Grok 3',        tier: 'best'  },
      { id: 'grok-3-mini',    label: 'Grok 3 Mini',   tier: 'fast'  },
      { id: 'grok-beta',      label: 'Grok Beta',     tier: 'smart' },
    ],
    defaultModel: 'grok-3',
    description:  '실시간 웹 검색, xAI',
  },
};

/** tier 레이블 */
const TIER_LABEL = {
  best:  '⭐ 최고',
  smart: '🧠 스마트',
  fast:  '⚡ 빠름',
  think: '🤔 추론',
};

module.exports = { PROVIDERS, TIER_LABEL };
