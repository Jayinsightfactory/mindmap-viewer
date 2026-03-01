'use strict';

/**
 * suggestion-engine.js
 * 수집 데이터 패턴 분석 → 구조화된 작업 제안(Suggestion) 생성
 *
 * 감지 패턴:
 *   A. 반복 파일 접근: 같은 파일 3회+ → 자동화 제안
 *   B. 반복 타이핑: 유사 텍스트 5회+ → 템플릿/스니펫 제안
 *   C. 앱 전환 빈도: Word↔Excel 하루 10회+ → 통합 제안
 *   D. 장시간 단일 파일: 3시간+ → 요약/구조화 제안
 *   E. 오류 반복 패턴: 같은 검색어 반복 → 해결책 제안
 *   F. AI 프롬프트 수정 패턴: 원하는 결과가 안 나와 수정/변경 반복 → 최적 프롬프트 템플릿 제안
 */

const { ulid } = require('ulid');
const http     = require('http');
const https    = require('https');

// ── Ollama 호출 ───────────────────────────────────────────────────────────────
async function askOllama(prompt, model = 'llama3.2') {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 300 },
    });
    const req = http.request({
      hostname: 'localhost', port: 11434,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).response || ''); }
        catch { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(15000, () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

// ── 유사도 계산 (간단한 단어 겹침) ────────────────────────────────────────────
function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size, 1);
}

// ── 패턴 A: 반복 파일 접근 ───────────────────────────────────────────────────
function detectRepeatFileAccess(events, since = Date.now() - 7 * 86400_000) {
  const counter = {};
  const timestamps = {};

  for (const e of events) {
    if (e.type !== 'file.content' && e.type !== 'file.read') continue;
    const fp = e.data?.filePath || e.data?.fileName || '';
    if (!fp || new Date(e.timestamp || e.ts || 0) < since) continue;

    counter[fp]    = (counter[fp] || 0) + 1;
    timestamps[fp] = timestamps[fp] || [];
    timestamps[fp].push(new Date(e.timestamp || e.ts).toISOString());
  }

  return Object.entries(counter)
    .filter(([, cnt]) => cnt >= 3)
    .map(([fp, cnt]) => ({
      pattern: 'repeat_file',
      filePath: fp,
      count: cnt,
      timestamps: (timestamps[fp] || []).slice(-5),
    }));
}

// ── 패턴 B: 반복 타이핑 ────────────────────────────────────────────────────────
function detectRepeatTyping(events, since = Date.now() - 3 * 86400_000) {
  const chunks = events
    .filter(e => e.type === 'keyboard.chunk' && new Date(e.timestamp || e.ts || 0) > since)
    .map(e => (e.data?.text || '').trim())
    .filter(t => t.length > 15);

  const groups = [];
  const used   = new Set();

  for (let i = 0; i < chunks.length; i++) {
    if (used.has(i)) continue;
    const similar = [chunks[i]];
    for (let j = i + 1; j < chunks.length; j++) {
      if (used.has(j)) continue;
      if (similarity(chunks[i], chunks[j]) > 0.6) {
        similar.push(chunks[j]);
        used.add(j);
      }
    }
    if (similar.length >= 5) {
      used.add(i);
      groups.push({ pattern: 'repeat_typing', sample: chunks[i], count: similar.length });
    }
  }
  return groups;
}

// ── 패턴 C: 앱 전환 빈도 ─────────────────────────────────────────────────────
function detectAppSwitching(events, since = Date.now() - 86400_000) {
  const APP_GROUPS = {
    document: ['word', 'pages', 'google docs', 'hwp', '한글'],
    spreadsheet: ['excel', 'numbers', 'google sheets', '엑셀'],
    email: ['mail', 'outlook', 'gmail', 'thunderbird'],
    browser: ['chrome', 'safari', 'firefox', 'edge'],
    code: ['vscode', 'cursor', 'xcode', 'intellij', 'vim'],
  };

  const switches = events
    .filter(e => e.type === 'app.activity' && new Date(e.timestamp || e.ts || 0) > since)
    .map(e => {
      const app = (e.data?.app || '').toLowerCase();
      for (const [group, apps] of Object.entries(APP_GROUPS)) {
        if (apps.some(a => app.includes(a))) return group;
      }
      return 'other';
    });

  const transitions = {};
  for (let i = 0; i < switches.length - 1; i++) {
    if (switches[i] === switches[i + 1]) continue;
    const key = `${switches[i]}→${switches[i + 1]}`;
    transitions[key] = (transitions[key] || 0) + 1;
  }

  return Object.entries(transitions)
    .filter(([, cnt]) => cnt >= 10)
    .map(([pair, cnt]) => ({
      pattern: 'frequent_switching',
      pair,
      count: cnt,
    }));
}

