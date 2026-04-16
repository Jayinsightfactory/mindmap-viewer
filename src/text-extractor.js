'use strict';

// ─── 상수 정의 ────────────────────────────────────────────────────────────────

const PRODUCT_KEYWORDS = [
  '카네이션', '장미', '레몬잎', '안개', '거베라', '튤립', '백합', '국화', '수국',
];

const QTY_PATTERN = /(\d+)\s*(박스|개|단|속|다발|kg|묶음|Box)/gi;

const DATE_PATTERN = /\d{1,2}월\s*\d{1,2}일|오늘|내일|모레/g;

const INTENT_KEYWORDS = {
  order:    ['주문', '발주', '추가', '더', '필요', '요청'],
  cancel:   ['취소', '반품', '안 함'],
  confirm:  ['확인', '맞죠', '맞나요', '되나요', '가능'],
  change:   ['변경', '수정', '바꿔'],
  delivery: ['출고', '배송', '보내', '받았', '도착'],
  stock:    ['재고', '있나요', '있어요', '남은'],
};

// Excel 업무도메인 키워드
const EXCEL_DOMAIN_KEYWORDS = {
  '재고관리': ['재고', '입고', '출고', '재고량', '수량'],
  '영업':     ['영업', '판매', '거래처', '견적', '수주'],
  '구매':     ['구매', '구입', '발주서', '공급', '단가'],
  '발주':     ['발주', '주문서', '발주량'],
  '매출':     ['매출', '수익', '실적', '달성', '목표'],
  '정산':     ['정산', '세금계산서', '청구', '입금', '미수'],
  '문서작업': [],  // 위 키워드 없을 때 기본값
};

// 브라우저 도메인 분류
const BROWSER_DOMAIN_RULES = [
  { keywords: ['holex', 'nenova'],  domain: 'nenova_system' },
  { keywords: ['naver.com', 'naver'], domain: '네이버' },
  { keywords: ['gmail.com', 'mail.google'], domain: 'Gmail' },
  { keywords: ['youtube.com', 'youtu.be'], domain: 'YouTube' },
  { keywords: ['orbit'],             domain: 'Orbit' },
  { keywords: ['kakao'],             domain: '카카오' },
  { keywords: [
    'kbank', 'kakaobank', 'shinhan', 'hana', 'woori', 'kb.co', 'nonghyup',
    'ibk', 'bank',
  ], domain: '은행' },
];

// ─── 헬퍼 함수 ────────────────────────────────────────────────────────────────

/** 텍스트에서 제품 키워드 추출 */
function extractProducts(text) {
  if (!text) return [];
  return PRODUCT_KEYWORDS.filter((p) => text.includes(p));
}

/** 텍스트에서 수량 추출 */
function extractQuantities(text) {
  if (!text) return [];
  const results = [];
  let m;
  const re = new RegExp(QTY_PATTERN.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    results.push({ qty: parseInt(m[1], 10), unit: m[2] });
  }
  return results;
}

/** 텍스트에서 날짜 추출 */
function extractDates(text) {
  if (!text) return [];
  const matches = text.match(DATE_PATTERN);
  return matches ? [...new Set(matches.map((d) => d.replace(/\s/g, '')))] : [];
}

/** 의도 분류 (우선순위: 앞에서부터 첫 매치) */
function detectIntent(text) {
  if (!text) return 'communicate';
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (keywords.some((kw) => text.includes(kw))) return intent;
  }
  return 'communicate';
}

/** 이름 추출 — 한국 인명 패턴 (성 1자 + 이름 1~2자) */
function extractNames(text) {
  if (!text) return [];
  const nameRe = /[가-힣]{1}[가-힣]{1,2}(?=\s|님|씨|$)/g;
  const raw = text.match(nameRe) || [];
  // 제품 키워드와 겹치는 것 제거
  return [...new Set(raw.filter((n) => !PRODUCT_KEYWORDS.includes(n)))];
}

/** Excel 업무도메인 결정 */
function detectExcelDomain(combinedText) {
  for (const [domain, keywords] of Object.entries(EXCEL_DOMAIN_KEYWORDS)) {
    if (keywords.length === 0) continue;
    if (keywords.some((kw) => combinedText.includes(kw))) return domain;
  }
  return '문서작업';
}

/** URL/windowTitle 에서 브라우저 도메인 분류 */
function classifyBrowserDomain(windowTitle, url) {
  const haystack = ((windowTitle || '') + ' ' + (url || '')).toLowerCase();
  for (const rule of BROWSER_DOMAIN_RULES) {
    if (rule.keywords.some((kw) => haystack.includes(kw))) return rule.domain;
  }
  return null;
}

/** 텍스트 200자 제한 */
function truncate(text, len = 200) {
  if (!text) return null;
  return text.length > len ? text.slice(0, len) : text;
}

/** null/빈 값 필드 제거 */
function stripNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

// ─── 앱 타입 감지 ─────────────────────────────────────────────────────────────

