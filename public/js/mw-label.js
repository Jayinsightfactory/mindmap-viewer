/**
 * mw-label.js — 노드 라벨 결정 전용 모듈
 *
 * ─ 이 파일만 보면 라벨/텍스트 관련 모든 버그 해결 가능 ─
 *
 * 함수 목록:
 *   _mwNormCat(raw)          : 영문/raw 카테고리 → 한국어 이모지 라벨
 *   mwGroupLabel(n)          : 0단계 카드 상단 텍스트 (그룹 대표)
 *   mwGroupColor(n)          : 그룹 카드 색상
 *   mwChildTopic(n)          : 1단계 자식 카드 텍스트
 *   mwLatestActivity(rawAct) : 카드 sub2 (latestActivity 정규화)
 *
 * 우선순위 (변경 금지 — 반복 튜닝 완료):
 *   groupLabel : autoTitle > projName+firstMsg > projName > firstMsg > purposeLabel > normCat
 *   childTopic : purposeLabel > proj+msg > label 가공(JSON 필터) > normCat
 */

// ─── 카테고리 정규화 매핑 ─────────────────────────────────────────────────────
const _MW_CAT_MAP = {
  // 영문 raw → 한국어
  'file':              '📁 파일 작업',
  'idle':              '⏸ 대기',
  'code':              '💻 코딩',
  'coding':            '💻 코딩',
  'browser':           '🌐 웹 작업',
  'terminal':          '⚡ 터미널',
  'design':            '🎨 디자인',
  'document':          '📄 문서 작업',
  'meeting':           '💬 미팅/소통',
  'test':              '🧪 테스트',
  'deploy':            '🚀 배포/운영',
  'research':          '🔍 조사/분석',
  'planning':          '📋 기획/설계',
  'feature':           '⚙️ 기능 개발',
  'bugfix':            '🐛 버그 수정',
  'review':            '👀 코드 리뷰',
  'communication':     '💬 소통',
  'etc':               '📌 기타',
  'other':             '📌 기타',
  // 이벤트 타입 직접 매핑
  'subagent.start':    '🤖 하위 작업',
  'subagent.stop':     '🤖 하위 작업',
  'tool.end':          '🔧 도구 실행',
  'tool.start':        '🔧 도구 실행',
  'tool.error':        '❌ 오류',
  'user.message':      '💬 대화',
  'assistant.message': '🤖 AI 응답',
  'session.start':     '🚀 세션 시작',
  'session.end':       '⏹ 세션 종료',
  'file.read':         '📄 파일 작업',
  'file.write':        '✏️ 파일 수정',
  'file.create':       '📝 파일 작성',
  'git.commit':        '📦 Git 커밋',
  'task.complete':     '✅ 작업 완료',
  'annotation.add':    '📌 메모',
};

// ─── 카테고리별 강조색 ────────────────────────────────────────────────────────
const _MW_CAT_COLOR = {
  '📁 파일 작업':  '#64748b',
  '⏸ 대기':       '#475569',
  '💻 코딩':       '#3b82f6',
  '🌐 웹 작업':    '#0ea5e9',
  '⚡ 터미널':     '#22c55e',
  '🎨 디자인':     '#ec4899',
  '📄 문서 작업':  '#a78bfa',
  '💬 미팅/소통':  '#f97316',
  '🧪 테스트':     '#06b6d4',
  '🚀 배포/운영':  '#10b981',
  '🔍 조사/분석':  '#f59e0b',
  '📋 기획/설계':  '#8b5cf6',
  '⚙️ 기능 개발':  '#3b82f6',
  '🐛 버그 수정':  '#ef4444',
  '👀 코드 리뷰':  '#14b8a6',
  '💬 소통':       '#f97316',
  '📌 기타':       '#94a3b8',
  '🤖 하위 작업':  '#79c0ff',
  '🔧 도구 실행':  '#d29922',
  '❌ 오류':       '#f85149',
  '💬 대화':       '#388bfd',
  '🤖 AI 응답':    '#3fb950',
  '🚀 세션 시작':  '#8b5cf6',
  '📦 Git 커밋':   '#f0c674',
  '✅ 작업 완료':  '#3fb950',
  '📌 메모':       '#f0c674',
};

