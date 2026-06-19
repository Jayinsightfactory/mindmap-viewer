'use strict';
/**
 * work-learner.js — 캡처+키로거 조합 학습 엔진
 *
 * keyboard.chunk + screen.capture를 결합하여:
 * 1. 업무 세션 감지 (시간 근접 이벤트 그룹핑)
 * 2. 활동 분류 (앱+윈도우타이틀 → 업무 유형)
 * 3. 반복 패턴 마이닝 (자동화 후보)
 * 4. 시간대별 업무 분석
 * 5. 멤버별 업무 프로필 생성
 */

// ── 업무 유형 분류 규칙 ────────────────────────────────────────────────────
const WORK_CATEGORIES = {
  '전산처리':   { apps: ['nenova'], keywords: ['주문', '관리', '입력', '조회', '화면', '프로그램'] },
  '문서작업':   { apps: ['excel', 'word', 'hwp', 'powerpnt', 'acrobat'], keywords: ['발주', '견적', '보고서', '매출', '시트'] },
  '커뮤니케이션': { apps: ['kakaotalk', 'slack', 'teams', 'outlook'], keywords: ['채팅', '메시지', '대화'] },
  '파일관리':   { apps: ['explorer'], keywords: ['폴더', '파일', '복사', '이동', '탐색기'] },
  '웹검색':     { apps: ['chrome', 'edge', 'firefox', 'whale'], keywords: ['검색', 'google', '네이버'] },
  '개발':       { apps: ['code', 'vscode', 'cursor', 'terminal', 'iterm'], keywords: ['코드', '빌드', '배포', 'git'] },
  '디자인':     { apps: ['figma', 'photoshop', 'illustrator'], keywords: ['디자인', '레이아웃'] },
};

function normalizeWindowTitle(title) {
  if (!title) return '';
  return title
    .toLowerCase()
    .replace(/[-_|•·]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\d{5,}/g, '#')        // 주문번호 등 5자리 이상 숫자 마스킹
    .replace(/[()[\]{}]/g, '')
    .trim()
    .slice(0, 60);
}

// ── 이벤트 → 업무 세션 그룹핑 ─────────────────────────────────────────────
function groupIntoWorkSessions(events, gapMinutes = 5) {
  const sorted = events
    .filter(e => e.type === 'keyboard.chunk' || e.type === 'screen.capture')
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const sessions = [];
  let current = null;

  for (const ev of sorted) {
    const ts = new Date(ev.timestamp).getTime();
    if (!current || ts - current.endTs > gapMinutes * 60 * 1000) {
      if (current) sessions.push(current);
      current = { startTs: ts, endTs: ts, events: [ev] };
    } else {
      current.endTs = ts;
      current.events.push(ev);
    }
  }
  if (current) sessions.push(current);
  return sessions;
}

// ── 단일 이벤트 → 앱/윈도우 추출 ─────────────────────────────────────────
function extractContext(event) {
  let data = event.data || {};
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }

  if (event.type === 'keyboard.chunk') {
    const ctx = data.appContext || {};
    const steps = (data.patterns?.detected?.workflowSteps) || [];
    const app = ctx.currentApp || (steps[0]?.app) || '';
    const window = ctx.currentWindow || '';
    const wh = ctx.windowHistory || {};
    const summary = data.summary || '';
    const mouseClicks = data.mouseClicks || 0;
    const inputText = data.inputText || '';  // [골:Phase1] 세션에 타이핑 내용 포함
    return { app: app.toLowerCase(), window: normalizeWindowTitle(window), windowHistory: wh, summary, mouseClicks, inputText, type: 'keyboard' };
  }

  if (event.type === 'screen.capture') {
    return {
      app: (data.app || '').toLowerCase(),
      window: normalizeWindowTitle(data.windowTitle || ''),
      trigger: data.trigger || '',
      activityLevel: data.activityLevel || '',
      type: 'capture',
    };
  }

  return { app: '', window: '', type: event.type };
}

// ── 활동 분류 ─────────────────────────────────────────────────────────────
function classifyActivity(app, windowTitle) {
  const appLow = (app || '').toLowerCase();
  const titleLow = (windowTitle || '').toLowerCase();

  for (const [category, rule] of Object.entries(WORK_CATEGORIES)) {
    if (rule.apps.some(a => appLow.includes(a))) return category;
    if (rule.keywords.some(k => titleLow.includes(k))) return category;
  }
  return '기타';
}

