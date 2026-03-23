'use strict';
/**
 * routes/activity-classifier.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 활동 분류 엔진 — raw window title 이벤트를 목적 기반 활동 설명으로 변환
 *
 * 원시 타이틀:  "네노바 - 김선희"
 * 변환 결과:    "[업무-거래처] 김선희 거래처 대화"
 *
 * 분류 규칙:
 *   1. KakaoTalk  — 거래처방(master_customers 매칭) / 내부방 / 개인
 *   2. Excel      — 파일명 패턴 (물량표/차감/발주/매출/견적/출고)
 *   3. 화훼관리   — nenova 전산 프로그램 화면별 분류
 *   4. Browser    — Holex/네이버/AI/Orbit 등
 *   5. 기타 앱    — 메모장/탐색기/캡처/PowerShell
 *
 * NO 외부 API 호출 — 모든 분류는 학습/캐시 데이터 기반
 *
 * 엔드포인트:
 *   GET  /api/activity/classify          — 최근 이벤트 분류
 *   GET  /api/activity/summary/:userId   — 직원별 활동 요약
 *   GET  /api/activity/timeline/:userId  — 시간순 분류 타임라인
 *   GET  /api/activity/sessions          — 세션 단위 활동
 *   GET  /api/activity/purposes          — 목적별 집계
 *   GET  /api/activity/flow/:userId      — 활동 흐름도
 *   POST /api/activity/learn             — 새 분류 규칙 학습
 *   GET  /api/activity/rules             — 현재 분류 규칙 목록
 *   GET  /api/activity/unknown           — 미분류 활동 목록
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// 고객명 캐시 (master_customers에서 로드, 1시간마다 갱신)
// ═══════════════════════════════════════════════════════════════════════════

let _customerNames = [];
let _customerCacheTs = 0;
const CUSTOMER_CACHE_TTL = 60 * 60 * 1000; // 1시간

async function loadCustomerNames(db) {
  if (!db?.query) return;
  try {
    const result = await db.query('SELECT name FROM master_customers ORDER BY name');
    _customerNames = result.rows.map(r => r.name).filter(Boolean);
    _customerCacheTs = Date.now();
    console.log(`[activity-classifier] 고객명 ${_customerNames.length}개 로드 완료`);
  } catch (e) {
    console.warn('[activity-classifier] master_customers 로드 실패:', e.message);
  }
}

async function ensureCustomerCache(db) {
  if (Date.now() - _customerCacheTs > CUSTOMER_CACHE_TTL || _customerNames.length === 0) {
    await loadCustomerNames(db);
  }
}

function matchCustomer(text) {
  if (!text) return null;
  for (const name of _customerNames) {
    if (text.includes(name)) return name;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 사용자 정의 분류 규칙 캐시 (DB에서 로드)
// ═══════════════════════════════════════════════════════════════════════════

let _customRules = [];
let _rulesCacheTs = 0;
const RULES_CACHE_TTL = 30 * 60 * 1000; // 30분

async function loadCustomRules(db) {
  if (!db?.query) return;
  try {
    // 테이블 없으면 무시
    const result = await db.query(
      'SELECT * FROM activity_rules WHERE active = true ORDER BY priority DESC'
    );
    _customRules = result.rows || [];
    _rulesCacheTs = Date.now();
  } catch {
    // 테이블 미존재 시 무시
    _customRules = [];
  }
}

async function ensureRulesCache(db) {
  if (Date.now() - _rulesCacheTs > RULES_CACHE_TTL) {
    await loadCustomRules(db);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 앱 감지 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function isKakaoTalk(app, windowTitle) {
  const a = (app || '').toLowerCase();
  const t = (windowTitle || '').toLowerCase();
  return a.includes('kakaotalk') || a.includes('카카오톡') ||
    t.includes('카카오톡') || (a === 'kakaotalk.exe');
}

function isExcel(app, windowTitle) {
  const a = (app || '').toLowerCase();
  const t = (windowTitle || '').toLowerCase();
  return a.includes('excel') || a.includes('et.exe') ||
    t.includes('excel') || t.includes('.xlsx') || t.includes('.xls') || t.includes('.csv');
}

function isNenova(app, windowTitle) {
  const a = (app || '').toLowerCase();
  const t = (windowTitle || '');
  return a.includes('nenova') || a.includes('네노바') || a.includes('hwahwe') ||
    t.includes('화훼 관리 프로그램') || t.includes('화훼관리') ||
    (a.includes('nenova') && (
      t.includes('주문') || t.includes('출고') || t.includes('재고') ||
      t.includes('거래처') || t.includes('발주') || t.includes('입고') ||
      t.includes('견적') || t.includes('Pivot') || t.includes('피벗')
    ));
}

function isBrowser(app) {
  const a = (app || '').toLowerCase();
  return a.includes('chrome') || a.includes('firefox') || a.includes('edge') ||
    a.includes('whale') || a.includes('safari') || a.includes('opera') ||
    a.includes('brave') || a.includes('msedge') || a.includes('iexplore');
}

// ═══════════════════════════════════════════════════════════════════════════
// 내부방 패턴 매칭
// ═══════════════════════════════════════════════════════════════════════════

const INTERNAL_CHATROOMS = [
  { pattern: '네노바 영업', purpose: '영업', label: '[업무-영업] 영업팀 내부 소통' },
  { pattern: '네노바 수입부', purpose: '수입', label: '[업무-수입] 수입부 내부 소통' },
  { pattern: '네노바 불량 공유방', purpose: '불량', label: '[업무-불량] 불량 공유 및 보고' },
  { pattern: '네노바 불량공유방', purpose: '불량', label: '[업무-불량] 불량 공유 및 보고' },
  { pattern: '네노바 수입방', purpose: '수입', label: '[업무-수입] 수입 업무 소통' },
  { pattern: '네노바 전체', purpose: '내부소통', label: '[업무-내부] 전체 공지 소통' },
  { pattern: '네노바 물류', purpose: '물류', label: '[업무-물류] 물류팀 내부 소통' },
  { pattern: '네노바 경영', purpose: '경영', label: '[업무-경영] 경영진 소통' },
  { pattern: '네노바 관리', purpose: '관리', label: '[업무-관리] 관리팀 내부 소통' },
];

// 개인 대화 힌트 (이 패턴이 있으면 확실히 개인)
const PERSONAL_PATTERNS = [
  /♡/, /♥/, /❤/, /사랑/, /^엄마$/, /^아빠$/, /^아내$/, /^남편$/,
  /^친구/, /동창/, /모임/, /가족/,
];

// ═══════════════════════════════════════════════════════════════════════════
// 분류 함수들
// ═══════════════════════════════════════════════════════════════════════════

/**
 * KakaoTalk 분류
 */
