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
const _learnedDataPath = require('path').join(__dirname, '..', 'data', 'learned-insights.jsonl');

function _saveLearnedData(analysis, eventCount) {
  try {
    const fs = require('fs');
    const dir = require('path').dirname(_learnedDataPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = {
      ts:         new Date().toISOString(),
      goal:       analysis.goal || null,
      phase:      analysis.phase || null,
      progress:   analysis.progress || null,
      focus:      analysis.focus || null,
      summary:    analysis.summary || null,
      skills:     analysis.skills || [],
      suggestion: analysis.suggestion || null,
      type:       analysis.type || null,
      events:     eventCount,
    };
    fs.appendFileSync(_learnedDataPath, JSON.stringify(entry) + '\n');
  } catch (e) {
    console.error('[학습저장] 오류:', e.message);
  }
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

  return `다음은 개발자의 최근 작업 내역입니다. 한국어로 분석해주세요.

작업 내역 (최근 ${events.length}건):
${lines}

아래 JSON 형식으로만 응답하세요 (설명 텍스트 없이 JSON만):
{
  "goal": "최종 목표 (15자 이내, 예: 로그인 시스템 구축)",
  "phase": "현재 단계 (15자 이내, 예: OAuth API 연동 중)",
  "progress": "초기|진행중|마무리|완료",
  "focus": "현재 작업 주제 (10자 이내)",
  "summary": "작업 요약 (50자 이내)",
  "skills": ["기술1", "기술2"],
  "suggestion": "다음 추천 작업 (30자 이내)",
  "type": "code|debug|research|review|meeting"
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

module.exports = { init, addEvent, getLearnedInsights };
