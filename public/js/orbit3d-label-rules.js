/* orbit3d-label-rules.js — Label determination rules (single source of truth)
 *
 * All label-related logic centralized here:
 *   - ABSTRACT_PATTERNS: regex patterns for abstract/generic labels
 *   - ABSTRACT_SET: set of known abstract label strings
 *   - isAbstractLabel(text): returns boolean
 *   - isMeaningfulLabel(text): returns boolean (non-junk, non-generic)
 *   - normalizeLabel(raw): strip emoji prefixes, bracket prefixes, trim
 *   - deriveDisplayLabel(userData, maxLen): pick best label from userData fields
 *   - DOMAIN_SHORT: domain key → short Korean label (fallback map)
 *
 * Any future "wrong label" bugs should only need changes in THIS file.
 */

// ─── Abstract label regex ────────────────────────────────────────────────────
// Matches labels that are generic category names with no specific information.
// Includes Korean abstract categories AND English event-type tokens.
const ABSTRACT_LABEL_RE = /^(기능\s*구현|버그\s*수정|코드\s*정리|테스트|배포[\s/]?운영|배포|조사[\s/]분석|설정[\s/]?환경|설정|검토[\s/]?리뷰|검토|논의[\s/]?질문|논의|기타|작업|명령\s*실행|파일\s*읽기|파일\s*수정|파일\s*작성|파일\s*탐색|파일\s*생성|코드\s*검색|웹\s*검색|웹\s*조회|하위\s*에이전트|에이전트\s*완료|할일\s*업데이트|사용자\s*질문|계획\s*수립\s*중|계획\s*확정|노트북\s*수정|시작|종료|세션|시간|유형|도메인|Tool|User|Assistant|Subagent|Event|File|Working|Notify|Done|Note|Bookmark)$/;

// Matches abstract categories WITH optional leading emoji (for core.js context updates)
const ABSTRACT_CAT_RE = /^[🛠🔧♻️🧪🚀🔍⚙️👁💬📌]?\s*(기능\s*구현|버그\s*수정|코드\s*정리|테스트|배포[\s/]운영|조사[\s/]분석|설정[\s/]환경|검토[\s/]리뷰|논의[\s/]질문|기타|작업)$/;

// ─── Abstract label set (from mw-label.js — for fast lookup) ─────────────────
// These are labels that should be replaced with fullContent when possible.
// Kept in sync with _MW_ABSTRACT_SET in mw-label.js.
const ABSTRACT_LABEL_SET = new Set([
  '명령 실행','파일 읽기','파일 수정','파일 작성','파일 탐색','파일 생성',
  '코드 검색','웹 검색','하위 에이전트','에이전트 완료','작업','기타',
  'idle','code','file','browser','terminal','design','document',
  'meeting','test','deploy','research','planning','other','etc',
]);

// ─── "Meaningful" test — rejects session/junk patterns ───────────────────────
const _JUNK_LABEL_RE = /^(세션\s|⚙️\s?작업\s?중|작업\s?중|\[.*\]\s*$)/;

// ─── Emoji prefix strip regex ────────────────────────────────────────────────
// Strips leading emoji (broad Unicode ranges + specific compound emoji)
const _EMOJI_PREFIX_RE = /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}⚙️🔐🌐🗄🎨🧪🚀🐳📝📐🔧🌿💬]\s*/gu;

// ─── Domain → short Korean label (final fallback) ────────────────────────────
const DOMAIN_SHORT = {
  auth:'인증', api:'API', data:'데이터', ui:'UI', test:'테스트',
  server:'서버', infra:'인프라', fix:'수정', git:'Git', chat:'대화',
  general:'작업', docs:'문서', design:'설계',
};

// ═══════════════════════════════════════════════════════════════════════════════
// Public functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Is this label abstract / generic (conveys no specific information)?
 * Use for planet labels, session labels, layout text etc.
 * @param {string} text — already stripped of emoji/bracket prefixes
 * @returns {boolean}
 */
function isAbstractLabel(text) {
  if (!text) return true;
  return ABSTRACT_LABEL_RE.test(text);
}

