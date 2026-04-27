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
    return null;
  }
}

function _emitAnalyzed(item, analysis) {
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
  try { _insertEvent(event); } catch (e) {
    console.warn('[server-vision-worker] insertEvent 실패:', e.message);
  }
  console.log(`[server-vision-worker] ✓ ${item.hostname}/${item.app} → ${analysis.screen || '?'} (auto:${analysis.automationScore ?? '?'})`);
}

async function _tick() {
  const queue = global._visionImageQueue;
  if (!queue || queue.length === 0) return;
  if (!_getClient()) return;
  if (Date.now() - _lastAt < MIN_GAP_MS) return;

  let done = 0;
  while (queue.length > 0 && done < BATCH_MAX) {
    const item = queue.shift();
    if (!item?.imageBase64) continue;
    const analysis = await _analyzeOne(item);
    if (analysis) {
      _emitAnalyzed(item, analysis);
    } else {
      console.warn(`[server-vision-worker] 분석 실패: ${item.hostname}/${item.app}`);
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
  setInterval(() => {
    _tick().catch(e => console.error('[server-vision-worker] tick 에러:', e.message));
  }, INTERVAL_MS);
  console.log('[server-vision-worker] 시작 — Haiku, 8s 인터벌');
}

module.exports = { start };