function classifyKakao(windowTitle) {
  const title = (windowTitle || '').trim();

  // 1. 내부방 매칭
  for (const room of INTERNAL_CHATROOMS) {
    if (title.includes(room.pattern)) {
      return {
        category: '업무',
        purpose: room.purpose,
        label: room.label,
        app: 'kakaotalk',
        detail: { roomType: '내부방', roomName: room.pattern },
        confidence: 0.95,
      };
    }
  }

  // 2. 거래처 매칭 (master_customers)
  const customer = matchCustomer(title);
  if (customer) {
    return {
      category: '업무',
      purpose: '거래처소통',
      label: `[업무-거래처] ${customer} 거래처 대화`,
      app: 'kakaotalk',
      detail: { roomType: '거래처방', customer },
      confidence: 0.90,
    };
  }

  // 3. "네노바" 키워드 포함 = 업무 관련
  if (title.includes('네노바') || title.includes('nenova')) {
    return {
      category: '업무',
      purpose: '내부소통',
      label: `[업무-내부] 카톡 '${title}' 소통`,
      app: 'kakaotalk',
      detail: { roomType: '내부방', roomName: title },
      confidence: 0.80,
    };
  }

  // 4. 개인 대화 판별
  const isPersonal = PERSONAL_PATTERNS.some(p => p.test(title));
  if (isPersonal) {
    return {
      category: '개인',
      purpose: '개인대화',
      label: '[개인] 사생활 (내용 비공개)',
      app: 'kakaotalk',
      detail: { roomType: '개인' },
      confidence: 0.95,
    };
  }

  // 5. 단순 이름 (XX - 이름) 형태 → 업무 가능성도 있지만 기본 개인
  //    다만 "네노바 - 이름" 패턴은 위에서 이미 처리됨
  const nameMatch = title.match(/^(.+?)\s*-\s*(.+)$/);
  if (nameMatch) {
    // 제목에 회사/업무 키워드 확인
    const fullText = nameMatch[1] + nameMatch[2];
    const customer2 = matchCustomer(fullText);
    if (customer2) {
      return {
        category: '업무',
        purpose: '거래처소통',
        label: `[업무-거래처] ${customer2} 거래처 대화`,
        app: 'kakaotalk',
        detail: { roomType: '거래처방', customer: customer2 },
        confidence: 0.85,
      };
    }
  }

  // 6. 기본: 개인
  return {
    category: '개인',
    purpose: '개인대화',
    label: '[개인] 사생활 (내용 비공개)',
    app: 'kakaotalk',
    detail: { roomType: '개인' },
    confidence: 0.70,
  };
}

/**
 * Excel 분류
 */
function classifyExcel(windowTitle) {
  const title = (windowTitle || '').trim();

  // 차수 추출 (예: "26년", "12차", "1차")
  const roundMatch = title.match(/(\d+[차년])/);
  const round = roundMatch ? roundMatch[1] : '';

  // 국가 추출
  const countryMatch = title.match(/(에콰도르|콜롬비아|케냐|에티오피아|네덜란드|중국|일본|인도|태국|베트남)/);
  const country = countryMatch ? countryMatch[1] : '';

  // 물량표
  if (title.includes('물량표') || title.includes('물량')) {
    const parts = [round, country, '물량표 작업'].filter(Boolean);
    return {
      category: '업무',
      purpose: '물량표',
      label: `[업무-물량] ${parts.join(' ')}`,
      app: 'excel',
      detail: { fileType: '물량표', round, country },
      confidence: 0.90,
    };
  }

  // 차감
  if (title.includes('차감내역') || title.includes('차감')) {
    const parts = [round, '차감 대조'].filter(Boolean);
    return {
      category: '업무',
      purpose: '차감대조',
      label: `[업무-차감] ${parts.join(' ')}`,
      app: 'excel',
      detail: { fileType: '차감', round },
      confidence: 0.90,
    };
  }

  // 발주
  if (title.includes('발주서') || title.includes('발주')) {
    const customer = matchCustomer(title);
    const target = customer || country || '';
    const parts = [target, '발주서 작업'].filter(Boolean);
    return {
      category: '업무',
      purpose: '발주',
      label: `[업무-발주] ${parts.join(' ')}`,
      app: 'excel',
      detail: { fileType: '발주', customer, country },
      confidence: 0.90,
    };
  }

  // 매출
  if (title.includes('매출보고') || title.includes('매출마감') || title.includes('매출')) {
    return {
      category: '업무',
      purpose: '매출',
      label: '[업무-매출] 매출 보고서/마감',
      app: 'excel',
      detail: { fileType: '매출' },
      confidence: 0.90,
    };
  }

  // 견적
  if (title.includes('견적서') || title.includes('견적')) {
    return {
      category: '업무',
      purpose: '견적',
      label: '[업무-견적] 견적서 작업',
      app: 'excel',
      detail: { fileType: '견적' },
      confidence: 0.90,
    };
  }

  // 출고
  if (title.includes('출고내역') || title.includes('출고')) {
    return {
      category: '업무',
      purpose: '출고',
      label: '[업무-출고] 출고 내역 관리',
      app: 'excel',
      detail: { fileType: '출고' },
      confidence: 0.90,
    };
  }

  // 거래처명 매칭
  const customer = matchCustomer(title);
  if (customer) {
    return {
      category: '업무',
      purpose: '거래처문서',
      label: `[업무-거래처] ${customer} Excel 작업`,
      app: 'excel',
      detail: { fileType: '거래처', customer },
      confidence: 0.85,
    };
  }

  // 기본 Excel
  // 파일명 추출 시도
  const fileMatch = title.match(/(.+?)\s*[-–—]\s*(Microsoft\s*)?Excel/i) ||
                    title.match(/(.+?)\s*[-–—]\s*Excel/i);
  const fileName = fileMatch ? fileMatch[1].trim() : '';

  return {
    category: '업무',
    purpose: '문서작업',
    label: fileName ? `[업무-문서] Excel '${fileName}' 작업` : '[업무-문서] Excel 작업',
    app: 'excel',
    detail: { fileType: '기타', fileName },
    confidence: 0.70,
  };
}

