'use strict';
/**
 * mssql-pool.js — nenova SQL Server 공유 커넥션 풀 (싱글톤)
 *
 * 5개 라우트가 각각 풀을 생성하던 것을 1개로 통합.
 * 메모리 절약 + 연결 수 제한.
 */

let sql;
try {
  sql = require('mssql');
} catch {
  sql = null;
}

const MSSQL_CONFIG = {
  server: 'sql16ssd-014.localnet.kr',
  port: 1433,
  database: 'nenova1_nenova',
  user: 'nenova1_nenova',
  password: process.env.NENOVA_DB_PASSWORD || '',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    requestTimeout: 30000,
  },
  pool: {
    max: 5,   // 5개 라우트 공유 → 최대 5 연결
    min: 0,
    idleTimeoutMillis: 60000,
  },
};

let _pool = null;
let _poolPromise = null;
let _lastError = null;

function validateReadOnly(query) {
  const normalized = query.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'EXEC', 'EXECUTE', 'MERGE'];
  for (const keyword of forbidden) {
    if (normalized.startsWith(keyword)) {
      throw new Error(`[보안] nenova DB에 ${keyword} 쿼리 실행 금지! 읽기 전용입니다.`);
    }
  }
}

async function getPool() {
  if (!sql) throw new Error('mssql 패키지 미설치');
  if (!process.env.NENOVA_DB_PASSWORD) throw new Error('NENOVA_DB_PASSWORD 미설정');
  if (_pool && _pool.connected) return _pool;
  if (_poolPromise) return _poolPromise;

  _poolPromise = (async () => {
    try {
      _pool = await new sql.ConnectionPool(MSSQL_CONFIG).connect();
      _lastError = null;
      console.log('[mssql-pool] SQL Server 연결 성공 (공유 풀)');
      _pool.on('error', (err) => {
        console.error('[mssql-pool] 풀 에러:', err.message);
        _lastError = err.message;
        _pool = null;
      });
      return _pool;
    } catch (err) {
      _lastError = err.message;
      _pool = null;
      throw err;
    } finally {
      _poolPromise = null;
    }
  })();

  return _poolPromise;
}

async function safeQuery(queryFn) {
  try {
    const pool = await getPool();
    const originalRequest = pool.request.bind(pool);
    const safePool = Object.create(pool);
    safePool.request = function() {
      const req = originalRequest();
      const originalQuery = req.query.bind(req);
      req.query = function(queryStr) {
        validateReadOnly(queryStr);
        return originalQuery(queryStr);
      };
      return req;
    };
    return await queryFn(safePool);
  } catch (err) {
    _lastError = err.message;
    throw err;
  }
}

module.exports = { sql, getPool, safeQuery, validateReadOnly, getLastError: () => _lastError, MSSQL_CONFIG };