// ── 세션 분석 ─────────────────────────────────────────────────────────────
function analyzeSession(session) {
  const apps = {};
  const categories = {};
  const windows = [];
  let totalClicks = 0;
  let captureCount = 0;
  const typedParts = [];                          // [골:Phase1] 세션 타이핑 내용

  for (const ev of session.events) {
    const ctx = extractContext(ev);
    if (ctx.app) apps[ctx.app] = (apps[ctx.app] || 0) + 1;
    if (ctx.window) windows.push(ctx.window);
    if (ctx.mouseClicks) totalClicks += ctx.mouseClicks;
    if (ctx.type === 'capture') captureCount++;
    if (ctx.inputText && ctx.inputText.trim()) typedParts.push(ctx.inputText.trim());

    const cat = classifyActivity(ctx.app, ctx.window);
    categories[cat] = (categories[cat] || 0) + 1;
  }

  const durationMin = Math.round((session.endTs - session.startTs) / 60000);
  const primaryApp = Object.entries(apps).sort((a, b) => b[1] - a[1])[0]?.[0] || '알 수 없음';
  const primaryCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] || '기타';

  // 고유 윈도우 타이틀 (반복 제거)
  const uniqueWindows = [...new Set(windows)].slice(0, 5);

  // [골:Phase1] 타이핑 내용(한글 디코딩) + 사람이 읽는 세션 요약
  const typedRaw = typedParts.join(' ').slice(0, 300);
  const typedText = qwertyToHangul(typedRaw);
  const sessionSummary = `${primaryApp}에서 ${durationMin}분 · ${primaryCategory}`
    + (typedText ? ` · 입력 "${typedText.slice(0, 50)}"` : '')
    + (totalClicks ? ` · ${totalClicks}클릭` : '');

  return {
    startTime: new Date(session.startTs).toISOString(),
    endTime: new Date(session.endTs).toISOString(),
    durationMin,
    eventCount: session.events.length,
    primaryApp,
    primaryCategory,
    apps,
    categories,
    uniqueWindows,
    totalClicks,
    captureCount,
    typedText,                                     // [골:Phase1] 세션에 친 내용(한글)
    sessionSummary,                                // [골:Phase1] "nenova에서 8분 · 데이터입력 · 입력 '...' · 45클릭"
  };
}

// ── 반복 패턴 감지 ────────────────────────────────────────────────────────
function detectPatterns(sessions) {
  // 앱 전환 시퀀스 추출
  const sequences = [];
  for (const sess of sessions) {
    const appSeq = [];
    let lastApp = '';
    for (const ev of sess.events) {
      const ctx = extractContext(ev);
      if (ctx.app && ctx.app !== lastApp) {
        appSeq.push(ctx.app);
        lastApp = ctx.app;
      }
    }
    if (appSeq.length >= 2) sequences.push(appSeq);
  }

  // 2-gram, 3-gram 빈도 계산
  const ngrams = {};
  for (const seq of sequences) {
    for (let n = 2; n <= Math.min(4, seq.length); n++) {
      for (let i = 0; i <= seq.length - n; i++) {
        const gram = seq.slice(i, i + n).join(' → ');
        ngrams[gram] = (ngrams[gram] || 0) + 1;
      }
    }
  }

  // 2회 이상 반복된 패턴만
  const patterns = Object.entries(ngrams)
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => {
      const apps = pattern.split(' → ');
      const isAutomatable = apps.some(a =>
        ['nenova', 'excel', 'explorer'].includes(a)
      );
      return {
        pattern,
        count,
        automatable: isAutomatable,
        suggestion: isAutomatable
          ? `이 작업 흐름(${pattern})이 ${count}회 반복됨 — 자동화 가능`
          : `반복 패턴: ${pattern} (${count}회)`,
      };
    });

  return patterns;
}

// ── 시간대별 업무 분석 ────────────────────────────────────────────────────
function analyzeTimeDistribution(events) {
  const hourly = Array(24).fill(0);
  const hourlyApps = {};

  for (const ev of events) {
    if (ev.type !== 'keyboard.chunk') continue;
    const h = new Date(ev.timestamp).getHours();
    hourly[h]++;
    const ctx = extractContext(ev);
    if (ctx.app) {
      if (!hourlyApps[h]) hourlyApps[h] = {};
      hourlyApps[h][ctx.app] = (hourlyApps[h][ctx.app] || 0) + 1;
    }
  }

  // 피크 시간
  const peakHour = hourly.indexOf(Math.max(...hourly));
  // 업무 시간 (첫/마지막 활동)
  const firstHour = hourly.findIndex(c => c > 0);
  const lastHour = 23 - [...hourly].reverse().findIndex(c => c > 0);

  return { hourly, hourlyApps, peakHour, firstHour, lastHour };
}