// ── 패턴 D: 장시간 단일 파일 ─────────────────────────────────────────────────
function detectLongSession(events, since = Date.now() - 86400_000) {
  const fileTimeline = {};

  for (const e of events) {
    if (e.type !== 'file.content') continue;
    const fp = e.data?.filePath || '';
    if (!fp || new Date(e.timestamp || e.ts || 0) < since) continue;
    fileTimeline[fp] = fileTimeline[fp] || [];
    fileTimeline[fp].push(new Date(e.timestamp || e.ts).getTime());
  }

  return Object.entries(fileTimeline)
    .map(([fp, times]) => {
      const sorted   = times.sort((a, b) => a - b);
      const duration = (sorted[sorted.length - 1] - sorted[0]) / 60000; // 분
      return { fp, duration };
    })
    .filter(({ duration }) => duration >= 180) // 3시간+
    .map(({ fp, duration }) => ({
      pattern: 'long_session',
      filePath: fp,
      durationMin: Math.round(duration),
    }));
}

// ── 패턴 F: AI 프롬프트 수정 패턴 ────────────────────────────────────────────
// AI 앱(Claude, ChatGPT 등)에서 타이핑 후 수정/변경 키워드가 반복 등장하면
// 최초 프롬프트가 의도를 제대로 담지 못한 것으로 판단, 최적 프롬프트 제안
const AI_APPS = ['claude', 'chatgpt', 'gemini', 'copilot', 'gpt', 'cursor', 'windsurf'];
const REVISION_KEYWORDS = [
  '다시', '아니', '아니야', '그게 아니라', '수정', '변경해', '바꿔',
  '원하는건', '내가 원한건', '그냥', '다시 해줘', '틀렸어', '아니고',
  'no', 'wrong', 'redo', 'again', 'not what', 'incorrect', 'change',
  'that\'s not', 'actually', 'wait', 'nevermind',
];

function isAiApp(app = '') {
  const a = app.toLowerCase();
  return AI_APPS.some(ai => a.includes(ai));
}

function hasRevisionSignal(text = '') {
  const t = text.toLowerCase();
  return REVISION_KEYWORDS.some(kw => t.includes(kw));
}

function detectPromptRefinements(events, since = Date.now() - 3 * 86400_000) {
  // keyboard.chunk 이벤트 중 AI 앱에서 발생한 것만 필터링
  const aiChunks = events
    .filter(e =>
      e.type === 'keyboard.chunk' &&
      new Date(e.timestamp || e.ts || 0) > since &&
      isAiApp(e.data?.app)
    )
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (aiChunks.length < 2) return [];

  // 세션 단위로 그룹화 (5분 이내 연속 = 같은 세션)
  const sessions = [];
  let cur = [aiChunks[0]];
  for (let i = 1; i < aiChunks.length; i++) {
    const gap = new Date(aiChunks[i].timestamp) - new Date(aiChunks[i - 1].timestamp);
    if (gap < 5 * 60 * 1000) {
      cur.push(aiChunks[i]);
    } else {
      if (cur.length >= 2) sessions.push(cur);
      cur = [aiChunks[i]];
    }
  }
  if (cur.length >= 2) sessions.push(cur);

  const results = [];

  for (const session of sessions) {
    const app   = session[0].data?.app || 'AI';
    const texts = session.map(e => (e.data?.text || '').trim()).filter(Boolean);

    // 수정 키워드가 포함된 청크 수 카운트 (1회 이상 = 학습 대상)
    const revisions = texts.filter(t => hasRevisionSignal(t));
    if (revisions.length < 1) continue;

    // 첫 번째 청크 (원래 요청) vs 마지막 청크 (최종 의도)
    const firstPrompt = texts[0].slice(0, 120);
    const finalPrompt = texts[texts.length - 1].slice(0, 120);

    results.push({
      pattern:       'prompt_refinement',
      app,
      revisionCount: revisions.length,
      totalChunks:   texts.length,
      firstPrompt,
      finalPrompt,
      revisionSamples: revisions.slice(0, 3),
      sessionStart: session[0].timestamp,
    });
  }

  return results;
}