/**
 * Is this label an abstract *category* (with optional leading emoji)?
 * Specifically for purpose-classifier output like "🔧 버그 수정".
 * @param {string} text — raw, may start with emoji
 * @returns {boolean}
 */
function isAbstractCategory(text) {
  if (!text) return true;
  return ABSTRACT_CAT_RE.test((text || '').trim());
}

/**
 * Is this text in the abstract label set?
 * Fast O(1) lookup for known abstract strings (mw-label compatible).
 * @param {string} text — lowercased, stripped
 * @returns {boolean}
 */
function isInAbstractSet(text) {
  if (!text) return true;
  return ABSTRACT_LABEL_SET.has(text.toLowerCase());
}

/**
 * Is this label "meaningful" — i.e. NOT a junk/session placeholder?
 * @param {string} text
 * @returns {boolean}
 */
function isMeaningfulLabel(text) {
  if (!text) return false;
  return !_JUNK_LABEL_RE.test(text);
}

/**
 * Normalize a raw label string:
 *  1. Strip leading emoji prefix
 *  2. Strip [bracket prefix]
 *  3. Trim whitespace
 *  4. Truncate to maxLen
 * @param {string} raw
 * @param {number} [maxLen=24]
 * @returns {string}
 */
function normalizeLabel(raw, maxLen) {
  if (!raw) return '';
  if (typeof maxLen !== 'number') maxLen = 24;
  let t = raw.replace(_EMOJI_PREFIX_RE, '').trim();
  if (/^\[.+?\]\s+/.test(t)) t = t.replace(/^\[.+?\]\s+/, '');
  if (t.length > maxLen) t = t.slice(0, maxLen - 1) + '\u2026';
  return t;
}

/**
 * Derive the best display label from a planet/node's userData fields.
 *
 * Priority (matches the repeated pattern across layout.js, core.js, camera.js):
 *  1. intent (already computed)  — normalized, abstract-checked
 *  2. firstMsg / msgPreview      — actual user input
 *  3. projectName (if not '기타')
 *  4. DOMAIN_SHORT[domain]       — final fallback
 *
 * @param {object} ud — userData object (planet.userData or similar)
 * @param {number} [maxLen=26] — max characters
 * @returns {string}
 */
function deriveDisplayLabel(ud, maxLen) {
  if (!ud) return '\u2014';
  if (typeof maxLen !== 'number') maxLen = 26;

  // 1) Start from intent
  let text = '';
  if (ud.intent) {
    text = normalizeLabel(ud.intent, maxLen);
  }

  // 2) Abstract check — fall back to firstMsg/msgPreview
  if (!text || isAbstractLabel(text)) {
    const specific = (ud.firstMsg || ud.msgPreview || '').replace(/[\n\r]/g, ' ').trim();
    if (specific.length > 3) text = specific.slice(0, maxLen);
  }

  // 3) Additional fallbacks
  if (!text && ud.msgPreview) text = ud.msgPreview.slice(0, maxLen);
  if (!text && ud.firstMsg)   text = ud.firstMsg.slice(0, maxLen);
  if (!text && ud.projectName && ud.projectName !== '기타') text = ud.projectName.slice(0, Math.min(maxLen, 16));

  // 4) Domain fallback
  if (!text) text = DOMAIN_SHORT[ud.domain] || '\u2014';

  return text;
}

/**
 * Derive the best specific label for session context updates (core.js).
 *
 * Priority:
 *  1. firstMsg (length > 4) — most specific
 *  2. autoTitle (meaningful + not abstract category)
 *  3. null — caller falls back to aiLabel/autoTitle
 *
 * @param {object} ctx — session context { firstMsg, autoTitle, aiLabel, ... }
 * @returns {string|null}
 */
function deriveContextLabel(ctx) {
  if (!ctx) return null;
  if (ctx.firstMsg && ctx.firstMsg.length > 4) {
    return ctx.firstMsg.slice(0, 42).trim();
  }
  if (isMeaningfulLabel(ctx.autoTitle) && !isAbstractCategory(ctx.autoTitle)) {
    return ctx.autoTitle;
  }
  return null;
}