/**
 * 화훼관리 프로그램 (nenova) 분류
 */
function classifyNenova(windowTitle) {
  const title = (windowTitle || '').trim();

  const NENOVA_SCREENS = [
    { patterns: ['신규 주문 등록', '신규주문등록'], purpose: '주문입력', label: '[업무-주문입력] 신규 주문 등록 중' },
    { patterns: ['주문 관리', '주문관리'], purpose: '주문관리', label: '[업무-주문관리] 주문 조회/수정' },
    { patterns: ['출고분배', '출고 분배'], purpose: '출고', label: '[업무-출고] 출고 분배 작업' },
    { patterns: ['출고조회', '출고내역조회', '출고 조회', '출고내역 조회'], purpose: '출고', label: '[업무-출고] 출고 내역 확인' },
    { patterns: ['재고관리', '재고 관리'], purpose: '재고', label: '[업무-재고] 재고 현황 확인' },
    { patterns: ['거래처관리', '거래처 관리'], purpose: '거래처', label: '[업무-거래처] 거래처 정보 관리' },
    { patterns: ['Pivot', '피벗', 'pivot'], purpose: '분석', label: '[업무-분석] 피벗 통계 조회' },
    { patterns: ['발주관리', '발주 관리'], purpose: '발주', label: '[업무-발주] 발주 관리' },
    { patterns: ['입고관리', '입고 관리'], purpose: '입고', label: '[업무-입고] 입고 처리' },
    { patterns: ['견적서관리', '견적서 관리'], purpose: '견적', label: '[업무-견적] 견적서 관리' },
  ];

  for (const screen of NENOVA_SCREENS) {
    if (screen.patterns.some(p => title.includes(p))) {
      return {
        category: '업무',
        purpose: screen.purpose,
        label: screen.label,
        app: 'nenova',
        detail: { screen: screen.patterns[0] },
        confidence: 0.95,
      };
    }
  }

  // 메인 화면
  if (title.includes('화훼 관리 프로그램') || title.includes('화훼관리')) {
    return {
      category: '업무',
      purpose: '전산',
      label: '[업무-전산] 화훼 관리 프로그램 메인',
      app: 'nenova',
      detail: { screen: 'main' },
      confidence: 0.90,
    };
  }

  // nenova 기타 화면
  return {
    category: '업무',
    purpose: '전산',
    label: `[업무-전산] nenova '${title}'`,
    app: 'nenova',
    detail: { screen: title },
    confidence: 0.75,
  };
}

/**
 * Browser 분류
 */
function classifyBrowser(windowTitle) {
  const title = (windowTitle || '').trim();
  const titleLow = title.toLowerCase();

  // Holex / 꽃 검색
  if (titleLow.includes('holex') || titleLow.includes('flowerportal') ||
      title.includes('꽃') || title.includes('품종') || title.includes('절화') ||
      title.includes('장미') || title.includes('카네이션') || title.includes('국화') ||
      titleLow.includes('flower')) {
    return {
      category: '업무',
      purpose: '검색',
      label: '[업무-검색] 꽃/품종 검색',
      app: 'browser',
      detail: { searchType: '꽃검색', query: title },
      confidence: 0.85,
    };
  }

  // 네이버 상품 검색
  if (title.includes('네이버') && (title.includes('상품') || title.includes('쇼핑') ||
      title.includes('가격') || title.includes('검색'))) {
    return {
      category: '업무',
      purpose: '검색',
      label: '[업무-검색] 상품 정보 검색',
      app: 'browser',
      detail: { searchType: '상품검색', query: title },
      confidence: 0.80,
    };
  }

  // AI 도구
  if (titleLow.includes('claude') || titleLow.includes('chatgpt') ||
      titleLow.includes('gemini') || titleLow.includes('perplexity') ||
      titleLow.includes('copilot') || title.includes('AI')) {
    return {
      category: '업무',
      purpose: 'AI활용',
      label: '[업무-AI] AI 도구 활용',
      app: 'browser',
      detail: { tool: title },
      confidence: 0.85,
    };
  }

  // Orbit AI
  if (titleLow.includes('orbit') || titleLow.includes('sparkling-determination')) {
    return {
      category: '업무',
      purpose: '관리',
      label: '[업무-관리] Orbit 대시보드 확인',
      app: 'browser',
      detail: { page: title },
      confidence: 0.90,
    };
  }

  // 은행/금융 (업무)
  if (title.includes('은행') || title.includes('뱅킹') || titleLow.includes('banking') ||
      title.includes('인터넷뱅킹')) {
    return {
      category: '업무',
      purpose: '금융',
      label: '[업무-금융] 은행/금융 업무',
      app: 'browser',
      detail: { type: '금융' },
      confidence: 0.80,
    };
  }

  // 이메일 (업무)
  if (titleLow.includes('gmail') || titleLow.includes('outlook') ||
      titleLow.includes('mail') || title.includes('메일')) {
    return {
      category: '업무',
      purpose: '메일',
      label: '[업무-메일] 이메일 확인',
      app: 'browser',
      detail: { type: '이메일' },
      confidence: 0.80,
    };
  }

  // 비업무 패턴
  const nonWorkPatterns = [
    /youtube/i, /넷플릭스/, /netflix/i, /tiktok/i, /instagram/i,
    /facebook/i, /twitter/i, /twitch/i, /게임/, /game/i,
    /나무위키/, /위키백과/, /namu\.wiki/i,
  ];
  if (nonWorkPatterns.some(p => p.test(title))) {
    return {
      category: '기타',
      purpose: '웹서핑',
      label: '[기타] 웹 브라우징',
      app: 'browser',
      detail: { type: '비업무', title },
      confidence: 0.75,
    };
  }

  // 기본: 업무 시간대면 업무로 추정
  return {
    category: '업무',
    purpose: '웹',
    label: '[업무-웹] 웹 브라우징',
    app: 'browser',
    detail: { title },
    confidence: 0.50,
  };
}

