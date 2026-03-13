/**
 * ollama-analyzer.js
 * ─────────────────────────────────────────────────────────────
 * Ollama를 이용한 실시간 작업 분석 엔진
 *
 * - 새 이벤트가 쌓이면 자동으로 Ollama에 분석 요청 (디바운스 10초)
 * - 이벤트 10개 이상 쌓이면 즉시 분석
 * - 결과를 WebSocket으로 브로드캐스트 (orbit3d.html 인사이트 패널)
 * - Ollama 꺼져있으면 조용히 스킵
 * ─────────────────────────────────────────────────────────────
 */
'use strict';

const http = require('http');

const OLLAMA_HOST   = process.env.OLLAMA_HOST  || '127.0.0.1';
const OLLAMA_PORT   = parseInt(process.env.OLLAMA_PORT  || '11434');
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b';
const DEBOUNCE_MS   = 12000;   // 마지막 이벤트 후 12초 대기
const QUEUE_LIMIT   = 10;      // 큐 10개 이상 → 즉시 분석
const MAX_EVENTS    = 20;      // 분석에 넣을 최대 이벤트 수

let _broadcastFn  = null;     // server.js의 broadcastAll 참조
let _eventQueue   = [];       // 분석 대기 이벤트
let _debounceTimer = null;
let _ollamaAlive  = null;     // null = 미확인, true/false = 캐시 (60초)
let _aliveChecked = 0;

// ── 초기화 (server.js에서 호출) ────────────────────────────
function init(broadcastFn) {
  _broadcastFn = broadcastFn;
  // 서버 시작 후 5초 뒤 Ollama 가동 상태 확인
  setTimeout(checkOllamaAlive, 5000);
}

// ── 새 이벤트 추가 (server.js 이벤트 수신마다 호출) ────────
function addEvent(event) {
  // 분석 불필요한 이벤트 필터
  const skip = ['session.start', 'session.end', 'subagent.start', 'subagent.stop'];
  if (skip.includes(event.type)) return;

  _eventQueue.push(event);

  // 큐 한도 초과 시 앞에서 버림 (최신 우선)
  if (_eventQueue.length > MAX_EVENTS * 2) {
    _eventQueue = _eventQueue.slice(-MAX_EVENTS);
  }

  // 즉시 분석 조건: 큐 한도 도달
  if (_eventQueue.length >= QUEUE_LIMIT) {
    clearTimeout(_debounceTimer);
    runAnalysis();
    return;
  }

  // 디바운스: 마지막 이벤트 후 N초 뒤 분석
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(runAnalysis, DEBOUNCE_MS);
}

