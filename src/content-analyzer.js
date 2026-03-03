'use strict';

/**
 * content-analyzer.js
 * 키보드 캡처 텍스트를 로컬 Ollama로 분석 → 구조화된 태그 추출
 *
 * 원칙:
 *   - 원본 텍스트는 로컬 DB에만 저장
 *   - 클라우드로는 태그(메타데이터)만 전송
 *   - Ollama가 완전히 오프라인으로 처리
 *
 * 출력 태그 구조:
 * {
 *   sentiment:  'positive' | 'negative' | 'neutral' | 'frustrated' | 'anxious' | 'angry',
 *   urgency:    'none' | 'low' | 'medium' | 'high' | 'critical',
 *   topic:      'work_pressure' | 'interpersonal' | 'deadline' | 'blame' | 'technical' | 'praise' | 'other',
 *   style:      'assertive' | 'defensive' | 'apologetic' | 'aggressive' | 'requesting' | 'short_answer',
 *   riskScore:  0.0 ~ 1.0   (이슈 전조 위험도)
 * }
 */

const http = require('http');

// ── Ollama 분류 프롬프트 ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `당신은 텍스트의 감정·긴급도·주제·화법을 분석하는 분류기입니다.
반드시 JSON 형식으로만 응답하세요. 다른 설명 없이 JSON만.

분석 항목:
- sentiment: positive | negative | neutral | frustrated | anxious | angry
- urgency: none | low | medium | high | critical
- topic: work_pressure | interpersonal | deadline | blame_shift | technical | praise | other
- style: assertive | defensive | apologetic | aggressive | requesting | short_answer | normal
- riskScore: 0.0~1.0 (이슈 전조 위험도. 갈등·압박·책임전가가 높을수록 높음)

응답 예시:
{"sentiment":"frustrated","urgency":"high","topic":"blame_shift","style":"defensive","riskScore":0.75}`;

// ── Ollama 호출 ───────────────────────────────────────────────────────────────
async function analyzeWithOllama(text, model = 'llama3.2') {
  // 너무 짧은 텍스트는 분석 의미 없음
  if (!text || text.trim().length < 10) return null;

  // 개인정보 제거: 전화번호·이메일·URL 마스킹
  const sanitized = text
    .replace(/\d{2,3}-\d{3,4}-\d{4}/g, '[전화번호]')
    .replace(/[\w.]+@[\w.]+\.\w+/g, '[이메일]')
    .replace(/https?:\/\/\S+/g, '[URL]')
    .slice(0, 400); // 최대 400자만 분석 (토큰 절약)

  const body = JSON.stringify({
    model,
    prompt:  `${SYSTEM_PROMPT}\n\n분석할 텍스트:\n"${sanitized}"`,
    stream:  false,
    options: { temperature: 0.1, num_predict: 80 },
  });

  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 11434,
      path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const resp = JSON.parse(data).response || '{}';
          // JSON 부분만 추출 (Ollama가 가끔 앞뒤에 텍스트 추가)
          const jsonMatch = resp.match(/\{[\s\S]*?\}/);
          const parsed   = JSON.parse(jsonMatch?.[0] || '{}');
          resolve(validateTag(parsed));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(12000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── 태그 검증 ─────────────────────────────────────────────────────────────────
const VALID = {
  sentiment: ['positive','negative','neutral','frustrated','anxious','angry'],
  urgency:   ['none','low','medium','high','critical'],
  topic:     ['work_pressure','interpersonal','deadline','blame_shift','technical','praise','other'],
  style:     ['assertive','defensive','apologetic','aggressive','requesting','short_answer','normal'],
};

function validateTag(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sentiment:  VALID.sentiment.includes(raw.sentiment) ? raw.sentiment : 'neutral',
    urgency:    VALID.urgency.includes(raw.urgency)     ? raw.urgency   : 'none',
    topic:      VALID.topic.includes(raw.topic)         ? raw.topic     : 'other',
    style:      VALID.style.includes(raw.style)         ? raw.style     : 'normal',
    riskScore:  typeof raw.riskScore === 'number'
                  ? Math.max(0, Math.min(1, raw.riskScore))
                  : 0,
  };
}

// ── 배치 처리: 이벤트 목록 → 태그 DB 저장 ────────────────────────────────────
/**
 * @param {object[]} events   - keyboard.chunk 이벤트 배열
 * @param {object}   db       - better-sqlite3 인스턴스
 * @param {string}   [model]  - Ollama 모델명
 */
async function analyzeAndStore(events, db, model = 'llama3.2') {
  ensureTable(db);

  // 이미 분석된 event_id 제외
  const analyzed = new Set(
    db.prepare(`SELECT event_id FROM content_tags`).all().map(r => r.event_id)
  );

  const targets = events.filter(e =>
    e.type === 'keyboard.chunk' &&
    (e.data?.text?.length || 0) >= 10 &&
    !analyzed.has(e.id)
  );

  const insert = db.prepare(`
    INSERT OR IGNORE INTO content_tags
      (event_id, timestamp, app, sentiment, urgency, topic, style, risk_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const e of targets) {
    const tag = await analyzeWithOllama(e.data?.text || '', model);
    if (!tag) continue;

    insert.run(
      e.id,
      e.timestamp || new Date().toISOString(),
      e.data?.app || 'unknown',
      tag.sentiment,
      tag.urgency,
      tag.topic,
      tag.style,
      tag.riskScore,
    );
    count++;

    // 과부하 방지: 청크 간 200ms 대기
    await sleep(200);
  }

  if (count) console.log(`[content-analyzer] ${count}개 이벤트 태그 완료`);
  return count;
}

// ── 최근 N시간 태그 요약 ──────────────────────────────────────────────────────
function recentTagSummary(db, hours = 4) {
  ensureTable(db);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const rows = db.prepare(
    `SELECT sentiment, urgency, topic, style, risk_score
     FROM content_tags WHERE timestamp > ? ORDER BY timestamp ASC`
  ).all(since);

  if (!rows.length) return null;

  // 최빈값 계산
  const freq = (arr, key) => {
    const counts = {};
    arr.forEach(r => { counts[r[key]] = (counts[r[key]] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  };

  const avgRisk = rows.reduce((s, r) => s + (r.risk_score || 0), 0) / rows.length;
  const highRisk = rows.filter(r => r.risk_score > 0.6).length;

  return {
    dominantSentiment: freq(rows, 'sentiment'),
    dominantUrgency:   freq(rows, 'urgency'),
    dominantTopic:     freq(rows, 'topic'),
    dominantStyle:     freq(rows, 'style'),
    avgRiskScore:      +avgRisk.toFixed(3),
    highRiskCount:     highRisk,
    totalTagged:       rows.length,
    windowHours:       hours,
  };
}

// ── 테이블 보장 ───────────────────────────────────────────────────────────────
function ensureTable(db) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS content_tags (
      event_id   TEXT PRIMARY KEY,
      timestamp  DATETIME,
      app        TEXT,
      sentiment  TEXT,
      urgency    TEXT,
      topic      TEXT,
      style      TEXT,
      risk_score REAL DEFAULT 0
    )
  `).run();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { analyzeAndStore, recentTagSummary, analyzeWithOllama };