/**
 * 기타 앱 분류
 */
function classifyOther(app, windowTitle) {
  const appLow = (app || '').toLowerCase();
  const title = (windowTitle || '').trim();
  const titleLow = title.toLowerCase();

  // 메모장
  if (appLow.includes('notepad') || appLow.includes('메모장') || titleLow.includes('메모장')) {
    const workKeywords = ['주문', '발주', '견적', '메모', '출고', '거래처', '회의', '업무', '보고'];
    const isWork = workKeywords.some(k => title.includes(k));
    if (isWork) {
      return {
        category: '업무',
        purpose: '메모',
        label: '[업무-메모] 업무 메모',
        app: 'notepad',
        detail: { content: title },
        confidence: 0.80,
      };
    }
    return {
      category: '기타',
      purpose: '메모',
      label: '[기타] 메모장',
      app: 'notepad',
      detail: { content: title },
      confidence: 0.50,
    };
  }

  // 파일 탐색기
  if (appLow.includes('explorer') || appLow.includes('탐색기') ||
      titleLow.includes('파일 탐색기') || titleLow.includes('file explorer')) {
    return {
      category: '업무',
      purpose: '파일관리',
      label: '[업무-파일] 파일 관리',
      app: 'explorer',
      detail: { path: title },
      confidence: 0.70,
    };
  }

  // 캡처 도구
  if (appLow.includes('snipping') || appLow.includes('캡처') ||
      titleLow.includes('캡처 도구') || titleLow.includes('screenshot')) {
    return {
      category: '업무',
      purpose: '캡처',
      label: '[업무-캡처] 화면 캡처',
      app: 'capture',
      detail: {},
      confidence: 0.80,
    };
  }

  // PowerShell / cmd / 터미널
  if (appLow.includes('powershell') || appLow.includes('cmd') ||
      appLow.includes('terminal') || appLow.includes('windowsterminal')) {
    return {
      category: '업무',
      purpose: '시스템',
      label: '[업무-시스템] 시스템 작업',
      app: 'terminal',
      detail: { type: appLow },
      confidence: 0.75,
    };
  }

  // 한글/Word
  if (appLow.includes('hwp') || appLow.includes('한글') || appLow.includes('word') ||
      titleLow.includes('.hwp') || titleLow.includes('.docx')) {
    return {
      category: '업무',
      purpose: '문서작업',
      label: `[업무-문서] 문서 작업${title ? ` '${title}'` : ''}`,
      app: 'word',
      detail: { fileName: title },
      confidence: 0.75,
    };
  }

  // PDF
  if (appLow.includes('acrobat') || appLow.includes('pdf') ||
      titleLow.includes('.pdf')) {
    return {
      category: '업무',
      purpose: '문서확인',
      label: `[업무-문서] PDF 문서 확인`,
      app: 'pdf',
      detail: { fileName: title },
      confidence: 0.70,
    };
  }

  // 카카오톡이 아닌 메신저
  if (appLow.includes('slack') || appLow.includes('teams') || appLow.includes('discord')) {
    return {
      category: '업무',
      purpose: '소통',
      label: `[업무-소통] 메신저 소통`,
      app: 'messenger',
      detail: { messenger: app },
      confidence: 0.70,
    };
  }

  // idle 이벤트
  if (appLow === 'idle' || appLow === '' || titleLow.includes('잠금')) {
    return {
      category: '기타',
      purpose: '대기',
      label: '[기타] 대기/잠금',
      app: 'system',
      detail: { state: 'idle' },
      confidence: 0.95,
    };
  }

  // 기본: 미분류
  return {
    category: '기타',
    purpose: '미분류',
    label: `[기타] ${app || '알 수 없는 앱'}${title ? ' - ' + title : ''}`,
    app: app || 'unknown',
    detail: { rawApp: app, rawTitle: title },
    confidence: 0.30,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 핵심 분류 함수
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 이벤트 1개를 분류
 * @param {object} event - DB 이벤트 row
 * @returns {object} { category, purpose, label, app, detail, confidence }
 */
function classifyActivity(event) {
  const dataJson = event.data_json || event.data || {};
  const data = typeof dataJson === 'string' ? (() => { try { return JSON.parse(dataJson || '{}'); } catch { return {}; } })() : dataJson;

  // PG에서 직접 추출한 필드 우선 사용 (data_json JSONB 파싱 문제 방지)
  let windowTitle = event.window_title || data.windowTitle ||
    (data.appContext && data.appContext.currentWindow) || '';
  let app = event.app_name || data.app ||
    (data.appContext && data.appContext.currentApp) || '';
  const rawInput = event.raw_input || data.rawInput || data.summary || '';

  // 사용자 정의 규칙 우선 적용
  for (const rule of _customRules) {
    try {
      const pattern = new RegExp(rule.pattern, 'i');
      const target = rule.match_field === 'app' ? app : windowTitle;
      if (pattern.test(target)) {
        return {
          category: rule.category || '업무',
          purpose: rule.purpose || '학습',
          label: rule.label || `[${rule.category}-${rule.purpose}] ${windowTitle}`,
          app: rule.app_name || app,
          detail: { ruleId: rule.id, matched: target },
          confidence: parseFloat(rule.confidence) || 0.90,
        };
      }
    } catch { /* 정규식 오류 무시 */ }
  }

  // 1. KakaoTalk
  if (isKakaoTalk(app, windowTitle)) return classifyKakao(windowTitle);

  // 2. Excel
  if (isExcel(app, windowTitle)) return classifyExcel(windowTitle);

  // 3. 화훼 관리 프로그램 (nenova)
  if (isNenova(app, windowTitle)) return classifyNenova(windowTitle);

  // 4. Browser
  if (isBrowser(app)) return classifyBrowser(windowTitle);

  // 5. Other
  return classifyOther(app, windowTitle);
}

/**
 * 이벤트에 분류 결과 부착
 */
function annotateEvent(event) {
  const classification = classifyActivity(event);
  return {
    ...event,
    classification,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 세션 그루핑 — 연속된 같은 목적 이벤트를 하나로 묶기
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 분류된 이벤트 배열 → 세션 배열
 * 같은 purpose가 연속이면 하나의 세션으로 그룹핑
 * @param {Array} classifiedEvents - annotateEvent 적용 후 배열 (timestamp 순)
 * @param {number} gapThresholdMs - 이 시간 이상 차이나면 같은 purpose라도 세션 분리 (기본 30분)
 */
function groupIntoSessions(classifiedEvents, gapThresholdMs = 30 * 60 * 1000) {
  if (!classifiedEvents.length) return [];

  const sessions = [];
  let current = null;

  for (const ev of classifiedEvents) {
    const cls = ev.classification || {};
    const ts = new Date(ev.timestamp).getTime();

    if (!current) {
      current = {
        purpose: cls.purpose,
        category: cls.category,
        label: cls.label,
        app: cls.app,
        startTs: ts,
        endTs: ts,
        events: [ev],
        customers: new Set(),
      };
      if (cls.detail?.customer) current.customers.add(cls.detail.customer);
      continue;
    }

    const gap = ts - current.endTs;
    const samePurpose = cls.purpose === current.purpose && cls.app === current.app;

    if (samePurpose && gap < gapThresholdMs) {
      // 같은 세션에 추가
      current.endTs = ts;
      current.events.push(ev);
      if (cls.detail?.customer) current.customers.add(cls.detail.customer);
    } else {
      // 세션 종료, 새 세션 시작
      sessions.push(_finalizeSession(current));
      current = {
        purpose: cls.purpose,
        category: cls.category,
        label: cls.label,
        app: cls.app,
        startTs: ts,
        endTs: ts,
        events: [ev],
        customers: new Set(),
      };
      if (cls.detail?.customer) current.customers.add(cls.detail.customer);
    }
  }

  if (current) sessions.push(_finalizeSession(current));
  return sessions;
}

function _finalizeSession(session) {
  const durationMin = Math.max(1, Math.round((session.endTs - session.startTs) / 60000));
  const customerList = [...session.customers];
  const eventCount = session.events.length;

  // 세션 레이블 강화
  let sessionLabel = session.label;
  if (customerList.length > 0 && session.purpose === '주문입력') {
    sessionLabel = `[업무-주문입력] ${customerList.join(', ')} 외 주문 등록`;
  } else if (customerList.length > 0) {
    sessionLabel = `${session.label} (${customerList.join(', ')})`;
  }

  return {
    purpose: session.purpose,
    category: session.category,
    label: sessionLabel,
    app: session.app,
    startTime: new Date(session.startTs).toISOString(),
    endTime: new Date(session.endTs).toISOString(),
    durationMin,
    eventCount,
    customers: customerList,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 라우터 생성
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createActivityClassifierRouter({ getDb }) {
  const router = express.Router();

  function db() { return getDb(); }

  // ── 분류 규칙 테이블 초기화 ──────────────────────────────────────────────
  async function ensureRulesTable() {
    const d = db();
    if (!d?.query) return;
    try {
      await d.query(`
        CREATE TABLE IF NOT EXISTS activity_rules (
          id SERIAL PRIMARY KEY,
          pattern TEXT NOT NULL,
          match_field TEXT DEFAULT 'windowTitle',
          category TEXT NOT NULL DEFAULT '업무',
          purpose TEXT NOT NULL,
          label TEXT,
          app_name TEXT,
          confidence REAL DEFAULT 0.90,
          active BOOLEAN DEFAULT true,
          source TEXT DEFAULT 'manual',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
    } catch { /* 이미 존재 시 무시 */ }
  }

  // ── 미분류 활동 테이블 ──────────────────────────────────────────────────
  async function ensureUnknownTable() {
    const d = db();
    if (!d?.query) return;
    try {
      await d.query(`
        CREATE TABLE IF NOT EXISTS activity_unknown (
          id SERIAL PRIMARY KEY,
          app TEXT,
          window_title TEXT,
          occurrence_count INT DEFAULT 1,
          first_seen TIMESTAMPTZ DEFAULT NOW(),
          last_seen TIMESTAMPTZ DEFAULT NOW(),
          resolved BOOLEAN DEFAULT false,
          resolved_rule_id INT,
          UNIQUE(app, window_title)
        )
      `);
    } catch { /* 이미 존재 시 무시 */ }
  }

  // 초기화
  (async () => {
    try {
      const d = db();
      if (d?.query) {
        await ensureRulesTable();
        await ensureUnknownTable();
        await ensureCustomerCache(d);
        await ensureRulesCache(d);
        console.log('[activity-classifier] 초기화 완료');
      }
    } catch (e) {
      console.warn('[activity-classifier] 초기화 경고:', e.message);
    }
  })();

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/classify — 최근 이벤트를 분류해서 반환
  // ?userId=X&hours=24&limit=100
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/classify', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureCustomerCache(d);
      await ensureRulesCache(d);

      const userId = req.query.userId || null;
      const hours = parseInt(req.query.hours) || 24;
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);

      let query = `
        SELECT id, type, user_id, timestamp, data_json,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow', '') as window_title,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp', '') as app_name,
          COALESCE(data_json->>'rawInput', '') as raw_input
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
      `;
      const params = [];

      if (userId) {
        params.push(userId);
        query += ` AND user_id = $${params.length}`;
      }

      query += ` ORDER BY timestamp DESC LIMIT ${limit}`;

      const { rows } = await d.query(query, params);

      const classified = rows.map(row => {
        const cls = classifyActivity(row);
        return {
          id: row.id,
          userId: row.user_id,
          timestamp: row.timestamp,
          type: row.type,
          classification: cls,
        };
      });

      // 미분류 활동 기록 (비동기, 실패해도 무시)
      _recordUnknowns(d, classified).catch(() => {});

      res.json({
        ok: true,
        total: classified.length,
        hours,
        events: classified,
      });
    } catch (e) {
      console.error('[activity-classifier] classify error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/summary/:userId — 직원별 활동 요약
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/summary/:userId', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureCustomerCache(d);
      await ensureRulesCache(d);

      const userId = req.params.userId;
      const hours = parseInt(req.query.hours) || 24;

      const { rows } = await d.query(`
        SELECT id, type, user_id, timestamp, data_json
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND user_id = $1
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp ASC
      `, [userId]);

      const classified = rows.map(annotateEvent);

      // 카테고리별 집계
      const categoryCounts = {};
      const purposeCounts = {};
      const appCounts = {};

      for (const ev of classified) {
        const cls = ev.classification;
        categoryCounts[cls.category] = (categoryCounts[cls.category] || 0) + 1;
        purposeCounts[cls.purpose] = (purposeCounts[cls.purpose] || 0) + 1;
        appCounts[cls.app] = (appCounts[cls.app] || 0) + 1;
      }

      const totalEvents = classified.length;
      const workEvents = categoryCounts['업무'] || 0;
      const personalEvents = categoryCounts['개인'] || 0;
      const otherEvents = categoryCounts['기타'] || 0;

      // 비율 계산
      const workRatio = totalEvents > 0 ? Math.round((workEvents / totalEvents) * 100) : 0;
      const personalRatio = totalEvents > 0 ? Math.round((personalEvents / totalEvents) * 100) : 0;
      const otherRatio = totalEvents > 0 ? 100 - workRatio - personalRatio : 0;

      // 목적별 시간 추정 (이벤트 수 기반, 각 이벤트 ≈ 평균 5분 간격)
      const purposeTime = {};
      for (const [purpose, count] of Object.entries(purposeCounts)) {
        purposeTime[purpose] = {
          count,
          estimatedMinutes: count * 5,
          percentage: totalEvents > 0 ? Math.round((count / totalEvents) * 100) : 0,
        };
      }

      // 세션 생성
      const sessions = groupIntoSessions(classified);

      // 실제 시간 기반 요약 (세션에서 계산)
      const totalMinutes = sessions.reduce((sum, s) => sum + s.durationMin, 0);
      const workMinutes = sessions.filter(s => s.category === '업무').reduce((sum, s) => sum + s.durationMin, 0);
      const personalMinutes = sessions.filter(s => s.category === '개인').reduce((sum, s) => sum + s.durationMin, 0);

      // userName 조회 시도
      let userName = userId;
      try {
        const userRes = await d.query('SELECT name FROM orbit_auth_users WHERE id = $1', [userId]);
        if (userRes.rows[0]) userName = userRes.rows[0].name;
      } catch { /* 무시 */ }

      res.json({
        ok: true,
        userId,
        userName,
        period: `${hours}h`,
        summary: {
          totalEvents,
          totalMinutes,
          workRatio: `${workRatio}%`,
          personalRatio: `${personalRatio}%`,
          otherRatio: `${otherRatio}%`,
          workMinutes,
          personalMinutes,
        },
        categories: categoryCounts,
        purposes: purposeTime,
        apps: appCounts,
        sessionCount: sessions.length,
        topSessions: sessions.slice(0, 10),
      });
    } catch (e) {
      console.error('[activity-classifier] summary error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/timeline/:userId — 시간순 분류 타임라인
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/timeline/:userId', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureCustomerCache(d);
      await ensureRulesCache(d);

      const userId = req.params.userId;
      const hours = parseInt(req.query.hours) || 8;
      const limit = Math.min(parseInt(req.query.limit) || 200, 500);

      const { rows } = await d.query(`
        SELECT id, type, user_id, timestamp, data_json
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND user_id = $1
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp ASC
        LIMIT ${limit}
      `, [userId]);

      const timeline = rows.map(row => {
        const cls = classifyActivity(row);
        const ts = new Date(row.timestamp);
        return {
          time: ts.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }),
          timestamp: row.timestamp,
          label: cls.label,
          category: cls.category,
          purpose: cls.purpose,
          app: cls.app,
          confidence: cls.confidence,
        };
      });

      // 시간대별 그룹핑 (1시간 단위)
      const hourlyGroups = {};
      for (const item of timeline) {
        const hour = item.time.substring(0, 2) + ':00';
        if (!hourlyGroups[hour]) hourlyGroups[hour] = [];
        hourlyGroups[hour].push(item);
      }

      res.json({
        ok: true,
        userId,
        period: `${hours}h`,
        total: timeline.length,
        timeline,
        hourlyGroups,
      });
    } catch (e) {
      console.error('[activity-classifier] timeline error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/sessions — 세션 단위 활동
  // ?userId=X&hours=24
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/sessions', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureCustomerCache(d);
      await ensureRulesCache(d);

      const userId = req.query.userId || null;
      const hours = parseInt(req.query.hours) || 24;
      const gapMin = parseInt(req.query.gapMin) || 30;

      let query = `
        SELECT id, type, user_id, timestamp, data_json,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow', '') as window_title,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp', '') as app_name,
          COALESCE(data_json->>'rawInput', '') as raw_input
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
      `;
      const params = [];
      if (userId) {
        params.push(userId);
        query += ` AND user_id = $${params.length}`;
      }
      query += ' ORDER BY timestamp ASC';

      const { rows } = await d.query(query, params);

      // userId 별로 그룹핑
      const byUser = {};
      for (const row of rows) {
        const uid = row.user_id;
        if (!byUser[uid]) byUser[uid] = [];
        byUser[uid].push(annotateEvent(row));
      }

      const result = {};
      for (const [uid, events] of Object.entries(byUser)) {
        result[uid] = groupIntoSessions(events, gapMin * 60 * 1000);
      }

      // 세션을 읽기 좋은 형태로 변환
      const allSessions = [];
      for (const [uid, sessions] of Object.entries(result)) {
        for (const sess of sessions) {
          allSessions.push({
            userId: uid,
            ...sess,
            timeRange: `${_formatTime(sess.startTime)}-${_formatTime(sess.endTime)}`,
            display: `${_formatTime(sess.startTime)}-${_formatTime(sess.endTime)} ${sess.label} (${sess.durationMin}분)`,
          });
        }
      }

      // 시간순 정렬
      allSessions.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      res.json({
        ok: true,
        period: `${hours}h`,
        totalSessions: allSessions.length,
        sessions: allSessions,
        byUser: result,
      });
    } catch (e) {
      console.error('[activity-classifier] sessions error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/purposes — 목적별 집계
  // ?userId=X&hours=24
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/purposes', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureCustomerCache(d);
      await ensureRulesCache(d);

      const userId = req.query.userId || null;
      const hours = parseInt(req.query.hours) || 24;

      let query = `
        SELECT id, type, user_id, timestamp, data_json,
          COALESCE(data_json->>'windowTitle', data_json->'appContext'->>'currentWindow', '') as window_title,
          COALESCE(data_json->>'app', data_json->'appContext'->>'currentApp', '') as app_name,
          COALESCE(data_json->>'rawInput', '') as raw_input
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
      `;
      const params = [];
      if (userId) {
        params.push(userId);
        query += ` AND user_id = $${params.length}`;
      }
      query += ' ORDER BY timestamp ASC';

      const { rows } = await d.query(query, params);
      const classified = rows.map(annotateEvent);
      const sessions = groupIntoSessions(classified);

      // 목적별 집계
      const purposeStats = {};
      for (const sess of sessions) {
        const key = sess.purpose;
        if (!purposeStats[key]) {
          purposeStats[key] = {
            purpose: key,
            category: sess.category,
            totalMinutes: 0,
            sessionCount: 0,
            eventCount: 0,
          };
        }
        purposeStats[key].totalMinutes += sess.durationMin;
        purposeStats[key].sessionCount += 1;
        purposeStats[key].eventCount += sess.eventCount;
      }

      // 비율 계산
      const totalMinutes = Object.values(purposeStats).reduce((s, p) => s + p.totalMinutes, 0);
      const purposes = Object.values(purposeStats)
        .map(p => ({
          ...p,
          percentage: totalMinutes > 0 ? Math.round((p.totalMinutes / totalMinutes) * 100) : 0,
        }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes);

      res.json({
        ok: true,
        period: `${hours}h`,
        totalMinutes,
        totalPurposes: purposes.length,
        purposes,
      });
    } catch (e) {
      console.error('[activity-classifier] purposes error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/flow/:userId — 활동 흐름도
  // 카톡 → 주문입력 → 차감 체인 분석
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/flow/:userId', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureCustomerCache(d);
      await ensureRulesCache(d);

      const userId = req.params.userId;
      const hours = parseInt(req.query.hours) || 8;

      const { rows } = await d.query(`
        SELECT id, type, user_id, timestamp, data_json
        FROM events
        WHERE type IN ('keyboard.chunk', 'screen.capture')
          AND user_id = $1
          AND timestamp::timestamptz > NOW() - INTERVAL '${hours} hours'
        ORDER BY timestamp ASC
      `, [userId]);

      const classified = rows.map(annotateEvent);
      const sessions = groupIntoSessions(classified);

      // 전환 패턴 분석
      const transitions = {};
      for (let i = 1; i < sessions.length; i++) {
        const from = sessions[i - 1].purpose;
        const to = sessions[i].purpose;
        if (from === to) continue;
        const key = `${from} → ${to}`;
        transitions[key] = (transitions[key] || 0) + 1;
      }

      // 전환 빈도순 정렬
      const flowPatterns = Object.entries(transitions)
        .map(([pattern, count]) => ({ pattern, count }))
        .sort((a, b) => b.count - a.count);

      // 체인 탐지 (3개 이상 연속 전환 패턴)
      const chains = [];
      if (sessions.length >= 3) {
        for (let i = 0; i <= sessions.length - 3; i++) {
          const chain = [
            sessions[i].purpose,
            sessions[i + 1].purpose,
            sessions[i + 2].purpose,
          ];
          // 중복 없는 체인만
          if (new Set(chain).size >= 2) {
            chains.push({
              chain: chain.join(' → '),
              startTime: sessions[i].startTime,
              endTime: sessions[i + 2].endTime,
              totalMin: sessions[i].durationMin + sessions[i + 1].durationMin + sessions[i + 2].durationMin,
            });
          }
        }
      }

      // 가장 흔한 체인
      const chainCounts = {};
      for (const c of chains) {
        chainCounts[c.chain] = (chainCounts[c.chain] || 0) + 1;
      }
      const topChains = Object.entries(chainCounts)
        .map(([chain, count]) => ({ chain, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // 시각화용 노드/엣지
      const purposeSet = new Set(sessions.map(s => s.purpose));
      const nodes = [...purposeSet].map(p => ({
        id: p,
        label: p,
        category: sessions.find(s => s.purpose === p)?.category || '기타',
      }));

      const edges = flowPatterns.map(fp => {
        const [from, to] = fp.pattern.split(' → ');
        return { from: from.trim(), to: to.trim(), weight: fp.count };
      });

      res.json({
        ok: true,
        userId,
        period: `${hours}h`,
        sessionCount: sessions.length,
        flowPatterns,
        topChains,
        graph: { nodes, edges },
        sessions: sessions.map(s => ({
          time: `${_formatTime(s.startTime)}-${_formatTime(s.endTime)}`,
          purpose: s.purpose,
          label: s.label,
          durationMin: s.durationMin,
        })),
      });
    } catch (e) {
      console.error('[activity-classifier] flow error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POST /api/activity/learn — 새 분류 규칙 학습
  // Body: { pattern, match_field, category, purpose, label, app_name, confidence, source }
  // ═══════════════════════════════════════════════════════════════════════
  router.post('/learn', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureRulesTable();

      const {
        pattern, match_field = 'windowTitle',
        category = '업무', purpose, label,
        app_name, confidence = 0.90, source = 'manual',
      } = req.body;

      if (!pattern || !purpose) {
        return res.status(400).json({ error: 'pattern, purpose 필수' });
      }

      // 정규식 유효성 검사
      try {
        new RegExp(pattern, 'i');
      } catch (e) {
        return res.status(400).json({ error: `잘못된 정규식: ${e.message}` });
      }

      const result = await d.query(`
        INSERT INTO activity_rules (pattern, match_field, category, purpose, label, app_name, confidence, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [pattern, match_field, category, purpose, label, app_name, confidence, source]);

      // 캐시 즉시 갱신
      _rulesCacheTs = 0;
      await ensureRulesCache(d);

      res.json({
        ok: true,
        message: '분류 규칙 학습 완료',
        rule: result.rows[0],
        totalRules: _customRules.length,
      });
    } catch (e) {
      console.error('[activity-classifier] learn error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/rules — 현재 분류 규칙 목록
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/rules', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureRulesTable();

      const includeInactive = req.query.all === 'true';
      const whereClause = includeInactive ? '' : 'WHERE active = true';

      const result = await d.query(
        `SELECT * FROM activity_rules ${whereClause} ORDER BY priority DESC, created_at DESC`
      ).catch(() =>
        // priority 컬럼 없는 경우 fallback
        d.query(`SELECT * FROM activity_rules ${whereClause} ORDER BY created_at DESC`)
      );

      // 빌트인 규칙도 표시
      const builtinRules = [
        { type: 'builtin', app: 'kakaotalk', description: 'KakaoTalk 거래처/내부방/개인 분류', patterns: INTERNAL_CHATROOMS.length + ' 내부방 + 고객DB 매칭' },
        { type: 'builtin', app: 'excel', description: 'Excel 파일명 패턴 분류 (물량표/차감/발주/매출/견적/출고)' },
        { type: 'builtin', app: 'nenova', description: '화훼관리 프로그램 화면별 분류 (10개 화면)' },
        { type: 'builtin', app: 'browser', description: '브라우저 URL/타이틀 기반 분류' },
        { type: 'builtin', app: 'other', description: '기타 앱 분류 (메모장/탐색기/캡처/터미널)' },
      ];

      res.json({
        ok: true,
        builtinRules,
        customRules: result.rows || [],
        customerCount: _customerNames.length,
        totalCustomRules: (result.rows || []).length,
      });
    } catch (e) {
      console.error('[activity-classifier] rules error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // GET /api/activity/unknown — 아직 분류 안 된 활동 목록
  // ═══════════════════════════════════════════════════════════════════════
  router.get('/unknown', async (req, res) => {
    try {
      const d = db();
      if (!d?.query) return res.status(503).json({ error: 'DB not available' });

      await ensureUnknownTable();

      const showResolved = req.query.resolved === 'true';
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);

      const whereClause = showResolved ? '' : 'WHERE resolved = false';

      const result = await d.query(`
        SELECT * FROM activity_unknown
        ${whereClause}
        ORDER BY occurrence_count DESC, last_seen DESC
        LIMIT ${limit}
      `);

      // 즉석 분류도 수행 — 미분류 중 분류 가능한 것 표시
      const rows = (result.rows || []).map(row => {
        const testEvent = {
          data_json: {
            app: row.app,
            windowTitle: row.window_title,
          },
        };
        const cls = classifyActivity(testEvent);
        return {
          ...row,
          currentClassification: cls,
          needsLearning: cls.confidence < 0.50 || cls.purpose === '미분류',
        };
      });

      res.json({
        ok: true,
        total: rows.length,
        needsLearning: rows.filter(r => r.needsLearning).length,
        items: rows,
      });
    } catch (e) {
      console.error('[activity-classifier] unknown error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 내부 헬퍼
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 미분류(confidence < 0.5) 활동을 activity_unknown에 기록
   */
  async function _recordUnknowns(d, classifiedEvents) {
    const unknowns = classifiedEvents.filter(
      ev => ev.classification && ev.classification.confidence < 0.50
    );
    if (!unknowns.length) return;

    for (const ev of unknowns.slice(0, 20)) {
      const cls = ev.classification;
      const dataJson = typeof ev.data_json === 'string'
        ? JSON.parse(ev.data_json || '{}')
        : (ev.data_json || {});
      const app = dataJson.app || (dataJson.appContext && dataJson.appContext.currentApp) || cls.app || '';
      const windowTitle = dataJson.windowTitle ||
        (dataJson.appContext && dataJson.appContext.currentWindow) || '';

      if (!app && !windowTitle) continue;

      try {
        await d.query(`
          INSERT INTO activity_unknown (app, window_title, occurrence_count, first_seen, last_seen)
          VALUES ($1, $2, 1, NOW(), NOW())
          ON CONFLICT (app, window_title) DO UPDATE SET
            occurrence_count = activity_unknown.occurrence_count + 1,
            last_seen = NOW()
        `, [app.substring(0, 200), windowTitle.substring(0, 500)]);
      } catch { /* 무시 */ }
    }
  }

  return router;
};

// ═══════════════════════════════════════════════════════════════════════════
// 시간 포맷 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function _formatTime(isoString) {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Seoul',
    });
  } catch {
    return isoString;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 외부에서도 classifyActivity 함수를 사용할 수 있도록 export
// ═══════════════════════════════════════════════════════════════════════════

module.exports.classifyActivity = classifyActivity;
module.exports.annotateEvent = annotateEvent;
module.exports.groupIntoSessions = groupIntoSessions;
module.exports.loadCustomerNames = loadCustomerNames;
module.exports.matchCustomer = matchCustomer;
