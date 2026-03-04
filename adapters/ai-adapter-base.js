/**
 * ai-adapter-base.js
 * 멀티 AI 어댑터 공통 베이스
 *
 * 역할:
 *   - AI 소스 상수 (AI_SOURCES)
 *   - AI별 시각 스타일 (getAiStyle)
 *   - 표준 이벤트 생성 (normalizeAiEvent)
 *
 * 설계 원칙:
 *   - OCP: 새 AI 추가 = AI_SOURCES + STYLES 맵에 추가만
 *   - SRP: 이 파일은 "공통 변환 규칙"만 담당
 */

const { ulid } = require('ulid');

// ─── AI 소스 상수 ──────────────────────────────────────
const AI_SOURCES = {
  CLAUDE:      'claude',
  GEMINI:      'gemini',
  PERPLEXITY:  'perplexity',
  OPENAI:      'openai',
  VSCODE:      'vscode',
  // 통합 어댑터
  NOTION:      'notion',
  CALENDAR:    'calendar',
  SLACK:       'slack',
  DISCORD:     'discord',
  ZOOM:        'zoom',
};

// ─── AI별 시각 스타일 (마인드맵 노드 색/형태/아이콘) ───
const AI_STYLES = {
  [AI_SOURCES.CLAUDE]: {
    color:       '#3fb950',   // 초록
    borderColor: '#2ea043',
    shape:       'box',
    icon:        '🟢',
    label:       'Claude',
    badgeBg:     'rgba(63,185,80,0.15)',
    badgeColor:  '#3fb950',
  },
  [AI_SOURCES.GEMINI]: {
    color:       '#4285f4',   // 파랑
    borderColor: '#2b6bd6',
    shape:       'diamond',
    icon:        '🔵',
    label:       'Gemini',
    badgeBg:     'rgba(66,133,244,0.15)',
    badgeColor:  '#4285f4',
  },
  [AI_SOURCES.PERPLEXITY]: {
    color:       '#bc8cff',   // 보라
    borderColor: '#a070e0',
    shape:       'hexagon',
    icon:        '🟣',
    label:       'Perplexity',
    badgeBg:     'rgba(188,140,255,0.15)',
    badgeColor:  '#bc8cff',
  },
  [AI_SOURCES.OPENAI]: {
    color:       '#8b949e',   // 회색
    borderColor: '#6e7681',
    shape:       'box',
    icon:        '⚪',
    label:       'GPT',
    badgeBg:     'rgba(139,148,158,0.15)',
    badgeColor:  '#8b949e',
  },
  [AI_SOURCES.VSCODE]: {
    color:       '#f85149',
    borderColor: '#da3633',
    shape:       'ellipse',
    icon:        '🔴',
    label:       'VSCode',
    badgeBg:     'rgba(248,81,73,0.15)',
    badgeColor:  '#f85149',
  },
  // ── 통합 어댑터 스타일 ──────────────────────────────
  [AI_SOURCES.NOTION]: {
    color:       '#e8e8e8',
    borderColor: '#b0b0b0',
    shape:       'box',
    icon:        '📋',
    label:       'Notion',
    badgeBg:     'rgba(232,232,232,0.15)',
    badgeColor:  '#e8e8e8',
  },
  [AI_SOURCES.CALENDAR]: {
    color:       '#4285f4',
    borderColor: '#2b6bd6',
    shape:       'circle',
    icon:        '📅',
    label:       'Calendar',
    badgeBg:     'rgba(66,133,244,0.15)',
    badgeColor:  '#4285f4',
  },
  [AI_SOURCES.SLACK]: {
    color:       '#4a154b',
    borderColor: '#611f69',
    shape:       'box',
    icon:        '💬',
    label:       'Slack',
    badgeBg:     'rgba(74,21,75,0.25)',
    badgeColor:  '#e8a0ff',
  },
  [AI_SOURCES.DISCORD]: {
    color:       '#5865f2',
    borderColor: '#3c47d0',
    shape:       'box',
    icon:        '🎮',
    label:       'Discord',
    badgeBg:     'rgba(88,101,242,0.15)',
    badgeColor:  '#5865f2',
  },
  [AI_SOURCES.ZOOM]: {
    color:       '#2d8cff',
    borderColor: '#1a6fd6',
    shape:       'hexagon',
    icon:        '🎥',
    label:       'Zoom',
    badgeBg:     'rgba(45,140,255,0.15)',
    badgeColor:  '#2d8cff',
  },
};

const DEFAULT_STYLE = {
  color:       '#c9d1d9',
  borderColor: '#8b949e',
  shape:       'dot',
  icon:        '❓',
  label:       'AI',
  badgeBg:     'rgba(201,209,217,0.15)',
  badgeColor:  '#c9d1d9',
};

// ─── AI 스타일 조회 ────────────────────────────────────
function getAiStyle(aiSource) {
  return AI_STYLES[aiSource] || DEFAULT_STYLE;
}

// ─── 표준 AI 이벤트 생성 ──────────────────────────────
/**
 * @param {object} params
 * @param {string} params.aiSource       - AI_SOURCES 값
 * @param {string} params.sessionId
 * @param {string} params.type           - 이벤트 타입 (assistant.message 등)
 * @param {string} [params.content]      - 응답 텍스트
 * @param {string} [params.timestamp]
 * @param {string[]} [params.files]      - 연관 파일 경로
 * @param {string|null} [params.parentEventId]
 * @param {object} [params.extra]        - AI별 추가 데이터
 * @returns {object} 표준 MindmapEvent
 */
function normalizeAiEvent(params) {
  const { aiSource, sessionId, type, content, timestamp, files, parentEventId, extra } = params;

  if (!aiSource) throw new Error('aiSource is required');

  const style = getAiStyle(aiSource);
  const text = content || '';

  return {
    id:            ulid(),
    type:          type || 'assistant.message',
    aiSource,
    source:        'ai-adapter',
    sessionId:     sessionId || 'unknown',
    userId:        'local',
    channelId:     'default',
    parentEventId: parentEventId || null,
    timestamp:     timestamp || new Date().toISOString(),
    data: {
      contentPreview: text.substring(0, 200),
      content:        text.substring(0, 8000),
      files:          files || [],
      aiLabel:        style.label,
      aiIcon:         style.icon,
      ...(extra || {}),
    },
    // 시각화 힌트 (graph-engine에서 사용)
    _style: {
      color:       { background: style.color, border: style.borderColor,
                     highlight: { background: style.color, border: style.borderColor } },
      shape:       style.shape,
      badgeBg:     style.badgeBg,
      badgeColor:  style.badgeColor,
    },
  };
}

module.exports = { AI_SOURCES, AI_STYLES, getAiStyle, normalizeAiEvent };