function detectAppType(event) {
  const app = (event.data && event.data.app) || event.app || '';
  const title = (event.data && event.data.windowTitle) || event.windowTitle || '';
  const combined = (app + ' ' + title).toLowerCase();

  if (combined.includes('kakaotalk') || combined.includes('카카오톡')) return 'kakao';
  if (combined.includes('whatsapp')) return 'whatsapp';
  if (
    combined.includes('excel') ||
    combined.includes('xlsx') ||
    combined.includes('microsoft excel')
  ) return 'excel';
  if (
    combined.includes('chrome') ||
    combined.includes('edge') ||
    combined.includes('firefox') ||
    combined.includes('msedge')
  ) return 'browser';
  return 'general';
}

// ─── 앱별 파서 ────────────────────────────────────────────────────────────────

function parseKakao(event) {
  const data    = event.data || {};
  const title   = data.windowTitle || event.windowTitle || null;
  const text    = data.text || data.inputText || event.text || '';

  return stripNulls({
    app_type:   'kakao',
    room:       title || null,
    contact:    null,
    intent:     detectIntent(text),
    products:   extractProducts(text),
    quantities: extractQuantities(text),
    dates:      extractDates(text),
    names:      extractNames(text),
    inputText:  truncate(text),
  });
}

function parseWhatsApp(event) {
  const data    = event.data || {};
  const title   = data.windowTitle || event.windowTitle || null;
  const text    = data.text || data.inputText || event.text || '';

  // WhatsApp 윈도우 타이틀: "연락처명 - WhatsApp" 형태가 많음
  let contact = null;
  if (title) {
    const m = title.match(/^(.+?)\s*[-–|]/);
    if (m) contact = m[1].trim();
  }

  return stripNulls({
    app_type:   'whatsapp',
    contact:    contact,
    intent:     detectIntent(text),
    products:   extractProducts(text),
    quantities: extractQuantities(text),
    dates:      extractDates(text),
    names:      extractNames(text),
    inputText:  truncate(text),
  });
}

function parseExcel(event) {
  const data = event.data || {};

  // app 또는 windowTitle이 JSON 형태일 수 있음
  let excelMeta = null;
  for (const candidate of [data.app, data.windowTitle, event.app, event.windowTitle]) {
    if (!candidate) continue;
    if (typeof candidate === 'object') {
      excelMeta = candidate;
      break;
    }
    if (typeof candidate === 'string' && candidate.trimStart().startsWith('{')) {
      try {
        excelMeta = JSON.parse(candidate);
        break;
      } catch (_) { /* 파싱 실패 — 무시 */ }
    }
  }

  const sheet    = excelMeta && excelMeta.sheet    ? excelMeta.sheet    : null;
  const cell     = excelMeta && excelMeta.cell     ? excelMeta.cell     : null;
  const workbook = excelMeta && excelMeta.workbook ? excelMeta.workbook : null;
  const cellValue = excelMeta && excelMeta.value   ? String(excelMeta.value) : '';

  const text = data.text || data.inputText || event.text || cellValue || '';
  const combinedForDomain = [
    sheet || '', workbook || '', text, cellValue,
  ].join(' ');

  return stripNulls({
    app_type:   'excel',
    domain:     detectExcelDomain(combinedForDomain),
    workbook:   workbook,
    sheet:      sheet,
    cell:       cell,
    products:   extractProducts(combinedForDomain),
    quantities: extractQuantities(combinedForDomain),
    dates:      extractDates(combinedForDomain),
    inputText:  truncate(text || cellValue),
  });
}

function parseBrowser(event) {
  const data  = event.data || {};
  const title = data.windowTitle || event.windowTitle || null;
  const url   = data.url   || event.url   || null;
  const text  = data.text  || data.inputText || event.text || '';

  return stripNulls({
    app_type:  'browser',
    domain:    classifyBrowserDomain(title, url) || null,
    inputText: truncate(text || title),
  });
}

function parseGeneral(event) {
  const data  = event.data || {};
  const title = data.windowTitle || event.windowTitle || null;
  const text  = data.text || data.inputText || event.text || '';
  const combined = [title, text].filter(Boolean).join(' ');

  return stripNulls({
    app_type:  'general',
    inputText: truncate(combined),
  });
}

// ─── 메인 함수 ────────────────────────────────────────────────────────────────

/**
 * 단일 keyboard.chunk 이벤트를 구조화
 * @param {object} event
 * @returns {{ structured: object }|null}
 */
function extract(event) {
  if (!event) return null;

  // 텍스트 가져오기 (2자 미만이면 null)
  const data   = event.data || {};
  const rawText = data.text || data.inputText || event.text || '';
  if (rawText && rawText.length < 2) return null;

  const appType = detectAppType(event);

  let structured;
  switch (appType) {
    case 'kakao':     structured = parseKakao(event);    break;
    case 'whatsapp':  structured = parseWhatsApp(event); break;
    case 'excel':     structured = parseExcel(event);    break;
    case 'browser':   structured = parseBrowser(event);  break;
    default:          structured = parseGeneral(event);  break;
  }

  return { structured };
}

/**
 * 여러 이벤트를 일괄 처리
 * @param {object[]} events
 * @returns {{ structured: object }[]}
 */
function extractBatch(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map((e) => extract(e))
    .filter((r) => r !== null);
}

// ─── Export ───────────────────────────────────────────────────────────────────

module.exports = { extract, extractBatch };
