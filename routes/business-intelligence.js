'use strict';
/**
 * routes/business-intelligence.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 비즈니스 인텔리전스 — 회사의 "비즈니스 브레인"
 *
 * 데이터를 해석해서 사장에게 "무엇이 중요한지" 알려주는 엔진
 *
 * ⚠️ 절대 규칙: nenova SQL Server에는 SELECT만 실행한다.
 *
 * ─── 현황 분석 ───
 *   GET /api/bi/health              — 회사 전체 건강도 (0-100 + 등급)
 *   GET /api/bi/pulse               — 오늘의 핵심 지표 (경영자 1분 브리핑)
 *   GET /api/bi/alerts              — 지금 주의해야 할 것들 (리스크 + 기회)
 *
 * ─── 깊은 분석 ───
 *   GET /api/bi/revenue             — 매출 분석 (추이, 집중도, 계절성)
 *   GET /api/bi/customers           — 거래처 분석 (의존도, 이탈 위험, 성장)
 *   GET /api/bi/products            — 상품 분석 (수익성, 인기도, 재고 리스크)
 *   GET /api/bi/operations          — 운영 효율 (직원, 프로세스, 병목)
 *   GET /api/bi/supply-chain        — 공급망 분석 (국가별 의존도, 리드타임, 리스크)
 *
 * ─── 예측 + 추천 ───
 *   GET /api/bi/forecast            — 다음 주/월 예측 (주문량, 매출, 재고)
 *   GET /api/bi/risks               — 리스크 목록 (확률 x 영향)
 *   GET /api/bi/opportunities       — 기회 목록 (수익 x 실행가능성)
 *   GET /api/bi/action-items        — 오너가 지금 해야 할 액션 TOP 5
 *
 * ─── 리포트 ───
 *   GET /api/bi/report/daily        — 일일 리포트
 *   GET /api/bi/report/weekly       — 주간 리포트
 * ─────────────────────────────────────────────────────────────────────────────
 */

const express = require('express');

// ═══════════════════════════════════════════════════════════════════════════
// SQL Server 연결 설정 (nenova-db.js와 동일 패턴)
// ═══════════════════════════════════════════════════════════════════════════

