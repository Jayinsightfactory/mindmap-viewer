'use strict';
/**
 * vision-processor.js — 서버 인메모리 Vision 분석 루프
 *
 * global._visionImageQueue 를 소비해 Claude Vision으로 분석 후
 * PG events 테이블에 screen.analyzed 이벤트로 저장.
 *
 * server.js 시작 시: startVisionLoop(getDb) 호출
 */

const https = require('https');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

const INTERVAL_ACTIVE = 30 * 1000;    // 큐 있을 때 30초
const INTERVAL_IDLE   = 2 * 60 * 1000; // 큐 없을 때 2분
const BATCH_SIZE      = 3;             // 한 번에 최대 3개 (Railway 메모리)

let _apiKeyWarned = false;
let _timer = null;

// ── 프롬프트 ──────────────────────────────────────────────────────────────────
const PROMPT = `화면을 분석해서 JSON으로만 답해:
{
  "app": "앱 이름",
  "screen": "화면/창 이름",
  "activity": "지금 하는 작업 설명 (한국어, 구체적으로)",
  "automatable": true/false,
  "automationHint": "자동화 방법 (있으면)",
  "nenovaScreen": "nenova 화면이면 화면명 아니면 null",
  "dataVisible": ["화면에 보이는 주요 데이터 항목들"],
  "userAction": "사용자가 방금 한 행동"
}`;

// ── JSON 파싱 (vision-worker.js 동일 패턴) ────────────────────────────────────
function _parseResult(text) {
  if (!text) return null;

  let jsonStr = null;

  // Strategy 1: ```json ... ``` 코드블록
  const codeBlock = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlock) jsonStr = codeBlock[1].trim();

  // Strategy 2: 가장 바깥 { ... }
  if (!jsonStr) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) jsonStr = m[0];
  }

  if (jsonStr) {
    const cleaned = jsonStr
      .replace(/:\s*true\/false/g, ': true')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    try { return JSON.parse(cleaned); } catch {}
    try { return JSON.parse(jsonStr); } catch {}
  }

  try { return JSON.parse(text.trim()); } catch {}
  return null;
}

// ── Anthropic API 호출 (https.request, vision-worker.js 동일 패턴) ─────────────
function visionApi(base64) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: 60000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          resolve(_parseResult(parsed.content?.[0]?.text));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── PG 저장 ───────────────────────────────────────────────────────────────────
async function saveEvent(db, item, result) {
  if (!db) {
    console.log(`[vision-proc] DB 없음 — 저장 skip: ${item.hostname}/${item.app}`);
    return;
  }

  const id = `vision-${Date.now()}-${String(item.id || '').slice(0, 6)}`;
  const dataJson = JSON.stringify({
    ...result,
    hostname:    item.hostname,
    app:         item.app,
    windowTitle: item.windowTitle,
    trigger:     item.trigger,
  });

  try {
    await db.query(
      `INSERT INTO events (id, type, user_id, data_json, timestamp)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, 'screen.analyzed', item.userId, dataJson]
    );
  } catch (e) {
    // SQLite fallback (db.run 방식)
    if (typeof db.run === 'function') {
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT INTO events (id, type, user_id, data_json, timestamp)
           VALUES (?, ?, ?, ?, datetime('now'))`,
          [id, 'screen.analyzed', item.userId, dataJson],
          (err) => (err ? reject(err) : resolve())
        );
      });
    } else {
      throw e;
    }
  }
}

// ── 배치 처리 ─────────────────────────────────────────────────────────────────
async function processBatch(getDb) {
  const queue = global._visionImageQueue;
  if (!Array.isArray(queue) || queue.length === 0) return 0;

  if (!ANTHROPIC_KEY) {
    if (!_apiKeyWarned) {
      console.log('[vision-proc] ANTHROPIC_API_KEY 없음 — Vision 분석 skip');
      _apiKeyWarned = true;
    }
    return 0;
  }

  const batch = queue.splice(0, BATCH_SIZE);
  let done = 0;

  for (const item of batch) {
    try {
      if (!item.imageBase64) {
        console.log(`[vision-proc] 이미지 없음 — skip: ${item.id}`);
        continue;
      }

      const result = await visionApi(item.imageBase64);
      if (!result) {
        console.log(`[vision-proc] 파싱 실패 — skip: ${item.hostname}/${item.app}`);
        continue;
      }

      let db = null;
      try { db = getDb ? getDb() : null; } catch {}

      await saveEvent(db, item, result);

      console.log(`[vision-proc] 완료: ${item.hostname}/${item.app} → ${result.activity || result.screen || '(activity 없음)'}`);
      done++;
    } catch (e) {
      console.log(`[vision-proc] 오류 — skip: ${(item && item.id) || '?'} — ${e.message}`);
    }
  }

  return done;
}

// ── 루프 스케줄러 ─────────────────────────────────────────────────────────────
function scheduleNext(getDb) {
  const queue = global._visionImageQueue;
  const hasItems = Array.isArray(queue) && queue.length > 0;
  const delay = hasItems ? INTERVAL_ACTIVE : INTERVAL_IDLE;

  _timer = setTimeout(async () => {
    try {
      await processBatch(getDb);
    } catch (e) {
      console.log(`[vision-proc] 루프 오류: ${e.message}`);
    }
    scheduleNext(getDb);
  }, delay);
}

// ── 공개 API ──────────────────────────────────────────────────────────────────
function startVisionLoop(getDb) {
  if (!global._visionImageQueue) {
    global._visionImageQueue = [];
  }

  console.log('[vision-proc] Vision 처리 루프 시작 (active:30s / idle:2m / batch:3)');

  // 첫 체크는 30초 후 (서버 초기화 완료 대기)
  _timer = setTimeout(async () => {
    try {
      await processBatch(getDb);
    } catch (e) {
      console.log(`[vision-proc] 초기 루프 오류: ${e.message}`);
    }
    scheduleNext(getDb);
  }, INTERVAL_ACTIVE);
}

module.exports = { startVisionLoop };
