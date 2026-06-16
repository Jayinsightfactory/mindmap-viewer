'use strict';
/**
 * src/server-vision-worker.js
 * Railway 서버사이드 Vision 분석 루프.
 * global._visionImageQueue 에 쌓인 screen.capture 이미지를
 * Anthropic API로 분석 → screen.analyzed 이벤트로 저장.
 *
 * server.js에서 serverVisionWorker.start(insertEvent) 로 호출됨.
 */

const Anthropic = require('@anthropic-ai/sdk');

const INTERVAL_MS = 8_000;   // 8초마다 큐 체크
const BATCH_MAX   = 2;        // 한 번에 최대 2건 처리
const MIN_GAP_MS  = 3_000;   // 연속 분석 사이 간격

let _client      = null;
let _running     = false;
let _insertEvent = null;
let _lastAt      = 0;
let _startedAt   = null;
let _processed   = 0;
let _failed      = 0;
let _lastError   = null;
let _lastSkipReason = null;

function _getClient() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

function _buildPrompt(ctx) {
  return `스크린샷을 정밀 분석해주세요. 호스트: ${ctx.hostname || '?'} 앱: ${ctx.app || '?'} 창: ${ctx.windowTitle || '?'}

다음 JSON 형식으로만 응답 (마크다운 없이 순수 JSON):
{
  "app": "실제 프로그램명",
  "screen": "현재 화면/메뉴명",
  "activity": "사용자가 지금 하는 작업 1줄 (구체적으로)",
  "workCategory": "전산처리|문서작업|커뮤니케이션|파일관리|웹검색|기타",
  "visibleText": ["화면에 보이는 핵심 텍스트/숫자 최대 10개"],
  "fields": [
    { "name": "필드명", "currentValue": "현재 값", "position": "위치" }
  ],
  "automationScore": 0.0,
  "automatable": false,
  "automationHint": "자동화 방법 또는 null"
}`;
}

function _parseResult(text) {
  if (!text) return null;
  const block = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  let s = block ? block[1].trim() : text;
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  s = s
    .replace(/:\s*true\/false/g, ': true')
    .replace(/:\s*(\d+\.?\d*)~(\d+\.?\d*)/g, ': $1')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  try { return JSON.parse(s); } catch { return null; }
}

async function _analyzeOne(item) {
  const client = _getClient();
  if (!client) return null;
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: item.imageBase64 } },
          { type: 'text', text: _buildPrompt(item) },
        ],
      }],
    });
    return _parseResult(msg.content?.[0]?.text || '');
  } catch (err) {
    console.warn('[server-vision-worker] API 에러:', err.message);
    _lastError = err.message;
    return null;
  }
}

async function _emitAnalyzed(item, analysis) {
  if (!_insertEvent) return;
  const event = {
    id:        'svw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    type:      'screen.analyzed',
    source:    'server-vision-worker',
    sessionId: item.sessionId || ('daemon-' + (item.hostname || 'unknown')),
    timestamp: item.ts || new Date().toISOString(),
    userId:    item.userId || null,
    data: {
      fileId: item.id, hostname: item.hostname || '',
      app: item.app || '', windowTitle: item.windowTitle || '',
      trigger: item.trigger || '', userId: item.userId || '',
      ...analysis,
    },
  };
  try { await Promise.resolve(_insertEvent(event)); } catch (e) {
    console.warn('[server-vision-worker] insertEvent 실패:', e.message);
    _lastError = e.message;
  }
  console.log(`[server-vision-worker] ✓ ${item.hostname}/${item.app} → ${analysis.screen || '?'} (auto:${analysis.automationScore ?? '?'})`);
}

async function _tick() {
  // [2026-06-15] 전용 OFF 스위치 — ANTHROPIC_API_KEY는 다른 기능(주문매칭/RAG/챗봇 등 16개 파일)이
  // 공유하므로 비울 수 없음. 이 서버 Vision 워커만 끄려면 Railway에 VISION_SERVER_WORKER=off 설정.
  // (분석은 owner PC의 CLI 야간 워커가 무과금으로 대신 처리)
  if ((process.env.VISION_SERVER_WORKER || '').toLowerCase() === 'off') { _lastSkipReason = 'disabled_by_flag'; return; }
  const queue = global._visionImageQueue;
  if (!queue || queue.length === 0) { _lastSkipReason = 'empty_queue'; return; }
  if (!_getClient()) { _lastSkipReason = 'missing_anthropic_api_key'; return; }
  if (Date.now() - _lastAt < MIN_GAP_MS) { _lastSkipReason = 'min_gap'; return; }
  _lastSkipReason = null;

  let done = 0;
  while (queue.length > 0 && done < BATCH_MAX) {
    const item = queue.shift();
    if (!item?.imageBase64) continue;
    const analysis = await _analyzeOne(item);
    if (analysis) {
      await _emitAnalyzed(item, analysis);
      _processed++;
    } else {
      console.warn(`[server-vision-worker] 분석 실패: ${item.hostname}/${item.app}`);
      _failed++;
    }
    done++;
    _lastAt = Date.now();
    if (queue.length > 0 && done < BATCH_MAX) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS));
    }
  }
}

function start(insertEventFn) {
  if (_running) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[server-vision-worker] ANTHROPIC_API_KEY 없음 — Vision 분석 비활성');
    return;
  }
  _insertEvent = insertEventFn;
  _running = true;
  _startedAt = new Date().toISOString();
  setInterval(() => {
    _tick().catch(e => console.error('[server-vision-worker] tick 에러:', e.message));
  }, INTERVAL_MS);
  console.log('[server-vision-worker] 시작 — Haiku, 8s 인터벌');
}

function getStatus() {
  return {
    running: _running,
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    startedAt: _startedAt,
    lastTickAt: _lastAt ? new Date(_lastAt).toISOString() : null,
    secondsSinceLastTick: _lastAt ? Math.round((Date.now() - _lastAt) / 1000) : null,
    intervalMs: INTERVAL_MS,
    processed: _processed,
    failed: _failed,
    lastError: _lastError,
    lastSkipReason: _lastSkipReason,
    queueSize: (global._visionImageQueue || []).length,
    likelyBlockedBy: !_running
      ? (!process.env.ANTHROPIC_API_KEY ? 'missing_anthropic_api_key' : 'not_started')
      : ((global._visionImageQueue || []).length === 0 ? 'empty_queue' : null),
  };
}

module.exports = { start, getStatus };