// ── Haiku API 호출 ───────────────────────────────────────────
async function queryHaiku(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model  = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
  if (!apiKey) return null;

  const body = JSON.stringify({
    model,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            console.error(`[Haiku] API 오류 ${res.statusCode}:`, parsed.error?.message || data.slice(0, 100));
            return resolve(null);
          }
          const text = parsed.content?.[0]?.text || '';
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            try { resolve(JSON.parse(match[0])); } catch { resolve(null); }
          } else { resolve(null); }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── 분석 실행 (Haiku 우선 → Ollama 폴백) ───────────────────
async function runAnalysis() {
  if (_eventQueue.length === 0) return;

  const events = _eventQueue.splice(0, MAX_EVENTS);
  const prompt = buildPrompt(events);
  let analysis = null;
  let usedModel = '';

  // 1차: Haiku API (빠르고 정확)
  if (process.env.ANTHROPIC_API_KEY) {
    analysis = await queryHaiku(prompt);
    usedModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
  }

  // 2차: Ollama 폴백 (로컬)
  if (!analysis && await checkOllamaAlive()) {
    try {
      analysis = await queryOllama(prompt);
      usedModel = OLLAMA_MODEL;
    } catch (e) {
      console.error('[Ollama] 분석 오류:', e.message);
    }
  }

  if (analysis && _broadcastFn) {
    // 학습 데이터 저장 (크롤링용)
    _saveLearnedData(analysis, events.length);

    _broadcastFn({
      type:       'ollama_analysis',
      data:       analysis,
      eventCount: events.length,
      model:      usedModel,
      timestamp:  new Date().toISOString(),
    });
    console.log(`[AI분석] ${usedModel}: ${analysis.goal || analysis.focus} — ${analysis.summary}`);
  }
}

// ── 학습 데이터 자동 저장 (크롤링용) ──────────────────────────
const path = require('path');
const _learnedDataPath = path.join(__dirname, '..', 'data', 'learned-insights.jsonl');
const _learningCsvPath = path.join(__dirname, '..', 'data', 'learning-data.csv');
const _sessionCsvPath  = path.join(__dirname, '..', 'data', 'session-classifications.csv');

function _ensureDataDir() {
  const fs = require('fs');
  const dir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _saveLearnedData(analysis, eventCount) {
  try {
    const fs = require('fs');
    _ensureDataDir();
    const entry = {
      ts:             new Date().toISOString(),
      project:        analysis.project || null,
      projectGoal:    analysis.projectGoal || null,
      sessionPurpose: analysis.sessionPurpose || null,
      phase:          analysis.phase || null,
      progress:       analysis.progress || null,
      domain:         analysis.domain || null,
      summary:        analysis.summary || null,
      skills:         analysis.skills || [],
      suggestion:     analysis.suggestion || null,
      insight:        analysis.insight || null,
      macroCat:       analysis.macroCat || null,
      events:         eventCount,
      // 하위호환
      goal:           analysis.goal || analysis.projectGoal || null,
      focus:          analysis.focus || analysis.sessionPurpose || null,
      type:           analysis.type || null,
    };
    fs.appendFileSync(_learnedDataPath, JSON.stringify(entry) + '\n');

    // CSV 자동 저장 (학습 피드백용)
    _appendLearningCsv(entry);
  } catch (e) {
    console.error('[학습저장] 오류:', e.message);
  }
}

// ── CSV 자동 저장 (구글시트 호환) ──────────────────────────────
function _appendLearningCsv(entry) {
  try {
    const fs = require('fs');
    const needHeader = !fs.existsSync(_learningCsvPath) || fs.statSync(_learningCsvPath).size === 0;
    const headers = 'timestamp,project,project_goal,session_purpose,phase,progress,domain,skills,suggestion,insight,summary,macro_cat,event_count';
    const row = [
      entry.ts,
      _csvEscape(entry.project),
      _csvEscape(entry.projectGoal),
      _csvEscape(entry.sessionPurpose),
      _csvEscape(entry.phase),
      _csvEscape(entry.progress),
      _csvEscape(entry.domain),
      _csvEscape((entry.skills || []).join('|')),
      _csvEscape(entry.suggestion),
      _csvEscape(entry.insight),
      _csvEscape(entry.summary),
      _csvEscape(entry.macroCat),
      entry.events || 0,
    ].join(',');
    fs.appendFileSync(_learningCsvPath, (needHeader ? headers + '\n' : '') + row + '\n');
  } catch (e) {
    console.error('[CSV저장] 오류:', e.message);
  }
}

// ── 세션 분류 결과 CSV 자동 저장 ────────────────────────────────
function _saveSessionClassification(sessionId, entry, eventCount, files, tools) {
  try {
    const fs = require('fs');
    _ensureDataDir();
    const needHeader = !fs.existsSync(_sessionCsvPath) || fs.statSync(_sessionCsvPath).size === 0;
    const headers = 'timestamp,session_id,project,project_goal,purpose_label,macro_cat,domain,phase,files,tools,event_count';
    const row = [
      new Date().toISOString(),
      sessionId,
      _csvEscape(entry.project),
      _csvEscape(entry.projectGoal),
      _csvEscape(entry.purposeLabel),
      _csvEscape(entry.macroCat),
      _csvEscape(entry.domain),
      _csvEscape(entry.phase),
      _csvEscape((files || []).join('|')),
      _csvEscape((tools || []).join('|')),
      eventCount || 0,
    ].join(',');
    fs.appendFileSync(_sessionCsvPath, (needHeader ? headers + '\n' : '') + row + '\n');
  } catch (e) {
    console.error('[세션CSV] 오류:', e.message);
  }
}

function _csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// ── 학습 데이터 조회 API용 ────────────────────────────────────
function getLearnedInsights(limit = 50) {
  try {
    const fs = require('fs');
    if (!fs.existsSync(_learnedDataPath)) return [];
    const lines = fs.readFileSync(_learnedDataPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ── Ollama 생존 확인 (60초 캐시) ───────────────────────────
function checkOllamaAlive() {
  const now = Date.now();
  if (_ollamaAlive !== null && now - _aliveChecked < 60000) {
    return Promise.resolve(_ollamaAlive);
  }
  return new Promise(resolve => {
    const req = http.get(
      { hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags', timeout: 2000 },
      res => {
        _ollamaAlive  = res.statusCode === 200;
        _aliveChecked = Date.now();
        res.resume();
        resolve(_ollamaAlive);
      }
    );
    req.on('error', () => { _ollamaAlive = false; _aliveChecked = Date.now(); resolve(false); });
    req.on('timeout', () => { req.destroy(); _ollamaAlive = false; _aliveChecked = Date.now(); resolve(false); });
  });
}

// ── 프롬프트 생성 ───────────────────────────────────────────
function buildPrompt(events) {
  const lines = events.map(e => {
    const d = e.data || {};
    switch (e.type) {
      case 'tool.end':
        return `- 도구: ${d.toolName || '?'} → ${d.filePath || d.command || ''}`;
      case 'tool.error':
        return `- 오류: ${d.toolName || '?'} → ${(d.error || '').slice(0, 60)}`;
      case 'file.save':
      case 'vscode.file_save':
        return `- 파일 저장: ${d.filePath || d.fileName || '?'} (${d.language || ''})`;
      case 'vscode.file_open':
        return `- 파일 열기: ${d.filePath || '?'}`;
      case 'terminal.command':
        return `- 터미널: ${(d.command || '').slice(0, 80)}`;
      case 'vscode.debug_start':
        return `- 디버그 시작: ${d.name || '?'}`;
      case 'ai.conversation':
        return `- AI 대화 (${d.site || '?'}): ${(d.title || '').slice(0, 50)}`;
      case 'user.message':
        return `- Claude 질문: ${(d.text || '').slice(0, 80)}`;
      case 'assistant.message':
        return `- Claude 응답 완료`;
      case 'browser.visit':
        return `- 브라우저: ${d.title || d.url || '?'}`;
      default:
        return `- ${e.type}`;
    }
  }).join('\n');

  return `다음은 사용자의 최근 작업 내역입니다.
이 사람이 "왜" 이 작업을 하는지, 어떤 프로젝트의 어떤 목표를 위한 것인지 분석하세요.
단순히 "무엇을 했는지"가 아니라 "이 작업의 목적과 의미"를 파악하세요.

예시:
- 텔레그램 봇 + 구글시트 연동 → 프로젝트: "업무 자동화", 목표: "예약 관리 시스템 구축"
- orbit3d-render.js 수정 → 프로젝트: "Orbit AI 플랫폼", 목표: "3D 시각화 엔진 개발"
- payment.js + 구독 구현 → 프로젝트: "Orbit AI 플랫폼", 목표: "수익화 시스템 구축"

작업 내역 (최근 ${events.length}건):
${lines}

아래 JSON 형식으로만 응답하세요 (설명 텍스트 없이 JSON만):
{
  "project": "최상위 프로젝트명 (예: Orbit AI 플랫폼, 업무 자동화 시스템)",
  "projectGoal": "프로젝트 내 구체 목표 (예: 3D 시각화 엔진 개발, 예약 관리 자동화)",
  "sessionPurpose": "이 세션의 구체적 목적 (예: 노드 레이아웃 최적화, 봇-시트 연동 구현)",
  "phase": "기획|설계|개발|테스트|배포|운영|리서치",
  "progress": "초기|진행중|마무리|완료",
  "domain": "프론트엔드|백엔드|인프라|UI/UX|데이터|자동화|보안|문서|기획|기타",
  "skills": ["기술1", "기술2", "기술3"],
  "suggestion": "다음 추천 작업 (30자 이내)",
  "insight": "이 작업에서 발견한 패턴이나 개선점 (50자 이내)",
  "summary": "작업 요약 (50자 이내)",
  "macroCat": "dev|research|ops|automation|design|planning"
}`;
}

// ── Ollama HTTP API 호출 ─────────────────────────────────────
function queryOllama(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:   OLLAMA_MODEL,
      prompt,
      stream:  false,
      options: { temperature: 0.2, num_predict: 256 },
    });

    const req = http.request({
      hostname: OLLAMA_HOST,
      port:     OLLAMA_PORT,
      path:     '/api/generate',
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const resp = JSON.parse(data);
          const text = (resp.response || '').trim();
          // JSON 블록 추출
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            try {
              resolve(JSON.parse(match[0]));
            } catch {
              resolve({ focus: '작업 중', summary: text.slice(0, 50), skills: [], suggestion: '', type: 'code' });
            }
          } else {
            resolve({ focus: '작업 중', summary: text.slice(0, 50), skills: [], suggestion: '', type: 'code' });
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(body);
    req.end();
  });
}

// ── 세션별 AI 분류 캐시 ─────────────────────────────────────
const _sessionClassifyCache = {};   // sessionId → { purposeLabel, macroCat, goal, ts }

// 세션 이벤트를 AI로 분류 (Haiku 우선 → 룰 기반 폴백)
async function classifySession(sessionId, events) {
  // 캐시 확인 (1시간 유효)
  const cached = _sessionClassifyCache[sessionId];
  if (cached && Date.now() - cached.ts < 3600000) return cached;

  // 이벤트 요약 생성
  const userMsgs = events
    .filter(e => e.type === 'user.message')
    .map(e => (e.data?.contentPreview || e.data?.content || e.label || '').slice(0, 60))
    .filter(Boolean)
    .slice(0, 3);

  const files = {};
  events.forEach(e => {
    const f = (e.data?.filePath || e.data?.fileName || '').replace(/\\/g, '/').split('/').pop();
    if (f && f.length > 2) files[f] = (files[f] || 0) + 1;
  });
  const topFiles = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f);

  // 프로젝트명 추출
  const startEv = events.find(e => e.type === 'session.start');
  const pd = startEv?.data?.projectDir || startEv?.data?.cwd || '';
  const projName = pd ? pd.replace(/\\/g, '/').split('/').filter(Boolean).pop() : '';

  // 도구/타입 통계
  const toolCounts = {};
  events.forEach(e => { if (e.type === 'tool.end' && e.data?.toolName) toolCounts[e.data.toolName] = (toolCounts[e.data.toolName]||0)+1; });
  const topTools = Object.entries(toolCounts).sort((a,b) => b[1]-a[1]).slice(0,5).map(([t,c]) => `${t}(${c})`);

  const prompt = `이 작업 세션이 "왜" 수행되었는지 분석하세요.
단순히 "코드 수정"이 아니라, 어떤 프로젝트의 어떤 목표를 위한 것인지 파악하세요.

프로젝트 디렉토리: ${projName || '(알 수 없음)'}
사용자 지시: ${userMsgs.length ? userMsgs.join(' | ') : '(없음)'}
수정 파일: ${topFiles.join(', ') || '(없음)'}
사용 도구: ${topTools.join(', ') || '(없음)'}
이벤트 수: ${events.length}건

JSON으로만 응답:
{
  "project": "최상위 프로젝트명 (예: Orbit AI 플랫폼)",
  "projectGoal": "프로젝트 내 목표 (예: 3D 시각화 엔진 개발)",
  "purposeLabel": "세션 목적 (20자 이내, 예: 노드 레이아웃 최적화)",
  "macroCat": "dev|research|ops|automation|design|planning",
  "domain": "프론트엔드|백엔드|인프라|UI/UX|데이터|자동화|보안|문서|기획",
  "phase": "기획|설계|개발|테스트|배포|운영",
  "goal": "최종 목표 (15자 이내)"
}`;

  let result = null;

  // Haiku 시도
  if (process.env.ANTHROPIC_API_KEY) {
    result = await queryHaiku(prompt);
  }

  // Ollama 폴백
  if (!result && await checkOllamaAlive()) {
    try { result = await queryOllama(prompt); } catch {}
  }

  // 룰 기반 폴백
  if (!result) {
    const mainMsg = userMsgs[0] || topFiles[0] || '작업';
    // 사용자 메시지에서 핵심 키워드 추출
    let purpose = mainMsg.slice(0, 20);
    // 프로젝트명 포함
    if (projName) purpose = `[${projName}] ${purpose}`;
    // 매크로 카테고리 룰 기반
    let cat = 'dev';
    const allTypes = events.map(e => e.type);
    const readCnt = allTypes.filter(t => t === 'file.read' || t === 'user.message').length;
    const writeCnt = allTypes.filter(t => t === 'file.write' || t === 'file.create').length;
    const opsCnt = allTypes.filter(t => t === 'git.commit' || t === 'terminal.command').length;
    if (readCnt > writeCnt && readCnt > opsCnt) cat = 'research';
    if (opsCnt > writeCnt && opsCnt > readCnt) cat = 'ops';
    result = { purposeLabel: purpose, macroCat: cat, goal: purpose };
  }

  const entry = {
    project:      result.project || projName || '프로젝트',
    projectGoal:  result.projectGoal || result.goal || '',
    purposeLabel: result.purposeLabel || '작업',
    macroCat:     result.macroCat || 'dev',
    domain:       result.domain || '',
    phase:        result.phase || '',
    goal:         result.goal || '',
    ts:           Date.now(),
  };
  _sessionClassifyCache[sessionId] = entry;

  // 세션 분류 결과 자동 저장 (학습 데이터)
  _saveSessionClassification(sessionId, entry, events.length, topFiles, topTools);

  return entry;
}

// 여러 세션 한번에 분류 (프론트에서 호출)
async function classifySessionsBulk(sessionsData) {
  const results = {};
  const promises = sessionsData.map(async ({ sessionId, events }) => {
    results[sessionId] = await classifySession(sessionId, events);
  });
  // 동시 5개씩 처리
  for (let i = 0; i < promises.length; i += 5) {
    await Promise.all(promises.slice(i, i + 5));
  }
  return results;
}

function getSessionClassification(sessionId) {
  return _sessionClassifyCache[sessionId] || null;
}

// ── 학습 CSV 데이터 조회 ─────────────────────────────────────
function getLearningCsvPath() { return _learningCsvPath; }
function getSessionCsvPath() { return _sessionCsvPath; }

module.exports = {
  init, addEvent, getLearnedInsights,
  classifySession, classifySessionsBulk, getSessionClassification,
  getLearningCsvPath, getSessionCsvPath,
};
