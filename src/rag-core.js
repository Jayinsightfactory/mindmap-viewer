'use strict';

/**
 * rag-core.js
 * ─────────────────────────────────────────────────────────────────────────────
 * RAG (Retrieval-Augmented Generation) 코어 엔진
 *
 * 역할:
 *   1. 이벤트/Vision/대화 데이터를 검색 가능한 문서로 정규화
 *   2. PostgreSQL tsvector 풀텍스트 + 키워드 + 시간범위 검색
 *   3. 검색 결과를 LLM 프롬프트에 주입 (컨텍스트 증강)
 *   4. 에이전트별 맞춤 컨텍스트 제공
 *
 * 사용: const rag = require('./rag-core'); rag.init(db);
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { generate } = require('./llm-gateway');

let _db = null;          // PG pool 참조
let _initialized = false;

// ── 캐시 레이어 (Map 기반, 5분 TTL) ───────────────────────────────────────
const _searchCache = new Map();  // key: cacheKey, value: { results, expireAt }
const CACHE_TTL_MS = 5 * 60 * 1000;  // 5분

function _cacheKey(opts) {
  return JSON.stringify({
    q: opts.query, u: opts.userId, st: opts.sourceType,
    app: opts.app, days: opts.days, lim: opts.limit,
  });
}

function _cacheGet(key) {
  const entry = _searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) { _searchCache.delete(key); return null; }
  return entry.results;
}

function _cacheSet(key, results) {
  // 캐시 크기 제한 (최대 200개)
  if (_searchCache.size >= 200) {
    const firstKey = _searchCache.keys().next().value;
    _searchCache.delete(firstKey);
  }
  _searchCache.set(key, { results, expireAt: Date.now() + CACHE_TTL_MS });
}

// ── n-gram 유사도 헬퍼 ────────────────────────────────────────────────────

/**
 * 문자열을 n-gram 집합으로 변환 (n=2)
 * @param {string} text
 * @param {number} n - gram 크기 (기본 2)
 * @returns {Set<string>}
 */
function _ngrams(text, n = 2) {
  const s = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const result = new Set();
  for (let i = 0; i <= s.length - n; i++) {
    result.add(s.slice(i, i + n));
  }
  return result;
}

/**
 * 두 텍스트 간 n-gram 코사인 유사도 (0~1)
 * Set 기반 자카드와 달리 빈도 가중치 없음 (이진 벡터)
 */
function _ngramSimilarity(a, b, n = 2) {
  const ga = _ngrams(a, n);
  const gb = _ngrams(b, n);
  if (ga.size === 0 || gb.size === 0) return 0;
  let intersection = 0;
  for (const g of ga) { if (gb.has(g)) intersection++; }
  // 코사인 유사도: intersection / sqrt(|A| * |B|)
  return intersection / Math.sqrt(ga.size * gb.size);
}

/**
 * 자카드 유사도 (중복 청크 제거용)
 */
function _jaccardSimilarity(a, b, n = 2) {
  const ga = _ngrams(a, n);
  const gb = _ngrams(b, n);
  if (ga.size === 0 && gb.size === 0) return 1;
  let intersection = 0;
  for (const g of ga) { if (gb.has(g)) intersection++; }
  const union = ga.size + gb.size - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── 초기화 ──────────────────────────────────────────────────────────────────

async function init(db) {
  if (!db?.query) throw new Error('RAG: PostgreSQL pool 필요');
  _db = db;

  // rag_documents 테이블 생성 (없으면)
  await _db.query(`
    CREATE TABLE IF NOT EXISTS rag_documents (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,          -- 'event', 'vision', 'kakao', 'workflow', 'nenova'
      source_id TEXT,                     -- 원본 이벤트/레코드 ID
      user_id TEXT,
      content TEXT NOT NULL,              -- 정규화된 텍스트
      metadata JSONB DEFAULT '{}',
      ts TIMESTAMPTZ DEFAULT NOW(),
      tsv TSVECTOR                        -- 풀텍스트 검색용
    )
  `).catch(e => console.warn('[rag] 테이블 생성 스킵:', e.message));

  // tsvector 인덱스
  await _db.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_tsv ON rag_documents USING GIN (tsv)
  `).catch(() => {});

  // 메타데이터 인덱스
  await _db.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_user ON rag_documents (user_id, ts DESC)
  `).catch(() => {});

  await _db.query(`
    CREATE INDEX IF NOT EXISTS idx_rag_source ON rag_documents (source_type, ts DESC)
  `).catch(() => {});

  _initialized = true;
  console.log('[rag-core] 초기화 완료');
}