// ── 제안 생성 ─────────────────────────────────────────────────────────────────
async function buildSuggestion(pattern, ollamaModel) {
  let type, priority, title, description, evidence, action;

  if (pattern.pattern === 'repeat_file') {
    const name = pattern.filePath.split('/').pop();
    const prompt = `파일 "${name}"이(가) 지난 7일 동안 ${pattern.count}번 반복적으로 열렸습니다. 이 파일 작업을 자동화하거나 효율화할 수 있는 간결한 제안을 한국어로 2문장 이내로 작성하세요.`;
    const desc = await askOllama(prompt, ollamaModel);
    type = 'automation'; priority = 4;
    title = `"${name}" 반복 접근 자동화`;
    description = desc || `지난 7일간 ${pattern.count}회 접근됨 — 자동화 스크립트 또는 단축키 설정을 권장합니다.`;
    evidence = [{ type: 'file_access', path: pattern.filePath, count: pattern.count }];
    action = { action: `"${name}" 열기 단축키 또는 스케줄 스크립트 생성` };

  } else if (pattern.pattern === 'repeat_typing') {
    const sample = pattern.sample.slice(0, 60);
    type = 'template'; priority = 3;
    title = '반복 입력 텍스트 → 스니펫 저장 제안';
    description = `"${sample}..." 와 유사한 텍스트를 ${pattern.count}회 입력함. 텍스트 스니펫 또는 자동완성으로 저장하세요.`;
    evidence = [{ type: 'repeat_typing', sample: pattern.sample, count: pattern.count }];
    action = { action: '스니펫 저장', template: pattern.sample };

  } else if (pattern.pattern === 'frequent_switching') {
    const [from, to] = pattern.pair.split('→');
    type = 'shortcut'; priority = 3;
    title = `${from} ↔ ${to} 전환 최적화`;
    description = `하루 ${pattern.count}회 전환 감지. 두 앱을 통합하거나 키보드 단축키를 설정하세요.`;
    evidence = [{ type: 'app_switch', pair: pattern.pair, count: pattern.count }];
    action = { action: `${from}↔${to} 통합 워크플로우 설정` };

  } else if (pattern.pattern === 'long_session') {
    const name = pattern.filePath.split('/').pop();
    const hours = (pattern.durationMin / 60).toFixed(1);
    type = 'review'; priority = 2;
    title = `"${name}" 장시간 작업 → 구조화 제안`;
    description = `약 ${hours}시간 작업 감지. 내용 요약 또는 섹션 분리를 권장합니다.`;
    evidence = [{ type: 'long_session', path: pattern.filePath, durationMin: pattern.durationMin }];
    action = { action: '문서 섹션 요약 및 구조화' };

  } else if (pattern.pattern === 'prompt_refinement') {
    // AI 프롬프트 수정 패턴 감지
    const appName = pattern.app || 'AI';
    const prompt = [
      `사용자가 ${appName}에서 AI에게 명령을 내렸으나 원하는 결과가 나오지 않아`,
      `${pattern.revisionCount}번 수정 요청을 반복했습니다.`,
      `최초 요청: "${pattern.firstPrompt}"`,
      `최종 의도: "${pattern.finalPrompt}"`,
      `위 대화 흐름을 분석하여 한 번에 원하는 결과를 얻을 수 있는 최적 프롬프트 구조를 한국어로 제안하세요.`,
      `응답 형식: "최적 프롬프트: [구체적 프롬프트 템플릿]" 형식으로 2-3문장.`,
    ].join(' ');
    const desc = await askOllama(prompt, ollamaModel);
    type = 'prompt_template'; priority = 5;
    title = `${appName} 프롬프트 최적화 (${pattern.revisionCount}회 수정 감지)`;
    description = desc ||
      `처음부터 원하는 결과를 얻을 수 있는 프롬프트 구조를 미리 스킬로 등록하세요. ` +
      `최초 요청: "${pattern.firstPrompt.slice(0, 50)}..."`;
    evidence = [{
      type:          'prompt_refinement',
      app:           pattern.app,
      revisionCount: pattern.revisionCount,
      firstPrompt:   pattern.firstPrompt,
      finalPrompt:   pattern.finalPrompt,
      revisions:     pattern.revisionSamples,
      sessionStart:  pattern.sessionStart,
    }];
    action = {
      action:     '최적 프롬프트를 Orbit 스킬로 저장',
      template:   pattern.finalPrompt,
      fixedSkill: {
        name:        `${appName} 최적 프롬프트`,
        description: `수정 없이 바로 원하는 결과를 얻는 프롬프트`,
        prompt:      pattern.finalPrompt,
      },
    };

  } else {
    return null;
  }

  return {
    id:          ulid(),
    type,
    priority,
    title,
    description,
    evidence:    JSON.stringify(evidence),
    suggestion:  JSON.stringify(action),
    confidence:  Math.min(0.5 + (pattern.count || pattern.revisionCount || 1) * 0.05, 0.95),
    status:      'pending',
    created_at:  new Date().toISOString(),
    responded_at: null,
  };
}

