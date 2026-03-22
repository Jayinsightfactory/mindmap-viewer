'use strict';
/**
 * routes/nenova-cross-analysis.js
 * ─────────────────────────────────────────────────────────────────────────────
 * nenova SQL Server + Orbit PostgreSQL 교차 분석
 *
 * 목적 3가지:
 *   1. 데이터 일치 확인: Orbit 수집 데이터(키로거/캡처/파서) ↔ nenova 실제 DB 대조
 *   2. 직원 사용 패턴 파악: 어떤 기능을 얼마나 쓰는지, 뭐가 필요한지
 *   3. Orbit OS 구조 설계: 분석 결과로 OS 인터페이스 우선순위 결정
 *
 * ⚠️ 절대 규칙: nenova SQL Server에는 SELECT만 실행한다.
 *   INSERT / UPDATE / DELETE / ALTER / DROP 절대 금지!
 *
 * 엔드포인트:
 *   # 데이터 일치 검증
 *   GET  /api/cross/verify/orders      — Orbit parsed_orders vs nenova OrderDetail
 *   GET  /api/cross/verify/products    — Orbit master_products vs nenova Product
 *   GET  /api/cross/verify/customers   — Orbit master_customers vs nenova Customer
 *   GET  /api/cross/verify/summary     — 전체 검증 요약
 *
 *   # 직원 사용 패턴 분석
 *   GET  /api/cross/usage/screens      — 직원별 전산 화면 사용 빈도
 *   GET  /api/cross/usage/features     — 기능별 사용 빈도
 *   GET  /api/cross/usage/timeline     — 시간대별 기능 사용 패턴
 *   GET  /api/cross/usage/efficiency   — 직원별 작업 효율
 *   GET  /api/cross/usage/needs        — TOP 10 기능 + 개선 필요 영역
 *
 *   # 데이터 흐름 추적
 *   GET  /api/cross/flow/order-entry   — 주문 입력 흐름 (카톡→클립보드→파서→전산)
 *   GET  /api/cross/flow/daily         — 오늘 데이터 흐름 요약
 *   GET  /api/cross/flow/gaps          — 데이터 누락 감지
 *
 *   # Orbit OS 설계 인사이트
 *   GET  /api/cross/insights/priority  — 기능 우선순위 추천
 *   GET  /api/cross/insights/automation — 자동화 기회 발견
 *   GET  /api/cross/insights/report    — 종합 분석 리포트
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// SQL Server 연결 설정 (nenova-db.js와 동일 패턴, 자체 포함)
// ═══════════════════════════════════════════════════════════════════════════

let sql;
try {
  sql = require('mssql');
} catch (e) {
  console.warn('[cross-analysis] mssql 패키지 미설치 — npm install mssql 필요');
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
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

// ── 커넥션 풀 싱글톤 ──
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
  if (!sql) throw new Error('mssql 패키지가 설치되지 않았습니다. npm install mssql');
  if (!process.env.NENOVA_DB_PASSWORD) {
    throw new Error('NENOVA_DB_PASSWORD 환경변수가 설정되지 않았습니다');
  }
  if (_pool && _pool.connected) return _pool;
  if (_poolPromise) return _poolPromise;

  _poolPromise = (async () => {
    try {
      _pool = await new sql.ConnectionPool(MSSQL_CONFIG).connect();
      _lastError = null;
      console.log('[cross-analysis] SQL Server 연결 성공');
      _pool.on('error', (err) => {
        console.error('[cross-analysis] 풀 에러:', err.message);
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

// ═══════════════════════════════════════════════════════════════════════════
// 라우터 팩토리
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createCrossAnalysisRouter({ getDb }) {
  const router = express.Router();

  // ── Orbit PostgreSQL 헬퍼 ──
  function getOrbitDb() {
    const db = getDb();
    if (!db || !db.query) throw new Error('Orbit PostgreSQL DB를 사용할 수 없습니다');
    return db;
  }

  // ── 공통 에러 핸들러 ──
  function handleError(res, err, context) {
    console.error(`[cross-analysis] ${context}:`, err.message);
    if (err.message.includes('NENOVA_DB_PASSWORD') || err.message.includes('mssql')) {
      return res.status(503).json({
        ok: false,
        error: err.message,
        hint: 'nenova DB 연결 설정을 확인하세요',
      });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }

  // ── 날짜 헬퍼 ──
  function todayKST() {
    const now = new Date();
    // KST = UTC + 9
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().split('T')[0]; // "2026-03-22"
  }

  function todayStartKST() {
    return todayKST() + 'T00:00:00+09:00';
  }

  function todayEndKST() {
    return todayKST() + 'T23:59:59+09:00';
  }

  // ── nenova 화면 분류 맵 ──
  const SCREEN_CATEGORIES = {
    '신규 주문': { keywords: ['신규 주문', '주문 등록', '주문등록', 'new order', 'order entry'], feature: 'order_entry' },
    '주문 관리': { keywords: ['주문 관리', '주문관리', '주문 조회', '주문조회', 'order manage', 'order list'], feature: 'order_manage' },
    '출하 관리': { keywords: ['출하', '출하 관리', '출하관리', '출하 조회', '출하조회', 'shipment'], feature: 'shipment' },
    '재고 관리': { keywords: ['재고', '재고 관리', '재고관리', '재고 조회', '재고조회', 'stock', 'inventory'], feature: 'inventory' },
    '견적 관리': { keywords: ['견적', '견적서', '견적 관리', '견적관리', 'estimate', 'quotation'], feature: 'estimate' },
    '거래처 관리': { keywords: ['거래처', '고객', '고객 관리', '고객관리', 'customer'], feature: 'customer' },
    '상품 관리': { keywords: ['상품', '상품 관리', '상품관리', '품목', 'product'], feature: 'product' },
    '매출 분석': { keywords: ['매출', '분석', '리포트', '통계', 'sales', 'report', 'analysis'], feature: 'sales_analysis' },
    '정산 관리': { keywords: ['정산', '대금', '결제', '입금', 'payment', 'settlement'], feature: 'settlement' },
    '기타 전산': { keywords: ['nenova', '화훼', '네노바'], feature: 'other' },
  };

  /**
   * windowTitle에서 화면 카테고리를 추출
   */
  function classifyScreen(windowTitle) {
    if (!windowTitle) return null;
    const lower = windowTitle.toLowerCase();

    for (const [category, config] of Object.entries(SCREEN_CATEGORIES)) {
      for (const keyword of config.keywords) {
        if (lower.includes(keyword.toLowerCase())) {
          return { category, feature: config.feature };
        }
      }
    }

    // nenova 또는 화훼 키워드 포함 시 기타 전산
    if (lower.includes('nenova') || lower.includes('화훼') || lower.includes('네노바')) {
      return { category: '기타 전산', feature: 'other' };
    }

    return null;
  }

  // ── 교차 분석 테이블 초기화 ──
  async function ensureCrossTables() {
    const db = getOrbitDb();

    await db.query(`
      CREATE TABLE IF NOT EXISTS cross_analysis_cache (
        id SERIAL PRIMARY KEY,
        analysis_type TEXT NOT NULL,
        analysis_key TEXT,
        result_json JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '1 hour'),
        UNIQUE(analysis_type, analysis_key)
      )
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_cac_type ON cross_analysis_cache(analysis_type)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_cac_expires ON cross_analysis_cache(expires_at)`);
  }

  // 초기화 (실패해도 서버 시작에 영향 없음)
  try {
    const db = getDb();
    if (db && db.query) {
      ensureCrossTables().catch(e => console.warn('[cross-analysis] 캐시 테이블 초기화 실패:', e.message));
    }
  } catch (_) { /* DB 미연결 시 무시 */ }


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     1. 데이터 일치 검증
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/cross/verify/orders
   * Orbit parsed_orders vs nenova OrderDetail 매칭
   * ?date=2026-03-22 &week=13 &year=2026 &limit=100
   */
  router.get('/verify/orders', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const { date, week, year } = req.query;
      const limit = Math.min(parseInt(req.query.limit) || 100, 500);

      // ── 1) Orbit parsed_orders 조회 ──
      let orbitWhere = [];
      let orbitParams = [];
      let paramIdx = 1;

      if (date) {
        orbitWhere.push(`order_date::DATE = $${paramIdx}::DATE`);
        orbitParams.push(date);
        paramIdx++;
      }
      if (week) {
        orbitWhere.push(`order_week LIKE $${paramIdx}`);
        orbitParams.push(`${week}%`);
        paramIdx++;
      }
      if (year) {
        orbitWhere.push(`order_year = $${paramIdx}`);
        orbitParams.push(parseInt(year));
        paramIdx++;
      }

      const orbitWhereClause = orbitWhere.length > 0 ? 'WHERE ' + orbitWhere.join(' AND ') : '';

      const orbitOrders = await orbitDb.query(`
        SELECT id, source_type, nenova_order_key, nenova_detail_key,
               customer, product, quantity, unit, action, raw_text,
               confidence, order_week, order_year, order_date, synced_at
        FROM parsed_orders
        ${orbitWhereClause}
        ORDER BY order_date DESC NULLS LAST
        LIMIT ${limit}
      `, orbitParams);

      // ── 2) nenova OrderDetail 조회 (같은 필터) ──
      const nenovaOrders = await safeQuery(async (pool) => {
        const r = pool.request();
        let where = ['ISNULL(om.isDeleted, 0) = 0', 'ISNULL(od.isDeleted, 0) = 0'];

        if (date) {
          r.input('date', sql.Date, new Date(date));
          where.push('CAST(om.OrderDtm AS DATE) = @date');
        }
        if (week) {
          r.input('week', sql.NVarChar, `${week}%`);
          where.push('om.OrderWeek LIKE @week');
        }
        if (year) {
          r.input('year', sql.Int, parseInt(year));
          where.push('om.OrderYear = @year');
        }

        const data = await r.query(`
          SELECT TOP ${limit}
            od.OrderDetailKey,
            om.OrderMasterKey,
            om.OrderDtm,
            om.OrderWeek,
            om.OrderYear,
            om.OrderCode,
            c.CustName,
            od.ProdKey,
            p.ProdName,
            p.FlowerName,
            p.CounName,
            od.BoxQuantity,
            od.BunchQuantity,
            od.SteamQuantity
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          JOIN Product p ON od.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON om.CustKey = c.CustKey
          WHERE ${where.join(' AND ')}
          ORDER BY om.OrderDtm DESC, od.OrderDetailKey
        `);

        return data.recordset;
      });

      // ── 3) 매칭 로직 ──
      const matched = [];
      const orbitOnly = [];
      const nenovaOnly = [];
      const mismatches = [];

      // nenova 데이터를 DetailKey 기반으로 인덱싱
      const nenovaMap = new Map();
      for (const n of nenovaOrders) {
        nenovaMap.set(n.OrderDetailKey, n);
      }

      // Orbit 데이터 중 nenova_detail_key가 있는 것은 직접 매칭
      const matchedNenovaKeys = new Set();

      for (const o of orbitOrders.rows) {
        if (o.nenova_detail_key && nenovaMap.has(o.nenova_detail_key)) {
          const n = nenovaMap.get(o.nenova_detail_key);
          matchedNenovaKeys.add(o.nenova_detail_key);

          // 수량 비교
          const qtyMatch = Math.abs((o.quantity || 0) - (n.BoxQuantity || 0)) < 0.01;
          const customerMatch = (o.customer || '').trim() === (n.CustName || '').trim();

          if (qtyMatch && customerMatch) {
            matched.push({
              orbitId: o.id,
              nenovaDetailKey: n.OrderDetailKey,
              customer: n.CustName,
              product: n.ProdName,
              orbitQty: o.quantity,
              nenovaQty: n.BoxQuantity,
              date: n.OrderDtm,
            });
          } else {
            mismatches.push({
              orbitId: o.id,
              nenovaDetailKey: n.OrderDetailKey,
              field: !qtyMatch ? 'quantity' : 'customer',
              orbitValue: !qtyMatch ? o.quantity : o.customer,
              nenovaValue: !qtyMatch ? n.BoxQuantity : n.CustName,
              customer: n.CustName,
              product: n.ProdName,
            });
          }
        } else if (!o.nenova_detail_key) {
          // nenova_detail_key 없는 Orbit 데이터 — 날짜+품목명+수량으로 유사 매칭 시도
          let fuzzyMatched = false;
          for (const [key, n] of nenovaMap) {
            if (matchedNenovaKeys.has(key)) continue;

            const sameDate = o.order_date && n.OrderDtm &&
              new Date(o.order_date).toDateString() === new Date(n.OrderDtm).toDateString();
            const similarProduct = o.product && n.ProdName &&
              o.product.toLowerCase().includes(n.ProdName.toLowerCase().substring(0, 5));
            const similarQty = Math.abs((o.quantity || 0) - (n.BoxQuantity || 0)) < 1;

            if (sameDate && (similarProduct || similarQty)) {
              matchedNenovaKeys.add(key);
              matched.push({
                orbitId: o.id,
                nenovaDetailKey: n.OrderDetailKey,
                matchType: 'fuzzy',
                customer: n.CustName,
                product: n.ProdName,
                orbitQty: o.quantity,
                nenovaQty: n.BoxQuantity,
                date: n.OrderDtm,
              });
              fuzzyMatched = true;
              break;
            }
          }

          if (!fuzzyMatched) {
            orbitOnly.push({
              orbitId: o.id,
              customer: o.customer,
              product: o.product,
              quantity: o.quantity,
              date: o.order_date,
              source: o.source_type,
            });
          }
        } else {
          // nenova_detail_key가 있지만 nenova에서 못 찾음
          orbitOnly.push({
            orbitId: o.id,
            nenovaDetailKey: o.nenova_detail_key,
            customer: o.customer,
            product: o.product,
            quantity: o.quantity,
            date: o.order_date,
            note: 'nenova에서 해당 키 미발견 (삭제되었거나 필터 범위 밖)',
          });
        }
      }

      // nenova에만 있는 데이터
      for (const [key, n] of nenovaMap) {
        if (!matchedNenovaKeys.has(key)) {
          nenovaOnly.push({
            nenovaDetailKey: n.OrderDetailKey,
            orderMasterKey: n.OrderMasterKey,
            customer: n.CustName,
            product: n.ProdName,
            boxQty: n.BoxQuantity,
            date: n.OrderDtm,
            week: n.OrderWeek,
          });
        }
      }

      const totalCompared = matched.length + mismatches.length + orbitOnly.length + nenovaOnly.length;
      const accuracy = totalCompared > 0 ? Math.round((matched.length / totalCompared) * 10000) / 100 : 0;

      res.json({
        ok: true,
        verify: 'orders',
        summary: {
          orbitTotal: orbitOrders.rows.length,
          nenovaTotal: nenovaOrders.length,
          matched: matched.length,
          mismatches: mismatches.length,
          orbitOnly: orbitOnly.length,
          nenovaOnly: nenovaOnly.length,
          accuracy: `${accuracy}%`,
        },
        matched: matched.slice(0, 20),
        mismatches,
        orbitOnly: orbitOnly.slice(0, 20),
        nenovaOnly: nenovaOnly.slice(0, 20),
        filters: { date, week, year, limit },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'verify/orders');
    }
  });


  /**
   * GET /api/cross/verify/products
   * Orbit master_products vs nenova Product 일치율
   */
  router.get('/verify/products', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // Orbit master_products
      const orbitProducts = await orbitDb.query(`
        SELECT id, nenova_key, name, flower_name, country, category, synced_at
        FROM master_products
        ORDER BY nenova_key
      `);

      // nenova Product 전체 건수 + 샘플
      const nenovaResult = await safeQuery(async (pool) => {
        const total = await pool.request().query(`SELECT COUNT(*) AS cnt FROM Product`);
        const sample = await pool.request().query(`
          SELECT TOP 50 ProdKey, ProdName, FlowerName, CounName
          FROM Product
          ORDER BY ProdKey DESC
        `);
        return {
          total: total.recordset[0].cnt,
          recentSample: sample.recordset,
        };
      });

      // 매칭 분석
      const orbitByKey = new Map();
      for (const p of orbitProducts.rows) {
        if (p.nenova_key) orbitByKey.set(p.nenova_key, p);
      }

      let matchedCount = 0;
      let nameMatchCount = 0;
      const nameMismatches = [];

      for (const n of nenovaResult.recentSample) {
        if (orbitByKey.has(n.ProdKey)) {
          matchedCount++;
          const o = orbitByKey.get(n.ProdKey);
          // 이름 일치 확인
          if ((o.name || '').trim() !== (n.ProdName || '').trim()) {
            nameMismatches.push({
              nenovaKey: n.ProdKey,
              orbitName: o.name,
              nenovaName: n.ProdName,
              lastSynced: o.synced_at,
            });
          } else {
            nameMatchCount++;
          }
        }
      }

      const syncRate = nenovaResult.total > 0
        ? Math.round((orbitProducts.rows.length / nenovaResult.total) * 10000) / 100
        : 0;

      const nameAccuracy = matchedCount > 0
        ? Math.round((nameMatchCount / matchedCount) * 10000) / 100
        : 0;

      res.json({
        ok: true,
        verify: 'products',
        summary: {
          nenovaTotal: nenovaResult.total,
          orbitTotal: orbitProducts.rows.length,
          syncRate: `${syncRate}%`,
          sampleMatched: matchedCount,
          sampleNameAccuracy: `${nameAccuracy}%`,
          nameMismatches: nameMismatches.length,
          missing: nenovaResult.total - orbitProducts.rows.length,
        },
        nameMismatches: nameMismatches.slice(0, 20),
        lastSyncedProducts: orbitProducts.rows
          .filter(p => p.synced_at)
          .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
          .slice(0, 5)
          .map(p => ({ nenovaKey: p.nenova_key, name: p.name, synced: p.synced_at })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'verify/products');
    }
  });


  /**
   * GET /api/cross/verify/customers
   * Orbit master_customers vs nenova Customer 일치율
   */
  router.get('/verify/customers', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // Orbit master_customers
      const orbitCustomers = await orbitDb.query(`
        SELECT id, nenova_key, name, region, contact, synced_at
        FROM master_customers
        ORDER BY nenova_key
      `);

      // nenova Customer 전체 건수 + 샘플
      const nenovaResult = await safeQuery(async (pool) => {
        const total = await pool.request().query(`SELECT COUNT(*) AS cnt FROM Customer`);
        const sample = await pool.request().query(`
          SELECT TOP 50 CustKey, CustName
          FROM Customer
          ORDER BY CustKey DESC
        `);
        return {
          total: total.recordset[0].cnt,
          recentSample: sample.recordset,
        };
      });

      // 매칭 분석
      const orbitByKey = new Map();
      for (const c of orbitCustomers.rows) {
        if (c.nenova_key) orbitByKey.set(c.nenova_key, c);
      }

      let matchedCount = 0;
      let nameMatchCount = 0;
      const nameMismatches = [];

      for (const n of nenovaResult.recentSample) {
        if (orbitByKey.has(n.CustKey)) {
          matchedCount++;
          const o = orbitByKey.get(n.CustKey);
          if ((o.name || '').trim() !== (n.CustName || '').trim()) {
            nameMismatches.push({
              nenovaKey: n.CustKey,
              orbitName: o.name,
              nenovaName: n.CustName,
              lastSynced: o.synced_at,
            });
          } else {
            nameMatchCount++;
          }
        }
      }

      const syncRate = nenovaResult.total > 0
        ? Math.round((orbitCustomers.rows.length / nenovaResult.total) * 10000) / 100
        : 0;

      const nameAccuracy = matchedCount > 0
        ? Math.round((nameMatchCount / matchedCount) * 10000) / 100
        : 0;

      res.json({
        ok: true,
        verify: 'customers',
        summary: {
          nenovaTotal: nenovaResult.total,
          orbitTotal: orbitCustomers.rows.length,
          syncRate: `${syncRate}%`,
          sampleMatched: matchedCount,
          sampleNameAccuracy: `${nameAccuracy}%`,
          nameMismatches: nameMismatches.length,
          missing: nenovaResult.total - orbitCustomers.rows.length,
        },
        nameMismatches: nameMismatches.slice(0, 20),
        lastSyncedCustomers: orbitCustomers.rows
          .filter(c => c.synced_at)
          .sort((a, b) => new Date(b.synced_at) - new Date(a.synced_at))
          .slice(0, 5)
          .map(c => ({ nenovaKey: c.nenova_key, name: c.name, synced: c.synced_at })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'verify/customers');
    }
  });


  /**
   * GET /api/cross/verify/summary
   * 전체 검증 요약 (일치율, 누락, 불일치)
   */
  router.get('/verify/summary', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();

      // Orbit 데이터 카운트 (병렬)
      const [orbitProducts, orbitCustomers, orbitOrders] = await Promise.all([
        orbitDb.query('SELECT COUNT(*) AS cnt FROM master_products').catch(() => ({ rows: [{ cnt: 0 }] })),
        orbitDb.query('SELECT COUNT(*) AS cnt FROM master_customers').catch(() => ({ rows: [{ cnt: 0 }] })),
        orbitDb.query('SELECT COUNT(*) AS cnt FROM parsed_orders').catch(() => ({ rows: [{ cnt: 0 }] })),
      ]);

      // nenova 데이터 카운트 (병렬)
      const nenovaCounts = await safeQuery(async (pool) => {
        const [products, customers, orders, orderDetails] = await Promise.all([
          pool.request().query('SELECT COUNT(*) AS cnt FROM Product'),
          pool.request().query('SELECT COUNT(*) AS cnt FROM Customer'),
          pool.request().query(`SELECT COUNT(*) AS cnt FROM OrderMaster WHERE ISNULL(isDeleted, 0) = 0`),
          pool.request().query(`SELECT COUNT(*) AS cnt FROM OrderDetail WHERE ISNULL(isDeleted, 0) = 0`),
        ]);
        return {
          products: products.recordset[0].cnt,
          customers: customers.recordset[0].cnt,
          orders: orders.recordset[0].cnt,
          orderDetails: orderDetails.recordset[0].cnt,
        };
      });

      // 동기화된 parsed_orders 중 nenova 키가 있는 건 수
      const syncedOrders = await orbitDb.query(
        'SELECT COUNT(*) AS cnt FROM parsed_orders WHERE nenova_detail_key IS NOT NULL'
      ).catch(() => ({ rows: [{ cnt: 0 }] }));

      // 최근 동기화 시간
      const lastSync = await orbitDb.query(`
        SELECT
          (SELECT MAX(synced_at) FROM master_products) AS products_last_sync,
          (SELECT MAX(synced_at) FROM master_customers) AS customers_last_sync,
          (SELECT MAX(synced_at) FROM parsed_orders WHERE source_type = 'nenova_sync') AS orders_last_sync
      `).catch(() => ({ rows: [{}] }));

      const oP = parseInt(orbitProducts.rows[0].cnt) || 0;
      const oC = parseInt(orbitCustomers.rows[0].cnt) || 0;
      const oO = parseInt(orbitOrders.rows[0].cnt) || 0;
      const sO = parseInt(syncedOrders.rows[0].cnt) || 0;
      const nP = nenovaCounts.products;
      const nC = nenovaCounts.customers;
      const nOD = nenovaCounts.orderDetails;

      const productSync = nP > 0 ? Math.round((oP / nP) * 10000) / 100 : 0;
      const customerSync = nC > 0 ? Math.round((oC / nC) * 10000) / 100 : 0;
      const orderSync = nOD > 0 ? Math.round((sO / nOD) * 10000) / 100 : 0;
      const overallSync = (productSync + customerSync + orderSync) / 3;

      res.json({
        ok: true,
        verify: 'summary',
        overall: {
          syncScore: `${Math.round(overallSync * 100) / 100}%`,
          status: overallSync > 90 ? 'excellent' : overallSync > 70 ? 'good' : overallSync > 50 ? 'fair' : 'needs_sync',
        },
        details: {
          products: {
            orbit: oP,
            nenova: nP,
            syncRate: `${productSync}%`,
            missing: Math.max(0, nP - oP),
            lastSync: lastSync.rows[0]?.products_last_sync || null,
          },
          customers: {
            orbit: oC,
            nenova: nC,
            syncRate: `${customerSync}%`,
            missing: Math.max(0, nC - oC),
            lastSync: lastSync.rows[0]?.customers_last_sync || null,
          },
          orders: {
            orbitTotal: oO,
            orbitSynced: sO,
            nenovaDetails: nOD,
            nenovaMasters: nenovaCounts.orders,
            syncRate: `${orderSync}%`,
            lastSync: lastSync.rows[0]?.orders_last_sync || null,
          },
        },
        recommendations: [
          ...(productSync < 100 ? [`상품 동기화 필요: ${nP - oP}건 누락 — POST /api/nenova/sync/products`] : []),
          ...(customerSync < 100 ? [`거래처 동기화 필요: ${nC - oC}건 누락 — POST /api/nenova/sync/customers`] : []),
          ...(orderSync < 50 ? [`주문 동기화 필요: ${nOD - sO}건 미동기화 — POST /api/nenova/sync/orders`] : []),
        ],
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'verify/summary');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     2. 직원 사용 패턴 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/cross/usage/screens
   * 직원별 전산 화면 사용 빈도 (windowTitle 분석)
   * ?days=7 &userId=...
   */
  router.get('/usage/screens', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 7, 90);
      const userId = req.query.userId || null;

      // Orbit events에서 windowTitle 포함 이벤트 조회
      let params = [days];
      let userFilter = '';
      if (userId) {
        userFilter = 'AND user_id = $2';
        params.push(userId);
      }

      const events = await orbitDb.query(`
        SELECT
          user_id,
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          type,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND (
            data_json->>'windowTitle' IS NOT NULL
            OR data_json->>'currentApp' IS NOT NULL
          )
          ${userFilter}
        ORDER BY timestamp DESC
        LIMIT 10000
      `, params);

      // 화면별 집계
      const screenUsage = {};
      const userScreens = {};

      for (const e of events.rows) {
        const title = e.window_title || e.current_app || '';
        const classification = classifyScreen(title);
        if (!classification) continue;

        const { category } = classification;

        // 전체 화면 집계
        if (!screenUsage[category]) {
          screenUsage[category] = { count: 0, users: new Set(), timestamps: [] };
        }
        screenUsage[category].count++;
        screenUsage[category].users.add(e.user_id);
        screenUsage[category].timestamps.push(e.timestamp);

        // 직원별 화면 집계
        const uid = e.user_id;
        if (!userScreens[uid]) userScreens[uid] = {};
        if (!userScreens[uid][category]) userScreens[uid][category] = 0;
        userScreens[uid][category]++;
      }

      // 결과 정리
      const screens = Object.entries(screenUsage)
        .map(([screen, data]) => ({
          screen,
          totalEvents: data.count,
          uniqueUsers: data.users.size,
          userList: [...data.users],
          firstSeen: data.timestamps[data.timestamps.length - 1],
          lastSeen: data.timestamps[0],
        }))
        .sort((a, b) => b.totalEvents - a.totalEvents);

      const perUser = Object.entries(userScreens).map(([uid, screens]) => ({
        userId: uid,
        screens: Object.entries(screens)
          .map(([s, c]) => ({ screen: s, count: c }))
          .sort((a, b) => b.count - a.count),
        totalEvents: Object.values(screens).reduce((a, b) => a + b, 0),
      }));

      res.json({
        ok: true,
        usage: 'screens',
        period: `${days}일`,
        totalEvents: events.rows.length,
        nenovaEvents: events.rows.filter(e => classifyScreen(e.window_title || e.current_app)).length,
        screens,
        perUser,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'usage/screens');
    }
  });


  /**
   * GET /api/cross/usage/features
   * 기능별 사용 빈도 (주문등록/출하/재고/견적 등)
   * ?days=7
   */
  router.get('/usage/features', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 7, 90);

      // Orbit events에서 nenova 관련 이벤트
      const events = await orbitDb.query(`
        SELECT
          user_id,
          type,
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          data_json->>'rawInput' AS raw_input,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND (
            data_json->>'windowTitle' IS NOT NULL
            OR data_json->>'currentApp' IS NOT NULL
          )
        ORDER BY timestamp DESC
        LIMIT 10000
      `, [days]);

      // nenova 실제 DB에서 최근 기능별 사용 현황
      const nenovaActivity = await safeQuery(async (pool) => {
        const [orders, shipments, estimates] = await Promise.all([
          // 최근 N일간 주문 생성
          pool.request().query(`
            SELECT
              COUNT(*) AS cnt,
              COUNT(DISTINCT CustKey) AS custCount,
              COUNT(DISTINCT CreateID) AS userCount,
              MAX(CreateDtm) AS lastCreate
            FROM OrderMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
          // 최근 N일간 출하 생성
          pool.request().query(`
            SELECT
              COUNT(*) AS cnt,
              COUNT(DISTINCT CustKey) AS custCount,
              MAX(CreateDtm) AS lastCreate
            FROM ShipmentMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
          // 최근 N일간 견적
          pool.request().query(`
            SELECT COUNT(*) AS cnt
            FROM Estimate
            WHERE CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `).catch(() => ({ recordset: [{ cnt: 0 }] })),
        ]);

        return {
          orders: orders.recordset[0],
          shipments: shipments.recordset[0],
          estimates: estimates.recordset[0],
        };
      });

      // Orbit 이벤트에서 기능별 집계
      const featureMap = {};

      for (const e of events.rows) {
        const classification = classifyScreen(e.window_title || e.current_app || '');
        if (!classification) continue;

        const { feature, category } = classification;
        if (!featureMap[feature]) {
          featureMap[feature] = {
            feature,
            category,
            orbitEvents: 0,
            keyboardEvents: 0,
            users: new Set(),
          };
        }
        featureMap[feature].orbitEvents++;
        if (e.type === 'keyboard.chunk' && e.raw_input) {
          featureMap[feature].keyboardEvents++;
        }
        featureMap[feature].users.add(e.user_id);
      }

      const features = Object.values(featureMap)
        .map(f => ({
          feature: f.feature,
          category: f.category,
          orbitEvents: f.orbitEvents,
          keyboardEvents: f.keyboardEvents,
          uniqueUsers: f.users.size,
          // nenova 실제 건수 매칭
          nenovaInserts: f.feature === 'order_entry' ? nenovaActivity.orders.cnt
            : f.feature === 'shipment' ? nenovaActivity.shipments.cnt
            : f.feature === 'estimate' ? nenovaActivity.estimates.cnt
            : null,
        }))
        .sort((a, b) => b.orbitEvents - a.orbitEvents);

      res.json({
        ok: true,
        usage: 'features',
        period: `${days}일`,
        features,
        nenovaActivity: {
          orders: {
            count: nenovaActivity.orders.cnt,
            customers: nenovaActivity.orders.custCount,
            users: nenovaActivity.orders.userCount,
            lastCreate: nenovaActivity.orders.lastCreate,
          },
          shipments: {
            count: nenovaActivity.shipments.cnt,
            customers: nenovaActivity.shipments.custCount,
            lastCreate: nenovaActivity.shipments.lastCreate,
          },
          estimates: {
            count: nenovaActivity.estimates.cnt,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'usage/features');
    }
  });


  /**
   * GET /api/cross/usage/timeline
   * 시간대별 기능 사용 패턴
   * ?days=7
   */
  router.get('/usage/timeline', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 7, 90);

      // Orbit 이벤트에서 시간대별 집계
      const events = await orbitDb.query(`
        SELECT
          EXTRACT(HOUR FROM timestamp::TIMESTAMPTZ) AS hour,
          type,
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          user_id
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND type IN ('keyboard.chunk', 'screen.capture', 'clipboard.change', 'screen.analyzed')
        ORDER BY timestamp
        LIMIT 20000
      `, [days]);

      // 시간대별 집계 (0~23시)
      const hourly = {};
      for (let h = 0; h < 24; h++) {
        hourly[h] = {
          hour: h,
          totalEvents: 0,
          keyboardEvents: 0,
          screenCaptures: 0,
          clipboardEvents: 0,
          nenovaEvents: 0,
          users: new Set(),
          features: {},
        };
      }

      for (const e of events.rows) {
        const h = parseInt(e.hour) || 0;
        if (h < 0 || h > 23) continue;

        hourly[h].totalEvents++;
        hourly[h].users.add(e.user_id);

        if (e.type === 'keyboard.chunk') hourly[h].keyboardEvents++;
        if (e.type === 'screen.capture') hourly[h].screenCaptures++;
        if (e.type === 'clipboard.change') hourly[h].clipboardEvents++;

        const classification = classifyScreen(e.window_title || e.current_app || '');
        if (classification) {
          hourly[h].nenovaEvents++;
          if (!hourly[h].features[classification.category]) {
            hourly[h].features[classification.category] = 0;
          }
          hourly[h].features[classification.category]++;
        }
      }

      // nenova에서 시간대별 주문 생성 패턴
      const nenovaHourly = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT
            DATEPART(HOUR, CreateDtm) AS hour,
            COUNT(*) AS cnt
          FROM OrderMaster
          WHERE ISNULL(isDeleted, 0) = 0
            AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          GROUP BY DATEPART(HOUR, CreateDtm)
          ORDER BY hour
        `);
        return data.recordset;
      });

      // nenova 시간대 데이터 병합
      const nenovaHourMap = {};
      for (const r of nenovaHourly) {
        nenovaHourMap[r.hour] = r.cnt;
      }

      const timeline = Object.values(hourly).map(h => ({
        hour: h.hour,
        label: `${String(h.hour).padStart(2, '0')}:00`,
        totalEvents: h.totalEvents,
        keyboardEvents: h.keyboardEvents,
        screenCaptures: h.screenCaptures,
        clipboardEvents: h.clipboardEvents,
        nenovaScreenEvents: h.nenovaEvents,
        nenovaOrderInserts: nenovaHourMap[h.hour] || 0,
        uniqueUsers: h.users.size,
        topFeatures: Object.entries(h.features)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([f, c]) => ({ feature: f, count: c })),
      }));

      // 피크 시간대 계산
      const peakHour = timeline.reduce((max, h) => h.totalEvents > max.totalEvents ? h : max, timeline[0]);
      const workHours = timeline.filter(h => h.hour >= 8 && h.hour <= 18);
      const avgWorkEvents = workHours.reduce((s, h) => s + h.totalEvents, 0) / (workHours.length || 1);

      res.json({
        ok: true,
        usage: 'timeline',
        period: `${days}일`,
        peakHour: peakHour ? { hour: peakHour.label, events: peakHour.totalEvents } : null,
        avgWorkHourEvents: Math.round(avgWorkEvents),
        timeline,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'usage/timeline');
    }
  });


  /**
   * GET /api/cross/usage/efficiency
   * 직원별 작업 효율 (입력 건수/시간, 소요시간/건)
   * ?days=7
   */
  router.get('/usage/efficiency', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 7, 90);

      // Orbit: 직원별 키보드 이벤트 수 + rawInput 길이
      const orbitStats = await orbitDb.query(`
        SELECT
          user_id,
          COUNT(*) AS total_events,
          COUNT(CASE WHEN type = 'keyboard.chunk' THEN 1 END) AS keyboard_events,
          SUM(CASE WHEN type = 'keyboard.chunk' THEN LENGTH(COALESCE(data_json->>'rawInput', '')) ELSE 0 END) AS total_chars,
          COUNT(CASE WHEN type = 'screen.capture' THEN 1 END) AS screen_captures,
          COUNT(CASE WHEN type = 'clipboard.change' THEN 1 END) AS clipboard_events,
          MIN(timestamp) AS first_event,
          MAX(timestamp) AS last_event,
          COUNT(DISTINCT DATE(timestamp::TIMESTAMPTZ)) AS active_days
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND type IN ('keyboard.chunk', 'screen.capture', 'clipboard.change')
        GROUP BY user_id
        ORDER BY total_events DESC
      `, [days]);

      // nenova: 최근 N일간 직원별 주문 INSERT 건수 (CreateID 기준)
      const nenovaInserts = await safeQuery(async (pool) => {
        const orders = await pool.request().query(`
          SELECT
            CreateID AS user_id,
            COUNT(*) AS order_count,
            COUNT(DISTINCT CustKey) AS customer_count,
            MIN(CreateDtm) AS first_order,
            MAX(CreateDtm) AS last_order,
            COUNT(DISTINCT CAST(CreateDtm AS DATE)) AS active_days
          FROM OrderMaster
          WHERE ISNULL(isDeleted, 0) = 0
            AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          GROUP BY CreateID
          ORDER BY order_count DESC
        `);

        const details = await pool.request().query(`
          SELECT
            om.CreateID AS user_id,
            COUNT(od.OrderDetailKey) AS detail_count,
            SUM(ISNULL(od.BoxQuantity, 0)) AS total_box
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          WHERE ISNULL(od.isDeleted, 0) = 0
            AND ISNULL(om.isDeleted, 0) = 0
            AND om.CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          GROUP BY om.CreateID
        `);

        return {
          orders: orders.recordset,
          details: details.recordset,
        };
      });

      // 직원별 효율 계산
      const nenovaDetailMap = {};
      for (const d of nenovaInserts.details) {
        nenovaDetailMap[d.user_id] = d;
      }

      const nenovaOrderMap = {};
      for (const o of nenovaInserts.orders) {
        nenovaOrderMap[o.user_id] = o;
      }

      const efficiency = orbitStats.rows.map(o => {
        // 활동 시간 추정 (첫 이벤트~마지막 이벤트 간격 / 활동일)
        const firstTs = new Date(o.first_event).getTime();
        const lastTs = new Date(o.last_event).getTime();
        const totalHours = (lastTs - firstTs) / (1000 * 60 * 60);
        const avgHoursPerDay = o.active_days > 0 ? totalHours / parseInt(o.active_days) : 0;

        // nenova 매칭 (Orbit user_id와 nenova CreateID 직접 매칭 시도)
        // CreateID가 다를 수 있으므로 별도 표시
        const nenovaOrder = nenovaOrderMap[o.user_id];
        const nenovaDetail = nenovaDetailMap[o.user_id];

        const orderCount = nenovaOrder ? nenovaOrder.order_count : 0;
        const detailCount = nenovaDetail ? nenovaDetail.detail_count : 0;

        // 입력 1건당 평균 시간 (분)
        const minutesPerOrder = orderCount > 0 && avgHoursPerDay > 0
          ? Math.round((avgHoursPerDay * 60 / orderCount) * 10) / 10
          : null;

        // 시간당 처리 건수
        const ordersPerHour = avgHoursPerDay > 0 && orderCount > 0
          ? Math.round((orderCount / totalHours) * 10) / 10
          : null;

        return {
          userId: o.user_id,
          orbit: {
            totalEvents: parseInt(o.total_events),
            keyboardEvents: parseInt(o.keyboard_events),
            totalChars: parseInt(o.total_chars),
            screenCaptures: parseInt(o.screen_captures),
            clipboardEvents: parseInt(o.clipboard_events),
            activeDays: parseInt(o.active_days),
            avgHoursPerDay: Math.round(avgHoursPerDay * 10) / 10,
          },
          nenova: {
            orderMasters: orderCount,
            orderDetails: detailCount,
            totalBox: nenovaDetail ? nenovaDetail.total_box : 0,
            customers: nenovaOrder ? nenovaOrder.customer_count : 0,
            activeDays: nenovaOrder ? nenovaOrder.active_days : 0,
          },
          efficiency: {
            minutesPerOrder,
            ordersPerHour,
            charsPerOrder: orderCount > 0 ? Math.round(parseInt(o.total_chars) / orderCount) : null,
            eventsPerOrder: orderCount > 0 ? Math.round(parseInt(o.total_events) / orderCount) : null,
          },
        };
      });

      // 병목 감지
      const bottlenecks = efficiency
        .filter(e => e.efficiency.minutesPerOrder && e.efficiency.minutesPerOrder > 5)
        .map(e => ({
          userId: e.userId,
          minutesPerOrder: e.efficiency.minutesPerOrder,
          issue: e.efficiency.minutesPerOrder > 10 ? 'critical' : 'warning',
          suggestion: e.efficiency.minutesPerOrder > 10
            ? '주문 1건당 10분 이상 소요 — 자동화 또는 프로세스 개선 필요'
            : '주문 1건당 5분 이상 소요 — 효율 개선 여지 있음',
        }));

      res.json({
        ok: true,
        usage: 'efficiency',
        period: `${days}일`,
        efficiency,
        bottlenecks,
        nenovaUsers: nenovaInserts.orders.map(o => ({
          createId: o.user_id,
          orderCount: o.order_count,
          activeDays: o.active_days,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'usage/efficiency');
    }
  });


  /**
   * GET /api/cross/usage/needs
   * 가장 많이 사용하는 기능 TOP 10 + 개선 필요 영역
   * ?days=30
   */
  router.get('/usage/needs', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // Orbit 이벤트에서 전체 기능 사용 집계
      const events = await orbitDb.query(`
        SELECT
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          data_json->>'rawInput' AS raw_input,
          type,
          user_id,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND type IN ('keyboard.chunk', 'screen.capture', 'clipboard.change', 'screen.analyzed')
        ORDER BY timestamp DESC
        LIMIT 20000
      `, [days]);

      // 기능별 상세 집계
      const featureStats = {};

      for (const e of events.rows) {
        const title = e.window_title || e.current_app || '';
        const classification = classifyScreen(title);
        if (!classification) continue;

        const key = classification.category;
        if (!featureStats[key]) {
          featureStats[key] = {
            category: key,
            feature: classification.feature,
            totalEvents: 0,
            keyboardEvents: 0,
            totalChars: 0,
            users: new Set(),
            timestamps: [],
          };
        }

        featureStats[key].totalEvents++;
        featureStats[key].users.add(e.user_id);
        featureStats[key].timestamps.push(new Date(e.timestamp).getTime());

        if (e.type === 'keyboard.chunk') {
          featureStats[key].keyboardEvents++;
          featureStats[key].totalChars += (e.raw_input || '').length;
        }
      }

      // TOP 10 정렬 + 시간 분석
      const top10 = Object.values(featureStats)
        .map(f => {
          const timestamps = f.timestamps.sort((a, b) => a - b);
          // 세션 간격 추정 (연속 이벤트 간 5분 이상 → 새 세션)
          let sessions = 1;
          let totalSessionTime = 0;
          let sessionStart = timestamps[0];

          for (let i = 1; i < timestamps.length; i++) {
            const gap = timestamps[i] - timestamps[i - 1];
            if (gap > 5 * 60 * 1000) { // 5분 이상 갭
              totalSessionTime += timestamps[i - 1] - sessionStart;
              sessionStart = timestamps[i];
              sessions++;
            }
          }
          if (timestamps.length > 0) {
            totalSessionTime += timestamps[timestamps.length - 1] - sessionStart;
          }

          const avgSessionMinutes = sessions > 0 ? Math.round(totalSessionTime / sessions / 60000 * 10) / 10 : 0;
          const totalHours = Math.round(totalSessionTime / 3600000 * 10) / 10;

          return {
            rank: 0,
            category: f.category,
            feature: f.feature,
            totalEvents: f.totalEvents,
            keyboardEvents: f.keyboardEvents,
            totalChars: f.totalChars,
            uniqueUsers: f.users.size,
            sessions,
            totalHours,
            avgSessionMinutes,
          };
        })
        .sort((a, b) => b.totalEvents - a.totalEvents)
        .slice(0, 10)
        .map((f, i) => ({ ...f, rank: i + 1 }));

      // 개선 필요 영역 분석
      const improvements = top10
        .filter(f => f.totalHours > 1 || f.keyboardEvents > 100)
        .map(f => {
          const issues = [];

          if (f.avgSessionMinutes > 10) {
            issues.push({
              type: 'long_session',
              detail: `평균 세션 ${f.avgSessionMinutes}분 — UI 개선 또는 자동완성 필요`,
            });
          }

          if (f.totalChars > 5000 && f.keyboardEvents > 50) {
            const avgCharsPerEvent = Math.round(f.totalChars / f.keyboardEvents);
            issues.push({
              type: 'heavy_typing',
              detail: `키 입력 ${f.totalChars}자 (이벤트당 ${avgCharsPerEvent}자) — 자동입력/템플릿 필요`,
            });
          }

          if (f.sessions > 20) {
            issues.push({
              type: 'frequent_access',
              detail: `${f.sessions}회 접속 — 대시보드/빠른접근 배치 필요`,
            });
          }

          return {
            category: f.category,
            feature: f.feature,
            urgency: issues.length >= 2 ? 'high' : 'medium',
            issues,
          };
        })
        .filter(f => f.issues.length > 0);

      res.json({
        ok: true,
        usage: 'needs',
        period: `${days}일`,
        top10,
        improvements,
        totalAnalyzed: events.rows.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'usage/needs');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     3. 데이터 흐름 추적
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/cross/flow/order-entry
   * 주문 입력 흐름: 카톡→클립보드→파서→전산 DB
   * ?days=7
   */
  router.get('/flow/order-entry', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 7, 90);

      // 각 단계별 건수 조회 (병렬)
      const [kakaoMsgs, clipboardEvents, parsedOrders, orbitKeyboard] = await Promise.all([
        // 1단계: 카카오톡 메시지 (주문 관련)
        orbitDb.query(`
          SELECT COUNT(*) AS cnt,
                 COUNT(CASE WHEN message ILIKE '%주문%' OR message ILIKE '%박스%' OR message ILIKE '%box%' THEN 1 END) AS order_related
          FROM kakao_messages
          WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        `, [days]).catch(() => ({ rows: [{ cnt: 0, order_related: 0 }] })),

        // 2단계: 클립보드 이벤트
        orbitDb.query(`
          SELECT COUNT(*) AS cnt,
                 COUNT(CASE WHEN data_json->>'text' ILIKE '%주문%' OR data_json->>'text' ILIKE '%박스%' THEN 1 END) AS order_related
          FROM events
          WHERE type = 'clipboard.change'
            AND timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
        `, [days]).catch(() => ({ rows: [{ cnt: 0, order_related: 0 }] })),

        // 3단계: 파서 결과
        orbitDb.query(`
          SELECT COUNT(*) AS cnt,
                 COUNT(CASE WHEN source_type = 'clipboard' THEN 1 END) AS from_clipboard,
                 COUNT(CASE WHEN source_type = 'vision' THEN 1 END) AS from_vision,
                 COUNT(CASE WHEN source_type = 'nenova_sync' THEN 1 END) AS from_sync,
                 COUNT(CASE WHEN nenova_detail_key IS NOT NULL THEN 1 END) AS has_nenova_key
          FROM parsed_orders
          WHERE created_at >= NOW() - INTERVAL '1 day' * $1
        `, [days]).catch(() => ({ rows: [{ cnt: 0, from_clipboard: 0, from_vision: 0, from_sync: 0, has_nenova_key: 0 }] })),

        // Orbit 키보드 이벤트 (nenova 화면)
        orbitDb.query(`
          SELECT COUNT(*) AS cnt
          FROM events
          WHERE type = 'keyboard.chunk'
            AND timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
            AND (
              data_json->>'windowTitle' ILIKE '%nenova%'
              OR data_json->>'windowTitle' ILIKE '%화훼%'
              OR data_json->>'windowTitle' ILIKE '%주문%'
              OR data_json->>'currentApp' ILIKE '%nenova%'
            )
        `, [days]).catch(() => ({ rows: [{ cnt: 0 }] })),
      ]);

      // 4단계: nenova DB 실제 INSERT 건수
      const nenovaInserts = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT
            COUNT(*) AS order_count,
            COUNT(DISTINCT CustKey) AS customer_count,
            (SELECT COUNT(*) FROM OrderDetail od
             JOIN OrderMaster om2 ON od.OrderMasterKey = om2.OrderMasterKey
             WHERE ISNULL(od.isDeleted, 0) = 0
               AND om2.CreateDtm >= DATEADD(DAY, -${days}, GETDATE())) AS detail_count
          FROM OrderMaster
          WHERE ISNULL(isDeleted, 0) = 0
            AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
        `);
        return data.recordset[0];
      });

      // 흐름 구성
      const kakao = kakaoMsgs.rows[0];
      const clipboard = clipboardEvents.rows[0];
      const parsed = parsedOrders.rows[0];
      const keyboard = orbitKeyboard.rows[0];

      const flow = [
        {
          step: 1,
          name: '카카오톡 메시지',
          source: 'kakao_messages',
          total: parseInt(kakao.cnt),
          orderRelated: parseInt(kakao.order_related),
          icon: 'chat',
        },
        {
          step: 2,
          name: '클립보드 복사',
          source: 'events (clipboard.change)',
          total: parseInt(clipboard.cnt),
          orderRelated: parseInt(clipboard.order_related),
          icon: 'clipboard',
        },
        {
          step: 3,
          name: '파서 처리',
          source: 'parsed_orders',
          total: parseInt(parsed.cnt),
          fromClipboard: parseInt(parsed.from_clipboard),
          fromVision: parseInt(parsed.from_vision),
          fromSync: parseInt(parsed.from_sync),
          hasNenovaKey: parseInt(parsed.has_nenova_key),
          icon: 'parser',
        },
        {
          step: 4,
          name: 'nenova 전산 입력',
          source: 'nenova OrderMaster/Detail',
          total: nenovaInserts.order_count,
          details: nenovaInserts.detail_count,
          customers: nenovaInserts.customer_count,
          orbitKeyboardOnNenova: parseInt(keyboard.cnt),
          icon: 'database',
        },
      ];

      // 전환율 계산
      const conversionRates = [];
      for (let i = 0; i < flow.length - 1; i++) {
        const from = flow[i].orderRelated || flow[i].total;
        const to = flow[i + 1].total;
        const rate = from > 0 ? Math.round((to / from) * 10000) / 100 : 0;
        conversionRates.push({
          from: flow[i].name,
          to: flow[i + 1].name,
          fromCount: from,
          toCount: to,
          rate: `${rate}%`,
        });
      }

      res.json({
        ok: true,
        flow: 'order-entry',
        period: `${days}일`,
        steps: flow,
        conversionRates,
        summary: {
          kakaoToNenova: `${kakao.cnt > 0 ? Math.round((nenovaInserts.order_count / parseInt(kakao.cnt)) * 10000) / 100 : 0}%`,
          endToEnd: `카톡 ${kakao.cnt}건 → 전산 ${nenovaInserts.order_count}건`,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'flow/order-entry');
    }
  });


  /**
   * GET /api/cross/flow/daily
   * 오늘 데이터 흐름 요약
   */
  router.get('/flow/daily', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const today = todayKST();

      // Orbit 오늘 이벤트 요약
      const orbitToday = await orbitDb.query(`
        SELECT
          type,
          COUNT(*) AS cnt,
          COUNT(DISTINCT user_id) AS users
        FROM events
        WHERE timestamp >= $1
          AND timestamp <= $2
        GROUP BY type
        ORDER BY cnt DESC
      `, [todayStartKST(), todayEndKST()]).catch(() => ({ rows: [] }));

      // 파서 오늘 처리 건수
      const parsedToday = await orbitDb.query(`
        SELECT
          source_type,
          COUNT(*) AS cnt,
          COUNT(CASE WHEN nenova_detail_key IS NOT NULL THEN 1 END) AS synced
        FROM parsed_orders
        WHERE created_at::DATE = $1::DATE
        GROUP BY source_type
      `, [today]).catch(() => ({ rows: [] }));

      // 카카오 오늘 메시지
      const kakaoToday = await orbitDb.query(`
        SELECT COUNT(*) AS cnt
        FROM kakao_messages
        WHERE created_at::DATE = $1::DATE
      `, [today]).catch(() => ({ rows: [{ cnt: 0 }] }));

      // nenova 오늘 활동
      const nenovaToday = await safeQuery(async (pool) => {
        const [orders, shipments] = await Promise.all([
          pool.request().query(`
            SELECT
              COUNT(*) AS cnt,
              COUNT(DISTINCT CustKey) AS customers,
              (SELECT COUNT(*) FROM OrderDetail od
               JOIN OrderMaster om2 ON od.OrderMasterKey = om2.OrderMasterKey
               WHERE ISNULL(od.isDeleted, 0) = 0
                 AND CAST(om2.CreateDtm AS DATE) = CAST(GETDATE() AS DATE)) AS details
            FROM OrderMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE)
          `),
          pool.request().query(`
            SELECT COUNT(*) AS cnt
            FROM ShipmentMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CAST(CreateDtm AS DATE) = CAST(GETDATE() AS DATE)
          `),
        ]);

        return {
          orders: orders.recordset[0],
          shipments: shipments.recordset[0],
        };
      });

      // 이벤트 타입별 맵
      const eventSummary = {};
      for (const r of orbitToday.rows) {
        eventSummary[r.type] = { count: parseInt(r.cnt), users: parseInt(r.users) };
      }

      res.json({
        ok: true,
        flow: 'daily',
        date: today,
        orbit: {
          events: eventSummary,
          totalEvents: orbitToday.rows.reduce((s, r) => s + parseInt(r.cnt), 0),
          parsedOrders: parsedToday.rows.map(r => ({
            source: r.source_type,
            count: parseInt(r.cnt),
            synced: parseInt(r.synced),
          })),
          kakaoMessages: parseInt(kakaoToday.rows[0].cnt),
        },
        nenova: {
          orders: {
            masters: nenovaToday.orders.cnt,
            details: nenovaToday.orders.details,
            customers: nenovaToday.orders.customers,
          },
          shipments: nenovaToday.shipments.cnt,
        },
        health: {
          orbitCollecting: (eventSummary['keyboard.chunk']?.count || 0) > 0,
          nenovaActive: nenovaToday.orders.cnt > 0,
          dataFlowing: (eventSummary['keyboard.chunk']?.count || 0) > 0 && nenovaToday.orders.cnt > 0,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'flow/daily');
    }
  });


  /**
   * GET /api/cross/flow/gaps
   * 데이터 누락 감지 (Orbit에 있지만 전산에 없는, 또는 반대)
   * ?days=7
   */
  router.get('/flow/gaps', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 7, 30);

      // ── Gap 1: Orbit parsed_orders에 있지만 nenova에 없는 ──
      // (source_type != 'nenova_sync'이고, 아직 nenova_detail_key 없는 건)
      const orbitUnmatched = await orbitDb.query(`
        SELECT id, source_type, customer, product, quantity, unit, order_date, raw_text, confidence
        FROM parsed_orders
        WHERE nenova_detail_key IS NULL
          AND source_type != 'nenova_sync'
          AND created_at >= NOW() - INTERVAL '1 day' * $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [days]).catch(() => ({ rows: [] }));

      // ── Gap 2: nenova에 있지만 Orbit parsed_orders에 없는 ──
      // (최근 N일 nenova 주문 중 Orbit에 동기화 안 된 것)
      const nenovaRecent = await safeQuery(async (pool) => {
        const data = await pool.request().query(`
          SELECT TOP 200
            od.OrderDetailKey,
            om.OrderMasterKey,
            om.OrderDtm,
            om.OrderWeek,
            om.OrderCode,
            c.CustName,
            p.ProdName,
            od.BoxQuantity
          FROM OrderDetail od
          JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
          JOIN Product p ON od.ProdKey = p.ProdKey
          LEFT JOIN Customer c ON om.CustKey = c.CustKey
          WHERE ISNULL(od.isDeleted, 0) = 0
            AND ISNULL(om.isDeleted, 0) = 0
            AND om.CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          ORDER BY om.CreateDtm DESC
        `);
        return data.recordset;
      });

      // Orbit에서 동기화된 nenova키 목록
      const syncedKeys = await orbitDb.query(`
        SELECT nenova_detail_key FROM parsed_orders
        WHERE nenova_detail_key IS NOT NULL
      `).catch(() => ({ rows: [] }));

      const syncedKeySet = new Set(syncedKeys.rows.map(r => r.nenova_detail_key));

      const nenovaUnsynced = nenovaRecent
        .filter(n => !syncedKeySet.has(n.OrderDetailKey))
        .map(n => ({
          nenovaDetailKey: n.OrderDetailKey,
          orderMasterKey: n.OrderMasterKey,
          customer: n.CustName,
          product: n.ProdName,
          boxQty: n.BoxQuantity,
          date: n.OrderDtm,
          week: n.OrderWeek,
        }));

      // ── Gap 3: Orbit 이벤트 수집 누락 (idle 시간이 긴 구간) ──
      const idleGaps = await orbitDb.query(`
        SELECT user_id, type, timestamp,
               LEAD(timestamp) OVER (PARTITION BY user_id ORDER BY timestamp) AS next_timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND type IN ('keyboard.chunk', 'screen.capture')
        ORDER BY user_id, timestamp
        LIMIT 5000
      `, [days]).catch(() => ({ rows: [] }));

      // 1시간 이상 이벤트 없는 구간 감지 (업무 시간 내)
      const significantGaps = [];
      for (const row of idleGaps.rows) {
        if (!row.next_timestamp) continue;
        const gapMs = new Date(row.next_timestamp).getTime() - new Date(row.timestamp).getTime();
        const gapHours = gapMs / (1000 * 60 * 60);
        const eventHour = new Date(row.timestamp).getHours();

        // 업무 시간 (8~18시) 내 1시간 이상 갭
        if (gapHours >= 1 && gapHours < 12 && eventHour >= 8 && eventHour < 18) {
          significantGaps.push({
            userId: row.user_id,
            from: row.timestamp,
            to: row.next_timestamp,
            gapMinutes: Math.round(gapMs / 60000),
            note: gapHours >= 3 ? '장시간 데이터 누락' : '일시적 수집 중단',
          });
        }
      }

      res.json({
        ok: true,
        flow: 'gaps',
        period: `${days}일`,
        gaps: {
          orbitOnly: {
            description: 'Orbit에서 파싱했지만 nenova에 미등록된 주문',
            count: orbitUnmatched.rows.length,
            items: orbitUnmatched.rows.slice(0, 20),
          },
          nenovaOnly: {
            description: 'nenova에 있지만 Orbit에 미동기화된 주문',
            count: nenovaUnsynced.length,
            items: nenovaUnsynced.slice(0, 20),
            action: 'POST /api/nenova/sync/orders 실행으로 동기화 가능',
          },
          collectionGaps: {
            description: '업무 시간 내 데이터 수집 중단 구간 (1시간 이상)',
            count: significantGaps.length,
            items: significantGaps.slice(0, 20),
          },
        },
        summary: {
          totalGaps: orbitUnmatched.rows.length + nenovaUnsynced.length + significantGaps.length,
          severity: (nenovaUnsynced.length > 50 || significantGaps.length > 10) ? 'high'
            : (nenovaUnsynced.length > 10 || significantGaps.length > 5) ? 'medium' : 'low',
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'flow/gaps');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     4. Orbit OS 설계 인사이트
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/cross/insights/priority
   * 기능 우선순위 추천 (사용 빈도 + 시간 소요 기반)
   * ?days=30
   */
  router.get('/insights/priority', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // Orbit 이벤트 + nenova 활동 조합
      const events = await orbitDb.query(`
        SELECT
          data_json->>'windowTitle' AS window_title,
          data_json->>'currentApp' AS current_app,
          data_json->>'rawInput' AS raw_input,
          type,
          user_id,
          timestamp
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND type IN ('keyboard.chunk', 'screen.capture', 'clipboard.change')
        ORDER BY timestamp
        LIMIT 20000
      `, [days]);

      // nenova 기능별 일일 평균 건수
      const nenovaDaily = await safeQuery(async (pool) => {
        const [orders, shipments] = await Promise.all([
          pool.request().query(`
            SELECT
              CAST(CreateDtm AS DATE) AS dt,
              COUNT(*) AS cnt,
              (SELECT COUNT(*) FROM OrderDetail od2
               JOIN OrderMaster om2 ON od2.OrderMasterKey = om2.OrderMasterKey
               WHERE ISNULL(od2.isDeleted, 0) = 0
                 AND CAST(om2.CreateDtm AS DATE) = CAST(om.CreateDtm AS DATE)) AS detail_cnt
            FROM OrderMaster om
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
            GROUP BY CAST(CreateDtm AS DATE)
          `),
          pool.request().query(`
            SELECT
              CAST(CreateDtm AS DATE) AS dt,
              COUNT(*) AS cnt
            FROM ShipmentMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
            GROUP BY CAST(CreateDtm AS DATE)
          `),
        ]);

        const orderDays = orders.recordset;
        const shipDays = shipments.recordset;
        const activeDays = orderDays.length || 1;

        return {
          orders: {
            avgPerDay: Math.round(orderDays.reduce((s, r) => s + r.cnt, 0) / activeDays),
            avgDetailsPerDay: Math.round(orderDays.reduce((s, r) => s + (r.detail_cnt || 0), 0) / activeDays),
            totalDays: activeDays,
          },
          shipments: {
            avgPerDay: Math.round(shipDays.reduce((s, r) => s + r.cnt, 0) / (shipDays.length || 1)),
          },
        };
      });

      // 기능별 사용 시간 + 빈도 계산
      const featureData = {};

      for (const e of events.rows) {
        const title = e.window_title || e.current_app || '';
        const classification = classifyScreen(title);
        if (!classification) continue;

        const key = classification.category;
        if (!featureData[key]) {
          featureData[key] = {
            category: key,
            feature: classification.feature,
            events: 0,
            keyboardChars: 0,
            users: new Set(),
            timestamps: [],
          };
        }

        featureData[key].events++;
        featureData[key].users.add(e.user_id);
        featureData[key].timestamps.push(new Date(e.timestamp).getTime());
        if (e.type === 'keyboard.chunk') {
          featureData[key].keyboardChars += (e.raw_input || '').length;
        }
      }

      // 우선순위 점수 계산
      const priorities = Object.values(featureData).map(f => {
        const ts = f.timestamps.sort((a, b) => a - b);
        let totalTimeMs = 0;
        let sessions = 1;
        let sessionStart = ts[0] || 0;

        for (let i = 1; i < ts.length; i++) {
          if (ts[i] - ts[i - 1] > 5 * 60 * 1000) {
            totalTimeMs += ts[i - 1] - sessionStart;
            sessionStart = ts[i];
            sessions++;
          }
        }
        if (ts.length > 0) totalTimeMs += ts[ts.length - 1] - sessionStart;

        const totalMinutes = Math.round(totalTimeMs / 60000);
        const avgMinutesPerSession = sessions > 0 ? Math.round(totalTimeMs / sessions / 60000 * 10) / 10 : 0;

        // 일일 사용 빈도 (nenova 데이터 참조)
        let dailyInserts = 0;
        if (f.feature === 'order_entry' || f.feature === 'order_manage') {
          dailyInserts = nenovaDaily.orders.avgDetailsPerDay;
        } else if (f.feature === 'shipment') {
          dailyInserts = nenovaDaily.shipments.avgPerDay;
        }

        // 우선순위 점수 = 사용빈도 x 소요시간(분) / 1000
        const usageScore = f.events;
        const timeScore = totalMinutes;
        const priorityScore = Math.round((usageScore * timeScore) / 100);

        let recommendation = '';
        if (priorityScore > 1000) recommendation = 'PAD 자동화 1순위 — 즉시 자동화 개발';
        else if (priorityScore > 500) recommendation = '자동화 2순위 — 반복 작업 개선 필요';
        else if (priorityScore > 100) recommendation = 'UI 개선 — 빠른 접근/템플릿 제공';
        else recommendation = '모니터링 유지';

        return {
          rank: 0,
          feature: f.feature,
          category: f.category,
          usage: f.events,
          totalMinutes,
          avgMinutesPerSession,
          sessions,
          dailyInserts,
          uniqueUsers: f.users.size,
          keyboardChars: f.keyboardChars,
          priorityScore,
          recommendation,
        };
      })
        .sort((a, b) => b.priorityScore - a.priorityScore)
        .map((p, i) => ({ ...p, rank: i + 1 }));

      res.json({
        ok: true,
        insights: 'priority',
        period: `${days}일`,
        priorities,
        nenovaDailyAvg: nenovaDaily,
        designGuideline: priorities.slice(0, 5).map(p => ({
          rank: p.rank,
          feature: p.category,
          placement: p.rank <= 2 ? '메인 대시보드 최상단' : p.rank <= 5 ? '메인 메뉴 1depth' : '서브 메뉴',
          shortcut: p.rank <= 3,
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'insights/priority');
    }
  });


  /**
   * GET /api/cross/insights/automation
   * 자동화 기회 발견 (반복 작업 + 전산 대응 분석)
   * ?days=30
   */
  router.get('/insights/automation', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // nenova DB에서 일일 INSERT 건수가 많은 작업 확인
      const nenovaVolume = await safeQuery(async (pool) => {
        const activeDaysResult = await pool.request().query(`
          SELECT COUNT(DISTINCT CAST(CreateDtm AS DATE)) AS active_days
          FROM OrderMaster
          WHERE ISNULL(isDeleted, 0) = 0
            AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
        `);
        const activeDays = activeDaysResult.recordset[0].active_days || 1;

        const [orderVolume, shipVolume, detailVolume] = await Promise.all([
          pool.request().query(`
            SELECT
              COUNT(*) AS total,
              COUNT(DISTINCT CustKey) AS customers,
              COUNT(DISTINCT CreateID) AS users
            FROM OrderMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
          pool.request().query(`
            SELECT
              COUNT(*) AS total,
              COUNT(DISTINCT CustKey) AS customers
            FROM ShipmentMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
          pool.request().query(`
            SELECT
              COUNT(*) AS total,
              SUM(ISNULL(BoxQuantity, 0)) AS total_box,
              AVG(ISNULL(BoxQuantity, 0)) AS avg_box
            FROM OrderDetail od
            JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
            WHERE ISNULL(od.isDeleted, 0) = 0
              AND ISNULL(om.isDeleted, 0) = 0
              AND om.CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
        ]);

        return {
          activeDays,
          orders: { ...orderVolume.recordset[0], perDay: Math.round(orderVolume.recordset[0].total / activeDays) },
          shipments: { ...shipVolume.recordset[0], perDay: Math.round(shipVolume.recordset[0].total / activeDays) },
          details: { ...detailVolume.recordset[0], perDay: Math.round(detailVolume.recordset[0].total / activeDays) },
        };
      });

      // Orbit에서 해당 작업의 평균 소요시간 추정
      const orbitTiming = await orbitDb.query(`
        SELECT
          user_id,
          COUNT(*) AS events,
          COUNT(CASE WHEN type = 'keyboard.chunk' THEN 1 END) AS keyboard_events,
          SUM(CASE WHEN type = 'keyboard.chunk' THEN LENGTH(COALESCE(data_json->>'rawInput', '')) ELSE 0 END) AS total_chars,
          MIN(timestamp) AS first_event,
          MAX(timestamp) AS last_event,
          COUNT(DISTINCT DATE(timestamp::TIMESTAMPTZ)) AS active_days
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND type IN ('keyboard.chunk', 'clipboard.change')
          AND (
            data_json->>'windowTitle' ILIKE '%nenova%'
            OR data_json->>'windowTitle' ILIKE '%화훼%'
            OR data_json->>'windowTitle' ILIKE '%주문%'
            OR data_json->>'windowTitle' ILIKE '%출하%'
            OR data_json->>'currentApp' ILIKE '%nenova%'
          )
        GROUP BY user_id
      `, [days]).catch(() => ({ rows: [] }));

      // 총 nenova 관련 작업 시간 추정
      let totalNenovaHours = 0;
      for (const r of orbitTiming.rows) {
        const hrs = (new Date(r.last_event).getTime() - new Date(r.first_event).getTime()) / 3600000;
        totalNenovaHours += hrs;
      }

      const avgDailyHours = nenovaVolume.activeDays > 0
        ? Math.round((totalNenovaHours / nenovaVolume.activeDays) * 10) / 10
        : 0;

      // 자동화 기회 분석
      const opportunities = [];

      // 1. 주문 등록 자동화
      const ordersPerDay = nenovaVolume.details.perDay;
      const orderMinutesPerDay = avgDailyHours * 60 * 0.6; // 60% 주문 관련 추정
      const minutesPerOrder = ordersPerDay > 0 ? Math.round((orderMinutesPerDay / ordersPerDay) * 10) / 10 : 0;

      if (ordersPerDay > 10) {
        const automatedMinutesPerOrder = 0.3; // 자동화 시 30초/건
        const savedMinutesPerDay = Math.round((minutesPerOrder - automatedMinutesPerOrder) * ordersPerDay);
        const savedHoursPerDay = Math.round(savedMinutesPerDay / 60 * 10) / 10;

        opportunities.push({
          rank: 1,
          task: '주문 등록',
          description: '카카오톡 주문 메시지 → nenova 전산 자동 입력',
          current: {
            dailyCount: ordersPerDay,
            minutesPerItem: minutesPerOrder,
            dailyMinutes: Math.round(minutesPerOrder * ordersPerDay),
            dailyHours: Math.round(minutesPerOrder * ordersPerDay / 60 * 10) / 10,
          },
          automated: {
            minutesPerItem: automatedMinutesPerOrder,
            dailyMinutes: Math.round(automatedMinutesPerOrder * ordersPerDay),
          },
          savings: {
            minutesPerDay: savedMinutesPerDay,
            hoursPerDay: savedHoursPerDay,
            percentReduction: minutesPerOrder > 0 ? Math.round(((minutesPerOrder - automatedMinutesPerOrder) / minutesPerOrder) * 100) : 0,
          },
          tools: ['PAD (UI 셀렉터)', 'pyautogui (좌표 기반)', '카카오 메시지 파서'],
          priority: 'critical',
          readiness: 'high',
        });
      }

      // 2. 출하 처리 자동화
      const shipmentsPerDay = nenovaVolume.shipments.perDay;
      if (shipmentsPerDay > 5) {
        const shipMinutes = avgDailyHours * 60 * 0.25; // 25% 출하 관련 추정
        const minutesPerShipment = shipmentsPerDay > 0 ? Math.round((shipMinutes / shipmentsPerDay) * 10) / 10 : 0;

        opportunities.push({
          rank: 2,
          task: '출하 처리',
          description: '주문 확정 → 출하 전표 자동 생성',
          current: {
            dailyCount: shipmentsPerDay,
            minutesPerItem: minutesPerShipment,
            dailyMinutes: Math.round(minutesPerShipment * shipmentsPerDay),
          },
          automated: {
            minutesPerItem: 0.5,
            dailyMinutes: Math.round(0.5 * shipmentsPerDay),
          },
          savings: {
            minutesPerDay: Math.round((minutesPerShipment - 0.5) * shipmentsPerDay),
            hoursPerDay: Math.round((minutesPerShipment - 0.5) * shipmentsPerDay / 60 * 10) / 10,
          },
          tools: ['PAD (주문→출하 연동)', 'nenova API (있으면)'],
          priority: 'high',
          readiness: 'medium',
        });
      }

      // 3. 데이터 동기화 자동화
      opportunities.push({
        rank: opportunities.length + 1,
        task: '데이터 동기화',
        description: 'nenova ↔ Orbit 실시간 동기화 (상품/거래처/주문)',
        current: {
          method: '수동 API 호출 (POST /api/nenova/sync/*)',
          frequency: '비정기',
        },
        automated: {
          method: '스케줄러 (매 30분) + 변경감지',
          dailyMinutes: 0,
        },
        savings: {
          description: '데이터 지연 0으로 — 실시간 교차분석 가능',
        },
        tools: ['node-cron', 'CDC (변경 데이터 캡처)'],
        priority: 'medium',
        readiness: 'high',
      });

      // 4. 클립보드 주문 파싱 자동화
      opportunities.push({
        rank: opportunities.length + 1,
        task: '클립보드 주문 파싱',
        description: '복사된 주문 텍스트 → 자동 파싱 + 전산 입력 제안',
        current: {
          method: '수동 읽기 + 타이핑',
        },
        automated: {
          method: 'NLP 파서 + 확인 UI',
        },
        tools: ['regex 파서', 'Claude Vision (이미지 주문)', 'PAD 자동입력'],
        priority: 'high',
        readiness: 'medium',
      });

      // ROI 요약
      const totalSavedMinutes = opportunities
        .filter(o => o.savings?.minutesPerDay)
        .reduce((s, o) => s + (o.savings.minutesPerDay || 0), 0);

      res.json({
        ok: true,
        insights: 'automation',
        period: `${days}일`,
        volume: {
          nenovaDailyOrders: ordersPerDay,
          nenovaDailyDetails: nenovaVolume.details.perDay,
          nenovaDailyShipments: shipmentsPerDay,
          orbitDailyHoursOnNenova: avgDailyHours,
          activeDays: nenovaVolume.activeDays,
        },
        opportunities,
        roi: {
          totalSavedMinutesPerDay: totalSavedMinutes,
          totalSavedHoursPerDay: Math.round(totalSavedMinutes / 60 * 10) / 10,
          monthlyHoursSaved: Math.round(totalSavedMinutes / 60 * 22), // 22 영업일
          note: '추정값 — 실제 자동화 구현 후 검증 필요',
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'insights/automation');
    }
  });


  /**
   * GET /api/cross/insights/report
   * 종합 분석 리포트
   * ?days=30
   */
  router.get('/insights/report', async (req, res) => {
    try {
      const orbitDb = getOrbitDb();
      const days = Math.min(parseInt(req.query.days) || 30, 180);

      // ── 1. 데이터 동기화 현황 ──
      const [orbitProdCount, orbitCustCount, orbitOrderCount] = await Promise.all([
        orbitDb.query('SELECT COUNT(*) AS cnt FROM master_products').catch(() => ({ rows: [{ cnt: 0 }] })),
        orbitDb.query('SELECT COUNT(*) AS cnt FROM master_customers').catch(() => ({ rows: [{ cnt: 0 }] })),
        orbitDb.query('SELECT COUNT(*) AS cnt FROM parsed_orders').catch(() => ({ rows: [{ cnt: 0 }] })),
      ]);

      const nenovaCounts = await safeQuery(async (pool) => {
        const [p, c, o, od] = await Promise.all([
          pool.request().query('SELECT COUNT(*) AS cnt FROM Product'),
          pool.request().query('SELECT COUNT(*) AS cnt FROM Customer'),
          pool.request().query(`SELECT COUNT(*) AS cnt FROM OrderMaster WHERE ISNULL(isDeleted, 0) = 0`),
          pool.request().query(`SELECT COUNT(*) AS cnt FROM OrderDetail WHERE ISNULL(isDeleted, 0) = 0`),
        ]);
        return {
          products: p.recordset[0].cnt,
          customers: c.recordset[0].cnt,
          orders: o.recordset[0].cnt,
          orderDetails: od.recordset[0].cnt,
        };
      });

      // ── 2. Orbit 이벤트 수집 현황 ──
      const orbitEventStats = await orbitDb.query(`
        SELECT
          type,
          COUNT(*) AS cnt,
          COUNT(DISTINCT user_id) AS users,
          MIN(timestamp) AS first_ts,
          MAX(timestamp) AS last_ts
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
        GROUP BY type
        ORDER BY cnt DESC
      `, [days]).catch(() => ({ rows: [] }));

      // ── 3. nenova 활동 요약 ──
      const nenovaActivity = await safeQuery(async (pool) => {
        const [orders, shipments, topCustomers, topProducts] = await Promise.all([
          pool.request().query(`
            SELECT
              COUNT(*) AS total,
              COUNT(DISTINCT CAST(CreateDtm AS DATE)) AS active_days,
              COUNT(DISTINCT CustKey) AS unique_customers,
              COUNT(DISTINCT CreateID) AS unique_users
            FROM OrderMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
          pool.request().query(`
            SELECT COUNT(*) AS total
            FROM ShipmentMaster
            WHERE ISNULL(isDeleted, 0) = 0
              AND CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
          `),
          pool.request().query(`
            SELECT TOP 5
              c.CustName,
              COUNT(*) AS order_count,
              SUM(ISNULL(od.BoxQuantity, 0)) AS total_box
            FROM OrderMaster om
            JOIN Customer c ON om.CustKey = c.CustKey
            LEFT JOIN OrderDetail od ON om.OrderMasterKey = od.OrderMasterKey AND ISNULL(od.isDeleted, 0) = 0
            WHERE ISNULL(om.isDeleted, 0) = 0
              AND om.CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
            GROUP BY c.CustName
            ORDER BY order_count DESC
          `),
          pool.request().query(`
            SELECT TOP 5
              p.ProdName, p.FlowerName,
              COUNT(*) AS order_count,
              SUM(ISNULL(od.BoxQuantity, 0)) AS total_box
            FROM OrderDetail od
            JOIN OrderMaster om ON od.OrderMasterKey = om.OrderMasterKey
            JOIN Product p ON od.ProdKey = p.ProdKey
            WHERE ISNULL(od.isDeleted, 0) = 0
              AND ISNULL(om.isDeleted, 0) = 0
              AND om.CreateDtm >= DATEADD(DAY, -${days}, GETDATE())
            GROUP BY p.ProdName, p.FlowerName
            ORDER BY order_count DESC
          `),
        ]);

        return {
          orders: orders.recordset[0],
          shipments: shipments.recordset[0],
          topCustomers: topCustomers.recordset,
          topProducts: topProducts.recordset,
        };
      });

      // ── 4. 사용 패턴 요약 ──
      const nenovaScreenEvents = await orbitDb.query(`
        SELECT COUNT(*) AS cnt
        FROM events
        WHERE timestamp >= (NOW() - INTERVAL '1 day' * $1)::TEXT
          AND (
            data_json->>'windowTitle' ILIKE '%nenova%'
            OR data_json->>'windowTitle' ILIKE '%화훼%'
            OR data_json->>'currentApp' ILIKE '%nenova%'
          )
      `, [days]).catch(() => ({ rows: [{ cnt: 0 }] }));

      // ── 5. 카카오 메시지 현황 ──
      const kakaoStats = await orbitDb.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN message ILIKE '%주문%' OR message ILIKE '%박스%' THEN 1 END) AS order_related
        FROM kakao_messages
        WHERE created_at >= NOW() - INTERVAL '1 day' * $1
      `, [days]).catch(() => ({ rows: [{ total: 0, order_related: 0 }] }));

      // ── 리포트 조합 ──
      const oP = parseInt(orbitProdCount.rows[0].cnt) || 0;
      const oC = parseInt(orbitCustCount.rows[0].cnt) || 0;
      const oO = parseInt(orbitOrderCount.rows[0].cnt) || 0;
      const nP = nenovaCounts.products;
      const nC = nenovaCounts.customers;

      const totalOrbitEvents = orbitEventStats.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
      const totalUsers = new Set(orbitEventStats.rows.map(r => r.users)).size;

      const activeDays = nenovaActivity.orders.active_days || 1;
      const ordersPerDay = Math.round(nenovaActivity.orders.total / activeDays);

      res.json({
        ok: true,
        insights: 'report',
        period: `${days}일`,
        generatedAt: new Date().toISOString(),

        // 1. 데이터 동기화
        syncStatus: {
          products: { orbit: oP, nenova: nP, rate: `${nP > 0 ? Math.round((oP / nP) * 100) : 0}%` },
          customers: { orbit: oC, nenova: nC, rate: `${nC > 0 ? Math.round((oC / nC) * 100) : 0}%` },
          orders: { orbit: oO, nenovaDetails: nenovaCounts.orderDetails },
        },

        // 2. Orbit 데이터 수집
        orbitCollection: {
          totalEvents: totalOrbitEvents,
          eventTypes: orbitEventStats.rows.map(r => ({
            type: r.type,
            count: parseInt(r.cnt),
            users: parseInt(r.users),
          })),
          nenovaRelatedEvents: parseInt(nenovaScreenEvents.rows[0].cnt),
          kakaoMessages: {
            total: parseInt(kakaoStats.rows[0].total),
            orderRelated: parseInt(kakaoStats.rows[0].order_related),
          },
        },

        // 3. nenova 업무 현황
        nenovaBusiness: {
          period: `${activeDays}영업일`,
          totalOrders: nenovaActivity.orders.total,
          ordersPerDay,
          totalShipments: nenovaActivity.shipments.total,
          uniqueCustomers: nenovaActivity.orders.unique_customers,
          uniqueUsers: nenovaActivity.orders.unique_users,
          topCustomers: nenovaActivity.topCustomers.map(c => ({
            name: c.CustName,
            orders: c.order_count,
            totalBox: c.total_box,
          })),
          topProducts: nenovaActivity.topProducts.map(p => ({
            name: p.ProdName,
            flower: p.FlowerName,
            orders: p.order_count,
            totalBox: p.total_box,
          })),
        },

        // 4. 핵심 인사이트
        keyInsights: [
          {
            area: '데이터 파이프라인',
            finding: `일 ${ordersPerDay}건 주문 처리 중, Orbit 이벤트 ${totalOrbitEvents}건 수집`,
            action: oP < nP ? '상품 마스터 동기화 우선 실행 필요' : '데이터 동기화 양호',
          },
          {
            area: '자동화 기회',
            finding: `주문 등록이 가장 빈번한 작업 (일 ${ordersPerDay}건)`,
            action: '카카오→전산 자동 입력 파이프라인 구축 1순위',
          },
          {
            area: 'Orbit OS 설계',
            finding: `전산 관련 이벤트 ${parseInt(nenovaScreenEvents.rows[0].cnt)}건 — 주문/출하 화면 중심`,
            action: 'Orbit OS 메인 메뉴에 주문 등록/관리, 출하 처리 최우선 배치',
          },
        ],

        // 5. 다음 액션
        nextActions: [
          ...(oP < nP ? ['POST /api/nenova/sync/products — 상품 마스터 동기화'] : []),
          ...(oC < nC ? ['POST /api/nenova/sync/customers — 거래처 마스터 동기화'] : []),
          'GET /api/cross/insights/automation — 자동화 기회 상세 분석',
          'GET /api/cross/insights/priority — 기능 우선순위 확인',
          'GET /api/cross/flow/gaps — 데이터 누락 점검',
        ],
      });
    } catch (err) {
      handleError(res, err, 'insights/report');
    }
  });


  // ── 라우터 반환 ──
  return router;
};
