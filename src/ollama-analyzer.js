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

// ── 분석 실행 ───────────────────────────────────────────────
async function runAnalysis() {
  if (_eventQueue.length === 0) return;
  if (!await checkOllamaAlive()) return; // Ollama 꺼져있으면 스킵

  const events = _eventQueue.splice(0, MAX_EVENTS); // 최대 MAX_EVENTS개만 처리
  try {
    const prompt   = buildPrompt(events);
    const analysis = await queryOllama(prompt);
    if (analysis && _broadcastFn) {
      _broadcastFn({
        type:       'ollama_analysis',
        data:       analysis,
        eventCount: events.length,
        model:      OLLAMA_MODEL,
        timestamp:  new Date().toISOString(),
      });
      console.log(`[Ollama] 분석 완료: ${analysis.focus} — ${analysis.summary}`);
    }
  } catch (e) {
    console.error('[Ollama] 분석 오류:', e.message);
    // 실패한 이벤트는 큐 앞에 돌려놓지 않음 (무한 재시도 방지)
  }
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

module.exports = { init, addEvent };