// ── 전체 멤버 분석 실행 ───────────────────────────────────────────────────
async function analyzeUser(pool, userId) {
  // LIMIT + 최근 30일만 — 무제한 스캔 시 OOM (Bad Gateway 근본 원인)
  const { rows } = await pool.query(
    `SELECT id, type, timestamp, data_json FROM events
     WHERE user_id=$1
       AND type IN ('keyboard.chunk','screen.capture','idle')
       AND timestamp::TIMESTAMPTZ > NOW() - INTERVAL '30 days'
     ORDER BY timestamp DESC LIMIT 5000`,
    [userId]
  );

  const events = rows.map(r => ({
    id: r.id,
    type: r.type,
    timestamp: r.timestamp,
    data: typeof r.data_json === 'string' ? JSON.parse(r.data_json) : r.data_json,
  }));

  if (events.length < 3) {
    return { userId, status: 'insufficient', eventCount: events.length, message: '데이터 부족 (3건 이상 필요)' };
  }

  // 1. 세션 그룹핑
  const workSessions = groupIntoWorkSessions(events);
  const sessionAnalyses = workSessions.map(analyzeSession);

  // 2. 앱 사용 통계
  const appTotals = {};
  const categoryTotals = {};
  for (const sa of sessionAnalyses) {
    for (const [app, cnt] of Object.entries(sa.apps)) {
      appTotals[app] = (appTotals[app] || 0) + cnt;
    }
    for (const [cat, cnt] of Object.entries(sa.categories)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + cnt;
    }
  }

  // 3. 반복 패턴
  const patterns = detectPatterns(workSessions);

  // 4. 시간대 분석
  const timeAnalysis = analyzeTimeDistribution(events);

  // 5. 총 업무 시간
  const totalWorkMin = sessionAnalyses.reduce((s, a) => s + a.durationMin, 0);

  // 6. 자동화 점수 (0~100)
  const automationScore = Math.min(100, Math.round(
    (patterns.filter(p => p.automatable).length * 20) +
    (categoryTotals['전산처리'] ? 15 : 0) +
    (categoryTotals['파일관리'] ? 10 : 0) +
    (Object.keys(appTotals).length <= 3 ? 10 : 0) // 앱 적으면 루틴성
  ));

  return {
    userId,
    status: 'ok',
    eventCount: events.length,
    sessionCount: workSessions.length,
    totalWorkMin,
    topApps: Object.entries(appTotals).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topCategories: Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]),
    patterns,
    timeAnalysis: {
      peakHour: timeAnalysis.peakHour,
      workHours: `${timeAnalysis.firstHour}:00 ~ ${timeAnalysis.lastHour}:00`,
      hourly: timeAnalysis.hourly,
    },
    automationScore,
    sessions: sessionAnalyses.slice(0, 10), // 최근 10개 세션
    insights: _generateInsights(sessionAnalyses, patterns, categoryTotals, appTotals, automationScore),
    rawInputPatterns: _extractRawInputPatterns(events),
    mouseHotspots: _clusterMouseClicks(events),
  };
}

// ── 인사이트 자동 생성 ────────────────────────────────────────────────────
function _generateInsights(sessions, patterns, categories, apps, autoScore) {
  const insights = [];

  // 주요 업무
  const topCat = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];
  if (topCat) {
    insights.push({ type: 'info', text: `주요 업무: ${topCat[0]} (전체의 ${Math.round(topCat[1] / Object.values(categories).reduce((s, v) => s + v, 0) * 100)}%)` });
  }

  // 자동화 가능 패턴
  const autoPatterns = patterns.filter(p => p.automatable);
  if (autoPatterns.length > 0) {
    insights.push({ type: 'automation', text: `자동화 가능 패턴 ${autoPatterns.length}개 감지 — ${autoPatterns[0].pattern}` });
  }

  // 앱 집중도
  const topApp = Object.entries(apps).sort((a, b) => b[1] - a[1])[0];
  const totalAppUse = Object.values(apps).reduce((s, v) => s + v, 0);
  if (topApp && totalAppUse > 0) {
    const pct = Math.round(topApp[1] / totalAppUse * 100);
    if (pct >= 50) {
      insights.push({ type: 'focus', text: `${topApp[0]}에 ${pct}% 집중 — 이 앱 최적화가 효율 향상의 핵심` });
    }
  }

  // 자동화 점수
  if (autoScore >= 50) {
    insights.push({ type: 'score', text: `자동화 가능성 ${autoScore}/100 — 반복 작업 비율 높음` });
  } else if (autoScore >= 25) {
    insights.push({ type: 'score', text: `자동화 가능성 ${autoScore}/100 — 부분 자동화 가능` });
  }

  return insights;
}