// ── 문서 정규화 (이벤트 → 검색 가능 텍스트) ──────────────────────────────────

/**
 * 이벤트를 자연어 문서로 변환
 * @param {Object} event - DB 이벤트 행
 * @returns {{ content: string, metadata: object }}
 */
function normalizeEvent(event) {
  const data = typeof event.data_json === 'string'
    ? JSON.parse(event.data_json) : (event.data_json || {});

  const type = event.type || '';
  const userId = event.user_id || '';
  const ts = event.timestamp || '';

  let content = '';
  const metadata = {
    type,
    app: '',
    screen: '',
  };

  // 타입별 정규화
  if (type === 'keyboard.chunk') {
    const win = data.windowTitle || data.appContext?.currentWindow || '';
    const app = data.app || data.appContext?.currentApp || '';
    const raw = data.rawInput || '';
    const activity = data.activity || '';
    metadata.app = app;
    metadata.screen = win;
    content = `[키입력] ${app} | ${win} | 입력: ${raw.slice(0, 200)}`;
    if (activity) content += ` | 활동: ${activity}`;

  } else if (type === 'screen.capture') {
    const win = data.windowTitle || '';
    const app = data.app || '';
    const trigger = data.trigger || '';
    metadata.app = app;
    metadata.screen = win;
    content = `[캡처] ${app} | ${win} | 트리거: ${trigger}`;

  } else if (type === 'screen.analyzed') {
    const win = data.windowTitle || '';
    const elements = data.dataVisible || '';
    const hint = data.automationHint || '';
    const automatable = data.automatable === 'true' || data.automatable === true;
    metadata.app = data.app || '';
    metadata.screen = win;
    metadata.automatable = automatable;
    content = `[Vision분석] ${win} | 요소: ${elements} | 힌트: ${hint}`;
    if (automatable) content += ' | 자동화가능';

  } else if (type === 'clipboard.change') {
    const text = data.text || '';
    const win = data.windowTitle || '';
    metadata.screen = win;
    content = `[클립보드] ${win} | 내용: ${text.slice(0, 300)}`;

  } else if (type.startsWith('kakao.')) {
    const room = data.room || data.windowTitle || '';
    const msg = data.message || data.text || '';
    metadata.app = 'kakaotalk';
    metadata.screen = room;
    content = `[카톡] ${room} | ${msg.slice(0, 300)}`;

  } else {
    const win = data.windowTitle || data.app || type;
    metadata.screen = win;
    content = `[${type}] ${win}`;
    if (data.rawInput) content += ` | ${data.rawInput.slice(0, 100)}`;
  }

  return { content, metadata };
}

// ── 문서 인덱싱 ─────────────────────────────────────────────────────────────

/**
 * 이벤트 배열을 RAG 문서로 인덱싱
 * @param {Array} events - DB 이벤트 행 배열
 * @param {string} sourceType - 'event', 'vision', 'kakao'
 * @returns {number} 인덱싱된 문서 수
 */
async function indexEvents(events, sourceType = 'event') {
  if (!_initialized) throw new Error('RAG 미초기화');
  if (!events?.length) return 0;

  let indexed = 0;
  // 배치 처리 (50개씩)
  for (let i = 0; i < events.length; i += 50) {
    const batch = events.slice(i, i + 50);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const ev of batch) {
      try {
        const { content, metadata } = normalizeEvent(ev);
        if (!content || content.length < 10) continue;

        const id = `rag-${ev.id || Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        values.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4}, $${paramIdx+5}, $${paramIdx+6}, to_tsvector('simple', $${paramIdx+4}))`);
        params.push(id, sourceType, ev.id || null, ev.user_id || null, content, JSON.stringify(metadata), ev.timestamp || new Date().toISOString());
        paramIdx += 7;
        indexed++;
      } catch {}
    }

    if (values.length === 0) continue;

    await _db.query(`
      INSERT INTO rag_documents (id, source_type, source_id, user_id, content, metadata, ts, tsv)
      VALUES ${values.join(', ')}
      ON CONFLICT (id) DO NOTHING
    `, params).catch(e => console.warn('[rag] 배치 인덱싱 실패:', e.message));
  }

  return indexed;
}

/**
 * 커스텀 문서 인덱싱 (워크플로우, nenova 데이터 등)
 */
