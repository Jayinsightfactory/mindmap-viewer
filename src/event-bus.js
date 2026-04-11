'use strict';
/**
 * src/event-bus.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 통합 이벤트 버스 코어
 *
 * PG LISTEN/NOTIFY 기반 + 인메모리 SSE 클라이언트 관리
 * 4개 시스템(ERP, Orbit, AI Trainer, nenova_agent)의 이벤트를 통합 수집/배포
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { ulid } = require('ulid');
const { Client } = require('pg');

const VALID_SOURCES = new Set(['erp-ui', 'orbit', 'ai-trainer', 'nenova-agent']);
const PG_CHANNEL = 'unified_events';

// SSE 구독자 관리
const _sseClients = new Set();
let _pgListener = null;
let _pool = null;

/**
 * 이벤트 버스 초기화
 * @param {import('pg').Pool} pool - PostgreSQL 연결 풀
 */
async function init(pool) {
  _pool = pool;
  await _startPgListener();
  console.log('[EventBus] 초기화 완료 (PG LISTEN + SSE)');
}

/**
 * PG LISTEN 시작 — 별도 연결로 NOTIFY 수신
 */
async function _startPgListener() {
  if (!process.env.DATABASE_URL) return;

  _pgListener = new Client({ connectionString: process.env.DATABASE_URL });
  await _pgListener.connect();
  await _pgListener.query(`LISTEN ${PG_CHANNEL}`);

  _pgListener.on('notification', (msg) => {
    if (msg.channel !== PG_CHANNEL) return;
    try {
      const event = JSON.parse(msg.payload);
      _broadcastToSSE(event);
    } catch (e) {
      console.warn('[EventBus] NOTIFY 파싱 실패:', e.message);
    }
  });

  _pgListener.on('error', (err) => {
    console.error('[EventBus] PG Listener 오류:', err.message);
    // 재연결 시도
    setTimeout(() => _startPgListener().catch(e =>
      console.error('[EventBus] PG Listener 재연결 실패:', e.message)
    ), 5000);
  });

  console.log('[EventBus] PG LISTEN 시작');
}

/**
 * 이벤트 발행 — DB 저장 + PG NOTIFY (트리거가 자동 발행)
 * @param {object} event - 이벤트 객체
 * @returns {object} 저장된 이벤트
 */
async function publish(event) {
  if (!_pool) throw new Error('EventBus not initialized');

  const id = event.id || ulid();
  const source = event.source || 'orbit';
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Invalid source: ${source}. Must be one of: ${[...VALID_SOURCES].join(', ')}`);
  }
  if (!event.type) throw new Error('Event type is required');

  const row = {
    id,
    type: event.type,
    source,
    timestamp: event.timestamp || new Date().toISOString(),
    user_id: event.user_id || null,
    workspace_id: event.workspace_id || 'nenova',
    session_id: event.session_id || null,
    data: event.data || {},
    metadata: event.metadata || {},
    correlation_id: event.correlation_id || null,
  };

  await _pool.query(`
    INSERT INTO unified_events (id, type, source, timestamp, user_id, workspace_id, session_id, data, metadata, correlation_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  `, [row.id, row.type, row.source, row.timestamp, row.user_id, row.workspace_id,
      row.session_id, JSON.stringify(row.data), JSON.stringify(row.metadata), row.correlation_id]);

  return row;
}

/**
 * 이벤트 조회
 * @param {object} filters
 * @returns {Array} 이벤트 목록
 */
async function query(filters = {}) {
  if (!_pool) throw new Error('EventBus not initialized');

  const conditions = ['1=1'];
  const params = [];
  let paramIdx = 1;

  if (filters.type) {
    // type prefix 매칭: "erp.*" → "erp.%"
    if (filters.type.endsWith('.*')) {
      conditions.push(`type LIKE $${paramIdx++}`);
      params.push(filters.type.replace('.*', '.%'));
    } else {
      conditions.push(`type = $${paramIdx++}`);
      params.push(filters.type);
    }
  }
  if (filters.source) {
    conditions.push(`source = $${paramIdx++}`);
    params.push(filters.source);
  }
  if (filters.user_id) {
    conditions.push(`user_id = $${paramIdx++}`);
    params.push(filters.user_id);
  }
  if (filters.correlation_id) {
    conditions.push(`correlation_id = $${paramIdx++}`);
    params.push(filters.correlation_id);
  }
  if (filters.since) {
    conditions.push(`timestamp >= $${paramIdx++}`);
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push(`timestamp <= $${paramIdx++}`);
    params.push(filters.until);
  }

  const limit = Math.min(parseInt(filters.limit) || 100, 1000);
  const offset = parseInt(filters.offset) || 0;

  const { rows } = await _pool.query(`
    SELECT * FROM unified_events
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `, params);

  return rows;
}

/**
 * SSE 클라이언트 등록
 */
function addSSEClient(res, filters = {}) {
  const client = { res, filters, id: ulid() };
  _sseClients.add(client);

  res.on('close', () => {
    _sseClients.delete(client);
  });

  // 초기 연결 확인 메시지
  res.write(`data: ${JSON.stringify({ type: 'connected', id: client.id })}\n\n`);

  return client.id;
}

/**
 * SSE 브로드캐스트 — 필터 매칭되는 클라이언트에만 전송
 */
function _broadcastToSSE(event) {
  for (const client of _sseClients) {
    try {
      const f = client.filters;
      // 필터 매칭
      if (f.source && f.source !== event.source) continue;
      if (f.type) {
        if (f.type.endsWith('.*')) {
          const prefix = f.type.replace('.*', '.');
          if (!event.type.startsWith(prefix)) continue;
        } else if (f.type !== event.type) continue;
      }
      if (f.user_id && f.user_id !== event.user_id) continue;

      client.res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (e) {
      _sseClients.delete(client);
    }
  }
}

/**
 * 통계 조회
 */
async function stats() {
  if (!_pool) return { total: 0, sources: {}, types: {} };

  const [totalRes, sourceRes, typeRes] = await Promise.all([
    _pool.query('SELECT COUNT(*) as cnt FROM unified_events'),
    _pool.query('SELECT source, COUNT(*) as cnt FROM unified_events GROUP BY source'),
    _pool.query(`SELECT type, COUNT(*) as cnt FROM unified_events GROUP BY type ORDER BY cnt DESC LIMIT 20`),
  ]);

  return {
    total: parseInt(totalRes.rows[0]?.cnt || 0),
    sources: Object.fromEntries(sourceRes.rows.map(r => [r.source, parseInt(r.cnt)])),
    types: Object.fromEntries(typeRes.rows.map(r => [r.type, parseInt(r.cnt)])),
  };
}

/** SSE 클라이언트 수 */
function clientCount() {
  return _sseClients.size;
}

/** 정리 */
async function shutdown() {
  if (_pgListener) {
    await _pgListener.end().catch(() => {});
    _pgListener = null;
  }
  for (const client of _sseClients) {
    try { client.res.end(); } catch {}
  }
  _sseClients.clear();
}

module.exports = { init, publish, query, addSSEClient, stats, clientCount, shutdown, VALID_SOURCES };
