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
    confidence:  Math.min(0.5 + (pattern.count || 1) * 0.05, 0.95),
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
    } catch (err) {
      console.error('[suggestion-engine] DB 저장 실패:', err.message);
    }
  }

  return newSuggestions;
}

function tryParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = { run };