async function indexDocument({ id, sourceType, sourceId, userId, content, metadata, ts }) {
  if (!_initialized) return;
  const docId = id || `rag-${sourceType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await _db.query(`
    INSERT INTO rag_documents (id, source_type, source_id, user_id, content, metadata, ts, tsv)
    VALUES ($1, $2, $3, $4, $5, $6, $7, to_tsvector('simple', $5))
    ON CONFLICT (id) DO UPDATE SET content = $5, metadata = $6, tsv = to_tsvector('simple', $5)
  `, [docId, sourceType, sourceId || null, userId || null, content, JSON.stringify(metadata || {}), ts || new Date().toISOString()])
    .catch(e => console.warn('[rag] 문서 인덱싱 실패:', e.message));
}

// ── 검색 ─────────────────────────────────────────────────────────────────────

/**
 * RAG 검색 (풀텍스트 + 메타데이터 필터)
 * @param {Object} opts
 * @param {string} opts.query - 검색 쿼리
 * @param {string} [opts.userId] - 사용자 격리
 * @param {string} [opts.sourceType] - 소스 필터 ('event', 'vision', 'kakao', 'workflow')
 * @param {string} [opts.app] - 앱 필터
 * @param {number} [opts.days] - 최근 N일
 * @param {number} [opts.limit] - 결과 수 (기본 10)
 * @returns {Array<{ content, metadata, ts, score }>}
 */
async function search({ query, userId, sourceType, app, days, limit = 10 }) {
  if (!_initialized) return [];
  if (!query) return [];

  // ── 캐시 확인 ──
  const cKey = _cacheKey({ query, userId, sourceType, app, days, limit });
  const cached = _cacheGet(cKey);
  if (cached) return cached;

  // 검색 쿼리 구성
  const conditions = [];
  const params = [];
  let paramIdx = 1;

  // 풀텍스트 검색 (tsquery)
  const tsQuery = query.split(/\s+/).filter(Boolean).map(w => w + ':*').join(' & ');
  conditions.push(`tsv @@ to_tsquery('simple', $${paramIdx})`);
  params.push(tsQuery);
  paramIdx++;

  // 사용자 격리
  if (userId) {
    conditions.push(`user_id = $${paramIdx}`);
    params.push(userId);
    paramIdx++;
  }

  // 소스 타입 필터
  if (sourceType) {
    conditions.push(`source_type = $${paramIdx}`);
    params.push(sourceType);
    paramIdx++;
  }

  // 앱 필터
  if (app) {
    conditions.push(`metadata->>'app' = $${paramIdx}`);
    params.push(app);
    paramIdx++;
  }

  // 시간 범위
  if (days) {
    conditions.push(`ts > NOW() - ($${paramIdx} || ' days')::INTERVAL`);
    params.push(String(days));
    paramIdx++;
  }

  // DB에서는 limit*3 가져와서 재랭킹 후 limit 반환
  const fetchLimit = Math.min(limit * 3, 150);
  params.push(fetchLimit);

  const sql = `
    SELECT content, metadata, ts,
           ts_rank(tsv, to_tsquery('simple', $1)) as score
    FROM rag_documents
    WHERE ${conditions.join(' AND ')}
    ORDER BY score DESC, ts DESC
    LIMIT $${paramIdx}
  `;

  try {
    const { rows } = await _db.query(sql, params);

    // ── 재랭킹: tsvector 점수 + n-gram 유사도 + 시간 가중치 합산 ──
    const now = Date.now();
    const ranked = rows.map(r => {
      const tsvScore   = parseFloat(r.score) || 0;
      const ngramScore = _ngramSimilarity(query, r.content);
      // 시간 가중치: 최근일수록 높음 (최대 7일 기준, 지수 감쇠)
      const ageDays    = (now - new Date(r.ts).getTime()) / 864e5;
      const timeWeight = Math.exp(-ageDays / 7);  // 7일 반감기
      // 가중 합산 (tsvector 50% + ngram 30% + time 20%)
      const combined = tsvScore * 0.5 + ngramScore * 0.3 + timeWeight * 0.2;
      return {
        content: r.content,
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
        ts: r.ts,
        score: +combined.toFixed(4),
        tsvScore: +tsvScore.toFixed(4),
        ngramScore: +ngramScore.toFixed(4),
      };
    }).sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 50));

    _cacheSet(cKey, ranked);
    return ranked;
  } catch (e) {
    console.error('[rag] 검색 실패:', e.message);
    return [];
  }
}

/**
 * 유사 맥락 검색 (현재 상황과 비슷한 과거 이벤트)
 * @param {Object} opts
 * @param {string} opts.currentState - 현재 windowTitle/앱 상태
 * @param {string} opts.userId - 사용자 ID
 * @param {number} [opts.days] - 검색 범위 (일)
 * @param {number} [opts.limit] - 결과 수
 */
async function searchSimilarContext({ currentState, userId, days = 7, limit = 10 }) {
  if (!_initialized || !currentState) return [];

  // 현재 상태에서 핵심 키워드 추출
  const keywords = currentState
    .replace(/[^가-힣a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 5);

  if (keywords.length === 0) return [];

  return search({
    query: keywords.join(' '),
    userId,
    days,
    limit,
  });
}

// ── 프롬프트 증강 ────────────────────────────────────────────────────────────

/**
 * 검색 결과를 LLM 프롬프트에 주입
 * @param {Object} opts
 * @param {string} opts.systemPrompt - 시스템 프롬프트
 * @param {string} opts.userQuery - 사용자/에이전트 질문
 * @param {Array} opts.retrievedDocs - search() 결과
 * @param {number} [opts.maxContextLen] - 컨텍스트 최대 길이 (문자)
 * @returns {string} 증강된 프롬프트
 */
function augmentPrompt({ systemPrompt, userQuery, retrievedDocs, maxContextLen = 3000 }) {
  if (!retrievedDocs?.length) {
    return `${systemPrompt}\n\n${userQuery}`;
  }

  // ── 컨텍스트 압축: 자카드 유사도 0.8 이상인 중복 청크 제거 ──
  const deduplicated = [];
  for (const doc of retrievedDocs) {
    let isDuplicate = false;
    for (const kept of deduplicated) {
      if (_jaccardSimilarity(doc.content, kept.content) >= 0.8) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) deduplicated.push(doc);
  }

  // 컨텍스트 구성 (길이 제한 내)
  let context = '';
  for (const doc of deduplicated) {
    const entry = `- ${doc.content} (${new Date(doc.ts).toLocaleString('ko-KR')})\n`;
    if (context.length + entry.length > maxContextLen) break;
    context += entry;
  }

  return `${systemPrompt}

## 관련 데이터 (RAG 검색 결과, ${deduplicated.length}건 / 원본 ${retrievedDocs.length}건)
${context}
## 질문
${userQuery}`;
}

/**
 * RAG 파이프라인: 검색 → 증강 → LLM 호출
 * @param {Object} opts
 * @param {string} opts.agent - 에이전트명 (think-engine, idea-engine 등)
 * @param {string} opts.question - 질문
 * @param {string} opts.userId - 사용자 ID
 * @param {Object} [opts.searchOpts] - 추가 검색 옵션
 * @param {Object} [opts.llmOpts] - LLM 옵션 (provider, model, apiKey)
 * @returns {{ answer: string, sources: Array, tokensUsed: number }}
 */
async function query({ agent, question, userId, searchOpts = {}, llmOpts = {} }) {
  // 1. 검색
  const docs = await search({
    query: question,
    userId,
    days: searchOpts.days || 14,
    limit: searchOpts.limit || 10,
    sourceType: searchOpts.sourceType,
    app: searchOpts.app,
  });

  // 2. 프롬프트 증강
  const systemPrompts = {
    'think-engine': '당신은 Orbit AI의 사고 엔진입니다. 사용자의 행동 패턴을 분석하고 다음 행동을 예측합니다. 관련 데이터를 참고하여 정확한 분석을 제공하세요.',
    'idea-engine': '당신은 Orbit AI의 아이디어 엔진입니다. 업무 데이터에서 자동화 기회와 개선 아이디어를 발견합니다.',
    'deep-investigator': '당신은 Orbit AI의 탐구 엔진입니다. 숨겨진 업무 패턴과 비효율을 발견합니다.',
    'business-intelligence': '당신은 Orbit AI의 BI 엔진입니다. 비즈니스 데이터를 분석하고 인사이트를 제공합니다.',
    'default': '당신은 Orbit AI의 분석 에이전트입니다. 관련 데이터를 참고하여 정확한 답변을 제공하세요.',
  };

  const prompt = augmentPrompt({
    systemPrompt: systemPrompts[agent] || systemPrompts.default,
    userQuery: question,
    retrievedDocs: docs,
    maxContextLen: searchOpts.maxContextLen || 3000,
  });

  // 3. LLM 호출
  const provider = llmOpts.provider || process.env.RAG_LLM_PROVIDER || 'ollama';
  const model = llmOpts.model || process.env.RAG_LLM_MODEL;
  const apiKey = llmOpts.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

  try {
    const answer = await generate({ provider, model, prompt, apiKey });
    return {
      answer,
      sources: docs.map(d => ({ content: d.content.slice(0, 100), ts: d.ts, score: d.score })),
      docsRetrieved: docs.length,
    };
  } catch (e) {
    return {
      answer: `[RAG 오류] LLM 호출 실패: ${e.message}`,
      sources: docs.map(d => ({ content: d.content.slice(0, 100), ts: d.ts, score: d.score })),
      docsRetrieved: docs.length,
      error: e.message,
    };
  }
}

// ── 자동 인덱싱 (백그라운드) ──────────────────────────────────────────────────

let _indexingInProgress = false;

/**
 * 최근 이벤트를 자동 인덱싱 (스케줄러에서 호출)
 * @param {Object} opts
 * @param {Function} opts.getRecentEvents - (limit) => Promise<Array>
 * @param {number} [opts.batchSize] - 배치 크기
 */
async function autoIndex({ getRecentEvents, batchSize = 200 }) {
  if (!_initialized || _indexingInProgress) return;
  _indexingInProgress = true;

  try {
    // 마지막 인덱싱 시점 조회
    const lastResult = await _db.query(
      `SELECT MAX(ts) as last_ts FROM rag_documents`
    ).catch(() => ({ rows: [{ last_ts: null }] }));

    const lastTs = lastResult.rows[0]?.last_ts;

    // 새 이벤트 조회
    let events;
    if (lastTs) {
      const { rows } = await _db.query(
        `SELECT * FROM events WHERE timestamp::timestamptz > $1 ORDER BY timestamp ASC LIMIT $2`,
        [lastTs, batchSize]
      );
      events = rows;
    } else {
      // 최초 인덱싱: 최근 7일
      const { rows } = await _db.query(
        `SELECT * FROM events WHERE timestamp::timestamptz > NOW() - INTERVAL '7 days' ORDER BY timestamp DESC LIMIT $1`,
        [batchSize]
      );
      events = rows;
    }

    if (events.length > 0) {
      const count = await indexEvents(events, 'event');
      if (count > 0) console.log(`[rag-core] ${count}개 문서 인덱싱 완료`);
    }
  } catch (e) {
    console.warn('[rag-core] 자동 인덱싱 실패:', e.message);
  } finally {
    _indexingInProgress = false;
  }
}

// ── 통계 ─────────────────────────────────────────────────────────────────────

async function getStats() {
  if (!_initialized) return { initialized: false };
  try {
    const { rows } = await _db.query(`
      SELECT
        source_type,
        COUNT(*) as doc_count,
        MIN(ts) as oldest,
        MAX(ts) as newest
      FROM rag_documents
      GROUP BY source_type
      ORDER BY doc_count DESC
    `);
    const total = rows.reduce((s, r) => s + parseInt(r.doc_count), 0);
    return {
      initialized: true, total, bySource: rows,
      cache: { size: _searchCache.size, ttlMs: CACHE_TTL_MS },
    };
  } catch (e) {
    return { initialized: true, error: e.message };
  }
}

/** 검색 캐시 수동 초기화 */
function clearCache() {
  _searchCache.clear();
  console.log('[rag-core] 캐시 초기화');
}

// ── 정리 (오래된 문서 삭제) ──────────────────────────────────────────────────

async function cleanup({ maxAgeDays = 90 } = {}) {
  if (!_initialized) return 0;
  try {
    const { rowCount } = await _db.query(
      `DELETE FROM rag_documents WHERE ts < NOW() - ($1 || ' days')::INTERVAL`,
      [String(maxAgeDays)]
    );
    if (rowCount > 0) console.log(`[rag-core] ${rowCount}개 오래된 문서 삭제`);
    return rowCount;
  } catch (e) {
    console.warn('[rag-core] 정리 실패:', e.message);
    return 0;
  }
}

module.exports = {
  init,
  normalizeEvent,
  indexEvents,
  indexDocument,
  search,
  searchSimilarContext,
  augmentPrompt,
  query,
  autoIndex,
  getStats,
  cleanup,
  clearCache,
};