// ── 전체 워크스페이스 분석 ────────────────────────────────────────────────
async function analyzeWorkspace(pool, memberIds) {
  const results = [];
  for (const uid of memberIds) {
    const result = await analyzeUser(pool, uid);
    results.push(result);
  }

  // 팀 전체 패턴
  const allPatterns = results.flatMap(r => r.patterns || []);
  const teamInsights = [];

  // 공통 앱
  const allApps = {};
  results.forEach(r => {
    (r.topApps || []).forEach(([app]) => { allApps[app] = (allApps[app] || 0) + 1; });
  });
  const sharedApps = Object.entries(allApps).filter(([_, cnt]) => cnt >= 2).map(([app]) => app);
  if (sharedApps.length) {
    teamInsights.push({ type: 'team', text: `팀 공통 앱: ${sharedApps.join(', ')}` });
  }

  return { members: results, teamInsights, analyzedAt: new Date().toISOString() };
}

// 두벌식 QWERTY→한글 (키훅이 IME 조합 전 물리키를 잡아서 — 자동화 후보 가독용)
function qwertyToHangul(str){
  if(!str) return '';
  const M={q:'ㅂ',w:'ㅈ',e:'ㄷ',r:'ㄱ',t:'ㅅ',y:'ㅛ',u:'ㅕ',i:'ㅑ',o:'ㅐ',p:'ㅔ',a:'ㅁ',s:'ㄴ',d:'ㅇ',f:'ㄹ',g:'ㅎ',h:'ㅗ',j:'ㅓ',k:'ㅏ',l:'ㅣ',z:'ㅋ',x:'ㅌ',c:'ㅊ',v:'ㅍ',b:'ㅠ',n:'ㅜ',m:'ㅡ',Q:'ㅃ',W:'ㅉ',E:'ㄸ',R:'ㄲ',T:'ㅆ',O:'ㅒ',P:'ㅖ'};
  const CHO='ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JUNG='ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const VC={'ㅗㅏ':'ㅘ','ㅗㅐ':'ㅙ','ㅗㅣ':'ㅚ','ㅜㅓ':'ㅝ','ㅜㅔ':'ㅞ','ㅜㅣ':'ㅟ','ㅡㅣ':'ㅢ'};
  const TC={'ㄱㅅ':'ㄳ','ㄴㅈ':'ㄵ','ㄴㅎ':'ㄶ','ㄹㄱ':'ㄺ','ㄹㅁ':'ㄻ','ㄹㅂ':'ㄼ','ㄹㅅ':'ㄽ','ㄹㅌ':'ㄾ','ㄹㅍ':'ㄿ','ㄹㅎ':'ㅀ','ㅂㅅ':'ㅄ'};
  const TS={'ㄳ':['ㄱ','ㅅ'],'ㄵ':['ㄴ','ㅈ'],'ㄶ':['ㄴ','ㅎ'],'ㄺ':['ㄹ','ㄱ'],'ㄻ':['ㄹ','ㅁ'],'ㄼ':['ㄹ','ㅂ'],'ㄽ':['ㄹ','ㅅ'],'ㄾ':['ㄹ','ㅌ'],'ㄿ':['ㄹ','ㅍ'],'ㅀ':['ㄹ','ㅎ'],'ㅄ':['ㅂ','ㅅ']};
  const JONGL=['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  const isC=c=>CHO.includes(c);
  let out='',cho='',jung='',jong='';
  const flush=()=>{if(cho&&jung){const ci=CHO.indexOf(cho),ji=JUNG.indexOf(jung),ti=JONGL.indexOf(jong||'');out+=String.fromCharCode(0xAC00+(ci*21+ji)*28+(ti<0?0:ti));}else out+=(cho||'')+(jung||'')+(jong||'');cho='';jung='';jong='';};
  for(const ch of str){const j=M[ch];if(j===undefined){flush();out+=ch;continue;}if(isC(j)){if(!cho&&!jung)cho=j;else if(cho&&!jung){flush();cho=j;}else if(cho&&jung&&!jong){if(JONGL.includes(j))jong=j;else{flush();cho=j;}}else{const cc=TC[jong+j];if(cc)jong=cc;else{flush();cho=j;}}}else{if(cho&&!jung)jung=j;else if(cho&&jung&&!jong){const vc=VC[jung+j];if(vc)jung=vc;else{flush();out+=j;}}else if(cho&&jung&&jong){const sp=TS[jong];let mj;if(sp){jong=sp[0];mj=sp[1];}else{mj=jong;jong='';}flush();cho=mj;jung=j;}else{const vc=VC[jung+j];if(jung&&vc){jung=vc;}else{flush();out+=j;}}}}flush();return out;
}

// [2026-06-18 골:Phase1] 키보드 내용(inputText) → 반복입력 → 자동화 후보. 한글 디코딩으로 가독.
// (기존 rawInput은 항상 비어있었음 — 옵션2로 inputText 캡처하면서 이 엔진이 실데이터로 작동)
function _extractRawInputPatterns(events) {
  const inputs = events
    .filter(e => e.type === 'keyboard.chunk' && typeof e.data?.inputText === 'string' && e.data.inputText.trim().length > 3)
    .map(e => e.data.inputText.trim().slice(0, 100));

  if (inputs.length < 5) return { count: inputs.length, patterns: [], topInputs: [] };

  const freq = {};
  for (const input of inputs) {
    const normalized = input.replace(/\d+/g, '#').trim();
    freq[normalized] = (freq[normalized] || 0) + 1;
  }

  const patterns = Object.entries(freq)
    .filter(([_, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => {
      const ko = qwertyToHangul(pattern);
      return {
        pattern, patternKo: ko, count,
        automatable: count >= 3,
        suggestion: count >= 3 ? `"${ko}" 반복 입력 ${count}회 → 자동완성/단축키 등록 가능` : null,
      };
    });

  return { count: inputs.length, patterns, topInputs: inputs.slice(0, 5).map(s => ({ raw: s, ko: qwertyToHangul(s) })) };
}

function _clusterMouseClicks(events) {
  const clicks = [];
  for (const e of events) {
    if (e.type !== 'keyboard.chunk') continue;
    const positions = e.data?.mousePositions;
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        clicks.push({ x: pos.x, y: pos.y });
      }
    }
  }

  if (clicks.length < 10) return { clickCount: clicks.length, hotspots: [] };

  const grid = {};
  for (const { x, y } of clicks) {
    const gx = Math.round(x / 50) * 50;
    const gy = Math.round(y / 50) * 50;
    const key = `${gx},${gy}`;
    grid[key] = (grid[key] || 0) + 1;
  }

  const hotspots = Object.entries(grid)
    .filter(([_, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const [x, y] = key.split(',').map(Number);
      return { x, y, count, automatable: count >= 5 };
    });

  return { clickCount: clicks.length, hotspots };
}

// ── [골:Phase1] Task Spec 추출 ────────────────────────────────────────────
// 클립보드+앱전환+윈도우타이틀 → "카톡→nenova 주문입력" 작업 대본
// inputText 없어도 기존 데이터만으로 동작.
const TASK_TRIGGERS = {
  order_entry: {
    pattern: ['kakaotalk', 'nenova'],
    description: '카카오톡 주문 수신 → nenova 주문입력',
  },
  inventory_check: {
    pattern: ['kakaotalk', 'excel'],
    description: '카카오톡 재고 문의 → Excel 확인',
  },
  doc_report: {
    pattern: ['excel', 'chrome'],
    description: 'Excel 작업 → 웹 업로드/보고',
  },
};

// 클립보드 이벤트에서 재고/주문 데이터 파싱
function parseOrderFromClipboard(text) {
  if (!text || text.length < 3) return null;
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // 품목+수량 패턴: "안개꽃 20단", "튤립 안트락티카 10단 <12.13>"
  const items = [];
  const itemRe = /^(.+?)\s+(\d+)\s*(단|박스|개|스팀|ea|EA)/;
  for (const line of lines) {
    const m = line.match(itemRe);
    if (m) items.push({ name: m[1].trim(), qty: parseInt(m[2]), unit: m[3] });
  }

  // 주문 헤더: "25-1차 중국 잔량", "25-2차 네덜란드 잔량"
  const headerRe = /(\d+)-(\d+차)\s+(.+)\s+(잔량|주문|발주)/;
  const header = lines.map(l => l.match(headerRe)).find(Boolean);

  if (items.length === 0 && !header) return null;
  return {
    items,
    header: header ? { lot: header[1], round: header[2], origin: header[3], type: header[4] } : null,
    raw: text.slice(0, 300),
  };
}

// 앱전환 시퀀스에서 task pattern 매칭
function matchTaskPattern(appSeq, patternApps) {
  // patternApps = ['kakaotalk','nenova'] → 이 순서로 등장하는지
  let pi = 0;
  const matchedAt = [];
  for (let i = 0; i < appSeq.length; i++) {
    if (appSeq[i].includes(patternApps[pi])) {
      matchedAt.push(i);
      pi++;
      if (pi === patternApps.length) return { matched: true, matchedAt };
    }
  }
  return { matched: false };
}

// 이벤트 배열 → task spec 목록 추출
function extractTaskSpecs(events) {
  // clipboard.change 이벤트 수집
  const clipboardEvents = events.filter(e => e.type === 'clipboard.change').map(e => {
    const d = (typeof e.data === 'string') ? JSON.parse(e.data) : (e.data || {});
    return { ts: new Date(e.timestamp).getTime(), text: d.text || d.clipboard || '', sourceApp: d.sourceApp || '' };
  });

  // 세션별 분석
  const sessions = groupIntoWorkSessions(events, 10); // 10분 gap
  const specs = [];

  for (const session of sessions) {
    const appSeq = [];
    const windowSeq = [];
    const inputParts = [];
    let lastApp = '';

    for (const ev of session.events) {
      const ctx = extractContext(ev);
      if (ctx.app && ctx.app !== lastApp) { appSeq.push(ctx.app); lastApp = ctx.app; }
      if (ctx.window) windowSeq.push(ctx.window);
      if (ctx.inputText) inputParts.push(ctx.inputText.trim());
    }

    // 각 task pattern 매칭 시도
    for (const [taskType, def] of Object.entries(TASK_TRIGGERS)) {
      const { matched, matchedAt } = matchTaskPattern(appSeq, def.pattern);
      if (!matched) continue;

      // 이 세션 시간대의 클립보드 이벤트 수집
      const sessionClips = clipboardEvents.filter(
        c => c.ts >= session.startTs - 5 * 60 * 1000 && c.ts <= session.endTs + 60 * 1000
      );

      // 클립보드에서 주문 데이터 파싱
      const orderData = sessionClips
        .map(c => parseOrderFromClipboard(c.text))
        .filter(Boolean);

      // 입력 내용(inputText, 있으면)
      const typedRaw = inputParts.join(' ').slice(0, 200);
      const typedText = typedRaw ? qwertyToHangul(typedRaw) : '';

      // nenova 화면 시퀀스 (어느 화면을 거쳤나)
      const nenovaWindows = windowSeq.filter(w => w && (w.includes('주문') || w.includes('관리') || w.includes('입력') || w.includes('nenova')));

      specs.push({
        taskType,
        description: def.description,
        startTime: new Date(session.startTs).toISOString(),
        endTime: new Date(session.endTs).toISOString(),
        durationMin: Math.round((session.endTs - session.startTs) / 60000),
        appSequence: appSeq,
        nenovaScreens: [...new Set(nenovaWindows)].slice(0, 5),
        clipboardOrders: orderData,          // 클립보드에서 파싱된 주문/재고 데이터
        typedText: typedText || null,        // inputText 있을 때 한글 디코딩
        clipboardCount: sessionClips.length,
        confidence: orderData.length > 0 ? 'high' : (sessionClips.length > 0 ? 'medium' : 'low'),
      });
    }
  }

  // 동일 taskType 빈도 집계
  const byType = {};
  for (const s of specs) {
    if (!byType[s.taskType]) byType[s.taskType] = [];
    byType[s.taskType].push(s);
  }

  return {
    totalSpecs: specs.length,
    byType: Object.fromEntries(
      Object.entries(byType).map(([k, v]) => [k, {
        count: v.length,
        description: TASK_TRIGGERS[k]?.description,
        latest: v[v.length - 1],
        highConfidence: v.filter(s => s.confidence === 'high').length,
        sampleOrders: v.flatMap(s => s.clipboardOrders).slice(0, 5),
      }])
    ),
    specs: specs.slice(-20), // 최근 20건
  };
}

module.exports = { analyzeUser, analyzeWorkspace, groupIntoWorkSessions, classifyActivity, detectPatterns, normalizeWindowTitle, _extractRawInputPatterns, _clusterMouseClicks, extractTaskSpecs, parseOrderFromClipboard };