let sql;
try {
  sql = require('mssql');
} catch (e) {
  console.warn('[business-intelligence] mssql 패키지 미설치 — npm install mssql 필요');
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
  if (!process.env.NENOVA_DB_PASSWORD) throw new Error('NENOVA_DB_PASSWORD 환경변수가 설정되지 않았습니다');
  if (_pool && _pool.connected) return _pool;
  if (_poolPromise) return _poolPromise;

  _poolPromise = (async () => {
    try {
      _pool = await new sql.ConnectionPool(MSSQL_CONFIG).connect();
      _lastError = null;
      console.log('[business-intelligence] SQL Server 연결 성공');
      _pool.on('error', (err) => {
        console.error('[business-intelligence] 풀 에러:', err.message);
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
// 안전 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

async function nenovaQuery(queryStr) {
  try {
    const result = await safeQuery(async (pool) => pool.request().query(queryStr));
    return result.recordset || [];
  } catch {
    return [];
  }
}

async function nenovaCount(queryStr) {
  try {
    const result = await safeQuery(async (pool) => pool.request().query(queryStr));
    return parseInt(result.recordset?.[0]?.cnt || 0);
  } catch {
    return 0;
  }
}

async function orbitCount(db, query, params = []) {
  try {
    const result = await db.query(query, params);
    return parseInt(result.rows[0]?.count || result.rows[0]?.cnt || 0);
  } catch {
    return 0;
  }
}

async function orbitQuery(db, query, params = []) {
  try {
    const result = await db.query(query, params);
    return result.rows || [];
  } catch {
    return [];
  }
}

function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().split('T')[0];
}

function getISOWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
}


// ═══════════════════════════════════════════════════════════════════════════
// 라우터 팩토리
// ═══════════════════════════════════════════════════════════════════════════

module.exports = function createBusinessIntelligenceRouter({ getDb }) {
  const router = express.Router();

  function getOrbitDb() {
    const db = getDb();
    if (!db || !db.query) throw new Error('Orbit PostgreSQL DB를 사용할 수 없습니다');
    return db;
  }

  function handleError(res, err, context) {
    console.error(`[business-intelligence] ${context}:`, err.message);
    if (err.message.includes('NENOVA_DB_PASSWORD') || err.message.includes('mssql')) {
      return res.status(503).json({ ok: false, error: err.message, hint: 'nenova DB 연결 설정을 확인하세요' });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BI 캐시 테이블
  // ═══════════════════════════════════════════════════════════════════════════

  async function ensureBiTables() {
    const db = getOrbitDb();
    await db.query(`
      CREATE TABLE IF NOT EXISTS bi_cache (
        id SERIAL PRIMARY KEY,
        cache_key TEXT NOT NULL UNIQUE,
        result_json JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 minutes')
      );
      CREATE INDEX IF NOT EXISTS idx_bi_cache_key ON bi_cache(cache_key);
      CREATE INDEX IF NOT EXISTS idx_bi_cache_exp ON bi_cache(expires_at);
    `);
  }

  try {
    const db = getDb();
    if (db && db.query) {
      ensureBiTables().catch(e => console.warn('[business-intelligence] 테이블 초기화 실패:', e.message));
    }
  } catch (_) {}

  // ── 캐시 헬퍼 ──
  async function getCached(db, key, ttlMinutes = 30) {
    try {
      const result = await db.query(
        `SELECT result_json FROM bi_cache WHERE cache_key = $1 AND expires_at > NOW()`,
        [key]
      );
      if (result.rows.length > 0) return result.rows[0].result_json;
    } catch {}
    return null;
  }

  async function setCache(db, key, value, ttlMinutes = 30) {
    try {
      await db.query(`
        INSERT INTO bi_cache (cache_key, result_json, expires_at)
        VALUES ($1, $2, NOW() + INTERVAL '${ttlMinutes} minutes')
        ON CONFLICT (cache_key) DO UPDATE SET result_json = $2, expires_at = NOW() + INTERVAL '${ttlMinutes} minutes', created_at = NOW()
      `, [key, JSON.stringify(value)]);
    } catch {}
  }


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     1. 회사 건강도
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/health
   * 회사 전체 건강도 0-100 + 등급
   */
  router.get('/health', async (req, res) => {
    try {
      const db = getOrbitDb();

      // 캐시 확인 (30분)
      const cached = await getCached(db, 'bi:health');
      if (cached && !req.query.refresh) return res.json(cached);

      const dimensions = {
        revenue_stability: { score: 50, weight: 20, detail: '' },
        customer_concentration: { score: 50, weight: 15, detail: '' },
        inventory_health: { score: 50, weight: 10, detail: '' },
        operational_efficiency: { score: 50, weight: 15, detail: '' },
        cash_flow_risk: { score: 50, weight: 15, detail: '' },
        supply_chain_risk: { score: 50, weight: 10, detail: '' },
        growth_trajectory: { score: 50, weight: 10, detail: '' },
        employee_health: { score: 50, weight: 5, detail: '' },
      };

      // ── 1) 매출 안정성 ──
      const weeklyOrders = await nenovaQuery(`
        SELECT
          DATEPART(ISO_WEEK, om.OrderDate) as wk,
          COUNT(*) as order_cnt,
          COUNT(DISTINCT od.CustKey) as cust_cnt
        FROM OrderMaster om
        JOIN OrderDetail od ON om.OrderKey = od.OrderKey
        WHERE om.OrderDate >= DATEADD(WEEK, -8, GETDATE())
        GROUP BY DATEPART(ISO_WEEK, om.OrderDate)
        ORDER BY wk
      `);
      if (weeklyOrders.length >= 3) {
        const counts = weeklyOrders.map(r => parseInt(r.order_cnt));
        const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
        const stddev = Math.sqrt(counts.reduce((s, c) => s + (c - avg) ** 2, 0) / counts.length);
        const cv = avg > 0 ? stddev / avg : 1; // coefficient of variation
        dimensions.revenue_stability.score = Math.max(0, Math.min(100, Math.round((1 - cv) * 100)));
        dimensions.revenue_stability.detail = `최근 ${weeklyOrders.length}주 주문 편차 CV=${cv.toFixed(2)}, 평균 ${Math.round(avg)}건/주`;
        // 추세 확인
        if (counts.length >= 4) {
          const recent = counts.slice(-2).reduce((s, c) => s + c, 0) / 2;
          const earlier = counts.slice(0, 2).reduce((s, c) => s + c, 0) / 2;
          if (recent < earlier * 0.8) {
            dimensions.revenue_stability.score = Math.max(dimensions.revenue_stability.score - 20, 0);
            dimensions.revenue_stability.detail += ' — 하락 추세 감지';
          }
        }
      }

      // ── 2) 거래처 집중도 ──
      const custConcentration = await nenovaQuery(`
        SELECT TOP 10 od.CustKey, c.CustName,
          COUNT(*) as order_cnt
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY od.CustKey, c.CustName
        ORDER BY order_cnt DESC
      `);
      if (custConcentration.length > 0) {
        const totalOrders = custConcentration.reduce((s, r) => s + parseInt(r.order_cnt), 0);
        const top3Orders = custConcentration.slice(0, 3).reduce((s, r) => s + parseInt(r.order_cnt), 0);
        const top3Pct = totalOrders > 0 ? Math.round((top3Orders / totalOrders) * 100) : 0;

        // Herfindahl–Hirschman Index
        const hhi = custConcentration.reduce((s, r) => {
          const share = parseInt(r.order_cnt) / totalOrders;
          return s + share * share;
        }, 0);

        // 0.15 이상이면 과도한 집중
        if (hhi > 0.25) {
          dimensions.customer_concentration.score = 20;
        } else if (hhi > 0.15) {
          dimensions.customer_concentration.score = 40;
        } else if (hhi > 0.10) {
          dimensions.customer_concentration.score = 60;
        } else {
          dimensions.customer_concentration.score = 80;
        }
        dimensions.customer_concentration.detail = `상위 3곳 비율 ${top3Pct}% (${custConcentration.slice(0, 3).map(r => r.CustName).join(', ')}), HHI=${hhi.toFixed(3)}`;
      }

      // ── 3) 재고 건강도 ──
      const stockStatus = await nenovaQuery(`
        SELECT COUNT(*) as total, SUM(CASE WHEN Qty > 0 THEN 1 ELSE 0 END) as in_stock,
               SUM(CASE WHEN Qty <= 0 THEN 1 ELSE 0 END) as out_of_stock,
               SUM(CASE WHEN Qty > 100 THEN 1 ELSE 0 END) as overstock
        FROM StockMaster
      `);
      if (stockStatus.length > 0) {
        const s = stockStatus[0];
        const total = parseInt(s.total || 0);
        const inStock = parseInt(s.in_stock || 0);
        const overstock = parseInt(s.overstock || 0);
        if (total > 0) {
          const inStockRate = inStock / total;
          const overstockRate = overstock / total;
          dimensions.inventory_health.score = Math.round(Math.max(0, (inStockRate * 80) - (overstockRate * 30)));
          dimensions.inventory_health.detail = `총 ${total}품목, 재고있음 ${inStock}, 과다재고 ${overstock}`;
        }
      }

      // ── 4) 운영 효율 ──
      const activeUsers = await orbitCount(db,
        `SELECT COUNT(DISTINCT user_id) as count FROM events
         WHERE created_at > NOW() - INTERVAL '7 days'`
      );
      const totalEvents7d = await orbitCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE created_at > NOW() - INTERVAL '7 days'`
      );
      // 사용자 대비 이벤트 밀도
      if (activeUsers > 0 && totalEvents7d > 0) {
        const eventsPerUser = totalEvents7d / activeUsers / 7;
        // 하루 500~2000 이벤트가 정상 범위로 가정
        if (eventsPerUser > 500 && eventsPerUser < 2000) {
          dimensions.operational_efficiency.score = 75;
        } else if (eventsPerUser >= 2000) {
          dimensions.operational_efficiency.score = 60; // 과다 활동 = 비효율?
        } else {
          dimensions.operational_efficiency.score = 50;
        }
        dimensions.operational_efficiency.detail = `활성 사용자 ${activeUsers}명, 일 평균 ${Math.round(eventsPerUser)}이벤트/인`;
      }

      // ── 5) 자금 리스크 (미수금 데이터 없으므로 기본값) ──
      dimensions.cash_flow_risk.score = 40;
      dimensions.cash_flow_risk.detail = '미수금 추적 시스템 미구축 — 리스크 판단 불가';

      // ── 6) 공급망 리스크 ──
      const countryDep = await nenovaQuery(`
        SELECT TOP 5 p.CountryName, COUNT(*) as cnt
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        AND p.CountryName IS NOT NULL AND p.CountryName != ''
        GROUP BY p.CountryName
        ORDER BY cnt DESC
      `);
      if (countryDep.length > 0) {
        const totalCountry = countryDep.reduce((s, r) => s + parseInt(r.cnt), 0);
        const topCountryPct = totalCountry > 0 ? Math.round((parseInt(countryDep[0].cnt) / totalCountry) * 100) : 0;
        if (topCountryPct > 70) {
          dimensions.supply_chain_risk.score = 25;
        } else if (topCountryPct > 50) {
          dimensions.supply_chain_risk.score = 45;
        } else if (topCountryPct > 30) {
          dimensions.supply_chain_risk.score = 70;
        } else {
          dimensions.supply_chain_risk.score = 85;
        }
        dimensions.supply_chain_risk.detail = `최대 의존 국가: ${countryDep[0].CountryName} (${topCountryPct}%), 총 ${countryDep.length}개국`;
      }

      // ── 7) 성장 궤적 ──
      const growthData = await nenovaQuery(`
        SELECT
          YEAR(om.OrderDate) as yr, MONTH(om.OrderDate) as mo,
          COUNT(*) as order_cnt
        FROM OrderMaster om
        WHERE om.OrderDate >= DATEADD(YEAR, -1, GETDATE())
        GROUP BY YEAR(om.OrderDate), MONTH(om.OrderDate)
        ORDER BY yr, mo
      `);
      if (growthData.length >= 4) {
        const recent3 = growthData.slice(-3).reduce((s, r) => s + parseInt(r.order_cnt), 0);
        const earlier3 = growthData.slice(-6, -3).reduce((s, r) => s + parseInt(r.order_cnt), 0);
        if (earlier3 > 0) {
          const growthRate = (recent3 - earlier3) / earlier3;
          if (growthRate > 0.1) {
            dimensions.growth_trajectory.score = 85;
          } else if (growthRate > 0) {
            dimensions.growth_trajectory.score = 70;
          } else if (growthRate > -0.1) {
            dimensions.growth_trajectory.score = 50;
          } else {
            dimensions.growth_trajectory.score = 30;
          }
          dimensions.growth_trajectory.detail = `최근 3개월 vs 이전 3개월: ${growthRate > 0 ? '+' : ''}${Math.round(growthRate * 100)}%`;
        }
      }

      // ── 8) 직원 건강도 ──
      const overtimeEvents = await orbitCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul') >= 19
         AND created_at > NOW() - INTERVAL '30 days'`
      );
      const totalEventsMonth = await orbitCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE created_at > NOW() - INTERVAL '30 days'`
      );
      if (totalEventsMonth > 0) {
        const overtimeRate = overtimeEvents / totalEventsMonth;
        if (overtimeRate < 0.05) {
          dimensions.employee_health.score = 90;
        } else if (overtimeRate < 0.15) {
          dimensions.employee_health.score = 70;
        } else if (overtimeRate < 0.25) {
          dimensions.employee_health.score = 50;
        } else {
          dimensions.employee_health.score = 30;
        }
        dimensions.employee_health.detail = `야근 비율 ${Math.round(overtimeRate * 100)}% (19시 이후 활동)`;
      }

      // ── 종합 점수 ──
      const totalWeight = Object.values(dimensions).reduce((s, d) => s + d.weight, 0);
      const weightedScore = Object.values(dimensions).reduce((s, d) => s + d.score * d.weight, 0);
      const overallScore = Math.round(weightedScore / totalWeight);

      const grade = overallScore >= 85 ? 'A+' : overallScore >= 75 ? 'A' :
        overallScore >= 65 ? 'B+' : overallScore >= 55 ? 'B' :
        overallScore >= 45 ? 'C+' : overallScore >= 35 ? 'C' : 'D';

      const result = {
        ok: true,
        score: overallScore,
        grade,
        grade_label: grade.startsWith('A') ? '양호' : grade.startsWith('B') ? '보통' : grade.startsWith('C') ? '주의' : '위험',
        dimensions: Object.fromEntries(
          Object.entries(dimensions).map(([k, v]) => [k, { score: v.score, detail: v.detail }])
        ),
        weakest: Object.entries(dimensions).sort((a, b) => a[1].score - b[1].score).slice(0, 3).map(([k, v]) => ({
          dimension: k, score: v.score, detail: v.detail,
        })),
        measured_at: new Date().toISOString(),
      };

      await setCache(db, 'bi:health', result, 30);
      res.json(result);
    } catch (err) {
      handleError(res, err, 'health');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     2. 오늘의 핵심 지표 (1분 브리핑)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/pulse
   * 경영자 1분 브리핑 — 오늘 가장 중요한 것들
   */
  router.get('/pulse', async (req, res) => {
    try {
      const db = getOrbitDb();
      const today = todayKST();

      // 오늘 주문
      const todayOrders = await nenovaQuery(`
        SELECT COUNT(*) as cnt, COUNT(DISTINCT od.CustKey) as cust_cnt
        FROM OrderMaster om
        JOIN OrderDetail od ON om.OrderKey = od.OrderKey
        WHERE CONVERT(DATE, om.OrderDate) = CONVERT(DATE, GETDATE())
      `);

      // 이번 주 주문 vs 지난 주
      const thisWeekOrders = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM OrderMaster
        WHERE DATEPART(ISO_WEEK, OrderDate) = DATEPART(ISO_WEEK, GETDATE())
        AND YEAR(OrderDate) = YEAR(GETDATE())
      `);
      const lastWeekOrders = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM OrderMaster
        WHERE DATEPART(ISO_WEEK, OrderDate) = DATEPART(ISO_WEEK, DATEADD(WEEK, -1, GETDATE()))
        AND YEAR(OrderDate) >= YEAR(GETDATE()) - 1
      `);

      // 활성 직원 (오늘)
      const activeToday = await orbitCount(db,
        `SELECT COUNT(DISTINCT user_id) as count FROM events
         WHERE created_at::DATE = CURRENT_DATE`
      );

      // 오늘 이벤트
      const eventsToday = await orbitCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE created_at::DATE = CURRENT_DATE`
      );

      // 신규 거래처 (이번 주)
      const newCustomers = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM Customer
        WHERE InsertDate >= DATEADD(WEEK, -1, GETDATE())
      `);

      // 재고 부족 품목
      const lowStockItems = await nenovaQuery(`
        SELECT TOP 5 p.ProdName, sm.Qty
        FROM StockMaster sm
        JOIN Product p ON sm.ProdKey = p.ProdKey
        WHERE sm.Qty > 0 AND sm.Qty <= 5
        ORDER BY sm.Qty ASC
      `);

      const weekChange = lastWeekOrders > 0
        ? Math.round(((thisWeekOrders - lastWeekOrders) / lastWeekOrders) * 100)
        : 0;

      res.json({
        ok: true,
        date: today,
        pulse: {
          today_orders: parseInt(todayOrders[0]?.cnt || 0),
          today_customers: parseInt(todayOrders[0]?.cust_cnt || 0),
          this_week_orders: thisWeekOrders,
          last_week_orders: lastWeekOrders,
          week_change_pct: weekChange,
          week_trend: weekChange > 5 ? '증가' : weekChange < -5 ? '감소' : '유지',
          active_employees: activeToday,
          events_today: eventsToday,
          new_customers_week: newCustomers,
          low_stock_items: lowStockItems.map(r => ({
            product: r.ProdName,
            remaining: parseInt(r.Qty),
            urgency: parseInt(r.Qty) <= 2 ? 'critical' : 'warning',
          })),
        },
        briefing: generateBriefing({
          todayOrders: parseInt(todayOrders[0]?.cnt || 0),
          weekChange,
          lowStockItems,
          activeToday,
        }),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'pulse');
    }
  });

  /**
   * 1분 브리핑 텍스트 자동 생성
   */
  function generateBriefing({ todayOrders, weekChange, lowStockItems, activeToday }) {
    const lines = [];
    lines.push(`오늘 주문 ${todayOrders}건 접수.`);

    if (weekChange > 10) {
      lines.push(`이번 주 주문량이 지난 주 대비 ${weekChange}% 증가 — 성장 신호.`);
    } else if (weekChange < -10) {
      lines.push(`이번 주 주문량이 지난 주 대비 ${Math.abs(weekChange)}% 감소 — 원인 파악 필요.`);
    } else {
      lines.push(`이번 주 주문량은 지난 주와 비슷한 수준 유지.`);
    }

    if (lowStockItems.length > 0) {
      const critical = lowStockItems.filter(r => parseInt(r.Qty) <= 2);
      if (critical.length > 0) {
        lines.push(`긴급: ${critical.map(r => r.ProdName).join(', ')} 재고 2박스 이하 — 즉시 확인 필요.`);
      } else {
        lines.push(`재고 부족 주의 품목 ${lowStockItems.length}개.`);
      }
    }

    if (activeToday === 0) {
      lines.push(`오늘 활동 감지된 직원 없음 (휴일 또는 데몬 문제).`);
    } else {
      lines.push(`오늘 ${activeToday}명 활동 중.`);
    }

    return lines.join(' ');
  }


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     3. 알림 (주의사항)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/alerts
   * 지금 주의해야 할 것들 — 리스크 + 기회 자동 감지
   */
  router.get('/alerts', async (req, res) => {
    try {
      const db = getOrbitDb();
      const alerts = [];

      // ── 매출 알림 ──
      // 상위 거래처 집중도
      const topCust = await nenovaQuery(`
        SELECT TOP 5 od.CustKey, c.CustName, COUNT(*) as order_cnt
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY od.CustKey, c.CustName
        ORDER BY order_cnt DESC
      `);
      if (topCust.length >= 3) {
        const totalOrders = await nenovaCount(`
          SELECT COUNT(*) as cnt FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())
        `);
        const top3Total = topCust.slice(0, 3).reduce((s, r) => s + parseInt(r.order_cnt), 0);
        const top3Pct = totalOrders > 0 ? Math.round((top3Total / totalOrders) * 100) : 0;
        if (top3Pct > 40) {
          alerts.push({
            type: 'revenue',
            severity: top3Pct > 60 ? 'critical' : 'warning',
            title: '거래처 집중도 과다',
            message: `상위 3 거래처(${topCust.slice(0, 3).map(r => r.CustName).join(', ')})가 매출의 ${top3Pct}% 차지 — 1곳 이탈 시 매출 ${Math.round(top3Pct / 3)}% 감소`,
            action: '신규 거래처 개발 또는 기존 중소 거래처 거래량 확대',
          });
        }
      }

      // 주간 주문량 변화
      const thisWeek = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM OrderMaster
        WHERE DATEPART(ISO_WEEK, OrderDate) = DATEPART(ISO_WEEK, GETDATE()) AND YEAR(OrderDate) = YEAR(GETDATE())
      `);
      const prevWeek = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM OrderMaster
        WHERE DATEPART(ISO_WEEK, OrderDate) = DATEPART(ISO_WEEK, DATEADD(WEEK, -1, GETDATE()))
        AND YEAR(OrderDate) >= YEAR(GETDATE()) - 1
      `);
      if (prevWeek > 0) {
        const changePct = Math.round(((thisWeek - prevWeek) / prevWeek) * 100);
        if (changePct < -15) {
          alerts.push({
            type: 'revenue',
            severity: changePct < -30 ? 'critical' : 'warning',
            title: '주문량 감소',
            message: `이번 주 주문량 전주 대비 ${Math.abs(changePct)}% 감소 — 계절적 vs 이상 징후 판단 필요`,
            action: '주요 거래처 연락하여 원인 확인',
            data: { this_week: thisWeek, prev_week: prevWeek, change_pct: changePct },
          });
        } else if (changePct > 20) {
          alerts.push({
            type: 'revenue',
            severity: 'info',
            title: '주문량 급증',
            message: `이번 주 주문량 전주 대비 ${changePct}% 증가 — 인력/재고 대응 점검 필요`,
            action: '재고 확인 + 출하 인력 배치 점검',
            data: { this_week: thisWeek, prev_week: prevWeek, change_pct: changePct },
          });
        }
      }

      // ── 거래처 알림 ──
      // 주문 빈도 감소 거래처 감지
      const churnCandidates = await nenovaQuery(`
        SELECT c.CustName, c.CustKey,
          SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) as recent,
          SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -6, GETDATE()) AND od.InputDate < DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) as earlier
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(WEEK, -6, GETDATE())
        GROUP BY c.CustName, c.CustKey
        HAVING SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -6, GETDATE()) AND od.InputDate < DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) > 5
        ORDER BY (CAST(SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) AS FLOAT) /
                  NULLIF(SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -6, GETDATE()) AND od.InputDate < DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END), 0)) ASC
      `);
      for (const cust of churnCandidates.slice(0, 3)) {
        const recent = parseInt(cust.recent || 0);
        const earlier = parseInt(cust.earlier || 0);
        if (earlier > 0 && recent < earlier * 0.5) {
          const declinePct = Math.round(((earlier - recent) / earlier) * 100);
          alerts.push({
            type: 'customer',
            severity: declinePct > 70 ? 'warning' : 'info',
            title: `${cust.CustName} 주문 감소`,
            message: `${cust.CustName}의 최근 2주 주문이 이전 4주 대비 ${declinePct}% 감소 — 이탈 조기 경고`,
            action: '해당 거래처 직접 연락 — 불만, 경쟁사 전환, 시즌 변동인지 확인',
            data: { customer: cust.CustName, recent, earlier, decline_pct: declinePct },
          });
        }
      }

      // 신규 거래처
      const newCusts = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM Customer WHERE InsertDate >= DATEADD(WEEK, -2, GETDATE())
      `);
      if (newCusts > 0) {
        alerts.push({
          type: 'customer',
          severity: 'info',
          title: `신규 거래처 ${newCusts}곳 추가`,
          message: `최근 2주 내 ${newCusts}개 신규 거래처 등록 — 성장 신호`,
          action: '신규 거래처 첫 주문 관리 집중',
        });
      }

      // ── 재고 알림 ──
      const criticalStock = await nenovaQuery(`
        SELECT TOP 10 p.ProdName, sm.Qty
        FROM StockMaster sm
        JOIN Product p ON sm.ProdKey = p.ProdKey
        WHERE sm.Qty > 0 AND sm.Qty <= 5
        ORDER BY sm.Qty ASC
      `);
      for (const item of criticalStock) {
        const qty = parseInt(item.Qty);
        alerts.push({
          type: 'inventory',
          severity: qty <= 2 ? 'critical' : 'warning',
          title: `${item.ProdName} 재고 부족`,
          message: `${item.ProdName} 재고 ${qty}박스 — ${qty <= 2 ? '2~3일 내 소진 예상' : '1주 내 소진 예상'}`,
          action: qty <= 2 ? '긴급 발주 필요' : '발주 검토',
        });
      }

      // 과다 재고
      const overstockItems = await nenovaQuery(`
        SELECT TOP 5 p.ProdName, sm.Qty
        FROM StockMaster sm
        JOIN Product p ON sm.ProdKey = p.ProdKey
        WHERE sm.Qty > 50
        ORDER BY sm.Qty DESC
      `);
      for (const item of overstockItems) {
        alerts.push({
          type: 'inventory',
          severity: 'info',
          title: `${item.ProdName} 과다 재고`,
          message: `${item.ProdName} 재고 ${item.Qty}박스 — 장기 보관 시 품질 저하 우려`,
          action: '프로모션 또는 할인 판매 검토',
        });
      }

      // ── 직원 알림 ──
      const overtimeUsers = await orbitQuery(db, `
        SELECT user_id, COUNT(*) as late_events
        FROM events
        WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul') >= 20
        AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY user_id
        HAVING COUNT(*) > 10
        ORDER BY late_events DESC
      `);
      for (const u of overtimeUsers) {
        alerts.push({
          type: 'employee',
          severity: parseInt(u.late_events) > 50 ? 'warning' : 'info',
          title: `직원 야근 패턴 감지`,
          message: `${u.user_id.substring(0, 12)}... 최근 2주 20시 이후 활동 ${u.late_events}건 — 업무량 확인 필요`,
          action: '해당 직원 업무 분배 점검, 번아웃/이직 리스크',
        });
      }

      // AI 도구 과다 사용
      const aiUsers = await orbitQuery(db, `
        SELECT user_id, COUNT(*) as ai_events
        FROM events
        WHERE (data_json->>'windowTitle' ILIKE '%claude%' OR data_json->>'windowTitle' ILIKE '%chatgpt%'
               OR data_json->>'appName' ILIKE '%claude%')
        AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY user_id
        HAVING COUNT(*) > 30
        ORDER BY ai_events DESC
      `);
      for (const u of aiUsers) {
        alerts.push({
          type: 'employee',
          severity: 'info',
          title: `AI 도구 빈번 사용 감지`,
          message: `${u.user_id.substring(0, 12)}... 최근 7일 AI 사용 ${u.ai_events}회 — 도구 교육 또는 프로세스 개선 기회`,
          action: 'AI 활용 업무 파악 → 자동화 스크립트 전환 검토',
        });
      }

      // ── 공급망 알림 ──
      const topCountry = await nenovaQuery(`
        SELECT TOP 1 p.CountryName, COUNT(*) as cnt,
          COUNT(*) * 100.0 / (SELECT COUNT(*) FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())) as pct
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        AND p.CountryName IS NOT NULL AND p.CountryName != ''
        GROUP BY p.CountryName
        ORDER BY cnt DESC
      `);
      if (topCountry.length > 0) {
        const pct = Math.round(parseFloat(topCountry[0].pct || 0));
        if (pct > 50) {
          alerts.push({
            type: 'supply_chain',
            severity: pct > 70 ? 'warning' : 'info',
            title: `${topCountry[0].CountryName} 의존도 ${pct}%`,
            message: `${topCountry[0].CountryName} 의존도 ${pct}% — 정치/물류 리스크 시 대안 부족`,
            action: '대안 국가/농장 탐색, 공급선 다변화',
          });
        }
      }

      // 심각도 정렬
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      alerts.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

      res.json({
        ok: true,
        total: alerts.length,
        by_severity: {
          critical: alerts.filter(a => a.severity === 'critical').length,
          warning: alerts.filter(a => a.severity === 'warning').length,
          info: alerts.filter(a => a.severity === 'info').length,
        },
        by_type: {
          revenue: alerts.filter(a => a.type === 'revenue').length,
          customer: alerts.filter(a => a.type === 'customer').length,
          inventory: alerts.filter(a => a.type === 'inventory').length,
          employee: alerts.filter(a => a.type === 'employee').length,
          supply_chain: alerts.filter(a => a.type === 'supply_chain').length,
        },
        alerts,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'alerts');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     4. 매출 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/revenue
   * 매출 분석 (추이, 집중도, 계절성)
   * ?period=3m (1m/3m/6m/1y)
   */
  router.get('/revenue', async (req, res) => {
    try {
      const period = req.query.period || '3m';
      const periodMap = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 };
      const months = periodMap[period] || 3;

      // 주간별 주문 추이
      const weeklyTrend = await nenovaQuery(`
        SELECT DATEPART(ISO_WEEK, om.OrderDate) as week_num,
          MIN(CONVERT(VARCHAR, om.OrderDate, 23)) as week_start,
          COUNT(DISTINCT om.OrderKey) as order_count,
          COUNT(od.DetailKey) as detail_count,
          COUNT(DISTINCT od.CustKey) as customer_count,
          COUNT(DISTINCT od.ProdKey) as product_count
        FROM OrderMaster om
        JOIN OrderDetail od ON om.OrderKey = od.OrderKey
        WHERE om.OrderDate >= DATEADD(MONTH, -${months}, GETDATE())
        GROUP BY DATEPART(ISO_WEEK, om.OrderDate)
        ORDER BY week_num
      `);

      // 거래처별 매출 집중도
      const customerRevenue = await nenovaQuery(`
        SELECT TOP 20 c.CustName, COUNT(*) as order_cnt,
          COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -${months}, GETDATE())), 0) as pct
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -${months}, GETDATE())
        GROUP BY c.CustName
        ORDER BY order_cnt DESC
      `);

      // 월별 추이
      const monthlyTrend = await nenovaQuery(`
        SELECT YEAR(om.OrderDate) as yr, MONTH(om.OrderDate) as mo,
          COUNT(DISTINCT om.OrderKey) as orders,
          COUNT(od.DetailKey) as details,
          COUNT(DISTINCT od.CustKey) as customers
        FROM OrderMaster om
        JOIN OrderDetail od ON om.OrderKey = od.OrderKey
        WHERE om.OrderDate >= DATEADD(MONTH, -${months}, GETDATE())
        GROUP BY YEAR(om.OrderDate), MONTH(om.OrderDate)
        ORDER BY yr, mo
      `);

      // 품목별 주문
      const productRevenue = await nenovaQuery(`
        SELECT TOP 15 p.ProdName, p.FlowerName, COUNT(*) as cnt
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -${months}, GETDATE())
        GROUP BY p.ProdName, p.FlowerName
        ORDER BY cnt DESC
      `);

      res.json({
        ok: true,
        period,
        weekly_trend: weeklyTrend.map(r => ({
          week: parseInt(r.week_num),
          week_start: r.week_start,
          orders: parseInt(r.order_count),
          details: parseInt(r.detail_count),
          customers: parseInt(r.customer_count),
          products: parseInt(r.product_count),
        })),
        monthly_trend: monthlyTrend.map(r => ({
          year: parseInt(r.yr),
          month: parseInt(r.mo),
          orders: parseInt(r.orders),
          details: parseInt(r.details),
          customers: parseInt(r.customers),
        })),
        customer_concentration: customerRevenue.map(r => ({
          customer: r.CustName,
          orders: parseInt(r.order_cnt),
          pct: Math.round(parseFloat(r.pct || 0) * 10) / 10,
        })),
        top_products: productRevenue.map(r => ({
          product: r.ProdName,
          flower: r.FlowerName,
          orders: parseInt(r.cnt),
        })),
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'revenue');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     5. 거래처 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/customers
   * 거래처 분석 (의존도, 이탈 위험, 성장)
   */
  router.get('/customers', async (req, res) => {
    try {
      const totalCustomers = await nenovaCount('SELECT COUNT(*) as cnt FROM Customer');

      // 최근 30일 활성 거래처
      const activeCustomers = await nenovaQuery(`
        SELECT DISTINCT c.CustKey, c.CustName
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(DAY, -30, GETDATE())
      `);

      // 상위 거래처 집중도
      const top10 = await nenovaQuery(`
        SELECT TOP 10 c.CustName, c.CustKey, COUNT(*) as cnt
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY c.CustName, c.CustKey
        ORDER BY cnt DESC
      `);
      const totalOdCnt = await nenovaCount(
        `SELECT COUNT(*) as cnt FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())`
      );

      // HHI 계산
      let hhi = 0;
      for (const c of top10) {
        const share = parseInt(c.cnt) / (totalOdCnt || 1);
        hhi += share * share;
      }

      // 이탈 위험 거래처
      const churnRisk = await nenovaQuery(`
        SELECT c.CustName,
          SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) as recent_2w,
          SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END) as prev_4w
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(WEEK, -6, GETDATE())
        GROUP BY c.CustName
        HAVING SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END) > 3
        ORDER BY (CAST(SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) AS FLOAT) /
                  NULLIF(SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END), 0)) ASC
      `);

      const churnList = [];
      for (const c of churnRisk.slice(0, 10)) {
        const recent = parseInt(c.recent_2w || 0);
        const prev = parseInt(c.prev_4w || 0);
        if (prev > 0 && recent < prev * 0.5) {
          const declinePct = Math.round(((prev - recent) / prev) * 100);
          churnList.push({
            customer: c.CustName,
            signal: `최근 2주 ${recent}건 vs 이전 4주 ${prev}건 (${declinePct}% 감소)`,
            risk: Math.min(declinePct / 100, 0.95),
          });
        }
      }

      // 성장 거래처
      const growthCandidates = await nenovaQuery(`
        SELECT c.CustName,
          SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) as m1,
          SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -2, GETDATE()) AND od.InputDate < DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) as m2,
          SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -3, GETDATE()) AND od.InputDate < DATEADD(MONTH, -2, GETDATE()) THEN 1 ELSE 0 END) as m3
        FROM OrderDetail od
        JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY c.CustName
        HAVING SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) >
               SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -2, GETDATE()) AND od.InputDate < DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END)
        AND SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -2, GETDATE()) AND od.InputDate < DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) >
            SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -3, GETDATE()) AND od.InputDate < DATEADD(MONTH, -2, GETDATE()) THEN 1 ELSE 0 END)
        ORDER BY SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) DESC
      `);

      const growthList = growthCandidates.slice(0, 5).map(c => {
        const m1 = parseInt(c.m1 || 0);
        const m3 = parseInt(c.m3 || 1);
        const growthRate = m3 > 0 ? Math.round(((m1 - m3) / m3) * 100) : 0;
        return {
          customer: c.CustName,
          signal: '주문량 3개월 연속 증가',
          rate: `+${growthRate}%/월`,
        };
      });

      res.json({
        ok: true,
        total: totalCustomers,
        active_30d: activeCustomers.length,
        concentration: {
          top3: {
            names: top10.slice(0, 3).map(r => r.CustName),
            pct: totalOdCnt > 0 ? Math.round((top10.slice(0, 3).reduce((s, r) => s + parseInt(r.cnt), 0) / totalOdCnt) * 100) : 0,
          },
          herfindahl_index: Math.round(hhi * 1000) / 1000,
          risk: hhi > 0.15 ? 'high' : hhi > 0.10 ? 'medium' : 'low',
        },
        churn_risk: churnList,
        growth: growthList,
        top_customers: top10.map(r => ({
          name: r.CustName,
          orders_3m: parseInt(r.cnt),
          pct: totalOdCnt > 0 ? Math.round((parseInt(r.cnt) / totalOdCnt) * 100) : 0,
        })),
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'customers');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     6. 상품 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/products
   * 상품 분석 (인기도, 재고 리스크)
   */
  router.get('/products', async (req, res) => {
    try {
      const totalProducts = await nenovaCount('SELECT COUNT(*) as cnt FROM Product');

      // 인기 상품 (주문 빈도)
      const popular = await nenovaQuery(`
        SELECT TOP 20 p.ProdName, p.FlowerName, p.CountryName, p.FarmName,
          COUNT(*) as order_cnt,
          COUNT(DISTINCT od.CustKey) as customer_cnt
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY p.ProdName, p.FlowerName, p.CountryName, p.FarmName
        ORDER BY order_cnt DESC
      `);

      // 꽃 종류별 집계
      const byFlower = await nenovaQuery(`
        SELECT p.FlowerName, COUNT(*) as cnt, COUNT(DISTINCT p.ProdKey) as varieties
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        AND p.FlowerName IS NOT NULL AND p.FlowerName != ''
        GROUP BY p.FlowerName
        ORDER BY cnt DESC
      `);

      // 재고 리스크
      const inventoryRisk = await nenovaQuery(`
        SELECT p.ProdName, sm.Qty,
          CASE WHEN sm.Qty <= 2 THEN 'critical'
               WHEN sm.Qty <= 5 THEN 'low'
               WHEN sm.Qty > 50 THEN 'overstock'
               ELSE 'normal' END as risk_level
        FROM StockMaster sm
        JOIN Product p ON sm.ProdKey = p.ProdKey
        WHERE sm.Qty > 0
        ORDER BY sm.Qty ASC
      `);

      const riskSummary = {
        critical: inventoryRisk.filter(r => r.risk_level === 'critical').length,
        low: inventoryRisk.filter(r => r.risk_level === 'low').length,
        overstock: inventoryRisk.filter(r => r.risk_level === 'overstock').length,
        normal: inventoryRisk.filter(r => r.risk_level === 'normal').length,
      };

      res.json({
        ok: true,
        total_products: totalProducts,
        popular: popular.map(r => ({
          product: r.ProdName,
          flower: r.FlowerName,
          country: r.CountryName,
          farm: r.FarmName,
          orders_3m: parseInt(r.order_cnt),
          customers: parseInt(r.customer_cnt),
        })),
        by_flower: byFlower.map(r => ({
          flower: r.FlowerName,
          orders: parseInt(r.cnt),
          varieties: parseInt(r.varieties),
        })),
        inventory_risk: {
          summary: riskSummary,
          critical_items: inventoryRisk.filter(r => r.risk_level === 'critical').map(r => ({
            product: r.ProdName, qty: parseInt(r.Qty),
          })),
          overstock_items: inventoryRisk.filter(r => r.risk_level === 'overstock').slice(0, 10).map(r => ({
            product: r.ProdName, qty: parseInt(r.Qty),
          })),
        },
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'products');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     7. 운영 효율
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/operations
   * 운영 효율 분석 (직원, 프로세스, 병목)
   */
  router.get('/operations', async (req, res) => {
    try {
      const db = getOrbitDb();

      // 직원별 활동량 (7일)
      const employeeLoad = await orbitQuery(db, `
        SELECT user_id,
          COUNT(*) as total_events,
          COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul') >= 19) as late_events,
          COUNT(*) FILTER (WHERE type = 'keyboard.activity') as keyboard_events,
          COUNT(DISTINCT created_at::DATE) as active_days,
          MIN(created_at) as first_activity,
          MAX(created_at) as last_activity
        FROM events
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY user_id
        ORDER BY total_events DESC
      `);

      // 앱별 사용 빈도
      const appUsage = await orbitQuery(db, `
        SELECT COALESCE(data_json->>'appName', 'unknown') as app,
          COUNT(*) as cnt
        FROM events
        WHERE created_at > NOW() - INTERVAL '7 days'
        AND data_json->>'appName' IS NOT NULL
        GROUP BY data_json->>'appName'
        ORDER BY cnt DESC
        LIMIT 15
      `);

      // 일일 주문 건수 (nenova 기준 — 주문 처리 업무량 추정)
      const dailyOrderWork = await nenovaQuery(`
        SELECT CONVERT(VARCHAR, OrderDate, 23) as dt, COUNT(*) as cnt
        FROM OrderMaster
        WHERE OrderDate >= DATEADD(DAY, -14, GETDATE())
        GROUP BY CONVERT(VARCHAR, OrderDate, 23)
        ORDER BY dt DESC
      `);

      // 주문 1건 처리 시간 추정 (활동 기반)
      const nenovaEvents = await orbitCount(db,
        `SELECT COUNT(*) as count FROM events
         WHERE (data_json->>'appName' ILIKE '%nenova%' OR data_json->>'windowTitle' ILIKE '%화훼%')
         AND created_at > NOW() - INTERVAL '7 days'`
      );
      const avgDailyOrders = dailyOrderWork.length > 0
        ? Math.round(dailyOrderWork.reduce((s, r) => s + parseInt(r.cnt), 0) / dailyOrderWork.length)
        : 0;

      // 자동화율 추정
      const parsedOrderCount = await orbitCount(db, 'SELECT COUNT(*) as count FROM parsed_orders');
      const totalOrderCount = await nenovaCount('SELECT COUNT(*) as cnt FROM OrderDetail');
      const automationRate = totalOrderCount > 0 ? Math.round((parsedOrderCount / totalOrderCount) * 100) : 0;

      // 병목 추정
      const bottlenecks = [];
      if (avgDailyOrders > 100) {
        bottlenecks.push({
          process: '주문 등록',
          daily_count: avgDailyOrders,
          estimated_time_per_item: '2~3분',
          total_hours: Math.round(avgDailyOrders * 2.5 / 60 * 10) / 10,
          automatable: true,
          suggestion: '클립보드 파싱 → PAD 자동 입력',
        });
      }

      bottlenecks.push({
        process: '차감 대조',
        manual_steps: 5,
        error_rate: '추정 3%',
        automatable: true,
        suggestion: 'openpyxl 자동화 — 엑셀 차감표 자동 처리',
      });

      bottlenecks.push({
        process: '출하 확인',
        manual_steps: 3,
        automatable: true,
        suggestion: 'nenova ShipmentDate 자동 갱신',
      });

      res.json({
        ok: true,
        efficiency_score: Math.min(100, Math.round(automationRate + (activeUsers > 0 ? 50 : 30))),
        bottlenecks,
        employee_load: employeeLoad.map(e => ({
          user_id: e.user_id,
          total_events: parseInt(e.total_events),
          keyboard_events: parseInt(e.keyboard_events),
          late_events: parseInt(e.late_events),
          active_days: parseInt(e.active_days),
          load: parseInt(e.total_events) > 5000 ? 'high' : parseInt(e.total_events) > 2000 ? 'medium' : 'low',
          overtime_risk: parseInt(e.late_events) > 20,
        })),
        app_usage: appUsage.map(a => ({
          app: a.app,
          events: parseInt(a.cnt),
        })),
        automation: {
          current_rate: automationRate,
          potential_rate: 78, // 추정치
          gap: `${78 - automationRate}% 추가 자동화 가능`,
          parsed_orders: parsedOrderCount,
          total_orders: totalOrderCount,
        },
        daily_workload: dailyOrderWork.map(d => ({
          date: d.dt,
          orders: parseInt(d.cnt),
        })),
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'operations');
    }
  });

  // 운영 효율에서 사용하는 변수 (상위 스코프 참조 방지)
  let activeUsers = 0;


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     8. 공급망 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/supply-chain
   * 공급망 분석 (국가별 의존도, 농장, 리스크)
   */
  router.get('/supply-chain', async (req, res) => {
    try {
      // 국가별 의존도
      const byCountry = await nenovaQuery(`
        SELECT p.CountryName, COUNT(*) as order_cnt,
          COUNT(DISTINCT p.ProdKey) as product_cnt,
          COUNT(DISTINCT p.FarmName) as farm_cnt,
          COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())), 0) as pct
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        AND p.CountryName IS NOT NULL AND p.CountryName != ''
        GROUP BY p.CountryName
        ORDER BY order_cnt DESC
      `);

      // 농장별 분석
      const byFarm = await nenovaQuery(`
        SELECT TOP 15 p.FarmName, p.CountryName, COUNT(*) as order_cnt,
          COUNT(DISTINCT p.ProdKey) as product_cnt
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        AND p.FarmName IS NOT NULL AND p.FarmName != ''
        GROUP BY p.FarmName, p.CountryName
        ORDER BY order_cnt DESC
      `);

      // 출하 현황
      const shipmentStatus = await nenovaQuery(`
        SELECT TOP 10 sd.ShipNo, sd.ShipDate, sd.ArrivalDate,
          COUNT(DISTINCT od.CustKey) as customer_cnt
        FROM ShipmentDate sd
        LEFT JOIN OrderDetail od ON sd.ShipNo = od.ShipNo
        WHERE sd.ShipDate >= DATEADD(MONTH, -1, GETDATE())
        GROUP BY sd.ShipNo, sd.ShipDate, sd.ArrivalDate
        ORDER BY sd.ShipDate DESC
      `);

      // 리스크 평가
      const risks = [];
      if (byCountry.length > 0) {
        const topPct = Math.round(parseFloat(byCountry[0].pct || 0));
        if (topPct > 50) {
          risks.push({
            type: 'country_concentration',
            severity: topPct > 70 ? 'high' : 'medium',
            description: `${byCountry[0].CountryName} 의존도 ${topPct}% — 해당 국가 이슈 시 대안 부족`,
            mitigation: '대안 국가 공급선 확보',
          });
        }
        if (byCountry.length <= 2) {
          risks.push({
            type: 'limited_sources',
            severity: 'medium',
            description: `공급 국가 ${byCountry.length}개국 — 다변화 부족`,
            mitigation: '신규 국가 공급선 탐색',
          });
        }
      }

      res.json({
        ok: true,
        by_country: byCountry.map(r => ({
          country: r.CountryName,
          orders: parseInt(r.order_cnt),
          products: parseInt(r.product_cnt),
          farms: parseInt(r.farm_cnt),
          pct: Math.round(parseFloat(r.pct || 0) * 10) / 10,
        })),
        by_farm: byFarm.map(r => ({
          farm: r.FarmName,
          country: r.CountryName,
          orders: parseInt(r.order_cnt),
          products: parseInt(r.product_cnt),
        })),
        recent_shipments: shipmentStatus.map(r => ({
          ship_no: r.ShipNo,
          ship_date: r.ShipDate,
          arrival_date: r.ArrivalDate,
          customers: parseInt(r.customer_cnt),
        })),
        risks,
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'supply-chain');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     9. 예측
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/forecast
   * 다음 주/월 예측 (주문량, 재고)
   */
  router.get('/forecast', async (req, res) => {
    try {
      // 최근 8주 주간 주문량
      const weeklyHistory = await nenovaQuery(`
        SELECT DATEPART(ISO_WEEK, om.OrderDate) as wk,
          COUNT(*) as cnt
        FROM OrderMaster om
        WHERE om.OrderDate >= DATEADD(WEEK, -8, GETDATE())
        GROUP BY DATEPART(ISO_WEEK, om.OrderDate)
        ORDER BY wk
      `);

      let predictedOrders = 0;
      let confidence = 0.5;
      let basis = '';

      if (weeklyHistory.length >= 4) {
        const counts = weeklyHistory.map(r => parseInt(r.cnt));
        const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
        const recentAvg = counts.slice(-3).reduce((s, c) => s + c, 0) / 3;

        // 추세 가중 평균
        predictedOrders = Math.round(recentAvg * 0.6 + avg * 0.4);
        confidence = counts.length >= 6 ? 0.75 : 0.60;
        basis = `최근 ${counts.length}주 평균 ${Math.round(avg)}건 + 최근 3주 가중 (${Math.round(recentAvg)}건)`;
      } else if (weeklyHistory.length > 0) {
        const counts = weeklyHistory.map(r => parseInt(r.cnt));
        predictedOrders = Math.round(counts.reduce((s, c) => s + c, 0) / counts.length);
        confidence = 0.50;
        basis = `데이터 부족 — ${counts.length}주 단순 평균`;
      }

      // 인기 품목 예측
      const topProducts = await nenovaQuery(`
        SELECT TOP 5 p.ProdName, p.FlowerName, COUNT(*) as cnt
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(WEEK, -4, GETDATE())
        GROUP BY p.ProdName, p.FlowerName
        ORDER BY cnt DESC
      `);

      // 재고 소진 예측
      const inventoryAlert = await nenovaQuery(`
        SELECT p.ProdName, sm.Qty
        FROM StockMaster sm
        JOIN Product p ON sm.ProdKey = p.ProdKey
        WHERE sm.Qty > 0 AND sm.Qty <= 15
        ORDER BY sm.Qty ASC
      `);

      // 최근 4주 품목별 평균 주문으로 소진 예측
      const demandByProduct = await nenovaQuery(`
        SELECT p.ProdName, COUNT(*) / 4.0 as weekly_avg
        FROM OrderDetail od
        JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(WEEK, -4, GETDATE())
        GROUP BY p.ProdName
      `);
      const demandMap = {};
      for (const d of demandByProduct) {
        demandMap[d.ProdName] = Math.round(parseFloat(d.weekly_avg));
      }

      const inventoryAlerts = inventoryAlert.map(item => {
        const weeklyDemand = demandMap[item.ProdName] || 0;
        const qty = parseInt(item.Qty);
        return {
          product: item.ProdName,
          current: qty,
          predicted_weekly_demand: weeklyDemand,
          days_until_empty: weeklyDemand > 0 ? Math.round((qty / weeklyDemand) * 7) : null,
          action: qty <= 3 && weeklyDemand > 0 ? '긴급 발주 필요' : weeklyDemand > qty ? '발주 검토' : '양호',
        };
      }).filter(a => a.predicted_weekly_demand > 0);

      res.json({
        ok: true,
        next_week: {
          predicted_orders: predictedOrders,
          confidence,
          basis,
          top_products: topProducts.map(r => r.ProdName),
        },
        inventory_alerts: inventoryAlerts,
        weekly_history: weeklyHistory.map(r => ({
          week: parseInt(r.wk),
          orders: parseInt(r.cnt),
        })),
        forecast_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'forecast');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     10. 리스크 목록
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/risks
   * 리스크 목록 (확률 x 영향)
   */
  router.get('/risks', async (req, res) => {
    try {
      const db = getOrbitDb();
      const risks = [];

      // 1. 거래처 집중 리스크
      const topCust = await nenovaQuery(`
        SELECT TOP 3 c.CustName, COUNT(*) as cnt
        FROM OrderDetail od JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY c.CustName ORDER BY cnt DESC
      `);
      const totalOd = await nenovaCount('SELECT COUNT(*) as cnt FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())');
      if (topCust.length > 0 && totalOd > 0) {
        const top1Pct = Math.round((parseInt(topCust[0].cnt) / totalOd) * 100);
        if (top1Pct > 15) {
          risks.push({
            id: 'customer-concentration',
            category: '거래처',
            title: `${topCust[0].CustName} 의존도 ${top1Pct}%`,
            probability: top1Pct > 25 ? 0.3 : 0.2,
            impact: top1Pct > 25 ? 0.9 : 0.7,
            score: null,
            description: `${topCust[0].CustName} 이탈 시 매출 ${top1Pct}% 감소 가능`,
            mitigation: '신규 거래처 개발, 기존 거래처 거래량 확대',
          });
          risks[risks.length - 1].score = Math.round(risks[risks.length - 1].probability * risks[risks.length - 1].impact * 100);
        }
      }

      // 2. 공급망 집중 리스크
      const topCountry = await nenovaQuery(`
        SELECT TOP 1 p.CountryName, COUNT(*) as cnt,
          COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())), 0) as pct
        FROM OrderDetail od JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE()) AND p.CountryName IS NOT NULL AND p.CountryName != ''
        GROUP BY p.CountryName ORDER BY cnt DESC
      `);
      if (topCountry.length > 0) {
        const pct = Math.round(parseFloat(topCountry[0].pct || 0));
        if (pct > 40) {
          risks.push({
            id: 'supply-chain-concentration',
            category: '공급망',
            title: `${topCountry[0].CountryName} 의존도 ${pct}%`,
            probability: 0.2,
            impact: pct > 60 ? 0.9 : 0.6,
            score: null,
            description: `${topCountry[0].CountryName} 정치/물류 이슈 시 공급 차질`,
            mitigation: '대안 국가/농장 사전 확보',
          });
          risks[risks.length - 1].score = Math.round(risks[risks.length - 1].probability * risks[risks.length - 1].impact * 100);
        }
      }

      // 3. 핵심 인력 리스크
      const keyEmployee = await orbitQuery(db, `
        SELECT user_id, COUNT(*) as events,
          COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul') >= 19) as late
        FROM events
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY user_id
        ORDER BY events DESC LIMIT 3
      `);
      for (const emp of keyEmployee) {
        const lateRate = parseInt(emp.events) > 0 ? parseInt(emp.late) / parseInt(emp.events) : 0;
        if (lateRate > 0.15) {
          risks.push({
            id: `burnout-${emp.user_id.substring(0, 8)}`,
            category: '인력',
            title: `핵심 직원 번아웃 위험`,
            probability: lateRate > 0.25 ? 0.5 : 0.3,
            impact: 0.7,
            score: null,
            description: `야근 비율 ${Math.round(lateRate * 100)}% — 이직/번아웃 위험`,
            mitigation: '업무 분배 조정, 자동화 도입',
          });
          risks[risks.length - 1].score = Math.round(risks[risks.length - 1].probability * risks[risks.length - 1].impact * 100);
        }
      }

      // 4. 미수금 리스크 (데이터 없음)
      risks.push({
        id: 'unknown-ar',
        category: '재무',
        title: '미수금 현황 파악 불가',
        probability: 0.4,
        impact: 0.8,
        score: 32,
        description: '미수금 추적 시스템이 없어 부실 채권 리스크 판단 불가',
        mitigation: '이카운트 또는 은행 데이터 연동으로 미수금 추적 체계 구축',
      });

      // 5. 재고 리스크
      const criticalItems = await nenovaCount(`SELECT COUNT(*) as cnt FROM StockMaster WHERE Qty > 0 AND Qty <= 3`);
      if (criticalItems > 0) {
        risks.push({
          id: 'inventory-shortage',
          category: '재고',
          title: `재고 부족 품목 ${criticalItems}개`,
          probability: 0.6,
          impact: 0.5,
          score: 30,
          description: `${criticalItems}개 품목이 3박스 이하 — 주문 불이행 위험`,
          mitigation: '긴급 발주 + 안전재고 기준 설정',
        });
      }

      // 리스크 점수 순 정렬
      risks.sort((a, b) => (b.score || 0) - (a.score || 0));

      res.json({
        ok: true,
        total: risks.length,
        high_risk: risks.filter(r => r.score >= 30).length,
        risks,
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'risks');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     11. 기회 목록
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/opportunities
   * 기회 목록 (수익 x 실행가능성)
   */
  router.get('/opportunities', async (req, res) => {
    try {
      const db = getOrbitDb();
      const opportunities = [];

      // 1. 주문 자동화
      const dailyOrders = await nenovaCount(`
        SELECT COUNT(*) / 14 as cnt FROM OrderDetail WHERE InputDate >= DATEADD(DAY, -14, GETDATE())
      `);
      opportunities.push({
        id: 'order-automation',
        category: '자동화',
        title: '주문 입력 자동화',
        revenue_impact: 'high',
        feasibility: 'medium',
        score: 85,
        description: `일 평균 ${dailyOrders || 200}건 수동 입력 → 자동화 시 연 2,000시간 절감`,
        action: 'PAD + 클립보드 파싱 주문 자동 입력 개발',
        estimated_savings: `인건비 연 ${Math.round((dailyOrders || 200) * 2.5 / 60 * 260 * 15000 / 10000)}만원`,
      });

      // 2. 성장 거래처 집중 영업
      const growingCusts = await nenovaQuery(`
        SELECT TOP 3 c.CustName,
          SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) as m1,
          SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -3, GETDATE()) AND od.InputDate < DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) as m23
        FROM OrderDetail od JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        GROUP BY c.CustName
        HAVING SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) >
               SUM(CASE WHEN od.InputDate >= DATEADD(MONTH, -3, GETDATE()) AND od.InputDate < DATEADD(MONTH, -1, GETDATE()) THEN 1 ELSE 0 END) / 2
        ORDER BY m1 DESC
      `);
      if (growingCusts.length > 0) {
        opportunities.push({
          id: 'growing-customers',
          category: '영업',
          title: '성장 거래처 집중 영업',
          revenue_impact: 'high',
          feasibility: 'high',
          score: 90,
          description: `${growingCusts.map(c => c.CustName).join(', ')} — 주문량 증가 추세, 추가 품목 제안 기회`,
          action: '담당자 미팅 → 추가 품목/물량 확대 제안',
        });
      }

      // 3. 계절 선제 대응
      opportunities.push({
        id: 'seasonal-preparation',
        category: '재고',
        title: '시즌 수요 선제 대응',
        revenue_impact: 'medium',
        feasibility: 'high',
        score: 75,
        description: '과거 주문 이력 기반 시즌 품목 사전 확보 — 재고 부족 방지',
        action: '지난해 동일 시기 주문 분석 → 사전 발주',
      });

      // 4. 차감 자동화
      opportunities.push({
        id: 'deduction-automation',
        category: '자동화',
        title: '차감 대조 자동화',
        revenue_impact: 'medium',
        feasibility: 'high',
        score: 80,
        description: '수동 차감 대조 → openpyxl 자동화 시 오류 제거 + 시간 절감',
        action: 'openpyxl 스크립트 개발 (1주)',
        estimated_savings: '일 1시간 절감, 오류율 3% → 0%',
      });

      // 5. 거래처 신용 관리
      opportunities.push({
        id: 'credit-management',
        category: '재무',
        title: '거래처 신용 관리 체계 도입',
        revenue_impact: 'high',
        feasibility: 'medium',
        score: 70,
        description: '부실 거래처 조기 발견 → 부도 손실 방지',
        action: '주문 이력 기반 자동 신용 점수 + 미수금 연동',
      });

      // 점수 순 정렬
      opportunities.sort((a, b) => b.score - a.score);

      res.json({
        ok: true,
        total: opportunities.length,
        opportunities,
        analyzed_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'opportunities');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     12. 오너 액션 아이템
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/action-items
   * 오너가 지금 해야 할 액션 TOP 5
   */
  router.get('/action-items', async (req, res) => {
    try {
      const db = getOrbitDb();
      const actions = [];

      // 1. 이탈 위험 거래처 연락
      const churnRisk = await nenovaQuery(`
        SELECT TOP 3 c.CustName,
          SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) as recent,
          SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END) as earlier
        FROM OrderDetail od JOIN Customer c ON od.CustKey = c.CustKey
        WHERE od.InputDate >= DATEADD(WEEK, -6, GETDATE())
        GROUP BY c.CustName
        HAVING SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END) > 5
          AND SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) <
              SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END) * 0.5
        ORDER BY (CAST(SUM(CASE WHEN od.InputDate >= DATEADD(WEEK, -2, GETDATE()) THEN 1 ELSE 0 END) AS FLOAT) /
                  NULLIF(SUM(CASE WHEN od.InputDate < DATEADD(WEEK, -2, GETDATE()) AND od.InputDate >= DATEADD(WEEK, -6, GETDATE()) THEN 1 ELSE 0 END), 0)) ASC
      `);
      for (const cust of churnRisk) {
        const earlier = parseInt(cust.earlier || 0);
        const recent = parseInt(cust.recent || 0);
        const declinePct = earlier > 0 ? Math.round(((earlier - recent) / earlier) * 100) : 0;
        actions.push({
          priority: actions.length + 1,
          action: `거래처 ${cust.CustName} 연락`,
          reason: `주문 ${declinePct}% 감소 감지 (최근 2주 ${recent}건 vs 이전 4주 ${earlier}건)`,
          deadline: '이번 주',
          impact: '거래처 이탈 방지',
          type: 'customer',
        });
      }

      // 2. 재고 확인
      const criticalStock = await nenovaQuery(`
        SELECT TOP 3 p.ProdName, sm.Qty
        FROM StockMaster sm JOIN Product p ON sm.ProdKey = p.ProdKey
        WHERE sm.Qty > 0 AND sm.Qty <= 3
        ORDER BY sm.Qty ASC
      `);
      if (criticalStock.length > 0) {
        actions.push({
          priority: actions.length + 1,
          action: `재고 긴급 확인: ${criticalStock.map(r => r.ProdName).join(', ')}`,
          reason: `${criticalStock.length}개 품목 3박스 이하 — 2~3일 내 소진 예상`,
          deadline: '내일',
          impact: '출하 지연 방지',
          type: 'inventory',
        });
      }

      // 3. 공급망 다변화
      const topCountry = await nenovaQuery(`
        SELECT TOP 1 p.CountryName,
          COUNT(*) * 100.0 / NULLIF((SELECT COUNT(*) FROM OrderDetail WHERE InputDate >= DATEADD(MONTH, -3, GETDATE())), 0) as pct
        FROM OrderDetail od JOIN Product p ON od.ProdKey = p.ProdKey
        WHERE od.InputDate >= DATEADD(MONTH, -3, GETDATE())
        AND p.CountryName IS NOT NULL AND p.CountryName != ''
        GROUP BY p.CountryName ORDER BY COUNT(*) DESC
      `);
      if (topCountry.length > 0) {
        const pct = Math.round(parseFloat(topCountry[0].pct || 0));
        if (pct > 50) {
          actions.push({
            priority: actions.length + 1,
            action: `${topCountry[0].CountryName} 대안 농장 탐색`,
            reason: `의존도 ${pct}%`,
            deadline: '이번 달',
            impact: '공급망 리스크 분산',
            type: 'supply_chain',
          });
        }
      }

      // 4. 주문 자동화 테스트
      const parsedOrders = await orbitCount(db, 'SELECT COUNT(*) as count FROM parsed_orders');
      actions.push({
        priority: actions.length + 1,
        action: '주문 자동화 테스트 승인',
        reason: `일 약 200건 수동 입력 중 (파싱 완료: ${parsedOrders}건)`,
        deadline: '이번 주',
        impact: '연 2,000시간 절약 가능',
        type: 'automation',
      });

      // 5. 야근 직원 확인
      const overtimeStaff = await orbitQuery(db, `
        SELECT user_id, COUNT(*) as late_cnt
        FROM events
        WHERE EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Seoul') >= 20
        AND created_at > NOW() - INTERVAL '14 days'
        GROUP BY user_id
        HAVING COUNT(*) > 15
        ORDER BY late_cnt DESC
        LIMIT 1
      `);
      if (overtimeStaff.length > 0) {
        actions.push({
          priority: actions.length + 1,
          action: `직원 업무량 확인 (야근 감지)`,
          reason: `최근 2주 20시 이후 활동 ${overtimeStaff[0].late_cnt}건`,
          deadline: '이번 주',
          impact: '번아웃/이직 방지',
          type: 'employee',
        });
      }

      // 번호 재정렬
      actions.forEach((a, i) => a.priority = i + 1);

      res.json({
        ok: true,
        total: actions.length,
        actions: actions.slice(0, 5),
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'action-items');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     13. 일일 리포트
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/report/daily
   * 일일 리포트 — 오늘 하루 종합
   * ?date=2026-03-23 (기본: 오늘)
   */
  router.get('/report/daily', async (req, res) => {
    try {
      const db = getOrbitDb();
      const targetDate = req.query.date || todayKST();

      // 주문
      const ordersToday = await nenovaQuery(`
        SELECT COUNT(DISTINCT om.OrderKey) as orders, COUNT(od.DetailKey) as details,
          COUNT(DISTINCT od.CustKey) as customers, COUNT(DISTINCT od.ProdKey) as products
        FROM OrderMaster om JOIN OrderDetail od ON om.OrderKey = od.OrderKey
        WHERE CONVERT(DATE, om.OrderDate) = '${targetDate}'
      `);

      // 전일 비교
      const ordersYesterday = await nenovaQuery(`
        SELECT COUNT(DISTINCT om.OrderKey) as orders
        FROM OrderMaster om
        WHERE CONVERT(DATE, om.OrderDate) = DATEADD(DAY, -1, '${targetDate}')
      `);

      // 직원 활동
      const employeeActivity = await orbitQuery(db, `
        SELECT user_id,
          COUNT(*) as events,
          MIN(created_at) as first_seen,
          MAX(created_at) as last_seen
        FROM events
        WHERE created_at::DATE = $1::DATE
        GROUP BY user_id
        ORDER BY events DESC
      `, [targetDate]);

      // 재고 스냅샷
      const stockSnapshot = await nenovaQuery(`
        SELECT COUNT(*) as total,
          SUM(CASE WHEN Qty <= 0 THEN 1 ELSE 0 END) as empty,
          SUM(CASE WHEN Qty > 0 AND Qty <= 5 THEN 1 ELSE 0 END) as low,
          SUM(CASE WHEN Qty > 50 THEN 1 ELSE 0 END) as over
        FROM StockMaster
      `);

      const todayData = ordersToday[0] || {};
      const yesterdayOrders = parseInt(ordersYesterday[0]?.orders || 0);
      const todayOrderCount = parseInt(todayData.orders || 0);

      res.json({
        ok: true,
        date: targetDate,
        report: {
          orders: {
            count: todayOrderCount,
            details: parseInt(todayData.details || 0),
            customers: parseInt(todayData.customers || 0),
            products: parseInt(todayData.products || 0),
            vs_yesterday: yesterdayOrders > 0
              ? `${todayOrderCount > yesterdayOrders ? '+' : ''}${Math.round(((todayOrderCount - yesterdayOrders) / yesterdayOrders) * 100)}%`
              : 'N/A',
          },
          employees: {
            active: employeeActivity.length,
            details: employeeActivity.map(e => ({
              user: e.user_id.substring(0, 12),
              events: parseInt(e.events),
              first_seen: e.first_seen,
              last_seen: e.last_seen,
            })),
          },
          inventory: stockSnapshot[0] ? {
            total: parseInt(stockSnapshot[0].total || 0),
            empty: parseInt(stockSnapshot[0].empty || 0),
            low: parseInt(stockSnapshot[0].low || 0),
            overstock: parseInt(stockSnapshot[0].over || 0),
          } : null,
        },
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'report/daily');
    }
  });


  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //                     14. 주간 리포트
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * GET /api/bi/report/weekly
   * 주간 리포트 — 이번 주 종합
   * ?week=13&year=2026 (기본: 현재 주)
   */
  router.get('/report/weekly', async (req, res) => {
    try {
      const db = getOrbitDb();
      const now = new Date();
      const week = parseInt(req.query.week) || getISOWeek(now);
      const year = parseInt(req.query.year) || now.getFullYear();

      // 이번 주 주문
      const weekOrders = await nenovaQuery(`
        SELECT COUNT(DISTINCT om.OrderKey) as orders, COUNT(od.DetailKey) as details,
          COUNT(DISTINCT od.CustKey) as customers, COUNT(DISTINCT od.ProdKey) as products
        FROM OrderMaster om JOIN OrderDetail od ON om.OrderKey = od.OrderKey
        WHERE DATEPART(ISO_WEEK, om.OrderDate) = ${week} AND YEAR(om.OrderDate) = ${year}
      `);

      // 지난 주 비교
      const prevWeekOrders = await nenovaCount(`
        SELECT COUNT(*) as cnt FROM OrderMaster
        WHERE DATEPART(ISO_WEEK, OrderDate) = ${week - 1 > 0 ? week - 1 : 52}
        AND YEAR(OrderDate) = ${week - 1 > 0 ? year : year - 1}
      `);

      // 일별 분포
      const dailyBreakdown = await nenovaQuery(`
        SELECT CONVERT(VARCHAR, om.OrderDate, 23) as dt,
          DATENAME(dw, om.OrderDate) as dow,
          COUNT(*) as cnt
        FROM OrderMaster om
        WHERE DATEPART(ISO_WEEK, om.OrderDate) = ${week} AND YEAR(om.OrderDate) = ${year}
        GROUP BY CONVERT(VARCHAR, om.OrderDate, 23), DATENAME(dw, om.OrderDate)
        ORDER BY dt
      `);

      // 상위 거래처 (이번 주)
      const topCustomers = await nenovaQuery(`
        SELECT TOP 5 c.CustName, COUNT(*) as cnt
        FROM OrderDetail od JOIN Customer c ON od.CustKey = c.CustKey
        JOIN OrderMaster om ON od.OrderKey = om.OrderKey
        WHERE DATEPART(ISO_WEEK, om.OrderDate) = ${week} AND YEAR(om.OrderDate) = ${year}
        GROUP BY c.CustName ORDER BY cnt DESC
      `);

      // 상위 품목
      const topProducts = await nenovaQuery(`
        SELECT TOP 5 p.ProdName, COUNT(*) as cnt
        FROM OrderDetail od JOIN Product p ON od.ProdKey = p.ProdKey
        JOIN OrderMaster om ON od.OrderKey = om.OrderKey
        WHERE DATEPART(ISO_WEEK, om.OrderDate) = ${week} AND YEAR(om.OrderDate) = ${year}
        GROUP BY p.ProdName ORDER BY cnt DESC
      `);

      // 직원 활동 (주간)
      const weekEmployees = await orbitQuery(db, `
        SELECT user_id, COUNT(*) as events,
          COUNT(DISTINCT created_at::DATE) as active_days
        FROM events
        WHERE EXTRACT(WEEK FROM created_at) = $1
        AND EXTRACT(YEAR FROM created_at) = $2
        GROUP BY user_id
        ORDER BY events DESC
      `, [week, year]);

      const thisWeekTotal = parseInt(weekOrders[0]?.orders || 0);
      const changePct = prevWeekOrders > 0
        ? Math.round(((thisWeekTotal - prevWeekOrders) / prevWeekOrders) * 100)
        : 0;

      res.json({
        ok: true,
        week,
        year,
        report: {
          summary: {
            orders: thisWeekTotal,
            details: parseInt(weekOrders[0]?.details || 0),
            customers: parseInt(weekOrders[0]?.customers || 0),
            products: parseInt(weekOrders[0]?.products || 0),
            vs_prev_week: `${changePct >= 0 ? '+' : ''}${changePct}%`,
            trend: changePct > 5 ? '증가' : changePct < -5 ? '감소' : '유지',
          },
          daily_breakdown: dailyBreakdown.map(d => ({
            date: d.dt, day: d.dow, orders: parseInt(d.cnt),
          })),
          top_customers: topCustomers.map(c => ({ name: c.CustName, orders: parseInt(c.cnt) })),
          top_products: topProducts.map(p => ({ name: p.ProdName, orders: parseInt(p.cnt) })),
          employees: {
            active: weekEmployees.length,
            details: weekEmployees.map(e => ({
              user: e.user_id.substring(0, 12),
              events: parseInt(e.events),
              active_days: parseInt(e.active_days),
            })),
          },
        },
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err, 'report/weekly');
    }
  });


  return router;
};