// ── 메인 실행 ─────────────────────────────────────────────────────────────────
/**
 * @param {object[]} events - DB에서 읽어온 최근 이벤트 배열
 * @param {object}   db     - better-sqlite3 DB 인스턴스
 * @param {string}   [ollamaModel]
 */
async function run(events, db, ollamaModel = 'llama3.2') {
  if (!events || !events.length || !db) return [];

  // 이벤트 data 필드 파싱
  const parsed = events.map(e => ({
    ...e,
    data: typeof e.data === 'string' ? tryParse(e.data) : (e.data || {}),
  }));

  // 패턴 감지
  const patterns = [
    ...detectRepeatFileAccess(parsed),
    ...detectRepeatTyping(parsed),
    ...detectAppSwitching(parsed),
    ...detectLongSession(parsed),
    ...detectPromptRefinements(parsed),   // F. AI 프롬프트 수정 패턴
  ];

  if (!patterns.length) return [];

  // DB에 이미 있는 pending 제안과 중복 방지
  let existing = [];
  try {
    existing = db.prepare(`SELECT title FROM suggestions WHERE status = 'pending'`).all().map(r => r.title);
  } catch {}

  const newSuggestions = [];

  for (const pattern of patterns) {
    let sug;
    try { sug = await buildSuggestion(pattern, ollamaModel); }
    catch { continue; }
    if (!sug) continue;
    if (existing.includes(sug.title)) continue;

    try {
      db.prepare(`
        INSERT OR IGNORE INTO suggestions
          (id, type, priority, title, description, evidence, suggestion, confidence, status, created_at)
        VALUES
          (@id, @type, @priority, @title, @description, @evidence, @suggestion, @confidence, @status, @created_at)
      `).run(sug);
      newSuggestions.push(sug);
      console.log(`[suggestion-engine] 새 제안: ${sug.title}`);

      // prompt_template은 학습 데이터 → Level 1 이상이면 즉시 자동 동기화
      if (sug.type === 'prompt_template') {
        immediatePromptSync(db, sug).catch(() => {});
      }
    } catch (err) {
      console.error('[suggestion-engine] DB 저장 실패:', err.message);
    }
  }

  return newSuggestions;
}

// ── prompt_template 즉시 자동 동기화 ─────────────────────────────────────────
// AI 수정 패턴에서 학습된 최적 프롬프트는 로컬에서 생성 즉시 클라우드로 전송
// (Level 1+ 동의 시 — 원문이 아닌 구조화된 학습 데이터만 전송)
async function immediatePromptSync(db, suggestion) {
  const cloudUrl = process.env.ORBIT_CLOUD_URL;
  const token    = process.env.ORBIT_TOKEN;
  if (!cloudUrl) return;

  // 동기화 레벨 확인
  let level = 0;
  try {
    const row = db.prepare(`SELECT value FROM kv_store WHERE key='sync_level'`).get();
    level = parseInt(row?.value || '0', 10);
  } catch {}
  if (level < 1) return;

  const payload = JSON.stringify({
    source:    'orbit-local',
    syncLevel: level,
    syncedAt:  new Date().toISOString(),
    // 학습된 프롬프트 최적화 데이터만 전송 (원본 키보드 데이터 아님)
    promptLearnings: [{
      id:          suggestion.id,
      type:        'prompt_template',
      app:         JSON.parse(suggestion.evidence||'[{}]')[0]?.app,
      revisionCount: JSON.parse(suggestion.evidence||'[{}]')[0]?.revisionCount,
      confidence:  suggestion.confidence,
      createdAt:   suggestion.created_at,
      // level 2만 원문 포함; level 1은 구조 메타만
      template:    level >= 2 ? JSON.parse(suggestion.suggestion||'{}')?.template : undefined,
    }],
    suggestions: [],
    events:      [],
  });

  try {
    const mod     = cloudUrl.startsWith('https') ? https : http;
    const parsed  = new URL(cloudUrl + '/api/sync/prompt-learning');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    await new Promise((resolve, reject) => {
      const req = mod.request({
        hostname: parsed.hostname, port: parsed.port || (cloudUrl.startsWith('https') ? 443 : 80),
        path: parsed.pathname, method: 'POST', headers,
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
    console.log(`[suggestion-engine] 프롬프트 학습 데이터 즉시 전송 (level ${level}): ${suggestion.title}`);
  } catch (err) {
    console.warn('[suggestion-engine] 즉시 동기화 실패 (무시):', err.message);
  }
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = { run };