// 추상 라벨 Set — orbit3d-label-rules.js의 ABSTRACT_LABEL_SET 참조 (단일 소스)
// isInAbstractSet() 함수 사용 권장. 직접 Set 참조 필요시 ABSTRACT_LABEL_SET 사용.

/**
 * raw 카테고리/이벤트 타입 → 한국어 이모지 라벨
 * 매핑 없으면 원본 반환
 */
function _mwNormCat(raw) {
  if (!raw) return '📌 기타';
  const k = raw.toLowerCase().trim();
  return _MW_CAT_MAP[k] || raw;
}

/**
 * 0단계 그룹 카드 상단 텍스트 결정
 * 우선순위: autoTitle > projName+firstMsg > projName > firstMsg > purposeLabel > normCat
 */
function mwGroupLabel(n) {
  const autoTitle = n.autoTitle || null;
  const projName  = n.projectName || n.project || n.repo || null;
  const firstMsg  = n.firstMsg || n.msgPreview || null;

  if (autoTitle) return autoTitle;
  if (projName && firstMsg) return `${projName} — ${firstMsg.slice(0, 25)}`;
  if (projName) return projName;
  if (firstMsg && firstMsg.length > 3) return firstMsg.slice(0, 35);
  if (n.purposeLabel && n.purposeLabel !== n.type && n.purposeLabel !== '기타')
    return n.purposeLabel;
  return _mwNormCat(n.domain || n.type || '기타');
}

/**
 * 그룹 카드 색상 결정
 * null 반환 시 → 호출부에서 _mwExtractColor(n.color) 폴백
 */
function mwGroupColor(n) {
  return n.purposeColor
    || _MW_CAT_COLOR[_mwNormCat(n.domain || n.type || '')]
    || null;
}

/**
 * 1단계 자식 카드 텍스트 결정
 * 우선순위: purposeLabel > proj+msg > label 가공(JSON 필터) > normCat
 */
function mwChildTopic(n) {
  // 1) AI 분류된 목적 라벨
  if (n.purposeLabel && n.purposeLabel !== n.type) return n.purposeLabel;

  // 2) 프로젝트명 + 첫 메시지
  const proj = n.projectName || n.project || n.repo || '';
  const msg  = n.firstMsg || n.msgPreview || n.autoTitle || '';
  if (proj && msg) return `${proj} — ${msg.slice(0, 30)}`;
  if (proj) return proj;
  if (msg && msg.length > 3) return msg.slice(0, 40);

  // 3) label 가공 — 추상 라벨이면 fullContent 사용
  const rawLabel = n.label || n.topic || n.name || '';
  const stripped = (typeof normalizeLabel === 'function') ? normalizeLabel(rawLabel) : rawLabel.replace(_EMOJI_PREFIX_RE, '').trim();
  if (rawLabel.includes(': ')) return rawLabel.split(': ').slice(1).join(': ');
  if ((typeof isInAbstractSet === 'function') ? isInAbstractSet(stripped) : ABSTRACT_LABEL_SET.has(stripped.toLowerCase())) {
    const fc = String(n.fullContent || n.detail || n.description || n.summary || '')
      .replace(/[{}"\\]/g, ' ').replace(/\s+/g, ' ').trim();
    // JSON key:value 패턴 → 의미없는 데이터 스킵
    const isJsonGarbage = /^\s*(type|category|timestamp|id)\s*:/i.test(fc);
    if (fc.length > 3 && !isJsonGarbage) return fc.slice(0, 40);
  }
  if (rawLabel.length > 2) return rawLabel;

  // 4) 최종 fallback
  return _mwNormCat(n.type || '작업');
}

/**
 * 카드 sub2 텍스트 결정 (latestActivity 정규화)
 * raw 값(idle 등) → 한국어 변환 후 반환
 */
function mwLatestActivity(rawAct) {
  if (!rawAct) return '';
  const la = String(rawAct);
  const normalized = _mwNormCat(la);
  return (normalized !== la ? normalized : la).slice(0, 38);
}
